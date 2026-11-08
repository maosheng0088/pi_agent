import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../lib/store.mjs';
import { EmailService } from '../lib/email.mjs';
import { HttpError } from '../lib/security.mjs';

const admin = { id: 'admin', role: 'admin' }, member = { id: 'employee', role: 'member' }, outsider = { id: 'other', role: 'member' };
const secret = 'offline-mail-authorization-4314';
const content = { to: ['recipient@example.test'], subject: '核对预约', text: '请核对今日预约数量。' };
const xorCodec = async (_, bytes) => Buffer.from(bytes).map(byte => byte ^ 0xa5);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t, options = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'pi-email-service-'));
  mkdirSync(path.join(directory, 'data')); mkdirSync(path.join(directory, 'workspace'));
  const store = new Store(path.join(directory, 'data'), path.join(directory, 'workspace'));
  for (const actor of [admin, member, outsider]) store.db.prepare('INSERT INTO users(id,username,display_name,role,password_hash,created_at) VALUES (?,?,?,?,?,?)').run(actor.id, actor.id, actor.id, actor.role, 'unused-offline-hash', '2026-10-30T00:00:00Z');
  for (const id of ['group1', 'group2']) store.db.prepare('INSERT INTO session_meta VALUES (?,?)').run(id, JSON.stringify({ id }));
  for (const actor of [admin, member]) store.db.prepare('INSERT INTO group_members VALUES (?,?,NULL,?)').run('group1', actor.id, '2026-10-30T00:00:00Z');
  store.db.prepare('INSERT INTO group_members VALUES (?,?,NULL,?)').run('group2', member.id, '2026-10-30T00:00:00Z');
  const calls = [], events = [];
  const adapter = {
    async check(config, credentials, runtime) { runtime.authorize(); calls.push('check'); assert.equal(credentials.imapPassword, secret); return { imapReady: true, smtpReady: Boolean(config.smtp) }; },
    async folders(_config, _credentials, runtime) { runtime.authorize(); calls.push('folders'); return { folders: [{ path: 'INBOX' }] }; },
    async search(_config, _credentials, options) { options.authorize(); calls.push('search'); return { folder: options.folder, uidValidity: '7', messages: [{ uid: 12, subject: '今日预约' }], nextCursor: 'next-page' }; },
    async read(_config, _credentials, options) { options.authorize(); calls.push('read'); return { uid: 12, folder: options.folder, text: '预约共 3 票。', attachments: [] }; },
    async downloadAttachment(_config, _credentials, options) { options.authorize(); calls.push('download'); return { name: 'report.csv', mimeType: 'text/csv', content: Buffer.from('count\n3') }; },
    async send(_config, _credentials, options) { options.authorize(); calls.push('send'); return { messageId: '<fixture@example.test>', accepted: options.draft.to, rejected: [] }; },
  };
  let service = new EmailService(store, { adapter, codec: xorCodec, onEvent: event => events.push(event), ...options });
  t.after(() => { service.close(); store.close(); assert.equal(path.dirname(directory), os.tmpdir()); assert.ok(path.basename(directory).startsWith('pi-email-service-')); rmSync(directory, { recursive: true, force: true }); });
  const management = { actor: admin, authorize() {} }, context = { actor: member, sessionId: 'group1', mode: 'workspace', authorize() {} };
  const body = { name: '业务邮箱', email: 'business@example.test', fromName: '业务组', enabled: true, allowSend: true, scope: 'groups', groupIds: ['group1'], imap: { host: 'imap.example.test', port: 993, tls: 'implicit', username: 'imap-user', password: secret }, smtp: { host: 'smtp.example.test', port: 587, tls: 'starttls', username: 'smtp-user', password: 'offline-smtp-code-1312' } };
  const account = await service.saveAccount(null, body, management);
  return { store, adapter, calls, events, account, body, context, management, get service() { return service; }, recreate() { service.close(); service = new EmailService(store, { adapter, codec: xorCodec, ...options }); return service; } };
}

