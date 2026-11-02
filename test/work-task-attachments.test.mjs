import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { Store } from '../lib/store.mjs';
import { WorkTaskService } from '../lib/work-tasks.mjs';
import { AttachmentService, ATTACHMENT_MAX_BYTES } from '../lib/attachments.mjs';
import { attachmentMarkdown } from '../lib/attachment-output.mjs';
import { HttpError } from '../lib/security.mjs';

const alice = { id: 'alice', displayName: 'Alice', role: 'member' };
const bob = { id: 'bob', displayName: 'Bob', role: 'member' };
const outsider = { id: 'outsider', displayName: 'Outsider', role: 'member' };

function fixture(t, options = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'pi-task-attachments-'));
  const data = path.join(directory, 'data'), workspace = path.join(directory, 'workspace');
  mkdirSync(data); mkdirSync(workspace);
  const store = new Store(data, workspace);
  for (const id of ['group-a', 'group-b']) store.db.prepare('INSERT INTO session_meta VALUES (?,?)').run(id, JSON.stringify({ id, title: id }));
  const members = new Map([['group-a', new Set(['alice', 'bob'])], ['group-b', new Set(['alice', 'outsider'])]]);
  const users = new Map([alice, bob, outsider].map(user => [user.id, { ...user }]));
  const published = [], events = [], resolved = [];
  const attachmentService = new AttachmentService(store);
  const authorize = ({ sessionId, actorId }) => {
    if (!members.get(sessionId)?.has(actorId) || users.get(actorId)?.disabled) throw new HttpError(403, 'Denied');
    return users.get(actorId);
  };
  const callbacks = {
    execute: async () => 'Verified result', authorize,
    resolveAttachments: request => {
      resolved.push(request);
      return request.attachmentIds.map(id => attachmentService.get(id, request.sessionId));
    },
    onMessage: message => published.push(message), onEvent: event => events.push(event), ...options,
  };
  let service = new WorkTaskService(store, callbacks);
  t.after(async () => {
    await service.stop(); store.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('pi-task-attachments-'));
    rmSync(directory, { recursive: true, force: true });
  });
  const add = (patch = {}) => {
    const value = { id: randomUUID(), sessionId: 'group-a', name: '提柜 [核对](1).csv',
      size: 128, mimeType: 'application/octet-stream', kind: 'file', ...patch };
    store.db.prepare('INSERT INTO attachments(id,session_id,name,size,mime_type,kind,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(value.id, value.sessionId, value.name, value.size, value.mimeType, value.kind, '2026-10-30T00:00:00.000Z');
    return attachmentService.get(value.id, value.sessionId);
  };
  return { store, users, members, published, events, resolved, attachmentService, add,
    get service() { return service; },
    async recreate() { await service.stop(); service = new WorkTaskService(store, callbacks); return service; },
    create: patch => service.create({ sessionId: 'group-a', actor: alice, instruction: '核对附件中的预约。', ...patch }),
    message: patch => service.postMessage({ sessionId: 'group-a', actor: alice, content: '请同事核对资料。', ...patch }),
  };
}

async function idle(service) {
  for (let n = 0; n < 100 && service.active.size; n++) await delay(5);
  assert.equal(service.active.size, 0);
}

test('AI task keeps instruction separate and persists only server-resolved public file references', t => {
  const f = fixture(t), file = f.add(), image = f.add({ name: '截图.png', kind: 'image', mimeType: 'image/png', size: 256 });
  const task = f.create({ actor: { ...alice, role: 'admin', displayName: 'Forged Admin' }, attachmentIds: [file.id, image.id],
    attachments: [{ id: file.id, name: 'forged', url: 'https://example.invalid/private', path: 'C:/secret' }] });
  assert.equal(task.instruction, '核对附件中的预约。');
  assert.deepEqual(task.attachments, [file, image]);
  assert.equal(f.resolved[0].actor.displayName, 'Alice');
  assert.equal(f.resolved[0].actor.role, 'member');
  const [message] = f.service.messages('group-a', bob);
  assert.equal(message.content, `${task.instruction}\n\n${attachmentMarkdown(file)}\n\n${attachmentMarkdown(image)}`);
  assert.deepEqual(message.attachments, [file, image]);
  assert.equal(message.authorName, 'Alice');
  assert.equal(f.published.length, 1); assert.equal(f.events.length, 1);
  assert.ok(!JSON.stringify(task).includes('C:/secret'));
  assert.ok(!JSON.stringify(message).includes('example.invalid'));
});

