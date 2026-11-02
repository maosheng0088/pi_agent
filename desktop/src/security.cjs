'use strict';
const DEFAULT_SERVERS = Object.freeze([
  Object.freeze({ id: 'company', label: '公司服务器', url: 'https://ai.junweirpa.asia/' }),
  Object.freeze({ id: 'local', label: '本机服务', url: 'http://127.0.0.1:3210/' }),
]);
const OFFLINE_URL = 'piconsole://app/offline.html';
function webUrl(value) {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url : null; } catch { return null; }
}
function normalizeServers(values = DEFAULT_SERVERS) {
  if (!Array.isArray(values) || !values.length || values.length > 8) throw new Error('无效的服务器列表。');
  const seen = new Set();
  return values.map(value => {
    const url = webUrl(value.url);
    if (!/^[a-z0-9-]{1,40}$/.test(value.id) || seen.has(value.id) || !url || (url.protocol === 'http:' && !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) throw new Error('仅支持 HTTPS 服务或本机回环地址。');
    seen.add(value.id); url.hash = ''; url.search = ''; url.pathname = '/';
    return { id: value.id, label: String(value.label || value.id).slice(0, 60), url: url.href };
  });
}
function sameServer(value, base) { const url = webUrl(value), server = webUrl(base); return !!url && !!server && url.origin === server.origin; }
function navigationDecision(value, base) { return sameServer(value, base) ? 'internal' : webUrl(value) ? 'external' : 'blocked'; }
function canDownload(value, base) {
  if (sameServer(value, base)) return true;
  try { return new URL(value).protocol === 'blob:' && new URL(value).origin === new URL(base).origin; } catch { return false; }
}
function safeFilename(value) {
  let name = String(value || '下载文件').split(/[\\/]/).at(-1).replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/[ .]+$/g, '').slice(0, 180);
  if (!name || name === '.' || name === '..') name = '下载文件';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
  return name;
}
function rendererPreferences(partition, preload) {
  return { partition, preload, nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, navigateOnDragDrop: false, spellcheck: false };
}
function trustedOfflineSender(event, contents) {
  return event.sender === contents && event.senderFrame === contents.mainFrame && event.senderFrame?.url === OFFLINE_URL;
}
function windowBounds(saved, areas) {
  const primary = areas[0] || { x: 0, y: 0, width: 1440, height: 900 };
  const fallback = { width: Math.min(1440, primary.width), height: Math.min(960, primary.height) };
  const valid = saved && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(saved[key])) && saved.width >= 640 && saved.height >= 480 && saved.width <= 8000 && saved.height <= 8000;
  if (!valid || !areas.some(area => Math.min(saved.x + saved.width, area.x + area.width) - Math.max(saved.x, area.x) >= 100 && Math.min(saved.y + 60, area.y + area.height) - Math.max(saved.y, area.y) >= 30)) return fallback;
  return { x: saved.x, y: saved.y, width: Math.min(saved.width, 4000), height: Math.min(saved.height, 2400) };
}
module.exports = { DEFAULT_SERVERS, OFFLINE_URL, webUrl, normalizeServers, sameServer, navigationDecision, canDownload, safeFilename, rendererPreferences, trustedOfflineSender, windowBounds };