test('mail accounts use encrypted credentials, current admin roles, safe metadata and blank-password preservation', async t => {
  const f = await fixture(t), row = f.store.db.prepare('SELECT * FROM email_accounts WHERE id=?').get(f.account.id);
  assert.ok(row.credentials_ciphertext); assert.doesNotMatch(JSON.stringify(row), /offline-mail-authorization|offline-smtp-code/);
  assert.equal(f.account.imap.passwordSet, true); assert.equal(f.account.smtp.passwordSet, true);
  assert.doesNotMatch(JSON.stringify(f.service.listAccounts(f.management)), /offline-mail-authorization|credentials_ciphertext/);
  assert.throws(() => f.service.listAccounts({ actor: { ...member, role: 'admin' } }), /管理员/);
  await assert.rejects(f.service.saveAccount(f.account.id, { name: 'Forged' }, { actor: { ...member, role: 'admin' } }), /管理员/);
  const updated = await f.service.saveAccount(f.account.id, { name: '客服邮箱', imap: { password: '' }, smtp: { password: '' } }, f.management);
  assert.equal(updated.name, '客服邮箱'); assert.equal(updated.version, 2);
  assert.equal((await f.service.decrypt(f.service.row(f.account.id))).imapPassword, secret);
  f.recreate(); assert.deepEqual(f.service.knownSecrets(), []); await f.service.initialize(); assert.ok(f.service.knownSecrets().includes(secret)); assert.deepEqual(f.calls, []);
});

test('new accounts default disabled and cannot silently allow sending or use insecure protocol modes', async t => {
  const f = await fixture(t), minimal = { ...f.body }; delete minimal.enabled; delete minimal.allowSend; delete minimal.scope; delete minimal.groupIds; minimal.smtp = null;
  const account = await f.service.saveAccount(null, minimal, f.management);
  assert.equal(account.enabled, false); assert.equal(account.allowSend, false); assert.equal(account.smtp, null);
  assert.equal(account.scope, 'none'); assert.deepEqual(account.groupIds, []);
  await assert.rejects(f.service.saveAccount(null, { ...f.body, imap: { ...f.body.imap, tls: 'plaintext' } }, f.management), /TLS/);
  await assert.rejects(f.service.saveAccount(null, { ...f.body, groupIds: ['missing-group'] }, f.management), /群聊不存在/);
  await assert.rejects(f.service.saveAccount(null, { ...f.body, smtp: null }, f.management), /SMTP/);
});

test('password presence is tracked per protocol and legacy ciphertext never implies an SMTP password', async t => {
  const f = await fixture(t), row = f.service.row(f.account.id), config = JSON.parse(row.config_json);
  delete config.imap.passwordSet; delete config.smtp.passwordSet;
  const legacy = await xorCodec('protect', Buffer.from(JSON.stringify({ imapPassword: secret })));
  f.store.db.prepare('UPDATE email_accounts SET config_json=?,credentials_ciphertext=?,version=version+1 WHERE id=?').run(JSON.stringify(config), legacy.toString('base64'), f.account.id);
  f.recreate(); await f.service.initialize();
  const view = f.service.getAccount(f.account.id, f.management);
  assert.equal(view.imap.passwordSet, true); assert.equal(view.smtp.passwordSet, false);
  await assert.rejects(f.service.saveAccount(f.account.id, { name: 'still incomplete' }, f.management), /已配置协议/);
  assert.equal((await f.service.saveAccount(f.account.id, { smtp: { password: 'new-smtp-authorization' } }, f.management)).smtp.passwordSet, true);
});

test('administrators can replace all credentials even if the old DPAPI value cannot be decrypted', async t => {
  const f = await fixture(t);
  f.service.codec = async (operation, bytes) => { if (operation === 'unprotect') throw new Error('unreadable legacy cipher'); return xorCodec(operation, bytes); };
  await assert.rejects(f.service.saveAccount(f.account.id, { name: 'missing replacements' }, f.management), /无法解密/);
  const updated = await f.service.saveAccount(f.account.id, { imap: { password: 'replacement-imap-code' }, smtp: { password: 'replacement-smtp-code' } }, f.management);
  assert.equal(updated.imap.passwordSet, true); assert.equal(updated.smtp.passwordSet, true);
});

test('admin revocation while encryption awaits prevents the synchronous database commit', async t => {
  const f = await fixture(t), pause = deferred(), reached = deferred(), old = f.service.getAccount(f.account.id, f.management);
  f.service.codec = async (operation, bytes) => { if (operation === 'protect') { reached.resolve(); await pause.promise; } return xorCodec(operation, bytes); };
  const pending = f.service.saveAccount(f.account.id, { name: 'must not commit' }, f.management);
  const rejected = assert.rejects(pending, /管理员/); await reached.promise;
  f.store.db.prepare("UPDATE users SET role='member' WHERE id='admin'").run(); pause.resolve(); await rejected;
  assert.equal(JSON.parse(f.service.row(f.account.id).config_json).name, old.name); assert.equal(f.service.row(f.account.id).version, old.version);
});

