// Company accounts and administrator views. Credentials only live in password inputs
// until submission; authentication itself is carried by the server's HttpOnly cookie.
export function createCompanyController({ $, api, state, icon, node, toast, closeSidebar, renderTranscript, loadWorkspace, clearWorkspace }) {
  let setupRequired = false;
  let setupAllowed = true;
  let view = 'chat';
  let users = [];
  let editUser = null;
  let requestId = 0;
  let authRequest = 0;
  let auditRequest = 0;
  let detailRequest = 0;
  let auditSessions = [];
  let auditParams = new URLSearchParams();
  let selectedAuditId = null;
  const isAdmin = () => state.user?.role === 'admin';
  const setError = (id, message = '') => { $(id).textContent = message; $(id).hidden = !message; if (message) $(id).focus(); };
  function busy(button, value, label) { button.disabled = value; button.textContent = label; }
  function clearPasswords(scope = document) { scope.querySelectorAll('input[type="password"]').forEach((input) => { input.value = ''; }); }
  function displayDate(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '时间未记录' : date.toLocaleString('zh-CN', { hour12: false }); }
  function resetAudit() { auditRequest++; detailRequest++; auditSessions = []; auditParams = new URLSearchParams(); selectedAuditId = null; editUser = null; $('audit-filter-form').reset(); const all = node('option', '', '所有创建人'); all.value = ''; $('audit-user').replaceChildren(all); $('user-form').reset(); $('user-dialog-description').textContent = '为员工创建公司空间登录账户。'; $('audit-session-list').replaceChildren(); $('audit-messages').replaceChildren(node('p', 'admin-empty', '从会话列表选择共享记录，查看完整聊天和工具结果。')); $('audit-transcript-heading').replaceChildren(node('strong', '', '选择一个共享会话'), node('span', '', '只读审计')); }
  function renderIdentity() {
    const user = state.user;
    $('account-name').textContent = user.displayName || user.username;
    $('account-avatar').textContent = (user.displayName || user.username).slice(0, 1).toUpperCase();
    $('account-identity').textContent = `${user.displayName || user.username} · ${user.username}`;
    $('account-role').textContent = isAdmin() ? '空间管理员' : '空间成员';
    const name = state.workspace?.name || '公司共享空间';
    $('company-name').textContent = name; $('sidebar-company-name').textContent = name;
    document.querySelectorAll('.admin-only').forEach((el) => { el.hidden = !isAdmin(); });
    for (const id of ['model-chip', 'composer-workspace']) { $(id).disabled = !isAdmin(); $(id).classList.toggle('shared-config', !isAdmin()); }
    $('app-shell').classList.toggle('employee-view', !isAdmin());
    if (!isAdmin()) {
      $('context-panel').classList.remove('open');
      $('toggle-context').setAttribute('aria-expanded', 'false');
    }
  }
  function showAuth(message = '') {
    $('app-shell').hidden = true; $('auth-screen').hidden = false; $('auth-form').hidden = false; $('auth-retry').hidden = true;
    $('auth-kicker').textContent = setupRequired ? '首次启用 · 仅本机创建' : (state.workspace?.name || '公司共享空间');
    $('auth-title').textContent = setupRequired ? '创建空间管理员' : '登录你的公司空间';
    $('auth-description').textContent = setupRequired ? '由你创建首个管理员账户，再邀请员工加入共享工作空间。' : '使用你的账户进入团队空间。群聊消息与上下文仅群成员可见，发言记录实际操作人。';
    $('auth-name-field').hidden = !setupRequired; $('auth-display-name').required = setupRequired;
    $('auth-confirm-field').hidden = !setupRequired; $('auth-confirm-password').required = setupRequired;
    $('auth-password').minLength = setupRequired ? 8 : 1;
    $('auth-password').autocomplete = setupRequired ? 'new-password' : 'current-password';
    $('auth-password-hint').textContent = setupRequired ? '8–128 个字符。此账户将拥有员工管理和聊天审计权限。' : '没有账户或忘记密码？请联系公司空间管理员。';
    $('auth-submit').textContent = setupRequired ? '创建管理员并进入' : '登录工作空间';
    clearPasswords($('auth-form')); setError('auth-error', message); if (!message) $('auth-username').focus();
    if (setupRequired && !setupAllowed) { $('auth-form').hidden = true; $('auth-description').textContent = '首次管理员必须在服务所在电脑通过 localhost 创建。请联系公司空间负责人完成初始化。'; $('auth-retry').hidden = false; }
  }
  async function enterWorkspace(auth) {
    state.user = auth.user; state.workspace = auth.workspace; renderIdentity();
    if (await loadWorkspace() === false) return;
    $('auth-screen').hidden = true; $('app-shell').hidden = false; $('auth-form').reset(); clearPasswords();
    goChat();
  }
  async function initialize() {
    const current = ++authRequest;
    $('auth-screen').hidden = false; $('app-shell').hidden = true; $('auth-form').hidden = true;
    $('auth-title').textContent = '正在连接公司空间…'; $('auth-description').textContent = '请稍候，正在确认登录状态。'; $('auth-retry').hidden = true; setError('auth-error');
    try {
      const auth = await api('/api/auth/status'); if (current !== authRequest) return;
      setupRequired = !!auth.setupRequired; setupAllowed = auth.setupAllowed !== false; state.workspace = auth.workspace;
      if (auth.authenticated && auth.user) await enterWorkspace(auth); else { state.user = null; showAuth(); }
    } catch (error) { if (current !== authRequest) return; $('auth-title').textContent = '暂时无法连接'; $('auth-description').textContent = '请确认 Pi Web 服务正在运行，再重新连接。'; setError('auth-error', error.message); $('auth-retry').hidden = false; }
  }
  function expire() {
    if (!state.user) return;
    state.user = null; authRequest++; requestId++; auditRequest++;
    document.querySelectorAll('dialog[open]').forEach((dialog) => dialog.close());
    clearWorkspace(); clearPasswords(); users = []; $('user-list').replaceChildren(); $('event-list').replaceChildren(); resetAudit();
    $('account-menu').open = false; showAuth('登录已过期或账户已停用，请重新登录。');
  }
  async function authenticate(event) {
    event.preventDefault(); if (!$('auth-form').reportValidity()) return;
    if (setupRequired && $('auth-password').value !== $('auth-confirm-password').value) { setError('auth-error', '两次输入的密码不一致，请重新输入。'); clearPasswords($('auth-form')); $('auth-password').focus(); return; }
    const body = { username: $('auth-username').value.trim(), password: $('auth-password').value, ...(setupRequired ? { displayName: $('auth-display-name').value.trim() } : {}) };
    busy($('auth-submit'), true, setupRequired ? '正在创建…' : '正在登录…'); setError('auth-error');
    try { const result = await api(setupRequired ? '/api/auth/setup' : '/api/auth/login', { method: 'POST', body }); setupRequired = false; await enterWorkspace(result); }
    catch (error) { setError('auth-error', error.message); }
    finally { clearPasswords($('auth-form')); busy($('auth-submit'), false, setupRequired ? '创建管理员并进入' : '登录工作空间'); }
  }
  async function logout() {
    if (state.running) { toast('请先停止当前任务，再退出登录。'); return; }
    $('logout').disabled = true;
    try { await api('/api/auth/logout', { method: 'POST', body: {} }); state.user = null; requestId++; authRequest++; document.querySelectorAll('dialog[open]').forEach((dialog) => dialog.close()); clearWorkspace(); clearPasswords(); users = []; $('user-list').replaceChildren(); $('event-list').replaceChildren(); resetAudit(); $('account-menu').open = false; showAuth(); }
    catch (error) { toast(error.message); } finally { $('logout').disabled = false; }
  }
  function goChat() {
    view = 'chat'; requestId++;
    $('chat-workspace').hidden = false; $('admin-view').hidden = true; $('view-name').textContent = '群聊';
    $('nav-chat').classList.add('nav-current');
    $('automation-view').hidden = true;
    for (const id of ['nav-users', 'nav-audit', 'nav-events', 'nav-skills', 'nav-schedules']) $(id).classList.remove('selected');
    $('toggle-context').hidden = false; closeSidebar();
  }
  async function navigate(next) {
    if (!isAdmin()) return;
    if (state.running) { toast('请等待当前任务完成或先停止，再进入管理页面。'); return; }
    const current = ++requestId; view = next; closeSidebar(); $('account-menu').open = false;
    $('chat-workspace').hidden = true; $('admin-view').hidden = false; $('context-panel').classList.remove('open'); $('toggle-context').hidden = true;
    $('automation-view').hidden = true;
    $('nav-chat').classList.remove('nav-current');
    for (const id of ['nav-users', 'nav-audit', 'nav-events', 'nav-skills', 'nav-schedules']) $(id).classList.toggle('selected', id === `nav-${next}`);
    const titles = { users: ['员工管理', '为同事创建登录账户，共同访问公司共享空间。'], audit: ['聊天审计', '查询群聊，按实际发言人查看完整消息与工具结果。'], events: ['操作记录', '查看公司空间中的账户、配置和审计访问记录。'] };
    $('admin-title').textContent = titles[next][0]; $('view-name').textContent = titles[next][0]; $('admin-description').textContent = titles[next][1];
    $('users-view').hidden = next !== 'users'; $('audit-view').hidden = next !== 'audit'; $('events-view').hidden = next !== 'events'; $('create-user').hidden = next !== 'users'; $('refresh-admin').hidden = next === 'users'; setError('admin-error');
    try { if (next === 'users') await loadUsers(current); else if (next === 'audit') { await loadAuditUsers(); await searchSessions(); } else await loadEvents(current); }
    catch (error) { if (current === requestId) setError('admin-error', error.message); }
  }
  async function loadUsers(current = requestId) {
    $('user-list').replaceChildren(node('p', 'admin-empty', '正在加载员工账户…'));
    const data = await api('/api/admin/users'); if (current !== requestId || view !== 'users') return;
    users = data.users || [];
    $('user-list').replaceChildren(...users.map((user) => {
      const row = node('article', 'user-row'); const avatar = node('div', 'member-avatar', (user.displayName || user.username).slice(0, 1).toUpperCase());
      const identity = node('div', 'member-identity'); const name = node('strong', '', user.displayName || user.username); if (user.id === state.user.id) name.append(node('span', 'self-tag', '你')); identity.append(name, node('span', '', user.username));
      const role = node('span', `member-role ${user.role}`, user.role === 'admin' ? '管理员' : '员工'); const status = node('span', `member-status${user.disabled ? ' disabled' : ''}`, user.disabled ? '已停用' : '可登录');
      const actions = node('div', 'member-actions'); const reset = node('button', 'secondary-button', '重置密码'); reset.type = 'button'; reset.addEventListener('click', () => openUserDialog(user));
      const toggle = node('button', `secondary-button${user.disabled ? '' : ' danger-button'}`, user.disabled ? '启用账户' : '停用账户'); toggle.type = 'button'; toggle.disabled = user.id === state.user.id; if (toggle.disabled) toggle.title = '不能在此停用当前登录账户';
      toggle.addEventListener('click', async () => { toggle.disabled = true; try { await api(`/api/admin/users/${encodeURIComponent(user.id)}`, { method: 'PATCH', body: { disabled: !user.disabled } }); toast(user.disabled ? '账户已启用。' : '账户已停用。'); await loadUsers(); } catch (error) { setError('admin-error', error.message); toggle.disabled = false; } });
      actions.append(reset, toggle); row.append(avatar, identity, role, status, actions); return row;
    }));
    if (!users.length) $('user-list').append(node('p', 'admin-empty', '当前还没有员工账户。'));
  }
  function openUserDialog(user = null) {
    if (!isAdmin()) return; editUser = user; $('user-form').reset(); setError('user-error');
    $('user-dialog-title').textContent = user ? '重置员工密码' : '添加员工';
    $('user-dialog-description').textContent = user ? `正在为 ${user.displayName || user.username}（${user.username}）设置新密码。` : '为员工创建公司空间登录账户。';
    for (const id of ['user-username-field', 'user-name-field', 'user-role-field']) $(id).hidden = !!user;
    $('user-username').required = !user; $('user-display-name').required = !user;
    $('user-password-label').textContent = user ? '新密码' : '初始密码'; $('save-user').textContent = user ? '重置密码' : '创建账户'; $('user-dialog').showModal();
  }
  async function saveUser(event) {
    event.preventDefault(); if (!$('user-form').reportValidity()) return;
    const body = editUser ? { password: $('user-password').value } : { username: $('user-username').value.trim(), displayName: $('user-display-name').value.trim(), password: $('user-password').value, role: $('user-role').value };
    busy($('save-user'), true, '正在保存…'); setError('user-error');
    try { await api(editUser ? `/api/admin/users/${encodeURIComponent(editUser.id)}` : '/api/admin/users', { method: editUser ? 'PATCH' : 'POST', body }); $('user-dialog').close(); toast(editUser ? '密码已重置，请通过可信渠道告知本人。' : '员工账户已创建。'); await loadUsers(); }
    catch (error) { setError('user-error', error.message); }
    finally { $('user-password').value = ''; busy($('save-user'), false, editUser ? '重置密码' : '创建账户'); }
  }
  async function loadAuditUsers() {
    const result = await api('/api/admin/users'); users = result.users || [];
    const selected = $('audit-user').value; const all = node('option', '', '所有创建人'); all.value = '';
    $('audit-user').replaceChildren(all, ...users.map((user) => { const option = node('option', '', `${user.displayName || user.username}（${user.username}）${user.disabled ? ' · 已停用' : ''}`); option.value = user.id; return option; }));
    if (users.some((user) => user.id === selected)) $('audit-user').value = selected;
  }
  async function searchSessions(event, append = false) {
    event?.preventDefault(); if (!isAdmin() || view !== 'audit') return;
    if ($('audit-from').value && $('audit-to').value && $('audit-from').value > $('audit-to').value) { setError('admin-error', '开始日期不能晚于结束日期。'); return; }
    const current = ++auditRequest; setError('admin-error'); busy($('search-audit'), true, '查询中…');
    if (!append) { detailRequest++; auditSessions = []; selectedAuditId = null; auditParams = new URLSearchParams(); for (const [name, id] of [['userId', 'audit-user'], ['q', 'audit-query'], ['from', 'audit-from'], ['to', 'audit-to']]) if ($(id).value.trim()) auditParams.set(name, $(id).value.trim()); }
    const params = new URLSearchParams(auditParams); params.set('limit', '100'); params.set('offset', String(auditSessions.length));
    if (!append) $('audit-session-list').replaceChildren(node('p', 'admin-empty', '正在查询会话…'));
    try {
      const data = await api(`/api/admin/sessions?${params}`); if (current !== auditRequest || view !== 'audit') return;
      const sessions = append ? [...auditSessions, ...(data.sessions || [])] : data.sessions || []; auditSessions = sessions;
      $('audit-session-list').replaceChildren(...sessions.map((session) => {
        const button = node('button', `audit-session-button${session.id === selectedAuditId ? ' active' : ''}`); button.type = 'button'; button.dataset.id = session.id;
        button.append(node('strong', '', session.title || '群聊'), node('span', '', `群聊 · ${session.legacyUnknownOwner ? '历史创建人未记录' : `${session.createdByName || session.ownerName || '创建人未记录'} 创建`}`), node('small', '', `${displayDate(session.updatedAt || session.createdAt)} · ${session.messageCount || 0} 条消息${session.running ? ` · ${session.activeUserName || '成员'} 运行中` : ''}`));
        button.addEventListener('click', () => openAuditSession(session.id, button)); return button;
      }));
      if (!sessions.length) $('audit-session-list').append(node('p', 'admin-empty', '没有符合条件的会话。试试调整创建人、关键词或日期。'));
      const total = data.total ?? sessions.length;
      if (sessions.length < total) { const more = node('button', 'audit-load-more', `加载更多 · 已显示 ${sessions.length} / ${total}`); more.type = 'button'; more.addEventListener('click', () => { more.disabled = true; searchSessions(null, true); }); $('audit-session-list').append(more); }
      if (!append) { $('audit-messages').replaceChildren(node('p', 'admin-empty', sessions.length ? '选择一个会话，查看完整聊天和工具结果。' : '暂无可显示的聊天记录。')); $('audit-transcript-heading').replaceChildren(node('strong', '', `查询结果 · ${total} 个会话`), node('span', '', '只读审计')); }
    } catch (error) { if (current === auditRequest) { setError('admin-error', error.message); $('audit-session-list').replaceChildren(node('p', 'admin-empty', '查询失败，请重试。')); } }
    finally { if (current === auditRequest) busy($('search-audit'), false, '查询'); }
  }
  async function openAuditSession(id, button) {
    const current = ++detailRequest; selectedAuditId = id;
    $('audit-messages').replaceChildren(node('p', 'admin-empty', '正在加载完整聊天记录…')); setError('admin-error');
    document.querySelectorAll('.audit-session-button').forEach((item) => item.classList.toggle('active', item === button));
    try {
      const data = await api(`/api/admin/sessions/${encodeURIComponent(id)}`); if (current !== detailRequest || view !== 'audit') return;
      const creator = data.session.legacyUnknownOwner ? '历史创建人未记录' : data.session.createdByName || data.session.ownerName || '创建人未记录';
      const identity = node('div'); identity.append(node('strong', '', data.session.title || '群聊'), node('small', '', `${creator} 创建 · ${displayDate(data.session.updatedAt || data.session.createdAt)}`));
      const actions = node('div', 'audit-detail-actions'); actions.append(node('span', 'audit-readonly-badge', '只读审计'));
      const download = node('a', 'secondary-button audit-export', '导出记录'); download.href = `/api/admin/sessions/${encodeURIComponent(id)}/export`; download.download = `pi-session-${id}.json`; download.prepend(icon('document')); actions.append(download);
      $('audit-transcript-heading').replaceChildren(identity, actions);
      renderTranscript(data.messages || [], $('audit-messages'), '历史发言人未记录');
      if (!data.messages?.length) $('audit-messages').append(node('p', 'admin-empty', '此会话尚无消息。'));
    } catch (error) { if (current === detailRequest) { setError('admin-error', error.message); $('audit-messages').replaceChildren(node('p', 'admin-empty', '无法读取此会话，请重新选择或刷新。')); } }
  }
  const actionLabels = { 'session.mode_changed': '切换对话工具模式', 'users.imported': '批量导入账号', 'workspace.setup': '初始化共享空间', 'auth.setup': '创建首个管理员', 'auth.login': '登录', 'auth.login_failed': '登录失败', 'auth.logout': '退出登录', 'auth.password': '修改密码', 'auth.password_changed': '修改密码', 'user.password_changed': '修改密码', 'user.create': '创建员工', 'user.created': '创建员工', 'user.update': '更新员工账户', 'user.updated': '更新员工账户', 'user.disable': '停用账户', 'user.enable': '启用账户', 'user.password': '重置密码', 'config.update': '更新公司配置', 'config.updated': '更新公司配置', 'session.create': '创建对话', 'session.created': '创建对话', 'session.read': '查看对话', 'session.exported': '导出聊天记录', 'admin.sessions_listed': '查询聊天审计', 'admin.session_viewed': '查看聊天详情', 'audit.sessions': '查询聊天审计', 'audit.session': '查看聊天详情', 'audit.events': '查看操作记录' };
  Object.assign(actionLabels, {
    'skill.created': '创建技能', 'skill.updated': '更新技能', 'skill.deleted': '删除技能',
    'schedule.created': '创建定时任务', 'schedule.updated': '更新定时任务', 'schedule.deleted': '删除定时任务',
    'schedule.run_requested': '请求运行任务', 'schedule.run_started': '开始运行任务', 'schedule.run_finished': '任务运行结束', 'schedule.cancel_requested': '请求取消任务',
  });
  async function loadEvents(current = requestId) {
    $('event-list').replaceChildren(node('p', 'admin-empty', '正在加载操作记录…'));
    const result = await api('/api/admin/audit?limit=200'); if (current !== requestId || view !== 'events') return;
    $('admin-description').textContent = `查看最近 ${result.events?.length || 0} 条公司空间操作记录（最多 200 条）。`;
    $('event-list').replaceChildren(...(result.events || []).map((event) => {
      const item = node('article', 'event-row'); const eventIcon = node('span', 'event-icon'); eventIcon.append(icon('list'));
      const body = node('div', 'event-body'); body.append(node('strong', '', actionLabels[event.action] || event.action || '操作记录'));
      const actor = event.actorName || event.displayName || event.username || event.actor?.displayName || event.actor?.username || event.userName || event.userId || '系统';
      body.append(node('span', '', `操作人：${actor}`));
      if (event.details || event.detail || event.targetId) { const details = node('details', 'event-details'); details.append(node('summary', '', '查看详情'), node('pre', '', typeof (event.details || event.detail) === 'string' ? event.details || event.detail : JSON.stringify(event.details || event.detail || { targetId: event.targetId }, null, 2))); body.append(details); }
      item.append(eventIcon, body, node('time', '', displayDate(event.at || event.timestamp || event.createdAt))); return item;
    }));
    if (!result.events?.length) $('event-list').append(node('p', 'admin-empty', '暂无操作记录。'));
  }
  async function savePassword(event) {
    event.preventDefault(); if (!$('password-form').reportValidity()) return;
    if ($('new-password').value !== $('confirm-new-password').value) { setError('password-error', '两次输入的新密码不一致。'); clearPasswords($('password-form')); $('current-password').focus(); return; }
    const body = { currentPassword: $('current-password').value, newPassword: $('new-password').value };
    busy($('save-password'), true, '更新中…'); setError('password-error');
    try { await api('/api/auth/password', { method: 'POST', body }); $('password-dialog').close(); toast('密码已更新，其他设备的登录已失效。'); }
    catch (error) { setError('password-error', error.message); }
    finally { clearPasswords($('password-form')); busy($('save-password'), false, '更新密码'); }
  }
  $('auth-form').addEventListener('submit', authenticate); $('auth-retry').addEventListener('click', initialize); $('logout').addEventListener('click', logout);
  $('nav-users').addEventListener('click', () => navigate('users')); $('nav-audit').addEventListener('click', () => navigate('audit')); $('nav-events').addEventListener('click', () => navigate('events'));
  $('create-user').addEventListener('click', () => openUserDialog()); $('user-form').addEventListener('submit', saveUser);
  $('audit-filter-form').addEventListener('submit', searchSessions); $('refresh-admin').addEventListener('click', () => navigate(view));
  $('change-password').addEventListener('click', () => { $('account-menu').open = false; $('password-form').reset(); setError('password-error'); $('password-dialog').showModal(); });
  $('password-form').addEventListener('submit', savePassword);
  document.querySelectorAll('.dialog-dismiss').forEach((button) => button.addEventListener('click', () => $(button.dataset.dialog).close()));
  for (const id of ['password-dialog', 'user-dialog']) $(id).addEventListener('close', () => clearPasswords($(id)));
  document.addEventListener('click', (event) => { if (!$('account-menu').contains(event.target)) $('account-menu').open = false; });
  function enterExtension(next) {
    if (!isAdmin() || !['skills', 'schedules'].includes(next)) return false;
    if (state.running) { toast('请等待当前任务完成或先停止，再进入管理页面。'); return false; }
    view = next; requestId++; closeSidebar(); $('account-menu').open = false;
    $('chat-workspace').hidden = true; $('admin-view').hidden = true; $('automation-view').hidden = false; $('context-panel').classList.remove('open'); $('toggle-context').hidden = true;
    $('view-name').textContent = next === 'skills' ? '技能中心' : '定时任务'; $('nav-chat').classList.remove('nav-current');
    for (const id of ['nav-users', 'nav-audit', 'nav-events', 'nav-skills', 'nav-schedules']) $(id).classList.toggle('selected', id === `nav-${next}`);
    return true;
  }
  return { initialize, expire, isAdmin, goChat, enterExtension, get view() { return view; } };
}

