'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { app, BrowserWindow } = require('electron');
const { startDesktop } = require('../src/main.cjs');
const directory = process.env.PI_DESKTOP_TEST_DIRECTORY;
const reportDirectory = path.resolve(__dirname, '../../qa/desktop-client-20261101');
const events = [];
const server = http.createServer((request, response) => {
  if (request.url === '/login') { response.writeHead(200, { 'Set-Cookie': 'desktop-test=fixture; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600' }); response.end('ok'); return; }
  if (request.url === '/protected') { response.writeHead(request.headers.cookie?.includes('desktop-test=fixture') ? 200 : 401); response.end('ok'); return; }
  if (request.url === '/upload') { const chunks = []; request.on('data', chunk => chunks.push(chunk)); request.on('end', () => { events.push({ upload: Buffer.concat(chunks).toString('utf8') }); response.end('received'); }); return; }
  if (request.url === '/report') { response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': 'attachment; filename="desktop-fixture.txt"' }); response.end('桌面附件验收\n'); return; }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'" }); response.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Desktop test</title><h1>桌面测试工作台</h1><input type="file" id="attachment"></html>');
});
async function until(check, label) { const deadline = Date.now() + 20000; while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 80)); } throw new Error(`Timeout: ${label}`); }
void (async () => {
  if (!directory) throw new Error('Missing isolated test directory');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${server.address().port}/`;
  const desktop = await startDesktop({ servers: [{ id: 'company', label: '隔离测试服务', url: origin }], dataDirectory: path.join(directory, 'profile'), showWindow: false, allowMultiple: true, quitOnClose: false });
  await until(() => desktop.window.webContents.getURL() === origin && !desktop.window.webContents.isLoading(), 'workspace load');
  const contents = desktop.window.webContents;
  const isolation = await contents.executeJavaScript('({node:typeof require,process:typeof process,desktop:typeof window.piDesktop})');
  assert.deepEqual(isolation, { node: 'undefined', process: 'undefined', desktop: 'undefined' });
  assert.equal(await contents.executeJavaScript("fetch('/login',{method:'POST'}).then(()=>fetch('/protected')).then(r=>r.status)"), 200);
  await desktop.session.flushStorageData(); assert.equal((await desktop.session.cookies.get({ name: 'desktop-test' }))[0].httpOnly, true);
  assert.equal(await contents.executeJavaScript("fetch('/upload',{method:'POST',body:new File(['fixture-file'],'fixture.txt',{type:'text/plain'})}).then(r=>r.status)"), 200);
  assert.equal(events[0].upload, 'fixture-file');
  const downloaded = new Promise((resolve, reject) => desktop.session.once('will-download', (_event, item) => { item.setSavePath(path.join(directory, 'download.txt')); item.once('done', (_event, status) => status === 'completed' ? resolve() : reject(new Error(status))); }));
  contents.downloadURL(`${origin}report`); await downloaded; assert.equal(await fs.readFile(path.join(directory, 'download.txt'), 'utf8'), '桌面附件验收\n');
  const before = BrowserWindow.getAllWindows().length; await contents.executeJavaScript("void window.open('file:///C:/Windows/win.ini')"); assert.equal(BrowserWindow.getAllWindows().length, before);
  await new Promise(resolve => { desktop.window.once('closed', resolve); desktop.window.close(); }); desktop.createWindow(); await until(() => desktop.window.webContents.getURL() === origin && !desktop.window.webContents.isLoading(), 'reopen');
  assert.equal(await desktop.window.webContents.executeJavaScript("fetch('/protected').then(r=>r.status)"), 200);
  const closing = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closing; await desktop.connect();
  await until(() => desktop.window.webContents.getURL() === 'piconsole://app/offline.html' && !desktop.window.webContents.isLoading(), 'offline recovery page');
  const state = await desktop.window.webContents.executeJavaScript('window.piDesktop.state()'); assert.equal(state.serverUrl, origin);
  await fs.mkdir(reportDirectory, { recursive: true }); await fs.writeFile(path.join(reportDirectory, 'offline.png'), (await desktop.window.webContents.capturePage()).toPNG());
  const report = { testedAt: new Date().toISOString(), isolation, loginCookie: true, restoredLogin: true, uploadedFile: true, downloadedFile: true, blockedLocalFilePopup: true, offlineRecovery: true };
  await fs.writeFile(path.join(reportDirectory, 'runtime-report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
  desktop.window.close(); app.quit();
})().catch(error => { console.error(error); server.closeAllConnections(); server.close(); app.exit(1); });