test('concurrent account saves preserve the first committed version instead of overwriting it', async t => {
  const f = await fixture(t), pause = deferred(), reached = deferred(); let blocked = false;
  f.service.codec = async (operation, bytes) => { if (operation === 'protect' && !blocked) { blocked = true; reached.resolve(); await pause.promise; } return xorCodec(operation, bytes); };
  const first = f.service.saveAccount(f.account.id, { name: 'stale change' }, f.management), rejected = assert.rejects(first, /配置已更新/); await reached.promise;
  await f.service.saveAccount(f.account.id, { name: 'committed change' }, f.management); pause.resolve(); await rejected;
  assert.equal(f.service.getAccount(f.account.id, f.management).name, 'committed change');
});

test('employees require live group membership, enabled mailbox and matching scope before any mailbox access', async t => {
  const f = await fixture(t);
  assert.equal(f.service.listAvailable(f.context)[0].allowSend, true);
  assert.ok(!('imap' in f.service.listAvailable(f.context)[0]));
  assert.throws(() => f.service.listAvailable({ ...f.context, actor: outsider }), /群成员/);
  await assert.rejects(f.service.listMessages(f.account.id, {}, { ...f.context, sessionId: 'group2' }), /未分配/);
  await assert.rejects(f.service.readMessage(f.account.id, { uid: 12 }, { ...f.context, actor: outsider }), /群成员/);
  f.store.db.prepare("UPDATE users SET disabled=1 WHERE id='employee'").run();
  await assert.rejects(f.service.readMessage(f.account.id, { uid: 12 }, f.context), /登录状态/); assert.deepEqual(f.calls, []);
});

test('mailbox AI authorization none stays independent from enabled public reads and preserves existing scopes', async t => {
  const f = await fixture(t), publicContext = { actor: outsider, mailboxPublic: true, authorize() {} };
  const none = await f.service.saveAccount(f.account.id, { scope: 'none', groupIds: ['group1'] }, f.management);
  assert.equal(none.enabled, true); assert.equal(none.scope, 'none'); assert.deepEqual(none.groupIds, []);
  assert.deepEqual(f.service.listAvailable(f.context), []);
  await assert.rejects(f.service.readMessage(f.account.id, { uid: 12 }, f.context), /未分配/);
  assert.equal((await f.service.readMessage(f.account.id, { uid: 12 }, publicContext, { publicRead: true })).text, '预约共 3 票。');
  assert.equal((await f.service.downloadAttachment(f.account.id, { uid: 12, part: '2' }, publicContext, { publicRead: true })).content.toString(), 'count\n3');
  await f.service.saveAccount(f.account.id, { scope: 'all' }, f.management);
  assert.equal(f.service.listAvailable(f.context).length, 1);
  await f.service.saveAccount(f.account.id, { name: '保留全部授权' }, f.management);
  assert.equal(f.service.getAccount(f.account.id, f.management).scope, 'all');
  await f.service.saveAccount(f.account.id, { scope: 'groups', groupIds: ['group1'] }, f.management);
  await f.service.saveAccount(f.account.id, { name: '保留指定授权' }, f.management);
  assert.deepEqual(f.service.getAccount(f.account.id, f.management).groupIds, ['group1']);
});

