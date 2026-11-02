import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import { AttachmentService, ATTACHMENT_MAX_BYTES } from '../lib/attachments.mjs';
import { Store } from '../lib/store.mjs';
import { HttpError } from '../lib/security.mjs';
import { createFixture, session } from './auth-helpers.mjs';

const localFixtures = [];
afterEach(async () => {
  for (const f of localFixtures.splice(0)) {
    f.store.close();
    assert.equal(path.dirname(f.directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(f.directory).startsWith('pi-upload-files-'));
    await fs.rm(f.directory, { recursive: true, force: true });
  }
});

async function filesFixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-upload-files-'));
  const cwd = path.join(directory, 'workspace'); await fs.mkdir(cwd);
  const store = new Store(path.join(directory, 'data'), cwd);
  store.sessions.push({ id: 'group-a', title: 'A' }, { id: 'group-b', title: 'B' }); store.saveSessions();
  const service = new AttachmentService(store);
  const f = { directory, cwd, store, service }; localFixtures.push(f); return f;
}

function upload(service, name, chunks, extra = {}) {
  return service.upload({ sessionId: 'group-a', name, stream: Readable.from(chunks), ...extra });
}

async function until(check, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!await check()) {
    assert.ok(Date.now() < deadline, 'Expected asynchronous upload state before deadline');
    await new Promise(resolve => setTimeout(resolve, 15));
  }
}

function rawUpload(baseUrl, route, cookie, headers = {}) {
  const address = new URL(baseUrl);
  let responded = false, request;
  const done = new Promise((resolve, reject) => {
    request = http.request({ hostname: address.hostname, port: address.port, path: `/api${route}`, method: 'POST',
      headers: { cookie, 'content-type': 'application/octet-stream', ...headers } }, response => {
      responded = true;
      let text = ''; response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('error', reject);
      response.on('end', () => {
        try { resolve({ status: response.statusCode, headers: response.headers, data: text ? JSON.parse(text) : null }); }
        catch (error) { reject(error); }
      });
    });
    request.on('error', error => { if (!responded) reject(error); });
    request.setTimeout(10_000, () => request.destroy(new Error('Local upload test timed out')));
  });
  return { request, done };
}

