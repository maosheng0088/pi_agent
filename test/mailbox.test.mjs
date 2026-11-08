import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { EmailService } from '../lib/email.mjs';
import { MailboxService, mailboxFolders } from '../lib/mailbox.mjs';
import { HttpError } from '../lib/security.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const message = uid => ({ uid, subject: `预约 ${uid}`, from: [{ name: '业务组', address: 'sender@example.test' }], to: [{ name: '', address: 'recipient@example.test' }], cc: [], date: '2026-11-05T00:00:00Z', messageId: `<${uid}@example.test>`, size: 100, seen: false, hasAttachments: true });
const inlineImage = cid => ({ cid, mimeType: 'image/png', data: Buffer.from('89504e470d0a1a0a00000000', 'hex').toString('base64') });

async function fixture(t, settings = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,disabled INTEGER DEFAULT 0,created_at TEXT);
    CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE session_meta(id TEXT PRIMARY KEY); CREATE TABLE group_members(session_id TEXT,user_id TEXT);
    INSERT INTO users(id,role,created_at) VALUES ('admin','admin','2026-01-01'),('member','member','2026-01-01'),('other','member','2026-01-01');
    INSERT INTO session_meta VALUES ('group1'),('group2');
    INSERT INTO group_members VALUES ('group1','member'),('group2','member');`);
  const store = { db, transaction(action) { db.exec('BEGIN'); try { const result = action(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } } };
  const state = { validity: '11', sentValidity: '22', folderValidity: true, folders: [{ path: 'INBOX', name: 'Inbox', selectable: true }, { path: '已发送', name: '已发送', selectable: true }],
    inbox: Array.from({ length: 5 }, (_, index) => message(index + 1)), sent: [message(101), message(102)], calls: [], searchHook: null, readHook: null };
  const adapter = {
    async folders(_config, _credentials, runtime) {
      runtime.authorize(); state.calls.push({ method: 'folders' });
      return { folders: state.folders.map(value => ({ ...value, uidValidity: state.folderValidity ? value.path === 'INBOX' ? state.validity : state.sentValidity : null })) };
    },
    async search(config, _credentials, input) {
      input.authorize(); state.calls.push({ method: 'search', ...input, signal: undefined, authorize: undefined, guard: undefined });
      if (state.searchHook) await state.searchHook(input, config);
      input.authorize(); const source = input.folder === 'INBOX' ? state.inbox : state.sent, validity = input.folder === 'INBOX' ? state.validity : state.sentValidity;
      const cursor = input.cursor ? JSON.parse(Buffer.from(input.cursor, 'base64url')) : null;
      if (cursor && (cursor.validity !== validity || cursor.syncSince !== input.syncSince)) throw new HttpError(409, '邮箱编号已重置。');
      const snapshot = cursor?.snapshot ?? Math.max(0, ...source.map(item => item.uid)), upper = cursor ? cursor.before - 1 : snapshot;
      const ordered = source.filter(item => item.uid <= upper && (!input.syncSince || (item.internalDate || item.date).slice(0, 10) >= input.syncSince))
        .sort((a, b) => b.uid - a.uid), selected = ordered.slice(0, input.limit);
      const more = ordered.length > input.limit, lower = more ? selected.at(-1).uid : 1;
      return { folder: input.folder, uidValidity: validity, messages: selected,
        nextCursor: more ? Buffer.from(JSON.stringify({ validity, snapshot, before: selected.at(-1).uid, syncSince: input.syncSince })).toString('base64url') : null,
        scannedUidRange: upper ? { fromUid: lower, toUid: upper } : null };
    },
    async read(_config, _credentials, input) { input.authorize(); state.calls.push({ method: 'read', ...input }); const result = state.readHook ? await state.readHook(input) : null; input.authorize(); return result || { ...message(Number(input.uid)), folder: input.folder, uidValidity: input.uidValidity, text: '只按需读取纯文本正文', attachments: [{ part: '2', name: 'report.pdf', size: 50, mimeType: 'application/pdf' }] }; },
  };
  const email = new EmailService(store, { adapter, codec: async (_mode, bytes) => Buffer.from(bytes) });
  const admin = { actor: { id: 'admin' } }, context = { actor: { id: 'member' }, sessionId: 'group1' };
  const body = { name: '业务邮箱', email: 'business@example.test', enabled: true, scope: 'groups', groupIds: ['group1'], imap: { host: 'imap.example.test', port: 993, tls: 'implicit', username: 'business@example.test', password: 'offline-secret-never-network' } };
  const account = await email.saveAccount(null, body, admin);
  let mailbox = new MailboxService(store, email, { pageSize: 2, bodyBatchSize: 0, ...settings });
  t.after(async () => { await mailbox.stop(); email.close(); db.close(); });
  return { db, store, email, state, context, admin, body, account, get mailbox() { return mailbox; },
    async sync() { mailbox.requestSync(account.id, context); await mailbox.whenIdle(); },
    list(input = {}) { return mailbox.listMessages(account.id, input, context); },
    async restart() { await mailbox.stop(); mailbox = new MailboxService(store, email, { pageSize: 2, bodyBatchSize: 0, ...settings }); return mailbox; } };
}

test('resolves special-use Sent before conservative multilingual names, never Outbox or INBOX', () => {
  assert.equal(mailboxFolders([{ path: 'INBOX' }, { path: 'Outbox' }, { path: '已发送' }, { path: '[Gmail]/Sent Mail', specialUse: '\\Sent' }]).sent.path, '[Gmail]/Sent Mail');
  assert.equal(mailboxFolders([{ path: 'INBOX' }, { path: 'Outbox' }, { path: 'Sent', selectable: false }]).sent, null);
  assert.equal(mailboxFolders([{ path: 'INBOX' }, { path: 'Sent Items' }]).sent.path, 'Sent Items');
  assert.equal(mailboxFolders([{ path: 'INBOX' }, { path: '邮件/已发送', delimiter: '/' }]).sent.path, '邮件/已发送');
});

test('queues metadata-only Inbox and Chinese Sent sync; caches deduplicate and paginate metadata search', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.state.calls, []); assert.equal(f.mailbox.requestSync(f.account.id, f.context).queued, true);
  assert.deepEqual(f.state.calls, []); await f.mailbox.whenIdle();
  assert.equal(f.list().total, 4); assert.equal(f.list().sync.historyComplete, false);
  assert.equal(f.list({ folder: 'sent' }).total, 2); assert.equal(f.mailbox.folders(f.account.id, f.context).folders[1].path, '已发送');
  await f.sync(); await f.sync();
  assert.equal(f.list().total, 5); assert.equal(f.list().sync.historyComplete, true);
  const page = f.list({ limit: 2, offset: 1 }); assert.deepEqual(page.messages.map(item => item.uid), [4, 3]); assert.equal(page.nextOffset, 3); assert.equal(page.hasMore, true);
  assert.equal(f.list({ query: 'SENDER@EXAMPLE.TEST' }).total, 5); assert.equal(f.list({ query: '预约 3' }).total, 1);
  assert.equal(f.list({ query: '只按需读取纯文本正文' }).total, 0); assert.equal(f.list().searchScope, 'local_archive');
  assert.equal(f.state.calls.some(item => item.method === 'read'), false);
  assert.equal(f.state.calls.filter(item => item.method === 'search').every(item => item.syncUidRange.afterUid === 0), true);
  assert.equal(f.state.calls.some(item => Object.hasOwn(item, 'syncSince')), false);
  assert.doesNotMatch(JSON.stringify(f.mailbox.listAccounts(f.context)), /imap|credentials|offline-secret|host|username/);
  assert.throws(() => f.list({ offset: -1 }), /分页/); assert.throws(() => f.list({ query: { text: 'body' } }), /搜索/);
});

test('multi-page new mail burst resumes a durable snapshot without dropping arrivals between pages', async t => {
  const f = await fixture(t, { maxNewPages: 2 }); await f.sync(); await f.sync();
  f.state.inbox.push(...Array.from({ length: 9 }, (_, index) => message(index + 6)));
  let injected = false;
  f.state.searchHook = async input => { if (input.folder === 'INBOX' && input.cursor && !injected) { injected = true; f.state.inbox.push(message(15), message(16)); } };
  await f.sync(); assert.equal(f.list().sync.status, 'syncing');
  assert.ok(f.db.prepare("SELECT head_cursor FROM mailbox_folders WHERE kind='inbox'").get().head_cursor);
  await f.restart(); for (let index = 0; index < 6; index++) await f.sync();
  assert.equal(f.list().total, 16); assert.deepEqual(f.list().messages.map(item => item.uid), Array.from({ length: 16 }, (_, index) => 16 - index));
  assert.equal(f.list().sync.status, 'ready');
});

test('restart restores history pagination and manual loadMore queues more old summaries', async t => {
  const f = await fixture(t); await f.sync(); assert.equal(f.list().total, 4);
  const cursor = f.db.prepare("SELECT history_cursor FROM mailbox_folders WHERE kind='inbox'").get().history_cursor; assert.ok(cursor);
  await f.restart(); assert.equal(f.list().total, 4);
  const result = f.mailbox.loadMore(f.account.id, { folder: 'inbox' }, f.context); assert.equal(result.queued, true);
  await f.mailbox.whenIdle(); assert.equal(f.list().total, 5); assert.equal(f.list().sync.historyComplete, true);
});

test('a persisted cutoff applies inclusively across Inbox and Sent history after restart', async t => {
  const f = await fixture(t), since = '2026-08-01';
  f.db.prepare('INSERT INTO metadata(key,value) VALUES (?,?)').run('mailbox.syncSince', since);
  const inRange = firstUid => Array.from({ length: 5 }, (_, offset) => ({ ...message(firstUid + offset), internalDate: `${since}T00:00:00Z` }));
  const beforeRange = uid => ({ ...message(uid), internalDate: '2026-07-31T23:59:59Z' });
  f.state.inbox = [beforeRange(1), ...inRange(2), beforeRange(7)];
  f.state.sent = [beforeRange(101), ...inRange(102), beforeRange(107)];
  await f.restart(); await f.sync();
  assert.equal(f.list().total, 4); assert.equal(f.list({ folder: 'sent' }).total, 4);
  assert.ok(f.db.prepare('SELECT history_cursor FROM mailbox_folders WHERE kind=?').get('inbox').history_cursor);
  assert.ok(f.db.prepare('SELECT history_cursor FROM mailbox_folders WHERE kind=?').get('sent').history_cursor);

  await f.restart(); await f.sync();
  assert.deepEqual(f.list().messages.map(item => item.uid), [6, 5, 4, 3, 2]);
  assert.deepEqual(f.list({ folder: 'sent' }).messages.map(item => item.uid), [106, 105, 104, 103, 102]);
  assert.equal(f.list().sync.historyComplete, true);
  assert.equal(f.list({ folder: 'sent' }).sync.historyComplete, true);
  const searches = f.state.calls.filter(call => call.method === 'search');
  assert.ok(searches.every(call => call.syncSince === since));
  assert.ok(searches.some(call => call.folder === 'INBOX' && call.cursor));
  assert.ok(searches.some(call => call.folder === '已发送' && call.cursor));

  f.state.inbox = f.state.inbox.filter(item => item.uid !== 6);
  await f.sync();
  assert.equal(f.list().messages.find(item => item.uid === 6).archive.remoteDeleted, true);
  assert.equal(f.list().messages.find(item => item.uid === 5).archive.remoteDeleted, false);
});

test('an invalid persisted cutoff fails closed before any mailbox search', async t => {
  const f = await fixture(t);
  f.db.prepare('INSERT INTO metadata(key,value) VALUES (?,?)').run('mailbox.syncSince', '2026-02-30');
  await assert.rejects(f.restart(), /有效的 YYYY-MM-DD/);
  assert.deepEqual(f.state.calls, []);
});

test('scoped history reuses HTML already being read and recent mail requests full rich text', async t => {
  const now = Date.parse('2026-11-06T00:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const f = await fixture(t, { syncSince: '2026-08-01', bodyBatchSize: 2 });
  let modes;
  f.email.adapter.readBatch = async (_config, _credentials, { uids, includeRichBody, uidValidity, onStart, onResult }) => {
    modes = [includeRichBody({ receivedAt: '2026-08-01' }), includeRichBody({ receivedAt: new Date(now).toISOString() })];
    for (const uid of uids) {
      assert.equal(onStart(uid), true);
      onResult(uid, { body: { uid, uidValidity, text: '历史正文', richBody: { html: '<p>历史正文</p>' } } });
    }
  };
  await f.sync();
  assert.deepEqual(modes, ['reuse', true]);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM mailbox_rich_bodies').get().n, 2);
});

test('UIDVALIDITY reset hides old summaries and rejects old message or attachment references', async t => {
  const f = await fixture(t); await f.sync(); const previous = f.list().uidValidity;
  f.state.validity = '33'; f.state.inbox = [{ ...message(1), subject: '编号重置后的邮件' }]; await f.sync();
  assert.equal(f.list().uidValidity, '33'); assert.equal(f.list().total, 1); assert.equal(f.list().messages[0].subject, '编号重置后的邮件');
  await assert.rejects(f.mailbox.readMessage(f.account.id, { uid: 1, uidValidity: previous }, f.context), /编号已重置/);
  assert.throws(() => f.mailbox.attachmentReference(f.account.id, { uid: 1, uidValidity: previous, part: '2' }, f.context), /编号已重置/);
  const result = await f.mailbox.readMessage(f.account.id, { uid: 1, uidValidity: '33' }, f.context); assert.equal(result.text, '只按需读取纯文本正文');
  assert.deepEqual(f.mailbox.attachmentReference(f.account.id, { uid: 1, uidValidity: '33', part: '2' }, f.context), { folder: 'INBOX', uid: '1', uidValidity: '33', part: '2' });
  assert.doesNotMatch(f.db.prepare('SELECT summary_json FROM mailbox_messages WHERE uid=1').get().summary_json, /正文|attachments|text|html/);
});

test('stale durable cursor recovers a mailbox reset even when folder listing omits UIDVALIDITY', async t => {
  const syncSince = '2026-08-01';
  const f = await fixture(t, { maxNewPages: 1, syncSince }); await f.sync(); await f.sync();
  f.state.inbox.push(message(6), message(7), message(8), message(9)); await f.sync();
  const before = f.state.calls.length;
  f.state.folderValidity = false; f.state.validity = '44'; f.state.inbox = [message(1)]; await f.sync();
  const recovery = f.state.calls.slice(before).filter(call => call.method === 'search' && call.folder === 'INBOX');
  assert.deepEqual(recovery.map(call => [Boolean(call.cursor), call.syncSince]), [[true, syncSince], [false, syncSince]]);
  assert.equal(f.list().uidValidity, '44'); assert.deepEqual(f.list().messages.map(item => item.uid), [1]);
});

test('live membership, scope, enabled status and deletion gate every cached read', async t => {
  const f = await fixture(t); await f.sync();
  assert.throws(() => f.mailbox.listMessages(f.account.id, {}, { ...f.context, actor: { id: 'other' } }), /群成员/);
  assert.throws(() => f.mailbox.folders(f.account.id, { ...f.context, sessionId: 'group2' }), /未分配/);
  f.db.prepare("DELETE FROM group_members WHERE session_id='group1' AND user_id='member'").run();
  assert.throws(() => f.list(), /群成员/); assert.throws(() => f.mailbox.listAccounts(f.context), /群成员/);
  f.db.prepare("INSERT INTO group_members VALUES ('group1','member')").run();
  await f.email.saveAccount(f.account.id, { enabled: false }, f.admin);
  assert.throws(() => f.list(), /停用/); assert.deepEqual(f.mailbox.listAccounts(f.context), []);
  f.email.deleteAccount(f.account.id, f.admin); assert.throws(() => f.list(), /不存在/);
});

test('new connection identity hides and preserves the prior archive, and invalidation stays offline until start', async t => {
  const f = await fixture(t); await f.sync(); const before = f.state.calls.length;
  await f.email.saveAccount(f.account.id, { email: 'updated@example.test' }, f.admin);
  assert.equal(f.list().total, 0); f.mailbox.onAccountChanged(f.account.id); await f.mailbox.whenIdle();
  assert.equal(f.state.calls.length, before); assert.ok(f.db.prepare('SELECT COUNT(*) AS count FROM mailbox_messages').get().count > 0);
  await f.sync(); assert.ok(f.list().total > 0);
});

test('configuration mutation while a provider waits cancels stale work before any cache commit', async t => {
  const f = await fixture(t), reached = deferred(), release = deferred();
  f.state.searchHook = async () => { reached.resolve(); await release.promise; };
  f.mailbox.requestSync(f.account.id, f.context); await reached.promise;
  await f.email.saveAccount(f.account.id, { imap: { password: 'replaced-offline-secret' } }, f.admin); f.mailbox.onAccountChanged(f.account.id);
  await f.mailbox.whenIdle(); assert.equal(f.list().total, 0); release.resolve(); await delay(0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM mailbox_messages').get().count, 0);
});

test('stop aborts and waits for service promises without waiting for an uncooperative provider', async t => {
  const f = await fixture(t), reached = deferred(), release = deferred();
  f.state.searchHook = async () => { reached.resolve(); await release.promise; };
  f.mailbox.requestSync(f.account.id, f.context); await reached.promise; await f.mailbox.stop();
  assert.equal(f.mailbox.active.size, 0); assert.equal(f.mailbox.pending.size, 0);
  assert.equal(f.list().total, 0); assert.throws(() => f.mailbox.requestSync(f.account.id, f.context), /关闭/);
  release.resolve(); await delay(0); assert.equal(f.list().total, 0);
});

test('missing Sent is explicit and bounded caches never claim complete history', async t => {
  const f = await fixture(t, { maxMessagesPerFolder: 3 }); f.state.folders = [{ path: 'INBOX' }, { path: 'Outbox' }]; await f.sync();
  assert.equal(f.list({ folder: 'sent' }).sync.status, 'not_found');
  assert.equal(f.list().total, 3); assert.equal(f.list().sync.truncated, true); assert.equal(f.list().sync.historyComplete, false);
});

test('background polling uses a live admin fallback, respects failure backoff and disabled accounts', async t => {
  const f = await fixture(t, { intervalMs: 60_000 });
  f.db.prepare("INSERT INTO users(id,role,created_at) VALUES ('admin2','admin','2026-01-02')").run();
  f.db.prepare("UPDATE users SET disabled=1 WHERE id='admin'").run();
  f.mailbox.start(); await f.mailbox.whenIdle(); assert.equal(f.list().sync.status, 'ready');
  f.db.prepare("UPDATE users SET disabled=1 WHERE id='admin2'").run();
  f.mailbox.requestSync(f.account.id, f.context); await f.mailbox.whenIdle();
  assert.equal(f.mailbox.listAccounts(f.context)[0].sync.status, 'error');
  const calls = f.state.calls.length; f.mailbox.tick(); await f.mailbox.whenIdle(); assert.equal(f.state.calls.length, calls);
});

test('background sync refreshes Seen and preserves expunged UIDs as local archive entries', async t => {
  const f = await fixture(t); await f.sync(); await f.sync();
  f.state.inbox = f.state.inbox.filter(item => item.uid !== 4); f.state.inbox.find(item => item.uid === 5).seen = true;
  await f.sync(); assert.equal(f.list().messages.find(item => item.uid === 5).seen, true);
  assert.equal(f.list().messages.find(item => item.uid === 4).archive.remoteDeleted, true); assert.equal(f.list().messages.some(item => item.uid === 1), true);
});

test('global background concurrency is bounded to two and each account stays serial', async t => {
  const f = await fixture(t), reached = deferred(), release = deferred(), counts = new Map(); let live = 0, maximum = 0;
  const second = await f.email.saveAccount(null, { ...f.body, email: 'second@example.test' }, f.admin);
  const third = await f.email.saveAccount(null, { ...f.body, email: 'third@example.test' }, f.admin);
  f.state.searchHook = async (_input, config) => {
    counts.set(config.email, (counts.get(config.email) || 0) + 1); assert.equal(counts.get(config.email), 1);
    live++; maximum = Math.max(maximum, live); if (live === 2) reached.resolve();
    await release.promise; live--; counts.set(config.email, counts.get(config.email) - 1);
  };
  for (const account of [f.account, second, third]) f.mailbox.requestSync(account.id, f.context);
  await reached.promise; assert.equal(f.mailbox.active.size, 2); assert.equal(f.mailbox.pending.size, 1);
  f.mailbox.requestSync(f.account.id, f.context); assert.equal(f.mailbox.active.size, 2);
  release.resolve(); await f.mailbox.whenIdle(); assert.equal(maximum, 2);
  assert.equal(f.mailbox.active.size, 0); assert.equal(f.mailbox.pending.size, 0);
});

test('disable and delete while a provider awaits prevent subsequent cache writes', async t => {
  for (const action of ['disable', 'delete']) await t.test(action, async subtest => {
    const f = await fixture(subtest), reached = deferred(), release = deferred();
    f.state.searchHook = async () => { reached.resolve(); await release.promise; };
    f.mailbox.requestSync(f.account.id, f.context); await reached.promise;
    if (action === 'disable') await f.email.saveAccount(f.account.id, { enabled: false }, f.admin);
    else f.email.deleteAccount(f.account.id, f.admin);
    f.mailbox.invalidate(f.account.id); await f.mailbox.whenIdle();
    release.resolve(); await delay(0); assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM mailbox_messages').get().count, 0);
    assert.throws(() => f.list());
  });
});

test('empty sparse UID windows advance durable history and do not reset its cursor every poll', async t => {
  const f = await fixture(t, { maxNewPages: 1 }), original = f.email.adapter.search;
  f.email.adapter.search = async (config, credentials, input) => {
    if (input.folder !== 'INBOX') return original(config, credentials, input);
    input.authorize();
    if (!input.cursor) return { uidValidity: '11', messages: [], nextCursor: 'gap2' };
    if (input.cursor === 'gap2') return { uidValidity: '11', messages: [], nextCursor: 'gap1' };
    return { uidValidity: '11', messages: [message(2), message(1)], nextCursor: null };
  };
  await f.sync(); assert.equal(f.list().total, 0);
  assert.equal(f.db.prepare("SELECT history_cursor FROM mailbox_folders WHERE kind='inbox'").get().history_cursor, 'gap1');
  for (let index = 0; index < 5; index++) await f.sync();
  assert.equal(f.list().total, 2); assert.equal(f.list().sync.historyComplete, true);
});

test('public center lists enabled accounts for every live employee while legacy AI group scopes stay enforced', async t => {
  const f = await fixture(t), publicContext = { actor: { id: 'other' }, mailboxPublic: true };
  await f.sync();
  assert.equal(f.mailbox.listAccounts(publicContext).length, 1);
  assert.equal(f.mailbox.listMessages(f.account.id, {}, publicContext).total, 4);
  assert.throws(() => f.mailbox.listMessages(f.account.id, {}, { actor: { id: 'other' }, sessionId: 'group1' }), /群成员/);
  await f.email.saveAccount(f.account.id, { scope: 'none', groupIds: [] }, f.admin); f.mailbox.invalidate(f.account.id);
  assert.equal(f.mailbox.listMessages(f.account.id, {}, publicContext).total, 4); assert.throws(() => f.list(), /未分配/);
  assert.equal(f.mailbox.listAccounts(publicContext)[0].allowSend, false);
  assert.throws(() => f.email.access(f.account.id, { ...publicContext, sessionId: 'group1' }, { send: true }), /仅允许读取/);
  f.db.prepare("UPDATE users SET disabled=1 WHERE id='other'").run();
  assert.throws(() => f.mailbox.listAccounts(publicContext), /登录状态/);
  await assert.rejects(f.mailbox.readMessage(f.account.id, { uid: 5, uidValidity: '11' }, publicContext), /登录状态/);
});

test('background stores bounded plain text, searches archived body, and reads locally while provider is offline', async t => {
  const f = await fixture(t, { bodyBatchSize: 4 }); await f.sync(); await f.sync();
  assert.equal(f.list({ query: '只按需读取纯文本正文' }).total, 5);
  const totalReads = f.state.calls.filter(value => value.method === 'read').length;
  f.state.readHook = async () => { throw new Error('provider offline'); };
  const context = { actor: { id: 'other' }, mailboxPublic: true };
  const result = await f.mailbox.readMessage(f.account.id, { uid: 5, uidValidity: '11' }, context);
  assert.equal(result.text, '只按需读取纯文本正文'); assert.equal(result.archive.status, 'ready');
  assert.equal(result.attachments[0].part, '2');
  assert.equal(result.attachments[0].archive, undefined);
  assert.equal(f.state.calls.filter(value => value.method === 'read').length, totalReads);
  assert.equal(f.mailbox.folders(f.account.id, context).folders[0].archive.ready, 5);
  await f.restart(); const reopened = await f.mailbox.readMessage(f.account.id, { uid: 5, uidValidity: '11' }, context); assert.equal(reopened.text, result.text);
});

test('manual public read archives only bounded text and attachment descriptors, never HTML or bytes', async t => {
  const f = await fixture(t); await f.sync();
  f.state.readHook = async input => ({ ...message(Number(input.uid)), uidValidity: input.uidValidity, text: `正文 needle ${'x'.repeat(130_000)}`, html: '<script>must-not-persist</script>',
    attachments: Array.from({ length: 21 }, (_, index) => ({ part: String(index + 2), name: 'report.txt', size: 10, content: Buffer.from('must-not-store-bytes'), absolutePath: 'must-not-store-path' })) });
  const result = await f.mailbox.readMessage(f.account.id, { uid: 5, uidValidity: '11' }, { actor: { id: 'other' }, mailboxPublic: true });
  assert.equal(result.text.length, 120_000); assert.equal(result.truncated, true); assert.equal(f.list({ query: 'needle' }).total, 1);
  assert.equal(result.attachments.length, 21);
  const body = f.db.prepare('SELECT * FROM mailbox_bodies WHERE uid=5').get();
  assert.doesNotMatch(JSON.stringify(body), /must-not-persist|must-not-store/); assert.equal(body.status, 'partial'); assert.equal(result.archive.status, 'partial');
});

test('archive identity survives name, AI scope, sending settings, password rotation and disabling', async t => {
  const f = await fixture(t, { bodyBatchSize: 4 }); await f.sync(); await f.sync();
  const context = { actor: { id: 'other' }, mailboxPublic: true }, initial = f.mailbox.archiveKey(f.account.id, context);
  await f.email.saveAccount(f.account.id, { name: '新名称', scope: 'none', groupIds: [], imap: { password: 'new-offline-password' } }, f.admin); f.mailbox.invalidate(f.account.id);
  const changed = f.mailbox.archiveKey(f.account.id, context);
  assert.equal(initial.archiveId, changed.archiveId); assert.ok(changed.version > initial.version);
  assert.equal(f.mailbox.listMessages(f.account.id, {}, context).total, 5);
  const readCount = f.state.calls.length; assert.equal((await f.mailbox.readMessage(f.account.id, { uid: 5, uidValidity: '11' }, context)).archive.status, 'ready'); assert.equal(f.state.calls.length, readCount);
  await f.email.saveAccount(f.account.id, { enabled: false }, f.admin); f.mailbox.invalidate(f.account.id); assert.throws(() => f.mailbox.archiveKey(f.account.id, context), /停用/);
  assert.ok(f.db.prepare('SELECT COUNT(*) AS n FROM mailbox_bodies WHERE status=\'ready\'').get().n > 0);
  await f.email.saveAccount(f.account.id, { enabled: true }, f.admin); f.mailbox.invalidate(f.account.id);
  assert.equal(f.mailbox.archiveKey(f.account.id, context).archiveId, initial.archiveId);
  await f.email.saveAccount(f.account.id, { email: 'new-connection@example.test' }, f.admin); f.mailbox.invalidate(f.account.id);
  assert.notEqual(f.mailbox.archiveKey(f.account.id, context).archiveId, initial.archiveId); assert.equal(f.mailbox.listMessages(f.account.id, {}, context).total, 0);
  await f.email.saveAccount(f.account.id, { email: f.body.email }, f.admin); f.mailbox.invalidate(f.account.id);
  assert.equal(f.mailbox.archiveKey(f.account.id, context).archiveId, initial.archiveId); assert.equal(f.mailbox.listMessages(f.account.id, {}, context).total, 5);
  f.email.deleteAccount(f.account.id, f.admin); f.mailbox.invalidate(f.account.id); assert.ok(f.db.prepare('SELECT COUNT(*) AS n FROM mailbox_bodies').get().n > 0);
});

test('body failures remain visible, do not fail incoming mail, back off, and manual refresh retries', async t => {
  const f = await fixture(t, { bodyBatchSize: 2 }); f.state.readHook = async () => { throw new HttpError(502, '模拟正文暂不可用'); }; await f.sync();
  assert.equal(f.mailbox.listAccounts(f.context)[0].sync.status, 'ready');
  assert.deepEqual(f.mailbox.folders(f.account.id, f.context).folders.map(folder => folder.archive.error), [1, 1]);
  const failed = f.db.prepare("SELECT * FROM mailbox_bodies WHERE status='error' LIMIT 1").get(); assert.ok(failed.next_attempt_at > Date.now());
  f.state.readHook = null; await f.sync();
  assert.ok(f.db.prepare("SELECT COUNT(*) AS n FROM mailbox_bodies WHERE status='ready'").get().n > 0);
});

test('legacy local attachments stay available after restart and remote expunge', async t => {
  const f = await fixture(t, { bodyBatchSize: 4 });
  await f.sync(); await f.sync();
  const cached = { id: 'previously-downloaded', size: 40, downloadUrl: `/api/mailbox/${f.account.id}/attachments/previously-downloaded?download=1` };
  f.db.prepare("UPDATE mailbox_archive_attachments SET status='ready',local_json=? WHERE path='INBOX' AND uid=4").run(JSON.stringify(cached));
  await f.restart();
  f.state.inbox = f.state.inbox.filter(value => value.uid !== 4); await f.sync();
  f.state.readHook = async () => { throw new Error('no remote read allowed'); };
  const after = await f.mailbox.readMessage(f.account.id, { uid: 4, uidValidity: '11' }, { actor: { id: 'other' }, mailboxPublic: true });
  assert.equal(after.archive.remoteDeleted, true);
  assert.equal(after.attachments[0].id, cached.id);
  assert.equal(after.attachments[0].downloadUrl, cached.downloadUrl);
  assert.equal(after.archive.attachments, undefined);
});

test('background sync stores attachment descriptors without fetching files or retrying legacy failures', async t => {
  let attachmentDownloads = 0;
  const countDownload = async () => { attachmentDownloads++; throw new Error('background attachment download'); };
  const f = await fixture(t, { bodyBatchSize: 4, archiveAttachment: countDownload });
  f.email.adapter.downloadAttachment = countDownload;
  await f.sync();
  assert.equal(attachmentDownloads, 0);
  const archived = f.db.prepare("SELECT COUNT(*) AS n FROM mailbox_archive_attachments WHERE status='pending'").get();
  assert.ok(archived.n > 0);

  const retryAt = Date.now() + 60_000;
  f.db.prepare("UPDATE mailbox_archive_attachments SET status='error',error='旧附件归档失败',failures=2,next_attempt_at=? WHERE uid=102").run(retryAt);
  await f.sync();

  assert.equal(attachmentDownloads, 0);
  assert.deepEqual({ ...f.db.prepare('SELECT status,failures,next_attempt_at FROM mailbox_archive_attachments WHERE uid=102').get() },
    { status: 'error', failures: 2, next_attempt_at: retryAt });
  const sent = f.list({ folder: 'sent' }).messages.find(item => item.uid === 102);
  assert.equal(sent.archive.attachments, undefined);
  const detail = await f.mailbox.readMessage(f.account.id, { folder: 'sent', uid: 102, uidValidity: '22' }, f.context);
  assert.equal(detail.archive.status, 'ready');
  assert.equal(detail.attachments[0].name, 'report.pdf');
  assert.equal(detail.attachments[0].archive, undefined);
});

test('late archive jobs get a full per-item timeout without starting another job after the batch window', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let bodyAttempts = 0;
  const finishWithinItemTimeout = async attempt => {
    if (attempt === 1) now += 14_999;
    else {
      await delay(10);
      now += 2;
    }
  };
  const f = await fixture(t, { bodyBatchSize: 3 });
  f.state.readHook = async () => {
    await finishWithinItemTimeout(++bodyAttempts);
  };

  await f.sync();

  assert.equal(bodyAttempts, 2);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM mailbox_bodies WHERE status='ready'").get().n, 2);
});

test('individual archive deadlines report timeouts for retry while the next job can succeed', async t => {
  const f = await fixture(t, { bodyBatchSize: 2, bodyTimeoutMs: 10 });
  f.state.readHook = async ({ uid }) => { if (uid === '5') await delay(30); };

  await f.sync();

  const body = f.db.prepare('SELECT status,error,next_attempt_at FROM mailbox_bodies WHERE uid=5').get();
  assert.equal(body.status, 'error');
  assert.match(body.error, /正文归档超时/);
  assert.ok(body.next_attempt_at > Date.now());
  assert.equal(f.db.prepare('SELECT status FROM mailbox_bodies WHERE uid=102').get().status, 'ready');
});

test('a one-job archive batch rotates folders and alternates due retries with fresh mail', async t => {
  const f = await fixture(t, { bodyBatchSize: 1 });
  const attempts = [];
  f.state.readHook = async ({ uid }) => {
    attempts.push(uid);
    if (uid === '5') throw new HttpError(502, '模拟归档失败');
  };

  for (let round = 0; round < 6; round++) await f.sync();

  assert.deepEqual(attempts, ['5', '102', '4', '101', '5', '3']);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM mailbox_bodies WHERE status='pending'").get().n, 2);
  assert.equal(f.db.prepare('SELECT failures FROM mailbox_bodies WHERE uid=5').get().failures, 2);
});

test('stop cancels body archiving and leaves the persistent job eligible for restart', async t => {
  const reached = deferred(), release = deferred();
  const f = await fixture(t, { bodyBatchSize: 4 });
  f.state.readHook = async () => { reached.resolve(); return release.promise; };
  f.mailbox.requestSync(f.account.id, f.context); await reached.promise; await f.mailbox.stop();
  assert.equal(f.mailbox.active.size, 0);
  release.resolve(); await delay(0);
  const status = f.db.prepare('SELECT status FROM mailbox_bodies WHERE uid=5').get();
  assert.equal(status.status, 'pending');
});

test('archives a fair default batch per folder and catches up without extra metadata polls', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const f = await fixture(t, { bodyBatchSize: undefined, pageSize: 50 });
  f.state.inbox = Array.from({ length: 65 }, (_, index) => message(index + 1));
  f.state.sent = Array.from({ length: 65 }, (_, index) => message(index + 101));
  const batches = [];
  const reached = deferred(), release = deferred();
  f.email.adapter.readBatch = async (_config, _credentials, input) => {
    const { folder, uidValidity, uids, deadline, bodyTimeoutMs, onStart, onResult } = input;
    assert.equal(deadline, now + 18_000);
    assert.equal(bodyTimeoutMs, 25_000);
    assert.equal(input.includeRichBody({ date: '2000-01-01', receivedAt: new Date(now).toISOString() }), true);
    assert.equal(input.includeRichBody({ date: '2000-01-01' }), false);
    batches.push({ folder, uidValidity, uids });
    if (batches.length === 3) { reached.resolve(); await release.promise; }
    for (const uid of uids) {
      assert.equal(onStart(uid), true);
      onResult(uid, { body: { uid, uidValidity, text: 'offline-secret-never-network' } });
    }
    if (batches.length === 1) now += 18_500;
  };
  f.mailbox.start(); await f.mailbox.whenIdle();
  assert.deepEqual(batches.map(({ folder, uidValidity, uids }) => [folder, uidValidity, uids.length, uids[0]]),
    [['INBOX', '11', 20, '65'], ['已发送', '22', 20, '165']]);
  assert.equal(f.db.prepare("SELECT text FROM mailbox_bodies WHERE path='INBOX' AND uid=65").get().text, '[REDACTED]');
  assert.equal(f.state.calls.filter(call => call.method === 'read').length, 0);

  now += 4_999; f.mailbox.tick(); await f.mailbox.whenIdle(); assert.equal(batches.length, 2);
  now++; f.mailbox.tick(); await reached.promise;
  assert.equal(f.mailbox.listAccounts(f.context)[0].sync.status, 'ready');
  assert.equal(f.list().sync.status, 'ready');
  f.mailbox.tick(); assert.equal(f.mailbox.pending.size, 0);
  const detail = await f.mailbox.readMessage(f.account.id, { uid: 45, uidValidity: '11' }, { actor: { id: 'other' }, mailboxPublic: true });
  assert.equal(detail.archive.status, 'ready');
  f.mailbox.requestSync(f.account.id, f.context);
  assert.equal(f.mailbox.listAccounts(f.context)[0].sync.status, 'queued');
  release.resolve(); await f.mailbox.whenIdle();
  assert.deepEqual(batches.slice(2).map(({ folder, uids }) => [folder, uids.length, uids[0]]),
    [['已发送', 20, '145'], ['INBOX', 20, '44'], ['已发送', 20, '125']]);
  assert.equal(f.state.calls.filter(call => call.method === 'folders').length, 2);

  now += 5_000; f.mailbox.tick(); await f.mailbox.whenIdle();
  assert.deepEqual(batches.slice(5).map(({ folder, uids }) => [folder, uids.length, uids[0]]),
    [['已发送', 5, '105'], ['INBOX', 24, '24']]);
  assert.equal(f.state.calls.filter(call => call.method === 'folders').length, 2);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM mailbox_bodies WHERE status='ready'").get().n, 130);
});

test('a body-only round yields its second folder when metadata becomes due', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const f = await fixture(t, { bodyBatchSize: 2 });
  const attempts = [];
  f.email.adapter.readBatch = async (_config, _credentials, { folder, uids, uidValidity, onStart, onResult }) => {
    attempts.push([folder, f.state.calls.filter(call => call.method === 'folders').length]);
    for (const uid of uids) {
      assert.equal(onStart(uid), true);
      onResult(uid, { body: { uid, uidValidity, text: 'ok' } });
    }
    if (attempts.length === 3) now += 6_000;
  };
  f.mailbox.start(); await f.mailbox.whenIdle();
  now += 55_000; f.mailbox.tick(); await f.mailbox.whenIdle();
  assert.deepEqual(attempts, [['INBOX', 1], ['已发送', 1], ['已发送', 1], ['INBOX', 2]]);
});

test('a queued metadata refresh can take a full background slot before another folder starts', async t => {
  const f = await fixture(t, { bodyBatchSize: 2, maxConcurrency: 1 });
  const second = await f.email.saveAccount(null, { ...f.body, email: 'second@example.test' }, f.admin);
  const reached = deferred(), release = deferred(), attempts = [];
  f.email.adapter.readBatch = async (config, _credentials, { folder, uids, uidValidity, onStart, onResult }) => {
    attempts.push([config.email, folder]);
    if (attempts.length === 1) { reached.resolve(); await release.promise; }
    for (const uid of uids) {
      assert.equal(onStart(uid), true);
      onResult(uid, { body: { uid, uidValidity, text: 'ok' } });
    }
  };
  f.mailbox.requestSync(f.account.id, f.context); await reached.promise;
  f.mailbox.requestSync(second.id, f.context);
  release.resolve(); await f.mailbox.whenIdle();
  assert.deepEqual(attempts, [['business@example.test', 'INBOX'], ['second@example.test', 'INBOX'], ['second@example.test', '已发送']]);
});

test('connection failures back off body-only work without marking unstarted messages as errors', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const f = await fixture(t, { bodyBatchSize: 2 });
  let attempts = 0;
  f.email.adapter.readBatch = async () => { attempts++; throw new HttpError(502, '模拟连接失败'); };
  f.mailbox.start(); await f.mailbox.whenIdle(); assert.equal(attempts, 2);
  now += 9_999; f.mailbox.tick(); await f.mailbox.whenIdle(); assert.equal(attempts, 2);
  now++; f.mailbox.tick(); await f.mailbox.whenIdle(); assert.equal(attempts, 4);
  now += 19_999; f.mailbox.tick(); await f.mailbox.whenIdle(); assert.equal(attempts, 4);
  now++; f.mailbox.tick(); await f.mailbox.whenIdle(); assert.equal(attempts, 6);
  assert.equal(f.state.calls.filter(call => call.method === 'folders').length, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM mailbox_bodies WHERE status!='pending' OR failures!=0").get().n, 0);
});

test('recent plain archives backfill sanitized rich text without reopening old or deleted mail', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const f = await fixture(t, { bodyBatchSize: 20, pageSize: 50 });
  const recent = new Date(now - 60_000).toISOString();
  const old = new Date(now - 3 * 24 * 60 * 60_000).toISOString();
  f.state.inbox = [1, 2, 3, 4].map(uid => ({ ...message(uid), date: uid === 1 ? old : recent }));
  f.state.sent = [{ ...message(101), date: recent }];
  await f.sync();
  f.db.prepare("UPDATE mailbox_bodies SET status='partial' WHERE path='INBOX' AND uid=2").run();
  f.db.prepare("UPDATE mailbox_messages SET remote_deleted=1 WHERE path='INBOX' AND uid=4").run();
  const attempts = [];
  f.email.adapter.readRichBatch = async (_config, _credentials, { folder, uids, deadline, bodyTimeoutMs, onStart, onResult }) => {
    assert.equal(deadline, now + 8_000);
    assert.equal(bodyTimeoutMs, 5_000);
    attempts.push([folder, ...uids]);
    for (const uid of uids) {
      assert.equal(onStart(uid), true);
      if (uid === '3') onResult(uid, { error: new HttpError(502, '模拟读取失败') });
      else onResult(uid, { body: { html: '<p>图文</p><script>bad()</script>', images: [Buffer.from('never stored')] } });
    }
  };
  f.mailbox.start(); await f.mailbox.whenIdle();
  now += 5_000; f.mailbox.tick(); await f.mailbox.whenIdle();
  assert.deepEqual(attempts, [['INBOX', '3', '2']]);
  assert.equal(f.db.prepare('SELECT html FROM mailbox_rich_bodies WHERE uid=2').get().html, '<p>图文</p>');
  const readBody = f.db.prepare('SELECT status,text,failures,rich_failures,rich_next_attempt_at FROM mailbox_bodies WHERE uid=?');
  assert.deepEqual({ ...readBody.get(2) }, { status: 'partial', text: '只按需读取纯文本正文', failures: 0, rich_failures: 0, rich_next_attempt_at: 0 });
  assert.deepEqual({ ...readBody.get(3) }, { status: 'ready', text: '只按需读取纯文本正文', failures: 0, rich_failures: 1, rich_next_attempt_at: now + 120_000 });

  now += 5_000; f.mailbox.tick(); await f.mailbox.whenIdle();
  now += 5_000; f.mailbox.tick(); await f.mailbox.whenIdle();
  assert.deepEqual(attempts, [['INBOX', '3', '2'], ['已发送', '101']]);
  assert.deepEqual(f.db.prepare('SELECT uid FROM mailbox_rich_bodies ORDER BY uid').all().map(row => row.uid), [2, 101]);
  assert.equal(f.state.calls.filter(call => call.method === 'folders').length, 1);
});

test('staged old mail requests full rich content and shares backfill turns with existing mail', async t => {
  let now = Date.parse('2026-11-06T00:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const f = await fixture(t, { bodyBatchSize: 20, pageSize: 50 });
  const old = '2026-08-01T00:00:00Z', recent = new Date(now - 60_000).toISOString();
  f.state.inbox = [{ ...message(1), date: old }, { ...message(2), date: recent }, { ...message(3), date: old }];
  f.state.sent = [{ ...message(101), date: old }, { ...message(102), date: recent }];
  await f.sync();
  f.db.prepare('UPDATE mailbox_messages SET publish_after_archive=1 WHERE uid=1').run();
  f.db.prepare('UPDATE mailbox_messages SET publish_after_archive=2 WHERE uid IN (3,101)').run();
  f.db.prepare("UPDATE mailbox_bodies SET status='pending' WHERE uid=1").run();

  const modes = [], batches = [];
  f.email.adapter.readBatch = async (_config, _credentials, { uids, uidValidity, includeRichBody, onStart, onResult }) => {
    for (const uid of uids) {
      modes.push([uid, includeRichBody({ uid: Number(uid), receivedAt: old })]);
      assert.equal(onStart(uid), true);
      onResult(uid, { body: { uid, uidValidity, text: '正文已读，HTML 暂未读到' } });
    }
  };
  f.email.adapter.readRichBatch = async (_config, _credentials, { folder, uids, onStart, onResult }) => {
    batches.push([folder, ...uids]);
    for (const uid of uids) {
      assert.equal(onStart(uid), true);
      onResult(uid, { body: { html: uid === '101' ? '' : `<p>${uid}</p>` } });
    }
  };
  f.mailbox.start(); await f.mailbox.whenIdle();
  for (let round = 0; round < 4; round++) {
    now += 5_000; f.mailbox.tick(); await f.mailbox.whenIdle();
  }
  assert.deepEqual(modes, [['1', true]]);
  assert.deepEqual(batches, [['INBOX', '1', '3'], ['INBOX', '2'], ['已发送', '101'], ['已发送', '102']]);
  assert.equal(f.db.prepare('SELECT html FROM mailbox_rich_bodies WHERE uid=101').get().html, '');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM mailbox_messages WHERE publish_after_archive<>0').get().n, 0);
  assert.equal(f.state.calls.filter(call => call.method === 'folders').length, 1);
});

test('staged body batches opt into CID bytes and publish complete local images without attachment downloads', async t => {
  const f = await fixture(t, { bodyBatchSize: 20, pageSize: 50 });
  let fileDownloads = 0;
  f.email.adapter.downloadAttachment = async () => { fileDownloads++; };
  f.email.adapter.readRichBatch = async () => assert.fail('正文已包含富文本');
  f.email.adapter.readInlineImages = async () => assert.fail('正文已包含内嵌图片');
  f.email.adapter.readBatch = async (_config, _credentials, { uids, uidValidity, includeRichBody, includeInlineImages, onStart, onResult }) => {
    for (const uid of uids) {
      const policy = { uid: Number(uid), receivedAt: '2026-08-01' };
      assert.equal(includeRichBody(policy), true);
      assert.equal(includeInlineImages(policy), true);
      assert.equal(onStart(uid), true);
      onResult(uid, { body: { uid, uidValidity, text: '已归档正文', richBody: { html: '<p>正文</p><img src="cid:logo">' },
        inlineImages: { images: [inlineImage('logo')] }, attachments: [{ part: '3', name: 'report.pdf', mimeType: 'application/pdf' }] } });
    }
  };
  await f.restart(); await f.sync();
  const cached = f.mailbox.inlineArchive(f.account.id, f.account.version, { folder: 'INBOX', uidValidity: '11', uid: '5' });
  assert.deepEqual(cached, { images: [inlineImage('logo')] });
  assert.equal(f.list().total, 5);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM mailbox_inline_images').get().n, 7);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM mailbox_messages WHERE publish_after_archive<>0').get().n, 0);
  assert.equal(fileDownloads, 0);
});

test('image-only catchup prioritizes viewed and staged mail, retains partial bytes and retries after restart', async t => {
  let now = Date.parse('2026-11-07T00:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const f = await fixture(t, { bodyBatchSize: 20, pageSize: 50 });
  f.state.inbox = [1, 2, 3].map(uid => ({ ...message(uid), date: '2026-08-01T00:00:00Z' }));
  f.state.sent = [{ ...message(101), date: '2026-08-01T00:00:00Z' }];
  await f.sync();
  for (const [folder, uidValidity, uids] of [['INBOX', '11', [1, 2, 3]], ['已发送', '22', [101]]]) {
    for (const uid of uids) f.mailbox.storeRichBody(f.account.id, f.account.version, { folder, uidValidity, uid },
      { html: `<p>${uid}</p><img src="cid:logo">${uid === 1 ? '<img src="cid:stamp">' : ''}` });
  }
  f.db.prepare('UPDATE mailbox_messages SET publish_after_archive=1 WHERE uid IN (1,101)').run();
  const attempts = [];
  let retried = false;
  f.email.adapter.readInlineImages = async (_config, _credentials, input) => {
    input.authorize(); attempts.push(Number(input.uid));
    if (input.uid === '1' && !retried) { retried = true; return { images: [inlineImage('logo')], truncated: true }; }
    return { images: input.uid === '1' ? [inlineImage('stamp')] : [inlineImage('logo')] };
  };
  assert.equal(f.mailbox.prioritizeInlineImages(f.account.id, f.account.version, { folder: 'INBOX', uidValidity: '11', uid: '2' }), true);
  assert.deepEqual(attempts, []);
  f.mailbox.start(); await f.mailbox.whenIdle();
  for (let round = 0; round < 3; round++) { now += 5_000; f.mailbox.tick(); await f.mailbox.whenIdle(); }
  assert.deepEqual(attempts, [2, 101, 1, 3]);
  const read = () => f.mailbox.inlineArchive(f.account.id, f.account.version, { folder: 'INBOX', uidValidity: '11', uid: '1' });
  assert.deepEqual(read(), { images: [inlineImage('logo')], truncated: true });
  const state = f.db.prepare('SELECT status,failures,next_attempt_at FROM mailbox_inline_image_state WHERE uid=1').get();
  assert.equal(state.status, 'partial'); assert.equal(state.failures, 1); assert.ok(state.next_attempt_at > now);
  assert.equal(f.state.calls.filter(call => call.method === 'folders').length, 1);
  await f.restart(); f.mailbox.start(); await f.mailbox.whenIdle();
  assert.deepEqual(attempts, [2, 101, 1, 3]);
  now = state.next_attempt_at; f.mailbox.tick(); await f.mailbox.whenIdle();
  assert.deepEqual(attempts, [2, 101, 1, 3, 1]);
  assert.deepEqual(read(), { images: [inlineImage('logo'), inlineImage('stamp')] });
  assert.equal(f.db.prepare('SELECT status FROM mailbox_inline_image_state WHERE uid=1').get().status, 'ready');
  assert.equal(f.db.prepare('SELECT publish_after_archive FROM mailbox_messages WHERE uid=1').get().publish_after_archive, 0);
  f.email.adapter.readInlineImages = async () => { throw new Error('offline'); };
  assert.deepEqual(read(), { images: [inlineImage('logo'), inlineImage('stamp')] });
});

test('an image-only request canceled by configuration changes cannot persist late bytes', async t => {
  let now = Date.parse('2026-11-07T00:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const f = await fixture(t, { bodyBatchSize: 20, pageSize: 50 });
  f.state.inbox = [message(1)]; f.state.sent = [];
  await f.sync();
  const reference = { folder: 'INBOX', uidValidity: '11', uid: '1' };
  f.mailbox.storeRichBody(f.account.id, f.account.version, reference, { html: '<img src="cid:logo">' });
  const reached = deferred(), release = deferred();
  f.email.adapter.readInlineImages = async () => { reached.resolve(); await release.promise; return { images: [inlineImage('logo')] }; };
  f.mailbox.start(); await f.mailbox.whenIdle();
  now += 5_000; f.mailbox.tick(); await reached.promise;
  await f.email.saveAccount(f.account.id, { enabled: false }, f.admin);
  await f.mailbox.whenIdle(); release.resolve(); await delay(0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM mailbox_inline_images').get().n, 0);
  assert.equal(f.db.prepare('SELECT failures FROM mailbox_inline_image_state WHERE uid=1').get().failures, 0);
});

test('viewed old mail is queued ahead of recent backfill without bypassing eligibility or retry', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const f = await fixture(t, { bodyBatchSize: 20, pageSize: 50 });
  const recent = new Date(now - 60_000).toISOString();
  const old = new Date(now - 3 * 24 * 60 * 60_000).toISOString();
  f.state.inbox = [1, 2, 3, 4].map(uid => ({ ...message(uid), date: uid === 4 ? recent : old }));
  f.state.sent = [];
  await f.sync();
  f.db.prepare("UPDATE mailbox_bodies SET status='pending' WHERE path='INBOX' AND uid=2").run();
  f.db.prepare("UPDATE mailbox_messages SET remote_deleted=1 WHERE path='INBOX' AND uid=3").run();
  const batches = [];
  f.email.adapter.readRichBatch = async (_config, _credentials, { uids, onStart, onResult }) => {
    batches.push(uids);
    for (const uid of uids) {
      assert.equal(onStart(uid), true);
      if (batches.length === 1) onResult(uid, { error: new HttpError(502, '模拟超时') });
      else onResult(uid, { body: { html: `<p>${uid}</p>` } });
    }
  };
  const version = f.account.version;
  const prioritize = uid => f.mailbox.prioritizeRichBody(f.account.id, version, { folder: 'INBOX', uidValidity: '11', uid: String(uid) });
  assert.equal(prioritize(1), true);
  assert.equal(prioritize(1), true);
  assert.equal(prioritize(2), false);
  assert.equal(prioritize(3), false);
  assert.deepEqual(batches, []);

  f.mailbox.start(); await f.mailbox.whenIdle();
  now += 5_000; f.mailbox.tick(); await f.mailbox.whenIdle();
  assert.deepEqual(batches, [['1']]);
  const retryAt = f.db.prepare('SELECT rich_next_attempt_at FROM mailbox_bodies WHERE uid=1').get().rich_next_attempt_at;
  assert.equal(retryAt, now + 120_000);
  assert.equal(prioritize(1), true);

  now += 5_000; f.mailbox.tick(); await f.mailbox.whenIdle();
  assert.deepEqual(batches, [['1'], ['4']]);
  now = retryAt; f.mailbox.tick(); await f.mailbox.whenIdle();
  assert.deepEqual(batches, [['1'], ['4'], ['1']]);
  assert.equal(prioritize(1), false);
  assert.deepEqual(f.db.prepare('SELECT uid FROM mailbox_rich_bodies ORDER BY uid').all().map(row => row.uid), [1, 4]);
});

test('a failed folder batch restores started jobs and leaves other folders eligible', async t => {
  const f = await fixture(t, { bodyBatchSize: 4 });
  f.email.adapter.readBatch = async (_config, _credentials, { folder, uids, uidValidity, onStart, onResult }) => {
    if (folder === 'INBOX') {
      assert.equal(onStart(uids[0]), true);
      throw new HttpError(502, '模拟连接中断');
    }
    for (const uid of uids) {
      assert.equal(onStart(uid), true);
      onResult(uid, { body: { uid, uidValidity, text: 'ok' } });
    }
  };
  await f.sync();
  const bodies = f.db.prepare('SELECT status,failures FROM mailbox_bodies WHERE path=? ORDER BY uid DESC LIMIT 2');
  assert.deepEqual(bodies.all('INBOX').map(row => [row.status, row.failures]), [['pending', 0], ['pending', 0]]);
  assert.deepEqual(bodies.all('已发送').map(row => [row.status, row.failures]), [['ready', 0], ['ready', 0]]);
});

test('a canceled batch retains completed results and ignores a late result for a started item', async t => {
  const reached = deferred(), release = deferred();
  const f = await fixture(t, { bodyBatchSize: 4 });
  f.email.adapter.readBatch = async (_config, _credentials, { uids, uidValidity, onStart, onResult }) => {
    const [first, second] = uids;
    assert.equal(onStart(first), true);
    onResult(first, { body: { uid: first, uidValidity, text: 'completed before cancellation' } });
    assert.equal(onStart(second), true);
    reached.resolve(); await release.promise;
    assert.throws(() => onResult(second, { body: { uid: second, uidValidity, text: 'late result' } }));
  };
  f.mailbox.requestSync(f.account.id, f.context); await reached.promise;
  await f.mailbox.stop(); release.resolve(); await delay(0);
  const statuses = f.db.prepare('SELECT status,failures FROM mailbox_bodies WHERE path=? AND uid>=? ORDER BY uid DESC');
  assert.deepEqual(statuses.all('INBOX', 4).map(row => [row.status, row.failures]), [['ready', 0], ['pending', 0]]);
  assert.deepEqual(statuses.all('已发送', 101).map(row => [row.status, row.failures]), [['pending', 0], ['pending', 0]]);
});

test('default archive exceeds 2000 summaries and SQL pages deserialize only a bounded result', async t => {
  const f = await fixture(t); await f.sync(); const insert = f.db.prepare('INSERT INTO mailbox_messages(account_id,account_version,path,uid_validity,uid,summary_json,search_text) VALUES (?,?,?,?,?,?,?)');
  for (let uid = 6; uid <= 2010; uid++) insert.run(f.account.id, 1, 'INBOX', '11', uid, JSON.stringify(message(uid)), `预约 ${uid}`);
  await f.sync(); const page = f.list({ offset: 2000, limit: 3 });
  assert.equal(page.total, 2010); assert.equal(page.messages.length, 3); assert.equal(page.sync.truncated, false); assert.equal(page.nextOffset, 2003);
  assert.equal(f.list({ query: '预约 2010' }).total, 1);
});

test('public read and attachment references require synchronized UID and known MIME part', async t => {
  const f = await fixture(t); await f.sync(); const context = { actor: { id: 'other' }, mailboxPublic: true };
  await assert.rejects(f.mailbox.readMessage(f.account.id, { uid: 999, uidValidity: '11' }, context), /尚未同步/);
  assert.throws(() => f.mailbox.attachmentReference(f.account.id, { uid: 5, uidValidity: '11', part: '2' }, context), /先打开/);
  await f.mailbox.readMessage(f.account.id, { uid: 5, uidValidity: '11' }, context);
  assert.throws(() => f.mailbox.attachmentReference(f.account.id, { uid: 5, uidValidity: '11', part: '9' }, context), /已识别的附件/);
  const calls = f.state.calls.length;
  const reference = { uid: 5, uidValidity: '11', part: '2' };
  assert.deepEqual(f.mailbox.attachmentMetadata(f.account.id, reference, context), {
    part: '2', name: 'report.pdf', size: 50, mimeType: 'application/pdf', inline: false, sizeIsEncoded: false
  });
  assert.throws(() => f.mailbox.attachmentMetadata(f.account.id, { ...reference, uidValidity: '99' }, context), /编号已重置/);
  assert.throws(() => f.mailbox.attachmentMetadata(f.account.id, { ...reference, part: '9' }, context), /已识别的附件/);
  assert.throws(() => f.mailbox.attachmentMetadata(f.account.id, reference, { actor: { id: 'other' }, sessionId: 'group1' }), { status: 403 });
  assert.equal(f.state.calls.length, calls);
});

test('IMAP port and TLS participate in stable archive identity and prior namespaces stay hidden', async t => {
  const f = await fixture(t); await f.sync(); const before = f.mailbox.archiveKey(f.account.id, f.context);
  await f.email.saveAccount(f.account.id, { imap: { port: 1993 } }, f.admin); f.mailbox.invalidate(f.account.id);
  assert.notEqual(f.mailbox.archiveKey(f.account.id, f.context).archiveId, before.archiveId); assert.equal(f.list().total, 0);
  await f.email.saveAccount(f.account.id, { imap: { port: 993 } }, f.admin); f.mailbox.invalidate(f.account.id);
  assert.equal(f.mailbox.archiveKey(f.account.id, f.context).archiveId, before.archiveId); assert.equal(f.list().total, 4);
});