test('public read requires an internal flag and explicit readonly permission and cannot bypass AI or admin authorization', async t => {
  const f = await fixture(t), publicContext = { actor: outsider, mailboxPublic: true, authorize() {} };
  const reference = { uid: 12 }, permissions = { publicRead: true };
  await assert.rejects(f.service.readMessage(f.account.id, reference, publicContext), /群成员/);
  await assert.rejects(f.service.readMessage(f.account.id, reference, { actor: outsider }, permissions), /仅允许读取/);
  await assert.rejects(f.service.readMessage(f.account.id, reference, { mailboxPublic: true }, permissions), /登录状态/);
  assert.throws(() => f.service.readMessage(f.account.id, reference, publicContext, { publicRead: true, admin: true }), /不支持/);
  assert.throws(() => f.service.readMessage(f.account.id, { ...reference, publicRead: true }, publicContext, permissions), /不支持/);
  assert.throws(() => f.service.access(f.account.id, { ...f.context, mailboxPublic: true }, { publicRead: true, send: true }), /仅允许读取/);
  assert.throws(() => f.service.access(f.account.id, { ...f.management, mailboxPublic: true }, { publicRead: true, admin: true }), /仅允许读取/);
  assert.throws(() => f.service.listAccounts(publicContext), /管理员/);
  assert.throws(() => f.service.listAvailable(publicContext), /群成员/);
  await assert.rejects(f.service.prepareDraft(f.account.id, content, publicContext), /群成员/);
  const draft = await f.service.prepareDraft(f.account.id, content, f.context);
  await assert.rejects(f.service.sendDraft(draft.id, { idempotencyKey: 'public-cannot-send' }, { ...f.context, mailboxPublic: true }), /仅允许读取/);
  assert.equal(f.service.getDraft(draft.id, f.context).status, 'draft'); assert.deepEqual(f.calls, []);
  await f.service.saveAccount(f.account.id, { enabled: false }, f.management);
  await assert.rejects(f.service.readMessage(f.account.id, reference, publicContext, permissions), /停用/);
  await f.service.saveAccount(f.account.id, { enabled: true }, f.management);
  f.store.db.prepare("UPDATE users SET disabled=1 WHERE id='other'").run();
  await assert.rejects(f.service.readMessage(f.account.id, reference, publicContext, permissions), /登录状态/);
});

test('public mailbox reads recheck login and enabled state after awaiting provider data', async t => {
  const f = await fixture(t), pause = deferred(), reached = deferred(), publicContext = { actor: outsider, mailboxPublic: true, authorize() {} };
  f.adapter.read = async () => { reached.resolve(); await pause.promise; return { text: 'private message' }; };
  const pending = f.service.readMessage(f.account.id, { uid: 12 }, publicContext, { publicRead: true }), rejected = assert.rejects(pending, /登录状态/);
  await reached.promise; f.store.db.prepare("UPDATE users SET disabled=1 WHERE id='other'").run(); pause.resolve(); await rejected;
});

test('extended attachment limits are internal public-read options and cannot be injected by AI parameters', async t => {
  const f = await fixture(t), publicContext = { actor: outsider, mailboxPublic: true, authorize() {} }, reference = { uid: 12, part: '2' }, maximum = 50 * 1024 * 1024;
  let forwarded;
  f.adapter.downloadAttachment = async (_a, _b, options) => { options.authorize(); forwarded = options; return { content: Buffer.from('public-attachment') }; };
  const result = await f.service.downloadAttachment(f.account.id, reference, publicContext, { publicRead: true }, { attachmentMaxBytes: maximum });
  assert.equal(result.content.toString(), 'public-attachment'); assert.equal(forwarded.attachmentMaxBytes, maximum);
  assert.throws(() => f.service.downloadAttachment(f.account.id, { ...reference, attachmentMaxBytes: maximum }, f.context), /不支持/);
  assert.throws(() => f.service.downloadAttachment(f.account.id, reference, f.context, {}, { attachmentMaxBytes: maximum }), /仅供公共邮箱/);
  await assert.rejects(f.service.downloadAttachment(f.account.id, reference, f.context, { publicRead: true }, { attachmentMaxBytes: maximum }), /仅允许读取/);
  for (const limit of [0, 1.5, maximum + 1, '52428800']) assert.throws(() => f.service.downloadAttachment(f.account.id, reference, publicContext, { publicRead: true }, { attachmentMaxBytes: limit }), /上限/);
});

test('receiver-only accounts can check, search and prepare drafts while sending stays forbidden', async t => {
  const f = await fixture(t);
  await f.service.saveAccount(f.account.id, { smtp: null, allowSend: false }, f.management);
  const checked = await f.service.checkAccount(f.account.id, f.management);
  assert.equal(checked.status, 'ready'); assert.equal(checked.imapReady, true); assert.equal(checked.smtpReady, false);
  assert.equal((await f.service.listMessages(f.account.id, { query: { unseen: true, since: '2026-10-01' } }, f.context)).messages.length, 1);
  const draft = await f.service.prepareDraft(f.account.id, content, f.context);
  await assert.rejects(f.service.sendDraft(draft.id, { idempotencyKey: 'send-offline-1' }, f.context), /尚未允许/);
  assert.ok(!f.calls.includes('send'));
});

