import { randomBytes, randomUUID } from 'node:crypto';

// Independent implementation of Tencent's documented iLink JSON protocol:
// https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol_zh_CN.md
const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const CHANNEL_VERSION = '0.9.0';
const CLIENT_VERSION = String((0 << 16) | (9 << 8) | 0);
const QR_STATUSES = new Set(['wait', 'scaned', 'confirmed', 'expired', 'need_verifycode', 'verify_code_blocked', 'scaned_but_redirect', 'binded_redirect']);
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export class WeixinError extends Error {
  constructor(message, { code = 'WEIXIN_ERROR', status = undefined, authExpired = false } = {}) {
    super(message);
    this.name = 'WeixinError';
    this.code = code;
    this.authExpired = authExpired;
    if (status !== undefined) this.status = status;
  }
}

function safeBaseUrl(value, { allowHostname = false } = {}) {
  try {
    if (typeof value !== 'string' || /[\s\\]/.test(value)) throw new Error();
    const url = new URL(allowHostname && !value.includes('://') ? `https://${value}` : value);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
      || !url.hostname.endsWith('.weixin.qq.com') || url.pathname !== '/' || url.search || url.hash) throw new Error();
    return url.origin;
  } catch {
    throw new WeixinError('微信返回的服务地址不受支持。', { code: 'INVALID_BASE_URL' });
  }
}

function safeString(value, maxLength = 8192) {
  return typeof value === 'string' && value.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(value) ? value : '';
}

function abortError() {
  return new DOMException('微信请求已取消。', 'AbortError');
}

function checkProviderResult(result) {
  const errors = [result.ret, result.errcode].filter(value => value !== undefined && value !== null && value !== 0 && value !== '0');
  if (!errors.length) return;
  const authExpired = errors.some(value => Number(value) === -14);
  const numericCode = Number(errors[0]);
  throw new WeixinError(authExpired ? '微信登录已失效，请重新扫码。' : '微信服务暂时无法完成请求，请稍后重试。', {
    code: authExpired ? -14 : Number.isFinite(numericCode) ? numericCode : 'PROVIDER_ERROR',
    authExpired,
  });
}

/** Converts direct user messages to text tasks; bot echoes and native groups are excluded. */
export function normalizeIncomingMessage(raw) {
  if (!raw || raw.message_type !== 1 || raw.group_id || Number(raw.delete_time_ms) > 0) return null;
  const messageId = typeof raw.message_id === 'number' && Number.isFinite(raw.message_id)
    ? String(raw.message_id) : safeString(raw.message_id, 256);
  const userId = safeString(raw.from_user_id, 2048).trim();
  if (!messageId || !userId || !Array.isArray(raw.item_list)) return null;
  const parts = raw.item_list.flatMap(item => {
    const text = item?.type === 1 ? item.text_item?.text : item?.type === 3 ? item.voice_item?.text : undefined;
    return typeof text === 'string' && text.trim() ? [text] : [];
  });
  if (!parts.length) return null;
  return {
    messageId,
    userId,
    toUserId: safeString(raw.to_user_id, 2048),
    text: parts.join('\n'),
    contextToken: safeString(raw.context_token),
    timestamp: Number.isFinite(raw.create_time_ms) && raw.create_time_ms > 0 ? raw.create_time_ms : Date.now(),
  };
}

export class WeixinClient {
  #fetch;
  #baseUrl;
  #token;
  #timeoutMs;

  constructor({ fetchImpl = globalThis.fetch, baseUrl = DEFAULT_BASE_URL, token = '', apiTimeoutMs = 35000 } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
    this.#fetch = fetchImpl;
    this.#baseUrl = safeBaseUrl(baseUrl);
    this.#token = safeString(token).trim();
    this.#timeoutMs = Number.isFinite(apiTimeoutMs) && apiTimeoutMs > 0 ? Math.min(apiTimeoutMs, 120000) : 35000;
  }

