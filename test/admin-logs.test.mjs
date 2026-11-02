import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { AdminLogService, LOG_SOURCES } from '../lib/admin-logs.mjs';

function fixture(t, options = {}) {
  const db = new DatabaseSync(':memory:');
  const logs = new AdminLogService({ db }, options);
  t.after(() => { logs.close(); db.close(); });
  return { db, logs };
}
async function until(check) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('Timed out waiting for diagnostic stream');
}
class Response extends EventEmitter {
  frames = []; writableLength = 0; writableEnded = false; destroyed = false;
  writeHead(status, headers) { this.status = status; this.headers = headers; }
  flushHeaders() {}
  write(value) { this.frames.push(value); return this.blockAt ? this.frames.length < this.blockAt : true; }
  end() { this.writableEnded = true; this.emit('close'); }
  destroy() { this.destroyed = true; this.emit('close'); }
  events() { return this.frames.filter(frame => frame.startsWith('data: ')).map(frame => JSON.parse(frame.slice(6))); }
}

test('runtime logs sanitize before persistence, redact again on read and exclude message/request/tool content', t => {
  let currentKey = 'known-fixture-key-58365';
  const { db, logs } = fixture(t, { knownSecrets: () => [currentKey] });
  const record = logs.write({ source: 'model', message: `调用 ${currentKey}\nAuthorization: Bearer bearer-private-value\nCookie: session=private-cookie\n{"cookie":"json-cookie-private-value","authorization":"Basic json-basic-private-value"}\napi_key=private-api-value\nhttps://user:password@example.com/path?token=private-query#private-fragment`,
    details: { status: 'failed', secret: 'hidden-secret', authorization: 'hidden-header', prompt: 'employee-private-body', body: 'private-request', stdout: 'private-tool', result: 'private-result', unknown: 'private-unknown', provider: 'custom', reason: new Error('API rejected employee-private-body') }, sessionId: 'group-1', taskId: 'task-1', actorId: 'user-1' });
  assert.ok(record.id > 0);
  const raw = JSON.stringify(db.prepare('SELECT * FROM admin_runtime_logs').get());
  for (const value of [currentKey, 'bearer-private-value', 'private-cookie', 'json-cookie-private-value', 'json-basic-private-value', 'private-api-value', 'private-query', 'private-fragment', 'employee-private-body', 'private-request', 'private-tool', 'private-result', 'private-unknown']) assert.ok(!raw.includes(value), value);
  assert.match(raw, /redacted/u);
  // A credential configured after an old row was saved is still hidden on read.
  db.prepare('INSERT INTO admin_runtime_logs(timestamp,level,source,message) VALUES (?,?,?,?)').run(new Date().toISOString(), 'INFO', 'system', 'newly-sensitive-key-1234');
  currentKey = 'newly-sensitive-key-1234';
  assert.ok(!JSON.stringify(logs.list()).includes(currentKey));
  assert.deepEqual(logs.list().sources, LOG_SOURCES);
});

test('untrusted error echoes become safe useful classifications and retain status/error code', t => {
  const { logs } = fixture(t);
  for (const value of ['API request rejected; employee-private-test-body invoice-92831', '模型调用失败：employee-private-test-body invoice-92831', '{"messages":"employee-private-test-body"}']) assert.ok(!logs.failure(new Error(value)).reason.includes('employee-private'));
  const cases = [['401 invalid API key', '认证'], ['403 member denied', '权限'], ['429 rate limit', '限流'], ['ETIMEDOUT timeout', '超时'], ['ECONNREFUSED', '网络'], ['结果投递失败', '投递'], ['退出码 9', '退出码 9'], ['500 upstream error', '服务端'], ['服务重启', '重启']];
  for (const [input, expected] of cases) {
    const failure = logs.failure(new Error(input));
    assert.ok(failure.reason.includes(expected), `${input}: ${failure.reason}`);
    assert.equal(logs.details(failure).reason, failure.reason, 'classification survives details sanitization');
  }
  const failure = logs.failure(Object.assign(new Error('request failed'), { status: 401, code: 'AUTH_FAILED' }));
  assert.equal(failure.statusCode, 401); assert.equal(failure.errorCode, 'AUTH_FAILED');
});

test('bounded diagnostics reject invalid records and do not throw after storage failure', t => {
  const { logs, db } = fixture(t);
  const record = logs.write({ message: '文'.repeat(5000), details: { provider: '文'.repeat(3000), model: Array(80).fill('x'.repeat(300)), prompt: 'never-collected' }, sessionId: '../invalid' });
  assert.ok(Buffer.byteLength(record.message) <= 2000);
  assert.ok(Buffer.byteLength(JSON.stringify(record.details)) <= 4096);
  assert.equal(record.sessionId, undefined);
  assert.equal(logs.write({ level: 'TRACE', message: 'bad' }), null);
  assert.equal(logs.write({ source: 'console', message: 'bad' }), null);
  assert.equal(logs.write({ message: '' }), null);
  db.exec('DROP TABLE admin_runtime_logs');
  assert.equal(logs.write({ message: 'capture failure must not affect application' }), null);
});