test('read/search/folder/attachment operations forward bounded references and redact secret-bearing output', async t => {
  const f = await fixture(t);
  assert.equal((await f.service.folders(f.account.id, f.context)).folders[0].path, 'INBOX');
  assert.equal((await f.service.readMessage(f.account.id, { folder: 'INBOX', uid: '12', uidValidity: 7 }, f.context)).text, '预约共 3 票。');
  assert.equal((await f.service.downloadAttachment(f.account.id, { uid: 12, part: '2.1' }, f.context)).content.toString(), 'count\n3');
  f.adapter.read = async () => ({ text: `mail ${secret}`, credentials: { imapPassword: secret } });
  const output = await f.service.readMessage(f.account.id, { uid: 12 }, f.context); assert.doesNotMatch(JSON.stringify(output), /offline-mail/); assert.equal(output.credentials, '[REDACTED]');
  f.adapter.read = async () => { throw new HttpError(409, `safe failure ${secret}`); };
  await assert.rejects(f.service.readMessage(f.account.id, { uid: 12 }, f.context), error => error.status === 409 && !error.message.includes(secret));
  for (const value of [{ uid: '1:*' }, { uid: 0 }, { uid: 4294967296 }, { uid: 1, uidValidity: '7\nBAD' }]) assert.throws(() => f.service.readMessage(f.account.id, value, f.context), /无效/);
  assert.throws(() => f.service.listMessages(f.account.id, { query: { rawImap: 'ALL' } }, f.context), /不支持/);
  assert.throws(() => f.service.listMessages(f.account.id, { limit: 51 }, f.context), /分页/);
  assert.throws(() => f.service.listMessages(f.account.id, { query: { since: '2026-02-31' } }, f.context), /有效/);
  assert.throws(() => f.service.downloadAttachment(f.account.id, { uid: 12, part: '../secret' }, f.context), /无效/);
});

test('revocation after an awaited mailbox request hides the response and credential rotation cancels work', async t => {
  const f = await fixture(t), pause = deferred(), reached = deferred();
  f.adapter.read = async () => { reached.resolve(); await pause.promise; return { text: 'private message' }; };
  const pending = f.service.readMessage(f.account.id, { uid: 12 }, f.context), rejected = assert.rejects(pending, /群成员/); await reached.promise;
  f.store.db.prepare("DELETE FROM group_members WHERE session_id='group1' AND user_id='employee'").run(); pause.resolve(); await rejected;
  f.store.db.prepare('INSERT INTO group_members VALUES (?,?,NULL,?)').run('group1', member.id, '2026-10-30T00:00:00Z');
  const next = deferred(); f.adapter.read = async (_a, _b, { signal }) => { next.resolve(); await delay(10000, null, { signal }); };
  const work = f.service.readMessage(f.account.id, { uid: 12 }, f.context), cancelled = assert.rejects(work, /取消或超时/); await next.promise;
  await f.service.saveAccount(f.account.id, { imap: { password: 'rotated-mail-password' } }, f.management); await cancelled;
});

test('mail operations bound concurrency, timeouts and close without leaving occupied slots', async t => {
  const f = await fixture(t, { operationTimeout: 40 });
  f.adapter.read = async (_a, _b, { signal }) => { await delay(10000, null, { signal }); };
  const waiting = Array.from({ length: 3 }, () => assert.rejects(f.service.readMessage(f.account.id, { uid: 12 }, f.context), /取消或超时/));
  await assert.rejects(f.service.readMessage(f.account.id, { uid: 12 }, f.context), /处理其他请求/);
  await Promise.all(waiting); assert.equal(f.service.operations.size, 0);
  const pending = assert.rejects(f.service.readMessage(f.account.id, { uid: 12 }, f.context), /取消或超时/); f.service.close(); await pending;
  await assert.rejects(f.service.readMessage(f.account.id, { uid: 12 }, f.context), /正在关闭/);
});

test('draft creation is idempotent, same-group only, plain text and rejects header/path injection', async t => {
  const f = await fixture(t), body = { ...content, clientRequestId: 'draft-request-1' };
  const draft = await f.service.prepareDraft(f.account.id, body, f.context);
  assert.equal((await f.service.prepareDraft(f.account.id, body, f.context)).id, draft.id);
  await assert.rejects(f.service.prepareDraft(f.account.id, { ...body, text: 'different' }, f.context), /其他邮件/);
  assert.equal(f.service.listDrafts({}, f.context).total, 1);
  assert.throws(() => f.service.getDraft(draft.id, { ...f.context, sessionId: 'group2' }), /不存在/);
  for (const bad of [{ ...content, subject: 'Hello\r\nBcc: x@example.test' }, { ...content, to: ['name <x@example.test>'] }, { ...content, headers: { Bcc: 'x@example.test' } }, { ...content, attachments: [{ path: 'C:/secret' }] }, { ...content, text: 'a'.repeat(120001) }, { ...content, inReplyTo: '<bad id>' }, { ...content, references: [''] }]) await assert.rejects(f.service.prepareDraft(f.account.id, bad, f.context), /无效|不支持|字符|完整邮箱/);
  assert.deepEqual(f.calls, []);
});

