import { HttpError } from './security.mjs';
import { createHash } from 'node:crypto';

const ENDPOINT = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send';
const MEDIA_LIMIT = 2 * 1024 * 1024;
const FILE_LIMIT = 20 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const AMR_NB_MAGIC = Buffer.from('#!AMR\n');
// Storage-format payload sizes, not including the one-byte frame header.
// RFC 4867 section 5: each complete frame represents 20 milliseconds.
const AMR_NB_SIZES = [12, 13, 15, 17, 19, 20, 26, 31, 5, null, null, null, null, null, null, 0];

/** The URL contains a credential. Never put it in public responses or errors. */
export function validateWecomWebhookUrl(value) {
  const invalid = () => new HttpError(400, '请输入有效的企业微信群机器人 Webhook 地址。');
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 2048 || /[\u0000-\u0020\u007f]/u.test(value.trim())) throw invalid();
  const input = value.trim();
  let url;
  try { url = new URL(input); } catch { throw invalid(); }
  // Check the original authority too: URL normalizes an explicit :443 away.
  const authority = /^https:\/\/([^/?#]+)/iu.exec(input)?.[1];
  const pathname = /^https:\/\/[^/?#]+([^?#]*)/iu.exec(input)?.[1];
  if (authority?.toLowerCase() !== 'qyapi.weixin.qq.com' || url.protocol !== 'https:' || url.hostname !== 'qyapi.weixin.qq.com'
    || url.username || url.password || url.port || url.hash || pathname !== '/cgi-bin/webhook/send' || url.pathname !== '/cgi-bin/webhook/send'
    || url.searchParams.size !== 1 || !url.searchParams.has('key')) throw invalid();
  const key = url.searchParams.get('key');
  if (!key || !/^[A-Za-z0-9_-]{1,512}$/u.test(key)) throw invalid();
  return `${ENDPOINT}?key=${encodeURIComponent(key)}`;
}

export class WecomWebhookError extends Error {
  constructor(code = 'SEND_FAILED') {
    super('企业微信 Webhook 发送失败，请检查机器人配置后重试。');
    this.name = 'WecomWebhookError';
    this.code = code;
  }
}

function mediaAttachment(attachment, messageType) {
  if (!attachment || !Buffer.isBuffer(attachment.content) || attachment.content.length <= 5
    || typeof attachment.name !== 'string' || !attachment.name.trim() || attachment.name.length > 512
    || /[\u0000-\u001f\u007f]/u.test(attachment.name)) throw new WecomWebhookError('INVALID_ATTACHMENT');
  const content = attachment.content;
  if (content.length > (messageType === 'file' ? FILE_LIMIT : MEDIA_LIMIT)) throw new WecomWebhookError(messageType === 'file' ? 'FILE_TOO_LARGE' : 'MEDIA_TOO_LARGE');
  // Names are display metadata only. Never read attachment paths or remote URLs.
  const name = attachment.name.split(/[\\/]/u).at(-1)?.trim();
  if (!name || name === '.' || name === '..') throw new WecomWebhookError('INVALID_ATTACHMENT');
  const suppliedMimeType = typeof attachment.mimeType === 'string' ? attachment.mimeType.split(';')[0].trim().toLowerCase() : '';
  const mimeType = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(suppliedMimeType) ? suppliedMimeType : 'application/octet-stream';
  return { content, name, mimeType };
}

function amrMimeType(content) {
  let offset, sizes, mimeType;
  if (content.subarray(0, AMR_NB_MAGIC.length).equals(AMR_NB_MAGIC)) { offset = AMR_NB_MAGIC.length; sizes = AMR_NB_SIZES; mimeType = 'audio/amr'; }
  else throw new WecomWebhookError('INVALID_MEDIA');
  let frames = 0;
  while (offset < content.length) {
    const header = content[offset], frameType = (header >> 3) & 15, size = sizes[frameType];
    if ((header & 0x83) !== 0 || size === null || size === undefined || offset + size + 1 > content.length) throw new WecomWebhookError('INVALID_MEDIA');
    offset += size + 1; frames++;
    if (frames > 3000) throw new WecomWebhookError('VOICE_TOO_LONG');
  }
  if (!frames) throw new WecomWebhookError('INVALID_MEDIA');
  return mimeType;
}

function imagePayload(content) {
  const png = content.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
  const jpeg = content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff;
  if (!png && !jpeg) throw new WecomWebhookError('INVALID_MEDIA');
  return { base64: content.toString('base64'), md5: createHash('md5').update(content).digest('hex') };
}

async function boundedJson(response, signal) {
  const reader = response.body?.getReader();
  if (!reader) throw new WecomWebhookError('INVALID_RESPONSE');
  let bytes = 0; const chunks = [];
  const onAbort = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 16_384) throw new WecomWebhookError('INVALID_RESPONSE');
      chunks.push(value);
    }
    signal.throwIfAborted();
    return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { signal.removeEventListener('abort', onAbort); reader.releaseLock(); }
}

