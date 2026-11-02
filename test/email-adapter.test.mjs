import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createServer } from 'node:net';
import nodemailer from 'nodemailer';
import { createEmailAdapter, EMAIL_LIMITS, EmailAdapterError } from '../lib/email-adapter.mjs';

const config = () => ({ name: '测试邮箱', email: 'team@example.com', fromName: '业务团队', enabled: true, allowSend: true,
  imap: { host: 'imap.example.com', port: 993, tls: 'implicit', username: 'imap-user' },
  smtp: { host: 'smtp.example.com', port: 587, tls: 'starttls', username: 'smtp-user' } });
const credentials = { imapPassword: 'imap-test-secret', smtpPassword: 'smtp-test-secret' };
const draft = () => ({ to: ['client@example.net'], subject: '预约更新', text: '请核对新的预约时间。' });
const textNode = { part: '1', type: 'text/plain', size: 20 };
const pdfNode = { part: '3', type: 'application/pdf', size: 100, disposition: 'attachment', dispositionParameters: { filename: '提单.pdf' } };
const message = (id = 10) => ({ uid: id, envelope: { subject: `预约 ${id}`, from: [{ name: '客户', address: 'client@example.net' }], to: [{ address: 'team@example.com' }],
  date: new Date('2026-10-30T01:00:00Z'), messageId: `<message-${id}@example.net>` }, flags: new Set(), size: 1000,
  bodyStructure: { type: 'multipart/mixed', childNodes: [textNode, { part: '2', type: 'text/html', size: 25 }, pdfNode] } });

function fixture(overrides = {}) {
  const state = { calls: [], imapOptions: [], smtpOptions: [], sent: [], messages: [message(10), message(9), message(8)], parts: { 1: Buffer.from('预约编号：A-100\n日期：明天'), 2: Buffer.from('<p>HTML</p>'), 3: Buffer.from('%PDF-fixture') },
    uidValidity: 123n, uidNext: 11, closed: 0, allowed: true, ...overrides };
  class MockImap extends EventEmitter {
    constructor(options) { super(); this.options = options; state.imapOptions.push(options); this.secureConnection = true; this.authenticated = true; }
    async connect() { state.calls.push(['connect']); if (state.connect) return state.connect(this); }
    close() { state.closed++; }
    async getMailboxLock(folder, options) { state.calls.push(['lock', folder, options]); this.mailbox = { uidValidity: state.uidValidity, uidNext: state.uidNext }; return { release() { state.calls.push(['release']); } }; }
    async list(options) { state.calls.push(['list', options]); return [{ path: 'INBOX', name: '收件箱', delimiter: '/', flags: new Set(), status: { uidValidity: 123n, messages: 3, unseen: 3 } }]; }
    async search(query, options) { state.calls.push(['search', query, options]); if (state.search) return state.search(query); const upper = Number(query.uid.split(':')[1]); return state.messages.filter(value => value.uid <= upper).map(value => value.uid); }
    async fetchAll(ids, query, options) { state.calls.push(['fetchAll', ids, query, options]); return state.messages.filter(value => ids.includes(value.uid)); }
    async fetchOne(id, query, options) { state.calls.push(['fetchOne', id, query, options]); state.onFetch?.(); return state.messages.find(value => value.uid === id); }
    async download(id, part, options) { state.calls.push(['download', id, part, options]); return { meta: { contentType: part === '3' ? 'application/pdf' : 'text/plain' }, content: Readable.from([state.parts[part] || Buffer.alloc(0)]) }; }
  }
  const createTransport = options => {
    state.smtpOptions.push(options);
    return { async verify() { state.calls.push(['verify']); return state.verify ? state.verify(options) : true; },
      async sendMail(value) { state.sent.push(value); return state.send ? state.send(value, options) : { accepted: ['client@example.net'], rejected: [], messageId: '<out@example.com>', response: 'secret and body must not be returned' }; },
      close() { state.calls.push(['smtpClose']); } };
  };
  const adapter = createEmailAdapter({ deps: { ImapFlow: MockImap, createTransport, ...overrides.deps } });
  return { state, adapter, MockImap };
}
const rejectCode = (promise, code, delivery) => assert.rejects(promise, error => {
  assert.equal(error.code, code); if (delivery) assert.equal(error.delivery, delivery);
  assert.ok(!JSON.stringify({ message: error.message }).includes('test-secret')); return true;
});