test('concurrent clicks and later retries send a draft only once and persist a reviewable result', async t => {
  const f = await fixture(t), pause = deferred(), reached = deferred(); let sends = 0;
  f.adapter.send = async (_config, _credentials, { draft, authorize }) => { authorize(); sends++; reached.resolve(); await pause.promise; return { messageId: '<sent@example.test>', accepted: draft.to, rejected: [] }; };
  const draft = await f.service.prepareDraft(f.account.id, content, f.context);
  const first = f.service.sendDraft(draft.id, { idempotencyKey: 'click-1' }, f.context); await reached.promise;
  const second = await f.service.sendDraft(draft.id, { idempotencyKey: 'click-2' }, f.context); assert.equal(second.status, 'sending');
  pause.resolve(); const result = await first;
  assert.equal(result.status, 'sent'); assert.equal(result.result.messageId, '<sent@example.test>'); assert.ok(result.sentAt);
  assert.equal(result.sentBy, member.id);
  assert.equal((await f.service.sendDraft(draft.id, { idempotencyKey: 'click-1' }, f.context)).status, 'sent'); assert.equal(sends, 1);
  assert.equal(f.service.listDrafts({ status: 'sent' }, f.context).total, 1);
  await assert.rejects(f.service.updateDraft(draft.id, content, f.context), /不能修改/);
  assert.doesNotMatch(JSON.stringify(f.events), /recipient@example|核对预约|offline-mail/);
});

test('sending requires current workspace mode and allowSend even for an existing draft', async t => {
  const f = await fixture(t), draft = await f.service.prepareDraft(f.account.id, content, f.context);
  await assert.rejects(f.service.sendDraft(draft.id, { idempotencyKey: 'read-only-attempt' }, { ...f.context, mode: 'read-only' }), /只读/);
  await f.service.saveAccount(f.account.id, { allowSend: false }, f.management);
  await assert.rejects(f.service.sendDraft(draft.id, { idempotencyKey: 'disabled-attempt' }, f.context), /尚未允许/);
  assert.equal(f.service.getDraft(draft.id, f.context).status, 'draft'); assert.ok(!f.calls.includes('send'));
});

test('Sent copy metadata stays JSON-safe, persists independently and never makes a sent draft sendable again', async t => {
  const f = await fixture(t); let sends = 0;
  for (const status of ['saved', 'already_present', 'unavailable', 'failed']) {
    f.adapter.send = async (_a, _b, { onAccepted }) => {
      sends++;
      const accepted = { messageId: '<sent-copy@example.test>', accepted: content.to, rejected: [], sentCopy: { status: 'failed' } };
      onAccepted(accepted);
      return { ...accepted, sentCopy: { status, folder: '已发送邮件', raw: Buffer.from(secret), credentials: { imapPassword: secret } } };
    };
    const draft = await f.service.prepareDraft(f.account.id, content, f.context);
    const result = await f.service.sendDraft(draft.id, { idempotencyKey: `copy-${status}` }, f.context);
    assert.equal(result.status, 'sent'); assert.deepEqual(result.result.sentCopy, { status, folder: '已发送邮件' });
    assert.doesNotMatch(JSON.stringify(result.result), /offline-mail|credentials|raw/);
    assert.equal((await f.service.sendDraft(draft.id, { idempotencyKey: `again-${status}` }, f.context)).status, 'sent');
  }
  assert.equal(sends, 4);
});

test('confirmed SMTP acceptance survives outer service timeout or cancellation during Sent copy and is never resent', async t => {
  for (const canceled of [false, true]) {
    const f = await fixture(t, { operationTimeout: 50 }), controller = new AbortController(); let sends = 0;
    f.adapter.send = async (_a, _b, { onAccepted, signal }) => {
      sends++;
      onAccepted({ messageId: '<accepted-before-copy@example.test>', accepted: content.to, rejected: [], sentCopy: { status: 'failed' } });
      if (canceled) controller.abort();
      await delay(10000, null, { signal });
    };
    const draft = await f.service.prepareDraft(f.account.id, content, f.context);
    const sending = f.service.sendDraft(draft.id, { idempotencyKey: `copy-interrupted-${canceled}` }, { ...f.context, signal: controller.signal });
    if (canceled) await assert.rejects(sending, error => error.name === 'AbortError');
    const result = canceled ? f.service.getDraft(draft.id, f.context) : await sending;
    assert.equal(result.status, 'sent'); assert.equal(result.result.sentCopy.status, 'failed'); assert.ok(result.sentAt);
    const retried = await f.service.sendDraft(draft.id, { idempotencyKey: `copy-retry-${canceled}` }, f.context);
    assert.equal(retried.status, 'sent'); assert.equal(sends, 1);
  }
});