test('file-only discussion is a real group message and never starts AI', t => {
  let calls = 0;
  const f = fixture(t, { execute: async () => { calls++; return 'Must not run'; } }), file = f.add();
  const message = f.message({ content: '', attachmentIds: [file.id], mentions: ['bob'] });
  assert.equal(message.content, attachmentMarkdown(file));
  assert.deepEqual(message.attachments, [file]);
  assert.deepEqual(message.mentions, ['bob']);
  assert.equal(f.service.tick(), 0); assert.equal(calls, 0);
});

test('file-only task has a usable default instruction and passes durable references to its worker after restart', async t => {
  const inputs = [];
  const f = fixture(t, { execute: async request => { inputs.push(request); return 'Read fixture input'; } }), file = f.add();
  const task = f.create({ instruction: undefined, attachmentIds: [file.id] });
  assert.match(task.instruction, /附件/);
  assert.ok(!task.instruction.includes(file.url));
  assert.equal(f.service.messages('group-a', alice)[0].content, attachmentMarkdown(file));
  await f.recreate();
  assert.deepEqual(f.service.get('group-a', task.id, bob).attachments, [file]);
  f.service.tick(); await idle(f.service);
  assert.equal(inputs.length, 1); assert.equal(inputs[0].actor.id, alice.id);
  assert.deepEqual(inputs[0].task.attachments, [file]);
  assert.equal(f.service.get('group-a', task.id, alice).status, 'succeeded');
});

test('attachment ids are bounded string arrays and rejected before resolution or persistence', t => {
  const f = fixture(t);
  for (const attachmentIds of [null, 'file', {}, [null], [123], [{}], ['../private'], new Array(1), Array.from({ length: 11 }, () => randomUUID())]) {
    assert.throws(() => f.create({ attachmentIds }), { status: 400 });
    assert.throws(() => f.message({ attachmentIds }), { status: 400 });
  }
  assert.equal(f.resolved.length, 0);
  assert.equal(f.service.list('group-a', alice).total, 0);
  assert.equal(f.service.messageCount('group-a'), 0);
  assert.throws(() => f.create({ instruction: '', attachmentIds: [] }), { status: 400 });
  assert.throws(() => f.message({ content: undefined, attachmentIds: [] }), { status: 400 });
});

test('missing or async resolution cannot silently accept uploaded file ids', t => {
  const f = fixture(t, { resolveAttachments: undefined }), file = f.add();
  assert.throws(() => f.create({ attachmentIds: [file.id] }), { status: 400 });
  assert.throws(() => f.message({ attachmentIds: [file.id] }), { status: 400 });
  f.service.resolveAttachments = async () => [file];
  assert.throws(() => f.create({ attachmentIds: [file.id] }), TypeError);
  assert.equal(f.service.messageCount('group-a'), 0);
  assert.deepEqual(f.create().attachments, []);
});

test('non-members cannot resolve files and attachment lookup remains scoped to the current group', t => {
  const f = fixture(t), foreign = f.add({ sessionId: 'group-b' });
  assert.throws(() => f.create({ actor: outsider, attachmentIds: [foreign.id] }), { status: 403 });
  assert.equal(f.resolved.length, 0);
  assert.throws(() => f.create({ attachmentIds: [foreign.id] }), { status: 404 });
  assert.throws(() => f.message({ attachmentIds: [randomUUID()] }), { status: 404 });
  assert.equal(f.service.messageCount('group-a'), 0);
});

