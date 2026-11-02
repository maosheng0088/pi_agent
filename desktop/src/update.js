'use strict';
const byId = id => document.getElementById(id);
let busy = false;
function render(state) {
  byId('current').textContent = state.currentVersion; byId('latest').textContent = state.latestVersion;
  const labels = { idle: '准备检查更新', checking: '正在检查更新', current: '已是最新版本', downloading: '正在下载更新', downloaded: '更新已准备好', installing: '正在安装更新', error: '更新暂未完成', unsupported: '请使用安装版客户端' };
  byId('title').textContent = state.required ? state.status === 'downloaded' ? '更新后继续使用' : '需要更新客户端' : labels[state.status] || '客户端更新';
  byId('message').textContent = state.message || (state.required ? `公司工作台要求使用 ${state.minimumVersion} 或更新版本。更新会自动下载，完成后点击安装。` : state.status === 'current' ? '你正在使用最新版本，可返回工作台继续使用。' : state.status === 'downloaded' ? '点击安装并重新启动，应用此次更新。' : state.status === 'unsupported' ? '请安装新版 PiConsole，以启用后续自动更新。' : '正在从公司更新服务获取最新客户端。');
  byId('download').hidden = state.status !== 'downloading'; byId('progress').value = state.progress; byId('progress-label').textContent = `正在下载更新 · ${state.progress}%`;
  byId('install').hidden = state.status !== 'downloaded'; byId('install').disabled = busy;
  byId('continue').hidden = state.required || ['idle', 'checking', 'installing'].includes(state.status);
  byId('retry').hidden = ['checking', 'downloading', 'installing', 'downloaded'].includes(state.status); byId('retry').disabled = busy;
  byId('notes').replaceChildren(...state.notes.map(note => { const li = document.createElement('li'); li.textContent = note; return li; }));
}
async function refresh() { try { render(await window.piDesktopUpdates.state()); } catch { byId('message').textContent = '无法读取更新状态，请重新打开客户端。'; } }
async function act(action) {
  if (busy) return; busy = true; document.querySelectorAll('button').forEach(button => { button.disabled = true; });
  try { await window.piDesktopUpdates.action(action); } catch (error) { byId('message').textContent = error?.message || '操作未完成，请重试。'; }
  finally { busy = false; document.querySelectorAll('button').forEach(button => { button.disabled = false; }); await refresh(); }
}
byId('retry').addEventListener('click', () => void act('check'));
byId('install').addEventListener('click', () => void act('install'));
byId('continue').addEventListener('click', () => void act('continue'));
byId('quit').addEventListener('click', () => void act('quit'));
void refresh(); setInterval(() => void refresh(), 500);
