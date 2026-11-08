import { Resolver } from 'node:dns/promises';
import { Agent, request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { HttpError } from './security.mjs';

const maxBytes = 4 * 1024 * 1024;
const maxTimeMs = 10_000;
const maxSide = 8192;
const maxPixels = 24_000_000;
const allowedTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const blocked = new BlockList();
// Reject IANA special-purpose IPv4 space and multicast.
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.31.196.0', 24], ['192.52.193.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['192.175.48.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(address, prefix, 'ipv4');
blocked.addSubnet('2001:db8::', 32, 'ipv6');
blocked.addSubnet('2620:4f:8000::', 48, 'ipv6');
// IANA IPv6 global unicast allocations to regional registries. Other space in 2000::/3 can still be reserved.
const unicast = new BlockList();
for (const [address, prefix] of [
  ['2001:200::', 23], ['2001:400::', 23], ['2001:600::', 23], ['2001:800::', 22], ['2001:c00::', 23],
  ['2001:e00::', 23], ['2001:1200::', 23], ['2001:1400::', 22], ['2001:1800::', 23], ['2001:1a00::', 23],
  ['2001:1c00::', 22], ['2001:2000::', 19], ['2001:4000::', 23], ['2001:4200::', 23], ['2001:4400::', 23],
  ['2001:4600::', 23], ['2001:4800::', 23], ['2001:4a00::', 23], ['2001:4c00::', 23], ['2001:5000::', 20],
  ['2001:8000::', 19], ['2001:a000::', 20], ['2001:b000::', 20], ['2003::', 18], ['2400::', 12], ['2410::', 12],
  ['2600::', 12], ['2610::', 23], ['2620::', 23], ['2630::', 12], ['2800::', 12], ['2a00::', 12], ['2a10::', 12], ['2c00::', 12],
]) unicast.addSubnet(address, prefix, 'ipv6');
const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');
const invalidUrl = () => new HttpError(400, '邮件外链图片地址无效。');
const blockedAddress = () => new HttpError(422, '邮件外链图片必须位于公开的 HTTPS 地址。');
const tooLarge = () => new HttpError(413, '邮件外链图片超过 4 MiB 上限。');
const unsupported = () => new HttpError(415, '邮件外链只支持有效的 PNG、JPEG、GIF 和 WebP 图片。');
const unavailable = () => new HttpError(502, '暂时无法读取邮件外链图片。');

function imageUrl(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\\\s\x00-\x1f\x7f]/.test(value)) throw invalidUrl();
  const authority = /^https:\/\/([^/?#]+)/i.exec(value)?.[1];
  if (!authority || authority.includes('@')) throw invalidUrl();
  let url;
  try { url = new URL(value); } catch { throw invalidUrl(); }
  if (url.protocol !== 'https:' || url.port && url.port !== '443' || url.username || url.password) throw invalidUrl();
  const hostname = url.hostname;
  const labels = hostname.split('.');
  // Require a DNS hostname so the request can validate the certificate against that name.
  if (hostname.length > 253 || isIP(hostname.replace(/^\[|\]$/g, '')) || labels.length < 2
    || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
    || /(?:^|\.)(?:localhost|local|internal|home\.arpa|onion|invalid|test|example)$/i.test(hostname)) throw blockedAddress();
  return url;
}

function isPublicRecord(record) {
  const { address, family } = record || {};
  if (typeof address !== 'string' || address.includes('%') || isIP(address) !== family) return false;
  if (family === 4) return !blocked.check(address, 'ipv4');
  return family === 6 && unicast.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

async function resolvePublicHost(hostname, { signal }) {
  const resolver = new Resolver({ timeout: 2000, tries: 2 });
  const cancel = () => resolver.cancel();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted();
    const results = await Promise.allSettled([resolver.resolve4(`${hostname}.`), resolver.resolve6(`${hostname}.`)]);
    return results.flatMap((result, index) => {
      if (result.status === 'fulfilled') return result.value.map(address => ({ address, family: index ? 6 : 4 }));
      if (['ENODATA', 'ENOTFOUND'].includes(result.reason?.code)) return [];
      throw result.reason;
    });
  } finally { signal.removeEventListener('abort', cancel); }
}

function jpegSize(content) {
  if (content[0] !== 0xff || content[1] !== 0xd8) return null;
  let size;
  for (let offset = 2; content[offset] === 0xff;) {
    while (content[offset] === 0xff) offset++;
    const marker = content[offset++];
    if (marker === 0xda || marker === 0xd9) return size;
    if (marker === 0x01) continue;
    if (marker === 0 || marker === 0xd8 || offset + 2 > content.length) return null;
    const length = content.readUInt16BE(offset);
    if (length < 2 || offset + length > content.length) return null;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (size || length < 8 || length !== 8 + 3 * content[offset + 7]) return null;
      size = [content.readUInt16BE(offset + 5), content.readUInt16BE(offset + 3)];
    }
    offset += length;
  }
  return null;
}

function webpSize(content) {
  if (content.length < 25 || content.toString('latin1', 0, 4) !== 'RIFF' || content.toString('latin1', 8, 12) !== 'WEBP'
    || content.readUInt32LE(4) + 8 !== content.length) return null;
  const type = content.toString('latin1', 12, 16), length = content.readUInt32LE(16);
  if (20 + length + (length % 2) > content.length) return null;
  if (type === 'VP8X' && length === 10) return [content.readUIntLE(24, 3) + 1, content.readUIntLE(27, 3) + 1];
  if (type === 'VP8L' && length >= 5 && content[20] === 0x2f) {
    const size = content.readUInt32LE(21);
    if ((size >>> 29) === 0) return [(size & 0x3fff) + 1, ((size >>> 14) & 0x3fff) + 1];
  }
  if (type === 'VP8 ' && length >= 10 && (content[20] & 1) === 0 && content.readUIntBE(23, 3) === 0x9d012a) {
    return [content.readUInt16LE(26) & 0x3fff, content.readUInt16LE(28) & 0x3fff];
  }
  return null;
}

function imageSize(content, type) {
  switch (type) {
    case 'image/png': return content.length >= 33 && content.subarray(0, 8).equals(pngSignature)
      && content.readUInt32BE(8) === 13 && content.toString('latin1', 12, 16) === 'IHDR'
      ? [content.readUInt32BE(16), content.readUInt32BE(20)] : null;
    case 'image/jpeg': return jpegSize(content);
    case 'image/gif': return content.length >= 13 && ['GIF87a', 'GIF89a'].includes(content.toString('latin1', 0, 6))
      ? [content.readUInt16LE(6), content.readUInt16LE(8)] : null;
    case 'image/webp': return webpSize(content);
    default: return null;
  }
}

async function readResponse(response, signal) {
  try {
    // Redirect responses never produce another outbound request.
    if (response.statusCode !== 200) throw unavailable();
    const declared = response.headers['content-type'];
    const mimeType = typeof declared === 'string' ? declared.split(';', 1)[0].trim().toLowerCase() : '';
    const encoding = response.headers['content-encoding'];
    if (!allowedTypes.has(mimeType) || encoding !== undefined && String(encoding).toLowerCase() !== 'identity') throw unsupported();
    const length = response.headers['content-length'];
    if (length !== undefined && (typeof length !== 'string' || !/^\d+$/.test(length))) throw unavailable();
    if (Number(length) > maxBytes) throw tooLarge();
    let size = 0;
    const chunks = [];
    for await (const chunk of response) {
      signal.throwIfAborted();
      size += chunk.length;
      if (size > maxBytes) throw tooLarge();
      chunks.push(chunk);
    }
    if (response.complete === false || length !== undefined && Number(length) !== size) throw unavailable();
    const content = Buffer.concat(chunks, size);
    const [width, height] = imageSize(content, mimeType) || [];
    if (!width || !height) throw unsupported();
    if (width > maxSide || height > maxSide || width * height > maxPixels) throw new HttpError(413, '邮件外链图片尺寸超过预览上限。');
    return { content, mimeType };
  } finally { response.destroy(); }
}

export async function fetchMailboxExternalImage(value, { signal, lookup = resolvePublicHost, request = httpsRequest, timeoutMs = maxTimeMs } = {}) {
  const url = imageUrl(value), hostname = url.hostname;
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), Math.max(1, Math.min(maxTimeMs, timeoutMs)));
  const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  const abortError = () => signal?.aborted ? new HttpError(499, '邮件外链图片请求已取消。') : new HttpError(504, '读取邮件外链图片超时。');
  const { promise: interrupted, reject } = Promise.withResolvers();
  const abort = () => reject(abortError());
  let agent;
  combined.addEventListener('abort', abort, { once: true });
  try {
    if (combined.aborted) throw abortError();
    const records = await Promise.race([lookup(hostname, { signal: combined }), interrupted]);
    if (!Array.isArray(records) || !records.length || records.length > 64 || !records.every(isPublicRecord)) throw blockedAddress();
    const { address, family } = records.find(record => record.family === 4) || records[0];
    if (combined.aborted) throw abortError();
    agent = new Agent({ keepAlive: false, proxyEnv: {} });
    const response = await Promise.race([new Promise((resolve, rejectRequest) => {
      const req = request({ hostname, servername: hostname, port: 443, family, autoSelectFamily: false, agent,
        path: `${url.pathname}${url.search}`, method: 'GET', signal: combined, rejectUnauthorized: true, minVersion: 'TLSv1.2',
        headers: { Accept: [...allowedTypes].join(','), 'Accept-Encoding': 'identity' },
        lookup(name, options, callback) {
          if (name !== hostname) return callback(blockedAddress());
          if (options?.all) return callback(null, [{ address, family }]);
          callback(null, address, family);
        }
      }, value => {
        if (combined.aborted) { value.destroy(); rejectRequest(abortError()); }
        else resolve(value);
      });
      req.once('error', rejectRequest);
      req.end();
    }), interrupted]);
    return await Promise.race([readResponse(response, combined), interrupted]);
  } catch (error) {
    if (combined.aborted) throw abortError();
    if (error instanceof HttpError) throw error;
    throw unavailable();
  } finally {
    clearTimeout(timer);
    combined.removeEventListener('abort', abort);
    agent?.destroy();
  }
}