  get baseUrl() { return this.#baseUrl; }
  set baseUrl(value) { this.#baseUrl = safeBaseUrl(value); }

  async #request(path, { method = 'POST', payload, signal, authenticated = true, baseUrl = this.#baseUrl } = {}) {
    if (signal?.aborted) throw abortError();
    if (authenticated && !this.#token) throw new WeixinError('微信尚未登录，请先扫码。', { code: 'NOT_AUTHENTICATED' });
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.#timeoutMs);
    timer.unref?.();
    const headers = { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': CLIENT_VERSION };
    if (method === 'POST') {
      headers['Content-Type'] = 'application/json';
      headers.AuthorizationType = 'ilink_bot_token';
      headers['X-WECHAT-UIN'] = Buffer.from(String(randomBytes(4).readUInt32BE()), 'utf8').toString('base64');
    }
    if (authenticated) headers.Authorization = `Bearer ${this.#token}`;
    try {
      const response = await this.#fetch(`${safeBaseUrl(baseUrl)}${path}`, {
        method,
        headers,
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        signal: controller.signal,
        redirect: 'error',
      });
      if (!response.ok) throw new WeixinError('微信服务请求失败，请稍后重试。', { code: 'HTTP_ERROR', status: response.status, authExpired: response.status === 401 });
      const contentLength = Number(response.headers?.get?.('content-length'));
      if (contentLength > MAX_RESPONSE_BYTES) throw new WeixinError('微信响应数据过大。', { code: 'INVALID_RESPONSE' });
      const text = await response.text();
      if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new WeixinError('微信响应数据过大。', { code: 'INVALID_RESPONSE' });
      let result;
      try { result = JSON.parse(text); } catch { throw new WeixinError('微信响应格式无效。', { code: 'INVALID_RESPONSE' }); }
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new WeixinError('微信响应格式无效。', { code: 'INVALID_RESPONSE' });
      checkProviderResult(result);
      return result;
    } catch (error) {
      if (signal?.aborted) throw abortError();
      if (timedOut || error?.name === 'TimeoutError') throw new WeixinError('微信请求超时，请稍后重试。', { code: 'TIMEOUT' });
      if (error instanceof WeixinError) throw error;
      throw new WeixinError('微信连接失败，请检查网络后重试。', { code: 'NETWORK_ERROR' });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  #baseInfo() { return { channel_version: CHANNEL_VERSION, bot_agent: `PiWeb/${CHANNEL_VERSION}` }; }

  async getQrCode({ signal } = {}) {
    const result = await this.#request('/ilink/bot/get_bot_qrcode?bot_type=3', {
      payload: { local_token_list: [] }, signal, authenticated: false, baseUrl: DEFAULT_BASE_URL,
    });
    const qrcode = safeString(result.qrcode, 16384);
    const qrCodeUrl = safeString(result.qrcode_img_content, 16384);
    if (!qrcode || !qrCodeUrl) throw new WeixinError('微信未返回有效的登录二维码，请重试。', { code: 'INVALID_RESPONSE' });
    return { qrcode, qrCodeUrl };
  }

  async getQrStatus(qrcode, { signal, verifyCode } = {}) {
    const value = safeString(qrcode, 16384);
    if (!value) throw new WeixinError('微信二维码无效，请重新生成。', { code: 'INVALID_QR_CODE' });
    const query = new URLSearchParams({ qrcode: value });
    if (verifyCode !== undefined && verifyCode !== '') {
      const code = safeString(verifyCode, 64).trim();
      if (!code) throw new WeixinError('请输入有效的微信配对码。', { code: 'INVALID_VERIFY_CODE' });
      query.set('verify_code', code);
    }
    let result;
    try {
      result = await this.#request(`/ilink/bot/get_qrcode_status?${query}`, { method: 'GET', authenticated: false, signal });
    } catch (error) {
      if (error?.code === 'TIMEOUT') return { status: 'wait' };
      throw error;
    }
    if (!QR_STATUSES.has(result.status)) throw new WeixinError('微信返回了未知登录状态，请重新扫码。', { code: 'INVALID_RESPONSE' });
    const normalized = { status: result.status };
    if (result.redirect_host) {
      const nextBaseUrl = safeBaseUrl(result.redirect_host, { allowHostname: true });
      if (result.status === 'scaned_but_redirect') this.#baseUrl = nextBaseUrl;
      normalized.redirectHost = new URL(nextBaseUrl).hostname;
    }
    if (result.baseurl) normalized.baseUrl = safeBaseUrl(result.baseurl);
    if (result.status === 'confirmed') {
      normalized.token = safeString(result.bot_token).trim();
      normalized.accountId = safeString(result.ilink_bot_id, 2048);
      normalized.userId = safeString(result.ilink_user_id, 2048);
      normalized.baseUrl ??= this.#baseUrl;
      if (!normalized.token || !normalized.accountId || !normalized.userId) throw new WeixinError('微信登录信息不完整，请重新扫码。', { code: 'INVALID_RESPONSE' });
    }
    return normalized;
  }

  async getUpdates(cursor = '', { signal } = {}) {
    const previousCursor = typeof cursor === 'string' ? cursor : '';
    let result;
    try {
      result = await this.#request('/ilink/bot/getupdates', { payload: { get_updates_buf: previousCursor, base_info: this.#baseInfo() }, signal });
    } catch (error) {
      if (error?.code === 'TIMEOUT') return { messages: [], cursor: previousCursor, longPollTimeoutMs: this.#timeoutMs, timedOut: true };
      throw error;
    }
    const longPollTimeoutMs = Number(result.longpolling_timeout_ms);
    return {
      messages: Array.isArray(result.msgs) ? result.msgs : [],
      cursor: typeof result.get_updates_buf === 'string' && result.get_updates_buf ? result.get_updates_buf : previousCursor,
      longPollTimeoutMs: Number.isFinite(longPollTimeoutMs) && longPollTimeoutMs > 0 ? Math.min(longPollTimeoutMs, 120000) : this.#timeoutMs,
    };
  }

  async sendText({ toUserId, text, contextToken = '', clientId = randomUUID(), signal } = {}) {
    const recipient = safeString(toUserId, 2048).trim();
    const id = safeString(clientId, 256).trim();
    if (!recipient || !id || typeof text !== 'string' || !text.trim()) throw new WeixinError('微信消息内容或接收人无效。', { code: 'INVALID_MESSAGE' });
    const token = safeString(contextToken);
    const msg = {
      from_user_id: '', to_user_id: recipient, client_id: id, message_type: 2, message_state: 2,
      ...(token ? { context_token: token } : {}), item_list: [{ type: 1, text_item: { text } }],
    };
    await this.#request('/ilink/bot/sendmessage', { payload: { msg, base_info: this.#baseInfo() }, signal });
    return { clientId: id };
  }
}
