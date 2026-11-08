import { HttpError } from './security.mjs';
import { createHash } from 'node:crypto';
import { EmailAdapterError, EMAIL_LIMITS } from './email-adapter.mjs';
import { formatMailboxRichBody, mailboxRichSanitizerVersion, sanitizeMailboxRichBody } from './mailbox-rich-body.mjs';
import { MailboxImageCache, mailboxImageHtmlHash } from './mailbox-image-cache.mjs';

const stamp = () => new Date().toISOString();
const kinds = ['inbox', 'sent'];
const archiveStartWindowMs = 15_000;
const archiveBatchStartWindowMs = 18_000;
const archiveBatchBodyTimeoutMs = 25_000;
const pollDueIntervalMs = 5_000;
const archiveProgressDelayMs = 5_000;
const archiveRetryDelayMs = 10_000;
const recentRichArchiveMs = 48 * 60 * 60_000;
const recentRichCandidates = 400;
const viewedRichPriorityLimit = 128;
const plainPublicationDelayMs = 120_000;
// 0 is published, 1 awaits its first archive, and 2 is visible while HTML catches up.
const publishedMailboxMessage = `(m.publish_after_archive<>1 OR m.remote_deleted=1 OR COALESCE(b.status='error' OR b.failures>0
  OR b.rich_failures>0 OR (b.status IN ('ready','partial') AND b.archived_at<=?),0))`;
const plainPublicationCutoff = () => new Date(Date.now() - plainPublicationDelayMs).toISOString();
const richArchiveBatchSize = 8;
const richArchiveStartWindowMs = 8_000;
const richArchiveBodyTimeoutMs = 5_000;
const inlineArchiveBatchSize = 2;
const inlineArchiveBodyTimeoutMs = 10_000;
const clean = (value, size = 1000) => String(value ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, size);
const uidString = value => {
  const result = String(value ?? '');
  if (!/^[1-9]\d{0,9}$/.test(result) || Number(result) > 0xffffffff) throw new HttpError(400, '邮件编号或文件夹版本无效。');
  return result;
};
function syncSinceDate(value) {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = new Date(`${value}T00:00:00Z`);
    if (Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value) return value;
  }
  throw new TypeError('邮件同步起始日期应为有效的 YYYY-MM-DD。');
}
function options(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new HttpError(400, '邮件参数含有不支持的字段。');
}
function kind(value = 'inbox') { if (!kinds.includes(value)) throw new HttpError(400, '请选择收件箱或已发送。'); return value; }
function metadata(value) {
  const addresses = input => (Array.isArray(input) ? input : []).slice(0, 50).map(item => ({ name: clean(item?.name, 200), address: clean(item?.address, 320) }));
  return { uid: Number(uidString(value.uid)), subject: clean(value.subject), from: addresses(value.from), to: addresses(value.to), cc: addresses(value.cc),
    date: typeof value.date === 'string' && Number.isFinite(Date.parse(value.date)) ? new Date(value.date).toISOString() : null,
    messageId: clean(value.messageId), size: Number.isSafeInteger(value.size) && value.size >= 0 ? value.size : null,
    seen: value.seen === true, hasAttachments: value.hasAttachments === true };
}
function searchText(message) { return [message.subject, message.messageId, ...[...message.from, ...message.to, ...message.cc].flatMap(value => [value.name, value.address])].join('\n').toLocaleLowerCase(); }
function attachmentDescriptor(value) {
  return {
    part: value.part,
    name: clean(value.name, 255),
    mimeType: clean(value.mimeType, 200),
    size: Number.isSafeInteger(value.size) && value.size >= 0 ? value.size : null,
    inline: value.inline === true,
    sizeIsEncoded: value.sizeIsEncoded === true
  };
}
function bodyArchive(value) {
  const text = typeof value.text === 'string' ? value.text : '';
  return { text: clean(text, 120_000), truncated: value.truncated === true || text.length > 120_000 || (Array.isArray(value.attachments) && value.attachments.length > EMAIL_LIMITS.mimeParts),
    warnings: (Array.isArray(value.warnings) ? value.warnings : []).slice(0, 20).map(value => clean(value, 500)),
    attachments: (Array.isArray(value.attachments) ? value.attachments : []).slice(0, EMAIL_LIMITS.mimeParts).filter(value => typeof value?.part === 'string' && /^\d+(?:\.\d+){0,19}$/.test(value.part)).map(attachmentDescriptor) };
}

/** Resolves a real server folder. Drafts, Outbox and INBOX are never Sent fallbacks. */
export function mailboxFolders(values) {
  const selectable = (Array.isArray(values) ? values : []).filter(value => value?.selectable !== false && typeof value?.path === 'string' && value.path.length <= 1000 && !/[\x00-\x1f\x7f]/.test(value.path));
  const inbox = selectable.find(value => value.path.toUpperCase() === 'INBOX') || selectable.find(value => value.specialUse === '\\Inbox');
  const sentCandidates = selectable.filter(value => value.path !== inbox?.path && value.path.toUpperCase() !== 'INBOX' && !/^(outbox|发件箱|寄件匣)$/i.test(value.name || value.path));
  const sent = sentCandidates.find(value => value.specialUse === '\\Sent') || sentCandidates.find(value => {
    const leaf = value.path.split(value.delimiter || '/').at(-1);
    return /^(sent|sent items|sent messages|sent mail|已发送|已发送邮件|已寄出|寄件备份|寄件備份)$/i.test(value.name || '') || /^(sent|sent items|sent messages|sent mail|已发送|已发送邮件|已寄出|寄件备份|寄件備份)$/i.test(leaf);
  });
  return { inbox: inbox || null, sent: sent || null };
}

