import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { AttachmentService, ATTACHMENT_MAX_BYTES } from '../lib/attachments.mjs';
import { Store } from '../lib/store.mjs';
import { HttpError } from '../lib/security.mjs';

const fixtures = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.store.close();
    const relative = path.relative(os.tmpdir(), f.directory);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(f.directory, { recursive: true, force: true });
  }
});

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-attachments-'));
  const cwd = path.join(directory, 'workspace with spaces');
  await fs.mkdir(cwd);
  const store = new Store(path.join(directory, '.data'), cwd);
  store.sessions.push({ id: 'group-a', title: 'Test group A' }, { id: 'group-b', title: 'Test group B' });
  store.saveSessions();
  const service = new AttachmentService(store);
  const f = { directory, cwd, store, service };
  fixtures.push(f);
  return f;
}

class Response extends Writable {
  constructor() { super(); this.headers = {}; this.chunks = []; this.statusCode = undefined; }
  setHeader(name, value) { this.headers[name.toLowerCase()] = value; }
  writeHead(status, headers = {}) { this.statusCode = status; for (const [name, value] of Object.entries(headers)) this.setHeader(name, value); return this; }
  _write(chunk, _encoding, callback) { this.chunks.push(Buffer.from(chunk)); callback(); }
  get body() { return Buffer.concat(this.chunks); }
}

async function serve(service, attachment, { method = 'GET', download = false, sessionId = 'group-a' } = {}) {
  const response = new Response();
  await service.serve({ method, url: download ? attachment.downloadUrl : attachment.url }, response, { sessionId, id: attachment.id });
  return response;
}

test('publishes private immutable snapshots with group-scoped public metadata', async () => {
  const f = await fixture();
  const file = path.join(f.cwd, '报表.csv');
  await fs.writeFile(file, 'id,total\n1,42\n');
  const published = await f.service.publish({ sessionId: 'group-a', cwd: f.cwd, filePath: '报表.csv' });
  assert.equal(published.name, '报表.csv');
  assert.equal(published.size, 14);
  assert.equal(published.kind, 'file');
  assert.equal(published.mimeType, 'application/octet-stream');
  assert.match(published.id, /^[a-f0-9-]{36}$/);
  assert.equal(published.url, `/api/sessions/group-a/attachments/${published.id}`);
  assert.equal(published.downloadUrl, `${published.url}?download=1`);
  assert.deepEqual(f.service.get(published.id, 'group-a'), published);
  assert.deepEqual(Object.keys(published).sort(), ['downloadUrl', 'id', 'kind', 'mimeType', 'name', 'size', 'url']);
  await fs.writeFile(file, 'changed original');
  await fs.rm(file);
  const response = await serve(f.service, published);
  assert.equal(response.body.toString(), 'id,total\n1,42\n');
  assert.equal(response.headers['content-type'], 'application/octet-stream');
  assert.match(response.headers['content-disposition'], /^attachment;/);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.deepEqual(await fs.readdir(f.service.directory), [`${published.id}.bin`]);
  const restarted = new AttachmentService(f.store);
  assert.deepEqual(restarted.get(published.id, 'group-a'), published);
});