test('connection check verifies both protocols without sending and enforces certificate verification', async () => {
  const { state, adapter } = fixture();
  const result = await adapter.check(config(), credentials);
  assert.equal(result.imapReady, true); assert.equal(result.smtpReady, true); assert.equal(state.sent.length, 0);
  const imap = state.imapOptions[0], smtp = state.smtpOptions[0];
  assert.deepEqual(imap.auth, { user: 'imap-user', pass: credentials.imapPassword }); assert.equal(imap.secure, true);
  assert.equal(imap.tls.rejectUnauthorized, true); assert.equal(imap.logger, false); assert.equal(imap.logRaw, false);
  assert.deepEqual(smtp.auth, { user: 'smtp-user', pass: credentials.smtpPassword }); assert.equal(smtp.requireTLS, true); assert.equal(smtp.secure, false);
  assert.equal(smtp.tls.rejectUnauthorized, true); assert.equal(smtp.debug, false); assert.equal(smtp.disableFileAccess, true); assert.equal(smtp.disableUrlAccess, true);
});

test('receive-only account can check, search and read; send is definitely not submitted', async () => {
  const { state, adapter } = fixture(), account = { ...config(), smtp: null };
  assert.deepEqual((await adapter.check(account, { imapPassword: credentials.imapPassword })).smtpReady, false);
  assert.equal((await adapter.search(account, credentials)).messages.length, 3);
  assert.match((await adapter.read(account, credentials, { uid: '10', uidValidity: '123' })).text, /预约编号/);
  await rejectCode(adapter.send(account, credentials, { draft: draft() }), 'not_configured', 'not_sent');
  assert.equal(state.smtpOptions.length, 0); assert.equal(state.sent.length, 0);
});

test('admin custom TLS ports are allowed while plaintext, malformed hosts and wrong standard-port encryption are rejected', async () => {
  const { state, adapter } = fixture(), account = config();
  account.imap.port = 1993; account.smtp.port = 1587;
  await adapter.check(account, credentials); assert.equal(state.imapOptions[0].port, 1993); assert.equal(state.smtpOptions[0].port, 1587);
  for (const modify of [value => { value.imap.tls = 'none'; }, value => { value.smtp.port = 465; }, value => { value.imap.host = 'https://imap.example.com'; }, value => { value.smtp.host = 'smtp.example.com\r\nAUTH'; }]) {
    const invalid = config(); modify(invalid); await rejectCode(adapter.check(invalid, credentials), 'invalid_arguments');
  }
  assert.equal(state.imapOptions.length, 1);
});

test('folders are read-only metadata and never fetch mailbox bodies or change flags', async () => {
  const { adapter, state } = fixture(); const result = await adapter.folders(config(), credentials);
  assert.equal(result.folders[0].uidValidity, '123'); assert.equal(result.folders[0].selectable, true); assert.equal(result.truncated, false);
  assert.deepEqual(state.calls.map(value => value[0]), ['connect', 'list']);
});