test('uncertain SMTP failures are unknown and never automatically repeated; definitely-unsent failures stay failed', async t => {
  const f = await fixture(t); let sends = 0;
  f.adapter.send = async () => { sends++; throw new Error(`connection lost ${secret}`); };
  const draft = await f.service.prepareDraft(f.account.id, content, f.context), unknown = await f.service.sendDraft(draft.id, { idempotencyKey: 'unknown-1' }, f.context);
  assert.equal(unknown.status, 'unknown'); assert.match(unknown.result.message, /核对发件箱/); assert.doesNotMatch(JSON.stringify(unknown), /offline-mail/);
  await f.service.sendDraft(draft.id, { idempotencyKey: 'unknown-2' }, f.context); assert.equal(sends, 1);
  f.adapter.send = async () => { sends++; throw Object.assign(new Error('authentication failure'), { delivery: 'not_sent' }); };
  const other = await f.service.prepareDraft(f.account.id, { ...content, subject: '另一个请求' }, f.context);
  assert.equal((await f.service.sendDraft(other.id, { idempotencyKey: 'failed-1' }, f.context)).status, 'failed');
  await f.service.sendDraft(other.id, { idempotencyKey: 'failed-2' }, f.context); assert.equal(sends, 2);
});

test('timeouts and process restarts preserve unknown send outcomes instead of enabling a resend', async t => {
  const f = await fixture(t, { operationTimeout: 25 }), draft = await f.service.prepareDraft(f.account.id, content, f.context);
  let sends = 0; f.adapter.send = async (_a, _b, { signal }) => { sends++; await delay(10000, null, { signal }); };
  assert.equal((await f.service.sendDraft(draft.id, { idempotencyKey: 'timeout-1' }, f.context)).status, 'unknown');
  f.store.db.prepare("UPDATE email_drafts SET status='sending' WHERE id=?").run(draft.id); f.recreate();
  assert.equal(f.service.getDraft(draft.id, f.context).status, 'unknown');
  await f.service.sendDraft(draft.id, { idempotencyKey: 'after-restart' }, f.context); assert.equal(sends, 1);
});

test('reuse of a committed send token across drafts cannot deliver another message', async t => {
  const f = await fixture(t), a = await f.service.prepareDraft(f.account.id, content, f.context), b = await f.service.prepareDraft(f.account.id, { ...content, subject: '另一个邮件' }, f.context);
  await f.service.sendDraft(a.id, { idempotencyKey: 'one-token' }, f.context);
  await assert.rejects(f.service.sendDraft(b.id, { idempotencyKey: 'one-token' }, f.context), /另一封邮件/);
  assert.equal(f.calls.filter(value => value === 'send').length, 1); assert.equal(f.service.getDraft(b.id, f.context).status, 'draft');
});

test('revocation after confirmed SMTP acceptance preserves send history but hides it from the former member', async t => {
  const f = await fixture(t), draft = await f.service.prepareDraft(f.account.id, content, f.context);
  f.adapter.send = async () => { f.store.db.prepare("DELETE FROM group_members WHERE user_id='employee' AND session_id='group1'").run(); return { messageId: '<accepted@example.test>', accepted: content.to, rejected: [] }; };
  await assert.rejects(f.service.sendDraft(draft.id, { idempotencyKey: 'revoke-after-send' }, f.context), /群成员/);
  const recorded = f.store.db.prepare('SELECT status,result_json FROM email_drafts WHERE id=?').get(draft.id);
  assert.equal(recorded.status, 'sent'); assert.equal(JSON.parse(recorded.result_json).messageId, '<accepted@example.test>');
});