test('only signature-confirmed PNG, JPEG, GIF and WebP are inline images', async () => {
  const f = await fixture();
  const images = [
    ['png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')],
    ['jpeg', Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex')],
    ['gif', Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')],
    ['webp', Buffer.from('52494646140000005745425056503820080000000000000000000000', 'hex')],
  ];
  for (const [type, data] of images) {
    const filePath = `${type}.txt`;
    await fs.writeFile(path.join(f.cwd, filePath), data);
    const attachment = await f.service.publish({ sessionId: 'group-a', cwd: f.cwd, filePath });
    assert.equal(attachment.kind, 'image');
    assert.equal(attachment.mimeType, `image/${type}`);
    const inline = await serve(f.service, attachment);
    assert.equal(inline.headers['content-type'], `image/${type}`);
    assert.match(inline.headers['content-disposition'], /^inline;/);
    assert.deepEqual(inline.body, data);
    assert.match((await serve(f.service, attachment, { download: true })).headers['content-disposition'], /^attachment;/);
  }
});

test('fake PNGs, SVG and HTML are ordinary forced-download files', async () => {
  const f = await fixture();
  for (const [filePath, content] of [['fake.png', '<html><script>alert(1)</script></html>'], ['drawing.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'], ['index.html', '<!doctype html><h1>unsafe</h1>']]) {
    await fs.writeFile(path.join(f.cwd, filePath), content);
    const attachment = await f.service.publish({ sessionId: 'group-a', cwd: f.cwd, filePath });
    assert.equal(attachment.kind, 'file');
    assert.equal(attachment.mimeType, 'application/octet-stream');
    const response = await serve(f.service, attachment);
    assert.equal(response.headers['content-type'], 'application/octet-stream');
    assert.match(response.headers['content-disposition'], /^attachment;/);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
  }
});

test('rejects relative and absolute path escapes and non-file sources', async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.directory, 'outside.txt'), 'outside');
  for (const filePath of ['../outside.txt', path.join(f.directory, 'outside.txt')]) await assert.rejects(f.service.publish({ sessionId: 'group-a', cwd: f.cwd, filePath }), { status: 403 });
  await assert.rejects(f.service.publish({ sessionId: 'group-a', cwd: f.cwd, filePath: '.' }), { status: 400 });
  await assert.rejects(f.service.publish({ sessionId: 'group-a', cwd: f.cwd, filePath: 'absent.txt' }), { status: 404 });
  await assert.rejects(f.service.publish({ sessionId: 'group-a', cwd: f.cwd, filePath: 'bad\0.txt' }), { status: 400 });
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM attachments').get().count, 0);
});

test('rejects junction and symbolic-link escapes, including private service data', async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.store.directory, 'private.txt'), 'PRIVATE SERVICE DATA');
  const link = path.join(f.cwd, 'private-link');
  await fs.symlink(f.store.directory, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.service.publish({ sessionId: 'group-a', cwd: f.cwd, filePath: path.join('private-link', 'private.txt') }), { status: 403 });
  assert.deepEqual(await fs.readdir(f.service.directory), []);
});

test('rejects workspaces containing service data or located inside it', async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.directory, 'outside.txt'), 'outside');
  await fs.writeFile(path.join(f.store.directory, 'private.txt'), 'PRIVATE SERVICE DATA');
  await assert.rejects(f.service.publish({ sessionId: 'group-a', cwd: f.directory, filePath: 'outside.txt' }), { status: 403 });
  await assert.rejects(f.service.publish({ sessionId: 'group-a', cwd: f.store.directory, filePath: 'private.txt' }), { status: 403 });
});

test('rejects hard links that could alias private data', async () => {
  const f = await fixture();
  const privateFile = path.join(f.store.directory, 'private.txt');
  await fs.writeFile(privateFile, 'PRIVATE SERVICE DATA');
  await fs.link(privateFile, path.join(f.cwd, 'linked.txt'));
  await assert.rejects(f.service.publish({ sessionId: 'group-a', cwd: f.cwd, filePath: 'linked.txt' }), { status: 403 });
});

test('accepts empty files and rejects oversized sources without retaining snapshots', async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.cwd, 'empty.txt'), '');
  const empty = await f.service.publish({ sessionId: 'group-a', cwd: f.cwd, filePath: 'empty.txt' });
  assert.equal(empty.size, 0);
  assert.equal(empty.kind, 'file');
  assert.equal((await serve(f.service, empty)).body.length, 0);
  const oversized = await fs.open(path.join(f.cwd, 'large.zip'), 'w');
  try { await oversized.truncate(ATTACHMENT_MAX_BYTES + 1); } finally { await oversized.close(); }
  await assert.rejects(f.service.publish({ sessionId: 'group-a', cwd: f.cwd, filePath: 'large.zip' }), { status: 413 });
  assert.deepEqual(await fs.readdir(f.service.directory), [`${empty.id}.bin`]);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM attachments').get().count, 1);
});

test('checks session association and attachment IDs before serving', async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.cwd, 'report.pdf'), 'report');
  const attachment = await f.service.publish({ sessionId: 'group-a', cwd: f.cwd, filePath: 'report.pdf' });
  assert.throws(() => f.service.get(attachment.id, 'group-b'), { status: 404 });
  assert.throws(() => f.service.get('../config.json', 'group-a'), { status: 404 });
  await assert.rejects(serve(f.service, attachment, { sessionId: 'group-b' }), { status: 404 });
  await assert.rejects(f.service.publish({ sessionId: 'absent-group', cwd: f.cwd, filePath: 'report.pdf' }), { status: 404 });
});

