import { randomUUID } from 'node:crypto';
import { HttpError } from './security.mjs';
import { storedCards, taskResultCard } from './message-cards.mjs';
import { ATTACHMENT_MAX_BYTES } from './attachments.mjs';
import { attachmentMarkdown } from './attachment-output.mjs';

const statuses = new Set(['queued', 'running', 'waiting_human', 'succeeded', 'failed', 'cancelled', 'interrupted']);
const terminal = new Set(['succeeded', 'failed', 'cancelled']);
const identifier = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
function id(value, label = '编号') {
  if (typeof value !== 'string' || !identifier.test(value)) throw new HttpError(400, `${label}无效。`);
  return value;
}
function text(value, label, max = 100000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new HttpError(400, `${label}不能为空，且不能超过 ${max} 个字符。`);
  return value.trim();
}
function limit(value, fallback, max) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new HttpError(400, '分页大小无效。');
  return value;
}
function offset(value = 0) { if (!Number.isSafeInteger(value) || value < 0) throw new HttpError(400, '分页位置无效。'); return value; }
function attachmentSelection(value = []) {
  if (!Array.isArray(value) || value.length > 10) throw new HttpError(400, '每条消息最多添加 10 个附件。');
  return [...new Set(Array.from(value, value => id(value, '附件编号')))];
}
function userContent(value, label, attachments) {
  if (value == null && attachments.length) return '';
  if (typeof value === 'string' && value.length <= 100000 && !value.trim() && attachments.length) return '';
  return text(value, label);
}
function withAttachments(content, attachments) {
  const links = attachments.map(attachmentMarkdown).join('\n\n');
  return links ? `${content ? `${content}\n\n` : ''}${links}` : content;
}

/** Durable group work and discussion. authorize must synchronously resolve a
 * currently enabled group member; execution always uses the task's creator. */
