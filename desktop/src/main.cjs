'use strict';
const { app, BrowserWindow, Menu, dialog, ipcMain, net, protocol, session, shell, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { DEFAULT_SERVERS, OFFLINE_URL, normalizeServers, sameServer, navigationDecision, canDownload, safeFilename, rendererPreferences, trustedOfflineSender, windowBounds, webUrl } = require('./security.cjs');
const { UPDATE_BASE, UPDATE_URL, DesktopUpdates } = require('./updates.cjs');

protocol.registerSchemesAsPrivileged([{ scheme: 'piconsole', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const assets = path.join(__dirname, '..', 'assets');
const preload = path.join(__dirname, 'preload.cjs');
const partition = 'persist:piconsole-workspace';
const channels = ['piconsole:state', 'piconsole:action', 'piconsole:update-state', 'piconsole:update-action'];
const localResources = new Map([['/offline.html', ['offline.html', 'text/html; charset=utf-8']], ['/offline.css', ['offline.css', 'text/css; charset=utf-8']], ['/offline.js', ['offline.js', 'text/javascript; charset=utf-8']], ['/icon.png', [path.join(assets, 'icon.png'), 'image/png']]]);
for (const [name, type] of [['update.html', 'text/html; charset=utf-8'], ['update.css', 'text/css; charset=utf-8'], ['update.js', 'text/javascript; charset=utf-8']]) localResources.set(`/${name}`, [name, type]);

async function startDesktop(options = {}) {
  const servers = normalizeServers(options.servers || DEFAULT_SERVERS);
  const userData = options.dataDirectory || path.join(app.getPath('appData'), 'PiConsole');
  app.setName('PiConsole'); app.setAppUserModelId('asia.junweirpa.piconsole');
  fs.mkdirSync(userData, { recursive: true }); app.setPath('userData', userData);
  if (!options.allowMultiple && !app.requestSingleInstanceLock()) { app.quit(); return null; }
  let saved = {};
  const settingsFile = path.join(userData, 'desktop-settings.json');
  try { const data = fs.readFileSync(settingsFile, 'utf8'); if (data.length < 16384) saved = JSON.parse(data); } catch {}
  let selected = servers.find(server => server.id === saved.serverId) || servers[0], window = null, lastError = '', generation = 0, retryTimer;
  let updates = null, bootComplete = false, showingUpdate = null, notifiedVersion = '';
  const writeSettings = () => { try { const temporary = `${settingsFile}.tmp`; fs.writeFileSync(temporary, JSON.stringify(saved, null, 2)); fs.renameSync(temporary, settingsFile); } catch {} };
  const alive = () => window && !window.isDestroyed();
  const openExternal = value => { if (webUrl(value)) void shell.openExternal(value).catch(() => { if (alive()) void dialog.showMessageBox(window, { type: 'error', message: '无法打开浏览器', detail: '请手动复制链接到浏览器。' }); }); };
  await app.whenReady();
  const workspace = session.fromPartition(partition);
  // Remote pages have no local execution bridge. Camera, microphone and other
  // permissions remain unavailable; copying a result is allowed for our origin.
  workspace.setPermissionCheckHandler((_contents, permission, requestingOrigin) => permission === 'clipboard-sanitized-write' && sameServer(requestingOrigin, selected.url));
  workspace.setPermissionRequestHandler((contents, permission, callback, details) => callback(permission === 'clipboard-sanitized-write' && sameServer(details.requestingUrl || contents.getURL(), selected.url)));
  workspace.protocol.handle('piconsole', async request => {
    const url = new URL(request.url), resource = url.host === 'app' && localResources.get(url.pathname);
    if (!resource || !['GET', 'HEAD'].includes(request.method)) return new Response('Not found', { status: 404 });
    const filename = path.isAbsolute(resource[0]) ? resource[0] : path.join(__dirname, resource[0]);
    const response = await net.fetch(pathToFileURL(filename).href);
    return new Response(request.method === 'HEAD' ? null : response.body, { headers: { 'Content-Type': resource[1], 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" } });
  });
  async function offline(reason) {
    if (!alive() || window.webContents.getURL() === OFFLINE_URL) return;
    generation++; clearTimeout(retryTimer); lastError = reason === 'crashed' ? '工作台页面已停止响应，请重新连接。' : '暂时无法连接工作台，请确认服务和网络连接正常。';
    try { await window.loadURL(OFFLINE_URL); } catch { if (alive()) dialog.showErrorBox('PiConsole', '无法加载连接页面，请重新打开桌面端。'); }
  }
  async function connect(serverId = selected.id) {
    if (updates?.required) { await showUpdate(); return; }
    const next = servers.find(server => server.id === serverId); if (!next) throw new Error('无效的服务器。');
    selected = next; saved.serverId = next.id; writeSettings(); buildMenu();
    if (!alive()) return;
    const token = ++generation; clearTimeout(retryTimer); lastError = '';
    retryTimer = setTimeout(() => { if (token === generation && alive()) { window.webContents.stop(); void offline('timeout'); } }, 25000);
    try { await window.loadURL(selected.url); } catch (reason) { if (token === generation && reason.code !== 'ERR_ABORTED') await offline('network'); }
    finally { if (token === generation) clearTimeout(retryTimer); }
  }
  async function showUpdate() {
    if (!alive() || window.webContents.getURL() === UPDATE_URL) { buildMenu(); return; }
    if (showingUpdate) return showingUpdate;
    generation++; clearTimeout(retryTimer); window.webContents.stop();
    showingUpdate = window.loadURL(UPDATE_URL).finally(() => { showingUpdate = null; buildMenu(); });
    return showingUpdate;
  }
  function guardContents(contents, owner) {
    const navigate = event => {
      if (event.isMainFrame === false) return;
      const decision = navigationDecision(event.url, selected.url);
      if (decision !== 'internal') { event.preventDefault(); if (decision === 'external') openExternal(event.url); }
    };
    contents.on('will-navigate', navigate); contents.on('will-redirect', navigate);
    contents.on('will-attach-webview', event => event.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      if (sameServer(url, selected.url)) return { action: 'allow', overrideBrowserWindowOptions: { parent: owner, width: 1100, height: 820, title: 'PiConsole · 文件预览', autoHideMenuBar: true, icon: path.join(assets, 'icon.png'), webPreferences: { ...rendererPreferences(partition), preload: undefined } } };
      openExternal(url); return { action: 'deny' };
    });
    contents.on('did-create-window', child => { child.removeMenu(); guardContents(child.webContents, child); });
    contents.on('render-process-gone', () => { if (alive() && contents === window.webContents) void offline('crashed'); });
  }
  workspace.on('will-download', (event, item) => {
    if (!canDownload(item.getURL(), selected.url)) { event.preventDefault(); return; }
    item.setSaveDialogOptions({ title: '保存工作台文件', defaultPath: path.join(app.getPath('downloads'), safeFilename(item.getFilename())) });
    item.on('updated', () => { if (alive()) window.setProgressBar(item.getTotalBytes() ? item.getReceivedBytes() / item.getTotalBytes() : 2); });
    item.once('done', (_event, state) => { if (!alive()) return; window.setProgressBar(-1); if (state === 'interrupted') void dialog.showMessageBox(window, { type: 'error', message: '文件下载中断', detail: '请回到聊天中重新下载。' }); });
  });
  for (const channel of channels) ipcMain.removeHandler(channel);
  function checkSender(event) { if (!alive() || !trustedOfflineSender(event, window.webContents)) throw new Error('此操作仅适用于桌面连接页面。'); }
  ipcMain.handle('piconsole:state', event => { checkSender(event); return { serverId: selected.id, serverUrl: selected.url, servers, message: lastError, version: app.getVersion() }; });
  ipcMain.handle('piconsole:action', async (event, action) => {
    checkSender(event);
    if (action === 'retry') { void connect(); return; }
    if (action === 'browser') { openExternal(selected.url); return; }
    if (typeof action === 'string' && action.startsWith('server:') && servers.some(server => `server:${server.id}` === action)) { void connect(action.slice(7)); return; }
    throw new Error('不支持的操作。');
  });
  function checkUpdateSender(event) { if (!alive() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame?.url !== UPDATE_URL) throw new Error('更新操作仅适用于客户端更新页面。'); }
  ipcMain.handle('piconsole:update-state', event => { checkUpdateSender(event); return updates.snapshot(); });
  ipcMain.handle('piconsole:update-action', async (event, action) => {
    checkUpdateSender(event);
    if (action === 'check') { void updates.check(); return; }
    if (action === 'install') { updates.install(); return; }
    if (action === 'continue' && !updates.required) { void connect(); return; }
    if (action === 'quit') { app.quit(); return; }
    throw new Error('请更新客户端后继续使用。');
  });
  function buildMenu() {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: '工作台', submenu: [{ label: '回到工作台', accelerator: 'Alt+Home', click: () => void connect() }, { label: '重新连接 / 刷新', accelerator: 'CmdOrCtrl+R', click: () => { if (!alive()) return; if (window.webContents.getURL() === OFFLINE_URL) void connect(); else window.webContents.reload(); } }, { type: 'separator' }, ...servers.map(server => ({ label: server.label, type: 'radio', checked: server.id === selected.id, click: () => void connect(server.id) })), { type: 'separator' }, { label: '在浏览器中打开', click: () => openExternal(alive() && sameServer(window.webContents.getURL(), selected.url) ? window.webContents.getURL() : selected.url) }, { type: 'separator' }, { label: '退出桌面端', role: 'quit' }] },
      { label: '编辑', submenu: [{ label: '撤销', role: 'undo' }, { label: '重做', role: 'redo' }, { type: 'separator' }, { label: '剪切', role: 'cut' }, { label: '复制', role: 'copy' }, { label: '粘贴', role: 'paste' }, { label: '全选', role: 'selectAll' }] },
      { label: '视图', submenu: [{ label: '放大', role: 'zoomIn' }, { label: '缩小', role: 'zoomOut' }, { label: '恢复原始大小', role: 'resetZoom' }, { type: 'separator' }, { label: '全屏 / 退出全屏', accelerator: 'F11', click: () => { if (alive()) window.setFullScreen(!window.isFullScreen()); } }, { label: '最小化', role: 'minimize' }] },
      { label: '帮助', submenu: [{ label: '检查客户端更新', click: () => { void showUpdate().then(() => updates.check()); } }, { type: 'separator' }, { label: '关于 PiConsole', click: () => { if (alive()) void dialog.showMessageBox(window, { type: 'info', title: '关于 PiConsole', message: `PiConsole ${app.getVersion()}`, detail: `Windows 桌面版\n${selected.label}：${selected.url}\n使用现有账号登录，与网页端共享聊天和业务数据。` }); } }] },
    ]));
  }
  function createWindow(autoConnect = true) {
    const bounds = windowBounds(saved.bounds, screen.getAllDisplays().map(display => display.workArea));
    window = new BrowserWindow({ ...bounds, minWidth: 800, minHeight: 600, show: false, backgroundColor: '#f8faff', title: 'PiConsole · 企业智能体', icon: path.join(assets, 'icon.png'), webPreferences: rendererPreferences(partition, preload) });
    guardContents(window.webContents, window);
    window.webContents.on('page-title-updated', event => { event.preventDefault(); if (alive()) window.setTitle('PiConsole · 企业智能体'); });
    window.webContents.on('did-fail-load', (_event, code, _description, url, isMainFrame) => { if (isMainFrame && code !== -3 && sameServer(url, selected.url)) void offline('network'); });
    window.once('ready-to-show', () => { if (!alive() || options.showWindow === false) return; if (saved.maximized !== false) window.maximize(); window.show(); });
    window.on('close', () => { clearTimeout(retryTimer); saved = { ...saved, bounds: window.getNormalBounds(), maximized: window.isMaximized() }; writeSettings(); });
    const created = window;
    window.on('closed', () => { if (window === created) window = null; });
    buildMenu(); if (autoConnect) void connect(); return window;
  }
  app.on('second-instance', () => { if (!alive()) createWindow(); if (alive()) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.on('activate', () => { if (!alive()) createWindow(); });
  app.on('window-all-closed', () => { if (options.quitOnClose !== false) app.quit(); });
  const updatesEnabled = options.enableUpdates ?? (app.isPackaged && process.platform === 'win32' && options.disableUpdates !== true);
  updates = new DesktopUpdates({ version: app.getVersion(), enabled: updatesEnabled, updater: updatesEnabled ? (options.updater || require('electron-updater').autoUpdater) : null, dataDirectory: userData,
    fetchPolicy: options.fetchUpdatePolicy || (async () => {
      const response = await net.fetch(`${UPDATE_BASE}policy.json?t=${Date.now()}`, { signal: AbortSignal.timeout(10000), redirect: 'error', headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' } });
      if (!response.ok || Number(response.headers.get('content-length')) > 32768) throw new Error('更新服务暂时不可用。');
      const text = await response.text(); if (text.length > 32768) throw new Error('更新策略过大。'); return JSON.parse(text);
    }),
    onState: state => {
      if (!alive()) return;
      if (state.required) { bootComplete = true; void showUpdate(); }
      else if (!bootComplete && ['downloading', 'current', 'downloaded', 'error'].includes(state.status) && state.schemaVersion === 1) { bootComplete = true; void connect(); }
      if (state.status === 'downloaded' && !state.required && notifiedVersion !== state.latestVersion) {
        notifiedVersion = state.latestVersion;
        void dialog.showMessageBox(window, { type: 'info', title: 'PiConsole 更新', message: `新版本 ${state.latestVersion} 已准备好`, detail: '重新启动客户端以安装更新，服务器任务会继续运行。', buttons: ['立即更新', '稍后'], defaultId: 0, cancelId: 1 }).then(result => { if (result.response === 0) updates.install(); });
      }
    },
  });
  app.on('before-quit', () => updates.dispose());
  createWindow(false);
  if (updatesEnabled) {
    await showUpdate();
    void updates.check().then(() => { if (!bootComplete && alive()) { bootComplete = true; if (updates.required) void showUpdate(); else void connect(); } });
    updates.startPolling();
  } else { bootComplete = true; void connect(); }
  return { get window() { return window; }, session: workspace, connect, createWindow, updates, servers, dataDirectory: userData };
}
module.exports = { startDesktop };
if (require.main === module) void startDesktop().catch(error => { dialog.showErrorBox('PiConsole 启动失败', error.message); app.quit(); });
