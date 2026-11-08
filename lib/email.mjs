import { randomUUID } from 'node:crypto';
import { windowsCredentialCodec } from './cloud-document-credentials.mjs';
import { HttpError } from './security.mjs';
import { EmailAdapterError } from './email-adapter.mjs';

const MAX_TEXT = 120000;
const own = (value, key) => Object.hasOwn(value, key);
const plain = value => Boolean(value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
const now = () => new Date().toISOString();
const fields = (value, allowed) => { if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new HttpError(400, '邮件参数含有不支持的字段。'); };
function line(value, label, max = 256, optional = false) {
  if (optional && (value === undefined || value === '')) return '';
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new HttpError(400, `${label}格式无效。`);
  return value.trim();
}
function address(value) {
  const result = line(value, '邮箱地址', 254);
  if (!/^[^\s<>@,;:"\\]+@[^\s<>@,;:"\\]+\.[^\s<>@,;:"\\]+$/.test(result)) throw new HttpError(400, '请输入完整邮箱地址，不包含姓名或邮件头。');
  return result;
}
function recipients(value, required = false) {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value) || value.length > 50 || required && !value.length) throw new HttpError(400, '每类收件人须为至多 50 个邮箱地址。');
  return [...new Set(value.map(address))];
}
function protocol(value, previous, label) {
  if (value === null || value === undefined && !previous) return { value: null, password: undefined };
  fields(value, ['host', 'port', 'tls', 'username', 'password', 'passwordSet']);
  const merged = { ...previous, ...value };
  const host = line(merged.host, `${label}服务器`, 253);
  if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host) || host.includes('..')) throw new HttpError(400, `${label}服务器须为主机名或 IPv4 地址。`);
  if (!Number.isInteger(merged.port) || merged.port < 1 || merged.port > 65535 || !['implicit', 'starttls'].includes(merged.tls) || [465, 993].includes(merged.port) && merged.tls !== 'implicit' || merged.port === 587 && merged.tls !== 'starttls') throw new HttpError(400, `${label}端口或 TLS 设置无效。`);
  const username = line(merged.username, `${label}登录账号`, 320);
  if (value.password !== undefined && (typeof value.password !== 'string' || value.password.length > 8192 || /[\x00\r\n]/.test(value.password))) throw new HttpError(400, `${label}密码或授权码格式无效。`);
  return { value: { host, port: merged.port, tls: merged.tls, username }, password: value.password || undefined };
}
function accountInput(body, previous = {}) {
  fields(body, ['id', 'name', 'email', 'fromName', 'enabled', 'allowSend', 'scope', 'groupIds', 'imap', 'smtp']);
  const value = { ...previous, ...body };
  for (const key of ['enabled', 'allowSend']) if (value[key] !== undefined && typeof value[key] !== 'boolean') throw new HttpError(400, '邮件启用和发送设置须为布尔值。');
  value.scope ??= 'none'; value.groupIds ??= [];
  if (!['none', 'all', 'groups'].includes(value.scope) || !Array.isArray(value.groupIds) || value.groupIds.length > 500 || value.groupIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id))) throw new HttpError(400, '邮箱智能体授权范围无效。');
  const groupIds = value.scope === 'groups' ? [...new Set(value.groupIds)] : [];
  if (value.scope === 'groups' && !groupIds.length) throw new HttpError(400, '请至少选择一个可使用邮箱的智能体，或选择不授权智能体。');
  const imap = own(body, 'imap') ? protocol(body.imap, previous.imap, 'IMAP') : { value: previous.imap || null };
  const smtp = own(body, 'smtp') ? protocol(body.smtp, previous.smtp, 'SMTP') : { value: previous.smtp || null };
  if (!imap.value || value.allowSend && !smtp.value) throw new HttpError(400, !imap.value ? '请配置 IMAP 收件服务器。' : '允许发送前须先配置 SMTP 服务器。');
  return { config: { name: line(value.name, '邮箱名称', 100), email: address(value.email), fromName: line(value.fromName, '发件人名称', 100, true), enabled: value.enabled ?? false, allowSend: value.allowSend ?? false, scope: value.scope, groupIds, imap: imap.value, smtp: smtp.value }, passwords: { imapPassword: imap.password, smtpPassword: smtp.password } };
}
function mailReference(value) {
  if (typeof value !== 'string' || !/^<[^<>\s\x00-\x1f]{1,990}>$/.test(value)) throw new HttpError(400, '回复邮件标识无效。');
  return value;
}
function draftInput(body) {
  fields(body, ['to', 'cc', 'bcc', 'subject', 'text', 'inReplyTo', 'references', 'clientRequestId', 'attachmentIds']);
  const subject = line(body.subject, '邮件主题', 998);
  if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > MAX_TEXT || body.text.includes('\x00')) throw new HttpError(400, '邮件正文须为 1 至 120000 个字符。');
  if (body.references !== undefined && (!Array.isArray(body.references) || body.references.length > 50)) throw new HttpError(400, '引用邮件标识过多。');
  const value = { to: recipients(body.to, true), cc: recipients(body.cc), bcc: recipients(body.bcc), subject, text: body.text, ...(body.inReplyTo !== undefined ? { inReplyTo: mailReference(body.inReplyTo) } : {}), ...(body.references ? { references: body.references.map(mailReference) } : {}) };
  if (body.attachmentIds !== undefined) {
    if (!Array.isArray(body.attachmentIds) || body.attachmentIds.length > 10 || body.attachmentIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) || new Set(body.attachmentIds).size !== body.attachmentIds.length) throw new HttpError(400, '邮件附件须为至多 10 个有效群内文件 ID。');
    value.attachmentIds = [...body.attachmentIds];
  }
  if (value.to.length + value.cc.length + value.bcc.length > 50) throw new HttpError(400, '一封邮件至多包含 50 个收件人。');
  return value;
}
function token(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new HttpError(400, '发送幂等标识无效。');
  return value;
}
function messageOptions(value = {}) {
  fields(value, ['folder', 'uid', 'uidValidity', 'part']);
  const folder = value.folder === undefined ? 'INBOX' : line(value.folder, '邮件文件夹', 256);
  const uid = String(value.uid ?? '');
  if (!/^[1-9]\d{0,9}$/.test(uid) || Number(uid) > 4294967295) throw new HttpError(400, '邮件 UID 无效。');
  const uidValidity = value.uidValidity === undefined ? undefined : String(value.uidValidity);
  if (uidValidity !== undefined && (!/^[1-9]\d{0,9}$/.test(uidValidity) || Number(uidValidity) > 4294967295)) throw new HttpError(400, '邮件文件夹版本无效。');
  return { folder, uid, ...(uidValidity ? { uidValidity } : {}) };
}
function readPermissions(value = {}) {
  fields(value, ['publicRead']);
  if (value.publicRead !== undefined && typeof value.publicRead !== 'boolean') throw new HttpError(400, '公共邮箱读取权限无效。');
  return { publicRead: value.publicRead === true };
}