test('search paginates descending UID against a stable snapshot and rejects changed query or UIDVALIDITY', async () => {
  const { adapter, state } = fixture();
  const first = await adapter.search(config(), credentials, { query: { subject: '预约', unseen: true, since: '2026-10-01' }, limit: 2 });
  assert.deepEqual(first.messages.map(value => value.uid), [10, 9]); assert.ok(first.nextCursor);
  state.messages.unshift(message(11)); state.uidNext = 12;
  const second = await adapter.search(config(), credentials, { query: { subject: '预约', unseen: true, since: '2026-10-01' }, limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.messages.map(value => value.uid), [8]); assert.equal(second.nextCursor, null);
  assert.equal(state.calls.find(value => value[0] === 'search')[1].seen, false);
  assert.ok(state.calls.filter(value => value[0] === 'lock').every(value => value[2].readOnly === true));
  await rejectCode(adapter.search(config(), credentials, { query: { subject: '其他' }, cursor: first.nextCursor }), 'invalid_arguments');
  state.uidValidity = 124n;
  await rejectCode(adapter.search(config(), credentials, { query: { subject: '预约', unseen: true, since: '2026-10-01' }, cursor: first.nextCursor }), 'stale_mailbox');
});

test('query validates dates and fields; overbroad matches fail instead of silently hiding results', async () => {
  const { adapter, state } = fixture({ search: () => Array.from({ length: 10_001 }, (_, index) => index + 1), uidNext: 20_000 });
  for (const query of [{ since: '2026-02-30' }, { gmraw: 'anything' }, { text: 'x\r\ny' }, { since: '2026-10-31', before: '2026-10-30' }]) await rejectCode(adapter.search(config(), credentials, { query }), 'invalid_arguments');
  assert.equal(state.calls.length, 0);
  await rejectCode(adapter.search(config(), credentials), 'output_limit');
});

test('UIDVALIDITY stays inside the IMAP unsigned 32-bit range accepted by message APIs', async () => {
  const allowed = fixture({ uidValidity: 4294967295n });
  assert.equal((await allowed.adapter.search(config(), credentials)).uidValidity, '4294967295');
  for (const value of [0n, -1n, 4294967296n, 12345678901234567890n]) {
    const invalid = fixture({ uidValidity: value });
    await rejectCode(invalid.adapter.search(config(), credentials), 'provider_error');
    assert.equal(invalid.state.calls.filter(row => row[0] === 'search').length, 0);
  }
});

test('read fetches only preferred text MIME part, keeps unseen and returns attachment metadata without bytes', async () => {
  const { adapter, state } = fixture(); const result = await adapter.read(config(), credentials, { uid: 10, uidValidity: '123' });
  assert.equal(result.seen, false); assert.match(result.text, /预约编号/); assert.equal(result.attachments[0].part, '3');
  assert.equal(result.attachments[0].sizeIsEncoded, true); assert.equal('content' in result.attachments[0], false); assert.equal('html' in result, false);
  assert.deepEqual(state.calls.filter(value => value[0] === 'download').map(value => value[2]), ['1']);
  assert.equal(state.calls.find(value => value[0] === 'fetchOne')[2].source, undefined);
  await rejectCode(adapter.read(config(), credentials, { uid: 10, uidValidity: '999' }), 'stale_mailbox');
  await rejectCode(adapter.read(config(), credentials, { uid: '10:20' }), 'invalid_arguments');
});

test('real MailParser converts HTML-only message to plain text and never returns executable HTML', async () => {
  const value = message(); value.bodyStructure = { part: '1', type: 'text/html', size: 200 };
  const { adapter } = fixture({ messages: [value], parts: { 1: Buffer.from('<html><body><script>alert(1)</script><p>提柜日期：10月31日</p><img src="https://example.net/tracker"></body></html>') } });
  const result = await adapter.read(config(), credentials, { uid: 10 });
  assert.match(result.text, /提柜日期/); assert.doesNotMatch(result.text, /<script|<img|alert\(1\)/); assert.equal('html' in result, false); assert.match(result.warnings.join(''), /纯文本/);
});

test('large message body is bounded with explicit truncation while attachments remain untouched', async () => {
  const large = Buffer.alloc(EMAIL_LIMITS.bodyBytes + 1, 'a');
  const { adapter, state } = fixture({ parts: { 1: large } });
  const result = await adapter.read(config(), credentials, { uid: 10 });
  assert.equal(result.text.length, EMAIL_LIMITS.bodyCharacters); assert.equal(result.truncated, true); assert.match(result.warnings.join(''), /截断/);
  assert.equal(state.calls.filter(value => value[0] === 'download').length, 1);
});

test('attachment downloads require actual MIME attachment part and enforce decoded-byte hard limit', async () => {
  const { adapter, state } = fixture();
  await rejectCode(adapter.downloadAttachment(config(), credentials, { uid: 10, part: '1' }), 'not_found');
  assert.equal(state.calls.filter(value => value[0] === 'download').length, 0);
  const result = await adapter.downloadAttachment(config(), credentials, { uid: '10', uidValidity: '123', part: '3' });
  assert.equal(result.content.toString(), '%PDF-fixture'); assert.equal(result.size, result.content.length); assert.equal(result.sizeIsEncoded, false);
  state.parts[3] = Buffer.alloc(EMAIL_LIMITS.attachmentBytes + 1);
  await rejectCode(adapter.downloadAttachment(config(), credentials, { uid: 10, part: '3' }), 'output_limit');
});

test('permission is checked before connecting and again before body download, without leaking provider errors', async () => {
  const { adapter, state } = fixture();
  await rejectCode(adapter.search(config(), credentials, { authorize: () => false }), 'permission_denied'); assert.equal(state.calls.length, 0);
  state.onFetch = () => { state.allowed = false; };
  await rejectCode(adapter.read(config(), credentials, { uid: 10, authorize: () => state.allowed }), 'permission_denied');
  assert.equal(state.calls.filter(value => value[0] === 'download').length, 0);
  const bad = fixture({ connect: () => { throw Object.assign(new Error(credentials.imapPassword), { authenticationFailed: true }); } });
  await rejectCode(bad.adapter.check(config(), credentials), 'credentials_required');
});

test('abort and whole-operation timeout close IMAP instead of leaving a hanging connection', async () => {
  const controller = new AbortController(), never = () => new Promise(() => {});
  const first = fixture({ connect: never });
  const pending = first.adapter.search(config(), credentials, { signal: controller.signal });
  setImmediate(() => controller.abort());
  await assert.rejects(pending, error => error.name === 'AbortError'); assert.ok(first.state.closed > 0);
  const second = fixture({ connect: never, deps: { timeoutMs: 25 } });
  await rejectCode(second.adapter.search(config(), credentials), 'timeout'); assert.ok(second.state.closed > 0);
});

test('sending uses fixed sender and trusted bytes, disables filesystem/URL access and omits SMTP response', async () => {
  const { adapter, state } = fixture(); const input = { ...draft(), attachments: [{ name: 'booking.csv', mimeType: 'text/csv', content: Buffer.from('id,status\n1,ok') }] };
  const result = await adapter.send(config(), credentials, { draft: input });
  assert.deepEqual(state.sent[0].from, { address: 'team@example.com', name: '业务团队' }); assert.equal(state.sent[0].attachments[0].content.toString(), 'id,status\n1,ok');
  assert.equal(state.sent[0].disableFileAccess, true); assert.equal(state.sent[0].disableUrlAccess, true);
  assert.equal(result.status, 'accepted'); assert.equal(result.messageId, '<out@example.com>'); assert.equal('response' in result, false); assert.equal('text' in result, false);
});

test('invalid draft, disabled sending and path/URL/header overrides never submit SMTP', async () => {
  const { adapter, state } = fixture();
  for (const input of [{ ...draft(), from: 'other@example.net' }, { ...draft(), subject: 'A\r\nBcc: stolen@example.net' }, { ...draft(), to: ['client@example.net\r\nX'] },
    { ...draft(), text: { path: 'D:/private.txt' } }, { ...draft(), attachments: [{ name: 'x', path: 'D:/private.txt' }] }, { ...draft(), attachments: [{ name: 'x', content: 'https://example.net/file' }] }]) {
    await rejectCode(adapter.send(config(), credentials, { draft: input }), 'invalid_arguments', 'not_sent');
  }
  await rejectCode(adapter.send({ ...config(), allowSend: false }, credentials, { draft: draft() }), 'permission_denied', 'not_sent');
  assert.equal(state.sent.length, 0); assert.equal(state.smtpOptions.length, 0);
});

test('SMTP partial acceptance is explicit; known pre-submit failures are not_sent and ambiguous failure is send_unknown', async () => {
  const partial = fixture({ send: () => ({ accepted: ['client@example.net'], rejected: ['other@example.net'], messageId: '<partial@example.com>' }) });
  assert.equal((await partial.adapter.send(config(), credentials, { draft: draft() })).status, 'partially_accepted');
  for (const code of ['EAUTH', 'EENVELOPE', 'ETLS', 'EDNS']) {
    const failed = fixture({ send: () => { throw Object.assign(new Error(credentials.smtpPassword), { code }); } });
    await assert.rejects(failed.adapter.send(config(), credentials, { draft: draft() }), error => { assert.equal(error.delivery, 'not_sent'); assert.notEqual(error.code, 'send_unknown'); return true; });
  }
  const unknown = fixture({ send: () => { throw Object.assign(new Error('disconnected after DATA'), { code: 'ECONNECTION' }); } });
  await rejectCode(unknown.adapter.send(config(), credentials, { draft: draft() }), 'send_unknown');
  const rejected = fixture({ send: () => ({ accepted: [], rejected: ['client@example.net'] }) });
  await rejectCode(rejected.adapter.send(config(), credentials, { draft: draft() }), 'send_rejected', 'not_sent');
});

async function localSmtp(handler, run) {
  const sockets = new Set(), server = createServer(socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); handler(socket); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { return await run(server.address().port); }
  finally { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); }
}

