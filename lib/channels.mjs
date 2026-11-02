import { randomUUID } from 'node:crypto';
import { HttpError } from './security.mjs';
import { WeixinClient, normalizeIncomingMessage } from './weixin-client.mjs';

const LOGIN_TTL = 5 * 60_000;
const LOGIN_TERMINAL = new Set(['expired', 'confirmed', 'verify_code_blocked']);
const nowIso = () => new Date().toISOString();
const adminError = () => new HttpError(403, '需要管理员权限。');
const unavailable = () => new HttpError(403, '微信渠道已停用、解绑或不再拥有此群聊的访问权限。');
// The official client's chunk threshold is 4000 UTF-16 code units. Using
// 2000 Unicode code points keeps surrogate pairs intact within that threshold.
const textParts = (value) => {
  const chars = Array.from(value); const parts = [];
  for (let index = 0; index < chars.length; index += 2000) parts.push(chars.slice(index, index + 2000).join(''));
  return parts;
};

function label(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) throw new HttpError(400, '渠道名称须为 1 至 80 个字符。');
  return value.trim();
}

/** A single confirmed scanner is the only external participant of each channel. */
export class ChannelService {
  constructor(store, { clientFactory = (options) => new WeixinClient(options), onMessage = async () => {}, audit = () => {},
    pollIntervalMs = 1000, loginPollIntervalMs = 2000, retryMs = 1500, now = Date.now, autoStart = false } = {}) {
    this.store = store; this.db = store.db; this.clientFactory = clientFactory; this.onMessage = onMessage; this.audit = audit; this.now = now;
    this.pollIntervalMs = Math.max(10, Number(pollIntervalMs) || 1000); this.retryMs = Math.max(10, Number(retryMs) || 1500);
    this.loginPollIntervalMs = Math.max(10, Number(loginPollIntervalMs) || 2000);
    this.started = false; this.closed = false; this.timer = null; this.polls = new Map(); this.groups = new Map(); this.senders = new Map();
    this.clients = new Map(); this.loginClients = new Map(); this.loginRequests = new Map(); this.actors = new WeakMap(); this.work = new Set();
    this.db.exec(`CREATE TABLE IF NOT EXISTS im_channels (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL DEFAULT 'weixin', enabled INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'login_required', owner_id TEXT NOT NULL, account_id TEXT, scanner_id TEXT,
      auth_token TEXT, base_url TEXT, cursor TEXT NOT NULL DEFAULT '', session_id TEXT, bound_by TEXT,
      binding_epoch INTEGER NOT NULL DEFAULT 0, bound_at INTEGER NOT NULL DEFAULT 0, context_token TEXT, last_error TEXT,
      next_poll_at INTEGER NOT NULL DEFAULT 0, poll_failures INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS im_channel_logins (
      id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, qrcode TEXT NOT NULL, qr_content TEXT NOT NULL,
      status TEXT NOT NULL, base_url TEXT, expires_at INTEGER NOT NULL, created_at TEXT NOT NULL,
      created_by TEXT, next_poll_at INTEGER NOT NULL DEFAULT 0, poll_failures INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS im_channel_logins_channel ON im_channel_logins(channel_id);
      CREATE TABLE IF NOT EXISTS im_channel_inbox (
      id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, message_id TEXT NOT NULL, session_id TEXT,
      binding_epoch INTEGER NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0, last_error TEXT,
      created_at TEXT NOT NULL, finished_at TEXT, UNIQUE(channel_id,message_id));
      CREATE INDEX IF NOT EXISTS im_channel_inbox_due ON im_channel_inbox(status,session_id,next_attempt_at);
      CREATE TABLE IF NOT EXISTS im_channel_outbox (
      id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, session_id TEXT NOT NULL, binding_epoch INTEGER NOT NULL,
      dedupe_key TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0, last_error TEXT,
      created_at TEXT NOT NULL, finished_at TEXT, UNIQUE(channel_id,binding_epoch,dedupe_key));
      CREATE INDEX IF NOT EXISTS im_channel_outbox_due ON im_channel_outbox(status,channel_id,next_attempt_at);`);
    if (!this.db.prepare('PRAGMA table_info(im_channels)').all().some((column) => column.name === 'bound_at')) {
      this.db.exec('ALTER TABLE im_channels ADD COLUMN bound_at INTEGER NOT NULL DEFAULT 0');
    }
    const loginColumns = new Set(this.db.prepare('PRAGMA table_info(im_channel_logins)').all().map((column) => column.name));
    for (const [name, declaration] of [['created_by', 'TEXT'], ['next_poll_at', 'INTEGER NOT NULL DEFAULT 0'], ['poll_failures', 'INTEGER NOT NULL DEFAULT 0']]) {
      if (!loginColumns.has(name)) this.db.exec(`ALTER TABLE im_channel_logins ADD COLUMN ${name} ${declaration}`);
    }
    // Older development databases may contain duplicate connections. Revoke all
    // conflicting credentials rather than selecting a group's access implicitly.
    const duplicateAccounts = this.db.prepare(`SELECT account_id FROM im_channels WHERE account_id IS NOT NULL AND auth_token IS NOT NULL
      GROUP BY account_id HAVING COUNT(*)>1`).all();
    for (const { account_id: accountId } of duplicateAccounts) {
      this.db.prepare(`UPDATE im_channels SET status='login_required',auth_token=NULL,context_token=NULL,
        binding_epoch=binding_epoch+1,last_error=? WHERE account_id=?`).run('检测到重复微信连接，请保留一个渠道后重新扫码。', accountId);
    }
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS im_channels_authenticated_account ON im_channels(account_id)
      WHERE account_id IS NOT NULL AND auth_token IS NOT NULL;`);
    // An interrupted Agent turn may already have performed business side effects.
    // Keep pending work, but never blindly execute such a turn again after a crash.
    this.db.prepare("UPDATE im_channel_inbox SET status='interrupted',finished_at=?,last_error=? WHERE status='running'")
      .run(nowIso(), '服务重启，先前任务已中断，请确认结果后重新发送。');
    this.db.prepare("UPDATE im_channel_outbox SET status='pending' WHERE status='sending'").run();
    this.db.prepare("DELETE FROM im_channel_logins WHERE expires_at<?").run(this.now() - LOGIN_TTL);
    if (autoStart) this.start();
  }

  _row(id) { const row = this.db.prepare('SELECT * FROM im_channels WHERE id=?').get(id); if (!row) throw new HttpError(404, '消息渠道不存在。'); return row; }
  _admin(actor) {
    const user = actor?.id && this.db.prepare('SELECT role,disabled FROM users WHERE id=?').get(actor.id);
    if (!user || user.disabled || user.role !== 'admin') throw adminError();
  }
  _authorized(row, requireBinding = true) {
    const owner = this.db.prepare('SELECT role,disabled FROM users WHERE id=?').get(row.owner_id);
    if (!owner || owner.disabled || owner.role !== 'admin') return false;
    if (!requireBinding || !row.session_id) return !requireBinding;
    if (this.store.sessions.find(meta => meta.id === row.session_id)?.deletedAt) return false;
    const binder = this.db.prepare(`SELECT u.role,u.disabled FROM users u JOIN group_members m ON m.user_id=u.id
      WHERE u.id=? AND m.session_id=?`).get(row.bound_by, row.session_id);
    return Boolean(binder && !binder.disabled && binder.role === 'admin' && this.db.prepare('SELECT id FROM session_meta WHERE id=?').get(row.session_id));
  }
  _ready(row) { return Boolean(row && row.enabled && row.status === 'connected' && row.auth_token && row.scanner_id && this._authorized(row)); }
  _public(row) {
    const permitted = this._authorized(row, false) && (!row.session_id || this._authorized(row));
    const meta = row.session_id && this.store.sessions.find((entry) => entry.id === row.session_id);
    return { id: row.id, name: row.name, platform: 'weixin', type: 'weixin', enabled: Boolean(row.enabled),
      status: permitted ? row.status : 'unavailable', connected: Boolean(permitted && row.enabled && row.status === 'connected'),
      accountLabel: row.scanner_id ? `微信账号 · ${row.scanner_id.length > 4 ? `***${row.scanner_id.slice(-4)}` : '***'}` : null,
      sessionId: row.session_id || null, boundSessionId: row.session_id || null, sessionTitle: meta?.title || null,
      externalMember: row.session_id && permitted && row.enabled && row.status === 'connected' ? this._member(row) : null,
      canReceive: Boolean(this._ready(row) && row.context_token), lastError: permitted ? row.last_error : '绑定管理员已停用或不再是群成员，请管理员重新绑定。',
      createdAt: row.created_at, updatedAt: row.updated_at };
  }
  _member(row) { return { id: `weixin:${row.id}`, displayName: `微信 · ${row.name}`, role: 'member', source: 'weixin', channelId: row.id, external: true }; }
  list() { return this.db.prepare('SELECT * FROM im_channels ORDER BY created_at,id').all().map((row) => this._public(row)); }
  get(id) { return this._public(this._row(id)); }
  create(body, actor) {
    this._admin(actor); const name = label(body?.name); const id = randomUUID(); const at = nowIso();
    this.db.prepare('INSERT INTO im_channels(id,name,owner_id,created_at,updated_at) VALUES (?,?,?,?,?)').run(id, name, actor.id, at, at);
    this.audit('channel.created', actor, id, { platform: 'weixin', name }); return this.get(id);
  }

  _client(row) {
    const previous = this.clients.get(row.id);
    if (previous?.token === row.auth_token && previous.baseUrl === row.base_url) return previous.client;
    const client = this.clientFactory({ token: row.auth_token, baseUrl: row.base_url || undefined });
    this.clients.set(row.id, { token: row.auth_token, baseUrl: row.base_url, client }); return client;
  }
  _track(promise) { this.work.add(promise); promise.catch(() => {}).finally(() => this.work.delete(promise)); return promise; }
  _revoke(id, reason = '微信渠道权限已变更。') {
    this.polls.get(id)?.controller.abort(new Error(reason));
    this.senders.get(id)?.controller.abort(new Error(reason));
    for (const entry of this.groups.values()) if (entry.channelId === id) entry.controller.abort(new Error(reason));
    this.db.prepare("UPDATE im_channel_inbox SET status='cancelled',finished_at=?,last_error=? WHERE channel_id=? AND status='pending'").run(nowIso(), reason, id);
    this.db.prepare("UPDATE im_channel_outbox SET status='cancelled',finished_at=?,last_error=? WHERE channel_id=? AND status IN ('pending','sending')").run(nowIso(), reason, id);
  }
  invalidateUser(userId) {
    if (this.closed) return;
    for (const row of this.db.prepare('SELECT * FROM im_channels WHERE owner_id=? OR bound_by=?').all(userId, userId)) {
      if (!this._authorized(row, false) || row.session_id && !this._authorized(row)) this._revoke(row.id);
    }
  }
  update(id, body, actor) {
    this._admin(actor); const row = this._row(id); const name = 'name' in body ? label(body.name) : row.name;
    if ('enabled' in body && typeof body.enabled !== 'boolean') throw new HttpError(400, 'enabled 须为布尔值。');
    const enabled = 'enabled' in body ? Number(body.enabled) : row.enabled;
    this.db.prepare('UPDATE im_channels SET name=?,enabled=?,updated_at=? WHERE id=?').run(name, enabled, nowIso(), id);
    if (!enabled) this._revoke(id, '管理员已停用微信渠道。');
    this.audit('channel.updated', actor, id, { name, enabled: Boolean(enabled) }); this._wake(); return this.get(id);
  }
  remove(id, actor) {
    this._admin(actor); this._row(id); this._revoke(id, '管理员已删除微信渠道。');
    for (const request of this.loginRequests.values()) if (request.channelId === id) request.controller.abort();
    this.store.transaction(() => {
      for (const table of ['im_channel_logins', 'im_channel_inbox', 'im_channel_outbox']) this.db.prepare(`DELETE FROM ${table} WHERE channel_id=?`).run(id);
      this.db.prepare('DELETE FROM im_channels WHERE id=?').run(id);
    });
    this.clients.delete(id); this.audit('channel.deleted', actor, id, {}); return { ok: true };
  }
  validateBindings(ids, sessionId = null) {
    if (!Array.isArray(ids) || ids.length > 20 || ids.some((id) => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new HttpError(400, '请选择不重复的消息渠道，最多 20 个。');
    for (const id of ids) {
      const row = this._row(id);
      if (row.session_id && row.session_id !== sessionId) throw new HttpError(409, '此消息渠道已绑定其他群聊，请先在原群解绑。');
      if (!this._authorized(row, false)) throw new HttpError(409, '渠道创建管理员已停用，请重新创建渠道。');
    }
    return true;
  }
  bind(sessionId, ids, actor) {
    this._admin(actor); this.validateBindings(ids, sessionId);
    if (!this.db.prepare('SELECT id FROM session_meta WHERE id=?').get(sessionId)) throw new HttpError(404, '群聊不存在。');
    if (!this.db.prepare('SELECT 1 FROM group_members WHERE session_id=? AND user_id=?').get(sessionId, actor.id)) throw new HttpError(403, '请先加入群聊再配置消息渠道。');
    const existing = this.db.prepare('SELECT * FROM im_channels WHERE session_id=?').all(sessionId); const desired = new Set(ids);
    const changes = [...existing.filter((row) => !desired.has(row.id)).map((row) => [row, null]),
      ...ids.map((id) => this._row(id)).filter((row) => row.session_id !== sessionId || row.bound_by !== actor.id || !this._authorized(row)).map((row) => [row, sessionId])];
    for (const [row] of changes) this._revoke(row.id, '管理员已修改微信渠道绑定。');
    this.store.transaction(() => {
      for (const [row, target] of changes) this.db.prepare('UPDATE im_channels SET session_id=?,bound_by=?,binding_epoch=binding_epoch+1,bound_at=?,context_token=NULL,updated_at=? WHERE id=?')
        .run(target, target ? actor.id : null, this.now(), nowIso(), row.id);
    });
    this.audit('channel.bound', actor, sessionId, { channelIds: ids }); this._wake(); return this.forSession(sessionId);
  }
  forSession(sessionId) { return this.db.prepare('SELECT * FROM im_channels WHERE session_id=? ORDER BY created_at,id').all(sessionId).map((row) => this._public(row)); }
  assertActor(sessionId, actor) {
    const stamp = actor && this.actors.get(actor); const row = stamp && this.db.prepare('SELECT * FROM im_channels WHERE id=?').get(stamp.channelId);
    if (!stamp || actor.source !== 'weixin' || actor.id !== `weixin:${stamp.channelId}` || actor.channelId !== stamp.channelId || !this._ready(row)
      || row.session_id !== sessionId || row.binding_epoch !== stamp.epoch || row.scanner_id !== stamp.scannerId) throw unavailable();
    return true;
  }

  _login(id, loginId) {
    const login = this.db.prepare('SELECT * FROM im_channel_logins WHERE id=? AND channel_id=?').get(loginId, id);
    if (!login) throw new HttpError(404, '扫码登录已更新，请重新获取二维码。');
    if (login.expires_at <= this.now() && !LOGIN_TERMINAL.has(login.status)) {
      this._endLogin(login, 'expired', '二维码已过期，请重新扫码。'); login.status = 'expired';
    }
    return login;
  }
  _endLogin(login, status, reason) {
    const current = this.db.prepare('SELECT status FROM im_channel_logins WHERE id=? AND channel_id=?').get(login.id, login.channel_id);
    if (!current || LOGIN_TERMINAL.has(current.status)) return;
    this.loginRequests.get(`status:${login.id}`)?.controller.abort(new Error(reason));
    this.db.prepare('UPDATE im_channel_logins SET status=?,next_poll_at=0 WHERE id=?').run(status, login.id);
    this.db.prepare("UPDATE im_channels SET status='login_required',last_error=?,updated_at=? WHERE id=? AND status='connecting'").run(reason, nowIso(), login.channel_id);
    this.loginClients.delete(login.id);
  }
  _loginAdmin(row, login, actor) {
    this._admin(actor); this._admin({ id: login.created_by || row.owner_id });
    if (!this._authorized(row, false)) throw unavailable();
  }
  _loginPublic(login) { return { id: login.id, status: login.status, expiresAt: new Date(login.expires_at).toISOString(), qrCodeUrl: `/api/admin/channels/${login.channel_id}/logins/${login.id}/qr.svg` }; }
  startLogin(...args) { return this._track(this._startLogin(...args)); }
  async _startLogin(id, actor) {
    this._admin(actor); if (!this._authorized(this._row(id), false)) throw unavailable();
    if (this.closed) throw new HttpError(503, '消息渠道服务正在关闭。');
    this.loginRequests.get(id)?.controller.abort(); const controller = new AbortController(); const request = { controller, channelId: id };
    this.loginRequests.set(id, request);
    try {
      const client = this.clientFactory({}); const qr = await client.getQrCode({ signal: controller.signal });
      if (this.closed || controller.signal.aborted) throw new HttpError(503, '扫码登录请求已停止。');
      this._admin(actor); if (!this._authorized(this._row(id), false)) throw unavailable();
      if (controller.signal.aborted || this.loginRequests.get(id) !== request) throw new HttpError(409, '扫码登录请求已更新。');
      if (typeof qr.qrcode !== 'string' || !qr.qrcode || typeof qr.qrCodeUrl !== 'string' || !qr.qrCodeUrl) throw new HttpError(502, '微信未返回有效二维码，请重试。');
      this._revoke(id, '管理员正在重新连接微信账号。');
      const loginId = randomUUID(); const expires = this.now() + LOGIN_TTL;
      this.store.transaction(() => {
        this.db.prepare('DELETE FROM im_channel_logins WHERE channel_id=?').run(id);
        this.db.prepare(`INSERT INTO im_channel_logins(id,channel_id,qrcode,qr_content,status,base_url,expires_at,created_at,created_by) VALUES (?,?,?,?,?,?,?,?,?)`)
          .run(loginId, id, qr.qrcode, qr.qrCodeUrl, 'wait', client.baseUrl || null, expires, nowIso(), actor.id);
        this.db.prepare("UPDATE im_channels SET status='connecting',auth_token=NULL,account_id=NULL,scanner_id=NULL,cursor='',context_token=NULL,binding_epoch=binding_epoch+1,bound_at=?,last_error=NULL,updated_at=? WHERE id=?").run(this.now(), nowIso(), id);
      });
      this.clients.delete(id); this.loginClients.set(loginId, client); this.audit('channel.login_started', actor, id, {});
      this._wake();
      return { channel: this.get(id), login: this._loginPublic(this._login(id, loginId)) };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, '微信扫码登录暂时不可用，请稍后重试。');
    } finally { if (this.loginRequests.get(id) === request) this.loginRequests.delete(id); }
  }
  qrContent(id, loginId, actor) { this._admin(actor); this._row(id); const login = this._login(id, loginId); if (LOGIN_TERMINAL.has(login.status)) throw new HttpError(410, '二维码已失效，请重新获取。'); return login.qr_content; }
  loginStatus(...args) { return this._track(this._loginStatus(...args)); }
  async _loginStatus(id, loginId, actor, verifyCode) {
    this._admin(actor); this._row(id); const login = this._login(id, loginId);
    if (this.closed) throw new HttpError(503, '消息渠道服务正在关闭。');
    if (LOGIN_TERMINAL.has(login.status) || login.status === 'need_verifycode' && !verifyCode) return { channel: this.get(id), login: this._loginPublic(login) };
    const lockId = `status:${loginId}`;
    if (this.loginRequests.has(lockId)) return { channel: this.get(id), login: this._loginPublic(login) };
    const controller = new AbortController(); const request = { controller, channelId: id }; this.loginRequests.set(lockId, request);
    try {
      this._loginAdmin(this._row(id), login, actor);
      const client = this.loginClients.get(loginId) || this.clientFactory({ baseUrl: login.base_url || undefined }); this.loginClients.set(loginId, client);
      const result = await client.getQrStatus(login.qrcode, { signal: controller.signal, verifyCode });
      if (this.closed || controller.signal.aborted) throw new HttpError(503, '扫码登录请求已停止。');
      this._loginAdmin(this._row(id), login, actor); const current = this._login(id, loginId);
      if (LOGIN_TERMINAL.has(current.status)) return { channel: this.get(id), login: this._loginPublic(current) };
      const status = typeof result.status === 'string' && ['wait', 'scaned', 'scaned_but_redirect', 'binded_redirect', 'confirmed', 'expired', 'need_verifycode', 'verify_code_blocked'].includes(result.status) ? result.status : 'wait';
      if (status === 'confirmed') {
        if (!result.token || !result.userId || !result.accountId) throw new HttpError(502, '微信未返回完整登录身份，请重新扫码。');
        if (this.db.prepare('SELECT id FROM im_channels WHERE account_id=? AND auth_token IS NOT NULL AND id<>?').get(result.accountId, id)) {
          this.db.prepare("UPDATE im_channel_logins SET status='expired',qr_content='',qrcode='' WHERE id=?").run(loginId);
          this.db.prepare("UPDATE im_channels SET status='login_required',last_error=? WHERE id=?").run('此微信账号已连接其他渠道，请先删除原渠道，或在原渠道重新连接。', id);
          throw new HttpError(409, '此微信账号已连接其他渠道，请先删除原渠道，或在原渠道重新连接。');
        }
        this._revoke(id, '微信登录身份已更新。');
        this.store.transaction(() => {
          this.db.prepare("UPDATE im_channel_logins SET status='confirmed',qr_content='',qrcode='' WHERE id=?").run(loginId);
          this.db.prepare("UPDATE im_channels SET status='connected',auth_token=?,account_id=?,scanner_id=?,base_url=?,cursor='',context_token=NULL,binding_epoch=binding_epoch+1,bound_at=?,last_error=NULL,poll_failures=0,next_poll_at=0,updated_at=? WHERE id=?")
            .run(result.token, result.accountId, result.userId, result.baseUrl || client.baseUrl || null, this.now(), nowIso(), id);
        });
        this.clients.delete(id); this.loginClients.delete(loginId); this.audit('channel.connected', actor, id, {}); this._wake();
      } else {
        if (status === 'expired' || status === 'verify_code_blocked') this._endLogin(login, status,
          status === 'expired' ? '二维码已过期，请重新扫码。' : '微信配对码验证次数过多，请重新获取二维码。');
        else {
          this.db.prepare('UPDATE im_channel_logins SET status=?,base_url=?,next_poll_at=?,poll_failures=0 WHERE id=?')
            .run(status, client.baseUrl || login.base_url, this.now() + this.loginPollIntervalMs, loginId);
          this.db.prepare("UPDATE im_channels SET last_error=NULL WHERE id=? AND status='connecting'").run(id);
        }
      }
      return { channel: this.get(id), login: this._loginPublic(this._login(id, loginId)) };
    } catch (error) {
      if (!this.closed && !controller.signal.aborted) {
        if (error instanceof HttpError && error.status === 403) this._endLogin(login, 'expired', '扫码登录管理员权限已变更，请由有效管理员重新连接。');
        else if (!(error instanceof HttpError) || error.status >= 500) {
          const current = this.db.prepare('SELECT * FROM im_channel_logins WHERE id=? AND channel_id=?').get(loginId, id);
          if (current && !LOGIN_TERMINAL.has(current.status)) {
            const failures = current.poll_failures + 1;
            const delay = Math.min(60_000, this.retryMs * 2 ** Math.min(6, failures - 1));
            this.db.prepare('UPDATE im_channel_logins SET poll_failures=?,next_poll_at=? WHERE id=?').run(failures, this.now() + delay, loginId);
            this.db.prepare("UPDATE im_channels SET last_error=? WHERE id=? AND status='connecting'").run('查询微信扫码状态暂时失败，正在重试。', id);
          }
        }
      }
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, '查询微信扫码状态失败，请稍后重试。');
    } finally { if (this.loginRequests.get(lockId) === request) this.loginRequests.delete(lockId); }
  }

  /** Enqueue only messages created after binding, never the group's old history. */
  publish(sessionId, { text, authorName = '', excludeChannelId = null, messageId = null, onlyChannels = null, waitForContext = false } = {}) {
    if (this.closed || typeof text !== 'string' || !text.trim()) return { queued: 0 };
    const payload = `${authorName ? `${String(authorName).slice(0, 100)}：\n` : ''}${text.trim()}`;
    const parts = textParts(payload);
    let queued = 0;
    for (const row of this.db.prepare('SELECT * FROM im_channels WHERE session_id=?').all(sessionId)) {
      if (row.id === excludeChannelId || !row.enabled || !this._authorized(row)
        || !waitForContext && (!this._ready(row) || !row.context_token)
        || onlyChannels && !onlyChannels.some(target => target.id === row.id && target.epoch === row.binding_epoch)) continue;
      const key = String(messageId || randomUUID()).slice(0, 200);
      this.store.transaction(() => {
        for (let index = 0; index < parts.length; index++) {
          queued += Number(this.db.prepare('INSERT OR IGNORE INTO im_channel_outbox(id,channel_id,session_id,binding_epoch,dedupe_key,text,created_at) VALUES (?,?,?,?,?,?,?)')
            .run(randomUUID(), row.id, sessionId, row.binding_epoch, parts.length === 1 ? key : `${key}:part:${index}`, parts[index], nowIso()).changes);
        }
      });
    }
    this._wake(); return { queued };
  }
  start() {
    if (this.started || this.closed) return; this.started = true;
    this.timer = setInterval(() => this._cycle(), Math.min(this.pollIntervalMs, this.loginPollIntervalMs)); this.timer.unref?.(); this._cycle();
  }
  _wake() { if (this.started && !this.closed) queueMicrotask(() => this._cycle()); }
  _cycle() {
    if (this.closed || !this.started) return;
    this._cycleLogins();
    for (const row of this.db.prepare('SELECT * FROM im_channels').all()) {
      if (!this._authorized(row, false) || row.session_id && !this._authorized(row)) { this._revoke(row.id); continue; }
      if (!row.enabled || row.status !== 'connected' || !row.auth_token || !row.scanner_id) continue;
      if (!this.polls.has(row.id) && row.next_poll_at <= this.now()) this._poll(row);
      if (this._ready(row) && !this.senders.has(row.id)) this._send(row);
    }
    const pending = this.db.prepare("SELECT session_id,next_attempt_at FROM im_channel_inbox WHERE status='pending' AND session_id IS NOT NULL ORDER BY created_at,rowid").all();
    const seen = new Set();
    for (const { session_id: sessionId, next_attempt_at: due } of pending) {
      if (seen.has(sessionId)) continue; seen.add(sessionId);
      if (due <= this.now() && !this.groups.has(sessionId)) this._runGroup(sessionId);
    }
  }
  _cycleLogins() {
    const logins = this.db.prepare(`SELECT l.* FROM im_channel_logins l JOIN im_channels c ON c.id=l.channel_id
      WHERE c.status='connecting' AND l.status NOT IN ('confirmed','expired','verify_code_blocked')`).all();
    for (const snapshot of logins) {
      const login = this._login(snapshot.channel_id, snapshot.id); if (LOGIN_TERMINAL.has(login.status)) continue;
      const row = this._row(login.channel_id); const actor = { id: login.created_by || row.owner_id };
      try { this._loginAdmin(row, login, actor); } catch {
        this._endLogin(login, 'expired', '扫码登录管理员权限已变更，请由有效管理员重新连接。'); continue;
      }
      // A pairing challenge requires an explicit code submission. Keep its state
      // stable instead of occupying the request lock with an empty-code poll.
      if (!row.enabled || login.status === 'need_verifycode' || login.next_poll_at > this.now()
        || this.loginRequests.has(row.id) || this.loginRequests.has(`status:${login.id}`)) continue;
      this.loginStatus(row.id, login.id, actor).catch(() => {});
    }
  }
  _credentialsExpired(id) {
    this._revoke(id, '微信登录已失效，请管理员重新扫码。'); this.clients.delete(id);
    this.db.prepare("UPDATE im_channels SET status='login_required',auth_token=NULL,context_token=NULL,binding_epoch=binding_epoch+1,last_error=?,updated_at=? WHERE id=?")
      .run('微信登录已失效，请管理员重新扫码。', nowIso(), id);
  }
  _poll(snapshot) {
    const controller = new AbortController(); const entry = { controller }; this.polls.set(snapshot.id, entry);
    entry.promise = this._track((async () => {
      try {
        const result = await this._client(snapshot).getUpdates(snapshot.cursor, { signal: controller.signal });
        if (this.closed || controller.signal.aborted) return;
        const row = this.db.prepare('SELECT * FROM im_channels WHERE id=?').get(snapshot.id);
        if (!row || row.auth_token !== snapshot.auth_token || !this._authorized(row, false)) return;
        this.store.transaction(() => {
          this.db.prepare('UPDATE im_channels SET cursor=?,poll_failures=0,next_poll_at=?,last_error=NULL WHERE id=?')
            .run(typeof result.cursor === 'string' ? result.cursor : snapshot.cursor, this.now() + this.pollIntervalMs, row.id);
          if (row.binding_epoch !== snapshot.binding_epoch || row.session_id !== snapshot.session_id || !this._ready(row)) return;
          for (const raw of (Array.isArray(result.messages) ? result.messages : []).slice(0, 1000)) {
            const message = normalizeIncomingMessage(raw);
            if (!message || message.userId !== row.scanner_id || message.toUserId && message.toUserId !== row.account_id || !message.text || !message.contextToken) continue;
            if (message.text.length > 100_000 || !message.messageId || message.timestamp < row.bound_at) continue;
            const inserted = this.db.prepare('INSERT OR IGNORE INTO im_channel_inbox(id,channel_id,message_id,session_id,binding_epoch,text,created_at) VALUES (?,?,?,?,?,?,?)')
              .run(randomUUID(), row.id, String(message.messageId), row.session_id, row.binding_epoch, message.text, nowIso());
            if (inserted.changes) this.db.prepare('UPDATE im_channels SET context_token=? WHERE id=?').run(message.contextToken, row.id);
          }
        });
      } catch (error) {
        if (this.closed || controller.signal.aborted) return;
        const row = this.db.prepare('SELECT * FROM im_channels WHERE id=?').get(snapshot.id);
        if (!row || row.auth_token !== snapshot.auth_token) return;
        if (error?.authExpired || error?.code === -14) this._credentialsExpired(row.id);
        else {
          const failures = row.poll_failures + 1; const delay = Math.min(60_000, this.retryMs * 2 ** Math.min(6, failures - 1));
          this.db.prepare('UPDATE im_channels SET poll_failures=?,next_poll_at=?,last_error=? WHERE id=?').run(failures, this.now() + delay, '微信连接暂时中断，正在重试。', row.id);
        }
      } finally { if (this.polls.get(snapshot.id) === entry) this.polls.delete(snapshot.id); this._wake(); }
    })());
  }
  _runGroup(sessionId) {
    const controller = new AbortController(); const entry = { controller, channelId: null }; this.groups.set(sessionId, entry);
    entry.promise = this._track((async () => {
      const pending = this.db.prepare("SELECT * FROM im_channel_inbox WHERE status='pending' AND session_id=? ORDER BY created_at,rowid LIMIT 1").get(sessionId);
      if (!pending || pending.next_attempt_at > this.now() || this.closed) return; entry.channelId = pending.channel_id;
      const row = this.db.prepare('SELECT * FROM im_channels WHERE id=?').get(pending.channel_id);
      if (!this._ready(row) || row.session_id !== sessionId || row.binding_epoch !== pending.binding_epoch) {
        this.db.prepare("UPDATE im_channel_inbox SET status='cancelled',finished_at=?,last_error=? WHERE id=?").run(nowIso(), '微信渠道绑定或权限已变更。', pending.id); return;
      }
      const actor = this._member(row); this.actors.set(actor, { channelId: row.id, epoch: row.binding_epoch, scannerId: row.scanner_id });
      this.db.prepare("UPDATE im_channel_inbox SET status='running',attempts=attempts+1 WHERE id=?").run(pending.id);
      try {
        this.assertActor(sessionId, actor);
        await this.onMessage({ sessionId, channel: this._public(row), actor, message: { id: pending.id, messageId: pending.message_id, text: pending.text }, signal: controller.signal });
        if (this.closed) return;
        const status = controller.signal.aborted ? 'cancelled' : 'done';
        this.db.prepare('UPDATE im_channel_inbox SET status=?,finished_at=?,last_error=NULL WHERE id=?').run(status, nowIso(), pending.id);
      } catch (error) {
        if (this.closed) return;
        if (!controller.signal.aborted && error?.status === 409 && pending.attempts < 120) {
          this.db.prepare("UPDATE im_channel_inbox SET status='pending',next_attempt_at=?,last_error=? WHERE id=?").run(this.now() + this.retryMs, '群聊正在处理其他任务，等待执行。', pending.id);
        } else {
          const cancelled = controller.signal.aborted || error?.name === 'AbortError';
          this.db.prepare('UPDATE im_channel_inbox SET status=?,finished_at=?,last_error=? WHERE id=?')
            .run(cancelled ? 'cancelled' : 'failed', nowIso(), cancelled ? '渠道权限已变更或任务已中止。' : '任务执行失败，请在群聊查看结果后重试。', pending.id);
          const current = this.db.prepare('SELECT * FROM im_channels WHERE id=?').get(pending.channel_id);
          if (!cancelled && ![401, 403].includes(error?.status) && this._ready(current) && current.context_token
            && current.binding_epoch === pending.binding_epoch && current.session_id === sessionId) {
            this.db.prepare('INSERT OR IGNORE INTO im_channel_outbox(id,channel_id,session_id,binding_epoch,dedupe_key,text,created_at) VALUES (?,?,?,?,?,?,?)')
              .run(randomUUID(), current.id, sessionId, current.binding_epoch, `${pending.id}:failure`, '任务暂时未能完成，请在 Web 群聊查看状态或稍后重试。', nowIso());
          }
        }
      }
    })().finally(() => { if (this.groups.get(sessionId) === entry) this.groups.delete(sessionId); this._wake(); }));
  }
  _send(snapshot) {
    const pending = this.db.prepare("SELECT * FROM im_channel_outbox WHERE channel_id=? AND status='pending' ORDER BY created_at,rowid LIMIT 1").get(snapshot.id);
    if (!pending || pending.next_attempt_at > this.now()) return;
    if (snapshot.binding_epoch !== pending.binding_epoch || snapshot.session_id !== pending.session_id) {
      this.db.prepare("UPDATE im_channel_outbox SET status='cancelled',finished_at=? WHERE id=?").run(nowIso(), pending.id); return;
    }
    // A newly linked owner must send one message to obtain Weixin's reply context.
    // Keep final task results queued until that context arrives.
    if (!snapshot.context_token) return;
    const controller = new AbortController(); const entry = { controller }; this.senders.set(snapshot.id, entry);
    entry.promise = this._track((async () => {
      this.db.prepare("UPDATE im_channel_outbox SET status='sending',attempts=attempts+1 WHERE id=?").run(pending.id);
      try {
        const current = this._row(snapshot.id);
        if (!this._ready(current) || current.binding_epoch !== pending.binding_epoch || current.session_id !== pending.session_id) throw unavailable();
        await this._client(current).sendText({ toUserId: current.scanner_id, text: pending.text, contextToken: current.context_token, clientId: pending.id, signal: controller.signal });
        if (this.closed) return;
        this.db.prepare("UPDATE im_channel_outbox SET status='sent',finished_at=?,last_error=NULL WHERE id=? AND status='sending'").run(nowIso(), pending.id);
      } catch (error) {
        if (this.closed) return;
        if (error?.authExpired || error?.code === -14) this._credentialsExpired(snapshot.id);
        else if (!controller.signal.aborted && !(error instanceof HttpError) && pending.attempts < 4) {
          this.db.prepare("UPDATE im_channel_outbox SET status='pending',next_attempt_at=?,last_error=? WHERE id=? AND status='sending'")
            .run(this.now() + Math.min(60_000, this.retryMs * 2 ** pending.attempts), '微信消息暂时发送失败，正在重试。', pending.id);
        } else this.db.prepare("UPDATE im_channel_outbox SET status=?,finished_at=?,last_error=? WHERE id=? AND status='sending'")
          .run(controller.signal.aborted ? 'cancelled' : 'failed', nowIso(), '微信消息未能送达。', pending.id);
      } finally { if (this.senders.get(snapshot.id) === entry) this.senders.delete(snapshot.id); this._wake(); }
    })());
  }
  close() { this.closePromise ||= this._close(); return this.closePromise; }
  async _close() {
    this.closed = true; this.started = false; clearInterval(this.timer); this.timer = null;
    for (const entries of [this.polls, this.groups, this.senders, this.loginRequests]) for (const entry of entries.values()) entry.controller.abort(new Error('消息渠道服务正在关闭。'));
    // Callers close SQLite only after all callbacks have observed cancellation.
    await Promise.allSettled([...this.work]);
    this.db.prepare("UPDATE im_channel_inbox SET status='interrupted',finished_at=?,last_error=? WHERE status='running'")
      .run(nowIso(), '服务关闭，先前任务已中断，请确认结果后重新发送。');
    this.db.prepare("UPDATE im_channel_outbox SET status='pending' WHERE status='sending'").run();
    this.clients.clear(); this.loginClients.clear(); this.loginRequests.clear();
  }
}
