import { createCompanyController } from './company.js';
import { createAutomationController } from './automation.js';
import { createGroupMembers } from './group-members.js';
import { createGroupActions } from './group-actions.js';
import { createChannelsController } from './channels.js';
const $ = (id) => document.getElementById(id);
const paths = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  messages: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z"/><path d="M8 11h8M8 15h5"/>',
  message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.4 6M20 4v7h-7"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/>',
  settings: '<path d="m9.2 3-.6 2a8 8 0 0 0-1.6 1L5 5.5 3 9l1.5 1.5a8 8 0 0 0 0 2L3 14l2 3.5 2-.5a8 8 0 0 0 1.6 1l.6 2h4l.6-2a8 8 0 0 0 1.6-1l2 .5 2-3.5-1.5-1.5a8 8 0 0 0 0-2L20 9l-2-3.5-2 .5a8 8 0 0 0-1.6-1l-.6-2Z"/><circle cx="11.2" cy="11.5" r="3"/>',
  'chevron-right': '<path d="m9 6 6 6-6 6"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  'arrow-right': '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  'arrow-up-right': '<path d="M7 17 17 7M7 7h10v10"/>',
  'arrow-up': '<path d="M12 19V5m-6 6 6-6 6 6"/>',
  square: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  sliders: '<path d="M4 7h9m4 0h3M4 17h3m4 0h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  document: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
  list: '<path d="m4 6 1 1 2-2m-3 7 1 1 2-2m-3 7 1 1 2-2M11 6h9M11 12h9M11 18h9"/>',
  shield: '<path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z"/><path d="m9 12 2 2 4-4"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
  edit: '<path d="m16 3 5 5M4 20l5-1L21 7a3.5 3.5 0 0 0-5-5L4 14Z"/>',
  cpu: '<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v4m6-4v4M9 19v4m6-4v4M1 9h4m-4 6h4m14-6h4m-4 6h4"/>',
  wrench: '<path d="M14.7 6.3a5 5 0 0 0-6.4 6.4L2.7 18.3a2.1 2.1 0 0 0 3 3l5.6-5.6a5 5 0 0 0 6.4-6.4l-3.4 3.4-3-3Z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
  alert: '<path d="m10.3 4.1-8.2 14A2 2 0 0 0 3.8 21h16.4a2 2 0 0 0 1.7-2.9l-8.2-14a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4m0 4h.01"/>',
  x: '<path d="m6 6 12 12M6 18 18 6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.9M16 3a4 4 0 0 1 0 8"/><circle cx="9" cy="7" r="4"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4m7 14 5-5-5-5m5 5H9"/>',
  search: '<circle cx="10.5" cy="10.5" r="7.5"/><path d="m16 16 5 5"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20M4 19.5V4a2 2 0 0 1 2-2h14v20H6.5A2.5 2.5 0 0 1 4 19.5Z"/><path d="M8 6h8M8 10h5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
};
function icon(name, className = '') {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) node.setAttribute(key, value);
  // Only fixed, locally authored SVG paths enter innerHTML. User/model data always uses textContent.
  node.innerHTML = paths[name] || paths.info;
  if (className) node.setAttribute('class', className);
  return node;
}
document.querySelectorAll('[data-icon]').forEach((node) => node.replaceWith(icon(node.dataset.icon, node.className)));
function node(tag, className, text) { const el = document.createElement(tag); if (className) el.className = className; if (text != null) el.textContent = text; return el; }