test('real Nodemailer rejects local SMTP without STARTTLS before any AUTH or MAIL command', async () => {
  const commands = [];
  await localSmtp(socket => {
    socket.write('220 local-fixture ESMTP\r\n');
    socket.on('data', bytes => { const text = bytes.toString(); commands.push(text); if (/EHLO/.test(text)) socket.write('250-local-fixture\r\n250 AUTH PLAIN LOGIN\r\n'); else if (/STARTTLS/.test(text)) socket.write('502 TLS unavailable\r\n'); });
  }, async port => {
    const { MockImap } = fixture(), adapter = createEmailAdapter({ deps: { ImapFlow: MockImap, createTransport: nodemailer.createTransport, timeoutMs: 2000 } });
    const account = config(); account.smtp = { host: '127.0.0.1', port, tls: 'starttls', username: 'dummy' };
    await assert.rejects(adapter.check(account, credentials), error => error instanceof EmailAdapterError);
  });
  assert.match(commands.join(''), /STARTTLS/); assert.doesNotMatch(commands.join(''), /(?:^|\r\n)(?:AUTH|MAIL FROM|RCPT TO|DATA)\s/i);
});

test('real pending SMTP socket is destroyed on cancellation, with no optimistic sent status', async () => {
  let connected, ended;
  const didConnect = new Promise(resolve => { connected = resolve; }), didEnd = new Promise(resolve => { ended = resolve; });
  await localSmtp(socket => { socket.once('close', ended); connected(); }, async port => {
    const { MockImap } = fixture(), controller = new AbortController(), adapter = createEmailAdapter({ deps: { ImapFlow: MockImap, createTransport: nodemailer.createTransport, timeoutMs: 2000 } });
    const account = config(); account.smtp = { host: '127.0.0.1', port, tls: 'starttls', username: 'dummy' };
    const pending = adapter.send(account, credentials, { draft: draft(), signal: controller.signal });
    await didConnect; controller.abort(); await rejectCode(pending, 'send_unknown');
    await Promise.race([didEnd, new Promise((_, reject) => setTimeout(() => reject(new Error('socket did not close')), 500))]);
  });
});

