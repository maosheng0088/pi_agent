import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
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
    async list(options) { state.calls.push(['list', options]); return state.folders || [{ path: 'INBOX', name: '收件箱', delimiter: '/', flags: new Set(), status: { uidValidity: 123n, messages: 3, unseen: 3 } }]; }
    async search(query, options) { state.calls.push(['search', query, options]); if (state.search) return state.search(query); if (query.header) return state.existingSent || []; const [lower, upper] = query.uid.split(':').map(Number); return state.messages.filter(value => value.uid >= lower && value.uid <= upper).map(value => value.uid); }
    async append(folder, raw, flags) { state.calls.push(['append', folder, raw, flags]); return state.append ? state.append(folder, raw, flags) : { uid: 12 }; }
    async fetchAll(ids, query, options) { state.calls.push(['fetchAll', ids, query, options]); return state.messages.filter(value => ids.includes(value.uid)); }
    async *fetch(ids, query, options) {
      state.calls.push(['fetch', ids, query, options]);
      const rows = state.onFetchBatch ? await state.onFetchBatch(ids, query) : state.messages.filter(value => ids.includes(value.uid));
      yield* rows;
    }
    async fetchOne(id, query, options) { state.calls.push(['fetchOne', id, query, options]); await state.onFetch?.(id); return state.messages.find(value => value.uid === id); }
    async download(id, part, options) { state.calls.push(['download', id, part, options]); await state.onDownload?.(id, part); return { meta: { contentType: part === '3' ? 'application/pdf' : 'text/plain' }, content: state.downloadStream || Readable.from([state.parts[part] || Buffer.alloc(0)]) }; }
  }
  const createTransport = options => {
    state.smtpOptions.push(options);
    return { async verify() { state.calls.push(['verify']); return state.verify ? state.verify(options) : true; },
      async sendMail(value) { state.calls.push(['send']); state.sent.push(value); return state.send ? state.send(value, options) : { accepted: ['client@example.net'], rejected: [], messageId: value.messageId, response: 'secret and body must not be returned' }; },
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

test('sync lists a message above the MIME complexity limit while reading it stays bounded', async () => {
  const oversized = message(10);
  oversized.bodyStructure = {
    type: 'multipart/mixed',
    childNodes: [textNode, ...Array.from({ length: EMAIL_LIMITS.mimeParts }, (_, index) => ({
      ...pdfNode, part: String(index + 2)
    }))]
  };
  const ordinary = { ...message(9), bodyStructure: textNode };
  const { adapter, state } = fixture({ messages: [oversized, ordinary] });

  const page = await adapter.search(config(), credentials, { syncUidRange: { afterUid: 0 } });
  assert.deepEqual(page.messages.map(({ uid, hasAttachments }) => ({ uid, hasAttachments })), [
    { uid: 10, hasAttachments: true },
    { uid: 9, hasAttachments: false }
  ]);
  assert.equal(page.nextCursor, null);
  await assert.rejects(adapter.read(config(), credentials, { uid: 10 }), { code: 'output_limit', status: 413 });
  assert.equal(state.calls.some(([method]) => method === 'download'), false);
});

test('inbound messages with more than twenty attachments keep their body and every valid attachment part', async () => {
  const value = message(10);
  const count = EMAIL_LIMITS.attachmentCount + 1;
  const lastPart = String(count + 1);
  value.bodyStructure = {
    type: 'multipart/mixed',
    childNodes: [textNode, ...Array.from({ length: count }, (_, index) => ({ ...pdfNode, part: String(index + 2) }))]
  };
  const { adapter } = fixture({ messages: [value], parts: { 1: Buffer.from('body'), [lastPart]: Buffer.from('last file') } });

  const result = await adapter.read(config(), credentials, { uid: 10 });
  assert.equal(result.text, 'body');
  assert.equal(result.attachments.length, count);
  assert.equal(result.attachments.at(-1).part, lastPart);
  const attachment = await adapter.downloadAttachment(config(), credentials, { uid: 10, part: lastPart });
  assert.equal(attachment.content.toString(), 'last file');
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

test('batch body reads reuse one read-only folder lock and report each attempted UID', async () => {
  const { adapter, state } = fixture({ messages: [message(10), message(8)] });
  const results = new Map();
  await adapter.readBatch(config(), credentials, {
    folder: 'INBOX', uidValidity: '123', uids: ['10', '9', '7', '8'], deadline: Date.now() + 1000,
    onStart: key => { state.calls.push(['start', key]); return key !== '7'; },
    onResult: (key, result) => { state.calls.push(['result', key]); results.set(key, result); }
  });
  assert.equal(state.calls.filter(([method]) => method === 'connect').length, 1);
  assert.deepEqual(state.calls.filter(([method]) => method === 'lock'), [['lock', 'INBOX', { readOnly: true, acquireTimeout: 5000 }]]);
  assert.deepEqual(state.calls.filter(([method]) => ['start', 'fetchOne', 'download', 'result'].includes(method)).map(([method, key]) => [method, String(key)]),
    [['start', '10'], ['download', '10'], ['result', '10'], ['start', '9'], ['fetchOne', '9'], ['result', '9'], ['start', '7'], ['start', '8'], ['download', '8'], ['result', '8']]);
  assert.equal(results.get('10').body.uid, 10);
  assert.match(results.get('10').body.text, /预约编号/);
  assert.equal(results.get('9').error.code, 'not_found');
  assert.equal(results.get('8').body.uidValidity, '123');
});

test('archive groups bounded BODY.PEEK text sections and falls back for untrustworthy responses and charsets', async () => {
  const sources = new Map([
    [10, Buffer.from('Caf=C3=A9=\r\n test\r\nnext')], [9, Buffer.from(Buffer.from('中文正文').toString('base64'))],
    [8, Buffer.from('declined')], [7, Buffer.from('wrong origin')], [6, Buffer.from('legacy charset')],
    [5, Buffer.from('large body')], [4, Buffer.from([0xff])], [3, Buffer.from('<p>有效 HTML 正文</p>')]
  ]);
  const values = [...sources].map(([id, bytes]) => {
    const node = { ...textNode, size: id === 5 ? 70_000 : bytes.length,
      encoding: id === 10 ? 'quoted-printable' : id === 9 ? 'base64' : '8bit', parameters: { charset: id === 6 ? 'gbk' : 'UTF-8' } };
    return { ...message(id), bodyStructure: id === 3
      ? { type: 'multipart/mixed', childNodes: [{ ...node, type: 'text/html' }, pdfNode] }
      : node };
  });
  const { adapter, state } = fixture({ messages: values,
    onFetchBatch(ids, query) {
      if (!query.bodyParts) return [...values, { uid: 10, flags: new Set(['\\Seen']) }];
      const [{ key }] = query.bodyParts;
      return [...ids].reverse().map(uid => ({ uid, bodyParts: new Map([[key, sources.get(uid)]]),
        partialOrigins: new Map([[key, uid === 7 ? 3 : 0]]) }));
    }
  });
  const results = new Map(), started = [];
  await adapter.readBatch(config(), credentials, {
    uidValidity: '123', uids: values.map(value => String(value.uid)), deadline: Date.now() + 1000,
    onStart: uid => { started.push(uid); return uid !== '8'; },
    onResult: (uid, result) => results.set(uid, result.body)
  });
  const queries = state.calls.filter(([method]) => method === 'fetch');
  assert.equal(queries.length, 3);
  assert.deepEqual(queries[0].slice(1), [values.map(value => value.uid),
    { uid: true, envelope: true, flags: true, bodyStructure: true, internalDate: true, size: true }, { uid: true }]);
  assert.deepEqual(queries[1].slice(1), [[10, 9, 7, 4],
    { uid: true, bodyParts: [{ key: 'text', start: 0, maxLength: sources.get(10).length + 1 }] }, { uid: true }]);
  assert.deepEqual(queries[2].slice(1), [[3],
    { uid: true, bodyParts: [{ key: '1', start: 0, maxLength: sources.get(3).length + 1 }] }, { uid: true }]);
  assert.ok(started.includes('8'));
  assert.equal(results.has('8'), false);
  assert.equal(results.get('10').text, 'Café test\r\nnext');
  assert.equal(results.get('10').seen, false);
  assert.equal(results.get('9').text, '中文正文');
  assert.match(results.get('3').text, /有效 HTML 正文/);
  assert.equal(results.get('3').attachments[0].part, '3');
  assert.deepEqual(state.calls.filter(([method]) => method === 'download').map(call => call[1]), [7, 4, 6, 5]);
  assert.equal(state.calls.some(([method]) => method === 'fetchOne'), false);
});

test('archive accepts forty UIDs while each metadata FETCH stays within eight', async () => {
  const values = Array.from({ length: 40 }, (_, index) => ({ ...message(index + 1), bodyStructure: pdfNode }));
  const { adapter, state } = fixture({ messages: values });
  const received = [];
  await adapter.readBatch(config(), credentials, {
    uidValidity: '123', uids: values.map(value => String(value.uid)), deadline: Date.now() + 1000,
    onStart() {}, onResult: (uid, result) => received.push([uid, result.body.attachments.length])
  });
  assert.deepEqual(state.calls.filter(([method]) => method === 'fetch').map(([, ids]) => ids.length), [8, 8, 8, 8, 8]);
  assert.deepEqual(received, values.map(value => [String(value.uid), 1]));
  assert.equal(state.calls.some(([method]) => method === 'download'), false);
});

test('batch start cutoff lets a launched body finish and skips later UIDs', async t => {
  let now = Date.now();
  const deadline = now + 1000;
  t.mock.method(Date, 'now', () => now);
  const { adapter, state } = fixture({
    async onDownload(key) { if (key === 9) await delay(10); }
  });
  const started = [], results = [];
  await adapter.readBatch(config(), credentials, {
    uidValidity: '123', uids: ['10', '9', '8'], deadline, bodyTimeoutMs: 100,
    onStart: key => started.push(key),
    onResult: (key, result) => {
      assert.ok(result.body);
      results.push(key);
      now = deadline + (key === '10' ? -1 : 1);
    }
  });
  assert.deepEqual(started, ['10', '9']);
  assert.deepEqual(results, started);
  assert.deepEqual(state.calls.filter(([method]) => method === 'download').map(call => call[1]), [10, 9]);
});

test('batch item timeout closes its IMAP connection and leaves later UIDs unstarted', async () => {
  let release;
  const pendingFetch = new Promise(resolve => { release = resolve; });
  const { adapter, state } = fixture({ onDownload: () => pendingFetch });
  const started = [], results = [];
  await adapter.readBatch(config(), credentials, {
    uidValidity: '123', uids: ['10', '9'], deadline: Date.now() + 1000, bodyTimeoutMs: 10,
    onStart: key => started.push(key),
    onResult: (key, result) => results.push({ key, code: result.error?.code, status: result.error?.status })
  });
  release();
  await delay(0);
  assert.deepEqual(started, ['10']);
  assert.deepEqual(results, [{ key: '10', code: 'timeout', status: 504 }]);
  assert.ok(state.closed > 0);
  assert.deepEqual(state.calls.filter(([method]) => method === 'download').map(call => call[1]), [10]);
});

test('batch provider setup, stale UIDVALIDITY and caller cancellation propagate without false item errors', async () => {
  const started = [], results = [];
  const options = {
    uidValidity: '123', uids: ['10', '9'], deadline: Date.now() + 1000,
    onStart: key => started.push(key),
    onResult: (key, result) => results.push({ key, result })
  };
  const unavailable = fixture({ connect: () => { throw new Error(credentials.imapPassword); } });
  await rejectCode(unavailable.adapter.readBatch(config(), credentials, options), 'provider_error');
  const stale = fixture({ uidValidity: 124n });
  await rejectCode(stale.adapter.readBatch(config(), credentials, options), 'stale_mailbox');
  assert.deepEqual(started, []);

  const denied = fixture({ onDownload: () => { denied.state.allowed = false; } });
  await rejectCode(denied.adapter.readBatch(config(), credentials, { ...options, authorize: () => denied.state.allowed }), 'permission_denied');
  const controller = new AbortController();
  const cancelled = fixture({ onDownload: () => controller.abort() });
  await assert.rejects(cancelled.adapter.readBatch(config(), credentials, { ...options, signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(started, ['10', '10']);
  assert.deepEqual(results, []);
});

test('real MailParser converts HTML-only message to plain text and never returns executable HTML', async () => {
  const value = message(); value.bodyStructure = { part: '1', type: 'text/html', size: 200 };
  const { adapter } = fixture({ messages: [value], parts: { 1: Buffer.from('<html><body><script>alert(1)</script><p>提柜日期：10月31日</p><img src="https://example.net/tracker"></body></html>') } });
  const result = await adapter.read(config(), credentials, { uid: 10 });
  assert.match(result.text, /提柜日期/); assert.doesNotMatch(result.text, /<script|<img|alert\(1\)/); assert.equal('html' in result, false); assert.match(result.warnings.join(''), /纯文本/);
});

test('rich reading selects HTML from multipart alternatives and downloads only referenced raster Content-IDs', async () => {
  const value = message();
  value.bodyStructure = { type: 'multipart/related', childNodes: [
    { part: '1', type: 'multipart/alternative', childNodes: [
      { part: '1.1', type: 'text/plain' }, { part: '1.2', type: 'text/html' }
    ] },
    { part: '2', type: 'image/png', id: '<Logo@Example.test>', disposition: 'inline' },
    { part: '3', type: 'image/png', id: '<Fake>' },
    { part: '4', type: 'image/svg+xml', id: '<Vector>' },
    { part: '5', type: 'image/jpeg', id: '<Unreferenced>' },
    { part: '6', type: 'image/gif', id: '<Oversized>' }
  ] };
  const html = [
    '<p>预约正文</p><IMG ALT="example src=cid:Unreferenced" SRC="CiD:Logo%40example.test">',
    '<img src=cid:logo@example.test><img src="cid:fake"><img src="cid:vector">',
    '<img src="cid:oversized"><img src="https://example.test/tracker.png">'
  ].join('');
  const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  const oversized = Buffer.alloc(1024 * 1024 + 1);
  oversized.write('GIF89a');
  const { adapter, state } = fixture({ messages: [value], parts: {
    '1.1': Buffer.from('纯文本版本'),
    '1.2': Buffer.from(html),
    2: png,
    3: Buffer.from('<svg onload="alert(1)"></svg>'),
    6: oversized
  } });

  const plain = await adapter.read(config(), credentials, { uid: 10, uidValidity: '123' });
  assert.equal(plain.text, '纯文本版本');
  const rich = await adapter.readRich(config(), credentials, { uid: 10, uidValidity: '123' });

  assert.equal(rich.html, html);
  assert.deepEqual(rich.images, [{ cid: 'logo@example.test', mimeType: 'image/png', data: png.toString('base64') }]);
  assert.equal(rich.truncated, true);
  const downloads = state.calls.filter(([method]) => method === 'download');
  assert.deepEqual(downloads.map(call => call[2]), ['1.1', '1.2', '2', '3', '6']);
  assert.equal(downloads[1][3].maxBytes, 512 * 1024 + 1);
  assert.equal(downloads[2][3].maxBytes, 1024 * 1024 + 1);
  assert.equal(state.calls.filter(([method]) => method === 'connect').length, 2);
  assert.ok(state.calls.filter(([method]) => method === 'lock').every(call => call[2].readOnly));
  await rejectCode(adapter.readRich(config(), credentials, { uid: 10, uidValidity: '999' }), 'stale_mailbox');
});

test('rich HTML and archived inline images can be loaded independently', async () => {
  const value = { ...message(), bodyStructure: { type: 'multipart/related', childNodes: [
    { part: '1', type: 'text/html' }, { part: '2', type: 'image/png', id: '<Logo>' },
    { part: '3', type: 'image/png', id: '<Unused>' }
  ] } };
  const html = '<p>正文</p><img src="cid:Logo"><img src="https://example.test/image.png">';
  const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  const { adapter, state } = fixture({ messages: [value], parts: { 1: Buffer.from(html), 2: png, 3: png } });
  const reference = { uid: 10, uidValidity: '123' };

  assert.deepEqual(await adapter.readRich(config(), credentials, { ...reference, includeImages: false }), { html, images: [] });
  assert.deepEqual(state.calls.filter(([method]) => method === 'download').map(call => call[2]), ['1']);
  state.calls.length = 0;
  assert.deepEqual(await adapter.readInlineImages(config(), credentials, { ...reference, html }), {
    images: [{ cid: 'logo', mimeType: 'image/png', data: png.toString('base64') }]
  });
  assert.deepEqual(state.calls.filter(([method]) => method === 'download').map(call => call[2]), ['2']);
  assert.deepEqual(state.calls.filter(([method]) => method === 'fetchOne').map(call => call[2]), [{ uid: true, bodyStructure: true }]);
  state.calls.length = 0;
  assert.deepEqual(await adapter.readInlineImages(config(), credentials, { ...reference, html: '<img src="https://example.test/only-remote.png">' }), { images: [] });
  assert.equal(state.calls.length, 0);
  await rejectCode(adapter.readInlineImages(config(), credentials, { ...reference, html, authorize: () => false }), 'permission_denied');
  await rejectCode(adapter.readInlineImages(config(), credentials, { ...reference, html: '表'.repeat(400_000) }), 'output_limit');
  await rejectCode(adapter.readInlineImages(config(), credentials, { ...reference, html, uidValidity: '999' }), 'stale_mailbox');
});

test('rich archive batch fetches one bounded BODYSTRUCTURE group and reads only opted-in HTML', async () => {
  const html = '<p>归档 HTML</p><img src="cid:logo">';
  const full = { ...message(10), bodyStructure: { type: 'multipart/related', childNodes: [
    { part: '1', type: 'multipart/alternative', childNodes: [{ part: '1.1', type: 'text/plain' }, { part: '1.2', type: 'text/html' }] },
    { part: '2', type: 'image/png', id: '<logo>' }
  ] } };
  const plain = { ...message(9), bodyStructure: textNode };
  const declined = message(8);
  const incomplete = { ...message(7), bodyStructure: { type: 'multipart/alternative' } };
  const large = { ...message(6), bodyStructure: { part: '1', type: 'text/html' } };
  const values = [full, plain, declined, incomplete, large];
  const { adapter, state } = fixture({ messages: values,
    parts: { '1.2': Buffer.from(html), 1: Buffer.alloc(512 * 1024 + 1, 'x') },
    onFetchBatch() { return [declined, full, incomplete, large, { uid: 9, flags: new Set() }]; }
  });
  const started = [], results = new Map();
  const uids = [...values.map(({ uid }) => String(uid)), '5'];
  const options = { folder: 'INBOX', uidValidity: '123', uids, deadline: Date.now() + 1000,
    onStart(uid) { started.push(uid); return uid !== '8'; },
    onResult(uid, result) { results.set(uid, result); }
  };
  await adapter.readRichBatch(config(), credentials, options);
  assert.deepEqual(started, uids);
  assert.deepEqual(results.get('10'), { body: { html } });
  assert.deepEqual(results.get('9'), { body: { html: '' } });
  assert.equal(results.has('8'), false);
  assert.equal(results.get('7').error.code, 'provider_error');
  assert.equal(results.get('6').body.html.length, 512 * 1024);
  assert.equal(results.get('6').body.truncated, true);
  assert.equal(results.get('5').error.code, 'not_found');
  assert.deepEqual(state.calls.filter(([method]) => method === 'connect'), [['connect']]);
  assert.deepEqual(state.calls.filter(([method]) => method === 'lock'), [['lock', 'INBOX', { readOnly: true, acquireTimeout: 5000 }]]);
  assert.deepEqual(state.calls.filter(([method]) => method === 'fetch'), [['fetch', [10, 9, 8, 7, 6, 5], { uid: true, bodyStructure: true }, { uid: true }]]);
  assert.deepEqual(state.calls.filter(([method]) => method === 'fetchOne').map(call => call[1]), [9, 7, 5]);
  assert.deepEqual(state.calls.filter(([method]) => method === 'download').map(([, uid, part]) => [uid, part]), [[10, '1.2'], [6, '1']]);
  await rejectCode(adapter.readRichBatch(config(), credentials, { ...options, uids: Array.from({ length: 9 }, (_, index) => String(index + 1)) }), 'invalid_arguments');
});

test('rich archive batches distinguish a started item timeout from permission changes and caller cancellation', async () => {
  const started = [], results = [];
  const options = { uidValidity: '123', uids: ['10', '9'], deadline: Date.now() + 1000,
    onStart(uid) { started.push(uid); }, onResult(uid, result) { results.push([uid, result.error?.code]); }
  };
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const slow = fixture({ onDownload: () => pending });
  await slow.adapter.readRichBatch(config(), credentials, { ...options, bodyTimeoutMs: 10 });
  release();
  assert.deepEqual(started, ['10']);
  assert.deepEqual(results, [['10', 'timeout']]);
  assert.ok(slow.state.closed > 0);

  started.length = 0;
  results.length = 0;
  const denied = fixture({ onDownload: () => { denied.state.allowed = false; } });
  await rejectCode(denied.adapter.readRichBatch(config(), credentials, { ...options, authorize: () => denied.state.allowed }), 'permission_denied');
  const controller = new AbortController();
  const cancelled = fixture({ onDownload: () => controller.abort() });
  await assert.rejects(cancelled.adapter.readRichBatch(config(), credentials, { ...options, signal: controller.signal }), { name: 'AbortError' });
  const stale = fixture({ uidValidity: 124n });
  await rejectCode(stale.adapter.readRichBatch(config(), credentials, options), 'stale_mailbox');
  assert.deepEqual(started, ['10', '10']);
  assert.deepEqual(results, []);
});

test('plain body opt-in captures previously read HTML or reads one bounded alternative without CID downloads', async () => {
  const html = '<p>归档 HTML</p><img src="cid:logo">';
  const htmlOnly = { ...message(10), internalDate: new Date('2026-10-31T01:00:00Z'), bodyStructure: { part: '1', type: 'text/html' } };
  const alternative = { ...message(9), bodyStructure: { type: 'multipart/related', childNodes: [
    { part: '1', type: 'multipart/alternative', childNodes: [{ part: '1.1', type: 'text/plain' }, { part: '1.2', type: 'text/html' }] },
    { part: '2', type: 'image/png', id: '<logo>' }
  ] } };
  const plain = { ...message(8), bodyStructure: { ...textNode, part: '1' } };
  const { adapter, state } = fixture({ messages: [htmlOnly, alternative, plain], parts: {
    1: Buffer.from(html), '1.1': Buffer.from('纯文本'), '1.2': Buffer.from(html)
  } });
  const single = await adapter.read(config(), credentials, { uid: 10, includeRichBody: true });
  assert.deepEqual(single.richBody, { html });
  assert.match(single.text, /归档 HTML/);
  assert.deepEqual(state.calls.filter(([method]) => method === 'download').map(call => call[2]), ['1']);
  state.calls.length = 0;

  const seen = [], results = new Map();
  await adapter.readBatch(config(), credentials, {
    uidValidity: '123', uids: ['10', '9', '8'], deadline: Date.now() + 1000,
    includeRichBody: message => { seen.push(message); return message.uid !== 10; },
    onStart() {}, onResult: (uid, result) => results.set(uid, result.body)
  });
  assert.deepEqual(seen.map(({ uid }) => uid), [10, 9, 8]);
  assert.ok(seen.every(({ date }) => date === '2026-10-30T01:00:00.000Z'));
  assert.deepEqual(seen.map(({ receivedAt }) => receivedAt), ['2026-10-31T01:00:00.000Z', null, null]);
  assert.equal(results.get('10').richBody, undefined);
  assert.equal(results.get('9').text, '纯文本');
  assert.deepEqual(results.get('9').richBody, { html });
  assert.deepEqual(results.get('8').richBody, { html: '' });
  assert.deepEqual(state.calls.filter(([method]) => method === 'download').map(call => call[2]), ['1', '1.1', '1.2', '1']);
  assert.equal(state.calls.find(([method, , part]) => method === 'download' && part === '1.2')[3].maxBytes, 512 * 1024 + 1);
});

test('optional archive HTML errors preserve plain mail while permission revocation stays fatal', async () => {
  const value = message();
  const recoverable = fixture({ messages: [value], onDownload(_uid, part) { if (part === '2') throw new Error('provider error'); } });
  const plain = await recoverable.adapter.read(config(), credentials, { uid: 10, includeRichBody: true });
  assert.match(plain.text, /预约编号/);
  assert.equal(plain.richBody, undefined);

  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const slow = fixture({ messages: [value], deps: { timeoutMs: 600 }, onDownload(_uid, part) { if (part === '2') return pending; } });
  const timed = await slow.adapter.read(config(), credentials, { uid: 10, includeRichBody: true });
  release();
  assert.match(timed.text, /预约编号/);
  assert.equal(timed.richBody, undefined);
  assert.equal(slow.state.calls.some(([method, , part]) => method === 'download' && part === '2'), true);

  const denied = fixture({ messages: [value], onDownload(_uid, part) { if (part === '2') denied.state.allowed = false; } });
  await rejectCode(denied.adapter.read(config(), credentials, { uid: 10, includeRichBody: true, authorize: () => denied.state.allowed }), 'permission_denied');
});

test('rich reuse saves only HTML already read and confirms plain-only messages without fetching an alternative', async () => {
  const html = '<p>已读取的 HTML</p>';
  const mixed = message(10);
  const htmlOnly = { ...message(9), bodyStructure: { type: 'multipart/related', childNodes: [
    { part: '1', type: 'image/png', id: '<logo>' }, { part: '2', type: 'text/html' }
  ] } };
  const plainOnly = { ...message(8), bodyStructure: textNode };
  const { adapter, state } = fixture({ messages: [mixed, htmlOnly, plainOnly], parts: { 1: Buffer.from('纯文本'), 2: Buffer.from(html) } });
  const direct = await adapter.read(config(), credentials, { uid: 10, includeRichBody: 'reuse' });
  assert.equal(direct.text, '纯文本');
  assert.equal(direct.richBody, undefined);

  const results = new Map();
  await adapter.readBatch(config(), credentials, {
    uidValidity: '123', uids: ['10', '9', '8'], deadline: Date.now() + 1000,
    includeRichBody: () => 'reuse', onStart() {}, onResult: (uid, result) => results.set(uid, result.body)
  });
  assert.equal(results.get('10').richBody, undefined);
  assert.deepEqual(results.get('9').richBody, { html });
  assert.deepEqual(results.get('8').richBody, { html: '' });
  assert.deepEqual(state.calls.filter(([method]) => method === 'download').map(([, uid, part]) => [uid, part]),
    [[10, '1'], [10, '1'], [9, '2'], [8, '1']]);
});

test('archive opt-in returns referenced CID originals in the same IMAP lock and marks missing images as partial', async () => {
  const html = '<p>邮件 HTML</p><img src="cid:Logo"><img src="cid:broken"><img src="cid:missing"><img src="cid:vector"><img src="https://example.test/tracker.png">';
  const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  const value = { ...message(10), bodyStructure: { type: 'multipart/related', childNodes: [
    { part: '1', type: 'multipart/alternative', childNodes: [{ part: '1.1', type: 'text/plain' }, { part: '1.2', type: 'text/html' }] },
    { part: '2', type: 'image/png', id: '<logo>' }, { part: '3', type: 'image/jpeg', id: '<broken>' },
    { part: '4', type: 'image/svg+xml', id: '<vector>' }, { part: '5', type: 'image/png', id: '<unreferenced>' }, pdfNode
  ] } };
  const { adapter, state } = fixture({ messages: [value], parts: {
    '1.1': Buffer.from('纯文本正文'), '1.2': Buffer.from(html), 2: png, 3: Buffer.from('invalid JPEG')
  } });
  const plain = await adapter.read(config(), credentials, { uid: 10, includeRichBody: true });
  assert.equal(plain.inlineImages, undefined);
  assert.deepEqual(state.calls.filter(([method]) => method === 'download').map(call => call[2]), ['1.1', '1.2']);
  state.calls.length = 0;
  const results = [];
  await adapter.readBatch(config(), credentials, {
    uidValidity: '123', uids: ['10'], deadline: Date.now() + 1000, includeRichBody: true,
    includeInlineImages: ({ uid }) => uid === 10, onStart() {}, onResult: (_uid, result) => results.push(result)
  });
  assert.equal(results[0].body.text, '纯文本正文');
  assert.deepEqual(results[0].body.richBody, { html });
  assert.deepEqual(results[0].body.inlineImages, { images: [{ cid: 'logo', mimeType: 'image/png', data: png.toString('base64') }], truncated: true });
  assert.deepEqual(state.calls.filter(([method]) => method === 'download').map(call => call[2]), ['1.1', '1.2', '2', '3']);
  assert.equal(state.calls.filter(([method]) => method === 'connect').length, 1);
  assert.equal(state.calls.filter(([method]) => method === 'lock').length, 1);

  const noCid = fixture({ messages: [{ ...message(10), bodyStructure: textNode }] });
  const empty = await noCid.adapter.read(config(), credentials, { uid: 10, includeRichBody: true, includeInlineImages: true });
  assert.deepEqual(empty.richBody, { html: '' });
  assert.deepEqual(empty.inlineImages, { images: [] });
  assert.deepEqual(noCid.state.calls.filter(([method]) => method === 'download').map(call => call[2]), ['1']);
});

test('optional CID image timeout keeps archived text, HTML, and earlier images while access loss remains fatal', async () => {
  const html = '<p>正文</p><img src="cid:logo"><img src="cid:later">';
  const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  const value = { ...message(10), bodyStructure: { type: 'multipart/related', childNodes: [
    { part: '1', type: 'text/html' }, { part: '2', type: 'image/png', id: '<logo>' }, { part: '3', type: 'image/png', id: '<later>' }
  ] } };
  const parts = { 1: Buffer.from(html), 2: png, 3: png };
  const options = { uid: 10, uidValidity: '123', includeRichBody: true, includeInlineImages: true };
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const slow = fixture({ messages: [value], parts, deps: { timeoutMs: 650 }, onDownload(_uid, part) { if (part === '3') return pending; } });
  const partial = await slow.adapter.read(config(), credentials, options);
  release();
  assert.match(partial.text, /正文/);
  assert.deepEqual(partial.richBody, { html });
  assert.deepEqual(partial.inlineImages, { images: [{ cid: 'logo', mimeType: 'image/png', data: png.toString('base64') }], truncated: true });

  const denied = fixture({ messages: [value], parts, onDownload(_uid, part) { if (part === '2') denied.state.allowed = false; } });
  await rejectCode(denied.adapter.read(config(), credentials, { ...options, authorize: () => denied.state.allowed }), 'permission_denied');
  const controller = new AbortController();
  const cancelled = fixture({ messages: [value], parts, onDownload(_uid, part) { if (part === '2') controller.abort(); } });
  await assert.rejects(cancelled.adapter.read(config(), credentials, { ...options, signal: controller.signal }), { name: 'AbortError' });
});

test('rich reading limits HTML and skips body downloads when the message is plain-only', async () => {
  const plain = { ...message(), bodyStructure: textNode };
  const plainFixture = fixture({ messages: [plain] });
  assert.deepEqual(await plainFixture.adapter.readRich(config(), credentials, { uid: 10 }), { html: '', images: [] });
  assert.equal(plainFixture.state.calls.some(([method]) => method === 'download'), false);

  const html = { ...message(), bodyStructure: { part: '1', type: 'text/html' } };
  const htmlFixture = fixture({ messages: [html], parts: { 1: Buffer.alloc(512 * 1024 + 1, 'x') } });
  const rich = await htmlFixture.adapter.readRich(config(), credentials, { uid: 10 });
  assert.equal(rich.html.length, 512 * 1024);
  assert.equal(rich.truncated, true);
});

test('rich reading bounds CID fetch attempts and total decoded image bytes', async () => {
  const parts = Array.from({ length: 10 }, (_, index) => ({ part: String(index + 2), type: 'image/jpeg', id: `<part-${index}>` }));
  const value = { ...message(), bodyStructure: { type: 'multipart/related', childNodes: [
    { part: '1', type: 'text/html' }, ...parts
  ] } };
  const html = Buffer.from(parts.map((_, index) => `<img src="cid:part-${index}">`).join(''));
  for (const [size, count] of [[32, 8], [1024 * 1024, 4]]) {
    const bytes = Buffer.alloc(size);
    bytes.set([0xff, 0xd8, 0xff]);
    const { adapter, state } = fixture({ messages: [value], parts: {
      1: html, ...Object.fromEntries(parts.map(({ part }) => [part, bytes]))
    } });
    const rich = await adapter.readRich(config(), credentials, { uid: 10 });
    assert.equal(rich.images.length, count);
    assert.equal(rich.truncated, true);
    assert.equal(state.calls.filter(([method]) => method === 'download').length, count + 1);
    assert.ok(rich.images.reduce((sum, image) => sum + Buffer.from(image.data, 'base64').length, 0) <= 4 * 1024 * 1024);
  }
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

test('internal public archive downloads support up to 50 MiB without increasing SMTP attachment limits', async () => {
  const large = Buffer.alloc(21 * 1024 * 1024, 7), { adapter, state } = fixture({ parts: { 3: large } });
  await rejectCode(adapter.downloadAttachment(config(), credentials, { uid: 10, part: '3' }), 'output_limit');
  const maximum = 50 * 1024 * 1024;
  const result = await adapter.downloadAttachment(config(), credentials, { uid: 10, part: '3', attachmentMaxBytes: maximum });
  assert.equal(result.size, large.length); assert.deepEqual(result.content, large);
  assert.equal(state.calls.filter(call => call[0] === 'download').at(-1)[3].maxBytes, maximum + 1);
  assert.equal(state.imapOptions.at(-1).maxLiteralSize, maximum + 1024 * 1024);
  await rejectCode(adapter.send(config(), credentials, { draft: { ...draft(), attachments: [{ name: 'large.pdf', content: large }] }, attachmentMaxBytes: maximum }), 'output_limit', 'not_sent');
  assert.equal(state.sent.length, 0);
  const invalid = fixture();
  for (const limit of [0, 1.5, maximum + 1, '52428800']) await rejectCode(invalid.adapter.downloadAttachment(config(), credentials, { uid: 10, part: '3', attachmentMaxBytes: limit }), 'invalid_arguments');
  assert.equal(invalid.state.imapOptions.length, 0);
  await rejectCode(adapter.downloadAttachment(config(), credentials, { uid: 10, part: '3', attachmentMaxBytes: large.length - 1 }), 'output_limit');
});

test('extended attachment downloads still destroy pending streams and IMAP on cancellation', async () => {
  let reached; const started = new Promise(resolve => { reached = resolve; });
  const stream = new Readable({ read() { this.push(Buffer.alloc(8)); reached(); this._read = () => {}; } });
  const { adapter, state } = fixture({ downloadStream: stream }), controller = new AbortController();
  const pending = adapter.downloadAttachment(config(), credentials, { uid: 10, part: '3', attachmentMaxBytes: 50 * 1024 * 1024, signal: controller.signal });
  await started; controller.abort(); await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(stream.destroyed, true); assert.ok(state.closed > 0);
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
  const parsed = await simpleParser(state.sent[0].raw);
  assert.deepEqual(parsed.from.value[0], { address: 'team@example.com', name: '业务团队' }); assert.equal(parsed.attachments[0].content.toString(), 'id,status\n1,ok');
  assert.equal(state.sent[0].disableFileAccess, true); assert.equal(state.sent[0].disableUrlAccess, true);
  assert.equal(result.status, 'accepted'); assert.equal(result.messageId, parsed.messageId); assert.equal('response' in result, false); assert.equal('text' in result, false);
  assert.deepEqual(result.sentCopy, { status: 'unavailable' }); assert.equal(state.calls.some(value => value[0] === 'append'), false);
});

const sentFolders = (path = 'Sent') => [{ path, flags: new Set(['\\Sent']), specialUse: '\\Sent' }];

test('accepted SMTP appends the identical MIME to a real Unicode Sent folder with references and no Bcc header', async () => {
  const { adapter, state } = fixture({ folders: sentFolders('已发送邮件') });
  let accepted;
  const input = { ...draft(), cc: ['copy@example.net'], bcc: ['private@example.net'], inReplyTo: '<original@example.net>', references: ['<root@example.net>', '<original@example.net>'] };
  const result = await adapter.send(config(), credentials, { draft: input, onAccepted: value => { accepted = structuredClone(value); assert.equal(state.calls.some(call => call[0] === 'connect'), false); } });
  assert.equal(result.status, 'accepted'); assert.deepEqual(result.sentCopy, { status: 'saved', folder: '已发送邮件' });
  assert.equal(accepted.status, 'accepted'); assert.equal(accepted.messageId, result.messageId);
  const send = state.sent[0], upload = state.calls.find(call => call[0] === 'append'), search = state.calls.find(call => call[0] === 'search');
  assert.equal(upload[1], '已发送邮件'); assert.equal(upload[2], send.raw); assert.deepEqual(upload[3], ['\\Seen']);
  assert.deepEqual(search[1], { header: { 'message-id': result.messageId } }); assert.deepEqual(search[2], { uid: true });
  assert.deepEqual(send.envelope.to, ['client@example.net', 'copy@example.net', 'private@example.net']);
  const parsed = await simpleParser(upload[2]);
  assert.equal(parsed.messageId, result.messageId); assert.equal(parsed.inReplyTo, input.inReplyTo); assert.deepEqual(parsed.references, input.references);
  assert.equal(parsed.bcc, undefined); assert.doesNotMatch(send.raw.toString(), /private@example\.net|^Bcc:/im);
  assert.equal(state.sent.length, 1); assert.equal(state.calls.filter(call => call[0] === 'lock')[0][2].readOnly, true);
  assert.ok(state.messages.every(value => !value.flags.has('\\Seen')));
});

test('server-saved Sent message is detected by its original Message-ID without duplicate append', async () => {
  const { adapter, state } = fixture({ folders: sentFolders(), existingSent: [44] });
  const result = await adapter.send(config(), credentials, { draft: draft() });
  assert.deepEqual(result.sentCopy, { status: 'already_present', folder: 'Sent' });
  assert.equal(state.calls.some(call => call[0] === 'append'), false); assert.equal(state.sent.length, 1);
});

test('unrecognized or ambiguous Sent folders are unavailable and never created or guessed', async () => {
  for (const folders of [[{ path: 'Sent', flags: new Set() }], [...sentFolders('Sent'), ...sentFolders('已发送')], [{ path: 'Sent', flags: new Set(['\\Sent', '\\Noselect']) }]]) {
    const { adapter, state } = fixture({ folders });
    const result = await adapter.send(config(), credentials, { draft: draft() });
    assert.deepEqual(result.sentCopy, { status: 'unavailable' }); assert.equal(state.calls.some(call => ['append', 'lock'].includes(call[0])), false);
  }
});

test('Sent append and IMAP login failures preserve accepted status and never submit SMTP twice', async () => {
  for (const overrides of [{ append: () => { throw new Error('imap-test-secret'); } }, { append: () => false }, { connect: () => { throw Object.assign(new Error('imap-test-secret'), { authenticationFailed: true }); } }]) {
    const { adapter, state } = fixture({ folders: sentFolders(), ...overrides });
    const result = await adapter.send(config(), credentials, { draft: draft() });
    assert.equal(result.status, 'accepted'); assert.equal(result.sentCopy.status, 'failed'); assert.equal(state.sent.length, 1);
    assert.doesNotMatch(JSON.stringify(result), /test-secret|provider_error/);
  }
  const { adapter, state } = fixture({ folders: sentFolders() });
  assert.equal((await adapter.send(config(), { smtpPassword: credentials.smtpPassword }, { draft: draft() })).sentCopy.status, 'failed');
  assert.equal(state.calls.some(call => ['connect', 'append'].includes(call[0])), false);
});

test('cancellation, authorization revocation and timeout during Sent archival preserve SMTP acceptance', async () => {
  const controller = new AbortController();
  const canceled = fixture({ folders: sentFolders(), connect: () => { controller.abort(); } });
  const canceledResult = await canceled.adapter.send(config(), credentials, { draft: draft(), signal: controller.signal });
  assert.equal(canceledResult.status, 'accepted'); assert.equal(canceledResult.sentCopy.status, 'failed');
  assert.equal(canceled.state.calls.some(call => call[0] === 'append'), false);
  const denied = fixture({ folders: sentFolders() });
  const deniedResult = await denied.adapter.send(config(), credentials, { draft: draft(), authorize: () => denied.state.allowed, onAccepted: () => { denied.state.allowed = false; } });
  assert.equal(deniedResult.status, 'accepted'); assert.equal(deniedResult.sentCopy.status, 'failed');
  assert.equal(denied.state.calls.some(call => call[0] === 'append'), false);
  const timed = fixture({ folders: sentFolders(), connect: () => new Promise(() => {}), deps: { timeoutMs: 100 } });
  const timedResult = await timed.adapter.send(config(), credentials, { draft: draft() });
  assert.equal(timedResult.status, 'accepted'); assert.equal(timedResult.sentCopy.status, 'failed'); assert.equal(timed.state.sent.length, 1); assert.ok(timed.state.closed > 0);
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
  assert.equal(unknown.state.calls.some(call => ['connect', 'append'].includes(call[0])), false); assert.equal(unknown.state.sent.length, 1);
  const rejected = fixture({ send: () => ({ accepted: [], rejected: ['client@example.net'] }) });
  await rejectCode(rejected.adapter.send(config(), credentials, { draft: draft() }), 'send_rejected', 'not_sent');
  assert.equal(rejected.state.calls.some(call => ['connect', 'append'].includes(call[0])), false);
});

test('internal sync UID windows traverse mailboxes above 10000 messages while public search keeps its limit', async () => {
  const messages = Array.from({ length: 10003 }, (_, index) => message(index + 1));
  const { adapter, state } = fixture({ messages, uidNext: 10004 });
  await rejectCode(adapter.search(config(), credentials, { limit: 50 }), 'output_limit');
  const found = [], ranges = []; let cursor, pages = 0;
  do {
    const result = await adapter.search(config(), credentials, { limit: 50, syncUidRange: { afterUid: 0 }, cursor });
    found.push(...result.messages.map(value => value.uid)); ranges.push(result.scannedUidRange);
    assert.equal(result.snapshotUid, 10003); cursor = result.nextCursor;
    if (!pages++) { state.messages.push(message(10004)); state.uidNext = 10005; }
  } while (cursor);
  assert.equal(found.length, 10003); assert.equal(new Set(found).size, 10003); assert.equal(found[0], 10003); assert.equal(found.at(-1), 1);
  assert.equal(ranges[0].toUid, 10003); assert.equal(ranges.at(-1).fromUid, 1);
  for (let index = 1; index < ranges.length; index++) assert.equal(ranges[index - 1].fromUid - 1, ranges[index].toUid);
  for (const call of state.calls.filter(value => value[0] === 'search').slice(1)) { const [lower, upper] = call[1].uid.split(':').map(Number); assert.ok(upper - lower + 1 <= EMAIL_LIMITS.searchMatches); }
});

test('internal sync advances empty UID windows, bounds history and rejects cross-mode cursors', async () => {
  const { adapter } = fixture({ messages: [message(3)], uidNext: 20004 });
  const first = await adapter.search(config(), credentials, { syncUidRange: { afterUid: 0 } });
  assert.deepEqual(first.messages, []); assert.ok(first.nextCursor); assert.deepEqual(first.scannedUidRange, { fromUid: 10004, toUid: 20003 });
  await rejectCode(adapter.search(config(), credentials, { cursor: first.nextCursor }), 'invalid_arguments');
  await rejectCode(adapter.search(config(), credentials, { syncUidRange: { afterUid: 1 }, cursor: first.nextCursor }), 'invalid_arguments');
  const second = await adapter.search(config(), credentials, { syncUidRange: { afterUid: 0 }, cursor: first.nextCursor });
  assert.deepEqual(second.messages, []); assert.ok(second.nextCursor); assert.deepEqual(second.scannedUidRange, { fromUid: 4, toUid: 10003 });
  const last = await adapter.search(config(), credentials, { syncUidRange: { afterUid: 0 }, cursor: second.nextCursor });
  assert.deepEqual(last.messages.map(value => value.uid), [3]); assert.equal(last.nextCursor, null); assert.deepEqual(last.scannedUidRange, { fromUid: 1, toUid: 3 });
  const newOnly = await adapter.search(config(), credentials, { syncUidRange: { afterUid: 3 } });
  assert.deepEqual(newOnly.messages, []);
  const empty = await adapter.search(config(), credentials, { syncUidRange: { afterUid: 20003 } });
  assert.equal(empty.nextCursor, null); assert.equal(empty.scannedUidRange, null);
});

test('internal sync cutoff applies to every bounded UID window and is part of its cursor scope', async () => {
  const dates = new Map([[20003, '2026-07-31'], [15000, '2026-08-01'], [10003, '2026-08-02'], [3, '2026-08-01']]);
  const messages = [...dates].map(([uid, date]) => ({ ...message(uid), internalDate: new Date(`${date}T01:00:00Z`),
    envelope: { date: new Date(uid === 20003 ? '2026-08-06T00:00:00Z' : '2026-07-30T00:00:00Z') } }));
  const { adapter, state } = fixture({ messages, uidNext: 20004, search({ uid, since }) {
    const [lower, upper] = uid.split(':').map(Number);
    return [...dates].filter(([key, date]) => lower <= key && key <= upper && (!since || date >= since)).map(([key]) => key);
  } });
  const options = { limit: 1, syncUidRange: { afterUid: 0 }, syncSince: '2026-08-01' };
  const first = await adapter.search(config(), credentials, options);
  assert.deepEqual(first.messages.map(({ uid }) => uid), [15000]);
  assert.deepEqual(first.scannedUidRange, { fromUid: 10004, toUid: 20003 });
  await rejectCode(adapter.search(config(), credentials, { ...options, syncSince: '2026-08-02', cursor: first.nextCursor }), 'invalid_arguments');
  await rejectCode(adapter.search(config(), credentials, { ...options, syncSince: undefined, cursor: first.nextCursor }), 'invalid_arguments');
  const second = await adapter.search(config(), credentials, { ...options, cursor: first.nextCursor });
  assert.deepEqual(second.messages.map(({ uid }) => uid), [10003]);
  assert.deepEqual(second.scannedUidRange, { fromUid: 4, toUid: 10003 });
  const last = await adapter.search(config(), credentials, { ...options, cursor: second.nextCursor });
  assert.deepEqual(last.messages.map(({ uid }) => uid), [3]);
  assert.deepEqual(last.scannedUidRange, { fromUid: 1, toUid: 3 });
  assert.equal(last.nextCursor, null);
  assert.deepEqual(state.calls.filter(([method]) => method === 'search').map(([, { since, uid }]) => [since, uid]), [
    ['2026-08-01', '10004:20003'], ['2026-08-01', '4:10003'], ['2026-08-01', '1:3']
  ]);
  assert.deepEqual(state.calls.filter(([method]) => method === 'fetchAll').flatMap(([, uids]) => uids), [15000, 10003, 3]);
});

test('sync cutoff is an internal valid calendar day and intersects the ordinary search date', async () => {
  const { adapter, state } = fixture();
  for (const syncSince of [null, '2026-02-30', '2026-8-01', '2026-08-01T00:00:00+08:00']) {
    await rejectCode(adapter.search(config(), credentials, { syncUidRange: { afterUid: 0 }, syncSince }), 'invalid_arguments');
  }
  await rejectCode(adapter.search(config(), credentials, { syncSince: '2026-08-01' }), 'invalid_arguments');
  await rejectCode(adapter.search(config(), credentials, { query: { syncSince: '2026-08-01' } }), 'invalid_arguments');
  assert.equal(state.calls.length, 0);

  await adapter.search(config(), credentials, { query: { since: '2026-07-01' } });
  await adapter.search(config(), credentials, { query: { since: '2026-07-01' }, syncUidRange: { afterUid: 3 }, syncSince: '2026-08-01' });
  await adapter.search(config(), credentials, { query: { since: '2026-09-01' }, syncUidRange: { afterUid: 3 }, syncSince: '2026-08-01' });
  assert.deepEqual(state.calls.filter(([method]) => method === 'search').map(([, { since, uid }]) => [since, uid]), [
    ['2026-07-01', '1:10'], ['2026-08-01', '4:10'], ['2026-09-01', '4:10']
  ]);
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