/** Persistent local archive. HTML and attachment bytes never enter the body index. */
export class MailboxService {
  constructor(store, email, { intervalMs = 60_000, autoStart = false, maxConcurrency = 2, maxMessagesPerFolder = null, pageSize = 50, maxNewPages = 20, historyPagesPerSync = 1, bodyBatchSize = 40, bodyTimeoutMs = 30_000, syncSince, onEvent = () => {} } = {}) {
    this.store = store; this.db = store.db; this.email = email;
    this.stageNewMail = typeof email.adapter.readBatch === 'function' && typeof email.adapter.readRichBatch === 'function';
    this.syncSince = syncSinceDate(syncSince === undefined ? this.db.prepare('SELECT value FROM metadata WHERE key=?').get('mailbox.syncSince')?.value : syncSince);
    this.intervalMs = Math.max(10, intervalMs); this.maxConcurrency = Math.max(1, Math.min(2, maxConcurrency));
    this.maxMessages = Number.isSafeInteger(maxMessagesPerFolder) && maxMessagesPerFolder > 0 ? maxMessagesPerFolder : null; this.pageSize = Math.max(1, Math.min(50, pageSize));
    this.bodyBatchSize = Math.max(0, Math.min(40, bodyBatchSize)); this.bodyTimeoutMs = Math.max(10, Math.min(30_000, bodyTimeoutMs));
    this.maxNewPages = Math.max(1, maxNewPages); this.historyPages = Math.max(1, historyPagesPerSync); this.onEvent = onEvent;
    this.pending = new Map(); this.active = new Map(); this.archiveRetryFirst = new Map(); this.archiveNextFolder = new Map(); this.archiveResumeAt = new Map();
    this.archiveNextRichFolder = new Map();
    this.archiveNextStagedRichFolder = new Map();
    this.archivePreferExistingRich = new Set();
    this.viewedRichPriorities = new Map();
    this.viewedInlinePriorities = new Map();
    this.archiveNextInlineFolder = new Map();
    this.archivePreferImages = new Set();
    this.closed = false; this.started = false; this.timer = null;
    this.db.exec(`CREATE TABLE IF NOT EXISTS mailbox_scope_versions (
      account_id TEXT NOT NULL, account_version INTEGER NOT NULL, archive_version INTEGER NOT NULL, identity TEXT NOT NULL,identity_format INTEGER NOT NULL DEFAULT 2,
      PRIMARY KEY(account_id,account_version));
      CREATE INDEX IF NOT EXISTS mailbox_scope_identity ON mailbox_scope_versions(account_id,identity);
      CREATE TABLE IF NOT EXISTS mailbox_sync_accounts (
      account_id TEXT NOT NULL, account_version INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'idle',
      last_sync_at TEXT, error TEXT, failures INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(account_id,account_version));
      CREATE TABLE IF NOT EXISTS mailbox_folders (
      account_id TEXT NOT NULL, account_version INTEGER NOT NULL, kind TEXT NOT NULL, path TEXT, label TEXT NOT NULL,
      uid_validity TEXT, last_sync_at TEXT, status TEXT NOT NULL DEFAULT 'idle', error TEXT,
      highest_uid INTEGER NOT NULL DEFAULT 0, history_cursor TEXT, history_complete INTEGER NOT NULL DEFAULT 0,
      history_truncated INTEGER NOT NULL DEFAULT 0, head_cursor TEXT, head_boundary INTEGER NOT NULL DEFAULT 0,
      head_highest INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(account_id,account_version,kind));
      CREATE TABLE IF NOT EXISTS mailbox_messages (
      account_id TEXT NOT NULL, account_version INTEGER NOT NULL, path TEXT NOT NULL, uid_validity TEXT NOT NULL,
      uid INTEGER NOT NULL, summary_json TEXT NOT NULL, publish_after_archive INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(account_id,account_version,path,uid_validity,uid));
      CREATE TABLE IF NOT EXISTS mailbox_bodies (
      account_id TEXT NOT NULL, account_version INTEGER NOT NULL, path TEXT NOT NULL, uid_validity TEXT NOT NULL, uid INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', text TEXT NOT NULL DEFAULT '', search_text TEXT NOT NULL DEFAULT '',
      attachments_json TEXT NOT NULL DEFAULT '[]', warnings_json TEXT NOT NULL DEFAULT '[]', truncated INTEGER NOT NULL DEFAULT 0,
      archived_at TEXT, error TEXT, failures INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0,
      rich_failures INTEGER NOT NULL DEFAULT 0, rich_next_attempt_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(account_id,account_version,path,uid_validity,uid));
      CREATE INDEX IF NOT EXISTS mailbox_bodies_retry ON mailbox_bodies(account_id,account_version,status,next_attempt_at);
      CREATE TABLE IF NOT EXISTS mailbox_rich_bodies (
      account_id TEXT NOT NULL, account_version INTEGER NOT NULL, path TEXT NOT NULL, uid_validity TEXT NOT NULL, uid INTEGER NOT NULL,
      html TEXT NOT NULL, truncated INTEGER NOT NULL, sanitizer_version INTEGER NOT NULL,
      PRIMARY KEY(account_id,account_version,path,uid_validity,uid),
      FOREIGN KEY(account_id,account_version,path,uid_validity,uid) REFERENCES mailbox_messages(account_id,account_version,path,uid_validity,uid) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS mailbox_archive_attachments (
      account_id TEXT NOT NULL, account_version INTEGER NOT NULL, path TEXT NOT NULL, uid_validity TEXT NOT NULL, uid INTEGER NOT NULL, part TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', metadata_json TEXT NOT NULL, local_json TEXT NOT NULL DEFAULT '{}',
      archived_at TEXT, error TEXT, failures INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(account_id,account_version,path,uid_validity,uid,part));`);
    if (!this.db.prepare('PRAGMA table_info(mailbox_scope_versions)').all().some(value => value.name === 'identity_format')) this.db.exec('ALTER TABLE mailbox_scope_versions ADD COLUMN identity_format INTEGER NOT NULL DEFAULT 1');
    const columns = this.db.prepare('PRAGMA table_info(mailbox_messages)').all();
    if (!columns.some(value => value.name === 'search_text')) {
      this.db.exec("ALTER TABLE mailbox_messages ADD COLUMN search_text TEXT NOT NULL DEFAULT ''");
      let after = 0;
      for (;;) {
        const batch = this.db.prepare('SELECT rowid,summary_json FROM mailbox_messages WHERE rowid>? ORDER BY rowid LIMIT 250').all(after);
        if (!batch.length) break;
        for (const value of batch) { this.db.prepare('UPDATE mailbox_messages SET search_text=? WHERE rowid=?').run(searchText(metadata(JSON.parse(value.summary_json))), value.rowid); after = value.rowid; }
      }
    }
    if (!columns.some(value => value.name === 'remote_deleted')) this.db.exec('ALTER TABLE mailbox_messages ADD COLUMN remote_deleted INTEGER NOT NULL DEFAULT 0');
    if (!columns.some(value => value.name === 'publish_after_archive')) {
      this.store.transaction(() => {
        this.db.exec('ALTER TABLE mailbox_messages ADD COLUMN publish_after_archive INTEGER NOT NULL DEFAULT 0');
        if (this.stageNewMail) this.db.exec(`UPDATE mailbox_messages SET publish_after_archive=1 WHERE remote_deleted=0 AND EXISTS (
          SELECT 1 FROM mailbox_bodies b WHERE b.account_id=mailbox_messages.account_id AND b.account_version=mailbox_messages.account_version
          AND b.path=mailbox_messages.path AND b.uid_validity=mailbox_messages.uid_validity AND b.uid=mailbox_messages.uid
          AND b.status IN ('pending','archiving'))`);
        if (this.stageNewMail && this.syncSince) this.db.prepare(`UPDATE mailbox_messages AS m SET publish_after_archive=2
          WHERE m.remote_deleted=0 AND m.publish_after_archive=0 AND EXISTS (
            SELECT 1 FROM mailbox_bodies b WHERE b.account_id=m.account_id AND b.account_version=m.account_version AND b.path=m.path
            AND b.uid_validity=m.uid_validity AND b.uid=m.uid AND b.status IN ('ready','partial')) AND NOT EXISTS (
            SELECT 1 FROM mailbox_rich_bodies r WHERE r.account_id=m.account_id AND r.account_version=m.account_version AND r.path=m.path
            AND r.uid_validity=m.uid_validity AND r.uid=m.uid AND r.sanitizer_version=?)`).run(mailboxRichSanitizerVersion);
      });
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS mailbox_messages_staged ON mailbox_messages(account_id,account_version,path,uid_validity,publish_after_archive,uid DESC) WHERE publish_after_archive<>0 AND remote_deleted=0');
    const bodyColumns = this.db.prepare('PRAGMA table_info(mailbox_bodies)').all();
    for (const column of ['rich_failures', 'rich_next_attempt_at']) {
      if (!bodyColumns.some(value => value.name === column)) this.db.exec(`ALTER TABLE mailbox_bodies ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
    }
    // An interrupted poll resumes its durable cursors on the next run.
    this.db.exec("UPDATE mailbox_sync_accounts SET status='idle' WHERE status IN ('syncing','queued'); UPDATE mailbox_folders SET status='idle' WHERE status='syncing'; UPDATE mailbox_bodies SET status=CASE WHEN failures>0 THEN 'error' ELSE 'pending' END WHERE status='archiving'");
    if (!this.maxMessages) this.db.exec("UPDATE mailbox_folders SET history_truncated=0,history_complete=0,highest_uid=0,history_cursor=NULL,head_cursor=NULL,head_boundary=0,head_highest=0 WHERE history_truncated=1");
    this.imageCache = new MailboxImageCache(store, { retryBaseMs: this.intervalMs });
    this.seedInlineImageStates();
    if (autoStart) this.start();
  }
  emit(id) { try { this.onEvent({ type: 'mailbox.updated', accountId: id }); } catch {} }
  start() {
    if (this.timer) return;
    this.closed = false; this.started = true; this.tick();
    this.timer = setInterval(() => this.tick(), Math.min(this.intervalMs, pollDueIntervalMs)); this.timer.unref?.();
  }
  async stop() {
    this.closed = true; this.started = false; clearInterval(this.timer); this.timer = null; this.pending.clear();
    const work = [...this.active.values()]; for (const item of work) item.controller.abort();
    await Promise.allSettled(work.map(item => item.promise));
  }
  close() { return this.stop(); }
  async whenIdle() {
    while (this.pending.size || this.active.size) { this.drain(); await Promise.allSettled([...this.active.values()].map(item => item.promise)); }
  }
  current(id, version, signal) {
    signal?.throwIfAborted();
    const row = this.email.row(id), config = this.email.config(row);
    if (row.version !== version || !config.enabled) throw new HttpError(409, '邮箱配置已变更或停用，请刷新后重试。');
    return row;
  }
  storageVersion(id, version) {
    const known = this.db.prepare('SELECT archive_version,identity_format FROM mailbox_scope_versions WHERE account_id=? AND account_version=?').get(id, version);
    if (known?.identity_format === 2) return known.archive_version;
    const row = this.email.row(id), config = this.email.config(row);
    if (row.version !== version) throw new HttpError(409, '邮箱配置已变更，请刷新后重试。');
    const identity = createHash('sha256').update(JSON.stringify([config.email.trim().toLowerCase(), config.imap.host.trim().toLowerCase(), config.imap.port, config.imap.tls, config.imap.username])).digest('hex');
    const previous = this.db.prepare('SELECT archive_version FROM mailbox_scope_versions WHERE account_id=? AND identity=? AND identity_format=2 ORDER BY archive_version LIMIT 1').get(id, identity);
    const maximum = this.db.prepare('SELECT COALESCE(MAX(archive_version),0) AS maximum FROM mailbox_scope_versions WHERE account_id=?').get(id).maximum;
    const archiveVersion = previous?.archive_version ?? Math.max(version, maximum + 1);
    this.db.prepare('INSERT INTO mailbox_scope_versions(account_id,account_version,archive_version,identity,identity_format) VALUES (?,?,?,?,2) ON CONFLICT(account_id,account_version) DO UPDATE SET archive_version=excluded.archive_version,identity=excluded.identity,identity_format=2').run(id, version, archiveVersion, identity);
    return archiveVersion;
  }
  purgeVersions(id, version) {
    this.storageVersion(id, version);
    const active = this.active.get(id); if (active && active.version !== version) active.controller.abort();
  }
  access(id, context) { const row = this.email.access(id, context, context?.mailboxPublic === true ? { publicRead: true } : {}); this.purgeVersions(id, row.version); return row; }
  archiveKey(id, context) { const row = this.access(id, context), archiveVersion = this.storageVersion(id, row.version); return { accountId: id, version: row.version, archiveVersion, archiveId: `${id}:${archiveVersion}` }; }
  accountSync(id, version) {
    const row = this.db.prepare('SELECT * FROM mailbox_sync_accounts WHERE account_id=? AND account_version=?').get(id, this.storageVersion(id, version));
    return { status: this.active.get(id)?.syncMetadata ? 'syncing' : this.pending.get(id)?.syncMetadata ? 'queued' : row?.status || 'idle', lastSyncAt: row?.last_sync_at || null, error: row?.error || null };
  }
  listAccounts(context) {
    let accounts;
    if (context?.mailboxPublic === true) {
      this.email.actor(context);
      accounts = this.db.prepare('SELECT * FROM email_accounts WHERE deleted=0 ORDER BY created_at,id').all().filter(row => this.email.config(row).enabled).map(row => { const config = this.email.config(row); return { id: row.id, name: config.name, email: config.email, fromName: config.fromName, allowSend: false, smtpConfigured: false }; });
    } else accounts = this.email.listAvailable(context);
    return accounts.map(account => { const row = this.access(account.id, context); return { ...account, sync: this.accountSync(row.id, row.version) }; });
  }
  folderRow(id, version, folder) { return this.db.prepare('SELECT * FROM mailbox_folders WHERE account_id=? AND account_version=? AND kind=?').get(id, this.storageVersion(id, version), folder); }
  folderView(row, folder) {
    return { kind: folder, path: row?.path || null, label: row?.label || (folder === 'inbox' ? '收件箱' : '已发送'), uidValidity: row?.uid_validity || null,
      lastSyncAt: row?.last_sync_at || null, status: row?.status || 'idle', error: row?.error || null,
      historyComplete: Boolean(row?.history_complete) && !row?.history_truncated, truncated: Boolean(row?.history_truncated), archive: this.archiveStats(row) };
  }
  archiveStats(row) {
    if (!row?.path || !row.uid_validity) return { total: 0, ready: 0, partial: 0, pending: 0, error: 0 };
    const { preparing, ...counts } = this.db.prepare(`SELECT COUNT(*) AS total,COALESCE(SUM(b.status='ready'),0) AS ready,COALESCE(SUM(b.status='partial'),0) AS partial,COALESCE(SUM(b.status='error'),0) AS error,
      COALESCE(SUM(NOT ${publishedMailboxMessage}),0) AS preparing
      FROM mailbox_messages m LEFT JOIN mailbox_bodies b USING(account_id,account_version,path,uid_validity,uid)
      WHERE m.account_id=? AND m.account_version=? AND m.path=? AND m.uid_validity=?`).get(plainPublicationCutoff(), row.account_id, row.account_version, row.path, row.uid_validity);
    return { ...counts, pending: counts.total - counts.ready - counts.partial - counts.error, ...(preparing ? { preparing } : {}) };
  }
  messageArchive(row) {
    return { status: row?.body_status || 'pending', lastArchivedAt: row?.archived_at || null, error: row?.body_error || null, truncated: Boolean(row?.body_truncated), remoteDeleted: Boolean(row?.remote_deleted) };
  }
  folders(id, context) { const row = this.access(id, context); return { folders: kinds.map(folder => this.folderView(this.folderRow(id, row.version, folder), folder)) }; }
  listMessages(id, input = {}, context) {
    const account = this.access(id, context); options(input, ['folder', 'query', 'limit', 'offset']); const folder = kind(input.folder);
    const query = input.query ?? '', limit = input.limit ?? 50, offset = input.offset ?? 0;
    if (typeof query !== 'string' || query.length > 500 || !Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) throw new HttpError(400, '邮件搜索或分页参数无效。');
    const row = this.folderRow(id, account.version, folder), view = this.folderView(row, folder), av = this.storageVersion(id, account.version);
    const needle = query.trim().toLocaleLowerCase(), args = [id, av, row?.path || '', row?.uid_validity || '', needle, needle, needle];
    const publicRead = context?.mailboxPublic === true;
    if (publicRead) args.push(plainPublicationCutoff());
    const where = `FROM mailbox_messages m LEFT JOIN mailbox_bodies b USING(account_id,account_version,path,uid_validity,uid)
      WHERE m.account_id=? AND m.account_version=? AND m.path=? AND m.uid_validity=? AND (?='' OR instr(m.search_text,?)>0 OR (b.status IN ('ready','partial') AND instr(b.search_text,?)>0))
      ${publicRead ? `AND ${publishedMailboxMessage}` : ''}`;
    const total = this.db.prepare(`SELECT COUNT(*) AS total ${where}`).get(...args).total;
    const rows = this.db.prepare(`SELECT m.summary_json,m.remote_deleted,b.status AS body_status,b.archived_at,b.error AS body_error,b.truncated AS body_truncated ${where} ORDER BY m.uid DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
    const messages = rows.map(value => ({ ...JSON.parse(value.summary_json), archive: this.messageArchive(value) }));
    const hasMore = offset + limit < total;
    return { messages, total, hasMore, nextOffset: hasMore ? offset + limit : null, folder,
      uidValidity: view.uidValidity, sync: { ...view, status: this.active.get(id)?.syncMetadata && view.status !== 'not_found' ? 'syncing' : view.status }, searchScope: 'local_archive' };
  }
  requestSync(id, context) {
    const row = this.access(id, context); if (this.closed) throw new HttpError(503, '邮件同步服务正在关闭。');
    const av = this.storageVersion(id, row.version);
    this.db.prepare("UPDATE mailbox_bodies SET next_attempt_at=0 WHERE account_id=? AND account_version=? AND status='error'").run(id, av);
    this.enqueue(row.id, row.version); return { queued: true, accountId: id, sync: this.accountSync(id, row.version) };
  }
  loadMore(id, input = {}, context) {
    options(input, ['folder']); const folder = kind(input.folder), row = this.access(id, context);
    if (this.closed) throw new HttpError(503, '邮件同步服务正在关闭。');
    this.enqueue(id, row.version, folder); return { queued: true, accountId: id, folder };
  }
  reference(id, input, context, attachment = false) {
    const account = this.access(id, context); options(input, ['folder', 'uid', 'uidValidity', ...(attachment ? ['part'] : [])]);
    const folder = kind(input.folder), uid = uidString(input.uid), validity = uidString(input.uidValidity), row = this.folderRow(id, account.version, folder);
    if (!row?.path || !row.uid_validity) throw new HttpError(409, '请先同步此邮件文件夹。');
    if (row.uid_validity !== validity) throw new HttpError(409, '邮箱的邮件编号已重置，请刷新后重试。');
    const av = this.storageVersion(id, account.version);
    if (!this.db.prepare('SELECT 1 FROM mailbox_messages WHERE account_id=? AND account_version=? AND path=? AND uid_validity=? AND uid=?').get(id, av, row.path, validity, Number(uid))) throw new HttpError(404, '邮件尚未同步到本地归档，请先刷新邮件。');
    if (attachment && (typeof input.part !== 'string' || !/^\d+(?:\.\d+){0,19}$/.test(input.part) || input.part.length > 100)) throw new HttpError(400, '邮件附件标识无效。');
    if (attachment && !this.db.prepare('SELECT 1 FROM mailbox_archive_attachments WHERE account_id=? AND account_version=? AND path=? AND uid_validity=? AND uid=? AND part=?').get(id, av, row.path, validity, Number(uid), input.part)) throw new HttpError(404, '此邮件没有已识别的附件，请先打开邮件归档。');
    return { folder: row.path, uid, uidValidity: validity, ...(attachment ? { part: input.part } : {}) };
  }
  async readMessage(id, input, context) {
    const version = this.access(id, context).version, reference = this.reference(id, input, context), av = this.storageVersion(id, version);
    const publicRead = context?.mailboxPublic === true;
    const withRichBody = row => {
      const message = this.archivedMessage(row);
      if (!publicRead) return message;
      const rich = this.richArchive(id, version, reference, context.signal).body;
      if (!rich) this.prioritizeRichBody(id, version, reference);
      return rich ? { ...message, richBody: formatMailboxRichBody(rich) } : message;
    };
    const cached = this.db.prepare("SELECT b.*,m.summary_json,m.remote_deleted FROM mailbox_bodies b JOIN mailbox_messages m USING(account_id,account_version,path,uid_validity,uid) WHERE b.account_id=? AND b.account_version=? AND b.path=? AND b.uid_validity=? AND b.uid=? AND b.status IN ('ready','partial')").get(id, av, reference.folder, reference.uidValidity, Number(reference.uid));
    if (cached) return withRichBody(cached);
    const result = await this.email.readMessage(id, reference, context, publicRead ? { publicRead: true } : {}, { includeRichBody: publicRead ? 'reuse' : false });
    if (this.access(id, context).version !== version) throw new HttpError(409, '邮箱配置已变更，请刷新后重试。');
    this.reference(id, input, context); this.storeBody(id, version, reference, result, context.signal);
    const body = this.db.prepare('SELECT b.*,m.summary_json,m.remote_deleted FROM mailbox_bodies b JOIN mailbox_messages m USING(account_id,account_version,path,uid_validity,uid) WHERE b.account_id=? AND b.account_version=? AND b.path=? AND b.uid_validity=? AND b.uid=?').get(id, av, reference.folder, reference.uidValidity, Number(reference.uid));
    return withRichBody(body);
  }
  richArchive(id, version, reference, signal) {
    this.current(id, version, signal);
    const av = this.storageVersion(id, version);
    const row = this.db.prepare(`SELECT r.html,r.truncated,m.remote_deleted FROM mailbox_messages m
      LEFT JOIN mailbox_rich_bodies r ON r.account_id=m.account_id AND r.account_version=m.account_version AND r.path=m.path
      AND r.uid_validity=m.uid_validity AND r.uid=m.uid AND r.sanitizer_version=?
      WHERE m.account_id=? AND m.account_version=? AND m.path=? AND m.uid_validity=? AND m.uid=?`)
      .get(mailboxRichSanitizerVersion, id, av, reference.folder, reference.uidValidity, Number(reference.uid));
    return { body: typeof row?.html === 'string' ? { html: row.html, truncated: Boolean(row.truncated) } : null, remoteDeleted: Boolean(row?.remote_deleted) };
  }
  imageScope(id, av, reference) {
    return { accountId: id, archiveVersion: av, folder: reference.folder, uidValidity: reference.uidValidity, uid: reference.uid };
  }
  seedInlineImageStates() {
    const rows = this.db.prepare(`SELECT r.account_id,r.account_version,r.path,r.uid_validity,r.uid,r.html FROM mailbox_rich_bodies r
      JOIN email_accounts e ON e.id=r.account_id AND e.deleted=0
      JOIN mailbox_scope_versions v ON v.account_id=e.id AND v.account_version=e.version AND v.archive_version=r.account_version
      JOIN mailbox_folders f USING(account_id,account_version,path,uid_validity)
      LEFT JOIN mailbox_inline_image_state s USING(account_id,account_version,path,uid_validity,uid)
      WHERE r.sanitizer_version=? AND s.uid IS NULL ORDER BY r.uid DESC LIMIT 16`).all(mailboxRichSanitizerVersion);
    for (const row of rows) this.imageCache.prepareInline(this.imageScope(row.account_id, row.account_version,
      { folder: row.path, uidValidity: row.uid_validity, uid: row.uid }), row.html);
  }
  inlineArchive(id, version, reference, signal) {
    const rich = this.richArchive(id, version, reference, signal).body;
    if (!rich) return null;
    const scope = this.imageScope(id, this.storageVersion(id, version), reference);
    this.imageCache.prepareInline(scope, rich.html);
    return this.imageCache.readInline(scope, rich.html);
  }
  storeInlineImages(id, version, reference, source, signal) {
    const rich = this.richArchive(id, version, reference, signal).body;
    if (!rich) return null;
    const av = this.storageVersion(id, version), scope = this.imageScope(id, av, reference);
    let stored;
    this.store.transaction(() => {
      stored = this.imageCache.storeInline(scope, rich.html, source);
      this.publishReadyMessage(id, av, reference);
    });
    return stored;
  }
  recordInlineImageFailure(id, version, reference, signal) {
    const rich = this.richArchive(id, version, reference, signal).body;
    if (!rich) return null;
    return this.imageCache.recordInlineFailure(this.imageScope(id, this.storageVersion(id, version), reference), rich.html);
  }
  externalImageArchive(id, version, reference, url, signal) {
    this.current(id, version, signal);
    return this.imageCache.readExternal(this.imageScope(id, this.storageVersion(id, version), reference), url);
  }
  storeExternalImage(id, version, reference, url, image, signal) {
    this.current(id, version, signal);
    return this.imageCache.storeExternal(this.imageScope(id, this.storageVersion(id, version), reference), url, image);
  }
  storeRichBody(id, version, reference, source, signal) {
    this.current(id, version, signal);
    const body = sanitizeMailboxRichBody(source);
    if (!body) return null;
    const av = this.storageVersion(id, version);
    this.store.transaction(() => {
      this.writeRichBody(id, av, reference, body);
      this.publishReadyMessage(id, av, reference);
    });
    return this.richArchive(id, version, reference, signal).body;
  }
  writeRichBody(id, av, reference, body) {
    this.db.prepare(`INSERT INTO mailbox_rich_bodies(account_id,account_version,path,uid_validity,uid,html,truncated,sanitizer_version)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(account_id,account_version,path,uid_validity,uid) DO UPDATE SET
      html=excluded.html,truncated=excluded.truncated,sanitizer_version=excluded.sanitizer_version
      WHERE mailbox_rich_bodies.sanitizer_version<>excluded.sanitizer_version OR (mailbox_rich_bodies.truncated=1 AND excluded.truncated=0)`)
      .run(id, av, reference.folder, reference.uidValidity, Number(reference.uid), body.html, Number(body.truncated), mailboxRichSanitizerVersion);
    const current = this.db.prepare('SELECT html FROM mailbox_rich_bodies WHERE account_id=? AND account_version=? AND path=? AND uid_validity=? AND uid=?')
      .get(id, av, reference.folder, reference.uidValidity, Number(reference.uid));
    this.imageCache.prepareInline(this.imageScope(id, av, reference), current.html);
  }
  publishReadyMessage(id, av, reference) {
    const rich = this.db.prepare('SELECT html FROM mailbox_rich_bodies WHERE account_id=? AND account_version=? AND path=? AND uid_validity=? AND uid=? AND sanitizer_version=?')
      .get(id, av, reference.folder, reference.uidValidity, Number(reference.uid), mailboxRichSanitizerVersion);
    if (!rich || !this.imageCache.isInlineReady(this.imageScope(id, av, reference), rich.html)) return;
    this.db.prepare(`UPDATE mailbox_messages AS m SET publish_after_archive=0
      WHERE m.account_id=? AND m.account_version=? AND m.path=? AND m.uid_validity=? AND m.uid=? AND m.publish_after_archive<>0
      AND EXISTS (SELECT 1 FROM mailbox_bodies b JOIN mailbox_rich_bodies r USING(account_id,account_version,path,uid_validity,uid)
        WHERE b.account_id=m.account_id AND b.account_version=m.account_version AND b.path=m.path AND b.uid_validity=m.uid_validity AND b.uid=m.uid
        AND b.status IN ('ready','partial') AND r.sanitizer_version=?)`)
      .run(id, av, reference.folder, reference.uidValidity, Number(reference.uid), mailboxRichSanitizerVersion);
  }
  attachmentReference(id, input, context) { return this.reference(id, input, context, true); }
  attachmentMetadata(id, input, context) {
    const account = this.access(id, context);
    const reference = this.attachmentReference(id, input, context);
    const archiveVersion = this.storageVersion(id, account.version);
    const row = this.db.prepare('SELECT metadata_json FROM mailbox_archive_attachments WHERE account_id=? AND account_version=? AND path=? AND uid_validity=? AND uid=? AND part=?')
      .get(id, archiveVersion, reference.folder, reference.uidValidity, Number(reference.uid), reference.part);
    if (!row) throw new HttpError(404, '此邮件没有已识别的附件，请先打开邮件。');
    return attachmentDescriptor({ ...JSON.parse(row.metadata_json), part: reference.part });
  }
  invalidate(id) {
    this.active.get(id)?.controller.abort(); this.pending.delete(id);
    this.archiveRetryFirst.delete(id); this.archiveNextFolder.delete(id); this.archiveResumeAt.delete(id);
    this.archiveNextRichFolder.delete(id);
    this.archiveNextStagedRichFolder.delete(id);
    this.archivePreferExistingRich.delete(id);
    for (const [key, entry] of this.viewedRichPriorities) if (entry.id === id) this.viewedRichPriorities.delete(key);
    for (const [key, entry] of this.viewedInlinePriorities) if (entry.id === id) this.viewedInlinePriorities.delete(key);
    this.archiveNextInlineFolder.delete(id); this.archivePreferImages.delete(id);
    const row = this.db.prepare('SELECT * FROM email_accounts WHERE id=? AND deleted=0').get(id);
    if (row) this.storageVersion(id, row.version);
    if (this.started && !this.closed && row && this.email.config(row).enabled) this.enqueue(id, row.version);
  }
  onAccountChanged(id) { this.invalidate(id); }
  tick() {
    if (this.closed || !this.started) return;
    this.seedInlineImageStates();
    const now = Date.now();
    const syncState = this.db.prepare('SELECT status,next_attempt_at FROM mailbox_sync_accounts WHERE account_id=? AND account_version=?');
    const archiveDue = this.db.prepare(`SELECT 1 FROM mailbox_bodies job
      JOIN mailbox_messages m USING(account_id,account_version,path,uid_validity,uid)
      JOIN mailbox_folders f USING(account_id,account_version,path,uid_validity)
      WHERE job.account_id=? AND job.account_version=? AND job.status IN ('pending','error') AND job.next_attempt_at<=? AND m.remote_deleted=0 LIMIT 1`);
    for (const row of this.db.prepare('SELECT * FROM email_accounts WHERE deleted=0').all()) {
      if (!this.email.config(row).enabled) continue;
      this.purgeVersions(row.id, row.version);
      if (this.active.has(row.id)) continue;
      const av = this.storageVersion(row.id, row.version), state = syncState.get(row.id, av);
      if (!state || state.next_attempt_at <= now) this.enqueue(row.id, row.version);
      else if (this.bodyBatchSize && state.status !== 'error' && !this.pending.has(row.id) && (this.archiveResumeAt.get(row.id)?.at || 0) <= now
        && (archiveDue.get(row.id, av, now) || this.richArchiveJobs(row.id, av, now))) {
        this.enqueue(row.id, row.version, null, false);
      }
    }
  }
  enqueue(id, version, folder, syncMetadata = true) {
    const item = this.pending.get(id) || { version, folders: new Set(), syncMetadata: false };
    item.version = version; item.syncMetadata ||= syncMetadata;
    if (folder) item.folders.add(folder); this.pending.set(id, item); queueMicrotask(() => this.drain());
  }
  drain() {
    if (this.closed) return;
    const ordered = [...this.pending].sort((a, b) => Number(b[1].syncMetadata) - Number(a[1].syncMetadata));
    for (const [id, item] of ordered) {
      if (this.active.size >= this.maxConcurrency) break;
      if (this.active.has(id)) continue;
      this.pending.delete(id); const controller = new AbortController(), task = { controller, version: item.version, syncMetadata: item.syncMetadata, promise: null };
      this.active.set(id, task);
      const work = item.syncMetadata ? this.syncAccount(id, item.version, controller.signal, item.folders) : this.archiveBodies(id, item.version, controller.signal);
      task.promise = work.catch(() => {}).finally(() => { this.active.delete(id); this.emit(id); this.drain(); });
    }
  }
  adminContext(row, signal) {
    const actor = this.db.prepare("SELECT id,role FROM users WHERE disabled=0 AND role='admin' ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END,created_at,id LIMIT 1").get(row.created_by);
    if (!actor) throw new HttpError(403, '当前没有可用管理员，邮件自动同步已暂停。');
    return { actor, signal, authorize: () => this.current(row.id, row.version, signal) };
  }
  async remote(id, version, context, action) {
    this.current(id, version, context.signal);
    const result = await this.email.operation(id, context, { admin: true }, (config, credentials, runtime) => action(config, credentials, { ...runtime, authorize: () => { runtime.authorize(); this.current(id, version, context.signal); }, guard: () => { runtime.authorize(); this.current(id, version, context.signal); } }));
    this.current(id, version, context.signal); return result;
  }
  resetFolder(id, version, folder, path, label, validity) {
    const av = this.storageVersion(id, version);
    this.db.prepare('DELETE FROM mailbox_folders WHERE account_id=? AND account_version=? AND kind=?').run(id, av, folder);
    this.db.prepare('INSERT INTO mailbox_folders(account_id,account_version,kind,path,label,uid_validity) VALUES (?,?,?,?,?,?)').run(id, av, folder, path, label, validity);
  }
  async syncAccount(id, version, signal, requestedFolders) {
    let context;
    try {
      const account = this.current(id, version, signal); this.purgeVersions(id, version);
      const av = this.storageVersion(id, version);
      this.db.prepare("INSERT INTO mailbox_sync_accounts(account_id,account_version,status) VALUES (?,?,'syncing') ON CONFLICT(account_id,account_version) DO UPDATE SET status='syncing',error=NULL").run(id, av);
      context = this.adminContext(account, signal);
      const listing = await this.remote(id, version, context, (config, credentials, runtime) => this.email.adapter.folders(config, credentials, runtime));
      const resolved = mailboxFolders(listing.folders), failures = [];
      for (const folder of kinds) {
        this.current(id, version, signal); const value = resolved[folder], old = this.folderRow(id, version, folder), label = folder === 'inbox' ? '收件箱' : '已发送';
        if (!value) {
          this.resetFolder(id, version, folder, null, label, null);
          this.db.prepare("UPDATE mailbox_folders SET status='not_found',error=? WHERE account_id=? AND account_version=? AND kind=?").run(listing.truncated ? '服务器文件夹列表被截断，尚未找到此文件夹。' : `服务器未提供可识别的${label}文件夹。`, id, av, folder); continue;
        }
        let validity = value.uidValidity ? uidString(value.uidValidity) : null;
        if (!old || old.path !== value.path || validity && old.uid_validity && validity !== old.uid_validity) this.resetFolder(id, version, folder, value.path, label, validity);
        try { await this.syncFolder(id, version, folder, context, requestedFolders.has(folder) ? this.historyPages + 1 : this.historyPages); }
        catch (error) {
          this.current(id, version, signal);
          const message = this.safeError(error); failures.push(message);
          this.db.prepare("UPDATE mailbox_folders SET status='error',error=? WHERE account_id=? AND account_version=? AND kind=?").run(message, id, av, folder);
        }
      }
      this.current(id, version, signal);
      if (failures.length) throw new HttpError(502, failures[0]);
      const unfinished = this.db.prepare('SELECT 1 FROM mailbox_folders WHERE account_id=? AND account_version=? AND head_cursor IS NOT NULL').get(id, av);
      this.db.prepare('UPDATE mailbox_sync_accounts SET status=?,last_sync_at=?,error=NULL,failures=0,next_attempt_at=? WHERE account_id=? AND account_version=?').run(unfinished ? 'syncing' : 'ready', stamp(), Date.now() + this.intervalMs, id, av);
    } catch (error) {
      try {
        this.current(id, version); const av = this.storageVersion(id, version), prior = this.db.prepare('SELECT failures FROM mailbox_sync_accounts WHERE account_id=? AND account_version=?').get(id, av);
        const failures = (prior?.failures || 0) + 1;
        this.db.prepare("UPDATE mailbox_sync_accounts SET status=?,error=?,failures=?,next_attempt_at=? WHERE account_id=? AND account_version=?").run(signal.aborted ? 'idle' : 'error', signal.aborted ? null : this.safeError(error), failures, Date.now() + Math.min(15 * 60_000, this.intervalMs * 2 ** Math.min(failures, 10)), id, av);
        if (signal.aborted) this.db.prepare("UPDATE mailbox_folders SET status='idle' WHERE account_id=? AND account_version=? AND status='syncing'").run(id, av);
      } catch { /* Deleted, disabled and superseded accounts must never receive stale writes. */ }
    }
    if (context && !signal.aborted) {
      try { await this.archiveBodies(id, version, signal, true); }
      catch { /* Body archive retries never turn an otherwise successful mailbox poll into an error. */ }
    }
  }
  archivedMessage(row) {
    const attachments = JSON.parse(row.attachments_json).map(value => {
      const cached = this.db.prepare("SELECT local_json FROM mailbox_archive_attachments WHERE account_id=? AND account_version=? AND path=? AND uid_validity=? AND uid=? AND part=? AND status='ready'").get(row.account_id, row.account_version, row.path, row.uid_validity, row.uid, value.part);
      return cached ? { ...value, ...JSON.parse(cached.local_json) } : value;
    });
    return { ...JSON.parse(row.summary_json), folder: row.path, uidValidity: row.uid_validity, text: row.text, attachments, warnings: JSON.parse(row.warnings_json), truncated: Boolean(row.truncated),
      archive: { status: row.status, lastArchivedAt: row.archived_at, truncated: Boolean(row.truncated), remoteDeleted: Boolean(row.remote_deleted) } };
  }
  storeBody(id, version, reference, result, signal) {
    this.current(id, version, signal);
    if (result.uidValidity !== undefined && String(result.uidValidity) !== reference.uidValidity || result.uid !== undefined && Number(result.uid) !== Number(reference.uid)) throw new HttpError(409, '邮箱编号已变更，正文未归档。');
    const av = this.storageVersion(id, version), body = bodyArchive(result), summary = metadata({ ...result, uid: reference.uid });
    const rich = sanitizeMailboxRichBody(result.richBody);
    this.store.transaction(() => {
      this.current(id, version, signal);
      this.db.prepare('INSERT OR IGNORE INTO mailbox_messages(account_id,account_version,path,uid_validity,uid,summary_json,search_text) VALUES (?,?,?,?,?,?,?)').run(id, av, reference.folder, reference.uidValidity, Number(reference.uid), JSON.stringify(summary), searchText(summary));
      this.db.prepare(`INSERT INTO mailbox_bodies(account_id,account_version,path,uid_validity,uid,status,text,search_text,attachments_json,warnings_json,truncated,archived_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id,account_version,path,uid_validity,uid) DO UPDATE SET
        status=excluded.status,text=excluded.text,search_text=excluded.search_text,attachments_json=excluded.attachments_json,warnings_json=excluded.warnings_json,truncated=excluded.truncated,archived_at=excluded.archived_at,error=NULL,failures=0,next_attempt_at=0`)
        .run(id, av, reference.folder, reference.uidValidity, Number(reference.uid), body.truncated ? 'partial' : 'ready', body.text, body.text.toLocaleLowerCase(), JSON.stringify(body.attachments), JSON.stringify(body.warnings), body.truncated ? 1 : 0, stamp());
      for (const attachment of body.attachments) this.db.prepare('INSERT INTO mailbox_archive_attachments(account_id,account_version,path,uid_validity,uid,part,metadata_json) VALUES (?,?,?,?,?,?,?) ON CONFLICT(account_id,account_version,path,uid_validity,uid,part) DO UPDATE SET metadata_json=excluded.metadata_json').run(id, av, reference.folder, reference.uidValidity, Number(reference.uid), attachment.part, JSON.stringify(attachment));
      if (rich) this.writeRichBody(id, av, reference, rich);
      const storedRich = this.db.prepare('SELECT html FROM mailbox_rich_bodies WHERE account_id=? AND account_version=? AND path=? AND uid_validity=? AND uid=? AND sanitizer_version=?')
        .get(id, av, reference.folder, reference.uidValidity, Number(reference.uid), mailboxRichSanitizerVersion);
      if (storedRich && result.inlineImages) this.imageCache.storeInline(this.imageScope(id, av, reference), storedRich.html, result.inlineImages);
      this.publishReadyMessage(id, av, reference);
    });
  }
  bodyArchiveFailure(id, av, row, error) {
    const failures = row.failures + 1, delay = Math.min(60 * 60_000, this.intervalMs * 2 ** Math.min(failures, 10));
    if (error instanceof EmailAdapterError && error.code === 'timeout') error = new HttpError(504, '邮件正文归档超时，将自动重试。');
    if (error instanceof EmailAdapterError && error.code === 'output_limit') error = new HttpError(error.status, error.message);
    this.store.transaction(() => {
      const key = [id, av, row.path, row.uid_validity, row.uid];
      const updated = this.db.prepare("UPDATE mailbox_bodies SET status='error',error=?,failures=?,next_attempt_at=? WHERE account_id=? AND account_version=? AND path=? AND uid_validity=? AND uid=? AND status='archiving'")
        .run(this.safeError(error), failures, Date.now() + delay, ...key);
      if (updated.changes) this.db.prepare('UPDATE mailbox_messages SET publish_after_archive=2 WHERE account_id=? AND account_version=? AND path=? AND uid_validity=? AND uid=? AND publish_after_archive=1').run(...key);
    });
  }
  bodyArchiveJobs(id, archiveVersion) {
    const batchSize = this.bodyBatchSize;
    const select = this.db.prepare(`SELECT job.*,m.publish_after_archive FROM mailbox_bodies job
      JOIN mailbox_messages m USING(account_id,account_version,path,uid_validity,uid)
      JOIN mailbox_folders f USING(account_id,account_version,path,uid_validity)
      WHERE job.account_id=? AND job.account_version=? AND f.kind=? AND job.status=? AND job.next_attempt_at<=? AND m.remote_deleted=0
      ORDER BY job.next_attempt_at,job.uid DESC LIMIT ?`);
    const now = Date.now(), retryFirst = this.archiveRetryFirst.get(id);
    const folderOrder = this.archiveNextFolder.get(id) === 'sent' ? ['sent', 'inbox'] : kinds;
    const groups = folderOrder.map(kind => {
      const fresh = select.all(id, archiveVersion, kind, 'pending', now, batchSize);
      const retries = select.all(id, archiveVersion, kind, 'error', now, batchSize);
      const alternateRetry = fresh.length > 0 && retries.length > 0;
      let candidates = fresh.length ? fresh : retries;
      if (alternateRetry) {
        // Reserve a retry in each folder when both queues have work.
        const [first, second] = retryFirst?.has(kind) ? [retries[0], fresh[0]] : [fresh[0], retries[0]];
        candidates = [first, second, ...fresh.slice(1), ...retries.slice(1)];
      }
      return { kind, alternateRetry, candidates, jobs: [] };
    });
    // Assign alternating slots to folders, then make one IMAP call per folder.
    let count = 0;
    for (let index = 0; index < batchSize && count < batchSize; index++) {
      for (const group of groups) {
        if (count === batchSize) break;
        const job = group.candidates[index];
        if (job) { group.jobs.push(job); count++; }
      }
    }
    const selected = groups.filter(group => group.jobs.length);
    if (selected.length) this.archiveNextFolder.set(id, selected[0].kind === 'inbox' ? 'sent' : 'inbox');
    return selected;
  }
  richArchiveJobs(id, av, now) {
    const rich = () => this.richOnlyArchiveJobs(id, av, now);
    const images = () => this.inlineArchiveJobs(id, av, now);
    return this.archivePreferImages.has(id) ? images() || rich() : rich() || images();
  }
  richOnlyArchiveJobs(id, av, now) {
    if (typeof this.email.adapter.readRichBatch !== 'function') return null;
    const folders = this.db.prepare(`SELECT kind,path,uid_validity FROM mailbox_folders
      WHERE account_id=? AND account_version=? AND path IS NOT NULL AND uid_validity IS NOT NULL
      ORDER BY kind`).all(id, av);
    const order = preference => preference.get(id) === 'sent' ? folders.toReversed() : folders;
    const staged = () => this.stagedRichArchiveJobs(id, av, now, order(this.archiveNextStagedRichFolder));
    const existing = () => this.existingRichArchiveJobs(id, av, now, order(this.archiveNextRichFolder));
    return this.archivePreferExistingRich.has(id) ? existing() || staged() : staged() || existing();
  }
  stagedRichArchiveJobs(id, av, now, folders) {
    const select = this.db.prepare(`SELECT m.uid,b.rich_failures FROM mailbox_messages m
      JOIN mailbox_bodies b USING(account_id,account_version,path,uid_validity,uid)
      LEFT JOIN mailbox_rich_bodies r ON r.account_id=m.account_id AND r.account_version=m.account_version
      AND r.path=m.path AND r.uid_validity=m.uid_validity AND r.uid=m.uid AND r.sanitizer_version=?
      WHERE m.account_id=? AND m.account_version=? AND m.path=? AND m.uid_validity=? AND m.publish_after_archive<>0
      AND m.remote_deleted=0 AND b.status IN ('ready','partial') AND b.rich_next_attempt_at<=? AND r.uid IS NULL
      ORDER BY m.publish_after_archive,m.uid DESC LIMIT ?`);
    for (const folder of folders) {
      const jobs = select.all(mailboxRichSanitizerVersion, id, av, folder.path, folder.uid_validity, now, richArchiveBatchSize);
      if (jobs.length) return { ...folder, jobs, staged: true };
    }
    return null;
  }
  existingRichArchiveJobs(id, av, now, folders) {
    if (this.viewedRichPriorities.size) {
      const selectViewed = this.richArchiveCandidate();
      let group = null;
      for (const [key, entry] of this.viewedRichPriorities) {
        if (entry.id !== id) continue;
        const { folder: path, uidValidity: uid_validity, uid } = entry;
        const row = entry.av === av && selectViewed.get(mailboxRichSanitizerVersion, id, av, path, uid_validity, Number(uid));
        if (!row) { this.viewedRichPriorities.delete(key); continue; }
        if (row.rich_next_attempt_at > now) continue;
        if (!group) group = { kind: row.kind, path, uid_validity, jobs: [] };
        if (group.path !== path || group.uid_validity !== uid_validity) continue;
        group.jobs.push({ uid, rich_failures: row.rich_failures, priorityKey: key });
        if (group.jobs.length === richArchiveBatchSize) break;
      }
      if (group) return group;
    }
    const select = this.db.prepare(`WITH recent AS MATERIALIZED (
      SELECT account_id,account_version,path,uid_validity,uid,summary_json FROM mailbox_messages
      WHERE account_id=? AND account_version=? AND path=? AND uid_validity=? AND remote_deleted=0 AND publish_after_archive=0 ORDER BY uid DESC LIMIT ?
    ) SELECT recent.uid,b.rich_failures FROM recent JOIN mailbox_bodies b USING(account_id,account_version,path,uid_validity,uid)
      LEFT JOIN mailbox_rich_bodies r ON r.account_id=recent.account_id AND r.account_version=recent.account_version
      AND r.path=recent.path AND r.uid_validity=recent.uid_validity AND r.uid=recent.uid AND r.sanitizer_version=?
      WHERE b.status IN ('ready','partial') AND b.rich_next_attempt_at<=? AND r.uid IS NULL
      AND json_extract(recent.summary_json,'$.date')>=? ORDER BY recent.uid DESC LIMIT ?`);
    const since = new Date(now - recentRichArchiveMs).toISOString();
    for (const folder of folders) {
      const jobs = select.all(id, av, folder.path, folder.uid_validity, recentRichCandidates, mailboxRichSanitizerVersion, now, since, richArchiveBatchSize);
      if (jobs.length) return { ...folder, jobs };
    }
    return null;
  }
  richArchiveCandidate() {
    return this.db.prepare(`SELECT f.kind,b.rich_failures,b.rich_next_attempt_at FROM mailbox_bodies b
      JOIN mailbox_messages m USING(account_id,account_version,path,uid_validity,uid)
      JOIN mailbox_folders f USING(account_id,account_version,path,uid_validity)
      LEFT JOIN mailbox_rich_bodies r ON r.account_id=b.account_id AND r.account_version=b.account_version AND r.path=b.path
      AND r.uid_validity=b.uid_validity AND r.uid=b.uid AND r.sanitizer_version=?
      WHERE b.account_id=? AND b.account_version=? AND b.path=? AND b.uid_validity=? AND b.uid=? AND b.status IN ('ready','partial')
      AND m.remote_deleted=0 AND r.uid IS NULL`);
  }
  prioritizeRichBody(id, version, { folder, uidValidity, uid }) {
    if (this.closed || !this.bodyBatchSize || typeof this.email.adapter.readRichBatch !== 'function') return false;
    this.current(id, version);
    const av = this.storageVersion(id, version);
    if (!this.richArchiveCandidate().get(mailboxRichSanitizerVersion, id, av, folder, uidValidity, Number(uid))) return false;
    const key = JSON.stringify([id, av, folder, uidValidity, uid]);
    if (this.viewedRichPriorities.has(key)) return true;
    if (this.viewedRichPriorities.size === viewedRichPriorityLimit) this.viewedRichPriorities.delete(this.viewedRichPriorities.keys().next().value);
    this.viewedRichPriorities.set(key, { id, av, folder, uidValidity, uid });
    return true;
  }
  inlineArchiveCandidate() {
    return this.db.prepare(`SELECT f.kind,r.html,s.html_hash,s.status,s.next_attempt_at FROM mailbox_messages m
      JOIN mailbox_bodies b USING(account_id,account_version,path,uid_validity,uid)
      JOIN mailbox_rich_bodies r USING(account_id,account_version,path,uid_validity,uid)
      JOIN mailbox_folders f USING(account_id,account_version,path,uid_validity)
      LEFT JOIN mailbox_inline_image_state s USING(account_id,account_version,path,uid_validity,uid)
      WHERE m.account_id=? AND m.account_version=? AND m.path=? AND m.uid_validity=? AND m.uid=?
      AND m.remote_deleted=0 AND b.status IN ('ready','partial') AND r.sanitizer_version=?`);
  }
  inlineArchiveDue(row, now) {
    if (!row) return false;
    if (row.html_hash !== mailboxImageHtmlHash(row.html)) return true;
    return row.status !== 'ready' && row.next_attempt_at <= now;
  }
  prioritizeInlineImages(id, version, { folder, uidValidity, uid }) {
    if (this.closed || !this.bodyBatchSize || typeof this.email.adapter.readInlineImages !== 'function') return false;
    this.current(id, version);
    const av = this.storageVersion(id, version);
    const row = this.inlineArchiveCandidate().get(id, av, folder, uidValidity, Number(uid), mailboxRichSanitizerVersion);
    if (!row || row.html_hash === mailboxImageHtmlHash(row.html) && row.status === 'ready') return false;
    const key = JSON.stringify([id, av, folder, uidValidity, uid]);
    if (this.viewedInlinePriorities.has(key)) return true;
    if (this.viewedInlinePriorities.size === viewedRichPriorityLimit) this.viewedInlinePriorities.delete(this.viewedInlinePriorities.keys().next().value);
    this.viewedInlinePriorities.set(key, { id, av, folder, uidValidity, uid });
    return true;
  }
  inlineArchiveJobs(id, av, now) {
    if (typeof this.email.adapter.readInlineImages !== 'function') return null;
    const selectViewed = this.inlineArchiveCandidate();
    let viewedGroup = null;
    for (const [key, entry] of this.viewedInlinePriorities) {
      if (entry.id !== id) continue;
      const { folder: path, uidValidity: uid_validity, uid } = entry;
      const row = entry.av === av && selectViewed.get(id, av, path, uid_validity, Number(uid), mailboxRichSanitizerVersion);
      if (!row || row.html_hash === mailboxImageHtmlHash(row.html) && row.status === 'ready') {
        this.viewedInlinePriorities.delete(key); continue;
      }
      if (!this.inlineArchiveDue(row, now)) continue;
      if (!viewedGroup) viewedGroup = { kind: row.kind, path, uid_validity, jobs: [], imagesOnly: true };
      if (viewedGroup.path !== path || viewedGroup.uid_validity !== uid_validity) continue;
      viewedGroup.jobs.push({ uid, priorityKey: key });
      if (viewedGroup.jobs.length === inlineArchiveBatchSize) break;
    }
    if (viewedGroup) return viewedGroup;
    const select = this.db.prepare(`SELECT m.uid,m.publish_after_archive FROM mailbox_inline_image_state s
      JOIN mailbox_messages m USING(account_id,account_version,path,uid_validity,uid)
      JOIN mailbox_bodies b USING(account_id,account_version,path,uid_validity,uid)
      JOIN mailbox_rich_bodies r USING(account_id,account_version,path,uid_validity,uid)
      WHERE s.account_id=? AND s.account_version=? AND s.path=? AND s.uid_validity=? AND s.status='partial'
      AND s.next_attempt_at<=? AND m.remote_deleted=0 AND b.status IN ('ready','partial') AND r.sanitizer_version=?
      ORDER BY CASE m.publish_after_archive WHEN 1 THEN 0 WHEN 2 THEN 1 ELSE 2 END,m.uid DESC LIMIT ?`);
    const folders = this.db.prepare(`SELECT kind,path,uid_validity FROM mailbox_folders
      WHERE account_id=? AND account_version=? AND path IS NOT NULL AND uid_validity IS NOT NULL ORDER BY kind`).all(id, av);
    if (this.archiveNextInlineFolder.get(id) === 'sent') folders.reverse();
    const groups = folders.map(folder => ({ ...folder, imagesOnly: true,
      jobs: select.all(id, av, folder.path, folder.uid_validity, now, mailboxRichSanitizerVersion, inlineArchiveBatchSize) })).filter(group => group.jobs.length);
    return groups.find(group => group.jobs[0].publish_after_archive) || groups[0] || null;
  }
  async archiveInlineGroup(id, version, av, context, { path: folder, uid_validity: uidValidity, jobs }, recordProgress) {
    const deadline = Date.now() + richArchiveStartWindowMs;
    const select = this.inlineArchiveCandidate();
    for (const job of jobs) {
      this.current(id, version, context.signal);
      if (Date.now() >= deadline) break;
      const reference = { folder, uidValidity, uid: String(job.uid) };
      const key = [id, av, folder, uidValidity, Number(job.uid), mailboxRichSanitizerVersion];
      const row = select.get(...key);
      if (!this.inlineArchiveDue(row, Date.now())) continue;
      const timeout = AbortSignal.timeout(Math.min(this.bodyTimeoutMs, inlineArchiveBodyTimeoutMs));
      const child = { ...context, signal: AbortSignal.any([context.signal, timeout]) };
      try {
        const source = await this.remote(id, version, child, (config, credentials, runtime) => this.email.adapter.readInlineImages(config, credentials, { ...runtime, ...reference, html: row.html }));
        const latest = select.get(...key);
        if (!latest || latest.html !== row.html) continue;
        this.storeInlineImages(id, version, reference, source, context.signal);
        this.viewedInlinePriorities.delete(job.priorityKey);
        recordProgress();
      } catch {
        this.current(id, version, context.signal);
        this.email.access(id, context, { admin: true });
        const latest = select.get(...key);
        if (latest?.html === row.html && this.inlineArchiveDue(latest, Date.now())) {
          this.recordInlineImageFailure(id, version, reference, context.signal);
        }
      }
    }
  }
  async archiveBodies(id, version, signal, seedLegacy = false) {
    if (!this.bodyBatchSize) return;
    let attempted = true, progressed = false, folderFailed = false;
    const recordProgress = () => { progressed = true; };
    try {
      const context = this.adminContext(this.current(id, version, signal), signal);
      const av = this.storageVersion(id, version);
      if (seedLegacy) {
        // Migrate legacy summaries incrementally without loading their payloads.
        const seed = this.db.prepare(`INSERT OR IGNORE INTO mailbox_bodies(account_id,account_version,path,uid_validity,uid)
          SELECT m.account_id,m.account_version,m.path,m.uid_validity,m.uid FROM mailbox_messages m JOIN mailbox_folders f USING(account_id,account_version,path,uid_validity)
          WHERE m.account_id=? AND m.account_version=? AND f.kind=? AND m.remote_deleted=0 AND NOT EXISTS (SELECT 1 FROM mailbox_bodies b WHERE b.account_id=m.account_id AND b.account_version=m.account_version AND b.path=m.path AND b.uid_validity=m.uid_validity AND b.uid=m.uid) LIMIT 125`);
        for (const folder of kinds) seed.run(id, av, folder);
      }
      const groups = this.bodyArchiveJobs(id, av);
      const batched = typeof this.email.adapter.readBatch === 'function';
      const sharedDeadline = Date.now() + archiveStartWindowMs;
      attempted = groups.length > 0;
      for (const [index, group] of groups.entries()) {
        this.current(id, version, signal);
        if (batched && index > 0 && this.archiveShouldYield(id, version, av)) break;
        const deadline = batched ? Date.now() + archiveBatchStartWindowMs : sharedDeadline;
        if (Date.now() >= deadline) break;
        try { await this.archiveBodyGroup(id, version, av, context, group, deadline, recordProgress); }
        catch { folderFailed = true; /* Unstarted messages still remain eligible. */ }
      }
      const richGroup = this.richArchiveJobs(id, av, Date.now());
      if (richGroup && !this.archiveShouldYield(id, version, av)) {
        attempted = true;
        if (richGroup.imagesOnly) {
          this.archiveNextInlineFolder.set(id, richGroup.kind === 'inbox' ? 'sent' : 'inbox');
          this.archivePreferImages.delete(id);
        } else {
          const nextFolder = richGroup.staged ? this.archiveNextStagedRichFolder : this.archiveNextRichFolder;
          nextFolder.set(id, richGroup.kind === 'inbox' ? 'sent' : 'inbox');
          if (richGroup.staged) this.archivePreferExistingRich.add(id);
          else this.archivePreferExistingRich.delete(id);
          this.archivePreferImages.add(id);
        }
        try {
          if (richGroup.imagesOnly) await this.archiveInlineGroup(id, version, av, context, richGroup, recordProgress);
          else await this.archiveRichGroup(id, version, av, context, richGroup, recordProgress);
        }
        catch { folderFailed = true; }
      }
    } finally {
      if (!signal.aborted) {
        if (!attempted) this.archiveResumeAt.delete(id);
        else {
          const failures = progressed ? 0 : (this.archiveResumeAt.get(id)?.failures || 0) + 1;
          const delay = progressed && !folderFailed ? archiveProgressDelayMs : Math.min(60_000, archiveRetryDelayMs * 2 ** Math.max(0, Math.min(3, failures - 1)));
          this.archiveResumeAt.set(id, { at: Date.now() + Math.min(this.intervalMs, delay), failures });
        }
      }
    }
  }
  archiveShouldYield(id, version, av) {
    if (this.pending.get(id)?.syncMetadata) return true;
    if (this.active.size >= this.maxConcurrency) {
      for (const [accountId, item] of this.pending) {
        if (item.syncMetadata && !this.active.has(accountId)) return true;
      }
    }
    if (!this.started) return false;
    const state = this.db.prepare('SELECT next_attempt_at FROM mailbox_sync_accounts WHERE account_id=? AND account_version=?').get(id, av);
    if (state && state.next_attempt_at > Date.now()) return false;
    this.enqueue(id, version);
    return true;
  }
  async archiveRichGroup(id, version, av, context, { path: folder, uid_validity: uidValidity, jobs }, recordProgress) {
    const candidates = new Map(jobs.map(job => [String(job.uid), job]));
    const started = new Set();
    const eligible = this.richArchiveCandidate();
    const retry = this.db.prepare('UPDATE mailbox_bodies SET rich_failures=?,rich_next_attempt_at=? WHERE account_id=? AND account_version=? AND path=? AND uid_validity=? AND uid=?');
    const key = uid => [id, av, folder, uidValidity, Number(uid)];
    const current = uid => {
      const row = eligible.get(mailboxRichSanitizerVersion, ...key(uid));
      return row && row.rich_next_attempt_at <= Date.now();
    };
    await this.remote(id, version, context, (config, credentials, runtime) => this.email.adapter.readRichBatch(config, credentials, {
      ...runtime, folder, uidValidity, uids: [...candidates.keys()], deadline: Date.now() + richArchiveStartWindowMs,
      bodyTimeoutMs: Math.min(this.bodyTimeoutMs, richArchiveBodyTimeoutMs),
      onStart: uid => {
        runtime.authorize();
        if (!candidates.has(uid) || started.has(uid) || !current(uid)) return false;
        started.add(uid);
        return true;
      },
      onResult: (uid, { body, error }) => {
        runtime.authorize();
        if (!started.delete(uid) || !current(uid)) return;
        const sanitized = error ? null : sanitizeMailboxRichBody(this.email.scrub(body));
        if (sanitized) {
          const reference = { folder, uidValidity, uid };
          this.store.transaction(() => {
            runtime.authorize();
            this.writeRichBody(id, av, reference, sanitized);
            retry.run(0, 0, ...key(uid));
            this.publishReadyMessage(id, av, reference);
          });
          this.viewedRichPriorities.delete(candidates.get(uid).priorityKey);
          recordProgress();
        } else {
          const failures = Math.min(10, candidates.get(uid).rich_failures + 1);
          const delay = Math.min(60 * 60_000, this.intervalMs * 2 ** failures);
          retry.run(failures, Date.now() + delay, ...key(uid));
        }
      },
    }));
  }
  async archiveBodyGroup(id, version, av, context, group, deadline, recordProgress) {
    const jobs = new Map(group.jobs.map(job => [String(job.uid), job]));
    const folder = group.jobs[0].path, uidValidity = group.jobs[0].uid_validity;
    const key = job => [id, av, folder, uidValidity, job.uid];
    const live = `EXISTS (SELECT 1 FROM mailbox_messages m JOIN mailbox_folders f USING(account_id,account_version,path,uid_validity)
      WHERE m.account_id=mailbox_bodies.account_id AND m.account_version=mailbox_bodies.account_version AND m.path=mailbox_bodies.path
      AND m.uid_validity=mailbox_bodies.uid_validity AND m.uid=mailbox_bodies.uid AND m.remote_deleted=0)`;
    const claim = this.db.prepare(`UPDATE mailbox_bodies SET status='archiving' WHERE account_id=? AND account_version=? AND path=? AND uid_validity=? AND uid=? AND status IN ('pending','error') AND ${live}`);
    const canFinish = this.db.prepare(`SELECT 1 FROM mailbox_bodies WHERE account_id=? AND account_version=? AND path=? AND uid_validity=? AND uid=? AND status='archiving' AND ${live}`);
    const reset = this.db.prepare("UPDATE mailbox_bodies SET status=? WHERE account_id=? AND account_version=? AND path=? AND uid_validity=? AND uid=? AND status='archiving'");
    const started = new Map();
    const richCutoff = Date.now() - recentRichArchiveMs;
    const includeRichBody = ({ uid, date, receivedAt }) => {
      if (jobs.get(String(uid))?.publish_after_archive) return true;
      if (Date.parse(receivedAt || date) >= richCutoff) return true;
      return this.syncSince ? 'reuse' : false;
    };
    const includeInlineImages = input => includeRichBody(input) !== false;
    const start = uid => {
      this.current(id, version, context.signal);
      const job = jobs.get(uid);
      if (!job || started.has(uid) || !claim.run(...key(job)).changes) return false;
      if (!started.size && group.alternateRetry) {
        const retryFirst = this.archiveRetryFirst.get(id) || new Set();
        if (!retryFirst.delete(group.kind)) retryFirst.add(group.kind);
        this.archiveRetryFirst.set(id, retryFirst);
      }
      started.set(uid, job);
      return true;
    };
    const finish = (uid, { body, error }) => {
      this.current(id, version, context.signal);
      const job = started.get(uid);
      if (!job || !canFinish.get(...key(job))) return;
      if (error) this.bodyArchiveFailure(id, av, job, error);
      else {
        try {
          this.storeBody(id, version, { folder, uid, uidValidity }, this.email.scrub(body), context.signal);
          recordProgress();
        }
        catch (error) { this.bodyArchiveFailure(id, av, job, error); }
      }
    };
    try {
      if (typeof this.email.adapter.readBatch === 'function') {
        await this.remote(id, version, context, (config, credentials, runtime) => this.email.adapter.readBatch(config, credentials, {
          ...runtime, folder, uidValidity, uids: [...jobs.keys()], deadline, bodyTimeoutMs: Math.min(this.bodyTimeoutMs, archiveBatchBodyTimeoutMs), includeRichBody, includeInlineImages,
          onStart: uid => { runtime.authorize(); return start(uid); },
          onResult: (uid, result) => { runtime.authorize(); finish(uid, result); }
        }));
        return;
      }
      for (const uid of jobs.keys()) {
        if (Date.now() >= deadline) break;
        if (!start(uid)) continue;
        const timeout = AbortSignal.timeout(this.bodyTimeoutMs);
        const child = { ...context, signal: AbortSignal.any([context.signal, timeout]) };
        try {
          const body = await this.remote(id, version, child, (config, credentials, runtime) => this.email.adapter.read(config, credentials, { folder, uid, uidValidity, ...runtime, includeRichBody, includeInlineImages }));
          finish(uid, { body });
        } catch (error) {
          finish(uid, { error: timeout.aborted ? new HttpError(504, '邮件正文归档超时，将自动重试。') : error });
        }
      }
    } finally {
      for (const job of started.values()) reset.run(job.status, ...key(job));
    }
  }
  safeError(error) { return error instanceof HttpError ? clean(this.email.scrub(error.message), 500) : '邮件同步未完成，请稍后重试或检查邮箱连接。'; }
  async page(id, version, folder, context, cursor) {
    const av = this.storageVersion(id, version);
    let row = this.folderRow(id, version, folder), result;
    const search = pageCursor => this.remote(id, version, context, (config, credentials, runtime) => this.email.adapter.search(config, credentials, {
      folder: row.path, limit: this.pageSize, query: {}, syncUidRange: { afterUid: 0 },
      ...(this.syncSince ? { syncSince: this.syncSince } : {}), ...(pageCursor ? { cursor: pageCursor } : {}), ...runtime
    }));
    try { result = await search(cursor); }
    catch (error) {
      // A durable cursor from a replaced mailbox is invalid. Probe current UIDVALIDITY without it.
      if (!cursor || error.status !== 409) throw error;
      this.current(id, version, context.signal);
      result = await search();
      if (String(result.uidValidity) === row.uid_validity) throw error;
    }
    const validity = uidString(result.uidValidity);
    if (!Array.isArray(result.messages) || result.messages.length > this.pageSize || result.nextCursor && (typeof result.nextCursor !== 'string' || result.nextCursor.length > 2048)) throw new HttpError(502, '邮箱返回的摘要或分页信息无效。');
    const reset = row.uid_validity !== validity;
    this.current(id, version, context.signal);
    if (reset) { this.resetFolder(id, version, folder, row.path, row.label, validity); row = this.folderRow(id, version, folder); }
    const messages = result.messages.map(metadata), insert = this.db.prepare('INSERT INTO mailbox_messages(account_id,account_version,path,uid_validity,uid,summary_json,search_text,publish_after_archive) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(account_id,account_version,path,uid_validity,uid) DO UPDATE SET summary_json=excluded.summary_json,search_text=excluded.search_text,remote_deleted=0');
    this.store.transaction(() => {
      this.current(id, version, context.signal);
      for (const message of messages) {
        insert.run(id, av, row.path, validity, message.uid, JSON.stringify(message), searchText(message), Number(this.stageNewMail));
        this.db.prepare('INSERT OR IGNORE INTO mailbox_bodies(account_id,account_version,path,uid_validity,uid) VALUES (?,?,?,?,?)').run(id, av, row.path, validity, message.uid);
      }
      const range = result.scannedUidRange;
      if (range && Number.isSafeInteger(range.fromUid) && Number.isSafeInteger(range.toUid) && range.fromUid > 0 && range.toUid >= range.fromUid && range.toUid <= 0xffffffff && messages.every(message => message.uid >= range.fromUid && message.uid <= range.toUid)) {
        const retained = new Set(messages.map(message => message.uid));
        const remove = this.db.prepare('UPDATE mailbox_messages SET remote_deleted=1 WHERE account_id=? AND account_version=? AND path=? AND uid_validity=? AND uid=?');
        for (const cached of this.db.prepare('SELECT uid FROM mailbox_messages WHERE account_id=? AND account_version=? AND path=? AND uid_validity=? AND uid>=? AND uid<=?').all(id, av, row.path, validity, range.fromUid, range.toUid)) {
          if (!retained.has(cached.uid)) {
            remove.run(id, av, row.path, validity, cached.uid);
            this.db.prepare("UPDATE mailbox_bodies SET status='error',error='远端邮件已删除，无法补归档未保存的内容。' WHERE account_id=? AND account_version=? AND path=? AND uid_validity=? AND uid=? AND status NOT IN ('ready','partial')").run(id, av, row.path, validity, cached.uid);
          }
        }
      }
      const count = this.maxMessages && this.db.prepare('SELECT COUNT(*) AS total FROM mailbox_messages WHERE account_id=? AND account_version=? AND path=? AND uid_validity=?').get(id, av, row.path, validity).total;
      if (this.maxMessages && count > this.maxMessages) {
        this.db.prepare('DELETE FROM mailbox_messages WHERE account_id=? AND account_version=? AND path=? AND uid_validity=? AND uid NOT IN (SELECT uid FROM mailbox_messages WHERE account_id=? AND account_version=? AND path=? AND uid_validity=? ORDER BY uid DESC LIMIT ?)').run(id, av, row.path, validity, id, av, row.path, validity, this.maxMessages);
        this.db.prepare('UPDATE mailbox_folders SET history_truncated=1,history_complete=0 WHERE account_id=? AND account_version=? AND kind=?').run(id, av, folder);
      }
    });
    return { ...result, messages, reset, nextCursor: result.nextCursor || null };
  }
  async syncFolder(id, version, folder, context, historyPages) {
    const av = this.storageVersion(id, version);
    this.db.prepare("UPDATE mailbox_folders SET status='syncing',error=NULL WHERE account_id=? AND account_version=? AND kind=?").run(id, av, folder);
    let row = this.folderRow(id, version, folder), cursor = row.head_cursor, boundary = cursor ? row.head_boundary : row.highest_uid, highest = cursor ? row.head_highest : row.highest_uid, complete = false;
    const initialized = Boolean(row.highest_uid || row.history_cursor || row.history_complete || row.history_truncated || cursor);
    for (let index = 0; index < this.maxNewPages; index++) {
      const result = await this.page(id, version, folder, context, cursor);
      if (result.reset) { boundary = 0; highest = 0; }
      highest = Math.max(highest, ...result.messages.map(value => value.uid));
      if (!initialized || result.reset) {
        this.db.prepare('UPDATE mailbox_folders SET highest_uid=?,history_cursor=?,history_complete=?,head_cursor=NULL,head_boundary=0,head_highest=0 WHERE account_id=? AND account_version=? AND kind=?').run(highest, result.nextCursor, result.nextCursor ? 0 : 1, id, av, folder);
        complete = true; break;
      }
      complete = !result.nextCursor || result.messages.some(value => value.uid <= boundary);
      if (complete) {
        this.db.prepare('UPDATE mailbox_folders SET highest_uid=?,head_cursor=NULL,head_boundary=0,head_highest=0 WHERE account_id=? AND account_version=? AND kind=?').run(highest, id, av, folder); break;
      }
      cursor = result.nextCursor;
      this.db.prepare('UPDATE mailbox_folders SET head_cursor=?,head_boundary=?,head_highest=? WHERE account_id=? AND account_version=? AND kind=?').run(cursor, boundary, highest, id, av, folder);
    }
    for (let index = 0; complete && index < historyPages; index++) {
      row = this.folderRow(id, version, folder);
      if (!row.history_cursor || row.history_complete || row.history_truncated) break;
      const result = await this.page(id, version, folder, context, row.history_cursor);
      this.db.prepare('UPDATE mailbox_folders SET history_cursor=?,history_complete=?,highest_uid=MAX(highest_uid,?) WHERE account_id=? AND account_version=? AND kind=?').run(result.nextCursor, result.nextCursor ? 0 : 1, Math.max(0, ...result.messages.map(value => value.uid)), id, av, folder);
    }
    this.current(id, version, context.signal);
    this.db.prepare("UPDATE mailbox_folders SET status=?,last_sync_at=?,error=NULL WHERE account_id=? AND account_version=? AND kind=?").run(complete ? 'ready' : 'syncing', stamp(), id, av, folder);
  }
}