test('resolved metadata is rechecked for size, exact ids, safe links and bounded display fields', t => {
  const f = fixture(t), file = f.add();
  const malformed = [null, {}, [{ ...file, id: randomUUID() }], [file, file],
    [{ ...file, name: '' }], [{ ...file, name: '../secret.csv' }], [{ ...file, name: 'x\n.csv' }],
    [{ ...file, size: -1 }], [{ ...file, size: 1.5 }], [{ ...file, size: NaN }],
    [{ ...file, kind: 'html' }], [{ ...file, mimeType: 'text/plain\r\nInjected: true' }],
    [{ ...file, kind: 'image' }], [{ ...file, url: 'javascript:alert(1)' }],
    [{ ...file, url: file.url.replace('group-a', 'group-b') }], [{ ...file, downloadUrl: 'https://example.invalid/file' }]];
  for (const value of malformed) {
    f.service.resolveAttachments = () => value;
    assert.throws(() => f.create({ attachmentIds: [file.id] }), { status: 400 });
  }
  f.service.resolveAttachments = () => [{ ...file, size: ATTACHMENT_MAX_BYTES + 1 }];
  assert.throws(() => f.create({ attachmentIds: [file.id] }), { status: 413 });
  assert.equal(f.service.list('group-a', alice).total, 0);
  assert.equal(f.service.messageCount('group-a'), 0);
});

test('ten files are allowed, duplicate ids are collapsed and callback metadata cannot add private paths', t => {
  const f = fixture(t), files = Array.from({ length: 10 }, (_, index) => f.add({ name: `file-${index}.bin`, size: ATTACHMENT_MAX_BYTES }));
  const source = files.map(file => ({ ...file, path: 'C:/private/snapshot.bin', sourcePath: 'C:/secret', secret: 'unused' }));
  f.service.resolveAttachments = ({ attachmentIds }) => attachmentIds.map(id => source.find(item => item.id === id)).reverse();
  const task = f.create({ attachmentIds: files.map(file => file.id) });
  assert.deepEqual(task.attachments, files);
  source[0].name = 'Changed after commit'; task.attachments[0].name = 'Changed returned value';
  assert.deepEqual(f.service.get('group-a', task.id, alice).attachments, files);
  assert.ok(!JSON.stringify(f.service.get('group-a', task.id, alice)).includes('C:/private'));
  const message = f.message({ attachmentIds: [files[1].id, files[1].id] });
  assert.deepEqual(message.attachments, [files[1]]);
  assert.equal(message.content.split(files[1].url).length - 1, 1);
});

test('idempotent retries return original files without resolving changed ids or duplicating events', t => {
  const f = fixture(t), file = f.add();
  const task = f.create({ clientRequestId: 'task-upload-request', attachmentIds: [file.id] });
  const message = f.message({ clientRequestId: 'discussion-upload-request', attachmentIds: [file.id] });
  const count = f.resolved.length, events = f.events.length, published = f.published.length;
  const retry = f.create({ instruction: 'Changed retry', clientRequestId: 'task-upload-request', attachmentIds: ['../invalid'] });
  assert.equal(retry.id, task.id); assert.deepEqual(retry.attachments, [file]);
  assert.equal(f.message({ clientRequestId: 'discussion-upload-request', attachmentIds: [randomUUID()] }).id, message.id);
  assert.equal(f.resolved.length, count); assert.equal(f.events.length, events); assert.equal(f.published.length, published);
  f.members.get('group-a').delete(alice.id);
  assert.throws(() => f.create({ clientRequestId: 'task-upload-request' }), { status: 403 });
});

test('explicitly quoting a file inherits and revalidates only that message attachments', t => {
  const f = fixture(t), first = f.add(), second = f.add({ name: 'other.csv' });
  const original = f.message({ content: '', attachmentIds: [first.id] });
  f.message({ attachmentIds: [second.id] });
  const inherited = f.create({ instruction: '分析引用的文件。', replyTo: original.id, attachmentIds: [] });
  assert.deepEqual(inherited.attachments, [first]);
  assert.deepEqual(f.resolved.at(-1).attachmentIds, [first.id]);
  const message = f.service.messages('group-a', alice).find(item => item.workTaskId === inherited.id);
  assert.deepEqual(message.replySnapshot.attachments, [first]);
  const explicit = f.create({ replyTo: original.id, attachmentIds: [second.id] });
  assert.deepEqual(explicit.attachments, [second]);
  assert.deepEqual(f.create().attachments, [], 'unrelated recent files are never inherited');
  const discussion = f.message({ replyTo: original.id });
  assert.deepEqual(discussion.replySnapshot.attachments, [first]);
  assert.deepEqual(discussion.attachments, [], 'discussion quote does not resend files');
});