describe('raw group upload HTTP API', { concurrency: false, timeout: 120_000 }, () => {
  let f, admin, employee, outsider, employeeUser;
  const password = 'local-upload-fixture-password';
  before(async () => {
    f = await createFixture({ prefix: 'raw-upload', options: { scheduler: { autoStart: false }, channels: { autoStart: false }, workTasks: { autoStart: false } } });
    admin = f.client(); employee = f.client(); outsider = f.client();
    assert.equal((await admin.request('/auth/setup', { method: 'POST', body: { username: 'upload-admin', displayName: 'Admin', password } })).response.status, 201);
    employeeUser = (await admin.request('/admin/users', { method: 'POST', body: { username: 'upload-member', displayName: 'Employee', password, role: 'member' } })).data.user;
    await admin.request('/admin/users', { method: 'POST', body: { username: 'upload-outsider', displayName: 'Outsider', password, role: 'member' } });
    assert.equal((await employee.request('/auth/login', { method: 'POST', body: { username: 'upload-member', password } })).response.status, 200);
    await outsider.request('/auth/login', { method: 'POST', body: { username: 'upload-outsider', password } });
  });
  after(async () => { await f?.close(); });
  async function group() {
    const chat = await session(admin, 'Upload test');
    assert.equal((await admin.request(`/sessions/${chat.id}/members`, { method: 'POST', body: { userIds: [employeeUser.id] } })).response.status, 200);
    return chat;
  }
  function directory() { return path.join(f.dataDir, 'attachments'); }
  function count(id) { return f.server.piWeb.schedules.db.prepare('SELECT COUNT(*) AS n FROM attachments WHERE session_id=?').get(id).n; }
  async function post(chat, client = employee, name = '业务报表.csv', bytes = Buffer.from('row,value\n1,42\n'), headers = {}) {
    const response = await fetch(`${f.baseUrl}/api/sessions/${chat.id}/attachments?name=${encodeURIComponent(name)}`, {
      method: 'POST', headers: { cookie: client.cookie, 'content-type': 'application/octet-stream', ...headers }, body: bytes, signal: AbortSignal.timeout(10_000),
    });
    return { response, data: await response.json() };
  }

  test('member uploads without a configured model; snapshots survive source changes and remain group-private', async () => {
    const chat = await group(); const bytes = Buffer.from('订单,数量\nA,42\n');
    const result = await post(chat, employee, '订单.csv', bytes);
    assert.equal(result.response.status, 201, JSON.stringify(result.data));
    const attachment = result.data.attachment;
    assert.deepEqual(Object.keys(attachment).sort(), ['downloadUrl', 'id', 'kind', 'mimeType', 'name', 'size', 'url']);
    assert.equal(attachment.name, '订单.csv'); assert.equal(attachment.size, bytes.length); assert.equal(attachment.kind, 'file');
    assert.ok(!JSON.stringify(attachment).includes(f.dataDir));
    const route = attachment.url.slice(4);
    const received = await employee.fetch(route);
    assert.equal(received.status, 200); assert.deepEqual(Buffer.from(await received.arrayBuffer()), bytes);
    assert.match(received.headers.get('content-disposition'), /^attachment;/);
    assert.equal(received.headers.get('x-content-type-options'), 'nosniff');
    const head = await employee.fetch(route, { method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal(await head.text(), ''); assert.equal(Number(head.headers.get('content-length')), bytes.length);
    assert.equal((await f.client().fetch(route)).status, 401);
    assert.equal((await outsider.fetch(route)).status, 404);
    const other = await session(admin, 'Other upload group');
    assert.equal((await admin.fetch(route.replace(chat.id, other.id))).status, 404);
    const repeated = await post(chat, employee, '订单.csv', Buffer.from('new'));
    assert.notEqual(repeated.data.attachment.id, attachment.id);
    assert.deepEqual(Buffer.from(await (await employee.fetch(route)).arrayBuffer()), bytes);
    assert.equal(count(chat.id), 2);
    const audit = f.server.piWeb.schedules.db.prepare("SELECT details FROM audit WHERE action='attachment.uploaded' AND target_id=?").get(attachment.id);
    assert.deepEqual(JSON.parse(audit.details), { sessionId: chat.id, size: bytes.length, kind: 'file' });
    await admin.request(`/sessions/${chat.id}/members/${employeeUser.id}`, { method: 'DELETE', body: {} });
    assert.equal((await employee.fetch(route)).status, 404);
    assert.equal((await post(chat)).response.status, 404);
  });

  test('upload keeps Host, Origin, fetch-site and exact-route content-type checks', async () => {
    const chat = await group();
    assert.equal((await post(chat, f.client())).response.status, 401);
    assert.equal((await post(chat, outsider)).response.status, 404);
    assert.equal((await post(chat, employee, 'x', Buffer.from('x'), { origin: 'https://untrusted.example' })).response.status, 403);
    assert.equal((await post(chat, employee, 'x', Buffer.from('x'), { 'sec-fetch-site': 'cross-site' })).response.status, 403);
    const foreignHost = rawUpload(f.baseUrl, `/sessions/${chat.id}/attachments?name=x`, employee.cookie, { host: 'untrusted.example' });
    try { foreignHost.request.end('x'); assert.equal((await foreignHost.done).status, 403); }
    finally { foreignHost.request.destroy(); }
    assert.equal((await post(chat, employee, 'x', Buffer.from('{}'), { 'content-type': 'application/json' })).response.status, 415);
    const wrongRoutes = ['/sessions', `/sessions/${chat.id}/discussion`, `/sessions/${chat.id}/attachments/`, `/sessions/${chat.id}/attachments/${randomUUID()}`];
    for (const route of wrongRoutes) {
      const response = await fetch(`${f.baseUrl}/api${route}`, { method: 'POST', headers: { cookie: employee.cookie, 'content-type': 'application/octet-stream' }, body: 'x' });
      assert.equal(response.status, 415, route); await response.text();
    }
    for (const query of ['', '?name=x&name=y', '?name=x&path=elsewhere', '?name=']) {
      const response = await fetch(`${f.baseUrl}/api/sessions/${chat.id}/attachments${query}`, { method: 'POST', headers: { cookie: employee.cookie, 'content-type': 'application/octet-stream' }, body: 'x' });
      assert.equal(response.status, 400, query); await response.text();
    }
    assert.equal(count(chat.id), 0);
  });

  test('declared and chunked oversized requests return 413 without committed or temporary files', async () => {
    const chat = await group(), before = await fs.readdir(directory());
    const declared = rawUpload(f.baseUrl, `/sessions/${chat.id}/attachments?name=large.bin`, employee.cookie, { 'content-length': ATTACHMENT_MAX_BYTES + 1 });
    try { declared.request.flushHeaders(); assert.equal((await declared.done).status, 413); }
    finally { declared.request.destroy(); }
    const chunked = rawUpload(f.baseUrl, `/sessions/${chat.id}/attachments?name=large.bin`, employee.cookie, { 'transfer-encoding': 'chunked' });
    try { chunked.request.end(Buffer.alloc(ATTACHMENT_MAX_BYTES + 1)); assert.equal((await chunked.done).status, 413); }
    finally { chunked.request.destroy(); }
    assert.equal(count(chat.id), 0);
    assert.deepEqual(await fs.readdir(directory()), before);
  });

  test('dropping membership during an idle upload cancels and cleans its uncommitted file', async () => {
    const chat = await group(), before = await fs.readdir(directory());
    const pending = rawUpload(f.baseUrl, `/sessions/${chat.id}/attachments?name=partial.txt`, employee.cookie);
    try {
      pending.request.write('partial upload');
      await until(async () => (await fs.readdir(directory())).some(name => name.endsWith('.tmp')));
      assert.equal((await admin.request(`/sessions/${chat.id}/members/${employeeUser.id}`, { method: 'DELETE', body: {} })).response.status, 200);
      assert.equal((await pending.done).status, 404);
      assert.equal(count(chat.id), 0); assert.deepEqual(await fs.readdir(directory()), before);
    } finally { pending.request.destroy(); }
  });

  test('logging out during an idle upload invalidates the old cookie and cleans its file', async () => {
    const chat = await group(), before = await fs.readdir(directory());
    const pending = rawUpload(f.baseUrl, `/sessions/${chat.id}/attachments?name=partial.txt`, employee.cookie);
    try {
      pending.request.write('partial upload');
      await until(async () => (await fs.readdir(directory())).some(name => name.endsWith('.tmp')));
      assert.equal((await employee.request('/auth/logout', { method: 'POST', body: {} })).response.status, 200);
      assert.equal((await pending.done).status, 401);
      assert.equal(count(chat.id), 0); assert.deepEqual(await fs.readdir(directory()), before);
    } finally { pending.request.destroy(); await employee.request('/auth/login', { method: 'POST', body: { username: 'upload-member', password } }); }
  });

  test('client disconnection cleans partial bytes without creating attachment metadata', async () => {
    const chat = await group(), before = await fs.readdir(directory());
    const pending = rawUpload(f.baseUrl, `/sessions/${chat.id}/attachments?name=partial.txt`, employee.cookie);
    pending.done.catch(() => {});
    try {
      pending.request.write('partial upload');
      await until(async () => (await fs.readdir(directory())).some(name => name.endsWith('.tmp')));
      pending.request.destroy();
      await until(async () => (await fs.readdir(directory())).length === before.length);
      assert.equal(count(chat.id), 0); assert.deepEqual(await fs.readdir(directory()), before);
    } finally { pending.request.destroy(); }
  });

  test('disabling an account during upload prevents both commit and later downloads', async () => {
    const chat = await group(), before = await fs.readdir(directory());
    const pending = rawUpload(f.baseUrl, `/sessions/${chat.id}/attachments?name=partial.txt`, employee.cookie);
    try {
      pending.request.write('partial upload');
      await until(async () => (await fs.readdir(directory())).some(name => name.endsWith('.tmp')));
      assert.equal((await admin.request(`/admin/users/${employeeUser.id}`, { method: 'PATCH', body: { disabled: true } })).response.status, 200);
      assert.equal((await pending.done).status, 401);
      assert.equal((await post(chat)).response.status, 401);
      assert.equal(count(chat.id), 0); assert.deepEqual(await fs.readdir(directory()), before);
    } finally {
      pending.request.destroy();
      await admin.request(`/admin/users/${employeeUser.id}`, { method: 'PATCH', body: { disabled: false } });
      await employee.request('/auth/login', { method: 'POST', body: { username: 'upload-member', password } });
    }
  });
});

test('upload classifies image signatures across chunks and forces HTML, SVG and fake images to download', async () => {
  const f = await filesFixture();
  const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  const attachment = await upload(f.service, 'untrusted.txt', [png.subarray(0, 2), png.subarray(2, 7), png.subarray(7)]);
  assert.equal(attachment.mimeType, 'image/png'); assert.equal(attachment.kind, 'image');
  assert.deepEqual(await fs.readFile(path.join(f.service.directory, `${attachment.id}.bin`)), png);
  for (const name of ['fake.png', 'page.html', 'drawing.svg']) {
    const ordinary = await upload(f.service, name, [Buffer.from('<svg><script>untrusted</script></svg>')]);
    assert.equal(ordinary.kind, 'file'); assert.equal(ordinary.mimeType, 'application/octet-stream');
  }
  const empty = await upload(f.service, 'empty.txt', []); assert.equal(empty.size, 0); assert.equal(empty.kind, 'file');
});

test('upload checks actual stream length, malformed lengths, signature spoofing and the exact 50 MiB boundary', async () => {
  const f = await filesFixture();
  for (const contentLength of ['invalid', '-1', '1.5', '9007199254740993']) {
    await assert.rejects(upload(f.service, 'bad.txt', [Buffer.from('x')], { contentLength }), { status: 400 });
  }
  await assert.rejects(upload(f.service, 'short.txt', [Buffer.from('x')], { contentLength: 2 }), { status: 400 });
  const chunk = Buffer.alloc(1024 * 1024);
  const exact = await upload(f.service, 'exact.bin', Array(50).fill(chunk), { contentLength: ATTACHMENT_MAX_BYTES });
  assert.equal(exact.size, ATTACHMENT_MAX_BYTES);
  await assert.rejects(upload(f.service, 'overflow.bin', [...Array(50).fill(chunk), Buffer.from('x')]), { status: 413 });
  assert.deepEqual(await fs.readdir(f.service.directory), [`${exact.id}.bin`]);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM attachments').get().n, 1);
});

test('upload revocation while waiting for bytes rejects without requiring another chunk', async () => {
  const f = await filesFixture(), stream = new PassThrough(); let allowed = true;
  const pending = f.service.upload({ sessionId: 'group-a', name: 'partial.txt', stream,
    authorize() { if (!allowed) throw new HttpError(403, 'Upload authorization revoked'); } });
  pending.catch(() => {});
  stream.write('partial');
  await until(async () => (await fs.readdir(f.service.directory)).some(name => name.endsWith('.tmp')));
  allowed = false;
  let keepAlive;
  try {
    await Promise.race([assert.rejects(pending, { status: 403 }), new Promise((_, reject) => { keepAlive = setTimeout(() => reject(new Error('Upload revocation timed out')), 5000); })]);
  } finally { clearTimeout(keepAlive); stream.end(); }
  assert.deepEqual(await fs.readdir(f.service.directory), []);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM attachments').get().n, 0);
});

test('upload cleans snapshots when final authorization or metadata commit fails', async () => {
  const f = await filesFixture();
  await assert.rejects(upload(f.service, 'revoked.txt', [Buffer.from('private')], {
    authorize() {
      if (fsSync.readdirSync(f.service.directory).some(name => name.endsWith('.bin'))) throw new HttpError(403, 'Authorization revoked before commit');
    },
  }), { status: 403 });
  assert.deepEqual(await fs.readdir(f.service.directory), []);
  f.store.db.exec("CREATE TRIGGER reject_upload BEFORE INSERT ON attachments BEGIN SELECT RAISE(ABORT,'private fixture database error'); END;");
  await assert.rejects(upload(f.service, 'failed.txt', [Buffer.from('private')]), error => error.status === 500 && !error.message.includes('private fixture'));
  assert.deepEqual(await fs.readdir(f.service.directory), []);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM attachments').get().n, 0);
});

test('materialize copies immutable same-group files into task-specific inbox paths with portable filenames', async () => {
  const f = await filesFixture(); const bytes = Buffer.from('actual shipment data');
  const attachment = await upload(f.service, 'CON:result<>|?*.xlsx. ', [bytes]);
  const taskId = `${randomUUID()}-${randomUUID()}`;
  const [copy] = await f.service.materialize({ sessionId: 'group-a', attachmentIds: [attachment.id], cwd: f.cwd, taskId });
  const { path: copiedPath, ...metadata } = copy;
  assert.deepEqual(metadata, attachment); assert.deepEqual(await fs.readFile(copiedPath), bytes);
  assert.equal(path.dirname(copiedPath), path.join(f.store.directory, 'attachment-inbox', 'group-a', taskId, attachment.id));
  assert.deepEqual(await fs.readdir(f.cwd), []);
  assert.ok(path.basename(copiedPath).startsWith(`${attachment.id}-`));
  assert.match(path.basename(copiedPath), /\.xlsx$/); assert.doesNotMatch(path.basename(copiedPath), /[<>:"/\\|?*]|[ .]$/);
  assert.ok(!copiedPath.includes(f.service.directory));
  const snapshot = path.join(f.service.directory, `${attachment.id}.bin`);
  const [sourceStat, targetStat] = await Promise.all([fs.stat(snapshot), fs.stat(copiedPath)]);
  assert.notEqual(targetStat.ino, sourceStat.ino); assert.equal(sourceStat.nlink, 1); assert.equal(targetStat.nlink, 1);
  await fs.writeFile(copiedPath, 'employee changed working copy');
  assert.deepEqual(await fs.readFile(snapshot), bytes);
  await assert.rejects(f.service.materialize({ sessionId: 'group-a', attachmentIds: [attachment.id], cwd: f.cwd, taskId }), { status: 409 });
  assert.equal(await fs.readFile(copiedPath, 'utf8'), 'employee changed working copy');
  const [second] = await f.service.materialize({ sessionId: 'group-a', attachmentIds: [attachment.id], cwd: f.cwd, taskId: randomUUID() });
  assert.notEqual(second.path, copiedPath); assert.deepEqual(await fs.readFile(second.path), bytes);
});

test('materialize validates group, task, size and attachment IDs before exposing any private path', async () => {
  const f = await filesFixture(); const attachment = await upload(f.service, 'input.txt', [Buffer.from('input')]);
  const base = { sessionId: 'group-a', attachmentIds: [attachment.id], cwd: f.cwd, taskId: 'task-1' };
  for (const patch of [{ sessionId: '../outside' }, { sessionId: undefined }, { taskId: '../outside' }, { taskId: 'x:y' }, { taskId: 'x'.repeat(129) }, { taskId: undefined },
    { attachmentIds: [attachment.id, attachment.id] }, { attachmentIds: Array.from({ length: 11 }, () => randomUUID()) }, { attachmentIds: ['../../private'] }]) {
    await assert.rejects(f.service.materialize({ ...base, ...patch }), error => error.status === 400 && !error.message.includes(f.directory));
  }
  await assert.rejects(f.service.materialize({ ...base, sessionId: 'group-b' }), { status: 404 });
  await assert.rejects(f.service.materialize({ ...base, attachmentIds: [randomUUID()] }), { status: 404 });
  await assert.rejects(f.service.materialize({ ...base, cwd: f.directory }), { status: 403 });
  await assert.rejects(f.service.materialize({ ...base, cwd: f.store.directory }), { status: 403 });
  await assert.rejects(f.service.materialize({ ...base, cwd: 'relative' }), { status: 400 });
  assert.deepEqual(await fs.readdir(f.cwd), []);
});

test('materialize accepts ten distinct attachments and makes Windows reserved names safe', async () => {
  const f = await filesFixture();
  const names = ['CON.txt', 'PRN.csv', 'AUX.pdf', 'NUL', 'COM1.txt', 'LPT9.xlsx', 'a:b.txt', 'a<q>"|?*.txt', 'report.csv. ', '../../客户报表.csv'];
  const attachments = [];
  for (const name of names) attachments.push(await upload(f.service, name, [Buffer.from(name)]));
  const copies = await f.service.materialize({ sessionId: 'group-a', attachmentIds: attachments.map(value => value.id), cwd: f.cwd, taskId: 'ten-files' });
  assert.equal(copies.length, 10);
  for (let index = 0; index < copies.length; index++) {
    assert.equal(await fs.readFile(copies[index].path, 'utf8'), names[index]);
    assert.ok(path.basename(copies[index].path).startsWith(`${attachments[index].id}-`));
    assert.doesNotMatch(path.basename(copies[index].path), /[<>:"/\\|?*]|[ .]$/);
  }
});

test('materialize rejects junctions at every private inbox path segment without writing to their target', async () => {
  const f = await filesFixture(); const attachment = await upload(f.service, 'input.txt', [Buffer.from('input')]);
  const outside = path.join(f.directory, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'sentinel.txt'), 'untouched');
  const segments = ['attachment-inbox', 'group-a', 'task-1', attachment.id];
  for (let depth = 0; depth < segments.length; depth++) {
    const parent = path.join(f.store.directory, ...segments.slice(0, depth)); await fs.mkdir(parent, { recursive: true });
    const linked = path.join(parent, segments[depth]);
    await fs.symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(f.service.materialize({ sessionId: 'group-a', attachmentIds: [attachment.id], cwd: f.cwd, taskId: 'task-1' }), { status: 403 });
    await fs.unlink(linked);
    assert.deepEqual(await fs.readdir(outside), ['sentinel.txt']);
    assert.equal(await fs.readFile(path.join(outside, 'sentinel.txt'), 'utf8'), 'untouched');
  }
});

test('materialize rejects hardlinked snapshots and existing hardlinked destinations', async () => {
  const f = await filesFixture(); const attachment = await upload(f.service, 'input.txt', [Buffer.from('private snapshot')]);
  const snapshot = path.join(f.service.directory, `${attachment.id}.bin`), alias = path.join(f.directory, 'snapshot-alias.txt');
  await fs.link(snapshot, alias);
  await assert.rejects(f.service.materialize({ sessionId: 'group-a', attachmentIds: [attachment.id], cwd: f.cwd, taskId: 'hard-source' }), { status: 403 });
  await fs.unlink(alias);
  const directory = path.join(f.store.directory, 'attachment-inbox', 'group-a', 'hard-target', attachment.id); await fs.mkdir(directory, { recursive: true });
  const outside = path.join(f.directory, 'outside.txt'); await fs.writeFile(outside, 'must not overwrite');
  const target = path.join(directory, `${attachment.id}-input.txt`); await fs.link(outside, target);
  await assert.rejects(f.service.materialize({ sessionId: 'group-a', attachmentIds: [attachment.id], cwd: f.cwd, taskId: 'hard-target' }), { status: 409 });
  assert.equal(await fs.readFile(outside, 'utf8'), 'must not overwrite'); assert.equal(await fs.readFile(target, 'utf8'), 'must not overwrite');
});

test('materialize revocation during copy rolls back all task copies and retains immutable originals', async () => {
  const f = await filesFixture();
  const first = await upload(f.service, 'first.txt', [Buffer.from('first')]);
  const second = await upload(f.service, 'second.bin', [Buffer.alloc(256 * 1024, 7)]);
  let checks = 0;
  await assert.rejects(f.service.materialize({ sessionId: 'group-a', attachmentIds: [first.id, second.id], cwd: f.cwd, taskId: 'revoked',
    authorize() { if (++checks === 11) throw new HttpError(403, 'Materialization revoked'); } }), { status: 403 });
  const root = path.join(f.store.directory, 'attachment-inbox', 'group-a', 'revoked');
  const remaining = [];
  async function files(directory) {
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name); if (item.isDirectory()) await files(file); else remaining.push(file);
    }
  }
  await files(root); assert.deepEqual(remaining, []);
  assert.equal((await fs.stat(path.join(f.service.directory, `${first.id}.bin`))).size, first.size);
  assert.equal((await fs.stat(path.join(f.service.directory, `${second.id}.bin`))).size, second.size);
});

test('cleanup removes only manifest-owned copies and preserves immutable snapshots and external files', async () => {
  const f = await filesFixture(), attachment = await upload(f.service, 'input.txt', [Buffer.from('private snapshot')]);
  const files = await f.service.materialize({ sessionId: 'group-a', attachmentIds: [attachment.id], cwd: f.cwd, taskId: 'cleanup' });
  const external = path.join(f.cwd, 'unrelated.txt'); await fs.writeFile(external, 'unrelated');
  const snapshot = path.join(f.service.directory, `${attachment.id}.bin`);
  assert.equal(await f.service.cleanupMaterialized([{ path: external }, { path: snapshot }, ...files]), 1);
  await assert.rejects(fs.stat(files[0].path), { code: 'ENOENT' });
  assert.equal(await fs.readFile(snapshot, 'utf8'), 'private snapshot');
  assert.equal(await fs.readFile(external, 'utf8'), 'unrelated');
  assert.equal(await f.service.cleanupMaterialized(files), 0);
  assert.equal(f.service.materialized.size, 0);
});

test('cleanup leaves replaced files, hard links and junction targets untouched', async () => {
  const f = await filesFixture(), attachment = await upload(f.service, 'input.txt', [Buffer.from('private snapshot')]);
  const materialize = taskId => f.service.materialize({ sessionId: 'group-a', attachmentIds: [attachment.id], cwd: f.cwd, taskId });
  const [replaced] = await materialize('replaced');
  await fs.rename(replaced.path, `${replaced.path}.original`); await fs.writeFile(replaced.path, 'replacement');
  assert.equal(await f.service.cleanupMaterialized([replaced]), 0);
  assert.equal(await fs.readFile(replaced.path, 'utf8'), 'replacement');
  assert.equal(await fs.readFile(`${replaced.path}.original`, 'utf8'), 'private snapshot');
  const [linked] = await materialize('hardlinked');
  const alias = path.join(f.directory, 'external-alias.txt'); await fs.link(linked.path, alias);
  assert.equal(await f.service.cleanupMaterialized([linked]), 0);
  assert.equal(await fs.readFile(alias, 'utf8'), 'private snapshot');
  assert.equal(await fs.readFile(linked.path, 'utf8'), 'private snapshot');
  const [junction] = await materialize('junction');
  const directory = path.dirname(junction.path), retained = `${directory}-retained`;
  await fs.rename(directory, retained);
  const outside = path.join(f.directory, 'outside-cleanup'); await fs.mkdir(outside);
  const outsideFile = path.join(outside, path.basename(junction.path)); await fs.writeFile(outsideFile, 'external replacement');
  await fs.symlink(outside, directory, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await f.service.cleanupMaterialized([junction]), 0);
  assert.equal(await fs.readFile(outsideFile, 'utf8'), 'external replacement');
  assert.equal(await fs.readFile(path.join(retained, path.basename(junction.path)), 'utf8'), 'private snapshot');
});