export class EmailService {
  constructor(store, { adapter, codec = windowsCredentialCodec, operationTimeout = 45000, onEvent = () => {}, resolveAttachments } = {}) {
    this.store = store; this.db = store.db; this.adapter = adapter; this.codec = codec; this.operationTimeout = operationTimeout; this.onEvent = onEvent;
    this.operations = new Map(); this.secretHistory = new Set(); this.credentialFlags = new Map(); this.closed = false; this.resolveAttachments = resolveAttachments;
    this.db.exec(`CREATE TABLE IF NOT EXISTS email_accounts (
      id TEXT PRIMARY KEY, config_json TEXT NOT NULL, credentials_ciphertext TEXT,
      version INTEGER NOT NULL DEFAULT 1, deleted INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'not_checked', check_json TEXT NOT NULL DEFAULT '{}',
      created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS email_drafts (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES email_accounts(id), session_id TEXT NOT NULL,
      content_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', result_json TEXT NOT NULL DEFAULT '{}',
      created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, sent_at TEXT,
      client_request_id TEXT, send_token TEXT UNIQUE, sent_by TEXT,
      UNIQUE(session_id,client_request_id));
      CREATE INDEX IF NOT EXISTS email_drafts_group_time ON email_drafts(session_id,created_at DESC);`);
    if (!this.db.prepare('PRAGMA table_info(email_drafts)').all().some(column => column.name === 'sent_by')) this.db.exec('ALTER TABLE email_drafts ADD COLUMN sent_by TEXT');
    this.db.prepare("UPDATE email_drafts SET status='unknown',result_json=?,updated_at=? WHERE status='sending'")
      .run(JSON.stringify({ message: '上次发送过程被中断，结果未知。请先核对发件箱，切勿直接重发。' }), now());
  }
  async initialize() {
    for (const row of this.db.prepare('SELECT * FROM email_accounts WHERE deleted=0 AND credentials_ciphertext IS NOT NULL').all()) {
      try { await this.decrypt(row); } catch { /* Reconfiguration remains available; startup never opens a mail connection. */ }
    }
  }
  knownSecrets() { return [...this.secretHistory]; }
  scrub(value) {
    if (typeof value === 'string') { let result = value; for (const secret of this.knownSecrets().sort((a,b) => b.length-a.length)) result = result.split(secret).join('[REDACTED]'); return result; }
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) return value;
    if (Array.isArray(value)) return value.map(item => this.scrub(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /^(password|imappassword|smtppassword|credentials|authorization|accesstoken|refreshtoken)$/i.test(key.replace(/[_-]/g,'')) ? '[REDACTED]' : this.scrub(item)]));
    return value;
  }
  emit(type, row) { try { this.onEvent({ type, accountId: row.account_id || row.id, ...(row.session_id ? { sessionId: row.session_id, draftId: row.id } : {}), ...(row.status ? { status: row.status } : {}) }); } catch {} }
  actor(context = {}, admin = false) {
    context.authorize?.(); context.signal?.throwIfAborted();
    const user = context.actor?.id && this.db.prepare('SELECT id,role,disabled FROM users WHERE id=?').get(context.actor.id);
    if (!user || user.disabled) throw new HttpError(401, '登录状态已变更，请重新登录。');
    if (admin && user.role !== 'admin') throw new HttpError(403, '邮箱配置需要管理员权限。');
    return user;
  }
  group(context) {
    const user = this.actor(context);
    if (!context.sessionId || !this.db.prepare('SELECT 1 FROM group_members WHERE session_id=? AND user_id=?').get(context.sessionId, user.id)) throw new HttpError(403, '仅当前群成员可以使用群内邮箱。');
    return user;
  }
  row(id, includeDeleted = false) {
    const row = this.db.prepare(`SELECT * FROM email_accounts WHERE id=?${includeDeleted ? '' : ' AND deleted=0'}`).get(id);
    if (!row) throw new HttpError(404, '邮箱不存在。');
    return row;
  }
  config(row) { return JSON.parse(row.config_json); }
  accountView(row) {
    const config = this.config(row), check = JSON.parse(row.check_json), remembered = this.credentialFlags.get(row.id);
    const flags = remembered?.version === row.version ? remembered : { imapPasswordSet: config.imap.passwordSet === true, smtpPasswordSet: config.smtp?.passwordSet === true };
    return { id: row.id, ...config, imap: { ...config.imap, passwordSet: Boolean(flags.imapPasswordSet) }, smtp: config.smtp ? { ...config.smtp, passwordSet: Boolean(flags.smtpPasswordSet) } : null, status: row.status, ...check, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  access(id, context, { admin = false, send = false, publicRead = false } = {}) {
    if (context?.mailboxPublic === true && (admin || send) || publicRead && (context?.mailboxPublic !== true || admin || send)) throw new HttpError(403, '公共邮件中心仅允许读取邮件。');
    if (publicRead) this.actor(context); else if (admin) this.actor(context, true); else this.group(context);
    const row = this.row(id), config = this.config(row);
    if (!admin && (!config.enabled || !publicRead && (config.scope === 'none' || config.scope === 'groups' && !config.groupIds.includes(context.sessionId)))) throw new HttpError(403, '当前智能体未分配此邮箱或邮箱已停用。');
    if (send && (!config.allowSend || !config.smtp)) throw new HttpError(403, '管理员尚未允许此邮箱发送邮件。');
    return row;
  }
  listAccounts(context) { this.actor(context, true); return this.db.prepare('SELECT * FROM email_accounts WHERE deleted=0 ORDER BY created_at,id').all().map(row => this.accountView(row)); }
  getAccount(id, context) { this.actor(context, true); return this.accountView(this.row(id)); }
  listAvailable(context) {
    this.group(context);
    return this.db.prepare('SELECT * FROM email_accounts WHERE deleted=0 ORDER BY created_at,id').all().filter(row => { const value = this.config(row); return value.enabled && (value.scope === 'all' || value.scope === 'groups' && value.groupIds.includes(context.sessionId)); }).map(row => { const value = this.config(row); return { id: row.id, name: value.name, email: value.email, fromName: value.fromName, allowSend: value.allowSend, smtpConfigured: Boolean(value.smtp) }; });
  }
  async decrypt(row) {
    if (!row.credentials_ciphertext) throw new HttpError(409, '请管理员先配置邮箱密码或授权码。');
    try {
      const value = JSON.parse((await this.codec('unprotect', Buffer.from(row.credentials_ciphertext, 'base64'))).toString('utf8'));
      if (!plain(value) || typeof value.imapPassword !== 'string' || !value.imapPassword || value.smtpPassword !== undefined && typeof value.smtpPassword !== 'string') throw new Error('invalid');
      for (const secret of Object.values(value)) if (secret) this.secretHistory.add(secret);
      this.credentialFlags.set(row.id, { version: row.version, imapPasswordSet: Boolean(value.imapPassword), smtpPasswordSet: Boolean(value.smtpPassword) });
      return value;
    } catch { throw new HttpError(409, '邮箱凭据无法解密，请使用原 Windows 用户启动服务或重新保存授权码。'); }
  }
  async saveAccount(id, body, context) {
    const actor = this.actor(context, true), old = id ? this.row(id) : null;
    const { config, passwords } = accountInput(body, old ? this.config(old) : {});
    for (const groupId of config.groupIds) if (!this.db.prepare('SELECT id FROM session_meta WHERE id=?').get(groupId)) throw new HttpError(400, '所选群聊不存在。');
    const replacesAll = Boolean(passwords.imapPassword && (!config.smtp || passwords.smtpPassword));
    const credentials = old && !replacesAll ? await this.decrypt(old) : {};
    for (const key of ['imapPassword', 'smtpPassword']) if (passwords[key] !== undefined) credentials[key] = passwords[key];
    if (!config.smtp) delete credentials.smtpPassword;
    if (!credentials.imapPassword || config.smtp && !credentials.smtpPassword) throw new HttpError(400, '请填写已配置协议的密码或授权码。');
    config.imap.passwordSet = Boolean(credentials.imapPassword);
    if (config.smtp) config.smtp.passwordSet = Boolean(credentials.smtpPassword);
    for (const secret of Object.values(credentials)) if (secret) this.secretHistory.add(secret);
    const encrypted = await this.codec('protect', Buffer.from(JSON.stringify(credentials)));
    this.actor(context, true);
    const accountId = id || randomUUID(), stamp = now();
    this.store.transaction(() => {
      this.actor(context, true);
      if (old && this.row(id).version !== old.version) throw new HttpError(409, '邮箱配置已更新，请刷新后重试。');
      for (const groupId of config.groupIds) if (!this.db.prepare('SELECT id FROM session_meta WHERE id=?').get(groupId)) throw new HttpError(400, '所选群聊不存在。');
      if (old) this.db.prepare("UPDATE email_accounts SET config_json=?,credentials_ciphertext=?,version=version+1,status='not_checked',check_json='{}',updated_at=? WHERE id=?")
        .run(JSON.stringify(config), encrypted.toString('base64'), stamp, accountId);
      else this.db.prepare('INSERT INTO email_accounts(id,config_json,credentials_ciphertext,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?)')
        .run(accountId, JSON.stringify(config), encrypted.toString('base64'), actor.id, stamp, stamp);
    });
    this.invalidate(accountId); this.emit('email.account_updated', this.row(accountId)); return this.getAccount(accountId, context);
  }
  deleteAccount(id, context) {
    this.actor(context, true); this.row(id);
    this.db.prepare("UPDATE email_accounts SET deleted=1,credentials_ciphertext=NULL,version=version+1,updated_at=? WHERE id=?").run(now(), id);
    this.invalidate(id); this.emit('email.account_deleted', { id }); return { ok: true };
  }
  invalidate(id) { for (const item of this.operations.values()) if (item.accountId === id) item.controller.abort(); }
  async operation(id, context, permissions, action) {
    const row = this.access(id, context, permissions);
    if (this.closed) throw new HttpError(503, '邮箱服务正在关闭。');
    if ([...this.operations.values()].filter(item => item.accountId === id).length >= 3) throw new HttpError(429, '此邮箱正在处理其他请求，请稍后重试。');
    const controller = new AbortController(), key = randomUUID(), signal = context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal;
    const authorize = () => { signal.throwIfAborted(); if (this.access(id, context, permissions).version !== row.version) throw new HttpError(409, '邮箱配置已变更，请重试。'); };
    const timer = setTimeout(() => controller.abort(), this.operationTimeout);
    const monitor = setInterval(() => { try { authorize(); } catch { controller.abort(); } }, 250);
    this.operations.set(key, { accountId: id, controller });
    let abort;
    const interrupted = new Promise((_, reject) => { abort = () => reject(new HttpError(409, '邮箱请求已取消或超时。')); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); });
    try {
      const work = async () => { const credentials = await this.decrypt(row); authorize(); return action(this.config(row), credentials, { signal, authorize, guard: authorize }); };
      const result = await Promise.race([work(), interrupted]); authorize(); return this.scrub(result);
    } catch (error) {
      if (error instanceof HttpError) throw new HttpError(error.status, this.scrub(error.message));
      if (error instanceof EmailAdapterError && (error.code === 'output_limit' || error.code === 'timeout')) {
        throw new HttpError(error.status, this.scrub(error.message));
      }
      throw new HttpError(signal.aborted ? 409 : 502, signal.aborted ? '邮箱请求已取消或超时。' : '邮箱操作未完成，请检查服务器、授权码和连接状态。');
    } finally { clearTimeout(timer); clearInterval(monitor); signal.removeEventListener('abort', abort); this.operations.delete(key); }
  }
  async checkAccount(id, context) {
    const version = this.access(id, context, { admin: true }).version;
    let check;
    try {
      const result = await this.operation(id, context, { admin: true }, (config, credentials, options) => this.adapter.check(config, credentials, options));
      check = { status: 'ready', data: { imapReady: result?.imapReady === true, smtpReady: result?.smtpReady === true, checkedAt: now(), message: '已检测已配置协议的登录连接，未发送邮件。' } };
      if (!check.data.imapReady || this.config(this.row(id)).smtp && !check.data.smtpReady) check = { status: 'error', data: { ...check.data, message: '部分邮箱协议未通过检测，请检查配置和授权。' } };
    } catch (error) { this.actor(context, true); check = { status: 'error', data: { checkedAt: now(), message: error.status === 409 ? '邮箱检测已取消，或凭据尚未就绪。' : '邮箱连接检测失败，请检查服务器和授权码。' } }; }
    this.actor(context, true); const row = this.row(id);
    if (row.version !== version) throw new HttpError(409, '邮箱配置已变更，请重新检测。');
    this.db.prepare('UPDATE email_accounts SET status=?,check_json=? WHERE id=?').run(check.status, JSON.stringify(check.data), id);
    return this.getAccount(id, context);
  }
  folders(id, context) { return this.operation(id, context, {}, (config, credentials, options) => this.adapter.folders(config, credentials, options)); }
  listMessages(id, options = {}, context) {
    fields(options, ['folder', 'query', 'limit', 'cursor']);
    const folder = options.folder === undefined ? 'INBOX' : line(options.folder, '邮件文件夹', 256), query = options.query || {};
    fields(query, ['from', 'to', 'subject', 'text', 'since', 'before', 'unseen']);
    for (const key of ['from', 'to', 'subject', 'text']) if (own(query, key)) line(query[key], '邮件搜索条件', 500);
    for (const key of ['since', 'before']) if (own(query, key) && (typeof query[key] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(query[key]) || !Number.isFinite(Date.parse(query[key])) || new Date(`${query[key]}T00:00:00Z`).toISOString().slice(0, 10) !== query[key])) throw new HttpError(400, '邮件查询日期须为有效的 YYYY-MM-DD。');
    if (query.since && query.before && query.since >= query.before) throw new HttpError(400, '查询开始日期须早于结束日期。');
    if (query.unseen !== undefined && typeof query.unseen !== 'boolean') throw new HttpError(400, '未读筛选须为布尔值。');
    if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 50) || options.cursor !== undefined && (typeof options.cursor !== 'string' || options.cursor.length > 2048)) throw new HttpError(400, '邮件分页参数无效。');
    return this.operation(id, context, {}, (config, credentials, runtime) => this.adapter.search(config, credentials, { ...options, folder, query, ...runtime }));
  }
  readMessage(id, options, context, permissions = {}, { includeRichBody = false } = {}) {
    const reference = messageOptions(options);
    return this.operation(id, context, readPermissions(permissions), (config, credentials, runtime) => this.adapter.read(config, credentials, {
      ...reference, ...runtime, ...(includeRichBody ? { includeRichBody } : {})
    }));
  }
  downloadAttachment(id, options, context, permissions = {}, internalOptions = {}) {
    const reference = messageOptions(options), part = line(options.part, '邮件附件标识', 100);
    if (!/^\d+(?:\.\d+){0,19}$/.test(part)) throw new HttpError(400, '邮件附件标识无效。');
    const allowed = readPermissions(permissions);
    fields(internalOptions, ['attachmentMaxBytes']);
    if (own(internalOptions, 'attachmentMaxBytes')) {
      if (!allowed.publicRead) throw new HttpError(403, '扩展附件下载仅供公共邮箱归档使用。');
      if (!Number.isInteger(internalOptions.attachmentMaxBytes) || internalOptions.attachmentMaxBytes < 1 || internalOptions.attachmentMaxBytes > 50 * 1024 * 1024) throw new HttpError(400, '邮件附件下载上限须为 1 字节至 50 MiB。');
    }
    return this.operation(id, context, allowed, (config, credentials, runtime) => this.adapter.downloadAttachment(config, credentials, { ...reference, part, ...internalOptions, ...runtime }));
  }
  draftRow(id) { const row = this.db.prepare('SELECT * FROM email_drafts WHERE id=?').get(id); if (!row) throw new HttpError(404, '邮件草稿不存在。'); return row; }
  draftAccess(id, context, send = false) { const row = this.draftRow(id); if (row.session_id !== context.sessionId) throw new HttpError(404, '邮件草稿不存在。'); this.access(row.account_id, context, { send }); return row; }
  draftView(row) { return { id: row.id, accountId: row.account_id, sessionId: row.session_id, ...JSON.parse(row.content_json), status: row.status, result: JSON.parse(row.result_json), createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at, ...(row.sent_by ? { sentBy: row.sent_by } : {}), ...(row.sent_at ? { sentAt: row.sent_at } : {}) }; }
  getDraft(id, context) { return this.draftView(this.draftAccess(id, context)); }
  listDrafts(options = {}, context) {
    fields(options, ['status', 'limit', 'offset']); this.group(context);
    const statuses = ['draft', 'sending', 'sent', 'failed', 'unknown'];
    if (options.status !== undefined && !statuses.includes(options.status) || options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) || options.offset !== undefined && (!Number.isInteger(options.offset) || options.offset < 0)) throw new HttpError(400, '邮件记录分页参数无效。');
    const rows = this.db.prepare('SELECT * FROM email_drafts WHERE session_id=? ORDER BY created_at DESC,id DESC').all(context.sessionId).filter(row => { if (options.status && row.status !== options.status) return false; try { this.access(row.account_id, context); return true; } catch (error) { if (error.status === 403 || error.status === 404) return false; throw error; } });
    const offset = options.offset || 0, limit = options.limit || 25;
    return { drafts: rows.slice(offset, offset + limit).map(row => this.draftView(row)), total: rows.length, ...(offset + limit < rows.length ? { nextOffset: offset + limit } : {}) };
  }
  async attachments(ids, context, authorize) {
    if (!ids?.length) return [];
    if (typeof this.resolveAttachments !== 'function') throw new HttpError(400, '此服务尚未配置群内邮件附件。');
    authorize(); const values = await this.resolveAttachments({ sessionId: context.sessionId, attachmentIds: [...ids], authorize, signal: context.signal }); authorize();
    if (!Array.isArray(values) || values.length !== ids.length) throw new HttpError(400, '邮件附件无法读取，请重新选择群内文件。');
    let total = 0;
    const result = values.map(item => {
      if (!plain(item) || !(Buffer.isBuffer(item.content) || item.content instanceof Uint8Array)) throw new HttpError(400, '邮件附件内容无效。');
      total += item.content.byteLength;
      const name = line(item.name, '附件名称', 255), mimeType = line(item.mimeType || 'application/octet-stream', '附件类型', 200);
      if (/[\\/]/.test(name) || !/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(mimeType)) throw new HttpError(400, '邮件附件名称或类型无效。');
      return { name, mimeType, content: item.content };
    });
    if (total > 20 * 1024 * 1024) throw new HttpError(413, '邮件附件合计不能超过 20 MiB。');
    return result;
  }
  async prepareDraft(id, body, context) {
    this.access(id, context); const content = draftInput(body), request = body.clientRequestId === undefined ? null : token(body.clientRequestId);
    await this.attachments(content.attachmentIds, context, () => this.access(id, context));
    this.access(id, context);
    if (request) { const previous = this.db.prepare('SELECT * FROM email_drafts WHERE session_id=? AND client_request_id=?').get(context.sessionId, request); if (previous) { if (previous.account_id !== id || previous.content_json !== JSON.stringify(content)) throw new HttpError(409, '相同请求标识已用于其他邮件。'); return this.getDraft(previous.id, context); } }
    const draftId = randomUUID(), stamp = now(), actor = this.group(context);
    this.db.prepare('INSERT INTO email_drafts(id,account_id,session_id,content_json,created_by,created_at,updated_at,client_request_id) VALUES (?,?,?,?,?,?,?,?)').run(draftId, id, context.sessionId, JSON.stringify(content), actor.id, stamp, stamp, request);
    const row = this.draftRow(draftId); this.emit('email.draft_created', row); return this.draftView(row);
  }
  async updateDraft(id, body, context) {
    const row = this.draftAccess(id, context); if (row.status !== 'draft') throw new HttpError(409, '已开始发送的邮件不能修改，请另建草稿。');
    const content = draftInput(body); await this.attachments(content.attachmentIds, context, () => this.draftAccess(id, context));
    const current = this.draftAccess(id, context); if (current.status !== 'draft' || current.updated_at !== row.updated_at || current.content_json !== row.content_json) throw new HttpError(409, '草稿已更新，请刷新后重试。');
    this.db.prepare('UPDATE email_drafts SET content_json=?,updated_at=? WHERE id=?').run(JSON.stringify(content), now(), id); return this.getDraft(id, context);
  }
  async sendDraft(id, body = {}, context) {
    fields(body, ['idempotencyKey']); const { idempotencyKey } = body;
    if (context?.mode !== 'workspace') throw new HttpError(403, '当前智能体为只读模式，不能发送邮件。');
    token(idempotencyKey); const initial = this.draftAccess(id, context, true);
    if (initial.status !== 'draft') return this.draftView(initial);
    let started = false;
    try {
      await this.operation(initial.account_id, context, { send: true }, async (config, credentials, options) => {
        options.authorize();
        let current = this.draftAccess(id, context, true);
        if (current.status !== 'draft') return;
        const content = JSON.parse(current.content_json), { attachmentIds, ...draft } = content;
        const attachments = await this.attachments(attachmentIds, { ...context, signal: options.signal }, options.authorize);
        options.authorize(); const refreshed = this.draftAccess(id, context, true);
        if (refreshed.status !== 'draft') return;
        if (refreshed.content_json !== current.content_json || refreshed.updated_at !== current.updated_at) throw new HttpError(409, '草稿已更新，请核对后重新发送。');
        current = refreshed;
        started = this.store.transaction(() => {
          options.authorize(); const latest = this.draftAccess(id, context, true);
          if (latest.status !== 'draft') return false;
          if (latest.content_json !== current.content_json || latest.updated_at !== current.updated_at) throw new HttpError(409, '草稿已更新，请核对后重新发送。');
          if (this.db.prepare('SELECT id FROM email_drafts WHERE send_token=? AND id<>?').get(idempotencyKey, id)) throw new HttpError(409, '发送标识已用于另一封邮件，请刷新后重试。');
          return this.db.prepare("UPDATE email_drafts SET status='sending',send_token=?,sent_by=?,updated_at=? WHERE id=? AND status='draft'").run(idempotencyKey, context.actor.id, now(), id).changes === 1;
        });
        if (!started) return;
        this.emit('email.sending', this.draftRow(id));
        const recordResult = result => {
          const accepted = Array.isArray(result?.accepted) ? result.accepted.filter(value => typeof value === 'string').slice(0, 100) : [];
          const rejected = Array.isArray(result?.rejected) ? result.rejected.filter(value => typeof value === 'string').slice(0, 100) : [];
          const status = accepted.length ? 'sent' : rejected.length ? 'failed' : 'unknown';
          const summary = { ...(typeof result?.messageId === 'string' && result.messageId.length <= 1000 && !/[\r\n\x00]/.test(result.messageId) ? { messageId: result.messageId } : {}), accepted, rejected, partial: Boolean(accepted.length && rejected.length), message: status === 'sent' ? 'SMTP 服务器已接收邮件；最终送达请以收件方或退信为准。' : status === 'failed' ? '服务器未接受收件人，未完成发送。请修改后新建草稿。' : '发送结果未知，请先核对发件箱，切勿直接重发。' };
          if (plain(result?.sentCopy) && ['saved', 'already_present', 'unavailable', 'failed'].includes(result.sentCopy.status)) {
            summary.sentCopy = { status: result.sentCopy.status,
              ...(typeof result.sentCopy.folder === 'string' && result.sentCopy.folder.length <= 1000 && !/[\x00-\x1f\x7f]/.test(result.sentCopy.folder) ? { folder: result.sentCopy.folder } : {}) };
          }
          this.db.prepare("UPDATE email_drafts SET status=?,result_json=?,sent_at=COALESCE(sent_at,?),updated_at=? WHERE id=? AND (status='sending' OR (status='sent' AND ?='sent' AND send_token=?))")
            .run(status, JSON.stringify(this.scrub(summary)), status === 'sent' ? now() : null, now(), id, status, idempotencyKey);
        };
        try {
          const result = await this.adapter.send(config, credentials, { draft: { ...draft, ...(attachments.length ? { attachments } : {}) }, ...options,
            onAccepted: result => { if (Array.isArray(result?.accepted) && result.accepted.some(value => typeof value === 'string')) recordResult(result); } });
          recordResult(result);
        } catch (error) {
          const status = error?.delivery === 'not_sent' ? 'failed' : 'unknown';
          this.db.prepare("UPDATE email_drafts SET status=?,result_json=?,updated_at=? WHERE id=? AND status='sending'").run(status, JSON.stringify({ message: status === 'failed' ? '邮件未提交成功，请检查配置或内容后新建草稿。' : '发送结果未知，请先核对发件箱，切勿直接重发。' }), now(), id);
        }
      });
    } catch (error) {
      if (started) this.db.prepare("UPDATE email_drafts SET status='unknown',result_json=?,updated_at=? WHERE id=? AND status='sending'").run(JSON.stringify({ message: '发送过程被中断，结果未知。请先核对发件箱，切勿直接重发。' }), now(), id);
      this.draftAccess(id, context, true);
      if (!started) throw error;
    }
    const row = this.draftAccess(id, context, true); this.emit('email.send_result', row); return this.draftView(row);
  }
  close() { this.closed = true; for (const { controller } of this.operations.values()) controller.abort(); }
}