test('retention enforces seven-day age and bounded row count while preserving monotonic cursor', t => {
  let now = new Date('2026-10-01T00:00:00Z');
  const { logs, db } = fixture(t, { now: () => now, maxEntries: 3 });
  for (let i = 0; i < 5; i++) logs.write({ message: `entry ${i}` });
  assert.deepEqual(logs.list().logs.map(log => log.id), [3, 4, 5]);
  assert.equal(logs.list({ after: 1 }).gap, true);
  assert.equal(logs.list({ after: 0 }).gap, true);
  now = new Date('2026-10-09T00:00:00Z');
  assert.equal(logs.list().logs.length, 0);
  assert.equal(logs.list().cursor, 5);
  const restored = new AdminLogService({ db }, { now: () => now });
  assert.equal(restored.write({ message: 'after restart' }).id, 6);
  restored.close();
});

test('list pagination is ascending, after catches earliest unread, and searches exact identifiers safely', t => {
  const { logs } = fixture(t);
  for (let i = 1; i <= 12; i++) logs.write({ level: i % 2 ? 'INFO' : 'ERROR', source: i % 2 ? 'tasks' : 'http', message: i === 6 ? 'literal 100%_complete' : `entry ${i}`, taskId: `task-${i}`, sessionId: `group-${i}`, actorId: `actor-${i}` });
  const latest = logs.list({ limit: '3' });
  assert.deepEqual(latest.logs.map(log => log.id), [10, 11, 12]); assert.equal(latest.nextBefore, 10);
  assert.deepEqual(logs.list({ limit: 3, before: 10 }).logs.map(log => log.id), [7, 8, 9]);
  const first = logs.list({ limit: 3, after: 0 });
  assert.deepEqual(first.logs.map(log => log.id), [1, 2, 3]); assert.equal(first.cursor, 12); assert.equal(first.nextAfter, 3); assert.equal(first.hasMore, true);
  assert.deepEqual(logs.list({ after: 0, source: 'http', level: 'ERROR', limit: 2 }).logs.map(log => log.id), [2, 4]);
  for (const keyword of ['task-12', 'group-12', 'actor-12', '100%_complete']) assert.equal(logs.list({ q: keyword }).logs.length, 1);
  assert.equal(logs.list({ q: "' OR 1=1 --" }).logs.length, 0);
});

test('strict filters reject malformed cursors, duplicate fields, unknown enums, controls and invalid dates', t => {
  const { logs } = fixture(t);
  const invalid = [{ limit: '0' }, { limit: 501 }, { after: '-1' }, { before: '1e2' }, { after: '9007199254740992' }, { after: 0, before: 1 }, { level: 'warn' }, { source: 'console' }, { arbitrary: 'x' }, { q: '\nsecret' }, { q: 'x'.repeat(201) }, { from: '2026-02-30T00:00:00Z' }, { from: '2026-10-29' }, { from: '2026-10-30T00:00:00Z', to: '2026-10-29T00:00:00Z' }, new URLSearchParams('limit=1&limit=2')];
  for (const input of invalid) assert.throws(() => logs.list(input), { status: 400 }, JSON.stringify(input));
  assert.equal(logs.filters({ from: '2024-02-29T12:00:00+08:00' }).from, '2024-02-29T04:00:00.000Z');
});

test('live streams drain more than 200 unseen filtered records with no race or duplicate and safe progress cursors', async t => {
  const { logs } = fixture(t, { authIntervalMs: 30 });
  for (let i = 1; i <= 750; i++) logs.write({ message: `backlog ${i}`, source: i % 2 ? 'tasks' : 'http' });
  const res = new Response();
  logs.live({}, res, { after: 0, source: 'tasks' }, { actorId: 'admin', authenticate: () => ({ id: 'admin', role: 'admin' }) });
  logs.write({ message: 'arrived during subscribe and replay', source: 'tasks' });
  await until(() => res.events().some(event => event.cursor === 751));
  const events = res.events().filter(event => event.type === 'logs'), ids = events.flatMap(event => event.logs.map(log => log.id));
  assert.equal(ids.length, 376); assert.equal(new Set(ids).size, 376);
  assert.deepEqual(ids, [...Array(375)].map((_, index) => index * 2 + 1).concat(751));
  assert.ok(events.every(event => Buffer.byteLength(JSON.stringify(event)) < 54000));
  assert.ok(events.slice(0, -1).every(event => event.cursor < 751));
});

test('live retention gaps are explicit and catch up with available records', async t => {
  const { logs } = fixture(t, { maxEntries: 3 });
  for (let i = 0; i < 8; i++) logs.write({ message: `entry ${i}` });
  const res = new Response();
  logs.live({}, res, { after: 1 }, { actorId: 'admin', authenticate: () => ({ id: 'admin', role: 'admin' }) });
  await until(() => res.events().some(event => event.cursor === 8));
  assert.deepEqual(res.events().filter(event => event.type === 'gap').map(event => event.oldestId), [6]);
  assert.deepEqual(res.events().filter(event => event.type === 'logs').flatMap(event => event.logs.map(log => log.id)), [6, 7, 8]);
});