const state = { user: null, identityEpoch: 0, workspace: null, config: null, status: null, sessions: [], session: null, models: [], providers: [], running: false, stopPending: false, loading: false, online: false, syncing: false, syncController: null, historyFingerprint: '', sidebarFingerprint: '', drafts: new Map(), historyRequest: 0, modelsRequest: 0, streamController: null, toastTimer: null };
let company, automation, groupMembers, groupActions, channels;
const defaults = { provider: 'custom', model: '', baseUrl: '', cwd: '', mode: 'read-only', systemPrompt: '', apiKeySet: false };
const providerNames = { custom: 'OpenAI 兼容接口', openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google', deepseek: 'DeepSeek', openrouter: 'OpenRouter' };
const toolDescriptions = { read: '读取文件', grep: '搜索文件内容', find: '查找文件', ls: '列出目录', write: '写入文件', edit: '编辑文件', powershell: '执行 PowerShell 命令', bash: '执行 Shell 命令' };
const sessionKey = () => state.session?.id || 'draft';

async function api(path, { method = 'GET', body, signal } = {}) {
  const owner = state.user?.id, epoch = state.identityEpoch;
  const response = await fetch(path, { method, signal, headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json().catch(() => ({}));
  if (response.status === 404 && state.user?.id === owner && state.identityEpoch === epoch && (data.code === 'GROUP_ACCESS_DENIED' || data.error === '群聊不存在或你尚未加入。' || data.error === '会话不存在。')) {
    const groupId = /^\/api\/sessions\/([^/?]+)/.exec(path)?.[1];
    if (groupId) forgetGroup(decodeURIComponent(groupId));
  }
  if (!response.ok) { if (response.status === 401 && state.user?.id === owner && state.identityEpoch === epoch && !['/api/auth/login', '/api/auth/setup', '/api/auth/status'].includes(path)) company?.expire(); const error = new Error(data.error || `请求失败（HTTP ${response.status}），请稍后重试。`); error.status = response.status; throw error; }
  return data;
}
function toast(message) { clearTimeout(state.toastTimer); $('toast').textContent = message; $('toast').hidden = false; state.toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4200); }
function chatError(message) { $('chat-error-text').textContent = message; $('chat-error').hidden = !message; }
function setOnline(online, message = '') {
  state.online = online;
  $('connection-dot').className = `connection-dot ${online ? 'connected' : 'failed'}`;
  $('runtime-state').textContent = online ? '引擎已连接' : '连接不可用';
  $('connection-banner').hidden = online;
  $('connection-message').textContent = message || '无法连接本地服务，请确认 Pi Web 已启动。';
}
function updateControls() {
  groupActions?.sync();
  const remoteRunning = !!state.session?.running && !state.running;
  const active = state.running || remoteRunning;
  const mayStop = active && (state.running || state.session?.activeUserId === state.user?.id || company?.isAdmin());
  $('send-button').disabled = active || state.loading || !$('prompt').value.trim() || !state.online;
  $('send-button').title = remoteRunning ? '此群聊正在运行，完成后即可接续' : '发送到群聊';
  $('send-button').hidden = active && mayStop;
  $('stop-button').hidden = !mayStop;
  $('stop-button').disabled = state.stopPending;
  $('running-label').hidden = !active;
  const actor = state.session?.activeUserName || (state.running ? state.user?.displayName || state.user?.username : '其他成员');
  const runningText = state.stopPending ? '正在停止此共享任务…' : state.running ? `${actor} 已发起任务，Pi 正在处理…` : `${actor} 正在运行此群聊，结果会自动同步。`;
  if (active && $('running-text').textContent !== runningText) $('running-text').textContent = runningText;
  $('new-chat').disabled = state.running || state.loading;
  $('prompt').readOnly = state.loading;
  $('save-settings').disabled = state.running;
  $('toggle-execution').disabled = active || state.loading || !!state.modeChanging;
  automation?.updateControls();
}
function updateContext() {
  const config = state.config || defaults;
  const mode = company?.isAdmin() ? state.session?.mode || config.mode : state.status?.mode || 'read-only';
  const cwd = state.session?.cwd || config.cwd;
  const model = state.session?.model || config.model;
  const provider = state.session?.provider || config.provider;
  $('active-model').textContent = state.status?.configured ? (model || '选择模型') : company?.isAdmin() ? '配置模型' : '等待管理员配置';
  $('model-chip').title = state.status?.configured ? `${providerNames[provider] || provider} · ${model}` : '连接你的模型服务';
  document.querySelector('.model-orb').classList.toggle('configured', !!state.status?.configured);
  const shortCwd = (cwd || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  $('workspace-name').textContent = shortCwd || '本地工作空间';
  $('composer-workspace').title = cwd || '设置工作目录';
  const modeLabel = mode === 'workspace' ? '工作区编辑模式' : '只读模式';
  $('composer-mode').textContent = modeLabel;
  $('toggle-execution').hidden = !company?.isAdmin();
  $('toggle-execution').textContent = mode === 'workspace' ? '切换为只读' : '启用脚本执行';
  $('toggle-execution').title = state.session ? '切换当前对话工具模式；执行模式允许文件修改和系统命令' : '设置新群聊工具模式';
  $('setup-callout').hidden = !!state.status?.configured;
  $('setup-callout').querySelector('strong').textContent = company?.isAdmin() ? '先连接一个模型' : '等待管理员连接模型';
  $('setup-callout').querySelector('p').textContent = company?.isAdmin() ? '设置公司 API Key 和共享工作目录，即可开始对话。' : '公司空间尚未完成模型配置，请联系空间管理员。';
  $('setup-model').hidden = !company?.isAdmin();
  $('conversation-title').textContent = state.session?.title || '新建群聊';
  $('engine-version').textContent = state.status?.piVersion ? `v${state.status.piVersion}` : 'Pi + Web';
  groupMembers?.syncPanel();
  groupActions?.sync();
  channels?.sync();
}
function renderSessions() {
  const fingerprint = `${state.session?.id || ''}:${JSON.stringify(state.sessions)}`;
  if (state.sidebarFingerprint === fingerprint) return;
  state.sidebarFingerprint = fingerprint;
  const scrollTop = $('session-list').scrollTop;
  const focusedId = document.activeElement?.closest('.session-button')?.dataset.id;
  if (!state.sessions.length) { $('session-list').replaceChildren(node('p', 'sidebar-empty', '还没有群聊。\n创建一个主题，和团队一起开始。')); return; }
  $('session-list').replaceChildren(...state.sessions.map((session) => {
    const button = node('button', `session-button${session.id === state.session?.id ? ' active' : ''}`);
    button.type = 'button'; button.dataset.id = session.id; button.title = `${session.title || '群聊'}\n群成员可见 · ${session.createdByName || session.ownerName || '创建人未记录'} 创建${session.running ? `\n${session.activeUserName || '成员'} 正在运行` : ''}`;
    button.setAttribute('aria-current', session.id === state.session?.id ? 'page' : 'false');
    button.append(icon('message'), node('span', '', session.title || '新群聊'));
    if (session.running) button.append(node('i', 'session-running'));
    button.addEventListener('click', () => selectSession(session.id)); return button;
  }));
  $('session-list').scrollTop = scrollTop;
  if (focusedId) [...$('session-list').querySelectorAll('.session-button')].find((button) => button.dataset.id === focusedId)?.focus({ preventScroll: true });
}
async function fetchSharedSessions({ signal } = {}) {
  const owner = state.user?.id, epoch = state.identityEpoch; let sessions = [], offset = 0; const seen = new Set();
  while (true) {
    const result = await api(`/api/sessions?limit=100&offset=${offset}`, { signal });
    if (state.user?.id !== owner || state.identityEpoch !== epoch) return null;
    const page = result.sessions || []; sessions.push(...page.filter((session) => { if (seen.has(session.id)) return false; seen.add(session.id); return true; })); offset += page.length;
    if (!page.length || offset >= (result.total ?? offset)) return sessions;
  }
}
async function refreshSessions() { const owner = state.user?.id, epoch = state.identityEpoch, id=state.session?.id, selection=state.historyRequest; const sessions = await fetchSharedSessions(); if (!sessions || state.user?.id !== owner || state.identityEpoch !== epoch) return; state.sessions = sessions; renderSessions(); if(id && state.session?.id===id && state.historyRequest===selection && !sessions.some(group=>group.id===id))forgetGroup(id); }
function forgetGroup(id, { left = false } = {}) {
  const voluntarilyLeft = left || groupMembers?.isLeaving(id);
  state.sessions = state.sessions.filter(group => group.id !== id); state.drafts.delete(id);
  if (state.session?.id !== id) { renderSessions(); return; }
  state.historyRequest++; state.streamController?.abort(); state.streamController=null; state.running=false; state.stopPending=false; state.loading=false;
  state.session=null;state.historyFingerprint='';state.sidebarFingerprint='';
  automation?.contextChanged();
  groupMembers?.resetPanel();groupActions?.reset();if($('group-members-dialog').open)$('group-members-dialog').close();
  $('prompt').value='';$('messages').replaceChildren();$('welcome').hidden=false;setHash(null);
  $('stop-button').disabled=false;$('stop-button').replaceChildren(icon('square'),document.createTextNode('停止'));
  renderSessions();updateContext();updateControls();resizePrompt();chatError(voluntarilyLeft ? '' : '你已不在此群聊中，相关内容已关闭。');toast(voluntarilyLeft ? '你已退出群聊。' : '你已被移出群聊。');
}
function preserveDraft() { state.drafts.set(sessionKey(), $('prompt').value); }
function restoreDraft() { $('prompt').value = state.drafts.get(sessionKey()) || ''; resizePrompt(); updateControls(); }
function setHash(id) { const url = new URL(location.href); url.hash = id ? `session=${encodeURIComponent(id)}` : ''; history.replaceState(null, '', url); }
function closeSidebar() { $('sidebar').classList.remove('open'); $('sidebar').inert = matchMedia('(max-width:760px)').matches; $('sidebar-scrim').hidden = true; $('mobile-menu').setAttribute('aria-expanded', 'false'); }
function newChat() {
  if (!state.user) return;
  if (state.running) { toast('请先停止当前任务，再新建对话。'); return; }
  company?.goChat();
  state.historyRequest++; state.loading = false; state.historyFingerprint = ''; preserveDraft(); state.session = null; $('messages').replaceChildren(); $('welcome').hidden = false;
  automation?.contextChanged();
  chatError(''); setHash(null); updateContext(); renderSessions(); restoreDraft(); closeSidebar(); $('prompt').focus();
}
function startNewChat() {
  if (company?.isAdmin()) { channels?.openCreate(); return; }
  newChat();
}
async function selectSession(id) {
  if (state.running) { toast('请等待当前任务完成，或先点击停止。'); return; }
  company?.goChat();
  const request = ++state.historyRequest; preserveDraft(); state.loading = true; updateControls(); closeSidebar(); chatError('');
  try {
    const data = await api(`/api/sessions/${encodeURIComponent(id)}`);
    if (request !== state.historyRequest) return;
    state.session = data.session; setHash(id); renderMessages(data.messages || []); updateContext(); renderSessions(); restoreDraft();
    automation?.contextChanged();
    if (data.session.running) toast(`${data.session.activeUserName || '团队成员'} 正在运行此群聊，结果会自动同步。`);
  } catch (error) { if (request === state.historyRequest) chatError(error.message); }
  finally { if (request === state.historyRequest) { state.loading = false; updateControls(); } }
}

function inline(parent, text) {
  const matcher = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
  let position = 0;
  for (const match of text.matchAll(matcher)) {
    parent.append(document.createTextNode(text.slice(position, match.index)));
    const isCode = match[0].startsWith('`');
    parent.append(node(isCode ? 'code' : 'strong', '', match[0].slice(isCode ? 1 : 2, isCode ? -1 : -2)));
    position = match.index + match[0].length;
  }
  parent.append(document.createTextNode(text.slice(position)));
}
function renderMarkdown(target, text) {
  // Small DOM-only renderer. Raw HTML and model-supplied URLs never become active markup.
  const fragment = document.createDocumentFragment();
  const sections = String(text).split(/(^```[^\n]*\n[\s\S]*?(?:\n```\s*(?:\n|$)|$))/m);
  for (const section of sections) {
    if (!section) continue;
    if (section.startsWith('```')) { const code = section.replace(/^```[^\n]*\n/, '').replace(/\n```\s*$/, ''); const pre = node('pre'); pre.append(node('code', '', code)); fragment.append(pre); continue; }
    let paragraph = []; let list = null;
    const flush = () => { if (paragraph.length) { const p = node('p'); inline(p, paragraph.join('\n')); fragment.append(p); paragraph = []; } };
    for (const line of section.split('\n')) {
      const heading = line.match(/^(#{1,4})\s+(.+)$/);
      const bullet = line.match(/^\s*(?:([-*])\s+|(\d+)[.)]\s+)(.+)$/);
      if (heading) { flush(); list = null; const h = node(`h${Math.min(heading[1].length + 1, 4)}`); inline(h, heading[2]); fragment.append(h); }
      else if (bullet) { flush(); const type = bullet[2] ? 'ol' : 'ul'; if (!list || list.tagName.toLowerCase() !== type) { list = node(type); fragment.append(list); } const item = node('li'); inline(item, bullet[3]); list.append(item); }
      else if (/^\s*---+\s*$/.test(line)) { flush(); list = null; fragment.append(node('hr')); }
      else if (!line.trim()) { flush(); list = null; }
      else { list = null; paragraph.push(line); }
    }
    flush();
  }
  target.replaceChildren(fragment);
}
function addMessage(role, content = '', timestamp, container = $('messages'), userLabel = '历史发言人未记录') {
  const message = node('article', `message ${role === 'user' ? 'user' : 'assistant'}`);
  const avatar = node('div', 'message-avatar', role === 'user' ? userLabel.slice(0, 1) : 'π'); avatar.setAttribute('aria-hidden', 'true');
  const body = node('div', 'message-content'); const author = node('div', 'message-author', role === 'user' ? userLabel : 'Pi');
  if (timestamp) { const date = new Date(timestamp); if (!Number.isNaN(date.getTime())) author.append(node('span', '', date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }))); }
  const text = node('div', 'message-text'); if (role === 'user') text.textContent = content; else renderMarkdown(text, content);
  const status = node('div', 'message-status'); body.append(author, text, status); message.append(avatar, body); container.append(message);
  return { root: message, body, text, status, author, avatar, content, tools: new Map() };
}
function renderMessages(messages, container = $('messages'), userLabel = '历史发言人未记录', { preserveScroll = false } = {}) {
  const isMain = container === $('messages'); const scrollBox = isMain ? $('message-scroll') : container;
  const oldScrollTop = scrollBox.scrollTop;
  const nearBottom = scrollBox.scrollHeight - scrollBox.scrollTop - scrollBox.clientHeight < 140;
  const lastUserIndex = messages.findLastIndex(message => message.role === 'user');
  const running = isMain && state.session?.running;
  const visible = messages.map((message, index) => ({ ...message, messageIndex: index })).filter((message, index) => message.role === 'user' || (
    message.role === 'assistant' && message.content?.trim() && !message.tools?.length && !(!message.taskRunId && running && index > lastUserIndex)
  ));
  container.replaceChildren(); if (isMain) { $('welcome').hidden = visible.length > 0; state.historyFingerprint = JSON.stringify(messages); }
  for (const message of visible) {
    const authorName = message.authorName || (message.authorUnknown || message.role === 'user' ? '历史发言人未记录' : userLabel);
    const view = addMessage(message.role, message.content || '', message.timestamp, container, authorName);
    view.root.dataset.messageIndex = message.messageIndex;
  }
  if (running) {
    const pending = addMessage('assistant', '', null, container, userLabel);
    pending.status.textContent = '处理中…'; pending.status.setAttribute('role', 'status');
  }
  if (preserveScroll) scrollBox.scrollTop = nearBottom ? scrollBox.scrollHeight : oldScrollTop;
  else if (isMain) scrollBottom(true);
}
function scrollBottom(force = false) { const box = $('message-scroll'); if (force || box.scrollHeight - box.scrollTop - box.clientHeight < 180) box.scrollTop = box.scrollHeight; }
function resizePrompt() { const input = $('prompt'); input.style.height = 'auto'; input.style.height = `${Math.min(Math.max(input.scrollHeight, 75), 220)}px`; }

async function consumeStream(response, onEvent) {
  if (!response.body) throw new Error('浏览器不支持流式响应，请使用新版浏览器。');
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
  const dispatch = (block) => { const text = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n'); if (!text) return; let data; try { data = JSON.parse(text); } catch { throw new Error('服务返回了无法解析的事件，请刷新群聊查看已保存的内容。'); } onEvent(data); };
  while (true) {
    const { value, done } = await reader.read(); buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n');
    let boundary; while ((boundary = buffer.indexOf('\n\n')) >= 0) { dispatch(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 2); }
    if (done) { if (buffer.trim()) dispatch(buffer); break; }
  }
}
async function sendMessage(event) {
  event.preventDefault(); const submittedDraft = $('prompt').value, prompt = submittedDraft.trim();
  if (!prompt || state.running || state.loading) return;
  if (state.session?.running) { toast(`${state.session.activeUserName || '团队成员'} 正在运行此群聊，请稍后接续。草稿已保留。`); return; }
  if (!state.status?.configured) { toast(company?.isAdmin() ? '连接模型后即可发送，已保留你的消息。' : '请联系管理员配置公司模型，已保留你的消息。'); if (company?.isAdmin()) await openSettings(); return; }
  const submittingUser = state.user?.id, submittingEpoch = state.identityEpoch;
  const submittedSkillId = automation?.selectedSkillId();
  let submittedSessionId = null;
  const sameIdentity = () => state.user?.id === submittingUser && state.identityEpoch === submittingEpoch && (!submittedSessionId || state.session?.id === submittedSessionId);
  const restoreSubmittedDraft = () => { if (!$('prompt').value.trim() || $('prompt').value === submittedDraft) $('prompt').value = submittedDraft; preserveDraft(); resizePrompt(); };
  const oldDraftKey = sessionKey(); state.drafts.set(oldDraftKey, $('prompt').value); state.running = true; chatError(''); updateControls();
  let assistant = null; let userMessage = null; let accepted = false; let finished = false; let aborted = false; let eventError = '';
  try {
    if (!state.session) { const result = await api('/api/sessions', { method: 'POST', body: {} }); if (!sameIdentity()) return; state.session = result.session; setHash(state.session.id); state.sessions.unshift(state.session); preserveDraft(); updateContext(); renderSessions(); }
    state.streamController = new AbortController();
    submittedSessionId = state.session.id;
    const response = await fetch(`/api/sessions/${encodeURIComponent(state.session.id)}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify({ message: prompt, ...(submittedSkillId ? { skillId: submittedSkillId } : {}) }), signal: state.streamController.signal });
    if (!sameIdentity()) return;
    if (!response.ok) { const error = await response.json().catch(() => ({})); if (response.status === 401 && sameIdentity()) company.expire(); if(response.status===404 && (error.code==='GROUP_ACCESS_DENIED' || error.error==='群聊不存在或你尚未加入。'))forgetGroup(submittedSessionId); throw new Error(error.error || `请求失败（HTTP ${response.status}）。`); }
    if (!(response.headers.get('content-type') || '').includes('text/event-stream')) throw new Error('服务响应格式异常，请刷新页面重试。');
    accepted = true; $('welcome').hidden = true; userMessage = addMessage('user', prompt, Date.now(), $('messages'), state.user.displayName || state.user.username); assistant = addMessage('assistant'); assistant.status.textContent = '处理中…'; assistant.status.setAttribute('role', 'status');
    if ($('prompt').value === submittedDraft) $('prompt').value = ''; state.drafts.delete(oldDraftKey); if ($('prompt').value) preserveDraft(); else state.drafts.delete(sessionKey()); resizePrompt(); updateControls(); scrollBottom(true);
    await consumeStream(response, (data) => {
      if (!sameIdentity()) return;
      if (data.type === 'access_revoked') { forgetGroup(submittedSessionId); return; }
      if (data.type === 'start') { state.session = { ...state.session, running: true, activeUserId: data.authorId || state.user.id, activeUserName: data.authorName || state.user.displayName || state.user.username }; if (data.authorName) { userMessage.author.textContent = data.authorName; userMessage.avatar.textContent = data.authorName.slice(0, 1); } updateControls(); assistant.status.textContent = '处理中…'; }
      else if (data.type === 'user' && data.authorName) { userMessage.author.textContent = data.authorName; userMessage.avatar.textContent = data.authorName.slice(0, 1); }
      else if (data.type === 'text_delta') { assistant.content += data.delta || ''; }
      else if (data.type === 'tool_start') { assistant.content = ''; assistant.status.textContent = '处理中…'; }
      else if (data.type === 'tool_update' || data.type === 'tool_end') { assistant.status.textContent = '处理中…'; }
      else if (data.type === 'error') { eventError = data.message || '模型请求失败。'; chatError(eventError); assistant.status.textContent = '本次请求失败'; }
      else if (data.type === 'done') { renderMarkdown(assistant.text, assistant.content); scrollBottom(); finished = true; aborted = !!data.aborted; if (data.session) { state.session = data.session; updateContext(); } assistant.status.textContent = aborted ? '已停止生成' : eventError ? '本次请求失败' : ''; }
    });
    if (!finished) throw new Error('连接已中断。可重新打开此对话查看已保存的内容。');
    if (eventError && !assistant.content && !aborted) restoreSubmittedDraft();
  } catch (error) {
    if (!sameIdentity()) return;
    const message = error.name === 'AbortError' ? '连接已中止，可重新打开此对话查看记录。' : error.message;
    chatError(message);
    if (!accepted || (assistant && !assistant.content)) restoreSubmittedDraft();
    if (assistant) assistant.status.textContent = accepted ? '连接中断' : '请求失败';
  } finally {
    if (sameIdentity()) {
    state.running = false; state.stopPending = false; state.streamController = null; $('stop-button').disabled = false; $('stop-button').replaceChildren(icon('square'), document.createTextNode('停止')); updateControls();
    const completedId = state.session?.id, completedSelection = state.historyRequest;
    await refreshSessions().catch(() => {});
    if (sameIdentity() && !state.running && state.historyRequest === completedSelection && assistant && finished && !eventError && !aborted && completedId && state.session?.id === completedId) {
      // Reload Pi's persisted transcript so multiple model/tool turns keep their exact order.
      try { const data = await api(`/api/sessions/${encodeURIComponent(completedId)}`); if (sameIdentity() && state.historyRequest === completedSelection && state.session?.id === completedId && !state.running) { state.session = data.session; renderMessages(data.messages || [], $('messages'), '历史发言人未记录', { preserveScroll: true }); updateContext(); updateControls(); } } catch {}
    }
    if (sameIdentity()) synchronizeShared();
    }
  }
}
async function stopMessage() {
  if ((!state.running && !state.session?.running) || !state.session || state.stopPending) return;
  if (!state.running && state.session.activeUserId !== state.user?.id && !company.isAdmin()) return;
  const owner = state.user?.id, epoch = state.identityEpoch, sessionId = state.session.id;
  state.stopPending = true; $('stop-button').replaceChildren(node('span', 'loading-ring'), document.createTextNode('停止中')); updateControls();
  try { await api(`/api/sessions/${encodeURIComponent(sessionId)}/abort`, { method: 'POST', body: {} }); if (!state.running) await synchronizeShared(); }
  catch (error) { if (state.user?.id === owner && state.identityEpoch === epoch) chatError(error.message); }
  finally { if (state.user?.id === owner && state.identityEpoch === epoch) { state.stopPending = false; $('stop-button').replaceChildren(icon('square'), document.createTextNode('停止')); updateControls(); } }
}

async function synchronizeShared() {
  if (!state.user || document.hidden || state.running || state.loading || state.syncing) return;
  const owner = state.user.id, epoch = state.identityEpoch, selection = state.historyRequest, sessionId = state.session?.id;
  const sameIdentity = () => state.user?.id === owner && state.identityEpoch === epoch;
  const sameSelection = () => sameIdentity() && state.historyRequest === selection && state.session?.id === sessionId && !state.running && !state.loading;
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 12000);
  state.syncing = true; state.syncController = controller;
  try {
    const [statusResult, listResult] = await Promise.allSettled([api('/api/status', { signal: controller.signal }), fetchSharedSessions({ signal: controller.signal })]);
    if (!sameIdentity() || state.running) return;
    if (statusResult.status === 'fulfilled') { state.status = statusResult.value; state.config = { ...state.config, ...statusResult.value }; setOnline(true); }
    if (listResult.status === 'fulfilled') {
      state.sessions = listResult.value || []; renderSessions();
      if (sameSelection() && sessionId && !state.sessions.some(group => group.id === sessionId)) { forgetGroup(sessionId); return; }
    }
    if (statusResult.status === 'rejected' && listResult.status === 'rejected') { setOnline(false, '共享空间暂时无法同步，正在自动重连。'); return; }
    if (!sameSelection() || !sessionId || company.view !== 'chat') { if (sameIdentity()) { updateContext(); updateControls(); } return; }
    const summary = state.sessions.find((session) => session.id === sessionId);
    if (summary) {
      state.session = { ...state.session, running: summary.running, activeUserId: summary.activeUserId, activeUserName: summary.activeUserName };
      updateControls();
      if (summary.revision != null && summary.revision === state.session.revision && state.historyFingerprint) { updateContext(); return; }
    }
    const data = await api(`/api/sessions/${encodeURIComponent(sessionId)}`, { signal: controller.signal });
    if (!sameSelection()) return;
    state.session = data.session;
    if (JSON.stringify(data.messages || []) !== state.historyFingerprint) renderMessages(data.messages || [], $('messages'), '历史发言人未记录', { preserveScroll: true });
    updateContext(); updateControls();
  } catch (error) { if (sameIdentity() && ![401,404].includes(error.status)) setOnline(false, '共享空间暂时无法同步，正在自动重连。'); }
  finally { clearTimeout(timeout); if (state.syncController === controller) { state.syncing = false; state.syncController = null; } }
}

function ensureProvider(value) { if (![...$('provider').options].some((option) => option.value === value)) { const option = node('option', '', providerNames[value] || value); option.value = value; $('provider').append(option); } }
async function loadModels(provider) {
  const request = ++state.modelsRequest;
  try {
    const result = await api(`/api/models?provider=${encodeURIComponent(provider)}`);
    if (request !== state.modelsRequest) return;
    state.models = result.models || []; state.providers = result.providers || [];
    for (const value of state.providers) ensureProvider(value.id);
    $('model-options').replaceChildren(...state.models.slice(0, 600).map((model) => { const option = document.createElement('option'); option.value = model.id; option.label = model.name || model.id; return option; }));
  } catch { if (request === state.modelsRequest) $('model-options').replaceChildren(); }
}
async function openSettings() {
  if (!company?.isAdmin()) { toast('公司配置由管理员统一管理。'); return; }
  closeSidebar();
  if (state.running) { toast('请先停止任务，再修改模型与工作空间设置。'); return; }
  const accountId = state.user.id, epoch = state.identityEpoch;
  const settingsRequest = state.settingsRequest = (state.settingsRequest || 0) + 1;
  $('open-settings').disabled = true;
  let config;
  try { config = await api('/api/config'); }
  catch (error) { if (state.user?.id === accountId && state.identityEpoch === epoch) toast(`无法读取最新公司配置：${error.message}`); return; }
  finally { $('open-settings').disabled = false; }
  if (state.user?.id !== accountId || state.identityEpoch !== epoch || settingsRequest !== state.settingsRequest || state.running) return;
  state.config = config;
  ensureProvider(config.provider); ensureProvider('custom'); $('provider').value = config.provider;
  $('model').value = config.model; $('base-url').value = config.baseUrl || ''; $('cwd').value = config.cwd || ''; $('system-prompt').value = config.systemPrompt || '';
  $('api-key').value = ''; $('api-key').type = 'password'; $('toggle-key').setAttribute('aria-pressed', 'false'); $('toggle-key').setAttribute('aria-label', '显示 API Key');
  $('api-key').placeholder = config.apiKeySet ? '已配置；留空保留现有密钥' : '输入模型服务的 API Key';
  $('api-key-status').textContent = config.apiKeySet ? '已配置' : '尚未配置';
  $('api-key-hint').textContent = config.apiKeySet ? '密钥已保存在本地服务端。留空会保留，输入新密钥可替换。' : '密钥保存在本地服务端，不会回传至浏览器。';
  for (const input of document.querySelectorAll('input[name="mode"]')) input.checked = input.value === config.mode;
  $('settings-error').hidden = true; $('save-settings').disabled = false;
  if (!$('settings-dialog').open) $('settings-dialog').showModal();
  loadModels(config.provider);
}
function closeSettings() { $('settings-dialog').close(); $('api-key').value = ''; }
async function saveSettings(event) {
  event.preventDefault(); if (!$('settings-form').reportValidity()) return;
  if (!state.config?.apiKeySet && !$('api-key').value.trim()) { $('settings-error').textContent = '请输入模型服务的 API Key，然后保存配置。'; $('settings-error').hidden = false; $('api-key').focus(); return; }
  const body = { provider: $('provider').value, model: $('model').value.trim(), baseUrl: $('base-url').value.trim(), cwd: $('cwd').value.trim(), mode: document.querySelector('input[name="mode"]:checked')?.value || 'read-only', systemPrompt: $('system-prompt').value };
  if ($('api-key').value.trim()) body.apiKey = $('api-key').value.trim();
  $('save-settings').disabled = true; $('save-settings').replaceChildren(node('span', 'loading-ring'), document.createTextNode('保存中…')); $('settings-error').hidden = true;
  try {
    state.config = await api('/api/config', { method: 'PUT', body }); state.status = await api('/api/status'); setOnline(true); updateContext(); closeSettings(); toast(state.session ? '默认配置已保存。当前对话可在输入框下切换工具模式。' : '配置已保存，可以开始与 Pi 对话。'); $('prompt').focus();
  } catch (error) { $('settings-error').textContent = error.message; $('settings-error').hidden = false; $('settings-error').focus(); }
  finally { $('save-settings').disabled = false; $('save-settings').replaceChildren(document.createTextNode('保存配置'), icon('check')); updateControls(); }
}
async function toggleExecution() {
  if (!company.isAdmin() || state.modeChanging || state.running || state.session?.running) return;
  const owner = state.user.id, epoch = state.identityEpoch, sessionId = state.session?.id;
  const mode = (state.session?.mode || state.config?.mode) === 'workspace' ? 'read-only' : 'workspace';
  const sameIdentity = () => state.user?.id === owner && state.identityEpoch === epoch;
  state.modeChanging = true; updateControls();
  try {
    if (sessionId) {
      const result = await api(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'PATCH', body: { mode } });
      if (!sameIdentity()) return;
      if (state.session?.id === sessionId) state.session = result.session;
      await refreshSessions();
    } else {
      const result = await api('/api/config', { method: 'PUT', body: { mode } });
      if (!sameIdentity()) return; state.config = result; state.status = await api('/api/status');
    }
    if (sameIdentity()) { updateContext(); toast(mode === 'workspace' ? '已启用脚本执行、文件修改和系统命令。选择技能后重新发送任务即可。' : '已切换为只读模式。'); }
  } catch (error) { if (sameIdentity()) toast(error.message); }
  finally { if (sameIdentity()) { state.modeChanging = false; updateControls(); } }
}
async function loadWorkspace() {
    const owner = state.user?.id, epoch = state.identityEpoch;
    const status = await api('/api/status');
    if (status.groupVisibility !== 'members') throw new Error('服务待更新：请先重启 Pi Web，使“仅群成员可见”的权限生效，再重新连接。');
    const sessions = await fetchSharedSessions();
    if (!sessions || state.user?.id !== owner || state.identityEpoch !== epoch) return false;
    const config = company.isAdmin() ? await api('/api/config') : { ...defaults, ...status };
    if (state.user?.id !== owner || state.identityEpoch !== epoch) return false;
    state.status = status; state.config = config; state.sessions = sessions; setOnline(true); updateContext(); renderSessions(); updateControls();
    automation?.identityChanged();
    const hashId = new URLSearchParams(location.hash.slice(1)).get('session'); if (hashId && state.sessions.some((session) => session.id === hashId)) await selectSession(hashId);
    return state.user?.id === owner && state.identityEpoch === epoch;
}
function clearWorkspace() {
  state.modeChanging = false;
  channels?.reset();
  automation?.reset();
  groupMembers?.resetPanel();
  groupActions?.reset();
  state.identityEpoch++; state.historyRequest++; state.modelsRequest++; state.settingsRequest = (state.settingsRequest || 0) + 1; state.streamController?.abort(); state.streamController = null; state.syncController?.abort(); state.syncController = null; state.syncing = false; state.running = false; state.stopPending = false; state.loading = false; state.session = null; state.config = null; state.status = null; state.sessions = []; state.sidebarFingerprint = ''; state.historyFingerprint = ''; state.drafts.clear();
  $('prompt').value = ''; $('messages').replaceChildren(); $('session-list').replaceChildren(); $('welcome').hidden = false; setHash(null); chatError(''); updateControls();
}
company = createCompanyController({ $, api, state, icon, node, toast, closeSidebar, renderTranscript: renderMessages, loadWorkspace, clearWorkspace });
async function ensureGroupSession() {
  if (state.session) return state.session;
  if (state.loading || state.running) { toast('请等待当前操作完成。'); return null; }
  const owner=state.user?.id,epoch=state.identityEpoch,selection=state.historyRequest;
  state.loading=true; updateControls();
  try {
    const result=await api('/api/sessions',{method:'POST',body:{}});
    if(state.user?.id!==owner || state.identityEpoch!==epoch || state.historyRequest!==selection)return null;
    state.session=result.session;setHash(result.session.id);state.sessions.unshift(result.session);preserveDraft();renderSessions();updateContext();return result.session;
  } finally { if(state.user?.id===owner && state.identityEpoch===epoch){state.loading=false;updateControls();} }
}
groupMembers = createGroupMembers({ $, api, state, node, toast, ensureSession: ensureGroupSession, onLeft: id => forgetGroup(id, { left: true }) });
groupActions = createGroupActions({ $, api, state, node, toast, ensureSession: ensureGroupSession,
  applySession: session => { if (state.session?.id !== session.id) return; state.session = { ...state.session, ...session }; state.sessions = state.sessions.map(item => item.id === session.id ? { ...item, ...session } : item); renderSessions(); updateContext(); },
  locateMessage: async (index, id) => {
    if (!Number.isSafeInteger(index) || index < 0 || state.session?.id !== id || state.loading) return;
    const owner=state.user?.id,epoch=state.identityEpoch,selection=state.historyRequest;
    let target=$('messages').querySelector(`[data-message-index="${index}"]`);
    if (!target && !state.running) {
      try {
        const data=await api(`/api/sessions/${encodeURIComponent(id)}`);
        if(state.session?.id!==id || state.user?.id!==owner || state.identityEpoch!==epoch || state.historyRequest!==selection || state.loading || state.running)return;
        state.session=data.session;renderMessages(data.messages||[]);updateContext();
        target=$('messages').querySelector(`[data-message-index="${index}"]`);
      } catch(error) { if(state.session?.id===id && state.identityEpoch===epoch)toast(error.message);return; }
    }
    if(!target){toast('此条消息暂未显示，请等待当前任务完成后再定位。');return;}
    if(matchMedia('(max-width:1100px)').matches){$('context-panel').classList.remove('open');$('toggle-context').setAttribute('aria-expanded','false');}
    $('messages').querySelectorAll('.message-search-match').forEach(message=>message.classList.remove('message-search-match'));
    target.classList.add('message-search-match');target.tabIndex=-1;target.focus({preventScroll:true});
    target.scrollIntoView({block:'center',behavior:matchMedia('(prefers-reduced-motion:reduce)').matches?'auto':'smooth'});
    setTimeout(()=>target.classList.remove('message-search-match'),6000);
  },
});
automation = createAutomationController({ $, api, state, icon, node, toast, company, selectSession, renderMarkdown, preserveDraft, updateControls });
channels = createChannelsController({ $, api, state, icon, node, toast, company, closeSidebar,
  onCreated: async session => { newChat(); state.sessions = [session, ...state.sessions.filter(item => item.id !== session.id)]; renderSessions(); await selectSession(session.id); },
  onBindingsChanged: () => groupMembers?.syncPanel(true),
});

$('new-chat').addEventListener('click', startNewChat);
$('toggle-execution').addEventListener('click', toggleExecution);
$('nav-chat').addEventListener('click', () => { company.goChat(); closeSidebar(); $('prompt').focus(); });
document.querySelector('.brand').addEventListener('click', (event) => { event.preventDefault(); startNewChat(); });
for (const id of ['open-settings', 'model-chip', 'setup-model', 'composer-workspace']) $(id).addEventListener('click', openSettings);
$('close-settings').addEventListener('click', closeSettings); $('cancel-settings').addEventListener('click', closeSettings);
$('settings-dialog').addEventListener('close', () => { $('api-key').value = ''; });
$('settings-dialog').addEventListener('click', (event) => { if (event.target === $('settings-dialog')) { const rect = $('settings-dialog').getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeSettings(); } });
$('settings-form').addEventListener('submit', saveSettings);
$('provider').addEventListener('change', () => { loadModels($('provider').value); });
$('toggle-key').addEventListener('click', () => { const show = $('api-key').type === 'password'; $('api-key').type = show ? 'text' : 'password'; $('toggle-key').setAttribute('aria-pressed', String(show)); $('toggle-key').setAttribute('aria-label', show ? '隐藏 API Key' : '显示 API Key'); });
$('chat-form').addEventListener('submit', sendMessage); $('stop-button').addEventListener('click', stopMessage);
$('prompt').addEventListener('input', () => { preserveDraft(); resizePrompt(); updateControls(); });
$('prompt').addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!$('send-button').disabled) $('chat-form').requestSubmit(); } });
$('dismiss-error').addEventListener('click', () => chatError(''));
$('refresh-sessions').addEventListener('click', async () => { const button = $('refresh-sessions'); button.disabled = true; try { await refreshSessions(); toast('对话列表已更新。'); } catch (error) { chatError(error.message); } finally { button.disabled = false; } });
$('retry-connection').addEventListener('click', () => company.initialize());
document.querySelectorAll('.suggestion').forEach((button) => button.addEventListener('click', () => { $('prompt').value = button.dataset.prompt; preserveDraft(); resizePrompt(); updateControls(); $('prompt').focus(); }));
$('mobile-menu').addEventListener('click', () => { const open = $('sidebar').classList.toggle('open'); $('sidebar').inert = !open && matchMedia('(max-width:760px)').matches; $('sidebar-scrim').hidden = !open; $('mobile-menu').setAttribute('aria-expanded', String(open)); if (open) $('new-chat').focus(); });
$('sidebar-scrim').addEventListener('click', closeSidebar);
$('toggle-context').addEventListener('click', () => { groupMembers?.syncPanel(true); const open = $('context-panel').classList.toggle('open'); $('toggle-context').setAttribute('aria-expanded', String(open)); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { closeSidebar(); $('context-panel').classList.remove('open'); $('toggle-context').setAttribute('aria-expanded', 'false'); $('account-menu').open = false; } if (event.key.toLowerCase() === 'n' && !event.ctrlKey && !event.metaKey && !event.altKey && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) && !document.querySelector('dialog[open]') && state.user) { event.preventDefault(); startNewChat(); } });
window.addEventListener('hashchange', () => { if (state.running) { setHash(state.session?.id); return; } const id = new URLSearchParams(location.hash.slice(1)).get('session'); if (id && id !== state.session?.id) selectSession(id); else if (!id) newChat(); });
window.addEventListener('resize', () => { $('sidebar').inert = matchMedia('(max-width:760px)').matches && !$('sidebar').classList.contains('open'); });
closeSidebar();
company.initialize();
setInterval(() => { synchronizeShared(); automation?.tick(); }, 2500);
document.addEventListener('visibilitychange', () => { if (!document.hidden) synchronizeShared(); });
