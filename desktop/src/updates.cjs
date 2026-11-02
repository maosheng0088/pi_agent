'use strict';
const fs = require('node:fs');
const path = require('node:path');
const semver = require('semver');
const UPDATE_BASE = 'https://ai.junweirpa.asia/desktop-updates/windows/';
const UPDATE_URL = 'piconsole://app/update.html';
function releaseVersion(value) { return typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value) && semver.valid(value) ? value : null; }
function validatePolicy(value) {
  if (!value || value.schemaVersion !== 1 || !releaseVersion(value.latestVersion) || !releaseVersion(value.minimumVersion) || semver.gt(value.minimumVersion, value.latestVersion)) throw new Error('更新策略格式不正确。');
  return { schemaVersion: 1, latestVersion: value.latestVersion, minimumVersion: value.minimumVersion, notes: Array.isArray(value.notes) ? value.notes.filter(note => typeof note === 'string').slice(0, 12).map(note => note.slice(0, 500)) : [] };
}
function validArtifact(info, base, policy, current) {
  if (!releaseVersion(info?.version) || semver.lte(info.version, current) || info.version !== policy.latestVersion || semver.lt(info.version, policy.minimumVersion) || !Array.isArray(info.files) || !info.files.length) return false;
  return info.files.every(file => {
    try {
      if (typeof file.url !== 'string' || /[\\\u0000-\u0020]/.test(file.url)) return false;
      const url = new URL(file.url, base), root = new URL(base);
      return url.origin === root.origin && url.pathname.startsWith(root.pathname) && /\.exe$/i.test(url.pathname) && !url.username && !url.password && !url.hash && /^[A-Za-z0-9+/]{86}==$/.test(file.sha512);
    } catch { return false; }
  });
}
class DesktopUpdates {
  constructor({ version, updater, fetchPolicy, dataDirectory, onState = () => {}, enabled = true, baseUrl = UPDATE_BASE }) {
    if (!releaseVersion(version)) throw new Error('无效的客户端版本。');
    this.updater = updater; this.fetchPolicy = fetchPolicy; this.onState = onState; this.enabled = enabled; this.baseUrl = baseUrl;
    this.cacheFile = path.join(dataDirectory, 'desktop-update-policy.json');
    this.state = { currentVersion: version, latestVersion: version, minimumVersion: version, required: false, status: enabled ? 'idle' : 'unsupported', progress: 0, notes: [], message: '' };
    this.policy = null; this.downloadedVersion = null; this.checking = null; this.downloading = null; this.timer = null; this.disposed = false;
    try { const text = fs.readFileSync(this.cacheFile, 'utf8'); if (text.length <= 32768) this.applyPolicy(validatePolicy(JSON.parse(text))); } catch {}
    if (!enabled) return;
    updater.autoDownload = false; updater.autoInstallOnAppQuit = false; updater.allowDowngrade = false; updater.allowPrerelease = false; updater.disableDifferentialDownload = true;
    updater.on('download-progress', progress => this.patch({ status: 'downloading', progress: Math.max(0, Math.min(100, Math.floor(Number(progress.percent) || 0))) }));
    // electron-updater also emits errors before rejecting a download promise.
    updater.on('error', error => { if (!this.disposed) this.fail(error); });
  }
  get required() { return this.state.required; }
  snapshot() { return { ...this.state, notes: [...this.state.notes] }; }
  patch(value) { if (this.disposed) return; this.state = { ...this.state, ...value }; this.onState(this.snapshot()); }
  applyPolicy(policy) { this.policy = policy; this.patch({ ...policy, required: semver.lt(this.state.currentVersion, policy.minimumVersion) }); }
  savePolicy(policy) { try { fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true }); const temporary = `${this.cacheFile}.tmp`; fs.writeFileSync(temporary, JSON.stringify(policy)); fs.renameSync(temporary, this.cacheFile); } catch {} }
  fail(error) {
    this.patch({ status: 'error', message: '更新未完成，请检查网络后重试。已下载的完整更新可继续安装。' });
    try {
      const log = path.join(path.dirname(this.cacheFile), 'desktop-update.log');
      if (fs.existsSync(log) && fs.statSync(log).size > 65536) fs.writeFileSync(log, '');
      fs.appendFileSync(log, `${new Date().toISOString()} ${String(error?.message || error).replace(/[\r\n]/g, ' ').slice(0, 1000)}\n`);
    } catch {}
  }
  check() {
    if (!this.enabled || this.disposed) return Promise.resolve(this.snapshot());
    if (this.checking) return this.checking;
    this.checking = this.performCheck().finally(() => { this.checking = null; });
    return this.checking;
  }
  async performCheck() {
    this.patch({ status: this.downloading ? 'downloading' : 'checking', message: '' });
    try {
      const policy = validatePolicy(await this.fetchPolicy()); this.applyPolicy(policy); this.savePolicy(policy);
      if (this.disposed) return this.snapshot();
      if (this.downloading) { await this.downloading; return this.snapshot(); }
      if (this.downloadedVersion === policy.latestVersion) { this.patch({ status: 'downloaded', progress: 100 }); return this.snapshot(); }
      if (semver.gte(this.state.currentVersion, policy.latestVersion)) { this.patch({ status: 'current', progress: 0 }); return this.snapshot(); }
      this.downloadedVersion = null;
      const result = await this.updater.checkForUpdates();
      if (this.disposed) return this.snapshot();
      if (!validArtifact(result?.updateInfo, this.baseUrl, policy, this.state.currentVersion)) throw new Error('更新包来源或版本与发布策略不一致，请稍后重试。');
      const version = result.updateInfo.version;
      this.patch({ status: 'downloading', progress: 0 });
      this.downloading = this.updater.downloadUpdate();
      try { await this.downloading; } finally { this.downloading = null; }
      if (this.disposed) return this.snapshot();
      // A policy refresh during download may have raised the minimum version.
      if (semver.lt(version, this.state.minimumVersion)) throw new Error('下载期间发布了更新版本，请重新检查更新。');
      this.downloadedVersion = version; this.patch({ status: 'downloaded', progress: 100 });
    } catch (error) { this.fail(error); }
    return this.snapshot();
  }
  install() {
    if (!this.enabled || !this.downloadedVersion || semver.lt(this.downloadedVersion, this.state.minimumVersion)) throw new Error('请先下载完整更新。');
    this.patch({ status: 'installing', message: '正在安装更新并重新启动…' });
    this.updater.quitAndInstall(true, true);
  }
  startPolling() { if (this.enabled && !this.timer) { this.timer = setInterval(() => void this.check(), 15 * 60 * 1000); this.timer.unref?.(); } }
  dispose() { this.disposed = true; clearInterval(this.timer); this.timer = null; }
}
module.exports = { UPDATE_BASE, UPDATE_URL, releaseVersion, validatePolicy, validArtifact, DesktopUpdates };
