// Channel credentials stay on the server. API text is always rendered as text nodes.
export function createChannelsController({ $, api, state, node, icon, toast, company, closeSidebar, onCreated, onBindingsChanged = () => {} }) {
  const host = node('div', 'channel-dialog-host');
  host.innerHTML = `
    <dialog id="channels-dialog" class="channels-dialog" aria-labelledby="channels-title">
      <div class="dialog-header"><div><span class="eyebrow">MESSAGE CHANNELS</span><h2 id="channels-title">消息渠道</h2><p>让个人微信、企业微信与指定群聊互通。</p></div><button class="icon-button" type="button" data-channel-close="channels-dialog" aria-label="关闭消息渠道"><span data-icon="x"></span></button></div>
      <div class="dialog-body"><div id="channels-error" class="settings-error" role="alert" tabindex="-1" hidden></div>
        <div class="channel-notice"><span data-icon="info"></span><p>仅管理员可配置渠道。每个渠道仅绑定一个 Web 群聊，绑定后互通新消息，不会同步历史记录。企业微信需要另外选择机器人可访问的外部会话。</p></div>
        <form id="channel-create-form" class="channel-create-form"><div class="channel-create-fields"><div class="form-field"><label for="channel-create-type">渠道类型</label><select id="channel-create-type" name="type"><option value="weixin">个人微信 · 扫码登录</option><option value="wecom">企业微信智能机器人 · 长连接</option></select></div><div class="form-field"><label for="channel-create-name">渠道名称</label><input id="channel-create-name" name="name" required maxlength="80" autocomplete="off" placeholder="例如：小敏的微信"></div><div id="channel-create-wecom" hidden><div class="form-field"><label for="channel-create-bot-id">Bot ID</label><input id="channel-create-bot-id" name="botId" maxlength="256" autocomplete="off" spellcheck="false"></div><div class="form-field"><label for="channel-create-secret">Secret</label><div class="password-field"><input id="channel-create-secret" name="secret" type="password" maxlength="1024" autocomplete="new-password" spellcheck="false"><button id="channel-create-secret-toggle" type="button" class="icon-button" aria-label="显示 Secret" aria-pressed="false"><span data-icon="eye"></span></button></div></div><p class="channel-note">在企业微信后台创建智能机器人，选择 API 模式的长连接方式，复制 Bot ID 和 Secret。无需 Webhook、回调地址或 Corp ID。</p></div><p id="channel-create-hint" class="channel-note">添加后使用本人微信扫码登录。</p></div><button class="primary-button" id="channel-create-submit" type="submit"><span data-icon="plus"></span>添加渠道</button></form>
        <div class="channel-list-heading"><h3>已添加的渠道</h3><button class="secondary-button" id="channels-refresh" type="button"><span data-icon="refresh"></span>刷新</button></div>
        <p id="channels-status" class="channel-note" role="status"></p><div id="channels-list" class="channel-list"></div>
      </div><div class="dialog-footer"><span>个人微信扫码 · 企业微信长连接</span><button class="secondary-button" type="button" data-channel-close="channels-dialog">完成</button></div>
    </dialog>
    <dialog id="channel-login-dialog" class="channel-login-dialog" aria-labelledby="channel-login-title">
      <div class="dialog-header"><div><h2 id="channel-login-title">微信扫码登录</h2><p id="channel-login-name"></p></div><button class="icon-button" type="button" data-channel-close="channel-login-dialog" aria-label="关闭微信登录"><span data-icon="x"></span></button></div>
      <div class="dialog-body"><div id="channel-login-error" class="settings-error" role="alert" tabindex="-1" hidden></div><div class="channel-qr-frame"><img id="channel-login-qr" width="224" height="224" alt="使用本人微信扫描此二维码登录消息渠道" hidden><span id="channel-qr-placeholder">正在申请二维码…</span></div><p id="channel-login-status" class="channel-login-status" role="status"></p>
        <form id="channel-verify-form" hidden><div class="form-field"><label for="channel-verify-code">手机验证码</label><input id="channel-verify-code" name="verifyCode" inputmode="numeric" autocomplete="one-time-code" maxlength="12" placeholder="输入微信验证时收到的验证码"><small>如微信要求手机验证，请先在手机完成提示，再填写验证码。</small></div><button type="submit" class="primary-button" id="channel-verify-submit">提交验证码</button></form>
        <p class="channel-note">请使用本人微信扫码并确认。需要微信支持微信 ClawBot 插件；如提示暂不支持，请先升级微信并确认插件可用。当前支持文字与语音转写，图片和文件后续支持。</p>
      </div><div class="dialog-footer"><button type="button" class="secondary-button" id="channel-login-refresh">刷新二维码</button><button type="button" class="primary-button" data-channel-close="channel-login-dialog">完成</button></div>
    </dialog>
    <dialog id="channel-wecom-dialog" class="channel-wecom-dialog" aria-labelledby="channel-wecom-title"><form id="channel-wecom-form">
      <div class="dialog-header"><div><h2 id="channel-wecom-title">企业微信渠道配置</h2><p id="channel-wecom-name"></p></div><button class="icon-button" type="button" data-channel-close="channel-wecom-dialog" aria-label="关闭企业微信配置"><span data-icon="x"></span></button></div>
      <div class="dialog-body"><div id="channel-wecom-error" class="settings-error" role="alert" tabindex="-1" hidden></div><div class="form-field"><label for="channel-wecom-bot-id">Bot ID</label><input id="channel-wecom-bot-id" name="botId" required maxlength="256" autocomplete="off" spellcheck="false"></div><div class="form-field"><label for="channel-wecom-secret">Secret</label><div class="password-field"><input id="channel-wecom-secret" name="secret" type="password" maxlength="1024" autocomplete="new-password" spellcheck="false"><button id="channel-wecom-secret-toggle" type="button" class="icon-button" aria-label="显示 Secret" aria-pressed="false"><span data-icon="eye"></span></button></div><small id="channel-wecom-secret-hint">留空保留已保存的 Secret；凭据只保存在服务端。</small></div><p class="channel-note">在企业微信后台的智能机器人中选择 API 模式、长连接方式，获取 Bot ID 和 Secret。更新凭据后自动连接，并清空原会话；请重新发现并选择会话。</p>
        <div class="channel-conversation-heading"><label for="channel-wecom-target">消息互通会话</label><button id="channel-wecom-refresh" class="secondary-button" type="button">刷新会话</button></div><select id="channel-wecom-target" aria-describedby="channel-wecom-target-hint"><option value="">暂不选择</option></select><p id="channel-wecom-target-hint" class="channel-note">先保存凭据，再将机器人加入目标企微群并 @ 机器人发送文字，或私聊机器人，然后刷新并选择会话。会话按 ID 区分，请按最近收到时间核对目标；不会自动绑定首次发消息的会话。</p><p id="channel-wecom-status" class="channel-note" role="status"></p><div class="channel-notice channel-sharing-notice"><span data-icon="info"></span><p>选择企微群后，该企微群所有成员可看到绑定 Web 群的新消息；历史记录不转发。选择私聊时，消息发给该私聊用户。</p></div>
      </div><div class="dialog-footer"><button type="button" class="secondary-button" data-channel-close="channel-wecom-dialog">取消</button><button id="channel-wecom-save" class="primary-button" type="submit">保存配置</button></div>
    </form></dialog>
    <dialog id="group-channel-dialog" class="group-channel-dialog" aria-labelledby="group-channel-title"><form id="group-channel-form">
      <div class="dialog-header"><div><h2 id="group-channel-title">新建群聊</h2><p id="group-channel-description">设置话题，按需绑定消息渠道。</p></div><button class="icon-button" type="button" data-channel-close="group-channel-dialog" aria-label="关闭群聊渠道设置"><span data-icon="x"></span></button></div>
      <div class="dialog-body"><div id="group-channel-error" class="settings-error" role="alert" tabindex="-1" hidden></div><div class="form-field" id="group-channel-name-field"><label for="group-channel-name">群名称</label><input id="group-channel-name" name="title" required maxlength="120" autocomplete="off" placeholder="例如：订单报价协作群"></div><fieldset class="channel-binding-fieldset"><legend>消息渠道 <span>可选</span></legend><p class="channel-note">绑定后互通新消息，不转发历史记录。个人微信由扫码本人参与；企业微信按渠道中选择的会话参与。选择企微群后，该企微群所有成员可看到本群的新消息。</p><p id="group-channel-status" class="channel-note" role="status"></p><div id="group-channel-options" class="channel-binding-options"></div></fieldset><button type="button" class="text-button" id="group-channel-open-manager"><span data-icon="plus"></span>管理消息渠道</button></div>
      <div class="dialog-footer"><button type="button" class="secondary-button" data-channel-close="group-channel-dialog">取消</button><button type="submit" class="primary-button" id="group-channel-save">创建群聊</button></div>
    </form></dialog>
    <dialog id="channel-delete-dialog" class="account-dialog" aria-labelledby="channel-delete-title"><form id="channel-delete-form"><div class="dialog-header"><div><h2 id="channel-delete-title">删除消息渠道</h2><p>删除后将停止外部渠道与群聊互通。</p></div><button type="button" class="icon-button" data-channel-close="channel-delete-dialog" aria-label="关闭删除渠道确认"><span data-icon="x"></span></button></div><div class="dialog-body"><div id="channel-delete-error" class="settings-error" role="alert" tabindex="-1" hidden></div><p id="channel-delete-description" class="channel-note"></p><p class="channel-note">外部参与人将离开绑定的群聊，已保存的聊天记录保留。</p></div><div class="dialog-footer"><button type="button" class="secondary-button" id="channel-delete-cancel" data-channel-close="channel-delete-dialog">取消</button><button type="submit" class="primary-button remove-member-confirm" id="channel-delete-submit">确认删除</button></div></form></dialog>`;
  document.body.append(host);
  host.querySelectorAll('[data-icon]').forEach(el => el.replaceWith(icon(el.dataset.icon)));
  let channels = [], managerRequest = 0, managerBusy = false, managerTimer, managerAbort, loginRequest = 0, loginTimer, loginAbort, loginFailures = 0, resetting = false;
  const channelViews = new Map();
  let loginChannelId = null, loginId = null, loginStarting = false, groupRequest = 0, groupBusy = false, groupTarget = null, groupSnapshot;
  let groupSelected = new Set(), deleteTarget = null, deleteBusy = false, deleteRequest = 0;
  let wecomChannel = null, wecomSnapshot = null, wecomRequest = 0, wecomConversationsRequest = 0, wecomAbort, wecomSaveAbort, wecomBusy = false, wecomConversations = [];
  const capture = () => ({ user: state.user?.id, epoch: state.identityEpoch });
  const valid = snapshot => company.isAdmin() && snapshot?.user === state.user?.id && snapshot?.epoch === state.identityEpoch;
  const error = (id, text = '', focus = true) => { $(id).textContent = text; $(id).hidden = !text; if (text && focus) $(id).focus(); };
  const isWecom = channel => channel?.type === 'wecom';
  const isWebhookOnly = channel => isWecom(channel) && channel.connectionMode === 'webhook';
  const labels = { idle: '未登录', login_required: '需重新登录', disconnected: '未登录', unconfigured: '未登录', connecting: '待扫码', waiting: '待扫码', waiting_scan: '待扫码', wait: '待扫码', scaned: '待确认', scanned: '待确认', scaned_but_redirect: '确认处理中', binded_redirect: '确认处理中', confirmed: '已连接', connected: '已连接', paused: '暂停', disabled: '暂停', expired: '需重新登录', error: '连接异常', need_verify: '待手机验证', need_verifycode: '待手机验证', verify_code_blocked: '需重新扫码', unavailable: '不可用' };
  function channelState(channel) {
    if (channel.enabled === false) return { label: '暂停', tone: 'paused' };
    if (isWebhookOnly(channel)) return { label: channel.webhookSet ? '已配置' : '待配置', tone: channel.webhookSet ? 'connected' : 'idle' };
    if (channel.connected) return { label: '已连接', tone: 'connected' };
    if (isWecom(channel)) return { label: channel.status === 'connecting' ? '连接中' : channel.status === 'unconfigured' || !channel.secretSet ? '待配置' : channel.status === 'error' ? '连接异常' : '未连接', tone: channel.status === 'error' ? 'error' : 'idle' };
    return { label: labels[channel.status] || '未登录', tone: ['expired', 'error', 'unavailable', 'verify_code_blocked'].includes(channel.status) ? 'error' : 'idle' };
  }
  function badge(channel) { const status = channelState(channel); return node('span', `channel-badge ${status.tone}`, status.label); }
  function button(text, action, className = 'secondary-button') {
    const result = node('button', className, text); result.type = 'button'; result.addEventListener('click', action); return result;
  }
  function stopManager() { managerRequest++; clearTimeout(managerTimer); managerAbort?.abort(); managerAbort = null; }
  async function refreshManager({ quiet = false } = {}) {
    if (resetting || !company.isAdmin() || !$('channels-dialog').open) return;
    clearTimeout(managerTimer); managerAbort?.abort();
    const snapshot = capture(), token = ++managerRequest;
    const controller = new AbortController(); managerAbort = controller;
    if (!quiet) $('channels-status').textContent = '正在加载消息渠道…';
    if (!quiet) $('channels-refresh').disabled = true;
    try {
      const result = await api('/api/admin/channels', { signal: controller.signal });
      if (!valid(snapshot) || token !== managerRequest || !$('channels-dialog').open) return;
      channels = result.channels || []; renderManager({ preserve: quiet }); $('channels-status').textContent = channels.length ? `共 ${channels.length} 个消息渠道` : '还没有渠道，选择类型并添加。';
    } catch (failure) {
      if (valid(snapshot) && token === managerRequest && $('channels-dialog').open && failure.name !== 'AbortError') {
        if (quiet) $('channels-status').textContent = '渠道状态暂未更新，正在自动重试…';
        else error('channels-error', failure.message);
      }
    } finally {
      if (valid(snapshot) && token === managerRequest) {
        managerAbort = null; $('channels-refresh').disabled = false;
        if ($('channels-dialog').open) managerTimer = setTimeout(() => refreshManager({ quiet: true }), 2500);
      }
    }
  }
  function renderManager({ preserve = false } = {}) {
    if (!preserve) { channelViews.clear(); $('channels-list').replaceChildren(); }
    const ids = new Set(channels.map(channel => channel.id));
    for (const [id, view] of channelViews) if (!ids.has(id)) { view.card.remove(); channelViews.delete(id); }
    for (const latest of channels) {
      const existing = channelViews.get(latest.id);
      if (existing) {
        const previousName = existing.channel.name;
        Object.assign(existing.channel, latest);
        if (existing.input.value === previousName && document.activeElement !== existing.input) existing.input.value = latest.name;
        updateChannelView(existing); continue;
      }
      const channel = { ...latest };
      const card = node('article', 'channel-card');
      const heading = node('div', 'channel-card-heading'), identity = node('div', 'channel-card-identity');
      const title = node('strong'), account = node('small'), status = badge(channel);
      identity.append(title, account); heading.append(identity, status); card.append(heading);
      const binding = node('p', 'channel-note'), context = node('p', 'channel-context-hint', '微信已登录。请先在微信给机器人发送一条消息，再接收群内新消息。'), issue = node('p', 'channel-card-error');
      card.append(binding, context, issue);
      const rename = node('form', 'channel-rename-form'), nameId = `channel-name-${channel.id}`;
      const label = node('label', 'sr-only', `渠道名称：${channel.name}`); label.htmlFor = nameId;
      const input = node('input'); input.id = nameId; input.value = channel.name; input.required = true; input.maxLength = 80; input.autocomplete = 'off';
      const save = node('button', 'secondary-button', '保存名称'); save.type = 'submit'; rename.append(label, input, save);
      rename.addEventListener('submit', async event => {
        event.preventDefault(); const snapshot = capture(); if (!valid(snapshot) || save.disabled) return;
        save.disabled = true; error('channels-error');
        try { await api(`/api/admin/channels/${encodeURIComponent(channel.id)}`, { method: 'PATCH', body: { name: input.value.trim() } }); if (valid(snapshot)) { toast('渠道名称已更新'); await refreshManager({ quiet: true }); } }
        catch (failure) { if (valid(snapshot) && $('channels-dialog').open) error('channels-error', failure.message); }
        finally { if (valid(snapshot)) save.disabled = false; }
      });
      const actions = node('div', 'channel-card-actions');
      const login = button('', () => isWecom(channel) ? reconnectWecom(channel, login) : startLogin(channel)); actions.append(login);
      const configure = button('配置企业微信', () => openWecom(channel)); actions.append(configure);
      const toggle = button(channel.enabled === false ? '启用渠道' : '暂停渠道', async () => {
        const snapshot = capture(); toggle.disabled = true; error('channels-error');
        try { await api(`/api/admin/channels/${encodeURIComponent(channel.id)}`, { method: 'PATCH', body: { enabled: channel.enabled === false } }); if (valid(snapshot)) { await refreshManager({ quiet: true }); onBindingsChanged(); } }
        catch (failure) { if (valid(snapshot) && $('channels-dialog').open) error('channels-error', failure.message); }
        finally { if (valid(snapshot)) toggle.disabled = false; }
      });
      actions.append(toggle, button('删除', () => {
        deleteTarget = channel; deleteRequest++; deleteBusy = false;
        error('channel-delete-error'); $('channel-delete-submit').disabled = false;
        $('channel-delete-description').textContent = `确定删除「${channel.name}」${channel.sessionTitle ? `与「${channel.sessionTitle}」的绑定` : ''}？`;
        $('channel-delete-dialog').showModal(); $('channel-delete-cancel').focus();
      }, 'secondary-button channel-danger'));
      card.append(rename, actions);
      const view = { channel, card, title, account, status, binding, context, issue, input, label, login, configure, toggle };
      channelViews.set(channel.id, view); updateChannelView(view); $('channels-list').append(card);
    }
  }
  function updateChannelView(view) {
    const { channel } = view, status = channelState(channel);
    view.title.textContent = channel.name; view.account.textContent = isWecom(channel) ? `企业微信${channel.botId ? ` · ${channel.botId}` : ''}` : channel.accountLabel || '个人微信';
    view.status.textContent = status.label; view.status.className = `channel-badge ${status.tone}`;
    view.binding.textContent = channel.sessionId ? `绑定群聊：${channel.sessionTitle || '已绑定群聊'}` : '尚未绑定群聊';
    view.context.hidden = isWebhookOnly(channel) ? false : isWecom(channel) ? !!channel.target : !(channel.connected && channel.canReceive === false);
    view.context.textContent = isWebhookOnly(channel) ? '企业微信群 Webhook 仅发送通知；请在新版工作台的消息渠道中管理 Webhook 配置。' : isWecom(channel) ? '尚未选择企业微信会话。请在配置中刷新并选择目标企微群或私聊，再保存。' : '微信已登录。请先在微信给机器人发送一条消息，再接收群内新消息。';
    view.issue.textContent = channel.lastError || ''; view.issue.hidden = !channel.lastError;
    view.label.textContent = `渠道名称：${channel.name}`;
    view.login.textContent = isWecom(channel) ? '重新连接' : channel.connected ? '重新扫码' : '扫码登录';
    view.login.hidden = isWebhookOnly(channel);
    view.configure.hidden = !isWecom(channel) || isWebhookOnly(channel);
    view.toggle.textContent = channel.enabled === false ? '启用渠道' : '暂停渠道';
  }
  async function openManager() {
    if (!company.isAdmin()) return;
    closeSidebar(); error('channels-error');
    if (!$('channels-dialog').open) { channels = []; channelViews.clear(); $('channels-list').replaceChildren(); $('channels-dialog').showModal(); }
    await refreshManager();
  }
  function clearSecret(prefix) {
    $(`${prefix}-secret`).value = ''; $(`${prefix}-secret`).type = 'password';
    $(`${prefix}-secret-toggle`).setAttribute('aria-label', '显示 Secret'); $(`${prefix}-secret-toggle`).setAttribute('aria-pressed', 'false');
  }
  function updateCreateType() {
    const wecom = $('channel-create-type').value === 'wecom';
    $('channel-create-wecom').hidden = !wecom; $('channel-create-bot-id').required = wecom; $('channel-create-secret').required = wecom;
    $('channel-create-name').placeholder = wecom ? '例如：报价协作机器人' : '例如：小敏的微信';
    $('channel-create-hint').textContent = wecom ? '添加后连接企业微信，再配置需要互通的会话。' : '添加后使用本人微信扫码登录。';
    clearSecret('channel-create');
  }
  async function reconnectWecom(channel, control) {
    if (!company.isAdmin() || control.disabled) return;
    const snapshot = capture(); control.disabled = true; error('channels-error');
    try { await api(`/api/admin/channels/${encodeURIComponent(channel.id)}/connect`, { method: 'POST', body: {} }); if (valid(snapshot) && $('channels-dialog').open) { toast('企业微信连接已发起'); await refreshManager({ quiet: true }); onBindingsChanged(); } }
    catch (failure) { if (valid(snapshot) && $('channels-dialog').open) error('channels-error', failure.message); }
    finally { if (valid(snapshot)) control.disabled = false; }
  }
  const conversationKey = target => target?.id && ['group', 'single'].includes(target.chatType) ? JSON.stringify([target.chatType, target.id]) : '';
  function conversationDescription(item) {
    const timestamp = item.lastSeen ? new Date(item.lastSeen) : null;
    const recent = timestamp && Number.isFinite(timestamp.getTime()) ? ` · 最近收到 ${timestamp.toLocaleString('zh-CN', { hour12: false })}` : '';
    return `${item.chatType === 'group' ? '群聊' : '私聊'} · ID：${item.id}${recent}`;
  }
  function wecomValid(token = wecomRequest) { return valid(wecomSnapshot) && token === wecomRequest && $('channel-wecom-dialog').open; }
  function stopWecom() {
    wecomRequest++; wecomConversationsRequest++; wecomAbort?.abort(); wecomSaveAbort?.abort(); wecomAbort = null; wecomSaveAbort = null;
    wecomChannel = null; wecomSnapshot = null; wecomConversations = []; wecomBusy = false;
    clearSecret('channel-wecom'); $('channel-wecom-bot-id').value = ''; $('channel-wecom-target').replaceChildren(); $('channel-wecom-target').value = '';
  }
  async function refreshConversations() {
    if (!wecomValid() || wecomBusy) return;
    const token = wecomRequest, request = ++wecomConversationsRequest, target = wecomChannel.id;
    wecomAbort?.abort(); const controller = new AbortController(); wecomAbort = controller;
    $('channel-wecom-refresh').disabled = true; $('channel-wecom-status').textContent = '正在加载机器人已收到消息的会话…'; error('channel-wecom-error');
    try {
      const result = await api(`/api/admin/channels/${encodeURIComponent(target)}/conversations`, { signal: controller.signal });
      if (!wecomValid(token) || request !== wecomConversationsRequest) return;
      const selected = $('channel-wecom-target').value;
      const items = (result.conversations || []).filter(item => conversationKey(item));
      const previous = wecomConversations.find(item => conversationKey(item) === selected);
      if (selected && !items.some(item => conversationKey(item) === selected) && previous) items.unshift(previous);
      wecomConversations = items;
      const empty = node('option', '', '暂不选择'); empty.value = '';
      $('channel-wecom-target').replaceChildren(empty, ...items.map(item => { const option = node('option', '', conversationDescription(item)); option.value = conversationKey(item); option.title = option.textContent; return option; }));
      $('channel-wecom-target').value = selected;
      $('channel-wecom-status').textContent = items.length ? `发现 ${items.length} 个会话。请选择需要互通的会话后保存。` : '暂未发现会话。请在目标企微群 @ 机器人发消息，或私聊机器人后刷新。';
    } catch (failure) { if (wecomValid(token) && request === wecomConversationsRequest && failure.name !== 'AbortError') error('channel-wecom-error', failure.message); }
    finally { if (wecomValid(token) && request === wecomConversationsRequest) { wecomAbort = null; $('channel-wecom-refresh').disabled = false; } }
  }
  function openWecom(channel) {
    if (!company.isAdmin() || !isWecom(channel)) return;
    stopWecom(); wecomChannel = { ...channel }; wecomSnapshot = capture();
    $('channel-wecom-name').textContent = channel.name; $('channel-wecom-bot-id').value = channel.botId || '';
    $('channel-wecom-secret').required = !channel.secretSet;
    $('channel-wecom-secret-hint').textContent = channel.secretSet ? '留空保留已保存的 Secret；凭据只保存在服务端。' : '请填写 Secret；凭据只保存在服务端。';
    $('channel-wecom-save').disabled = false; $('channel-wecom-save').textContent = '保存配置'; $('channel-wecom-refresh').disabled = false; error('channel-wecom-error');
    const empty = node('option', '', '暂不选择'); empty.value = '';
    wecomConversations = channel.target ? [{ ...channel.target }] : [];
    const options = wecomConversations.map(item => { const option = node('option', '', conversationDescription(item)); option.value = conversationKey(item); return option; });
    $('channel-wecom-target').replaceChildren(empty, ...options); $('channel-wecom-target').value = conversationKey(channel.target);
    if (!$('channel-wecom-dialog').open) $('channel-wecom-dialog').showModal(); $('channel-wecom-bot-id').focus(); refreshConversations();
  }
  function stopLogin() { loginRequest++; clearTimeout(loginTimer); loginAbort?.abort(); loginAbort = null; loginStarting = false; loginFailures = 0; }
  function loginValid(snapshot, token) { return valid(snapshot) && token === loginRequest && $('channel-login-dialog').open; }
  function applyLogin(result) {
    const login = result.login || {};
    loginId = login.id || loginId;
    const status = login.status || result.channel?.status || 'waiting';
    const needsVerification = ['need_verify', 'need_verifycode'].includes(status);
    $('channel-login-status').textContent = needsVerification ? '请完成手机验证' : result.channel?.connected || ['confirmed', 'connected'].includes(status) ? result.channel?.canReceive === false ? '微信已连接。请先在微信给机器人发送一条消息，再接收群内新消息。' : '微信已连接，可以关闭此窗口。' : ['scanned', 'scaned'].includes(status) ? '已扫码，请在微信中确认登录。' : ['scaned_but_redirect', 'binded_redirect'].includes(status) ? '已扫码，确认处理中，请稍候。' : status === 'verify_code_blocked' ? '手机验证已被限制，请刷新二维码后重新扫码。' : status === 'expired' ? '二维码已过期，请刷新后重新扫描。' : status === 'error' ? '登录未完成，请查看提示或重新扫码。' : '请使用本人微信扫码，并在手机上确认登录。';
    const connected = result.channel?.connected || ['confirmed', 'connected'].includes(status);
    $('channel-verify-form').hidden = !needsVerification;
    $('channel-verify-code').required = needsVerification;
    if (connected) { $('channel-login-qr').hidden = true; $('channel-qr-placeholder').hidden = false; $('channel-qr-placeholder').textContent = '微信已连接'; return false; }
    if (loginId && !['expired', 'error', 'verify_code_blocked'].includes(status)) {
      const src = `/api/admin/channels/${encodeURIComponent(loginChannelId)}/logins/${encodeURIComponent(loginId)}/qr.svg`;
      if ($('channel-login-qr').getAttribute('src') !== src) $('channel-login-qr').src = src;
      $('channel-login-qr').hidden = false; $('channel-qr-placeholder').hidden = true;
    } else if (['expired', 'error', 'verify_code_blocked'].includes(status)) {
      $('channel-verify-code').value = '';
      $('channel-login-qr').hidden = true; $('channel-qr-placeholder').hidden = false; $('channel-qr-placeholder').textContent = status === 'expired' ? '二维码已过期' : status === 'verify_code_blocked' ? '请刷新二维码' : '登录未完成';
    }
    return !['expired', 'error', 'verify_code_blocked'].includes(status);
  }
  function scheduleLoginPoll(snapshot, token, delay = 2000) {
    clearTimeout(loginTimer);
    loginTimer = setTimeout(async () => {
      if (!loginValid(snapshot, token) || !loginId) return;
      loginAbort = new AbortController();
      try {
        const result = await api(`/api/admin/channels/${encodeURIComponent(loginChannelId)}/logins/${encodeURIComponent(loginId)}`, { signal: loginAbort.signal });
        if (!loginValid(snapshot, token)) return;
        loginFailures = 0; error('channel-login-error');
        if (applyLogin(result)) scheduleLoginPoll(snapshot, token);
        else { refreshManager({ quiet: true }); onBindingsChanged(); }
      } catch (failure) {
        if (loginValid(snapshot, token) && failure.name !== 'AbortError') {
          loginFailures++;
          const retryable = !failure.status || failure.status >= 500 || [408, 429].includes(failure.status);
          if (retryable && loginFailures < 5) {
            $('channel-login-status').textContent = '连接暂时中断，正在自动重试，请稍候…';
            scheduleLoginPoll(snapshot, token, Math.min(10000, 2000 * 2 ** (loginFailures - 1)));
          } else {
            error('channel-login-error', failure.message, false);
            $('channel-login-status').textContent = '暂时无法获取登录状态，可关闭窗口后查看渠道连接状态。';
          }
        }
      }
    }, delay);
  }
  async function startLogin(channel) {
    if (!company.isAdmin() || loginStarting) return;
    stopLogin(); const snapshot = capture(), token = loginRequest;
    loginChannelId = channel.id; loginId = null; loginStarting = true;
    $('channel-login-name').textContent = channel.name; error('channel-login-error');
    $('channel-verify-form').hidden = true; $('channel-verify-code').value = ''; $('channel-verify-submit').disabled = false;
    $('channel-login-qr').hidden = true; $('channel-login-qr').removeAttribute('src');
    $('channel-qr-placeholder').hidden = false; $('channel-qr-placeholder').textContent = '正在申请二维码…';
    $('channel-login-status').textContent = '正在连接微信服务…'; $('channel-login-refresh').disabled = true;
    if (!$('channel-login-dialog').open) $('channel-login-dialog').showModal();
    loginAbort = new AbortController();
    try {
      const result = await api(`/api/admin/channels/${encodeURIComponent(channel.id)}/logins`, { method: 'POST', body: {}, signal: loginAbort.signal });
      if (!loginValid(snapshot, token)) return;
      if (applyLogin(result)) scheduleLoginPoll(snapshot, token);
      else { refreshManager({ quiet: true }); onBindingsChanged(); }
    } catch (failure) {
      if (loginValid(snapshot, token) && failure.name !== 'AbortError') { error('channel-login-error', failure.message); $('channel-qr-placeholder').textContent = '二维码暂不可用'; $('channel-login-status').textContent = '请重试连接。'; }
    } finally { if (loginValid(snapshot, token)) { loginStarting = false; $('channel-login-refresh').disabled = false; } }
  }
  function renderBindingOptions(items) {
    $('group-channel-options').replaceChildren(...items.map(channel => {
      const conflicting = !!channel.sessionId && channel.sessionId !== groupTarget;
      const label = node('label', `channel-binding-option${conflicting ? ' unavailable' : ''}`), checkbox = node('input');
      checkbox.type = 'checkbox'; checkbox.value = channel.id; checkbox.checked = groupSelected.has(channel.id); checkbox.disabled = groupBusy || conflicting;
      const detail = isWecom(channel) ? channel.target ? `企业微信 · ${conversationDescription(channel.target)}` : '企业微信 · 待选择外部会话' : channel.accountLabel || '个人微信 · 扫码本人参与';
      const identity = node('span', 'channel-binding-identity'); identity.append(node('strong', '', channel.name), node('small', '', conflicting ? `已绑定「${channel.sessionTitle || '其他群聊'}」` : detail));
      checkbox.addEventListener('change', () => checkbox.checked ? groupSelected.add(channel.id) : groupSelected.delete(channel.id));
      label.append(checkbox, identity, badge(channel)); return label;
    }));
    $('group-channel-status').textContent = items.length ? '可选择多个渠道；已绑定其他群聊的渠道不可重复选择。' : '暂无消息渠道。可以先创建普通群聊，或添加渠道后再绑定。';
  }
  async function loadBindingOptions(token = groupRequest, { preserveSelection = false } = {}) {
    const snapshot = groupSnapshot, target = groupTarget;
    $('group-channel-status').textContent = '正在加载可用渠道…'; $('group-channel-save').disabled = true;
    try {
      const [all, current] = await Promise.all([api('/api/admin/channels'), target ? api(`/api/sessions/${encodeURIComponent(target)}/channels`) : Promise.resolve({ channels: [], canManage: true })]);
      if (!valid(snapshot) || token !== groupRequest || !$('group-channel-dialog').open || target !== groupTarget || (target && state.session?.id !== target)) return;
      if (current.canManage === false) throw new Error('仅本群内的管理员可以配置消息渠道。');
      groupSelected = preserveSelection
        ? new Set((all.channels || []).filter(channel => groupSelected.has(channel.id) && (!channel.sessionId || channel.sessionId === target)).map(channel => channel.id))
        : new Set((current.channels || []).map(channel => channel.id));
      renderBindingOptions(all.channels || []); $('group-channel-save').disabled = false;
    } catch (failure) { if (valid(snapshot) && token === groupRequest && $('group-channel-dialog').open) error('group-channel-error', failure.message); }
  }
  function openGroup(target = null) {
    if (!company.isAdmin() || state.running || state.loading) return;
    closeSidebar(); groupSnapshot = capture(); groupTarget = target; const token = ++groupRequest; groupBusy = false; groupSelected.clear();
    $('group-channel-title').textContent = target ? '消息渠道绑定' : '新建群聊';
    $('group-channel-description').textContent = target ? `配置「${state.session?.title || '当前群聊'}」的消息渠道。` : '设置话题，按需绑定消息渠道。';
    $('group-channel-name-field').hidden = !!target; $('group-channel-name').required = !target; $('group-channel-name').value = '';
    $('group-channel-save').textContent = target ? '保存绑定' : '创建群聊'; $('group-channel-options').replaceChildren(); error('group-channel-error');
    $('group-channel-dialog').showModal(); if (!target) $('group-channel-name').focus(); loadBindingOptions(token);
  }
  $('nav-channels').addEventListener('click', openManager);
  $('group-manage-channels').addEventListener('click', () => { if (state.session) openGroup(state.session.id); });
  $('channels-refresh').addEventListener('click', () => { error('channels-error'); refreshManager(); });
  $('channel-create-type').addEventListener('change', updateCreateType);
  for (const prefix of ['channel-create', 'channel-wecom']) $(`${prefix}-secret-toggle`).addEventListener('click', () => {
    const input = $(`${prefix}-secret`), visible = input.type === 'password'; input.type = visible ? 'text' : 'password';
    $(`${prefix}-secret-toggle`).setAttribute('aria-label', visible ? '隐藏 Secret' : '显示 Secret'); $(`${prefix}-secret-toggle`).setAttribute('aria-pressed', String(visible));
  });
  $('channel-create-form').addEventListener('submit', async event => {
    event.preventDefault(); if (!company.isAdmin() || managerBusy) return;
    const snapshot = capture(); managerBusy = true; $('channel-create-submit').disabled = true; error('channels-error');
    const type = $('channel-create-type').value === 'wecom' ? 'wecom' : 'weixin';
    const body = { type, name: $('channel-create-name').value.trim(), ...(type === 'wecom' ? { botId: $('channel-create-bot-id').value.trim(), secret: $('channel-create-secret').value.trim() } : {}) };
    clearSecret('channel-create');
    try {
      const result = await api('/api/admin/channels', { method: 'POST', body });
      if (!valid(snapshot) || !$('channels-dialog').open) return;
      $('channel-create-form').reset(); updateCreateType(); await refreshManager({ quiet: true }); if (valid(snapshot) && $('channels-dialog').open && result.channel) isWecom(result.channel) ? openWecom(result.channel) : startLogin(result.channel);
    } catch (failure) { if (valid(snapshot) && $('channels-dialog').open) error('channels-error', failure.message); }
    finally { if (valid(snapshot)) { managerBusy = false; $('channel-create-submit').disabled = false; } }
  });
  $('channel-wecom-refresh').addEventListener('click', refreshConversations);
  $('channel-wecom-form').addEventListener('submit', async event => {
    event.preventDefault(); if (!wecomValid() || wecomBusy) return;
    const token = wecomRequest, channelId = wecomChannel.id, selected = wecomConversations.find(item => conversationKey(item) === $('channel-wecom-target').value);
    const secret = $('channel-wecom-secret').value.trim(), botId = $('channel-wecom-bot-id').value.trim();
    const credentialsChanged = !!secret || botId !== (wecomChannel.botId || '');
    const body = { botId, ...(secret ? { secret } : {}), ...(!credentialsChanged ? { target: selected ? { id: selected.id, chatType: selected.chatType } : null } : {}) };
    clearSecret('channel-wecom'); wecomBusy = true; wecomConversationsRequest++; wecomAbort?.abort(); wecomAbort = null;
    $('channel-wecom-save').disabled = true; $('channel-wecom-save').textContent = '正在保存…'; $('channel-wecom-refresh').disabled = true; error('channel-wecom-error');
    wecomSaveAbort = new AbortController();
    try {
      const result = await api(`/api/admin/channels/${encodeURIComponent(channelId)}`, { method: 'PATCH', body, signal: wecomSaveAbort.signal });
      if (!wecomValid(token)) return;
      if (result.channel) wecomChannel = { ...wecomChannel, ...result.channel };
      $('channel-wecom-dialog').close(); toast(credentialsChanged ? '凭据更新后，请重新发现并选择会话' : '企业微信配置已保存'); await refreshManager({ quiet: true }); onBindingsChanged();
    } catch (failure) { if (wecomValid(token) && failure.name !== 'AbortError') error('channel-wecom-error', failure.message); }
    finally { if (wecomValid(token)) { wecomBusy = false; wecomSaveAbort = null; $('channel-wecom-save').disabled = false; $('channel-wecom-save').textContent = '保存配置'; $('channel-wecom-refresh').disabled = false; } }
  });
  $('channel-login-refresh').addEventListener('click', () => { if (loginChannelId) startLogin({ id: loginChannelId, name: $('channel-login-name').textContent }); });
  $('channel-login-qr').addEventListener('error', () => { if ($('channel-login-dialog').open && !$('channel-login-qr').hidden) { $('channel-login-qr').hidden = true; $('channel-qr-placeholder').hidden = false; $('channel-qr-placeholder').textContent = '二维码加载失败，请刷新重试'; } });
  $('channel-verify-form').addEventListener('submit', async event => {
    event.preventDefault(); if (!company.isAdmin() || !loginId || $('channel-verify-submit').disabled) return;
    stopLogin(); const snapshot = capture(), token = loginRequest; $('channel-verify-submit').disabled = true; error('channel-login-error');
    loginAbort = new AbortController();
    try {
      const result = await api(`/api/admin/channels/${encodeURIComponent(loginChannelId)}/logins/${encodeURIComponent(loginId)}`, { method: 'POST', body: { verifyCode: $('channel-verify-code').value.trim() }, signal: loginAbort.signal });
      if (!loginValid(snapshot, token)) return;
      $('channel-verify-code').value = ''; if (applyLogin(result)) scheduleLoginPoll(snapshot, token); else { refreshManager({ quiet: true }); onBindingsChanged(); }
    } catch (failure) { if (loginValid(snapshot, token)) error('channel-login-error', failure.message); }
    finally { if (loginValid(snapshot, token)) $('channel-verify-submit').disabled = false; }
  });
  $('group-channel-form').addEventListener('submit', async event => {
    event.preventDefault(); if (!valid(groupSnapshot) || groupBusy || $('group-channel-save').disabled) return;
    const snapshot = groupSnapshot, target = groupTarget, token = groupRequest;
    if (target && state.session?.id !== target) return;
    groupBusy = true; $('group-channel-save').disabled = true; $('group-channel-save').textContent = '正在保存…'; error('group-channel-error');
    $('group-channel-options').querySelectorAll('input').forEach(input => { input.disabled = true; });
    try {
      const body = { channelIds: [...groupSelected], ...(!target ? { title: $('group-channel-name').value.trim() } : {}) };
      const result = await api(target ? `/api/sessions/${encodeURIComponent(target)}/channels` : '/api/sessions', { method: target ? 'PUT' : 'POST', body });
      if (!valid(snapshot) || token !== groupRequest || !$('group-channel-dialog').open || (target && state.session?.id !== target)) return;
      $('group-channel-dialog').close();
      if (target) { toast('消息渠道绑定已更新'); onBindingsChanged(); }
      else if (result.session) await onCreated(result.session);
    } catch (failure) {
      if (valid(snapshot) && token === groupRequest && $('group-channel-dialog').open) { error('group-channel-error', failure.message); groupBusy = false; $('group-channel-save').disabled = false; $('group-channel-save').textContent = target ? '保存绑定' : '创建群聊'; await loadBindingOptions(token, { preserveSelection: true }); }
    }
  });
  $('group-channel-open-manager').addEventListener('click', openManager);
  $('channel-delete-form').addEventListener('submit', async event => {
    event.preventDefault(); if (!company.isAdmin() || !deleteTarget || deleteBusy) return;
    const snapshot = capture(), target = deleteTarget, token = ++deleteRequest;
    deleteBusy = true; $('channel-delete-submit').disabled = true; error('channel-delete-error');
    try {
      await api(`/api/admin/channels/${encodeURIComponent(target.id)}`, { method: 'DELETE', body: {} });
      if (!valid(snapshot) || token !== deleteRequest || !$('channel-delete-dialog').open) return;
      deleteBusy = false; $('channel-delete-dialog').close(); toast('消息渠道已删除'); await refreshManager({ quiet: true }); onBindingsChanged();
    } catch (failure) { if (valid(snapshot) && token === deleteRequest && $('channel-delete-dialog').open) error('channel-delete-error', failure.message); }
    finally { if (valid(snapshot) && token === deleteRequest) { deleteBusy = false; $('channel-delete-submit').disabled = false; } }
  });
  host.querySelectorAll('[data-channel-close]').forEach(control => control.addEventListener('click', () => { if (control.dataset.channelClose !== 'channel-delete-dialog' || !deleteBusy) $(control.dataset.channelClose).close(); }));
  $('channel-delete-dialog').addEventListener('cancel', event => { if (deleteBusy) event.preventDefault(); });
  $('channel-delete-dialog').addEventListener('close', () => { deleteRequest++; deleteTarget = null; deleteBusy = false; });
  $('channel-login-dialog').addEventListener('close', () => { stopLogin(); loginChannelId = null; loginId = null; $('channel-verify-code').value = ''; $('channel-login-qr').removeAttribute('src'); $('channel-login-qr').hidden = true; refreshManager({ quiet: true }); });
  $('channel-wecom-dialog').addEventListener('close', stopWecom);
  $('channels-dialog').addEventListener('close', () => { stopManager(); clearSecret('channel-create'); channels = []; channelViews.clear(); $('channels-list').replaceChildren(); if (!resetting && $('group-channel-dialog').open) loadBindingOptions(++groupRequest, { preserveSelection: true }); });
  $('group-channel-dialog').addEventListener('close', () => { groupRequest++; groupSelected.clear(); groupBusy = false; groupTarget = null; groupSnapshot = null; });
  function sync() {
    if (!company.isAdmin() && [...host.querySelectorAll('dialog')].some(dialog => dialog.open)) { reset(); return; }
    if ($('channel-wecom-dialog').open && !valid(wecomSnapshot)) $('channel-wecom-dialog').close();
    $('group-manage-channels').hidden = !company.isAdmin(); $('group-manage-channels').disabled = !state.session || state.loading || state.running;
    if ($('group-channel-dialog').open && (!valid(groupSnapshot) || (groupTarget && state.session?.id !== groupTarget))) $('group-channel-dialog').close();
  }
  function reset() {
    resetting = true;
    stopLogin(); stopManager(); stopWecom(); groupRequest++; deleteRequest++; channels = []; channelViews.clear(); managerBusy = false; deleteBusy = false; groupBusy = false; groupTarget = null; groupSnapshot = null;
    for (const dialog of host.querySelectorAll('dialog')) if (dialog.open) dialog.close();
    $('channels-list').replaceChildren(); $('group-channel-options').replaceChildren(); $('channel-create-form').reset(); $('channel-create-submit').disabled = false; $('channel-verify-submit').disabled = false;
    $('channel-create-bot-id').value = ''; updateCreateType();
    $('channel-login-qr').removeAttribute('src'); $('channel-login-qr').hidden = true; $('channel-verify-code').value = ''; $('channel-verify-form').hidden = true;
    resetting = false;
  }
  updateCreateType();
  return { openManager, openCreate: () => openGroup(), sync, reset };
}
