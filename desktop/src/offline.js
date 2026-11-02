'use strict';
async function act(action) {
  const buttons = [...document.querySelectorAll('button')]; buttons.forEach(button => { button.disabled = true; });
  try { document.getElementById('message').textContent = action === 'browser' ? '正在打开浏览器…' : '正在重新连接，请稍候…'; await window.piDesktop.action(action); }
  catch { document.getElementById('message').textContent = '连接未完成，请重新打开桌面端或稍后再试。'; }
  finally { buttons.forEach(button => { button.disabled = false; }); }
}
document.getElementById('retry').addEventListener('click', () => void act('retry'));
document.getElementById('browser').addEventListener('click', () => void act('browser'));
window.piDesktop.state().then(state => {
  document.getElementById('server').textContent = state.serverUrl;
  if (state.message) document.getElementById('message').textContent = state.message;
  for (const server of state.servers) { const button = document.createElement('button'); button.textContent = server.label; button.setAttribute('aria-current', String(state.serverId === server.id)); button.addEventListener('click', () => void act(`server:${server.id}`)); document.getElementById('servers').append(button); }
}).catch(() => { document.getElementById('server').textContent = '请从上方“工作台”菜单选择服务器'; });
