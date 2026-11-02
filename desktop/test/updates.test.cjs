'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { UPDATE_BASE, validatePolicy, validArtifact, DesktopUpdates } = require('../src/updates.cjs');
const checksum = crypto.createHash('sha512').update('verified installer fixture').digest('base64');
const policy = { schemaVersion: 1, latestVersion: '0.2.0', minimumVersion: '0.2.0', notes: ['客户端更新'] };
const info = { version: '0.2.0', files: [{ url: 'PiConsole-Setup-0.2.0-x64.exe', sha512: checksum }] };
class FakeUpdater extends EventEmitter {
  constructor() { super(); this.checks = 0; this.downloads = 0; this.installs = []; }
  async checkForUpdates() { this.checks++; return { updateInfo: info }; }
  async downloadUpdate() { this.downloads++; this.emit('download-progress', { percent: 54.8 }); return ['/verified/update.exe']; }
  quitAndInstall(...args) { this.installs.push(args); }
}
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-desktop-updates-test-'));
  const updater = new FakeUpdater(), states = [];
  const controller = new DesktopUpdates({ version: '0.1.0', updater, fetchPolicy: async () => policy, dataDirectory: directory, onState: state => states.push(state), ...options });
  t.after(() => { controller.dispose(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('pi-desktop-updates-test-')); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, updater, controller, states };
}
test('policy accepts only stable versions and an attainable minimum', () => {
  assert.equal(validatePolicy(policy).minimumVersion, '0.2.0');
  for (const patch of [{ minimumVersion: '0.3.0' }, { latestVersion: 'v0.2.0' }, { latestVersion: '0.2.0-beta.1' }, { schemaVersion: 2 }]) assert.throws(() => validatePolicy({ ...policy, ...patch }));
  assert.equal(validatePolicy({ ...policy, notes: ['safe', 123] }).notes.length, 1);
});
test('only the exact release and same-feed installers with valid hashes may download', () => {
  assert.equal(validArtifact(info, UPDATE_BASE, policy, '0.1.0'), true);
  for (const url of ['https://evil.example/update.exe', 'http://ai.junweirpa.asia/update.exe', '../update.exe', 'file:///C:/update.exe', '//evil.example/update.exe', 'PiConsole.exe#fragment']) assert.equal(validArtifact({ ...info, files: [{ url, sha512: checksum }] }, UPDATE_BASE, policy, '0.1.0'), false);
  assert.equal(validArtifact({ ...info, files: [{ url: info.files[0].url, sha512: 'wrong' }] }, UPDATE_BASE, policy, '0.1.0'), false);
  assert.equal(validArtifact({ ...info, version: '0.3.0' }, UPDATE_BASE, policy, '0.1.0'), false);
  assert.equal(validArtifact(info, UPDATE_BASE, policy, '0.2.0'), false);
});
test('mandatory update downloads, reports progress, and installs only verified completed downloads', async t => {
  const { controller, updater, states } = fixture(t);
  assert.throws(() => controller.install());
  await controller.check();
  assert.equal(controller.required, true); assert.equal(controller.snapshot().status, 'downloaded');
  assert.ok(states.some(state => state.progress === 54)); assert.equal(updater.downloads, 1);
  assert.equal(updater.autoInstallOnAppQuit, false); assert.equal(updater.allowDowngrade, false);
  controller.install(); assert.deepEqual(updater.installs, [[true, true]]);
});
test('normal updates remain optional when the current version meets the minimum', async t => {
  const { controller } = fixture(t, { fetchPolicy: async () => ({ ...policy, minimumVersion: '0.1.0' }) });
  await controller.check(); assert.equal(controller.required, false); assert.equal(controller.snapshot().status, 'downloaded');
});
test('a known mandatory policy survives a network error and restarting the application', async t => {
  const first = fixture(t); await first.controller.check();
  const reopened = new DesktopUpdates({ version: '0.1.0', updater: new FakeUpdater(), dataDirectory: first.directory, fetchPolicy: async () => { throw new Error('Network disconnected'); } });
  t.after(() => reopened.dispose()); assert.equal(reopened.required, true);
  await reopened.check(); assert.equal(reopened.required, true); assert.equal(reopened.snapshot().status, 'error'); assert.throws(() => reopened.install());
});
test('failed or mismatched packages cannot become installable, and retries recover', async t => {
  const { controller, updater } = fixture(t);
  updater.checkForUpdates = async () => ({ updateInfo: { ...info, files: [{ url: 'https://evil.example/payload.exe', sha512: checksum }] } });
  await controller.check(); assert.equal(updater.downloads, 0); assert.equal(controller.snapshot().status, 'error'); assert.throws(() => controller.install());
  updater.checkForUpdates = async () => ({ updateInfo: info });
  updater.downloadUpdate = async () => { throw new Error('checksum mismatch'); };
  await controller.check(); assert.equal(controller.snapshot().status, 'error'); assert.throws(() => controller.install());
  updater.downloadUpdate = async () => ['/verified.exe']; await controller.check(); assert.equal(controller.snapshot().status, 'downloaded');
});
test('duplicate checks coalesce and a compliant up-to-date client does not download', async t => {
  let resolve; const pending = new Promise(yes => { resolve = yes; });
  const { controller, updater } = fixture(t, { version: '0.2.0', fetchPolicy: () => pending });
  const first = controller.check(); assert.equal(controller.check(), first); resolve(policy); await first;
  assert.equal(controller.snapshot().status, 'current'); assert.equal(controller.required, false); assert.equal(updater.checks, 0); assert.equal(updater.downloads, 0);
});
test('a raised minimum during download prevents installing the superseded package', async t => {
  let complete; const pending = new Promise(yes => { complete = yes; });
  const { controller, updater } = fixture(t);
  updater.downloadUpdate = () => pending;
  const check = controller.check(); await new Promise(resolve => setImmediate(resolve));
  controller.applyPolicy({ ...policy, latestVersion: '0.3.0', minimumVersion: '0.3.0' }); complete(['/old-update.exe']); await check;
  assert.equal(controller.snapshot().status, 'error'); assert.throws(() => controller.install());
});