export class WorkTaskService {
  constructor(store, { execute, authorize, resolveReply, resolveAttachments, onMessage = () => {}, onEvent = () => {},
    redact = String, now = () => new Date(), pollIntervalMs = 250, maxConcurrentGroups = 4, maxQueuedPerGroup = 100 } = {}) {
    if (typeof authorize !== 'function' || typeof execute !== 'function') throw new TypeError('WorkTaskService requires execute and synchronous authorize callbacks.');
    this.store = store; this.db = store.db; this.execute = execute; this.authorize = authorize;
    this.onMessage = onMessage; this.onEvent = onEvent; this.redact = redact; this.now = now;
    this.resolveReply = resolveReply;
    this.resolveAttachments = resolveAttachments;
    this.maxConcurrentGroups = limit(maxConcurrentGroups, 4, 32);
    this.maxQueuedPerGroup = limit(maxQueuedPerGroup, 100, 1000);
    this.pollIntervalMs = Math.min(5000, Math.max(20, Number(pollIntervalMs) || 250));
    this.active = new Map(); this.started = false; this.stopping = false; this.ticking = false; this.timer = null;
    this.db.exec(`CREATE TABLE IF NOT EXISTS work_tasks (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL REFERENCES session_meta(id), title TEXT NOT NULL, instruction TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('queued','running','waiting_human','succeeded','failed','cancelled','interrupted')),
      created_by TEXT NOT NULL, created_by_name TEXT NOT NULL, assignee_id TEXT, assignee_name TEXT, skill_id TEXT,
      progress REAL NOT NULL DEFAULT 0, progress_text TEXT NOT NULL DEFAULT '', result TEXT, error TEXT,
      client_request_id TEXT, queue_order INTEGER NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,deleted_at TEXT,
      attachments_json TEXT NOT NULL DEFAULT '[]',
      UNIQUE(session_id,created_by,client_request_id));
      CREATE INDEX IF NOT EXISTS work_tasks_queue ON work_tasks(status,session_id,queue_order,seq);
      CREATE TABLE IF NOT EXISTS collaboration_messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL REFERENCES session_meta(id), role TEXT NOT NULL CHECK(role IN ('user','assistant')),
      content TEXT NOT NULL,author_id TEXT,author_name TEXT NOT NULL,reply_to TEXT,reply_snapshot_json TEXT,mentions_json TEXT NOT NULL DEFAULT '[]',
      work_task_id TEXT REFERENCES work_tasks(id),client_request_id TEXT,created_at TEXT NOT NULL,
      attachments_json TEXT NOT NULL DEFAULT '[]',
      UNIQUE(session_id,author_id,client_request_id));
      CREATE INDEX IF NOT EXISTS collaboration_messages_group ON collaboration_messages(session_id,seq);
      CREATE TABLE IF NOT EXISTS work_task_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,task_id TEXT NOT NULL REFERENCES work_tasks(id),
      session_id TEXT NOT NULL,actor_id TEXT,actor_name TEXT NOT NULL,type TEXT NOT NULL,data_json TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS work_task_events_task ON work_task_events(task_id,seq);`);
    for (const [table, column, definition] of [['work_tasks', 'deleted_at', 'TEXT'], ['collaboration_messages', 'reply_snapshot_json', 'TEXT'],
      ['work_tasks', 'attachments_json', "TEXT NOT NULL DEFAULT '[]'"], ['collaboration_messages', 'attachments_json', "TEXT NOT NULL DEFAULT '[]'"]]) {
      if (!this.db.prepare(`PRAGMA table_info(${table})`).all().some(item => item.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
    if (!this.db.prepare('PRAGMA table_info(collaboration_messages)').all().some(item => item.name === 'cards_json')) this.db.exec("ALTER TABLE collaboration_messages ADD COLUMN cards_json TEXT NOT NULL DEFAULT '[]'");
    // A restart cannot determine whether an external action already committed.
    // Never replay it automatically, even if no result was written.
    const interruptedEvents = [];
    this.store.transaction(() => {
      for (const row of this.db.prepare("SELECT * FROM work_tasks WHERE status='running'").all()) {
        const at = this.at();
        this.db.prepare("UPDATE work_tasks SET status='interrupted',error=?,finished_at=?,updated_at=?,revision=revision+1 WHERE id=?")
          .run('服务重启，任务已中断；请先核对已执行的操作，再明确恢复。', at, at, row.id);
        interruptedEvents.push(this.event(row, null, 'interrupted', { reason: 'restart' }, at));
      }
    });
    for (const event of interruptedEvents) this.emit(event);
  }

  at() { const date = this.now(); return new Date(date).toISOString(); }
  clean(value, max = 100000) { return String(this.redact(String(value ?? ''))).slice(0, max); }
  actor(sessionId, supplied, phase, task = null) {
    id(sessionId, '群聊编号');
    if (!this.db.prepare('SELECT id FROM session_meta WHERE id=?').get(sessionId)) throw new HttpError(404, '群聊不存在。');
    const actorId = typeof supplied === 'string' ? supplied : supplied?.id;
    id(actorId, '成员编号');
    const member = this.authorize({ sessionId, actorId, phase, task });
    if (member?.then) throw new TypeError('WorkTaskService authorize must be synchronous.');
    if (!member || member.id !== actorId || member.disabled) throw new HttpError(403, '成员已停用或不再具有群聊访问权限。');
    return { ...member, displayName: String(member.displayName || member.username || member.id) };
  }
  raw(sessionId, taskId) {
    id(sessionId, '群聊编号'); id(taskId, '任务编号');
    const row = this.db.prepare('SELECT * FROM work_tasks WHERE id=? AND session_id=?').get(taskId, sessionId);
    if (!row || row.deleted_at) throw new HttpError(404, '任务不存在。');
    return row;
  }
  view(row, events = false) {
    const value = { id: row.id, sessionId: row.session_id, title: row.title, instruction: row.instruction,
      status: row.status, createdBy: row.created_by, createdByName: row.created_by_name,
      assigneeId: row.assignee_id, assigneeName: row.assignee_name, skillId: row.skill_id,
      progress: row.progress, progressText: row.progress_text, result: row.result, error: row.error,
      attempt: row.attempt, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at,
      startedAt: row.started_at, finishedAt: row.finished_at, attachments: JSON.parse(row.attachments_json || '[]') };
    if (events) value.events = this.db.prepare('SELECT * FROM work_task_events WHERE task_id=? AND session_id=? ORDER BY seq').all(row.id, row.session_id)
      .map(event => ({ id: event.id, type: event.type, actorId: event.actor_id, actorName: event.actor_name,
        data: JSON.parse(event.data_json), createdAt: event.created_at }));
    return value;
  }
  messageView(row) {
    const cards = storedCards(row.cards_json);
    return { id: row.id, sessionId: row.session_id, role: row.role, content: row.content,
      authorId: row.author_id, authorName: row.author_name, timestamp: Date.parse(row.created_at), createdAt: row.created_at,
      replyTo: row.reply_to, replySnapshot: row.reply_snapshot_json ? JSON.parse(row.reply_snapshot_json) : null,
      mentions: JSON.parse(row.mentions_json), attachments: JSON.parse(row.attachments_json || '[]'),
      ...(row.work_task_id ? { workTaskId: row.work_task_id } : {}), ...(cards.length ? { cards } : {}) };
  }
  event(row, actor, type, data = {}, at = this.at()) {
    const event = { id: randomUUID(), taskId: row.id, sessionId: row.session_id, actorId: actor?.id || null,
      actorName: actor?.displayName || 'Pi', type, data, createdAt: at };
    this.db.prepare('INSERT INTO work_task_events(id,task_id,session_id,actor_id,actor_name,type,data_json,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(event.id, row.id, row.session_id, event.actorId, event.actorName, type, JSON.stringify(data), at);
    return event;
  }
  emit(event) { try { this.onEvent(event); } catch {} }
  emitMessage(message) { try { this.onMessage(message); } catch {} }
  attachmentMetadata(sessionId, attachmentIds, values) {
    const selected = attachmentSelection(attachmentIds);
    if (!Array.isArray(values) || values.length !== selected.length) throw new HttpError(400, '附件记录不完整，请重新选择。');
    const records = new Map();
    for (const item of values) {
      if (!item || typeof item !== 'object' || Array.isArray(item) || !selected.includes(item.id) || records.has(item.id)) throw new HttpError(400, '附件记录无效。');
      const url = `/api/sessions/${encodeURIComponent(sessionId)}/attachments/${item.id}`;
      if (typeof item.name !== 'string' || !item.name.trim() || item.name.length > 512 || /^\.+$/.test(item.name)
        || /[\u0000-\u001f\u007f/\\\u202a-\u202e\u2066-\u2069]/.test(item.name) || item.name !== item.name.toWellFormed()
        || !Number.isSafeInteger(item.size) || item.size < 0) throw new HttpError(400, '附件元数据无效。');
      if (item.size > ATTACHMENT_MAX_BYTES) throw new HttpError(413, '附件不能超过 50 MiB。');
      if (!['image', 'file'].includes(item.kind) || typeof item.mimeType !== 'string'
        || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(item.mimeType)
        || (item.kind === 'image') !== item.mimeType.startsWith('image/')
        || item.url !== url || (item.downloadUrl !== undefined && item.downloadUrl !== `${url}?download=1`)) throw new HttpError(400, '附件链接或类型无效。');
      records.set(item.id, { id: item.id, name: item.name, size: item.size, mimeType: item.mimeType,
        kind: item.kind, url, downloadUrl: `${url}?download=1` });
    }
    return selected.map(value => records.get(value));
  }
  attachments(sessionId, attachmentIds, actor) {
    const selected = attachmentSelection(attachmentIds);
    if (!selected.length) return [];
    if (typeof this.resolveAttachments !== 'function') throw new HttpError(400, '附件功能尚未启用。');
    const values = this.resolveAttachments({ sessionId, attachmentIds: selected, actor });
    if (values?.then) throw new TypeError('WorkTaskService resolveAttachments must be synchronous.');
    return this.attachmentMetadata(sessionId, selected, values);
  }
  references(sessionId, replyTo, mentions = [], actor) {
    let replySnapshot = null;
    if (replyTo !== undefined && replyTo !== null) {
      id(replyTo, '引用消息编号');
      let original = this.db.prepare('SELECT id,content,author_name AS authorName,attachments_json FROM collaboration_messages WHERE id=? AND session_id=?').get(replyTo, sessionId);
      if (!original && this.resolveReply) {
        original = this.resolveReply({ sessionId, replyTo, actor });
        if (original?.then) throw new TypeError('WorkTaskService resolveReply must be synchronous.');
      }
      if (!original || original.id !== replyTo || typeof original.content !== 'string') throw new HttpError(404, '引用消息不存在或不属于当前群。');
      replySnapshot = { id: replyTo, content: this.clean(original.content, 500), authorName: this.clean(original.authorName || '历史成员', 100) };
      const attachments = original.attachments_json ? JSON.parse(original.attachments_json) : original.attachments;
      if (attachments != null && !Array.isArray(attachments)) throw new HttpError(400, '引用消息的附件记录无效。');
      if (attachments?.length) replySnapshot.attachments = this.attachmentMetadata(sessionId, attachments.map(item => item?.id), attachments);
    }
    if (!Array.isArray(mentions) || mentions.length > 100) throw new HttpError(400, '提及成员列表无效。');
    const selected = [...new Set(mentions.map(value => id(value, '提及成员编号')))];
    for (const memberId of selected) if (memberId !== 'agent') this.actor(sessionId, memberId, 'mention');
    return { replyTo: replyTo ?? null, replySnapshot, mentions: selected };
  }
  requestId(value) { return value == null ? null : id(value, '请求去重编号'); }
  insertMessage({ sessionId, actor, content, replyTo = null, replySnapshot = null, mentions = [], workTaskId = null, role = 'user', clientRequestId = null, at = this.at(), cards = [], attachments = [] }) {
    const messageId = randomUUID();
    this.db.prepare('INSERT INTO collaboration_messages(id,session_id,role,content,author_id,author_name,reply_to,reply_snapshot_json,mentions_json,work_task_id,client_request_id,created_at,cards_json,attachments_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(messageId, sessionId, role, this.clean(content, 100000 + attachments.reduce((total, item) => total + attachmentMarkdown(item).length + 2, 0)), actor?.id || null, actor?.displayName || 'Pi', replyTo,
        replySnapshot ? JSON.stringify(replySnapshot) : null, JSON.stringify(mentions), workTaskId, clientRequestId, at, JSON.stringify(cards), JSON.stringify(attachments));
    return this.messageView(this.db.prepare('SELECT * FROM collaboration_messages WHERE id=?').get(messageId));
  }
  get(sessionId, taskId, actor) { this.actor(sessionId, actor, 'read'); return this.view(this.raw(sessionId, taskId), true); }
  list(sessionId, actor, options = {}) {
    this.actor(sessionId, actor, 'read');
    const size = limit(options.limit, 50, 200), start = offset(options.offset);
    if (options.status !== undefined && !statuses.has(options.status)) throw new HttpError(400, '任务状态无效。');
    const where = 'session_id=? AND deleted_at IS NULL' + (options.status ? ' AND status=?' : '');
    const params = options.status ? [sessionId, options.status] : [sessionId];
    return { tasks: this.db.prepare(`SELECT * FROM work_tasks WHERE ${where} ORDER BY seq DESC LIMIT ? OFFSET ?`).all(...params, size, start).map(row => this.view(row)),
      total: this.db.prepare(`SELECT COUNT(*) AS total FROM work_tasks WHERE ${where}`).get(...params).total };
  }
  listMessages(sessionId, actor, options = {}) {
    this.actor(sessionId, actor, 'read');
    const size = limit(options.limit, 100, 1000), start = offset(options.offset);
    if (options.latest !== undefined && typeof options.latest !== 'boolean') throw new HttpError(400, 'latest 须为布尔值。');
    const rows = this.db.prepare(`SELECT * FROM collaboration_messages WHERE session_id=? ORDER BY seq ${options.latest ? 'DESC' : 'ASC'} LIMIT ? OFFSET ?`).all(sessionId, size, start);
    if (options.latest) rows.reverse();
    return { messages: rows.map(row => this.messageView(row)),
      total: this.db.prepare('SELECT COUNT(*) AS total FROM collaboration_messages WHERE session_id=?').get(sessionId).total };
  }
  messages(sessionId, actor, options = {}) { return this.listMessages(sessionId, actor, options).messages; }
  messageCount(sessionId) { id(sessionId, '群聊编号'); return this.db.prepare('SELECT COUNT(*) AS total FROM collaboration_messages WHERE session_id=?').get(sessionId).total; }
  postMessage({ sessionId, actor: supplied, content, replyTo, mentions, clientRequestId, attachmentIds } = {}) {
    const actor = this.actor(sessionId, supplied, 'message');
    const key = this.requestId(clientRequestId);
    if (key) {
      const previous = this.db.prepare('SELECT * FROM collaboration_messages WHERE session_id=? AND author_id=? AND client_request_id=?').get(sessionId, actor.id, key);
      if (previous) return this.messageView(previous);
    }
    const attachments = this.attachments(sessionId, attachmentIds, actor);
    const value = userContent(content, '消息', attachments), refs = this.references(sessionId, replyTo, mentions, actor);
    const message = this.insertMessage({ sessionId, actor, content: withAttachments(value, attachments), attachments, ...refs, clientRequestId: key });
    this.emitMessage(message);
    return message;
  }
  create({ sessionId, actor: supplied, instruction, title, assigneeId = null, skillId = null, clientRequestId, replyTo, mentions, attachmentIds } = {}) {
    if (this.stopping) throw new HttpError(503, '服务正在关闭，请稍后提交。');
    const actor = this.actor(sessionId, supplied, 'create');
    const key = this.requestId(clientRequestId);
    if (key) {
      const previous = this.db.prepare('SELECT * FROM work_tasks WHERE session_id=? AND created_by=? AND client_request_id=?').get(sessionId, actor.id, key);
      if (previous) { if (previous.deleted_at) throw new HttpError(409, '此请求对应的任务已删除，请勿重复执行。'); return this.view(previous, true); }
    }
    if (this.db.prepare("SELECT COUNT(*) AS total FROM work_tasks WHERE session_id=? AND status='queued' AND deleted_at IS NULL").get(sessionId).total >= this.maxQueuedPerGroup) throw new HttpError(429, '当前群聊排队任务过多，请稍后提交。');
    const refs = this.references(sessionId, replyTo, mentions, actor);
    const inherited = (attachmentIds === undefined || (Array.isArray(attachmentIds) && !attachmentIds.length)) && refs.replySnapshot?.attachments?.length
      ? refs.replySnapshot.attachments.map(item => item.id) : attachmentIds;
    const attachments = this.attachments(sessionId, inherited, actor), body = userContent(instruction, '任务内容', attachments);
    const input = body || '请查看我上传的附件，并说明其中的主要内容。';
    const heading = title === undefined ? input.slice(0, 80) : text(title, '任务标题', 120);
    const assignee = assigneeId == null || assigneeId === '' ? null : this.actor(sessionId, assigneeId, 'assign');
    const skill = skillId == null || skillId === '' ? null : id(skillId, '技能编号');
    const taskId = randomUUID(), at = this.at();
    let message, event;
    this.store.transaction(() => {
      const order = this.db.prepare('SELECT COALESCE(MAX(queue_order),0)+1 AS next FROM work_tasks').get().next;
      this.db.prepare(`INSERT INTO work_tasks(id,session_id,title,instruction,status,created_by,created_by_name,assignee_id,assignee_name,skill_id,client_request_id,queue_order,created_at,updated_at,attachments_json)
        VALUES (?,?,?,?,'queued',?,?,?,?,?,?,?,?,?,?)`)
        .run(taskId, sessionId, heading, input, actor.id, actor.displayName, assignee?.id || null, assignee?.displayName || null, skill, key, order, at, at, JSON.stringify(attachments));
      const row = this.raw(sessionId, taskId);
      event = this.event(row, actor, 'created', { assigneeId: assignee?.id || null, skillId: skill }, at);
      message = this.insertMessage({ sessionId, actor, content: withAttachments(body, attachments), attachments, ...refs, workTaskId: taskId, at });
    });
    this.emit(event); this.emitMessage(message); this.poke();
    return this.get(sessionId, taskId, actor);
  }
  manageable(row, actor) {
    if (actor.role !== 'admin' && actor.id !== row.created_by && actor.id !== row.assignee_id) throw new HttpError(403, '仅任务创建人、负责人或管理员可操作此任务。');
  }
  update(sessionId, taskId, patch, supplied) {
    const row = this.raw(sessionId, taskId), actor = this.actor(sessionId, supplied, 'update', this.view(row));
    this.manageable(row, actor);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(key => !['title', 'assigneeId'].includes(key))) throw new HttpError(400, '只能更新任务标题或负责人。');
    if (terminal.has(row.status)) throw new HttpError(409, '已结束任务不可修改。');
    const heading = 'title' in patch ? text(patch.title, '任务标题', 120) : row.title;
    const assignee = 'assigneeId' in patch ? (patch.assigneeId === null || patch.assigneeId === '' ? null : this.actor(sessionId, patch.assigneeId, 'assign', this.view(row))) : null;
    const assignedId = 'assigneeId' in patch ? assignee?.id || null : row.assignee_id;
    const assignedName = 'assigneeId' in patch ? assignee?.displayName || null : row.assignee_name;
    const pauses = 'assigneeId' in patch && ['queued', 'running'].includes(row.status);
    let event;
    this.store.transaction(() => {
      this.db.prepare('UPDATE work_tasks SET title=?,assignee_id=?,assignee_name=?,status=?,updated_at=?,revision=revision+1 WHERE id=?')
        .run(heading, assignedId, assignedName, pauses ? 'waiting_human' : row.status, this.at(), row.id);
      event = this.event(row, actor, 'updated', { title: heading, assigneeId: assignedId, status: pauses ? 'waiting_human' : row.status });
    });
    if (pauses && this.active.get(sessionId)?.taskId === row.id) this.active.get(sessionId).controller.abort(new DOMException('任务已转交，等待人工确认恢复。', 'AbortError'));
    this.emit(event); return this.get(sessionId, taskId, actor);
  }
  action(sessionId, taskId, options, supplied) {
    if (!options || !['takeover', 'assign', 'supplement', 'resume', 'complete', 'cancel'].includes(options.action)) throw new HttpError(400, '任务操作无效。');
    const row = this.raw(sessionId, taskId), actor = this.actor(sessionId, supplied, options.action, this.view(row));
    const kind = options.action;
    if (kind === 'takeover') {
      if (row.assignee_id && row.assignee_id !== actor.id && row.created_by !== actor.id && actor.role !== 'admin') throw new HttpError(409, '此任务已有负责人，请先由创建人或当前负责人转交。');
    } else this.manageable(row, actor);
    if (terminal.has(row.status)) throw new HttpError(409, '任务已结束，不能再次操作或恢复。');
    if (kind === 'resume' && !['waiting_human', 'interrupted'].includes(row.status)) throw new HttpError(409, '仅等待人工或已中断的任务可明确恢复。');
    if (kind === 'resume' && this.db.prepare("SELECT COUNT(*) AS total FROM work_tasks WHERE session_id=? AND status='queued' AND deleted_at IS NULL").get(sessionId).total >= this.maxQueuedPerGroup) throw new HttpError(429, '当前群聊排队任务过多，请稍后恢复。');
    if (kind === 'supplement' && !['waiting_human', 'interrupted'].includes(row.status)) throw new HttpError(409, '请先人工接手任务，再补充内容并明确恢复。');
    if (kind === 'complete' && !['waiting_human', 'interrupted'].includes(row.status)) throw new HttpError(409, '请先接手任务，再提交人工完成结果。');
    const content = options.content === undefined ? null : text(options.content, '补充内容');
    if (['supplement', 'complete'].includes(kind) && !content) throw new HttpError(400, '请提供补充内容或人工完成结果。');
    if (kind === 'assign' && !('assigneeId' in options)) throw new HttpError(400, '请选择负责人，或明确清空负责人。');
    const assignee = kind === 'takeover' ? actor : kind === 'assign' && options.assigneeId != null && options.assigneeId !== '' ? this.actor(sessionId, options.assigneeId, 'assign', this.view(row)) : null;
    const at = this.at(); let event, message;
    this.store.transaction(() => {
      if (kind === 'takeover') this.db.prepare("UPDATE work_tasks SET status='waiting_human',assignee_id=?,assignee_name=?,error=NULL,updated_at=?,revision=revision+1 WHERE id=?").run(actor.id, actor.displayName, at, row.id);
      if (kind === 'assign') this.db.prepare('UPDATE work_tasks SET assignee_id=?,assignee_name=?,status=?,updated_at=?,revision=revision+1 WHERE id=?').run(assignee?.id || null, assignee?.displayName || null, ['queued', 'running'].includes(row.status) ? 'waiting_human' : row.status, at, row.id);
      if (kind === 'supplement') this.db.prepare('UPDATE work_tasks SET updated_at=?,revision=revision+1 WHERE id=?').run(at, row.id);
      if (kind === 'resume') {
        const order = this.db.prepare('SELECT COALESCE(MAX(queue_order),0)+1 AS next FROM work_tasks').get().next;
        this.db.prepare("UPDATE work_tasks SET status='queued',progress=0,progress_text='',result=NULL,error=NULL,queue_order=?,started_at=NULL,finished_at=NULL,updated_at=?,revision=revision+1 WHERE id=?").run(order, at, row.id);
      }
      if (kind === 'complete') this.db.prepare("UPDATE work_tasks SET status='succeeded',progress=100,result=?,error=NULL,finished_at=?,updated_at=?,revision=revision+1 WHERE id=?").run(this.clean(content), at, at, row.id);
      if (kind === 'cancel') this.db.prepare("UPDATE work_tasks SET status='cancelled',error=NULL,finished_at=?,updated_at=?,revision=revision+1 WHERE id=?").run(at, at, row.id);
      event = this.event(row, actor, kind, { ...(content ? { content: this.clean(content) } : {}), ...(kind === 'takeover' || kind === 'assign' ? { assigneeId: assignee?.id || null } : {}) }, at);
      if (content) message = this.insertMessage({ sessionId, actor, content, workTaskId: row.id, at });
    });
    if (kind === 'cancel' || kind === 'takeover' || kind === 'assign') this.active.get(sessionId)?.taskId === row.id && this.active.get(sessionId).controller.abort(new DOMException(kind === 'cancel' ? '任务已取消。' : '任务已由人工接手或转交，等待明确恢复。', 'AbortError'));
    this.emit(event); if (message) this.emitMessage(message); this.poke();
    return this.get(sessionId, taskId, actor);
  }
  cancel(sessionId, taskId, actor) { return this.action(sessionId, taskId, { action: 'cancel' }, actor); }
  takeover(sessionId, taskId, actor) { return this.action(sessionId, taskId, { action: 'takeover' }, actor); }
  assign(sessionId, taskId, assigneeId, actor) { return this.action(sessionId, taskId, { action: 'assign', assigneeId }, actor); }
  supplement(sessionId, taskId, content, actor) { return this.action(sessionId, taskId, { action: 'supplement', content }, actor); }
  resume(sessionId, taskId, actor) { return this.action(sessionId, taskId, { action: 'resume' }, actor); }
  complete(sessionId, taskId, content, actor) { return this.action(sessionId, taskId, { action: 'complete', content }, actor); }
  remove(sessionId, taskId, supplied) {
    const row = this.raw(sessionId, taskId), actor = this.actor(sessionId, supplied, 'delete', this.view(row)); this.manageable(row, actor);
    if (['queued', 'running', 'waiting_human'].includes(row.status) || this.active.get(sessionId)?.taskId === row.id) throw new HttpError(409, '请先结束任务，再删除。');
    // Keep deduplication keys, events and truthful transcript authorship. A
    // delayed retry must never recreate an externally executed deleted task.
    let event;
    this.store.transaction(() => {
      const at = this.at();
      this.db.prepare('UPDATE work_tasks SET deleted_at=?,updated_at=?,revision=revision+1 WHERE id=?').run(at, at, row.id);
      event = this.event(row, actor, 'deleted', {}, at);
    });
    this.emit(event);
    return { ok: true };
  }
  dispatchActor(row, phase = 'dispatch') {
    const task = this.view(row), actor = this.actor(row.session_id, row.created_by, phase, task);
    if (row.assignee_id) this.actor(row.session_id, row.assignee_id, 'assignee', task);
    return actor;
  }
  progress(row, value) {
    const current = this.raw(row.session_id, row.id);
    if (current.status !== 'running' || current.attempt !== row.attempt) return false;
    this.dispatchActor(current, 'progress');
    const input = typeof value === 'number' ? { progress: value } : value;
    if (!input || typeof input !== 'object' || !Number.isFinite(input.progress) || input.progress < 0 || input.progress > 100) throw new HttpError(400, '进度须为 0 至 100。');
    const description = input.message === undefined ? current.progress_text : this.clean(text(input.message, '进度说明', 2000), 2000);
    let event;
    this.store.transaction(() => {
      this.db.prepare('UPDATE work_tasks SET progress=?,progress_text=?,updated_at=?,revision=revision+1 WHERE id=?').run(input.progress, description, this.at(), row.id);
      event = this.event(current, null, 'progress', { progress: input.progress, message: description });
    });
    this.emit(event); return true;
  }
  finish(row, status, result, error) {
    const current = this.raw(row.session_id, row.id);
    if (current.status !== 'running' || current.attempt !== row.attempt) return;
    const at = this.at(); let event, message;
    this.store.transaction(() => {
      this.db.prepare('UPDATE work_tasks SET status=?,progress=?,result=?,error=?,finished_at=?,updated_at=?,revision=revision+1 WHERE id=?')
        .run(status, status === 'succeeded' ? 100 : current.progress, result, error, at, at, row.id);
      event = this.event(current, null, status, { title: current.title, attempt: current.attempt, ...(error ? { error } : {}) }, at);
      const card = taskResultCard({ id: current.id, title: current.title, status, result, error, attempt: current.attempt, finishedAt: at,
        startedAt: current.started_at, createdByName: current.created_by_name, assigneeName: current.assignee_name }, 'work');
      message = this.insertMessage({ sessionId: row.session_id, role: 'assistant', content: status === 'succeeded' ? result : `任务「${current.title}」执行失败：${error}`, workTaskId: row.id, at, cards: card ? [card] : [] });
    });
    this.emit(event); this.emitMessage(message);
  }
  tick() {
    if (this.stopping || this.ticking) return 0;
    this.ticking = true; let dispatched = 0;
    try {
      const rows = this.db.prepare("SELECT * FROM work_tasks WHERE status='queued' ORDER BY queue_order,seq").all();
      const considered = new Set();
      for (const row of rows) {
        if (this.active.size >= this.maxConcurrentGroups) break;
        if (considered.has(row.session_id) || this.active.has(row.session_id)) continue;
        considered.add(row.session_id);
        let actor;
        try { actor = this.dispatchActor(row); }
        catch {
          const at = this.at(); let event;
          this.store.transaction(() => {
            this.db.prepare("UPDATE work_tasks SET status='failed',error=?,finished_at=?,updated_at=?,revision=revision+1 WHERE id=?").run('任务创建人或负责人已失去执行权限，任务未启动。', at, at, row.id);
            event = this.event(row, null, 'failed', { reason: 'permission_revoked_before_dispatch' }, at);
          });
          this.emit(event); continue;
        }
        const at = this.at(); let event;
        this.store.transaction(() => {
          this.db.prepare("UPDATE work_tasks SET status='running',attempt=attempt+1,started_at=?,finished_at=NULL,error=NULL,updated_at=?,revision=revision+1 WHERE id=? AND status='queued'").run(at, at, row.id);
          event = this.event(row, actor, 'running', {}, at);
        });
        const running = this.raw(row.session_id, row.id), controller = new AbortController();
        const entry = { taskId: row.id, controller, promise: null };
        this.active.set(row.session_id, entry); this.emit(event); dispatched++;
        entry.promise = Promise.resolve().then(async () => {
          if (controller.signal.aborted) return;
          const latest = this.raw(row.session_id, row.id);
          if (latest.status !== 'running' || latest.attempt !== running.attempt) return;
          const currentActor = this.dispatchActor(latest);
          const task = this.view(latest, true);
          const output = await this.execute({ task, actor: currentActor, signal: controller.signal, onProgress: value => this.progress(running, value) });
          if (controller.signal.aborted) return;
          const fresh = this.raw(row.session_id, row.id);
          if (fresh.status !== 'running' || fresh.attempt !== running.attempt) return;
          this.dispatchActor(fresh, 'complete');
          const result = typeof output === 'string' ? output : output?.result ?? output?.reply;
          if (typeof result !== 'string' || !result.trim()) throw new Error('任务执行器未返回可验证的文字结果。');
          this.finish(running, 'succeeded', this.clean(result), null);
        }).catch(cause => {
          if (controller.signal.aborted) return;
          const denied = cause?.status === 401 || cause?.status === 403 || cause?.status === 404;
          this.finish(running, 'failed', null, denied ? '任务执行权限已失效，已停止输出。' : this.clean(cause?.message || '任务执行失败。', 2000));
        }).finally(() => { if (this.active.get(row.session_id) === entry) this.active.delete(row.session_id); this.poke(); });
      }
      return dispatched;
    } finally { this.ticking = false; }
  }
  poke() { if (this.started && !this.stopping) queueMicrotask(() => { if (this.started && !this.stopping) this.tick(); }); }
  invalidateUser(userId, sessionId) {
    id(userId, '成员编号'); if (sessionId !== undefined) id(sessionId, '群聊编号');
    const rows = this.db.prepare(`SELECT * FROM work_tasks WHERE (created_by=? OR assignee_id=?)
      AND status IN ('queued','running','waiting_human','interrupted')${sessionId === undefined ? '' : ' AND session_id=?'}`)
      .all(userId, userId, ...(sessionId === undefined ? [] : [sessionId]));
    const events = [];
    this.store.transaction(() => {
      for (const row of rows) {
        const at = this.at();
        this.db.prepare("UPDATE work_tasks SET status='cancelled',error=?,finished_at=?,updated_at=?,revision=revision+1 WHERE id=?")
          .run('任务创建人或负责人已失去群聊访问权限，任务已取消。', at, at, row.id);
        events.push(this.event(row, null, 'cancelled', { reason: 'permission_revoked', userId }, at));
      }
    });
    for (const row of rows) if (this.active.get(row.session_id)?.taskId === row.id) this.active.get(row.session_id).controller.abort(new DOMException('成员权限已撤销。', 'AbortError'));
    for (const event of events) this.emit(event);
    this.poke(); return rows.length;
  }
  start() {
    if (this.started) return;
    if (this.active.size) throw new HttpError(409, '上一轮执行尚未结束，请先等待关闭完成。');
    this.stopping = false; this.started = true;
    this.timer = setInterval(() => this.tick(), this.pollIntervalMs); this.timer.unref?.(); this.poke();
  }
  async stop({ drain = true } = {}) {
    this.started = false; this.stopping = true; clearInterval(this.timer); this.timer = null;
    const active = [...this.active.values()];
    for (const entry of active) {
      const row = this.db.prepare('SELECT * FROM work_tasks WHERE id=?').get(entry.taskId);
      if (row?.status === 'running') {
        const at = this.at(); let event;
        this.store.transaction(() => {
          this.db.prepare("UPDATE work_tasks SET status='interrupted',error=?,finished_at=?,updated_at=?,revision=revision+1 WHERE id=?").run('服务关闭，任务已中断；请先核对已执行的操作，再明确恢复。', at, at, row.id);
          event = this.event(row, null, 'interrupted', { reason: 'shutdown' }, at);
        });
        this.emit(event);
      }
      entry.controller.abort(new DOMException('服务正在关闭。', 'AbortError'));
    }
    if (drain) await Promise.allSettled(active.map(entry => entry.promise));
  }
}