test('live revalidates real current admin before batches and on heartbeat then tears down listeners', async t => {
  const { logs } = fixture(t, { authIntervalMs: 20 }); let current = { id: 'admin', role: 'admin' };
  const res = new Response(); logs.live({}, res, { after: 0 }, { actorId: 'admin', authenticate: () => current });
  current = { id: 'admin', role: 'member' };
  logs.write({ message: 'must not reach revoked administrator' });
  await until(() => res.writableEnded);
  assert.equal(res.events().at(-1).type, 'auth_expired');
  assert.equal(res.events().flatMap(event => event.logs || []).length, 0);
  assert.equal(logs.streams.size, 0); assert.equal(logs.listeners.size, 0);
});

test('slow connections, revocation, stream caps and shutdown cannot retain buffered unauthorized sockets', async t => {
  const { logs } = fixture(t, { authIntervalMs: 20 });
  const auth = actorId => ({ actorId, authenticate: () => ({ id: actorId, role: 'admin' }) });
  const a = new Response(); a.blockAt = 2;
  logs.live({}, a, { after: 0 }, auth('a')); logs.write({ message: 'blocked frame' });
  await until(() => a.frames.length === 2);
  logs.revokeActor('a');
  assert.equal(a.destroyed, true); assert.equal(logs.streams.size, 0);
  const heartbeat = new Response(); heartbeat.blockAt = 2;
  logs.live({}, heartbeat, {}, auth('heartbeat-admin'));
  await until(() => heartbeat.frames.length === 2);
  assert.equal(heartbeat.frames[1], ': heartbeat\n\n');
  logs.revokeActor('heartbeat-admin'); assert.equal(heartbeat.destroyed, true);
  const first = new Response(), second = new Response();
  logs.live({}, first, {}, auth('same-admin')); logs.live({}, second, {}, auth('same-admin'));
  assert.throws(() => logs.live({}, new Response(), {}, auth('same-admin')), { status: 429 });
  first.end(); second.end();
  const responses = [];
  for (const actorId of ['a', 'a', 'b', 'b', 'c', 'c', 'd', 'd']) { const response = new Response(); responses.push(response); logs.live({}, response, {}, auth(actorId)); }
  assert.throws(() => logs.live({}, new Response(), {}, auth('e')), { status: 429 });
  logs.closeStreams(); assert.ok(responses.every(response => response.writableEnded));
  assert.equal(logs.streams.size, 0); assert.equal(logs.listeners.size, 0);
  assert.throws(() => logs.live({}, new Response(), {}, auth('a')), { status: 503 });
  assert.ok(logs.write({ message: 'shutdown task lifecycle is still recorded' }));
});

test('channel state diagnostics distinguish connection, receive and delivery failures without reading message text', t => {
  const { db, logs } = fixture(t);
  db.exec(`CREATE TABLE im_channels(id TEXT,status TEXT,session_id TEXT,last_error TEXT,poll_failures INTEGER,updated_at TEXT,auth_token TEXT);
    CREATE TABLE im_channel_outbox(id TEXT,channel_id TEXT,session_id TEXT,status TEXT,last_error TEXT,attempts INTEGER,created_at TEXT,text TEXT);
    CREATE TABLE im_channel_logins(id TEXT,channel_id TEXT,status TEXT,created_at TEXT,qrcode TEXT);`);
  db.prepare('INSERT INTO im_channels VALUES (?,?,?,?,?,?,?)').run('channel-1', 'connected', 'group-1', null, 0, 'now', 'never-read-token');
  db.prepare('INSERT INTO im_channel_outbox VALUES (?,?,?,?,?,?,?,?)').run('outbox-1', 'channel-1', 'group-1', 'failed', '结果投递失败', 4, 'now', 'employee-private-message');
  db.prepare('INSERT INTO im_channel_logins VALUES (?,?,?,?,?)').run('login-1', 'channel-1', 'expired', 'now', 'never-read-qr');
  logs.observeChannels();
  const first = logs.list(); assert.equal(first.logs.length, 3);
  assert.ok(first.logs.some(log => log.source === 'channels' && log.level === 'ERROR' && log.details.phase === 'delivery'));
  assert.ok(first.logs.some(log => log.details.phase === 'login' && log.details.reason.includes('失效')));
  const encoded = JSON.stringify(first);
  for (const value of ['never-read-token', 'employee-private-message', 'never-read-qr']) assert.ok(!encoded.includes(value));
  logs.observeChannels(); assert.equal(logs.list().logs.length, 3);
  db.prepare('UPDATE im_channels SET last_error=?,poll_failures=5').run('微信连接暂时中断，正在重试。');
  logs.observeChannels(); assert.equal(logs.list().logs.length, 4);
  db.prepare('UPDATE im_channels SET poll_failures=6').run(); logs.observeChannels(); assert.equal(logs.list().logs.length, 4);
});