test('draft attachments are group-resolved twice, store no bytes or paths and enforce limits before SMTP', async t => {
  let resolutions = 0;
  const f = await fixture(t, { resolveAttachments: async ({ sessionId, attachmentIds, authorize }) => { authorize(); assert.equal(sessionId, 'group1'); assert.deepEqual(attachmentIds, ['file-1']); resolutions++; return [{ name: '报价.csv', mimeType: 'text/csv', content: Buffer.from('a,b\n1,2'), path: 'never-expose' }]; } });
  const draft = await f.service.prepareDraft(f.account.id, { ...content, attachmentIds: ['file-1'] }, f.context);
  assert.equal(resolutions, 1); assert.deepEqual(draft.attachmentIds, ['file-1']); assert.doesNotMatch(JSON.stringify(draft), /never-expose|a,b/);
  f.adapter.send = async (_a, _b, { draft: submitted }) => { assert.equal(submitted.attachmentIds, undefined); assert.equal(submitted.attachments[0].content.toString(), 'a,b\n1,2'); assert.equal(submitted.attachments[0].path, undefined); return { accepted: content.to, rejected: [] }; };
  assert.equal((await f.service.sendDraft(draft.id, { idempotencyKey: 'attachment-send' }, f.context)).status, 'sent'); assert.equal(resolutions, 2);
  f.service.resolveAttachments = async () => [{ name: 'large.bin', content: Buffer.alloc(20 * 1024 * 1024 + 1) }];
  await assert.rejects(f.service.prepareDraft(f.account.id, { ...content, attachmentIds: ['file-1'] }, f.context), /20 MiB/);
  f.service.resolveAttachments = undefined;
  await assert.rejects(f.service.prepareDraft(f.account.id, { ...content, attachmentIds: ['file-1'] }, f.context), /尚未配置/);
});

test('attachment permission revocation or draft edits while loading prevent network submission', async t => {
  const f = await fixture(t, { resolveAttachments: async () => [{ name: 'data.txt', content: Buffer.from('fixture') }] });
  const draft = await f.service.prepareDraft(f.account.id, { ...content, attachmentIds: ['file-1'] }, f.context), pause = deferred(), reached = deferred();
  f.service.resolveAttachments = async () => { reached.resolve(); await pause.promise; return [{ name: 'data.txt', content: Buffer.from('fixture') }]; };
  const pending = f.service.sendDraft(draft.id, { idempotencyKey: 'changed-draft' }, f.context), rejected = assert.rejects(pending, /草稿已更新/); await reached.promise;
  f.store.db.prepare('UPDATE email_drafts SET content_json=? WHERE id=?').run(JSON.stringify({ ...content, cc: [], bcc: [], attachmentIds: ['file-1'], text: 'changed after click' }), draft.id); pause.resolve(); await rejected;
  assert.ok(!f.calls.includes('send')); assert.equal(f.service.getDraft(draft.id, f.context).status, 'draft');
});

test('revoking mailbox send permission while loading attachments leaves the draft unsent', async t => {
  const f = await fixture(t, { resolveAttachments: async () => [{ name: 'data.txt', content: Buffer.from('fixture') }] });
  const draft = await f.service.prepareDraft(f.account.id, { ...content, attachmentIds: ['file-1'] }, f.context), pause = deferred(), reached = deferred();
  f.service.resolveAttachments = async () => { reached.resolve(); await pause.promise; return [{ name: 'data.txt', content: Buffer.from('fixture') }]; };
  const pending = f.service.sendDraft(draft.id, { idempotencyKey: 'revoked-with-attachment' }, f.context), rejected = assert.rejects(pending, /尚未允许/); await reached.promise;
  await f.service.saveAccount(f.account.id, { allowSend: false }, f.management); pause.resolve(); await rejected;
  assert.ok(!f.calls.includes('send')); assert.equal(f.service.getDraft(draft.id, f.context).status, 'draft');
});

test('deleted accounts cancel access, erase encrypted secrets and preserve historical draft rows', async t => {
  const f = await fixture(t), draft = await f.service.prepareDraft(f.account.id, content, f.context);
  assert.throws(() => f.service.deleteAccount(f.account.id, { actor: member }), /管理员/);
  assert.equal(f.service.deleteAccount(f.account.id, f.management).ok, true);
  assert.equal(f.service.listAccounts(f.management).length, 0); assert.equal(f.service.row(f.account.id, true).credentials_ciphertext, null);
  assert.throws(() => f.service.getDraft(draft.id, f.context), /不存在/); assert.equal(f.service.listDrafts({}, f.context).total, 0);
  assert.ok(f.store.db.prepare('SELECT id FROM email_drafts WHERE id=?').get(draft.id));
});
