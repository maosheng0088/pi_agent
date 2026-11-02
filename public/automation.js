// Administrator-only skill catalog and schedules. Every displayed item comes from the API.
export function createAutomationController({ $, api, state, icon, node, toast, company, selectSession, renderMarkdown, preserveDraft, updateControls }) {
  const template = `
    <div class="admin-page-heading"><div><span class="eyebrow">ADMINISTRATOR TOOLS</span><h1 id="automation-title">技能中心</h1><p id="automation-description">将可复用的处理方法保存为技能，在群聊中执行。</p></div><div class="automation-heading-actions"><button class="secondary-button" id="automation-refresh" type="button"><span data-icon="refresh"></span>刷新</button><button class="primary-button" id="automation-create" type="button"><span data-icon="plus"></span>新建技能</button></div></div>
    <div class="settings-error" id="automation-error" role="alert" tabindex="-1" hidden></div><div class="sr-only" id="automation-status" role="status"></div>
    <div id="skills-panel"><div class="admin-info"><span data-icon="book"></span><p>仅管理员可以管理和使用技能。技能以 SKILL.md 保存；执行结果会进入群聊，群成员可查看。</p></div><div class="skill-grid" id="skill-grid"></div><div class="automation-pagination" id="skills-pagination"></div></div>
    <div id="schedules-panel" hidden><div class="admin-info"><span data-icon="clock"></span><p>计划按北京时间执行，Pi Web 服务需保持运行。错过的计划合并补跑一次，每次新建只读群聊，最长运行 10 分钟；无外部消息推送。</p></div><div class="automation-tabs" role="tablist" aria-label="定时任务视图"><button id="tab-plans" role="tab" aria-selected="true" aria-controls="plans-panel" type="button">任务计划</button><button id="tab-runs" role="tab" aria-selected="false" aria-controls="runs-panel" type="button">运行记录</button><span>Asia/Shanghai · 北京时间</span></div><section id="plans-panel" role="tabpanel" aria-labelledby="tab-plans"><div id="schedule-list" class="schedule-list"></div><div id="plans-pagination" class="automation-pagination"></div></section><section id="runs-panel" role="tabpanel" aria-labelledby="tab-runs" hidden><div class="run-filter"><span id="run-filter-label">最近 100 条运行记录</span><button class="text-button" id="show-all-runs" type="button" hidden>查看全部任务记录</button></div><div id="task-run-list" class="task-run-list"></div><div id="runs-pagination" class="automation-pagination"></div><p class="automation-footnote">服务重启留下的运行会标为“已中断”，不会自动重复执行。历史结果可在对应群聊中查看。</p></section></div>
    <dialog class="automation-dialog" id="skill-editor" aria-labelledby="skill-editor-title"><form id="skill-editor-form"><div class="dialog-header"><div><span class="eyebrow">SKILL AUTHORING</span><h2 id="skill-editor-title">新建技能</h2><p>填写名称、说明与指令正文，无需编写 YAML 头。</p></div><button class="icon-button" type="button" data-automation-close="skill-editor" aria-label="关闭技能编辑器"><span data-icon="x"></span></button></div><div class="dialog-body"><div class="settings-error" id="skill-editor-error" role="alert" tabindex="-1" hidden></div><div class="form-field"><label for="skill-name">技能名称 / slug</label><input id="skill-name" required autocomplete="off" placeholder="例如 document-summary"><small>使用简洁的小写英文名称，方便在对话与任务中识别。</small></div><div class="form-field"><label for="skill-description">技能说明</label><textarea id="skill-description" rows="2" required placeholder="说明适用场景、处理目标与输出内容"></textarea></div><div class="form-field"><label for="skill-content">SKILL.md 指令正文</label><textarea class="code-editor" id="skill-content" rows="12" required spellcheck="false" placeholder="描述技能目标、输入资料、处理步骤和输出格式…"></textarea><small>名称和说明会由服务端写入技能元信息；这里仅填写 Markdown 正文。</small></div><label class="automation-checkbox"><input type="checkbox" id="skill-enabled"><span>启用此技能，允许在对话和任务中使用</span></label></div><div class="dialog-footer"><button class="secondary-button" type="button" data-automation-close="skill-editor">取消</button><button class="primary-button" type="submit" id="save-skill">导入 ZIP</button></div></form></dialog>
    <dialog class="automation-dialog" id="skill-detail" aria-labelledby="skill-detail-title"><div class="dialog-header"><div><span class="eyebrow">SKILL DETAILS</span><h2 id="skill-detail-title">技能详情</h2><p id="skill-detail-meta"></p></div><button class="icon-button" type="button" data-automation-close="skill-detail" aria-label="关闭技能详情"><span data-icon="x"></span></button></div><div class="dialog-body"><p class="skill-detail-description" id="skill-detail-description"></p><div class="message-text skill-detail-content" id="skill-detail-content"></div></div><div class="dialog-footer"><button class="secondary-button" type="button" id="edit-detail-skill">更新 ZIP</button><button class="primary-button" type="button" id="use-detail-skill">在群聊中使用<span data-icon="arrow-right"></span></button></div></dialog>
    <dialog class="automation-dialog schedule-editor" id="schedule-editor" aria-labelledby="schedule-editor-title"><form id="schedule-editor-form"><div class="dialog-header"><div><span class="eyebrow">SCHEDULE A TASK</span><h2 id="schedule-editor-title">新建定时任务</h2><p>任务使用公司模型与只读工具，结果发布到新的群聊。</p></div><button class="icon-button" type="button" data-automation-close="schedule-editor" aria-label="关闭任务编辑器"><span data-icon="x"></span></button></div><div class="dialog-body"><div class="settings-error" id="schedule-editor-error" role="alert" tabindex="-1" hidden></div><div class="form-field"><label for="schedule-name">任务名称</label><input id="schedule-name" required maxlength="120" autocomplete="off" placeholder="例如：每周资料梳理"></div><div class="form-field"><label for="schedule-skill">使用技能 <span class="field-optional">可选</span></label><select id="schedule-skill"><option value="">不使用技能 · 普通任务</option></select></div><div class="form-field"><label for="schedule-prompt">执行任务</label><textarea id="schedule-prompt" rows="4" required placeholder="明确资料范围、处理要求和输出格式"></textarea></div><div class="form-field"><label for="schedule-type">执行频率</label><select id="schedule-type"><option value="once">仅执行一次</option><option value="daily">每天</option><option value="weekly">每周</option><option value="interval">按分钟间隔</option></select></div><div class="form-field" id="schedule-once-field"><label for="schedule-run-at">执行时间 · 北京时间</label><input type="datetime-local" id="schedule-run-at" step="60"><small>按 Asia/Shanghai（UTC+08:00）解释，不受当前电脑时区影响。</small></div><div class="form-field" id="schedule-time-field" hidden><label for="schedule-time">执行时刻 · 北京时间</label><input type="time" id="schedule-time" step="60"></div><fieldset class="schedule-weekdays" id="schedule-weekdays-field" hidden><legend>每周执行日</legend><label><input type="checkbox" name="schedule-weekday" value="1"><span>周一</span></label><label><input type="checkbox" name="schedule-weekday" value="2"><span>周二</span></label><label><input type="checkbox" name="schedule-weekday" value="3"><span>周三</span></label><label><input type="checkbox" name="schedule-weekday" value="4"><span>周四</span></label><label><input type="checkbox" name="schedule-weekday" value="5"><span>周五</span></label><label><input type="checkbox" name="schedule-weekday" value="6"><span>周六</span></label><label><input type="checkbox" name="schedule-weekday" value="0"><span>周日</span></label></fieldset><div class="form-field" id="schedule-interval-field" hidden><label for="schedule-interval">间隔分钟数</label><input type="number" id="schedule-interval" min="1" step="1" inputmode="numeric" placeholder="至少 1 分钟"></div><label class="automation-checkbox"><input type="checkbox" id="schedule-enabled"><span>启用计划，保存后按设定时间执行</span></label><p class="automation-form-note">新任务默认停用。你可以保存后手动运行验证，再启用计划。</p></div><div class="dialog-footer"><button class="secondary-button" type="button" data-automation-close="schedule-editor">取消</button><button class="primary-button" type="submit" id="save-schedule">保存任务</button></div></form></dialog>
    <dialog class="automation-confirm" id="automation-confirm" aria-labelledby="automation-confirm-title"><form id="automation-confirm-form"><div class="dialog-header"><div><h2 id="automation-confirm-title">确认删除</h2><p id="automation-confirm-description"></p></div></div><div class="dialog-body"><div class="settings-error" id="automation-confirm-error" role="alert" tabindex="-1" hidden></div></div><div class="dialog-footer"><button class="secondary-button" type="button" data-automation-close="automation-confirm">取消</button><button class="primary-button danger-primary" id="automation-confirm-submit" type="submit">确认删除</button></div></form></dialog>`;
  // This template is a fixed local string; API data is rendered only through DOM text nodes.
  $('automation-view').innerHTML = template;
  $('skills-panel').querySelector('.admin-info p').textContent = '管理员管理技能及共享范围。启用后，授权群聊的成员可使用技能，群聊与定时任务遵循相同范围。';
  $('schedules-panel').querySelector('.admin-info p').textContent = '任务按北京时间执行，Pi Web 服务需保持运行。每次独立执行，最终结果自动投递到绑定业务群，并同步该群已绑定的微信／企业微信渠道。错过的计划合并补跑一次，最长运行 10 分钟。';
  $('schedule-editor').querySelector('.dialog-header p').textContent = '选择业务群、执行权限和计划；群成员只会看到最终结果。';
  $('schedule-name').closest('.form-field').insertAdjacentHTML('afterend', `
    <div class="form-field"><label for="schedule-target">绑定业务群</label><select id="schedule-target" required aria-describedby="schedule-target-hint"><option value="">请选择业务群</option></select><small id="schedule-target-hint">仅列出你已加入的业务群。结果自动同步该群已绑定的消息渠道。</small></div>
    <div class="form-field"><label for="schedule-execution-mode">技能执行权限</label><select id="schedule-execution-mode" aria-describedby="schedule-mode-hint"><option value="read-only">文件只读 · 读取与分析</option><option value="workspace">执行技能与命令</option></select><small id="schedule-mode-hint"></small></div>`);
  $('schedule-name').closest('.form-field').insertAdjacentHTML('beforebegin', '<div class="form-field"><label for="schedule-task-kind">任务类型</label><select id="schedule-task-kind" aria-describedby="schedule-kind-hint"><option value="agent">AI 任务</option><option value="business">业务项目</option></select><small id="schedule-kind-hint">AI 任务使用模型处理资料；业务项目直接执行已接入的项目。</small></div>');
  $('schedule-skill').closest('.form-field').insertAdjacentHTML('beforebegin', '<div class="form-field" id="schedule-business-field" hidden><label for="schedule-business-task">业务项目</label><select id="schedule-business-task" aria-describedby="schedule-business-hint"><option value="">请选择业务项目</option></select><small id="schedule-business-hint"></small></div><p class="schedule-binding-note" id="schedule-business-note" hidden>直接执行现有项目，不调用模型。每天最多执行一次，失败不会自动重跑；执行日志仅管理员可见。</p>');
  $('schedule-type').closest('.form-field').insertAdjacentHTML('afterend', '<div class="form-field" id="schedule-start-date-field" hidden><label for="schedule-start-date">首次计划日期 · 北京时间</label><input type="date" id="schedule-start-date"><small>从此日期起按设定时刻运行。手动运行仍会立即提交。</small></div>');
  $('automation-view').insertAdjacentHTML('beforeend', '<dialog class="automation-dialog business-log-dialog" id="business-run-log" aria-labelledby="business-run-log-title"><div class="dialog-header"><div><span class="eyebrow">BUSINESS TASK LOG</span><h2 id="business-run-log-title">业务执行日志</h2><p id="business-run-log-meta">仅管理员可查看，日志不会发送到业务群。</p></div><button class="icon-button" type="button" data-automation-close="business-run-log" aria-label="关闭业务执行日志"><span data-icon="x"></span></button></div><div class="dialog-body"><div class="settings-error" id="business-run-log-error" role="alert" tabindex="-1" hidden></div><pre id="business-run-log-content" class="business-run-log-content" tabindex="0"></pre><p id="business-run-log-note" class="automation-form-note" role="status"></p></div><div class="dialog-footer"><button class="secondary-button" type="button" id="business-run-log-refresh">刷新日志</button><button class="primary-button" type="button" data-automation-close="business-run-log">关闭</button></div></dialog>');
  $('schedules-panel').querySelector('.admin-info p').textContent = '任务按北京时间执行，Pi Web 服务需保持运行。AI 任务独立处理，业务项目直接运行现有代码；最终结果投递到绑定业务群及其消息渠道。业务项目每天最多执行一次，失败不会自动重跑。';
  $('runs-panel').querySelector('.automation-footnote').textContent = '执行状态与结果投递状态分别记录。补发只重试已有结果，不会重新执行任务。服务重启留下的执行标为“已中断”，不会自动重跑。';
  $('skill-editor').querySelector('.dialog-header p').textContent = '上传完整技能 ZIP，自动读取 SKILL.md 中的名称、说明和正文。';
  for (const id of ['skill-name', 'skill-description', 'skill-content']) { $(id).required = false; $(id).closest('.form-field').hidden = true; }
  $('skill-editor-error').insertAdjacentHTML('afterend', '<div class="form-field"><label for="skill-zip">技能 ZIP 文件</label><input id="skill-zip" type="file" accept=".zip,application/zip" required><small>最大 10 MB，包含一个 SKILL.md；可附带 scripts、references、assets 等配套文件。每次上传一个技能。</small><p id="skill-zip-info" role="status"></p></div>');
  const scopeFields = (prefix) => `<div class="form-field skill-sharing-field"><label for="${prefix}-scope">共享范围</label><select id="${prefix}-scope" aria-describedby="${prefix}-hint"><option value="all">全部群聊共享</option><option value="groups">仅指定群聊</option></select><small id="${prefix}-hint">全部群聊包含现在及今后创建的业务群；仍需加入群聊才能使用。</small></div><div class="skill-sharing-groups" id="${prefix}-groups" hidden><div class="form-field"><label for="${prefix}-search">选择业务群</label><input id="${prefix}-search" type="search" autocomplete="off" placeholder="搜索你已加入的群聊" aria-controls="${prefix}-list"></div><p class="skill-sharing-count" id="${prefix}-count" role="status"></p><div class="skill-sharing-list" id="${prefix}-list"></div><small class="skill-sharing-note">仅列出你已加入的业务群。历史授权中不可访问的群聊会隐藏名称，可保留或取消授权。</small></div>`;
  $('skill-enabled').closest('.automation-checkbox').insertAdjacentHTML('beforebegin', scopeFields('skill-import'));
  $('automation-view').insertAdjacentHTML('beforeend', `<dialog class="automation-dialog skill-sharing-dialog" id="skill-sharing" aria-labelledby="skill-sharing-title"><form id="skill-sharing-form"><div class="dialog-header"><div><span class="eyebrow">SKILL SHARING</span><h2 id="skill-sharing-title">设置共享范围</h2><p id="skill-sharing-description">调整技能可用的业务群，无需重新上传 ZIP。</p></div><button class="icon-button" type="button" data-automation-close="skill-sharing" aria-label="关闭共享范围设置"><span data-icon="x"></span></button></div><div class="dialog-body"><div class="settings-error" id="skill-sharing-error" role="alert" tabindex="-1" hidden></div>${scopeFields('skill-sharing')}</div><div class="dialog-footer"><button class="secondary-button" type="button" data-automation-close="skill-sharing">取消</button><button class="primary-button" type="submit" id="save-skill-sharing">保存范围</button></div></form></dialog><dialog class="automation-dialog skill-sharing-dialog" id="skill-use" aria-labelledby="skill-use-title"><form id="skill-use-form"><div class="dialog-header"><div><h2 id="skill-use-title">选择使用技能的群聊</h2><p>仅列出你已加入且获授权的业务群。</p></div><button class="icon-button" type="button" data-automation-close="skill-use" aria-label="关闭群聊选择"><span data-icon="x"></span></button></div><div class="dialog-body"><div class="settings-error" id="skill-use-error" role="alert" tabindex="-1" hidden></div><div class="form-field"><label for="skill-use-target">业务群</label><select id="skill-use-target" required></select><small id="skill-use-hint"></small></div></div><div class="dialog-footer"><button class="secondary-button" type="button" data-automation-close="skill-use">取消</button><button class="primary-button" type="submit" id="skill-use-submit">进入群聊并选择技能</button></div></form></dialog>`);
  $('skill-detail-description').insertAdjacentHTML('beforebegin', '<p class="skill-detail-sharing" id="skill-detail-sharing"></p>');
  $('schedule-skill').setAttribute('aria-describedby', 'schedule-skill-hint');
  $('schedule-skill').insertAdjacentHTML('afterend', '<small id="schedule-skill-hint">只显示当前业务群可用的技能。</small>');
  $('skill-zip').addEventListener('change', () => { const file = $('skill-zip').files[0]; $('skill-zip-info').textContent = file ? `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB` : ''; error('skill-editor-error', file && file.size > 10 * 1024 * 1024 ? 'ZIP 文件不能超过 10 MB。' : ''); });
    $('automation-view').querySelectorAll('[data-icon]').forEach((el) => el.replaceWith(icon(el.dataset.icon)));
  $('skill-name').minLength = 1; $('skill-name').maxLength = 64; $('skill-name').pattern = '[a-z0-9]+(-[a-z0-9]+)*';
  $('skill-description').maxLength = 1024; $('skill-content').maxLength = 60000;
  let skills = [], schedules = [], runs = [], groups = [], businessTasks = [], editingSkill = null, detailSkill = null, editingSchedule = null, sharingSkill = null, usingSkill = null;
  let skillPage = 0, planPage = 0, runPage = 0, tab = 'plans', runFilter = null;
  let skillsRequest = 0, schedulesRequest = 0, runsRequest = 0, groupsRequest = 0, detailRequest = 0, nextRefresh = 0;
  let tickBusy = false, confirmAction = null, lastSkillsLoad = 0;
  let skillEditorRevision = 0, scheduleEditorRevision = 0;
  let confirmRevision = 0, sharingRevision = 0, useRevision = 0, composerSessionId = null;
  let businessTasksRequest = 0, logRevision = 0, logRun = null, agentScheduleType = 'once', agentExecutionMode = 'read-only';
  const scopeSelections = new Map();
  const PAGE_SIZE = 10;
  const labels = { queued: '排队中', running: '运行中', succeeded: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断', skipped: '已跳过' };
  const capture = () => ({ id: state.user?.id, epoch: state.identityEpoch });
  const valid = (snapshot) => company.isAdmin() && state.user?.id === snapshot.id && state.identityEpoch === snapshot.epoch;
  const error = (id, message = '', focus = true) => { $(id).textContent = message; $(id).hidden = !message; if (message && focus) $(id).focus(); };
  const say = (message) => { $('automation-status').textContent = message; toast(message); };
  const busy = (button, on, text) => { button.disabled = on; if (text) button.textContent = text; };
  const date = (value, fallback = '尚未执行') => { if (!value) return fallback; const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? fallback : parsed.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }); };
  const localDate = (value) => { if (!value) return ''; const parsed = new Date(value); if (Number.isNaN(parsed.getTime())) return ''; return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(parsed).replace(' ', 'T'); };
  const badge = (status) => node('span', `automation-badge ${status || 'idle'}`, labels[status] || status || '未运行');
  const groupName = (item) => item.targetSessionName || groups.find((group) => group.id === item.targetSessionId)?.title || (item.targetSessionId ? '业务群暂不可用' : '未绑定业务群');
  const modeName = (mode) => mode === 'workspace' ? '执行技能与命令' : '文件只读';
  const businessName = (item) => businessTasks.find((task) => task.id === item.businessTaskId)?.name || item.businessTaskId || '业务项目';
  const skillAvailable = (skill, groupId) => !!groupId && !!skill?.enabled && (skill.scope !== 'groups' || skill.groupIds?.includes(groupId));
  const scopeName = (skill) => skill.scope === 'groups' ? `已指定 ${skill.groupIds?.length || 0} 个群聊` : '全部群聊共享';
  function action(text, callback, className = 'secondary-button') { const button = node('button', className, text); button.type = 'button'; button.addEventListener('click', async () => { const snapshot = capture(); try { await callback(button); } catch (failure) { if (valid(snapshot)) error('automation-error', failure.message); } }); return button; }
  function page(items, index) { return items.slice(index * PAGE_SIZE, (index + 1) * PAGE_SIZE); }
  function paginate(id, items, index, change) {
    const count = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
    $(id).replaceChildren(); if (count <= 1) return;
    const previous = action('上一页', () => change(index - 1)); previous.disabled = index === 0;
    const next = action('下一页', () => change(index + 1)); next.disabled = index >= count - 1;
    $(id).append(node('span', '', `第 ${index + 1} / ${count} 页 · 共 ${items.length} 项`), previous, next);
  }
  function refreshComposer() {
    composerSessionId = state.session?.id || null;
    const selected = $('chat-skill').value;
    const empty = node('option', '', '不使用技能'); empty.value = '';
    $('chat-skill').replaceChildren(empty, ...skills.filter((skill) => skillAvailable(skill, state.session?.id)).map((skill) => { const option = node('option', '', skill.name); option.value = skill.id; option.title = skill.description; return option; }));
    if (skills.some((skill) => skill.id === selected && skillAvailable(skill, state.session?.id))) $('chat-skill').value = selected;
    $('composer-skill').hidden = !company.isAdmin();
    $('chat-skill').disabled = !company.isAdmin();
  }
  async function loadSkills({ silent = false } = {}) {
    if (!company.isAdmin()) return [];
    const snapshot = capture(), request = ++skillsRequest;
    if (!silent && company.view === 'skills') $('skill-grid').replaceChildren(node('p', 'admin-empty', '正在加载技能目录…'));
    const data = await api('/api/skills'); if (!valid(snapshot) || request !== skillsRequest) return null;
    skills = data.skills || []; lastSkillsLoad = Date.now(); refreshComposer();
    if ($('schedule-editor').open) updateScheduleSkills();
    if (company.view === 'skills') renderSkills(); return skills;
  }
  function renderSkills() {
    skillPage = Math.min(skillPage, Math.max(0, Math.ceil(skills.length / PAGE_SIZE) - 1));
    $('skill-grid').replaceChildren(...page(skills, skillPage).map((skill) => {
      const card = node('article', 'skill-card'); const head = node('div', 'skill-card-heading');
      const emblem = node('span', 'skill-card-icon'); emblem.append(icon('book'));
      const title = node('div'); title.append(node('h2', '', skill.name), node('span', '', `版本 ${skill.version ?? 1} · ${date(skill.updatedAt, '时间未记录')}`));
      head.append(emblem, title, node('span', `automation-badge ${skill.enabled ? 'enabled' : 'disabled'}`, skill.enabled ? '已启用' : '已停用'));
      const description = node('p', 'skill-card-description', skill.description || '暂无说明'); const actions = node('div', 'automation-row-actions');
      actions.append(action('查看详情', () => openSkill(skill.id)), action('共享范围', () => editSharing(skill.id)), action('更新 ZIP', () => editSkill(skill.id)), action(skill.enabled ? '停用' : '启用', (button) => mutateSkill(skill, { enabled: !skill.enabled }, button)), action('删除', () => confirmDelete('skill', skill), 'secondary-button danger-button'));
      card.append(head, node('span', 'automation-badge skill-scope-badge', scopeName(skill)), description, actions); return card;
    }));
    if (!skills.length) $('skill-grid').append(node('p', 'admin-empty', '还没有技能。导入包含 SKILL.md 的 ZIP 技能包开始使用。'));
    paginate('skills-pagination', skills, skillPage, (value) => { skillPage = value; renderSkills(); });
  }
  async function openSkill(id) {
    if (!company.isAdmin()) return; const snapshot = capture(), request = ++detailRequest; error('automation-error');
    try {
      const [data] = await Promise.all([api(`/api/skills/${encodeURIComponent(id)}`), loadGroups()]); if (!valid(snapshot) || request !== detailRequest || company.view !== 'skills') return;
      detailSkill = data.skill; $('skill-detail-title').textContent = detailSkill.name;
      $('skill-detail-meta').textContent = `版本 ${detailSkill.version ?? 1} · ${detailSkill.enabled ? '已启用' : '已停用'} · ${date(detailSkill.updatedAt, '时间未记录')}`;
      $('skill-detail-description').textContent = detailSkill.description || ''; renderMarkdown($('skill-detail-content'), detailSkill.content || '');
      $('skill-detail-sharing').textContent = detailSkill.scope === 'groups'
        ? `共享范围：${(detailSkill.groupIds || []).map((groupId) => groups.find((group) => group.id === groupId)?.title || '已授权群聊（目前不可访问）').join('、') || '尚未选择群聊'}`
        : '共享范围：全部群聊，包含今后新建的业务群。';
      if (detailSkill.files?.length) { const files = node('details', 'run-error'); files.append(node('summary', '', `配套文件 · ${detailSkill.files.length} 个`), node('pre', '', detailSkill.files.map(file => `${file.path} · ${file.size} 字节`).join('\n'))); $('skill-detail-content').append(files); }
      $('use-detail-skill').disabled = !detailSkill.enabled; $('use-detail-skill').title = detailSkill.enabled ? '选择技能并返回群聊' : '请先启用此技能'; $('skill-detail').showModal();
    } catch (failure) { if (valid(snapshot)) error('automation-error', failure.message); }
  }
  async function editSkill(id = null) {
    if (!company.isAdmin()) return; const snapshot = capture(), request = ++detailRequest; error('automation-error');
    let skill = null;
    try { const [result] = await Promise.all([id ? api(`/api/skills/${encodeURIComponent(id)}`) : Promise.resolve(null), loadGroups()]); if (!valid(snapshot) || request !== detailRequest || company.view !== 'skills') return; skill = result?.skill || null; }
    catch (failure) { if (valid(snapshot)) error('automation-error', failure.message); return; }
    if (company.view !== 'skills') return; skillEditorRevision++; editingSkill = skill; $('skill-editor-form').reset(); busy($('save-skill'), false, '导入 ZIP'); error('skill-editor-error');
    $('skill-editor-title').textContent = skill ? '上传 ZIP 更新技能' : '导入技能 ZIP'; $('skill-zip-info').textContent = skill ? `当前技能：${skill.name} · 版本 ${skill.version}。新包将替换整个技能包，正在运行的任务保留旧版本。` : ''; $('skill-enabled').checked = false;
    setupScope('skill-import', skill);
    if ($('skill-detail').open) $('skill-detail').close(); $('skill-editor').showModal();
  }
  async function saveSkill(event) {
    event.preventDefault(); if (!company.isAdmin() || !$('skill-editor-form').reportValidity()) return;
    const snapshot = capture(), skillId = editingSkill?.id, revision = skillEditorRevision;
    const file = $('skill-zip').files[0];
    if (!file || !/\.zip$/i.test(file.name) || file.size > 10 * 1024 * 1024) { error('skill-editor-error', '请选择不超过 10 MB 的 ZIP 文件。'); return; }
    const enabled = $('skill-enabled').checked, sharing = scopeValue('skill-import', 'skill-editor-error');
    if (!sharing) return;
    busy($('save-skill'), true, '保存中…'); error('skill-editor-error');
    try {
      const bytes = new Uint8Array(await file.arrayBuffer()); let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
      if (!valid(snapshot) || revision !== skillEditorRevision) return;
      const result = await api(`/api/admin/skills/import${skillId ? `/${encodeURIComponent(skillId)}` : ''}`, { method: 'POST', body: { zipBase64: btoa(binary), enabled, ...sharing } });
      if (!valid(snapshot)) return; const showPreview = revision === skillEditorRevision && $('skill-editor').open;
      if (showPreview) $('skill-editor').close(); await loadSkills({ silent: true });
      if (valid(snapshot)) { say('ZIP 已导入，可查看正文与配套文件。'); if (showPreview && company.view === 'skills') await openSkill(result.skill.id); }
    }
    catch (failure) { if (valid(snapshot)) { if (revision === skillEditorRevision && $('skill-editor').open) error('skill-editor-error', failure.message); else toast(failure.message); } }
    finally { if (valid(snapshot) && revision === skillEditorRevision) busy($('save-skill'), false, '导入 ZIP'); }
  }
  function setupScope(prefix, skill) {
    scopeSelections.set(prefix, new Set(skill?.groupIds || []));
    $(`${prefix}-scope`).value = skill?.scope === 'groups' ? 'groups' : 'all';
    $(`${prefix}-search`).value = ''; renderScopeGroups(prefix);
  }
  function renderScopeGroups(prefix) {
    const selected = scopeSelections.get(prefix) || new Set();
    const scoped = $(`${prefix}-scope`).value === 'groups';
    $(`${prefix}-groups`).hidden = !scoped;
    $(`${prefix}-hint`).textContent = scoped ? '只有选中群聊的成员，才能在该群及其定时任务中使用此技能。' : '全部群聊包含现在及今后创建的业务群；仍需加入群聊才能使用。';
    const query = $(`${prefix}-search`).value.trim().toLocaleLowerCase();
    const choices = groups.map((group) => ({ id: group.id, name: group.title || '未命名群聊', accessible: true }));
    for (const id of selected) if (!groups.some((group) => group.id === id)) choices.push({ id, name: '已授权群聊（目前不可访问）', accessible: false });
    const visible = choices.filter((choice) => !query || choice.name.toLocaleLowerCase().includes(query));
    const list = $(`${prefix}-list`); list.replaceChildren();
    for (const choice of visible) {
      const label = node('label', `skill-sharing-choice${choice.accessible ? '' : ' unavailable'}`);
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = selected.has(choice.id);
      const text = node('span', ''); text.append(node('strong', '', choice.name));
      if (!choice.accessible) text.append(node('small', '', '保留的历史授权；取消勾选可移除。'));
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selected.add(choice.id); else selected.delete(choice.id);
        scopeSelections.set(prefix, selected); updateScopeCount(prefix);
      });
      label.append(checkbox, text); list.append(label);
    }
    if (!visible.length) list.append(node('p', 'skill-sharing-empty', query ? '未找到匹配的群聊。可以修改搜索条件。' : '你还没有可选的业务群。请先创建或加入群聊，或选择全部群聊共享。'));
    updateScopeCount(prefix);
  }
  function updateScopeCount(prefix) { $(`${prefix}-count`).textContent = `已选择 ${scopeSelections.get(prefix)?.size || 0} 个群聊`; }
  function scopeValue(prefix, errorId) {
    const scope = $(`${prefix}-scope`).value, groupIds = scope === 'groups' ? [...(scopeSelections.get(prefix) || [])] : [];
    if (scope === 'groups' && !groupIds.length) { error(errorId, '请至少选择一个共享群聊。'); $(`${prefix}-search`).focus(); return null; }
    return { scope, groupIds };
  }
  async function editSharing(id) {
    if (!company.isAdmin()) return;
    const snapshot = capture(), revision = ++sharingRevision; error('automation-error');
    try {
      const [result] = await Promise.all([api(`/api/skills/${encodeURIComponent(id)}`), loadGroups()]);
      if (!valid(snapshot) || revision !== sharingRevision || company.view !== 'skills') return;
      sharingSkill = result.skill; $('skill-sharing-form').reset(); setupScope('skill-sharing', sharingSkill);
      $('skill-sharing-title').textContent = '设置共享范围'; $('skill-sharing-description').textContent = `技能：${sharingSkill.name}。修改后，群聊与定时任务按新的范围使用。`;
      error('skill-sharing-error'); busy($('save-skill-sharing'), false, '保存范围'); $('skill-sharing').showModal();
    } catch (failure) { if (valid(snapshot)) error('automation-error', failure.message); }
  }
  async function saveSharing(event) {
    event.preventDefault(); if (!company.isAdmin() || !sharingSkill) return;
    const body = scopeValue('skill-sharing', 'skill-sharing-error'); if (!body) return;
    const snapshot = capture(), revision = sharingRevision, id = sharingSkill.id;
    busy($('save-skill-sharing'), true, '保存中…'); error('skill-sharing-error');
    try {
      await api(`/api/admin/skills/${encodeURIComponent(id)}`, { method: 'PATCH', body });
      if (!valid(snapshot)) return;
      if (revision === sharingRevision && $('skill-sharing').open) $('skill-sharing').close();
      await loadSkills({ silent: true }); if (valid(snapshot)) say('技能共享范围已更新。');
    } catch (failure) { if (valid(snapshot)) { if (revision === sharingRevision && $('skill-sharing').open) error('skill-sharing-error', failure.message); else toast(failure.message); } }
    finally { if (valid(snapshot) && revision === sharingRevision) busy($('save-skill-sharing'), false, '保存范围'); }
  }
  async function mutateSkill(skill, body, button) {
    const snapshot = capture(); button.disabled = true; error('automation-error');
    try { await api(`/api/admin/skills/${encodeURIComponent(skill.id)}`, { method: 'PATCH', body }); if (valid(snapshot)) { await loadSkills({ silent: true }); if (valid(snapshot)) say(body.enabled ? '技能已启用。' : '技能已停用。'); } }
    catch (failure) { if (valid(snapshot)) error('automation-error', failure.message); }
    finally { button.disabled = false; }
  }
  function recurrence(schedule) {
    if (schedule.scheduleType === 'once') return `一次 · ${date(schedule.runAt, '未设置时间')}`;
    if (schedule.scheduleType === 'daily') return `每天 ${schedule.time || ''}`;
    if (schedule.scheduleType === 'weekly') { const weekdays = ['日', '一', '二', '三', '四', '五', '六']; return `每周${(schedule.weekdays || []).map((day) => weekdays[day]).join('、')} ${schedule.time || ''}`; }
    return `每隔 ${schedule.intervalMinutes} 分钟`;
  }
  async function loadSchedules({ silent = false } = {}) {
    if (!company.isAdmin()) return;
    const snapshot = capture(), request = ++schedulesRequest;
    if (!silent) $('schedule-list').replaceChildren(node('p', 'admin-empty', '正在加载任务计划…'));
    const result = await api('/api/admin/schedules'); if (!valid(snapshot) || request !== schedulesRequest) return;
    const changed = JSON.stringify(schedules) !== JSON.stringify(result.schedules || []); schedules = result.schedules || [];
    if (changed || !silent) renderSchedules();
  }
  async function loadGroups() {
    if (!company.isAdmin()) return;
    const snapshot = capture(), request = ++groupsRequest, result = [];
    let offset = 0, total = 0;
    do {
      const data = await api(`/api/sessions?limit=200&offset=${offset}`);
      if (!valid(snapshot) || request !== groupsRequest) return;
      const items = data.sessions || [];
      result.push(...items.filter((group) => !group.taskWorker));
      offset += items.length; total = Number(data.total) || 0;
      if (!items.length) break;
    } while (offset < total);
    groups = result;
  }
  async function loadBusinessTasks() {
    if (!company.isAdmin()) return;
    const snapshot = capture(), request = ++businessTasksRequest;
    const result = await api('/api/admin/business-tasks');
    if (!valid(snapshot) || request !== businessTasksRequest) return;
    businessTasks = result.tasks || [];
  }
  function renderSchedules() {
    planPage = Math.min(planPage, Math.max(0, Math.ceil(schedules.length / PAGE_SIZE) - 1));
    $('schedule-list').replaceChildren(...page(schedules, planPage).map((schedule) => {
      const row = node('article', 'schedule-card'); const heading = node('div', 'schedule-card-heading'); const title = node('div'); title.append(node('h2', '', schedule.name), node('span', '', recurrence(schedule)));
      heading.append(title, node('span', `automation-badge ${schedule.enabled ? 'enabled' : 'disabled'}`, schedule.enabled ? '计划已启用' : '计划已停用'));
      const prompt = node('p', 'schedule-prompt', schedule.prompt); const meta = node('div', 'schedule-meta');
      const skill = skills.find((item) => item.id === schedule.skillId);
      meta.append(node('span', '', `业务群：${groupName(schedule)}`));
      if (schedule.taskType === 'business') {
        const project = businessTasks.find((item) => item.id === schedule.businessTaskId);
        meta.append(node('span', '', `业务项目：${businessName(schedule)}`), node('span', '', `来源：${project?.source || 'RPAC'}${project?.projectVersion ? ` · ${project.projectVersion}` : ''}`));
        if (project?.timeoutSeconds) meta.append(node('span', '', `超时：${Math.ceil(project.timeoutSeconds / 60)} 分钟`));
        if (schedule.startDate) meta.append(node('span', '', `起始日期：${schedule.startDate}`));
      } else meta.append(node('span', '', `权限：${modeName(schedule.executionMode)}`), node('span', '', schedule.skillId ? `技能：${skill?.name || '技能不可用'}${skill && !skill.enabled ? '（已停用）' : ''}` : 'AI 任务'));
      meta.append(node('span', '', `下次：${date(schedule.nextRunAt, !schedule.enabled ? '未启用' : schedule.scheduleType === 'once' && schedule.lastRunAt ? '无后续计划' : '暂无下次时间')}`));
      const last = node('div', 'schedule-last'); last.append(node('span', '', `上次：${date(schedule.lastRunAt)}`)); if (schedule.lastStatus) last.append(badge(schedule.lastStatus));
      const actions = node('div', 'automation-row-actions');
      const runButton = action('立即运行', (button) => runNow(schedule, button));
      if (schedule.taskType === 'business') runButton.title = '立即提交；今天已执行过的项目会跳过，不会重复运行';
      const toggleButton = action(schedule.enabled ? '停用计划' : '启用计划', (button) => mutateSchedule(schedule, { enabled: !schedule.enabled }, button));
      if (!schedule.targetSessionId) { runButton.disabled = true; runButton.title = '请先编辑任务并绑定业务群'; if (!schedule.enabled) { toggleButton.disabled = true; toggleButton.title = '请先编辑任务并绑定业务群'; } }
      actions.append(runButton, action('运行记录', () => showRuns(schedule)), action('编辑', () => editSchedule(schedule)), toggleButton, action('删除', () => confirmDelete('schedule', schedule), 'secondary-button danger-button'));
      row.append(heading, prompt, meta);
      if (!schedule.targetSessionId) row.append(node('p', 'schedule-binding-note', '请先编辑任务并绑定业务群，之后才能运行或启用计划。'));
      row.append(last, actions); return row;
    }));
    if (!schedules.length) $('schedule-list').append(node('p', 'admin-empty', '还没有定时任务。新建计划，绑定业务群并选择执行权限，再决定何时启用。'));
    paginate('plans-pagination', schedules, planPage, (value) => { planPage = value; renderSchedules(); });
  }
  function updateScheduleFields() {
    const type = $('schedule-type').value;
    for (const [id, show] of [['schedule-once-field', type === 'once'], ['schedule-time-field', type === 'daily' || type === 'weekly'], ['schedule-weekdays-field', type === 'weekly'], ['schedule-interval-field', type === 'interval']]) $(id).hidden = !show;
    $('schedule-run-at').required = type === 'once'; $('schedule-time').required = type === 'daily' || type === 'weekly'; $('schedule-interval').required = type === 'interval';
  }
  function updateBusinessTaskHint() {
    const task = businessTasks.find((item) => item.id === $('schedule-business-task').value);
    $('schedule-business-hint').textContent = task
      ? `${task.source || 'RPAC'}${task.projectVersion ? ` · ${task.projectVersion}` : ''}${task.timeoutSeconds ? ` · 最长 ${Math.ceil(task.timeoutSeconds / 60)} 分钟` : ''}${task.ready === false ? ' · 项目暂不可用，请检查运行环境' : ''}`
      : businessTasks.length ? '选择已接入的业务项目。执行入口和运行环境由服务端管理。' : '暂无已接入的业务项目，请检查服务端配置。';
    $('schedule-business-task').setCustomValidity(task?.ready === false ? '此项目暂不可用，请检查运行环境。' : '');
  }
  function updateTaskKind({ changed = false } = {}) {
    const business = $('schedule-task-kind').value === 'business';
    if (changed && business) { agentScheduleType = $('schedule-type').value; agentExecutionMode = $('schedule-execution-mode').value; }
    $('schedule-business-field').hidden = !business; $('schedule-business-note').hidden = !business;
    $('schedule-start-date-field').hidden = !business;
    $('schedule-business-task').required = business; $('schedule-business-task').disabled = !business;
    $('schedule-start-date').disabled = !business;
    for (const id of ['schedule-skill', 'schedule-prompt', 'schedule-execution-mode']) { $(id).closest('.form-field').hidden = business; $(id).disabled = business; }
    $('schedule-prompt').required = !business; $('schedule-type').disabled = business;
    if (business) { $('schedule-type').value = 'daily'; $('schedule-execution-mode').value = 'workspace'; $('schedule-skill').setCustomValidity(''); }
    else if (changed) { $('schedule-type').value = agentScheduleType; $('schedule-execution-mode').value = agentExecutionMode; }
    $('schedule-editor').querySelector('.dialog-header p').textContent = business ? '直接运行已接入的业务项目，按北京时间执行并将结果发送到业务群。' : '选择业务群、执行权限和计划；群成员只会看到最终结果。';
    $('schedule-editor').querySelector('.automation-form-note').textContent = business ? '新任务默认停用。启用前请确认首次计划日期与执行时刻；手动运行也计入当天一次的执行限制。' : '新任务默认停用。你可以保存后手动运行验证，再启用计划。';
    updateScheduleFields(); updateExecutionModeHint(); updateBusinessTaskHint();
  }
  function updateExecutionModeHint() {
    $('schedule-mode-hint').textContent = $('schedule-execution-mode').value === 'workspace'
      ? '允许技能脚本、系统命令、文件修改和网络访问。需要调用飞书等业务接口时选择此项。'
      : '只读取文件并分析，不运行技能脚本、系统命令或网络请求。';
  }
  function validateScheduleSkill() {
    if ($('schedule-task-kind').value === 'business') { $('schedule-skill').setCustomValidity(''); return true; }
    const selected = $('schedule-skill').value, groupId = $('schedule-target').value;
    const unavailable = !!selected && !skills.some((skill) => skill.id === selected && skillAvailable(skill, groupId));
    $('schedule-skill').setCustomValidity(unavailable ? '当前业务群不可使用此技能，请更换业务群或技能。' : '');
    $('schedule-skill-hint').textContent = unavailable ? '所选技能在当前群不可用，请更换业务群或技能后保存。' : groupId ? '只显示此业务群已授权并启用的技能。' : '请先选择业务群，再选择可用技能。';
    $('schedule-skill-hint').classList.toggle('skill-availability-error', unavailable);
    return !unavailable;
  }
  function updateScheduleSkills(requested = $('schedule-skill').value) {
    const groupId = $('schedule-target').value;
    const empty = node('option', '', '不使用技能 · 普通任务'); empty.value = '';
    const available = skills.filter((skill) => skillAvailable(skill, groupId));
    const options = available.map((skill) => { const option = node('option', '', skill.name); option.value = skill.id; return option; });
    if (requested && !available.some((skill) => skill.id === requested)) {
      const skill = skills.find((item) => item.id === requested);
      const unavailable = node('option', '', `${skill?.name || '原选技能'} · 当前群不可用`); unavailable.value = requested; options.push(unavailable);
    }
    $('schedule-skill').replaceChildren(empty, ...options); $('schedule-skill').value = requested || ''; validateScheduleSkill();
  }
  async function editSchedule(schedule = null) {
    if (!company.isAdmin()) return; const snapshot = capture(), revision = ++scheduleEditorRevision;
    try { await Promise.all([loadSkills({ silent: true }), loadGroups(), loadBusinessTasks()]); } catch (failure) { if (valid(snapshot)) error('automation-error', failure.message); return; }
    if (!valid(snapshot) || revision !== scheduleEditorRevision || company.view !== 'schedules') return; editingSchedule = schedule; $('schedule-editor-form').reset(); busy($('save-schedule'), false, '保存任务'); error('schedule-editor-error');
    $('schedule-editor-title').textContent = schedule ? '编辑定时任务' : '新建定时任务'; $('schedule-name').value = schedule?.name || ''; $('schedule-prompt').value = schedule?.prompt || ''; $('schedule-type').value = schedule?.scheduleType || 'once';
    $('schedule-run-at').value = localDate(schedule?.runAt); $('schedule-time').value = schedule?.time || ''; $('schedule-interval').value = schedule?.intervalMinutes || ''; $('schedule-enabled').checked = !!schedule?.enabled;
    $('schedule-task-kind').value = schedule?.taskType === 'business' ? 'business' : 'agent'; $('schedule-task-kind').disabled = !!schedule;
    $('schedule-kind-hint').textContent = schedule ? '已保存任务的类型保持不变；需要其他类型时请新建任务。' : 'AI 任务使用模型处理资料；业务项目直接执行已接入的项目。';
    const emptyProject = node('option', '', businessTasks.length ? '请选择业务项目' : '暂无业务项目'); emptyProject.value = '';
    const projects = businessTasks.map((task) => { const option = node('option', '', `${task.name || task.id}${task.ready === false ? ' · 暂不可用' : ''}`); option.value = task.id; return option; });
    if (schedule?.businessTaskId && !businessTasks.some((task) => task.id === schedule.businessTaskId)) { const missing = node('option', '', `${schedule.businessTaskId} · 项目不可用`); missing.value = schedule.businessTaskId; projects.push(missing); }
    $('schedule-business-task').replaceChildren(emptyProject, ...projects); $('schedule-business-task').value = schedule?.businessTaskId || ''; $('schedule-start-date').value = schedule?.startDate || '';
    const target = node('option', '', groups.length ? '请选择业务群' : '暂无业务群，请先创建群聊'); target.value = '';
    $('schedule-target').replaceChildren(target, ...groups.map((group) => { const option = node('option', '', group.title || '未命名群聊'); option.value = group.id; return option; }));
    const hasTarget = groups.some((group) => group.id === schedule?.targetSessionId);
    $('schedule-target').value = hasTarget ? schedule.targetSessionId : '';
    $('schedule-target-hint').textContent = !groups.length ? '你还没有可用的业务群。请先创建或加入群聊，再回来配置任务。' : schedule && !hasTarget ? '此任务需要重新绑定你已加入的业务群，保存后才能执行和投递。' : '仅列出你已加入的业务群。结果自动同步该群已绑定的消息渠道。';
    $('schedule-execution-mode').value = schedule?.executionMode === 'workspace' ? 'workspace' : 'read-only'; updateExecutionModeHint();
    document.querySelectorAll('input[name="schedule-weekday"]').forEach((input) => { input.checked = !!schedule?.weekdays?.includes(Number(input.value)); });
    updateScheduleSkills(schedule?.skillId || ''); agentScheduleType = $('schedule-type').value; agentExecutionMode = $('schedule-execution-mode').value; updateTaskKind(); $('schedule-editor').showModal();
  }
  async function saveSchedule(event) {
    event.preventDefault(); if (!company.isAdmin() || !validateScheduleSkill() || !$('schedule-editor-form').reportValidity()) return;
    const snapshot = capture(), id = editingSchedule?.id, type = $('schedule-type').value, revision = scheduleEditorRevision;
    const business = $('schedule-task-kind').value === 'business';
    const body = { name: $('schedule-name').value.trim(), targetSessionId: $('schedule-target').value, executionMode: business ? 'workspace' : $('schedule-execution-mode').value, skillId: business ? null : $('schedule-skill').value || null, prompt: business ? `执行 RPAC 业务项目 ${$('schedule-business-task').value}，将最终执行结果投递到绑定业务群。` : $('schedule-prompt').value.trim(), scheduleType: type, enabled: $('schedule-enabled').checked, taskType: business ? 'business' : 'agent' };
    if (business) { body.businessTaskId = $('schedule-business-task').value; body.startDate = $('schedule-start-date').value || null; }
    if (type === 'once') {
      const sameTime = id && localDate(editingSchedule.runAt) === $('schedule-run-at').value;
      const instant = new Date(sameTime ? editingSchedule.runAt : `${$('schedule-run-at').value}:00+08:00`);
      const unchangedPast = sameTime && !body.enabled;
      if (Number.isNaN(instant.getTime()) || (instant.getTime() <= Date.now() && !unchangedPast)) { error('schedule-editor-error', '请选择未来的北京时间。'); $('schedule-run-at').focus(); return; } body.runAt = instant.toISOString();
    }
    if (type === 'daily' || type === 'weekly') body.time = $('schedule-time').value;
    if (type === 'weekly') { body.weekdays = [...document.querySelectorAll('input[name="schedule-weekday"]:checked')].map((input) => Number(input.value)); if (!body.weekdays.length) { error('schedule-editor-error', '请至少选择一个每周执行日。'); document.querySelector('input[name="schedule-weekday"]').focus(); return; } }
    if (type === 'interval') { body.intervalMinutes = Number($('schedule-interval').value); if (!Number.isInteger(body.intervalMinutes) || body.intervalMinutes < 1) { error('schedule-editor-error', '间隔必须是至少 1 分钟的整数。'); $('schedule-interval').focus(); return; } }
    busy($('save-schedule'), true, '保存中…'); error('schedule-editor-error');
    try { await api(id ? `/api/admin/schedules/${encodeURIComponent(id)}` : '/api/admin/schedules', { method: id ? 'PATCH' : 'POST', body }); if (!valid(snapshot)) return; if (revision === scheduleEditorRevision && $('schedule-editor').open) $('schedule-editor').close(); await loadSchedules({ silent: true }); if (valid(snapshot)) say(body.enabled ? '任务已保存并启用计划。' : '任务已保存，计划保持停用。'); }
    catch (failure) { if (valid(snapshot)) { if (revision === scheduleEditorRevision && $('schedule-editor').open) error('schedule-editor-error', failure.message); else toast(failure.message); } }
    finally { if (valid(snapshot) && revision === scheduleEditorRevision) busy($('save-schedule'), false, '保存任务'); }
  }
  async function mutateSchedule(schedule, body, button) {
    const snapshot = capture(); button.disabled = true; error('automation-error');
    try { await api(`/api/admin/schedules/${encodeURIComponent(schedule.id)}`, { method: 'PATCH', body }); if (valid(snapshot)) { await loadSchedules({ silent: true }); if (valid(snapshot)) say(body.enabled ? '计划已启用。' : '计划已停用。'); } }
    catch (failure) { if (valid(snapshot)) error('automation-error', failure.message); }
    finally { button.disabled = false; }
  }
  async function runNow(schedule, button) {
    const snapshot = capture(); busy(button, true, '正在提交…'); error('automation-error');
    try { const result = await api(`/api/admin/schedules/${encodeURIComponent(schedule.id)}/run`, { method: 'POST', body: {} }); if (valid(snapshot)) { say(result.run?.status === 'skipped' ? '今日已执行过此项目，本次已跳过，不会重复运行。' : '任务已提交，最终结果将自动投递到绑定业务群及其消息渠道。'); await showRuns(schedule); } }
    catch (failure) { if (valid(snapshot)) error('automation-error', failure.message); }
    finally { busy(button, false, '立即运行'); }
  }
  function setTab(next) { tab = next; $('plans-panel').hidden = next !== 'plans'; $('runs-panel').hidden = next !== 'runs'; $('tab-plans').setAttribute('aria-selected', String(next === 'plans')); $('tab-runs').setAttribute('aria-selected', String(next === 'runs')); }
  async function showRuns(schedule = null) { runFilter = schedule ? { id: schedule.id, name: schedule.name } : null; runPage = 0; setTab('runs'); await loadRuns(); }
  async function loadRuns({ silent = false } = {}) {
    if (!company.isAdmin()) return; const snapshot = capture(), request = ++runsRequest, filterId = runFilter?.id;
    if (!silent) $('task-run-list').replaceChildren(node('p', 'admin-empty', '正在加载运行记录…'));
    const result = await api(filterId ? `/api/admin/schedules/${encodeURIComponent(filterId)}/runs?limit=100` : '/api/admin/task-runs?limit=100');
    if (!valid(snapshot) || request !== runsRequest || filterId !== runFilter?.id) return;
    const changed = JSON.stringify(runs) !== JSON.stringify(result.runs || []); runs = result.runs || [];
    $('run-filter-label').textContent = runFilter ? `${runFilter.name} · 最近 ${runs.length} 条记录（最多 100 条）` : `最近 ${runs.length} 条运行记录（最多 100 条）`; $('show-all-runs').hidden = !runFilter;
    if (changed || !silent) renderRuns();
  }
  function renderRuns() {
    runPage = Math.min(runPage, Math.max(0, Math.ceil(runs.length / PAGE_SIZE) - 1));
    $('task-run-list').replaceChildren(...page(runs, runPage).map((run) => {
      const row = node('article', 'task-run-card'); const head = node('div', 'schedule-card-heading');
      const executionBadge = badge(run.status); executionBadge.textContent = `执行：${labels[run.status] || run.status || '未运行'}`;
      head.append(node('h2', '', run.scheduleName || '任务记录'), executionBadge);
      const trigger = run.trigger === 'manual' ? '手动触发' : run.trigger === 'scheduled' ? '计划触发' : run.trigger || '计划触发';
      const meta = node('div', 'run-metadata'); meta.append(node('span', '', `${trigger} · ${run.requestedByName || '计划调度'}`), node('span', '', run.trigger === 'manual' ? `提交：${date(run.createdAt, '未记录')}` : `计划时间：${date(run.scheduledFor, '未记录')}`), node('span', '', `开始：${date(run.startedAt, '尚未开始')}`), node('span', '', `结束：${date(run.finishedAt, '尚未结束')}`));
      row.append(head, meta);
      if (run.targetSessionId || run.executionMode) meta.append(node('span', '', `业务群：${groupName(run)}`), node('span', '', `权限：${modeName(run.executionMode)}`));
      if (run.taskType === 'business') meta.append(node('span', '', `业务项目：${businessName(run)} · 直接执行项目`), node('span', '', '来源：RPAC · 不调用模型'));
      if (run.delivery) {
        const deliveryLabels = { pending: '等待结果投递', delivered: '群内已投递', failed: '投递失败，待补发', not_required: '无需投递' };
        const delivery = node('div', 'run-delivery');
        delivery.append(node('span', 'run-delivery-label', '结果投递'), node('span', `automation-badge delivery-${run.delivery.status}`, deliveryLabels[run.delivery.status] || '等待投递'));
        const channels = run.delivery.channels;
        if (channels && (channels.queued || channels.sent || channels.failed || channels.pending)) delivery.append(node('span', 'run-channel-status', `消息渠道：已送达 ${channels.sent || 0} · 待送达 ${channels.pending || 0} · 失败 ${channels.failed || 0}`));
        else if (run.delivery.status === 'delivered') delivery.append(node('span', 'run-channel-status', '无待投递的消息渠道'));
        row.append(delivery);
        if (run.delivery.error) { const details = node('details', 'run-error'); details.append(node('summary', '', '查看投递信息'), node('pre', '', run.delivery.error)); row.append(details); }
      } else row.append(node('p', 'run-legacy-note', '历史运行记录 · 未记录自动投递状态'));
      if (run.error) { const details = node('details', 'run-error'); details.append(node('summary', '', '查看执行信息'), node('pre', '', run.error)); row.append(details); }
      const actions = node('div', 'automation-row-actions');
      if (run.targetSessionId) actions.append(action('打开业务群', () => selectSession(run.targetSessionId)));
      if (run.sessionId) actions.append(action(run.targetSessionId ? '执行会话' : '打开历史群聊', () => selectSession(run.sessionId)));
      if (run.taskType === 'business') actions.append(action('执行日志', () => openBusinessLog(run)));
      if (['succeeded', 'failed'].includes(run.status) && (run.delivery?.status === 'failed' || run.delivery?.channels?.failed > 0)) {
        const retryButton = action('补发结果', (button) => retryDelivery(run, button)); retryButton.title = '只补发已有结果，不会重新执行任务'; actions.append(retryButton);
      }
      if (run.status === 'queued' || run.status === 'running') actions.append(action('取消运行', (button) => cancelRun(run, button), 'secondary-button danger-button'));
      if (actions.childElementCount) row.append(actions); return row;
    }));
    if (!runs.length) $('task-run-list').append(node('p', 'admin-empty', '还没有运行记录。手动运行任务，或启用计划后等待触发。'));
    paginate('runs-pagination', runs, runPage, (value) => { runPage = value; renderRuns(); });
  }
  async function openBusinessLog(run) {
    if (!company.isAdmin() || run.taskType !== 'business') return;
    logRun = run; logRevision++; $('business-run-log-title').textContent = `${run.scheduleName || businessName(run)} · 执行日志`;
    $('business-run-log-meta').textContent = `${date(run.startedAt || run.createdAt, '时间未记录')} · 仅管理员可查看，日志不会发送到业务群。`;
    $('business-run-log-content').textContent = '正在加载执行日志…'; $('business-run-log-note').textContent = ''; error('business-run-log-error');
    $('business-run-log').showModal(); await loadBusinessLog();
  }
  async function loadBusinessLog() {
    if (!company.isAdmin() || !logRun || !$('business-run-log').open) return;
    const snapshot = capture(), revision = ++logRevision, runId = logRun.id;
    busy($('business-run-log-refresh'), true, '加载中…'); error('business-run-log-error');
    try {
      const result = await api(`/api/admin/task-runs/${encodeURIComponent(runId)}/log`);
      if (!valid(snapshot) || revision !== logRevision || logRun?.id !== runId || !$('business-run-log').open) return;
      $('business-run-log-content').textContent = result.content || '尚无执行日志。';
      $('business-run-log-note').textContent = result.truncated ? '日志较长，仅显示部分内容。运行中可刷新查看。' : '运行中可刷新查看最新日志。';
    } catch (failure) { if (valid(snapshot) && revision === logRevision) { $('business-run-log-content').textContent = ''; error('business-run-log-error', failure.message); } }
    finally { if (valid(snapshot) && revision === logRevision) busy($('business-run-log-refresh'), false, '刷新日志'); }
  }
  async function retryDelivery(run, button) {
    if (!company.isAdmin()) return;
    const snapshot = capture(); busy(button, true, '正在补发…'); error('automation-error');
    try { await api(`/api/admin/task-runs/${encodeURIComponent(run.id)}/retry-delivery`, { method: 'POST', body: {} }); if (valid(snapshot)) { await loadRuns({ silent: true }); if (valid(snapshot)) say('已重试投递现有结果，任务不会重新执行。'); } }
    catch (failure) { if (valid(snapshot)) error('automation-error', failure.message); }
    finally { busy(button, false, '补发结果'); }
  }
  async function cancelRun(run, button) {
    const snapshot = capture(); busy(button, true, '取消中…'); error('automation-error');
    try { await api(`/api/admin/task-runs/${encodeURIComponent(run.id)}/cancel`, { method: 'POST', body: {} }); if (valid(snapshot)) { await loadRuns({ silent: true }); if (valid(snapshot)) say('已提交取消请求。'); } }
    catch (failure) { if (valid(snapshot)) error('automation-error', failure.message); }
    finally { busy(button, false, '取消运行'); }
  }
  function confirmDelete(kind, item) {
    if (!company.isAdmin()) return; error('automation-confirm-error');
    const revision = ++confirmRevision; busy($('automation-confirm-submit'), false, '确认删除');
    $('automation-confirm-title').textContent = `删除${kind === 'skill' ? '技能' : '任务'}？`;
    $('automation-confirm-description').textContent = kind === 'skill' ? `将删除技能「${item.name}」。被任务引用的技能需先解除引用，删除后不能在技能中心恢复。` : `将删除任务「${item.name}」并停止未来计划。已有群聊仍可查看。`;
    const snapshot = capture(); confirmAction = async () => { await api(kind === 'skill' ? `/api/admin/skills/${encodeURIComponent(item.id)}` : `/api/admin/schedules/${encodeURIComponent(item.id)}`, { method: 'DELETE', body: {} }); if (!valid(snapshot)) return; if (revision === confirmRevision && $('automation-confirm').open) $('automation-confirm').close(); if (kind === 'skill') await loadSkills({ silent: true }); else await loadSchedules({ silent: true }); if (valid(snapshot)) say(kind === 'skill' ? '技能已删除。' : '任务已删除。'); };
    $('automation-confirm').showModal();
  }
  async function navigate(next) {
    if (!company.enterExtension(next)) return;
    const snapshot = capture();
    error('automation-error'); $('skills-panel').hidden = next !== 'skills'; $('schedules-panel').hidden = next !== 'schedules';
    $('automation-title').textContent = next === 'skills' ? '技能中心' : '定时任务'; $('automation-description').textContent = next === 'skills' ? '保存可复用的处理方法，供群聊与定时任务使用。' : '按计划执行技能或业务项目，最终结果自动送达业务群及其消息渠道。';
    $('automation-create').replaceChildren(icon('plus'), document.createTextNode(next === 'skills' ? '导入 ZIP' : '新建任务'));
    try { if (next === 'skills') await loadSkills(); else { await Promise.all([loadSkills({ silent: true }), loadGroups(), loadBusinessTasks()]); if (tab === 'runs') await loadRuns(); else await loadSchedules(); } }
    catch (failure) { if (valid(snapshot) && company.view === next) error('automation-error', failure.message); }
    nextRefresh = Date.now() + 5000;
  }
  async function refresh() { if (!company.isAdmin()) return; const button = $('automation-refresh'); button.disabled = true; error('automation-error'); try { if (company.view === 'skills') await loadSkills(); else if (company.view === 'schedules' && tab === 'runs') await loadRuns(); else if (company.view === 'schedules') await loadSchedules(); } catch (failure) { error('automation-error', failure.message); } finally { button.disabled = false; } }
  function applySkillSelection(skill) {
    if (!skillAvailable(skill, state.session?.id)) return;
    company.goChat(); refreshComposer(); $('chat-skill').value = skill.id; $('prompt').focus(); preserveDraft(); say(`已选择技能 ${skill.name}，补充任务后发送。`);
  }
  async function useSkill(skill) {
    if (!company.isAdmin() || !skill?.enabled) return;
    const snapshot = capture(), revision = ++useRevision;
    try {
      await loadGroups(); if (!valid(snapshot) || revision !== useRevision) return;
      if ($('skill-detail').open) $('skill-detail').close();
      if (groups.some((group) => group.id === state.session?.id) && skillAvailable(skill, state.session?.id)) { applySkillSelection(skill); return; }
      usingSkill = skill; const available = groups.filter((group) => skillAvailable(skill, group.id));
      const empty = node('option', '', available.length ? '请选择已授权的业务群' : '暂无可用业务群'); empty.value = '';
      $('skill-use-target').replaceChildren(empty, ...available.map((group) => { const option = node('option', '', group.title || '未命名群聊'); option.value = group.id; return option; }));
      $('skill-use-target').value = available.length === 1 ? available[0].id : '';
      $('skill-use-hint').textContent = available.length ? '当前群未选择或不在此技能共享范围内，请切换到授权群聊。' : '此技能暂无你可进入的授权业务群。请先加入获授权群聊，或调整技能共享范围。';
      $('skill-use-title').textContent = `选择使用 ${skill.name} 的群聊`; error('skill-use-error'); busy($('skill-use-submit'), false, '进入群聊并选择技能'); $('skill-use-submit').disabled = !available.length; $('skill-use').showModal();
    } catch (failure) { if (valid(snapshot)) error('automation-error', failure.message); }
  }
  async function selectSkillGroup(event) {
    event.preventDefault(); if (!company.isAdmin() || !usingSkill || !$('skill-use-form').reportValidity()) return;
    const snapshot = capture(), revision = useRevision, skill = usingSkill, groupId = $('skill-use-target').value;
    if (!skillAvailable(skill, groupId)) { error('skill-use-error', '请选择已授权的业务群。'); return; }
    busy($('skill-use-submit'), true, '正在进入…'); error('skill-use-error');
    try {
      await selectSession(groupId); if (!valid(snapshot) || revision !== useRevision) return;
      if (state.session?.id !== groupId) throw new Error('暂时无法进入此群聊，请重试。');
      $('skill-use').close(); applySkillSelection(skill);
    } catch (failure) { if (valid(snapshot) && revision === useRevision) error('skill-use-error', failure.message); }
    finally { if (valid(snapshot) && revision === useRevision) busy($('skill-use-submit'), false, '进入群聊并选择技能'); }
  }
  function reset() {
    skillsRequest++; schedulesRequest++; runsRequest++; groupsRequest++; detailRequest++; sharingRevision++; useRevision++; businessTasksRequest++; logRevision++; skills = []; schedules = []; runs = []; groups = []; businessTasks = []; logRun = null; editingSkill = null; detailSkill = null; editingSchedule = null; sharingSkill = null; usingSkill = null; scopeSelections.clear(); runFilter = null; confirmAction = null; skillPage = 0; planPage = 0; runPage = 0; tickBusy = false; lastSkillsLoad = 0;
    $('chat-skill').replaceChildren(Object.assign(node('option', '', '不使用技能'), { value: '' })); $('composer-skill').hidden = true;
    for (const id of ['skill-grid', 'schedule-list', 'task-run-list', 'skill-detail-content', 'skill-detail-description', 'skill-detail-meta', 'skill-detail-sharing', 'skill-import-list', 'skill-sharing-list', 'skill-use-target']) $(id).replaceChildren();
    for (const id of ['skill-editor', 'skill-detail', 'skill-sharing', 'skill-use', 'schedule-editor', 'automation-confirm', 'business-run-log']) if ($(id).open) $(id).close();
    $('business-run-log-content').textContent = ''; $('business-run-log-note').textContent = ''; error('business-run-log-error');
    $('skill-editor-form').reset(); $('schedule-editor-form').reset(); error('automation-error');
    $('schedule-target').replaceChildren(Object.assign(node('option', '', '请选择业务群'), { value: '' })); updateExecutionModeHint();
    $('skill-detail-title').textContent = '技能详情'; busy($('save-skill'), false, '导入 ZIP'); busy($('save-schedule'), false, '保存任务');
  }
  async function identityChanged() { reset(); if (!company.isAdmin()) return; try { await loadSkills({ silent: true }); } catch (failure) { if (company.isAdmin()) toast(`技能目录暂时不可用：${failure.message}`); } }
  async function tick() {
    if (!company.isAdmin() || document.hidden || company.view !== 'schedules' || tickBusy || Date.now() < nextRefresh) return;
    tickBusy = true; nextRefresh = Date.now() + 5000;
    try { if (tab === 'runs') await loadRuns({ silent: true }); else await loadSchedules({ silent: true }); }
    catch (failure) { if (company.isAdmin() && company.view === 'schedules') error('automation-error', `自动刷新失败：${failure.message}`, false); }
    finally { tickBusy = false; }
  }
  $('nav-skills').addEventListener('click', () => navigate('skills')); $('nav-schedules').addEventListener('click', () => navigate('schedules')); $('manage-chat-skills').addEventListener('click', () => navigate('skills'));
  $('automation-create').addEventListener('click', () => company.view === 'skills' ? editSkill() : editSchedule()); $('automation-refresh').addEventListener('click', refresh);
  $('skill-editor-form').addEventListener('submit', saveSkill); $('schedule-editor-form').addEventListener('submit', saveSchedule); $('schedule-type').addEventListener('change', updateScheduleFields); $('schedule-execution-mode').addEventListener('change', updateExecutionModeHint);
  $('schedule-task-kind').addEventListener('change', () => updateTaskKind({ changed: true })); $('schedule-business-task').addEventListener('change', updateBusinessTaskHint);
  $('business-run-log-refresh').addEventListener('click', loadBusinessLog); $('business-run-log').addEventListener('close', () => { logRevision++; logRun = null; $('business-run-log-content').textContent = ''; $('business-run-log-note').textContent = ''; });
  $('skill-sharing-form').addEventListener('submit', saveSharing); $('skill-use-form').addEventListener('submit', selectSkillGroup);
  $('schedule-target').addEventListener('change', () => updateScheduleSkills()); $('schedule-skill').addEventListener('change', validateScheduleSkill);
  for (const prefix of ['skill-import', 'skill-sharing']) { $(`${prefix}-scope`).addEventListener('change', () => renderScopeGroups(prefix)); $(`${prefix}-search`).addEventListener('input', () => renderScopeGroups(prefix)); }
  $('edit-detail-skill').addEventListener('click', () => { if (detailSkill) editSkill(detailSkill.id); }); $('use-detail-skill').addEventListener('click', () => useSkill(detailSkill));
  $('tab-plans').addEventListener('click', async () => { setTab('plans'); try { await loadSchedules(); } catch (failure) { error('automation-error', failure.message); } }); $('tab-runs').addEventListener('click', async () => { try { await showRuns(); } catch (failure) { error('automation-error', failure.message); } }); $('show-all-runs').addEventListener('click', async () => { try { await showRuns(); } catch (failure) { error('automation-error', failure.message); } });
  $('chat-skill').addEventListener('focus', () => { if (company.isAdmin() && Date.now() - lastSkillsLoad > 10000) loadSkills({ silent: true }).catch(() => {}); });
  $('skill-editor').addEventListener('close', () => { skillEditorRevision++; }); $('schedule-editor').addEventListener('close', () => { scheduleEditorRevision++; });
  $('skill-sharing').addEventListener('close', () => { sharingRevision++; sharingSkill = null; }); $('skill-use').addEventListener('close', () => { useRevision++; usingSkill = null; });
  document.querySelectorAll('[data-automation-close]').forEach((button) => button.addEventListener('click', () => $(button.dataset.automationClose).close()));
  $('automation-confirm').addEventListener('close', () => { confirmRevision++; });
  $('automation-confirm-form').addEventListener('submit', async (event) => { event.preventDefault(); if (!company.isAdmin() || !confirmAction) return; const snapshot = capture(), revision = confirmRevision; busy($('automation-confirm-submit'), true, '删除中…'); try { await confirmAction(); } catch (failure) { if (valid(snapshot) && revision === confirmRevision) error('automation-confirm-error', failure.message); } finally { if (valid(snapshot) && revision === confirmRevision) busy($('automation-confirm-submit'), false, '确认删除'); } });
  return { identityChanged, reset, tick, refreshComposer, contextChanged: refreshComposer, selectedSkillId: () => company.isAdmin() && skills.some((skill) => skill.id === $('chat-skill').value && skillAvailable(skill, state.session?.id)) ? $('chat-skill').value : null, updateControls: () => { if (composerSessionId !== (state.session?.id || null)) refreshComposer(); $('chat-skill').disabled = !company.isAdmin() || state.loading; } };
}
