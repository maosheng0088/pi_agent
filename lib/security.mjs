import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function isLocalSetup(req) {
  const remote = req.socket.remoteAddress;
  const localSocket = remote === '::1' || remote === '127.0.0.1' || remote?.startsWith('::ffff:127.');
  let hostname;
  try { hostname = new URL(`http://${req.headers.host}`).hostname; } catch { return false; }
  return Boolean(localSocket && ['localhost', '127.0.0.1', '[::1]'].includes(hostname));
}

export function publicAddress(value) {
  if (!value) return null;
  let url;
  try { url = new URL(value); } catch { throw new Error('PI_WEB_PUBLIC_URL 必须是完整 HTTP/HTTPS 地址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('PI_WEB_PUBLIC_URL 须为不带路径、认证、查询或片段的 HTTP/HTTPS 地址。');
  return url;
}

export function secureRequest(req, server, { host = '127.0.0.1', publicUrl = null } = {}) {
  const port = server.address()?.port;
  const format = (address) => `${address.includes(':') ? `[${address}]` : address}${port === 80 ? '' : `:${port}`}`;
  const hosts = new Set([format('127.0.0.1'), format('localhost'), format('::1')]);
  if (port === 80) for (const item of [...hosts]) hosts.add(`${item}:80`);
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    for (const iface of Object.values(os.networkInterfaces())) for (const item of iface || []) {
      if (!item.address.includes('%')) hosts.add(format(item.address));
    }
  }
  if (publicUrl) hosts.add(publicUrl.host.toLowerCase());
  const requestHost = req.headers.host?.toLowerCase();
  if (!hosts.has(requestHost)) throw new HttpError(403, '此访问地址未被允许。请使用服务器的本机或局域网地址，或配置 PI_WEB_PUBLIC_URL。');
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, '已拒绝跨站访问。');
  const origin = req.headers.origin;
  const expectedOrigin = publicUrl?.host.toLowerCase() === requestHost ? publicUrl.origin : `http://${requestHost}`;
  if (origin && origin !== expectedOrigin) throw new HttpError(403, '已拒绝来自其他站点的请求。');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const upload = req.method === 'POST' && /^\/api\/sessions\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\/attachments$/.test(String(req.url || '').split('?', 1)[0]);
    const expectedType = upload ? 'application/octet-stream' : 'application/json';
    if (req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== expectedType) {
      throw new HttpError(415, `请求必须使用 ${expectedType}。`);
    }
  }
}

export async function jsonBody(req, maxBytes = 1_048_576) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > maxBytes) throw new HttpError(413, '请求内容超过大小限制。');
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw new HttpError(400, 'JSON 格式无效。'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, '请求内容必须是 JSON 对象。');
  return body;
}

export function responseHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
}

export function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

export async function staticFile(req, res, publicDir) {
  let decoded;
  try { decoded = decodeURIComponent(req.url.split('?')[0]); }
  catch { throw new HttpError(400, '无效的资源路径。'); }
  if (decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').includes('..')) throw new HttpError(403, '资源路径无效。');
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const root = await fs.realpath(publicDir);
  const target = path.resolve(root, relative);
  if (!target.startsWith(`${root}${path.sep}`)) throw new HttpError(403, '资源路径无效。');
  let real;
  try { real = await fs.realpath(target); }
  catch { throw new HttpError(404, '页面或资源不存在。'); }
  if (!real.startsWith(`${root}${path.sep}`)) throw new HttpError(403, '资源路径无效。');
  const stat = await fs.stat(real);
  if (!stat.isFile()) throw new HttpError(404, '资源不存在。');
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
  res.writeHead(200, { 'Content-Type': types[path.extname(real)] || 'application/octet-stream', 'Content-Length': stat.size });
  res.end(req.method === 'HEAD' ? undefined : await fs.readFile(real));
}
