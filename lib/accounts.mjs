import { randomBytes, randomUUID, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { HttpError, isLocalSetup } from './security.mjs';

const scrypt = promisify(scryptCallback);
const COOKIE = 'pi_web_session';
const LOGIN_DURATION = 12 * 60 * 60 * 1000;
export const workspace = Object.freeze({ id: 'company', name: '公司共享空间' });

function password(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128) throw new HttpError(400, '密码须为 8 至 128 个字符。');
  return value;
}
function loginPassword(value) {
  // Existing or imported credentials can predate the new-password minimum.
  if (typeof value !== 'string' || !value.length || value.length > 128) throw new HttpError(400, '请输入 1 至 128 个字符的密码。');
  return value;
}
function username(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,47}$/.test(value)) throw new HttpError(400, '用户名须为 3 至 48 位字母、数字、下划线、点或短横线，首位须为字母或数字。');
  return value.toLowerCase();
}
function displayName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) throw new HttpError(400, '姓名须为 1 至 80 个字符。');
  return value.trim();
}
export function publicUser(row) {
  return row ? { id: row.id, username: row.username, displayName: row.display_name, role: row.role, disabled: Boolean(row.disabled), createdAt: row.created_at } : null;
}
async function hashPassword(value) {
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(value, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt:${salt}:${derived.toString('hex')}`;
}
async function checkPassword(value, hash) {
  const [, salt, expected] = (hash || '').split(':');
  const derived = await scrypt(value, salt || 'no-user-constant-timing-salt', 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const wanted = Buffer.from(expected || '', 'hex');
  return wanted.length === derived.length && timingSafeEqual(wanted, derived);
}
const digest = (value) => createHash('sha256').update(value).digest('hex');

export class Accounts {
  constructor(store, { secureCookie = false, onInvalidate, onAudit = () => {} } = {}) {
    this.store = store;
    this.db = store.db;
    this.secureCookie = secureCookie;
    this.onInvalidate = onInvalidate;
    this.onAudit = onAudit;
    this.attempts = new Map();
  }
  setupRequired() { return !this.db.prepare('SELECT id FROM users LIMIT 1').get(); }
  requireAdmin(user) { if (user.role !== 'admin') throw new HttpError(403, '需要管理员权限。'); }
  assertCurrent(user, admin = false) {
    const row = this.db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
    if (!row || row.disabled) throw new HttpError(401, '登录状态已变更，请重新登录。');
    if (admin && row.role !== 'admin') throw new HttpError(403, '需要管理员权限。');
    return row;
  }
  cookie(req, res, value, age = LOGIN_DURATION / 1000) {
    const secure = typeof this.secureCookie === 'function' ? this.secureCookie(req) : this.secureCookie;
    res.setHeader('Set-Cookie', `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? '; Secure' : ''}`);
  }
  token(req) {
    const entry = (req.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`));
    const value = entry?.slice(COOKIE.length + 1);
    return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
  }
  current(req) {
    const token = this.token(req);
    if (!token) return null;
    const row = this.db.prepare(`SELECT u.* FROM logins l JOIN users u ON u.id=l.user_id
      WHERE l.token_hash=? AND l.expires_at>? AND l.auth_version=u.auth_version AND u.disabled=0`).get(digest(token), Date.now());
    return publicUser(row);
  }
  requireUser(req) { const user = this.current(req); if (!user) throw new HttpError(401, '请先登录公司共享空间。'); return user; }
  audit(action, user, targetId, details = {}, req) {
    this.db.prepare('INSERT INTO audit(at,action,actor_id,actor_name,target_id,details,ip) VALUES (?,?,?,?,?,?,?)')
      .run(new Date().toISOString(), action, user?.id || null, user?.displayName || '未登录', targetId || null, JSON.stringify(details), req?.socket.remoteAddress || null);
    try { this.onAudit({ action, actorId: user?.id ?? null, targetId, details }); } catch {}
  }
  startLogin(req, res, user) {
    const token = randomBytes(32).toString('hex');
    const row = this.db.prepare('SELECT auth_version FROM users WHERE id=?').get(user.id);
    this.db.prepare('DELETE FROM logins WHERE expires_at<?').run(Date.now());
    this.db.prepare('INSERT INTO logins(token_hash,user_id,auth_version,expires_at) VALUES (?,?,?,?)').run(digest(token), user.id, row.auth_version, Date.now() + LOGIN_DURATION);
    this.cookie(req, res, token);
  }
  async setup(req, res, body) {
    if (!isLocalSetup(req)) throw new HttpError(403, '请在服务器本机打开 localhost 或 127.0.0.1，初始化管理员。');
    if (!this.setupRequired()) throw new HttpError(409, '管理员已初始化，请直接登录。');
    const normalized = username(body.username);
    const name = displayName(body.displayName);
    const hash = await hashPassword(password(body.password));
    const id = randomUUID();
    this.store.transaction(() => {
      if (!this.setupRequired()) throw new HttpError(409, '管理员已初始化，请直接登录。');
      this.db.prepare('INSERT INTO users(id,username,display_name,role,password_hash,created_at) VALUES (?,?,?,?,?,?)').run(id, normalized, name, 'admin', hash, new Date().toISOString());
      const persist = this.db.prepare('UPDATE session_meta SET data=? WHERE id=?');
      for (const meta of this.store.sessions) {
        if (!meta.ownerId) { meta.ownerId = id; meta.legacyUnknownOwner = true; persist.run(JSON.stringify(meta), meta.id); }
      }
      this.audit('workspace.setup', { id, displayName: name }, id, { legacySessions: this.store.sessions.filter((item) => item.legacyUnknownOwner).length }, req);
    });
    const user = publicUser(this.db.prepare('SELECT * FROM users WHERE id=?').get(id));
    this.startLogin(req, res, user);
    return { user, workspace };
  }
  rateLimit(req, name) {
    const now = Date.now();
    for (const [key, entry] of this.attempts) if (entry.until < now) this.attempts.delete(key);
    const keys = [`ip:${req.socket.remoteAddress}`, `account:${name}`];
    for (const key of keys) {
      const entry = this.attempts.get(key);
      if (entry && entry.count >= (key.startsWith('ip:') ? 30 : 10)) throw new HttpError(429, '登录尝试过多，请在 15 分钟后重试。');
    }
    for (const key of keys) {
      const entry = this.attempts.get(key) || { count: 0, until: now + 15 * 60 * 1000 };
      entry.count++; this.attempts.set(key, entry);
    }
  }
  async login(req, res, body) {
    const name = username(body.username);
    loginPassword(body.password);
    this.rateLimit(req, name);
    const row = this.db.prepare('SELECT * FROM users WHERE username=?').get(name);
    const valid = await checkPassword(body.password, row?.password_hash);
    const current = row && this.db.prepare('SELECT * FROM users WHERE id=?').get(row.id);
    if (!valid || !current || current.disabled || current.auth_version !== row.auth_version) { this.audit('auth.login_failed', null, null, { username: name }, req); throw new HttpError(401, '用户名或密码错误，或账号已停用。'); }
    const user = publicUser(current);
    this.attempts.delete(`account:${name}`);
    const ipAttempt = this.attempts.get(`ip:${req.socket.remoteAddress}`);
    if (ipAttempt) { ipAttempt.count--; if (ipAttempt.count <= 0) this.attempts.delete(`ip:${req.socket.remoteAddress}`); }
    this.startLogin(req, res, user);
    this.audit('auth.login', user, user.id, {}, req);
    return { user, workspace };
  }
  logout(req, res, user) {
    const token = this.token(req);
    if (token) this.db.prepare('DELETE FROM logins WHERE token_hash=?').run(digest(token));
    this.cookie(req, res, '', 0);
    if (user) this.audit('auth.logout', user, user.id, {}, req);
    return { ok: true };
  }
  async changePassword(req, res, user, body) {
    if (typeof body.currentPassword !== 'string' || body.currentPassword.length > 128) throw new HttpError(400, '请输入当前密码。');
    const row = this.db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
    if (!await checkPassword(body.currentPassword, row.password_hash)) throw new HttpError(400, '当前密码不正确。');
    const hash = await hashPassword(password(body.newPassword));
    this.store.transaction(() => {
      const current = this.assertCurrent(user);
      if (current.auth_version !== row.auth_version) throw new HttpError(401, '登录状态已变更，请重新登录。');
      this.db.prepare('UPDATE users SET password_hash=?,auth_version=auth_version+1 WHERE id=?').run(hash, user.id);
      this.db.prepare('DELETE FROM logins WHERE user_id=?').run(user.id);
      this.audit('user.password_changed', user, user.id, {}, req);
    });
    this.onInvalidate?.(user.id);
    this.startLogin(req, res, user);
    return { ok: true };
  }
  listUsers() { return this.db.prepare('SELECT * FROM users ORDER BY created_at,username').all().map(publicUser); }
  async createUser(req, actor, body) {
    const name = username(body.username);
    const label = displayName(body.displayName);
    if (!['admin', 'member'].includes(body.role)) throw new HttpError(400, '角色必须为 admin 或 member。');
    if (this.db.prepare('SELECT id FROM users WHERE username=?').get(name)) throw new HttpError(409, '用户名已存在。');
    const hash = await hashPassword(password(body.password));
    const id = randomUUID();
    this.store.transaction(() => {
      this.assertCurrent(actor, true);
      if (this.db.prepare('SELECT id FROM users WHERE username=?').get(name)) throw new HttpError(409, '用户名已存在。');
      this.db.prepare('INSERT INTO users(id,username,display_name,role,password_hash,created_at) VALUES (?,?,?,?,?,?)').run(id, name, label, body.role, hash, new Date().toISOString());
      this.audit('user.created', actor, id, { username: name, displayName: label, role: body.role }, req);
    });
    return publicUser(this.db.prepare('SELECT * FROM users WHERE id=?').get(id));
  }
  async updateUser(req, actor, id, body) {
    const row = this.db.prepare('SELECT * FROM users WHERE id=?').get(id);
    if (!row) throw new HttpError(404, '员工不存在。');
    if ('disabled' in body && typeof body.disabled !== 'boolean') throw new HttpError(400, 'disabled 须为布尔值。');
    const label = 'displayName' in body ? displayName(body.displayName) : null;
    const hash = 'password' in body ? await hashPassword(password(body.password)) : null;
    let invalidate = false;
    this.store.transaction(() => {
      this.assertCurrent(actor, true);
      const current = this.db.prepare('SELECT * FROM users WHERE id=?').get(id);
      const disabled = 'disabled' in body ? Number(body.disabled) : current.disabled;
      invalidate = Boolean(hash) || disabled !== current.disabled;
      if (disabled && current.role === 'admin' && !current.disabled && this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND disabled=0").get().n <= 1) throw new HttpError(409, '至少保留一个启用的管理员。');
      this.db.prepare('UPDATE users SET display_name=?,disabled=?,password_hash=?,auth_version=auth_version+? WHERE id=?').run(label ?? current.display_name, disabled, hash ?? current.password_hash, invalidate ? 1 : 0, id);
      if (invalidate) this.db.prepare('DELETE FROM logins WHERE user_id=?').run(id);
      this.audit('user.updated', actor, id, { displayName: label ?? current.display_name, disabled: Boolean(disabled), passwordReset: 'password' in body }, req);
    });
    if (invalidate) this.onInvalidate?.(id);
    return publicUser(this.db.prepare('SELECT * FROM users WHERE id=?').get(id));
  }
  events(limit = 100) {
    return this.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit).map((row) => ({ id: row.id, at: row.at, action: row.action, actorId: row.actor_id, actorName: row.actor_name, targetId: row.target_id, details: JSON.parse(row.details), ip: row.ip }));
  }
}