test('quoted files must still exist and belong to the resolved group before a new task is accepted', t => {
  const f = fixture(t), file = f.add();
  const original = f.message({ attachmentIds: [file.id] });
  f.store.db.prepare('DELETE FROM attachments WHERE id=?').run(file.id);
  assert.throws(() => f.create({ replyTo: original.id }), { status: 404 });
  assert.throws(() => f.create({ sessionId: 'group-b', replyTo: original.id }), { status: 404 });
  assert.equal(f.service.list('group-a', alice).total, 0);
  assert.equal(f.service.messageCount('group-a'), 1);
});

test('legacy reply resolver can provide validated file snapshots and inherited ids', t => {
  let snapshot;
  const f = fixture(t, { resolveReply: ({ sessionId, replyTo }) => sessionId === 'group-a' && replyTo === 'pi:history-file'
    ? { id: replyTo, content: 'Historical file', authorName: 'Historical Alice', attachments: [snapshot] } : null });
  const file = f.add(); snapshot = { ...file, path: 'C:/private/source.bin' };
  const task = f.create({ replyTo: 'pi:history-file' });
  assert.deepEqual(task.attachments, [file]);
  assert.deepEqual(f.service.messages('group-a', alice)[0].replySnapshot.attachments, [file]);
  assert.ok(!JSON.stringify(f.service.messages('group-a', alice)).includes('C:/private'));
  snapshot = { ...file, url: file.url.replace('group-a', 'group-b') };
  assert.throws(() => f.create({ replyTo: 'pi:history-file' }), { status: 400 });
});

test('existing rows migrate to empty attachment arrays without changing task or message identity', async t => {
  const f = fixture(t), task = f.create(), message = f.message();
  await f.service.stop();
  f.store.db.exec('ALTER TABLE work_tasks DROP COLUMN attachments_json; ALTER TABLE collaboration_messages DROP COLUMN attachments_json;');
  await f.recreate();
  const restored = f.service.get('group-a', task.id, alice);
  assert.equal(restored.id, task.id); assert.equal(restored.instruction, task.instruction);
  assert.deepEqual(restored.attachments, []);
  assert.deepEqual(f.service.messages('group-a', alice).find(item => item.id === message.id).attachments, []);
  for (const table of ['work_tasks', 'collaboration_messages']) {
    const column = f.store.db.prepare(`PRAGMA table_info(${table})`).all().find(item => item.name === 'attachments_json');
    assert.equal(column.notnull, 1); assert.equal(column.dflt_value, "'[]'");
  }
});

test('maximum-length user text retains complete generated attachment links', t => {
  const f = fixture(t), file = f.add(), instruction = 'A'.repeat(100000);
  const task = f.create({ instruction, attachmentIds: [file.id] });
  assert.equal(task.instruction, instruction);
  const [message] = f.service.messages('group-a', alice);
  assert.ok(message.content.endsWith(attachmentMarkdown(file)));
  assert.equal(message.content, `${instruction}\n\n${attachmentMarkdown(file)}`);
});

test('failed initial message insertion rolls back task, attachment reference and event together', t => {
  const f = fixture(t), file = f.add();
  f.store.db.exec("CREATE TRIGGER fail_fixture_message BEFORE INSERT ON collaboration_messages BEGIN SELECT RAISE(ABORT,'fixture message rejected'); END;");
  assert.throws(() => f.create({ attachmentIds: [file.id] }), /fixture message rejected/);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM work_tasks').get().count, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM work_task_events').get().count, 0);
  assert.equal(f.published.length, 0); assert.equal(f.events.length, 0);
});
