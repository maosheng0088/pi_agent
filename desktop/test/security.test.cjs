'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_SERVERS, normalizeServers, navigationDecision, canDownload, safeFilename, rendererPreferences, trustedOfflineSender, windowBounds, OFFLINE_URL } = require('../src/security.cjs');
const base = DEFAULT_SERVERS[0].url;
test('only secure company and explicit local services are configured', () => {
  assert.deepEqual(normalizeServers(), DEFAULT_SERVERS);
  for (const url of ['file:///C:/Windows/win.ini', 'javascript:alert(1)', 'http://10.0.0.1/', 'https://admin:secret@example.com/']) assert.throws(() => normalizeServers([{ id: 'bad', url }]));
  assert.equal(normalizeServers([{ id: 'local-test', url: 'http://127.0.0.1:45678/?secret=no#old' }])[0].url, 'http://127.0.0.1:45678/');
});
test('main navigation cannot become a local file or a disguised company origin', () => {
  assert.equal(navigationDecision(`${base}#view=agents`, base), 'internal');
  assert.equal(navigationDecision('https://open.feishu.cn/docs', base), 'external');
  assert.equal(navigationDecision('https://ai.junweirpa.asia.evil.example/', base), 'external');
  for (const url of ['file:///C:/Windows/win.ini', 'data:text/html,hello', 'javascript:alert(1)', 'cmd.exe', OFFLINE_URL, 'https://user:password@ai.junweirpa.asia/']) assert.equal(navigationDecision(url, base), 'blocked');
});
test('downloads stay within the selected server or its own generated blobs', () => {
  assert.equal(canDownload(`${base}api/sessions/alpha/attachments/report`, base), true);
  assert.equal(canDownload('blob:https://ai.junweirpa.asia/fake-fixture-id', base), true);
  for (const url of ['file:///C:/secret', 'blob:https://evil.example/id', 'data:application/octet-stream,hello', 'https://evil.example/payload.exe']) assert.equal(canDownload(url, base), false);
  assert.equal(safeFilename('../../folder/report.xlsx'), 'report.xlsx');
  assert.equal(safeFilename('CON.txt'), '_CON.txt');
  assert.equal(safeFilename('bad:name?.csv'), 'bad_name_.csv');
});
test('web renderer cannot use Node, disable isolation or attach webviews', () => {
  const preferences = rendererPreferences('persist:test', '/owned/preload.cjs');
  assert.equal(preferences.nodeIntegration, false); assert.equal(preferences.nodeIntegrationInSubFrames, false); assert.equal(preferences.contextIsolation, true); assert.equal(preferences.sandbox, true); assert.equal(preferences.webSecurity, true); assert.equal(preferences.webviewTag, false);
});
test('only our top-level offline page can call the desktop recovery bridge', () => {
  const mainFrame = { url: OFFLINE_URL }, contents = { mainFrame };
  assert.equal(trustedOfflineSender({ sender: contents, senderFrame: mainFrame }, contents), true);
  assert.equal(trustedOfflineSender({ sender: contents, senderFrame: { url: OFFLINE_URL } }, contents), false);
  mainFrame.url = base; assert.equal(trustedOfflineSender({ sender: contents, senderFrame: mainFrame }, contents), false);
});
test('a saved window cannot reopen off-screen after changing monitors', () => {
  const areas = [{ x: 0, y: 0, width: 1920, height: 1040 }];
  assert.deepEqual(windowBounds({ x: 9000, y: 9000, width: 1200, height: 800 }, areas), { width: 1440, height: 960 });
  assert.deepEqual(windowBounds({ x: 100, y: 50, width: 1200, height: 800 }, areas), { x: 100, y: 50, width: 1200, height: 800 });
});
