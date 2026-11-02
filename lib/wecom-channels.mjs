import { createHash, randomUUID } from 'node:crypto';
import { HttpError } from './security.mjs';
import { WecomClient } from './wecom-client.mjs';

const iso = () => new Date().toISOString();
const denied = () => new HttpError(403, '企业微信渠道已停用、解绑或失去群聊访问权限。');
const digest = value => createHash('sha256').update(value).digest('hex').slice(0, 20);
function name(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) throw new HttpError(400, '渠道名称须为 1 至 80 个字符。');
  return value.trim();
}
function identifier(value, limit = 2048) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > limit || /[\u0000-\u0020\u007f]/.test(value.trim())) throw new HttpError(400, '请填写有效的企业微信配置。');
  return value.trim();
}
function parts(text) {
  const result = []; let chunk = ''; let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (bytes + size > 3800) { result.push(chunk); chunk = ''; bytes = 0; }
    chunk += char; bytes += size;
  }
  if (chunk) result.push(chunk);
  return result;
}

/** A transport owns one explicitly selected external conversation and one Web group. */
export class WecomService {
  constructor(store, { clientFactory = options => new WecomClient(options), onMessage = async () => {}, audit = () => {}, now = Date.now, retryMs = 1500, pollIntervalMs = 100, autoStart = false } = {}) {
    this.store = store; this.db = store.db; this.clientFactory = clientFactory; this.onMessage = onMessage; this.audit = audit; this.now = now;
    this.retryMs = Math.max(10, Number(retryMs) || 1500); this.interval = Math.max(10, Number(pollIntervalMs) || 100);
    this.started = false; this.closed = false; this.clients = new Map(); this.groups = new Map(); this.senders = new Map(); this.actors = new WeakMap(); this.work = new Set();
    this.db.exec(`CREATE TABLE IF NOT EXISTS wecom_channels (
      id TEXT PRIMARY KEY,name TEXT NOT NULL,owner_id TEXT NOT NULL,bot_id TEXT NOT NULL UNIQUE,secret TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'disconnected',session_id TEXT,bound_by TEXT,
      binding_epoch INTEGER NOT NULL DEFAULT 0,bound_at INTEGER NOT NULL DEFAULT 0,target_id TEXT,target_type TEXT,
      last_error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS wecom_conversations (
      channel_id TEXT NOT NULL,target_id TEXT NOT NULL,chat_type TEXT NOT NULL,last_seen INTEGER NOT NULL,
      PRIMARY KEY(channel_id,target_id,chat_type));
      CREATE TABLE IF NOT EXISTS wecom_observed_members (
      channel_id TEXT NOT NULL,target_id TEXT NOT NULL,chat_type TEXT NOT NULL,user_id TEXT NOT NULL,last_seen INTEGER NOT NULL,
      PRIMARY KEY(channel_id,target_id,chat_type,user_id));
      CREATE TABLE IF NOT EXISTS wecom_inbox (
      id TEXT PRIMARY KEY,channel_id TEXT NOT NULL,message_id TEXT NOT NULL,session_id TEXT NOT NULL,binding_epoch INTEGER NOT NULL,
      user_id TEXT NOT NULL,text TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,last_error TEXT,created_at TEXT NOT NULL,finished_at TEXT,UNIQUE(channel_id,message_id));
      CREATE TABLE IF NOT EXISTS wecom_outbox (
      id TEXT PRIMARY KEY,channel_id TEXT NOT NULL,session_id TEXT NOT NULL,binding_epoch INTEGER NOT NULL,dedupe_key TEXT NOT NULL,
      text TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,created_at TEXT NOT NULL,finished_at TEXT,UNIQUE(channel_id,binding_epoch,dedupe_key));
      CREATE INDEX IF NOT EXISTS wecom_inbox_due ON wecom_inbox(status,session_id,next_attempt_at);
      CREATE INDEX IF NOT EXISTS wecom_outbox_due ON wecom_outbox(status,channel_id,next_attempt_at);`);
    this.db.prepare("UPDATE wecom_channels SET status='disconnected'").run();
    this.db.prepare("UPDATE wecom_inbox SET status='interrupted',last_error=?,finished_at=? WHERE status='running'").run('服务重启，先前任务已中断，请确认结果后重新发送。', iso());
    this.db.prepare("UPDATE wecom_outbox SET status='pending' WHERE status='sending'").run();
    if (autoStart) this.start();
  }
  _row(id) { const row = this.db.prepare('SELECT * FROM wecom_channels WHERE id=?').get(id); if (!row) throw new HttpError(404, '消息渠道不存在。'); return row; }
  _admin(actor) {
    const user = actor?.id && this.db.prepare('SELECT role,disabled FROM users WHERE id=?').get(actor.id);
    if (!user || user.disabled || user.role !== 'admin') throw new HttpError(403, '需要管理员权限。');
  }
  _authorized(row, binding = true) {
    if (!row) return false;
    const owner = this.db.prepare('SELECT role,disabled FROM users WHERE id=?').get(row.owner_id);
    if (!owner || owner.disabled || owner.role !== 'admin') return false;
    if (!binding) return true;
    if (this.store.sessions.find(meta => meta.id === row.session_id)?.deletedAt) return false;
    if (!row.session_id || !this.db.prepare('SELECT id FROM session_meta WHERE id=?').get(row.session_id)) return false;
    const binder = this.db.prepare('SELECT u.role,u.disabled FROM users u JOIN group_members m ON m.user_id=u.id WHERE u.id=? AND m.session_id=?').get(row.bound_by, row.session_id);
    return Boolean(binder && !binder.disabled && binder.role === 'admin');
  }
  _canAccess(row) { return Boolean(row?.enabled && row.target_id && this._authorized(row)); }
  _ready(row) { return Boolean(this._canAccess(row) && row.status === 'connected'); }
  _public(row) {
    const allowed = this._authorized(row, false) && (!row.session_id || this._authorized(row));
    return { id: row.id, name: row.name, type: 'wecom', platform: 'wecom', enabled: Boolean(row.enabled),
      status: allowed ? row.status : 'unavailable', connected: Boolean(allowed && row.enabled && row.status === 'connected'), canReceive: this._ready(row),
      botId: row.bot_id, secretSet: Boolean(row.secret), target: row.target_id ? { id: row.target_id, chatType: row.target_type } : null,
      sessionId: row.session_id || null, boundSessionId: row.session_id || null, sessionTitle: this.store.sessions.find(item => item.id === row.session_id)?.title || null,
      lastError: allowed ? row.last_error : '绑定管理员已停用或不再是群成员，请管理员重新绑定。', createdAt: row.created_at, updatedAt: row.updated_at };
  }
  list() { return this.db.prepare('SELECT * FROM wecom_channels ORDER BY created_at,id').all().map(row => this._public(row)); }
  get(id) { return this._public(this._row(id)); }
  create(body, actor) {
    this._admin(actor); const channelName = name(body?.name), botId = identifier(body?.botId), secret = identifier(body?.secret, 8192);
    if (this.db.prepare('SELECT id FROM wecom_channels WHERE bot_id=?').get(botId)) throw new HttpError(409, '此企业微信机器人已配置，请使用原渠道。');
    const id = randomUUID(), at = iso();
    this.db.prepare('INSERT INTO wecom_channels(id,name,owner_id,bot_id,secret,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(id, channelName, actor.id, botId, secret, at, at);
    this.audit('channel.created', actor, id, { platform: 'wecom', name: channelName });
    if (this.started) this._connect(this._row(id));
    return this.get(id);
  }
  _track(promise) { this.work.add(promise); promise.catch(() => {}).finally(() => this.work.delete(promise)); return promise; }
  _stop(id) {
    const entry = this.clients.get(id); this.clients.delete(id);
    if (entry) this._track(Promise.resolve().then(() => entry.client.close()).catch(() => {}));
  }
  _revoke(id) {
    this.senders.get(id)?.controller.abort();
    for (const entry of this.groups.values()) if (entry.channelId === id) entry.controller.abort();
    for (const table of ['wecom_inbox', 'wecom_outbox']) this.db.prepare(`UPDATE ${table} SET status='cancelled',finished_at=?,last_error=? WHERE channel_id=? AND status IN ('pending','running','sending')`).run(iso(), '渠道绑定或权限已变更。', id);
  }
  _connect(row) {
    if (this.closed || !row.enabled || !this._authorized(row, false) || this.clients.has(row.id)) return;
    const entry = {}; this.clients.set(row.id, entry);
    const active = () => !this.closed && this.clients.get(row.id) === entry;
    this.db.prepare("UPDATE wecom_channels SET status='connecting',last_error=NULL WHERE id=?").run(row.id);
    try {
      entry.client = this.clientFactory({ botId: row.bot_id, secret: row.secret,
        onMessage: message => { if (active()) this._receive(row.id, message); },
        onState: state => {
          if (!active()) return;
          const current = this.db.prepare('SELECT * FROM wecom_channels WHERE id=?').get(row.id);
          if (!current?.enabled || !this._authorized(current, false)) return;
          const status = ['connecting', 'connected', 'disconnected', 'error'].includes(state?.status) ? state.status : 'error';
          this.db.prepare('UPDATE wecom_channels SET status=?,last_error=?,updated_at=? WHERE id=?').run(status, status === 'error' ? '企业微信连接失败，请检查 Bot ID、Secret 和连接状态后重试。' : null, iso(), row.id);
          this._wake();
        } });
      const started = entry.client.start();
      if (started?.then) this._track(Promise.resolve(started).catch(() => {
        if (active()) this.db.prepare("UPDATE wecom_channels SET status='error',last_error=? WHERE id=?").run('企业微信连接失败，请检查配置后重试。', row.id);
      }));
    } catch {
      if (active()) this.db.prepare("UPDATE wecom_channels SET status='error',last_error=? WHERE id=?").run('企业微信连接失败，请检查配置后重试。', row.id);
      this._stop(row.id);
    }
  }
  connect(id, actor) {
    this._admin(actor); const row = this._row(id);
    if (!row.enabled || !this._authorized(row, false)) throw denied();
    this._stop(id); this._connect(row); return this.get(id);
  }
  update(id, body, actor) {
    this._admin(actor); const row = this._row(id), channelName = 'name' in body ? name(body.name) : row.name;
    if ('enabled' in body && typeof body.enabled !== 'boolean') throw new HttpError(400, 'enabled 须为布尔值。');
    const enabled = 'enabled' in body ? Number(body.enabled) : row.enabled;
    const botId = 'botId' in body ? identifier(body.botId) : row.bot_id, secret = 'secret' in body && body.secret !== '' ? identifier(body.secret, 8192) : row.secret;
    if (this.db.prepare('SELECT id FROM wecom_channels WHERE bot_id=? AND id<>?').get(botId, id)) throw new HttpError(409, '此企业微信机器人已配置，请使用原渠道。');
    const credentials = botId !== row.bot_id || secret !== row.secret;
    let targetId = row.target_id, targetType = row.target_type;
    if ('target' in body) {
      if (body.target === null) { targetId = null; targetType = null; }
      else {
        targetId = identifier(body.target?.id); targetType = body.target?.chatType;
        if (!['group', 'single'].includes(targetType) || credentials || !this.db.prepare('SELECT 1 FROM wecom_conversations WHERE channel_id=? AND target_id=? AND chat_type=?').get(id, targetId, targetType)) throw new HttpError(400, '请先在企业微信向机器人发送消息，再选择已发现的会话。');
      }
    }
    if (credentials) { targetId = null; targetType = null; }
    const changed = credentials || row.enabled !== enabled || targetId !== row.target_id || targetType !== row.target_type;
    if (changed) this._revoke(id);
    if (credentials || !enabled) this._stop(id);
    this.store.transaction(() => {
      if (credentials) for (const table of ['wecom_conversations', 'wecom_observed_members']) this.db.prepare(`DELETE FROM ${table} WHERE channel_id=?`).run(id);
      this.db.prepare('UPDATE wecom_channels SET name=?,enabled=?,bot_id=?,secret=?,target_id=?,target_type=?,binding_epoch=binding_epoch+?,bound_at=?,status=?,last_error=NULL,updated_at=? WHERE id=?')
        .run(channelName, enabled, botId, secret, targetId, targetType, Number(changed), changed ? this.now() : row.bound_at, credentials || !enabled ? 'disconnected' : row.status, iso(), id);
    });
    if (this.started && enabled) this._connect(this._row(id));
    this.audit('channel.updated', actor, id, { platform: 'wecom', name: channelName, enabled: Boolean(enabled), credentialsChanged: credentials });
    this._wake(); return this.get(id);
  }
  remove(id, actor) {
    this._admin(actor); this._row(id); this._revoke(id); this._stop(id);
    this.store.transaction(() => {
      for (const table of ['wecom_conversations', 'wecom_observed_members', 'wecom_inbox', 'wecom_outbox']) this.db.prepare(`DELETE FROM ${table} WHERE channel_id=?`).run(id);
      this.db.prepare('DELETE FROM wecom_channels WHERE id=?').run(id);
    });
    this.audit('channel.deleted', actor, id, { platform: 'wecom' }); return { ok: true };
  }
  validateBindings(ids, sessionId = null) {
    if (!Array.isArray(ids) || ids.length > 20 || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new HttpError(400, '请选择不重复的消息渠道，最多 20 个。');
    for (const id of ids) {
      const row = this._row(id);
      if (row.session_id && row.session_id !== sessionId) throw new HttpError(409, '此消息渠道已绑定其他群聊，请先在原群解绑。');
      if (!this._authorized(row, false)) throw denied();
    }
    return true;
  }
  bind(sessionId, ids, actor) {
    this._admin(actor); this.validateBindings(ids, sessionId);
    if (!this.db.prepare('SELECT id FROM session_meta WHERE id=?').get(sessionId)) throw new HttpError(404, '群聊不存在。');
    if (!this.db.prepare('SELECT 1 FROM group_members WHERE session_id=? AND user_id=?').get(sessionId, actor.id)) throw new HttpError(403, '请先加入群聊再配置消息渠道。');
    const desired = new Set(ids), existing = this.db.prepare('SELECT * FROM wecom_channels WHERE session_id=?').all(sessionId);
    const changes = [...existing.filter(row => !desired.has(row.id)).map(row => [row, null]), ...ids.map(id => this._row(id)).filter(row => row.session_id !== sessionId || row.bound_by !== actor.id || !this._authorized(row)).map(row => [row, sessionId])];
    for (const [row] of changes) this._revoke(row.id);
    this.store.transaction(() => { for (const [row, target] of changes) this.db.prepare('UPDATE wecom_channels SET session_id=?,bound_by=?,binding_epoch=binding_epoch+1,bound_at=?,updated_at=? WHERE id=?').run(target, target ? actor.id : null, this.now(), iso(), row.id); });
    this.audit('channel.bound', actor, sessionId, { platform: 'wecom', channelIds: ids }); this._wake(); return this.forSession(sessionId);
  }
  forSession(sessionId) { return this.db.prepare('SELECT * FROM wecom_channels WHERE session_id=? ORDER BY created_at,id').all(sessionId).map(row => this._public(row)); }
  conversations(id, actor) {
    this._admin(actor); this._row(id);
    return this.db.prepare(`SELECT c.*,COUNT(m.user_id) AS members FROM wecom_conversations c LEFT JOIN wecom_observed_members m
      ON c.channel_id=m.channel_id AND c.target_id=m.target_id AND c.chat_type=m.chat_type WHERE c.channel_id=? GROUP BY c.target_id,c.chat_type ORDER BY c.last_seen DESC`).all(id)
      .map(row => ({ id: row.target_id, chatType: row.chat_type, label: `${row.chat_type === 'group' ? '企微群聊' : '企微单聊'} · ***${row.target_id.slice(-4)}`, lastSeen: new Date(row.last_seen).toISOString(), memberCount: row.members }));
  }
  _member(row, userId) { return { id: `wecom:${row.id}:${digest(userId)}`, displayName: `企微 · ***${userId.slice(-4).replace(/[^\p{L}\p{N}_-]/gu, '') || '成员'}`, role: 'member', source: 'wecom', channelId: row.id, external: true }; }
  externalMembers(sessionId) {
    return this.db.prepare('SELECT * FROM wecom_channels WHERE session_id=?').all(sessionId).filter(row => this._canAccess(row)).flatMap(row => {
      const members = this.db.prepare('SELECT user_id FROM wecom_observed_members WHERE channel_id=? AND target_id=? AND chat_type=?').all(row.id, row.target_id, row.target_type);
      return members.length ? members.map(member => this._member(row, member.user_id)) : [{ id: `wecom:${row.id}`, displayName: `企微 · ${row.name}`, source: 'wecom', channelId: row.id, external: true, role: 'member' }];
    });
  }
  assertActor(sessionId, actor) {
    const stamp = actor && this.actors.get(actor), row = stamp && this.db.prepare('SELECT * FROM wecom_channels WHERE id=?').get(stamp.channelId);
    if (!stamp || actor.role !== 'member' || actor.source !== 'wecom' || actor.channelId !== stamp.channelId || actor.id !== `wecom:${stamp.channelId}:${digest(stamp.userId)}` || !this._canAccess(row) || row.session_id !== sessionId || row.binding_epoch !== stamp.epoch) throw denied();
    return true;
  }
  invalidateUser(userId) {
    if (this.closed) return;
    for (const row of this.db.prepare('SELECT * FROM wecom_channels WHERE owner_id=? OR bound_by=?').all(userId, userId)) {
      if (!this._authorized(row, false) || row.session_id && !this._authorized(row)) {
        this._revoke(row.id);
        this.db.prepare('UPDATE wecom_channels SET binding_epoch=binding_epoch+1,bound_at=? WHERE id=?').run(this.now(), row.id);
        if (!this._authorized(row, false)) this._stop(row.id);
      }
    }
  }
  _receive(id, message) {
    const row = this.db.prepare('SELECT * FROM wecom_channels WHERE id=?').get(id);
    if (!row?.enabled || row.status !== 'connected' || !this._authorized(row, false) || !message || message.botId !== row.bot_id) return;
    if (!['group', 'single'].includes(message.chatType) || !message.userId || !message.targetId || !message.messageId || typeof message.text !== 'string' || !message.text.trim() || message.text.length > 100000 || /\u0000/.test(message.text) || !Number.isFinite(message.timestamp) || message.timestamp <= 0) return;
    try { identifier(message.userId); identifier(message.targetId); identifier(message.messageId, 512); } catch { return; }
    if (message.userId === row.bot_id || message.chatType === 'single' && message.targetId !== message.userId) return;
    this.store.transaction(() => {
      this.db.prepare('INSERT INTO wecom_conversations(channel_id,target_id,chat_type,last_seen) VALUES (?,?,?,?) ON CONFLICT(channel_id,target_id,chat_type) DO UPDATE SET last_seen=excluded.last_seen').run(id, message.targetId, message.chatType, this.now());
      this.db.prepare('INSERT INTO wecom_observed_members(channel_id,target_id,chat_type,user_id,last_seen) VALUES (?,?,?,?,?) ON CONFLICT(channel_id,target_id,chat_type,user_id) DO UPDATE SET last_seen=excluded.last_seen').run(id, message.targetId, message.chatType, message.userId, this.now());
      if (!this._ready(row) || message.targetId !== row.target_id || message.chatType !== row.target_type || message.timestamp < row.bound_at) return;
      this.db.prepare('INSERT OR IGNORE INTO wecom_inbox(id,channel_id,message_id,session_id,binding_epoch,user_id,text,created_at) VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(), id, message.messageId, row.session_id, row.binding_epoch, message.userId, message.text, iso());
    });
    this._wake();
  }
  _enqueue(row, text, key) {
    let queued = 0;
    for (const [index, part] of parts(text).entries()) queued += Number(this.db.prepare('INSERT OR IGNORE INTO wecom_outbox(id,channel_id,session_id,binding_epoch,dedupe_key,text,created_at) VALUES (?,?,?,?,?,?,?)').run(randomUUID(), row.id, row.session_id, row.binding_epoch, `${key}:${index}`, part, iso()).changes);
    return queued;
  }
  publish(sessionId, { text, authorName, excludeChannelId, messageId, onlyChannels = null } = {}) {
    if (this.closed || typeof text !== 'string' || !text.trim() || text.length > 100000 || /\u0000/.test(text)) return { queued: 0 };
    const content = authorName ? `${String(authorName).slice(0, 80)}：\n${text}` : text, key = messageId || randomUUID(); let queued = 0;
    this.store.transaction(() => { for (const row of this.db.prepare('SELECT * FROM wecom_channels WHERE session_id=?').all(sessionId)) if (row.id !== excludeChannelId && this._canAccess(row)
      && (!onlyChannels || onlyChannels.some(target => target.id === row.id && target.epoch === row.binding_epoch))) queued += this._enqueue(row, content, key); });
    this._wake(); return { queued };
  }
  start() {
    if (this.started || this.closed) return;
    this.started = true;
    for (const row of this.db.prepare('SELECT * FROM wecom_channels WHERE enabled=1').all()) this._connect(row);
    this.timer = setInterval(() => this._tick(), this.interval); this.timer.unref?.(); this._wake();
  }
  _wake() { if (this.started && !this.closed) queueMicrotask(() => { if (!this.closed) this._tick(); }); }
  _tick() {
    if (this.closed || !this.started) return;
    for (const { session_id: id } of this.db.prepare("SELECT DISTINCT session_id FROM wecom_inbox WHERE status='pending'").all()) if (!this.groups.has(id)) this._run(id);
    for (const row of this.db.prepare("SELECT * FROM wecom_channels WHERE enabled=1 AND status='connected'").all()) if (!this.senders.has(row.id) && this._ready(row)) this._send(row);
  }
  _run(sessionId) {
    const controller = new AbortController(), entry = { controller, channelId: null }; this.groups.set(sessionId, entry);
    entry.promise = this._track((async () => {
      await Promise.resolve();
      const pending = this.db.prepare("SELECT * FROM wecom_inbox WHERE status='pending' AND session_id=? ORDER BY created_at,rowid LIMIT 1").get(sessionId);
      if (!pending || pending.next_attempt_at > this.now() || this.closed) return;
      entry.channelId = pending.channel_id; const row = this.db.prepare('SELECT * FROM wecom_channels WHERE id=?').get(pending.channel_id);
      if (!row?.enabled || !row.target_id || !this._authorized(row) || row.session_id !== sessionId || row.binding_epoch !== pending.binding_epoch) {
        this.db.prepare("UPDATE wecom_inbox SET status='cancelled',finished_at=? WHERE id=?").run(iso(), pending.id); return;
      }
      if (row.status !== 'connected') return;
      const actor = this._member(row, pending.user_id); this.actors.set(actor, { channelId: row.id, epoch: row.binding_epoch, userId: pending.user_id });
      this.db.prepare("UPDATE wecom_inbox SET status='running',attempts=attempts+1 WHERE id=?").run(pending.id);
      try {
        this.assertActor(sessionId, actor);
        await this.onMessage({ sessionId, channel: this._public(row), actor, message: { id: pending.id, messageId: pending.message_id, text: pending.text }, signal: controller.signal });
        if (!this.closed) this.db.prepare("UPDATE wecom_inbox SET status=?,finished_at=? WHERE id=? AND status='running'").run(controller.signal.aborted ? 'cancelled' : 'done', iso(), pending.id);
      } catch (error) {
        if (this.closed) return;
        const current = this.db.prepare('SELECT * FROM wecom_channels WHERE id=?').get(pending.channel_id);
        const cancelled = controller.signal.aborted || error?.name === 'AbortError' || !this._canAccess(current) || current.binding_epoch !== pending.binding_epoch;
        if (!cancelled && error?.status === 409 && pending.attempts < 120) this.db.prepare("UPDATE wecom_inbox SET status='pending',next_attempt_at=?,last_error=? WHERE id=? AND status='running'").run(this.now() + this.retryMs, '群聊正在处理其他任务，等待执行。', pending.id);
        else {
          this.db.prepare("UPDATE wecom_inbox SET status=?,finished_at=?,last_error=? WHERE id=? AND status='running'").run(cancelled ? 'cancelled' : 'failed', iso(), '任务已停止或执行失败，请在 Web 群聊查看状态。', pending.id);
          if (!cancelled && ![401, 403].includes(error?.status)) this._enqueue(current, '任务暂时未能完成，请在 Web 群聊查看状态或稍后重试。', `${pending.id}:failure`);
        }
      }
    })().finally(() => { if (this.groups.get(sessionId) === entry) this.groups.delete(sessionId); }));
  }
  _send(snapshot) {
    const pending = this.db.prepare("SELECT * FROM wecom_outbox WHERE channel_id=? AND status='pending' ORDER BY created_at,rowid LIMIT 1").get(snapshot.id);
    if (!pending || pending.next_attempt_at > this.now()) return;
    if (snapshot.binding_epoch !== pending.binding_epoch || snapshot.session_id !== pending.session_id) {
      this.db.prepare("UPDATE wecom_outbox SET status='cancelled',finished_at=? WHERE id=?").run(iso(), pending.id); return;
    }
    const controller = new AbortController(), entry = { controller }; this.senders.set(snapshot.id, entry);
    entry.promise = this._track((async () => {
      await Promise.resolve();
      if (this.closed || controller.signal.aborted) return;
      this.db.prepare("UPDATE wecom_outbox SET status='sending',attempts=attempts+1 WHERE id=? AND status='pending'").run(pending.id);
      try {
        const current = this._row(snapshot.id), client = this.clients.get(snapshot.id)?.client;
        if (!this._canAccess(current) || current.binding_epoch !== pending.binding_epoch || current.session_id !== pending.session_id) throw denied();
        if (!client || current.status !== 'connected') {
          this.db.prepare("UPDATE wecom_outbox SET status='pending',attempts=attempts-1 WHERE id=? AND status='sending'").run(pending.id); return;
        }
        await client.sendText({ targetId: current.target_id, text: pending.text, clientId: pending.id, signal: controller.signal });
        if (!this.closed) this.db.prepare("UPDATE wecom_outbox SET status='sent',finished_at=?,last_error=NULL WHERE id=? AND status='sending'").run(iso(), pending.id);
      } catch (error) {
        if (this.closed) return;
        if (!controller.signal.aborted && !(error instanceof HttpError) && pending.attempts < 4) this.db.prepare("UPDATE wecom_outbox SET status='pending',next_attempt_at=?,last_error=? WHERE id=? AND status='sending'").run(this.now() + this.retryMs * 2 ** pending.attempts, '企业微信发送暂时失败，正在重试。', pending.id);
        else this.db.prepare("UPDATE wecom_outbox SET status=?,finished_at=?,last_error=? WHERE id=? AND status='sending'").run(controller.signal.aborted ? 'cancelled' : 'failed', iso(), '企业微信消息未能送达。', pending.id);
      }
    })().finally(() => { if (this.senders.get(snapshot.id) === entry) this.senders.delete(snapshot.id); }));
  }
  close() { return this.closePromise ||= this._close(); }
  async _close() {
    this.closed = true; this.started = false; clearInterval(this.timer);
    for (const map of [this.groups, this.senders]) for (const entry of map.values()) entry.controller.abort();
    for (const id of [...this.clients.keys()]) this._stop(id);
    await Promise.allSettled([...this.work]);
    this.db.prepare("UPDATE wecom_inbox SET status='interrupted',finished_at=?,last_error=? WHERE status='running'").run(iso(), '服务关闭，任务中断，请确认结果后重新发送。');
    this.db.prepare("UPDATE wecom_outbox SET status='pending' WHERE status='sending'").run();
  }
}