test('encodes dangerous and non-ASCII names without header injection', async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.cwd, 'report.pdf'), 'report');
  const attachment = await f.service.publish({ sessionId: 'group-a', cwd: f.cwd, filePath: 'report.pdf', name: '../../客户报表";\r\nX-Injected: yes.pdf' });
  assert.equal(attachment.name, '客户报表";X-Injected: yes.pdf');
  const response = await serve(f.service, attachment);
  const header = response.headers['content-disposition'];
  assert.ok(!/[\r\n]/.test(header));
  assert.match(header, /^attachment; filename="[^"\\]*"; filename\*=UTF-8''/);
  assert.ok(header.includes(encodeURIComponent(attachment.name)));
  assert.ok(Object.keys(response.headers).every(name => name !== 'x-injected'));
  const oddName = await f.service.publish({ sessionId: 'group-a', cwd: f.cwd, filePath: 'report.pdf', name: '\ud800.pdf' });
  assert.ok((await serve(f.service, oddName)).headers['content-disposition'].includes('%EF%BF%BD'));
});

test('HEAD returns private metadata headers without a body, other methods are refused', async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.cwd, 'report.pdf'), 'actual bytes');
  const attachment = await f.service.publish({ sessionId: 'group-a', cwd: f.cwd, filePath: 'report.pdf' });
  const response = await serve(f.service, attachment, { method: 'HEAD' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-length'], 12);
  assert.equal(response.body.length, 0);
  await assert.rejects(serve(f.service, attachment, { method: 'POST' }), { status: 405 });
});

test('cleans snapshots when metadata insertion fails', async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.cwd, 'report.pdf'), 'actual bytes');
  f.store.db.exec("CREATE TRIGGER reject_attachment BEFORE INSERT ON attachments BEGIN SELECT RAISE(ABORT,'fixture reject'); END;");
  await assert.rejects(f.service.publish({ sessionId: 'group-a', cwd: f.cwd, filePath: 'report.pdf' }), { status: 500 });
  assert.deepEqual(await fs.readdir(f.service.directory), []);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM attachments').get().count, 0);
});

test('does not follow a substituted storage directory or snapshot symlink', async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.cwd, 'report.pdf'), 'actual bytes');
  const attachment = await f.service.publish({ sessionId: 'group-a', cwd: f.cwd, filePath: 'report.pdf' });
  await fs.rm(path.join(f.service.directory, `${attachment.id}.bin`));
  await assert.rejects(serve(f.service, attachment), { status: 404 });
  await fs.rmdir(f.service.directory);
  await fs.symlink(f.cwd, f.service.directory, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => new AttachmentService(f.store), { status: 403 });
  await assert.rejects(f.service.publish({ sessionId: 'group-a', cwd: f.cwd, filePath: 'report.pdf' }), { status: 403 });
});

test('rechecks authorization after asynchronous snapshot work before publishing metadata', async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.cwd, 'report.pdf'), 'actual bytes');
  let calls = 0;
  await assert.rejects(f.service.publish({ sessionId: 'group-a', cwd: f.cwd, filePath: 'report.pdf', authorize() {
    if (++calls === 2) throw new HttpError(403, 'Group access revoked.');
  } }), { status: 403 });
  assert.equal(calls, 2);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM attachments').get().count, 0);
  assert.deepEqual(await fs.readdir(f.service.directory), []);
});

test('rechecks authorization after opening a snapshot and sends no bytes or headers on revocation', async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.cwd, 'report.pdf'), 'actual bytes');
  const attachment = await f.service.publish({ sessionId: 'group-a', cwd: f.cwd, filePath: 'report.pdf' });
  const response = new Response();
  let calls = 0;
  await assert.rejects(f.service.serve({ method: 'GET', url: attachment.url }, response, { sessionId: 'group-a', id: attachment.id, authorize() {
    if (++calls === 2) throw new HttpError(403, 'Group access revoked.');
  } }), { status: 403 });
  assert.equal(calls, 2);
  assert.equal(response.statusCode, undefined);
  assert.deepEqual(response.headers, {});
  assert.equal(response.body.length, 0);
});