/** Uses bytes supplied by the authorized attachment reader; never reads paths or URLs. */
export function createWecomWebhookSender({ fetchImpl = globalThis.fetch, timeoutMs } = {}) {
  return async ({ webhookUrl, text, signal, messageType = 'markdown', attachment }) => {
    signal?.throwIfAborted();
    const url = validateWecomWebhookUrl(webhookUrl);
    if (!['markdown', 'markdown_v2', 'image', 'file', 'voice'].includes(messageType)) throw new WecomWebhookError('INVALID_MESSAGE');
    let payload, media;
    if (messageType === 'markdown' || messageType === 'markdown_v2') {
      if (typeof text !== 'string' || !text.trim() || /\u0000/u.test(text) || Buffer.byteLength(text) > 4096) throw new WecomWebhookError('INVALID_MESSAGE');
      payload = { msgtype: messageType, [messageType]: { content: text } };
    } else {
      media = mediaAttachment(attachment, messageType);
      if (messageType === 'image') payload = { msgtype: 'image', image: imagePayload(media.content) };
      else if (messageType === 'voice') media.mimeType = amrMimeType(media.content);
    }
    const requestSignal = AbortSignal.any([AbortSignal.timeout(timeoutMs ?? (media ? 60_000 : 10_000)), ...(signal ? [signal] : [])]);
    try {
      const request = async (endpoint, options) => {
        requestSignal.throwIfAborted();
        const response = await fetchImpl(endpoint, { ...options, method: 'POST', redirect: 'error', signal: requestSignal });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw new WecomWebhookError('HTTP_ERROR');
        }
        const result = await boundedJson(response, requestSignal);
        if (!result || result.errcode !== 0) throw new WecomWebhookError('PROVIDER_ERROR');
        return result;
      };
      if (!payload) {
        const uploadUrl = new URL(url);
        uploadUrl.pathname = '/cgi-bin/webhook/upload_media';
        uploadUrl.searchParams.set('type', messageType);
        const form = new FormData();
        form.append('media', new Blob([media.content], { type: media.mimeType }), media.name);
        const uploaded = await request(uploadUrl.href, { body: form });
        if (typeof uploaded.media_id !== 'string' || !uploaded.media_id || uploaded.media_id.length > 2048
          || /[\u0000-\u0020\u007f]/u.test(uploaded.media_id) || uploaded.type && uploaded.type !== messageType) throw new WecomWebhookError('INVALID_RESPONSE');
        payload = { msgtype: messageType, [messageType]: { media_id: uploaded.media_id } };
      }
      await request(url, { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      return { ok: true };
    } catch (error) {
      if (signal?.aborted) throw new DOMException('企业微信 Webhook 发送已取消。', 'AbortError');
      throw error instanceof WecomWebhookError ? error : new WecomWebhookError(requestSignal.aborted ? 'TIMEOUT' : 'SEND_FAILED');
    }
  };
}
