'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { app } = require('electron');
const { startDesktop } = require('../src/main.cjs');
const { UPDATE_URL, DesktopUpdates } = require('../src/updates.cjs');
const directory = process.env.PI_DESKTOP_UPDATE_TEST_DIRECTORY;
const reportDirectory = path.resolve(__dirname, '../../qa/desktop-updater-20261101');
const output = path.resolve(__dirname, '../release/installer');
let server;
async function until(check, label) { const deadline = Date.now() + 20000; while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 60)); } throw new Error(`Timeout: ${label}`); }
class FakeUpdater extends EventEmitter {
  async checkForUpdates() { return { updateInfo: { version: '99.0.0', files: [{ url: 'PiConsole-Setup-99.0.0-x64.exe', sha512: crypto.createHash('sha512').update('fixture').digest('base64') }] } }; }
  downloadUpdate() { return new Promise(resolve => { this.complete = resolve; }); }
  quitAndInstall(...args) { this.installArguments = args; }
}
void (async () => {
  if (!directory) throw new Error('Missing isolated test directory');
  const updater = new FakeUpdater();
  const desktop = await startDesktop({ dataDirectory: path.join(directory, 'profile'), showWindow: false, allowMultiple: true, quitOnClose: false, enableUpdates: true, updater,
    fetchUpdatePolicy: async () => ({ schemaVersion: 1, latestVersion: '99.0.0', minimumVersion: '99.0.0', notes: ['隔离测试：验证强制更新页面。'] }) });
  await until(() => desktop.window.webContents.getURL() === UPDATE_URL && !desktop.window.webContents.isLoading() && updater.complete, 'forced update page');
  const contents = desktop.window.webContents;
  assert.equal((await contents.executeJavaScript('window.piDesktopUpdates.state()')).required, true);
  assert.equal(await contents.executeJavaScript("window.piDesktopUpdates.action('continue').then(()=>false,()=>true)"), true);
  assert.equal(await contents.executeJavaScript("window.piDesktopUpdates.action('install').then(()=>false,()=>true)"), true);
  await desktop.connect('local'); assert.equal(contents.getURL(), UPDATE_URL);
  updater.emit('download-progress', { percent: 67 });
  await contents.executeJavaScript('window.piDesktopUpdates.state().then(state => { document.getElementById("progress").value = state.progress; })');
  await fs.mkdir(reportDirectory, { recursive: true });
  await fs.writeFile(path.join(reportDirectory, 'mandatory-downloading.png'), (await contents.capturePage()).toPNG());
  updater.complete(['/verified/fixture.exe']); await desktop.updates.check();
  await until(async () => contents.executeJavaScript('!document.getElementById("install").hidden'), 'install action visible');
  await fs.writeFile(path.join(reportDirectory, 'mandatory-ready.png'), (await contents.capturePage()).toPNG());
  await contents.executeJavaScript("window.piDesktopUpdates.action('install')"); assert.deepEqual(updater.installArguments, [true, true]);
  desktop.updates.dispose();

  // Exercise the real NSIS downloader against the actual built installer. Never install it here.
  const { NsisUpdater } = require('electron-updater');
  const { ElectronHttpExecutor } = require('electron-updater/out/electronHttpExecutor');
  const yaml = require('yaml'), manifestText = await fs.readFile(path.join(output, 'latest.yml'), 'utf8'), manifest = yaml.parse(manifestText);
  server = http.createServer(async (request, response) => {
    const filename = new URL(request.url, 'http://localhost').pathname.slice(1);
    if (!['latest.yml', manifest.path].includes(filename)) { response.writeHead(404); response.end(); return; }
    const file = path.join(output, filename), stat = await fs.stat(file);
    response.writeHead(200, { 'Content-Type': filename.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream', 'Content-Length': stat.size });
    require('node:fs').createReadStream(file).pipe(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const baseUrl = `http://127.0.0.1:${server.address().port}/`;
  const adapter = { version: '0.1.0', name: 'PiConsole updater fixture', isPackaged: true, appUpdateConfigPath: path.join(directory, 'test-update.yml'), userDataPath: path.join(directory, 'real-profile'), baseCachePath: path.join(directory, 'cache'), whenReady: () => app.whenReady(), relaunch() { throw new Error('Test must not relaunch'); }, quit() { throw new Error('Test must not quit through updater'); }, onQuit() {} };
  await fs.writeFile(adapter.appUpdateConfigPath, `provider: generic\nurl: ${baseUrl}\nupdaterCacheDirName: piconsole-test-updater\n`);
  const realUpdater = new NsisUpdater(null, adapter);
  realUpdater.httpExecutor = new ElectronHttpExecutor();
  realUpdater.setFeedURL({ provider: 'generic', url: baseUrl, useMultipleRangeRequest: false });
  realUpdater.disableWebInstaller = true;
  const controller = new DesktopUpdates({ version: '0.1.0', updater: realUpdater, baseUrl, dataDirectory: path.join(directory, 'real-policy'), fetchPolicy: async () => ({ schemaVersion: 1, latestVersion: manifest.version, minimumVersion: manifest.version, notes: [] }) });
  await controller.check(); assert.equal(controller.snapshot().status, 'downloaded'); assert.equal(controller.required, true);
  const actualPath = realUpdater.installerPath;
  const digest = crypto.createHash('sha512'); for await (const chunk of require('node:fs').createReadStream(actualPath)) digest.update(chunk);
  assert.equal(digest.digest('base64'), manifest.sha512); controller.dispose();
  const report = { testedAt: new Date().toISOString(), mandatoryScreen: true, cannotSkip: true, cannotSwitchServerToBypass: true, incompleteInstallBlocked: true, installIPC: true, actualNsisDownload: true, actualChecksumValidated: true, installerVersion: manifest.version, installerBytes: (await fs.stat(actualPath)).size };
  await fs.writeFile(path.join(reportDirectory, 'update-runtime-report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
  await new Promise(resolve => server.close(resolve)); server.closeAllConnections(); desktop.window.close(); app.quit();
})().catch(error => { console.error(error); server?.closeAllConnections(); server?.close(); app.exit(1); });