test('cancellation also destroys the original socket after Nodemailer wraps it for STARTTLS', async () => {
  let handshake, ended;
  const didHandshake = new Promise(resolve => { handshake = resolve; }), didEnd = new Promise(resolve => { ended = resolve; });
  await localSmtp(socket => {
    let upgraded = false; socket.write('220 local-fixture ESMTP\r\n'); socket.once('close', ended);
    socket.on('data', bytes => {
      if (upgraded) { handshake(); return; }
      if (/EHLO/.test(bytes.toString())) socket.write('250-local-fixture\r\n250 STARTTLS\r\n');
      else if (/STARTTLS/.test(bytes.toString())) { upgraded = true; socket.write('220 Begin TLS\r\n'); }
    });
  }, async port => {
    const { MockImap } = fixture(), controller = new AbortController(), adapter = createEmailAdapter({ deps: { ImapFlow: MockImap, createTransport: nodemailer.createTransport, timeoutMs: 2000 } });
    const account = config(); account.smtp = { host: '127.0.0.1', port, tls: 'starttls', username: 'dummy' };
    const pending = adapter.send(account, credentials, { draft: draft(), signal: controller.signal });
    await didHandshake; controller.abort(); await rejectCode(pending, 'send_unknown');
    await Promise.race([didEnd, new Promise((_, reject) => setTimeout(() => reject(new Error('TLS socket did not close')), 500))]);
  });
});
