import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { Store } from '../lib/store.mjs';
import { WorkTaskService } from '../lib/work-tasks.mjs';
import { HttpError } from '../lib/security.mjs';

const alice = { id: 'alice', displayName: 'Alice', role: 'member' };
const bob = { id: 'bob', displayName: 'Bob', role: 'member' };
const admin = { id: 'admin', displayName: 'Admin', role: 'admin' };
const outsider = { id: 'outsider', displayName: 'Outsider', role: 'member' };
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function until(predicate) {
  for (let i = 0; i < 250; i++) { if (predicate()) return; await delay(5); }
  assert.ok(predicate(), 'Expected asynchronous state change');
}
function fixture(t, options = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'pi-work-tasks-'));
  const store = new Store(directory, directory);
  for (const id of ['group-a', 'group-b']) store.db.prepare('INSERT INTO session_meta VALUES (?,?)').run(id, JSON.stringify({ id, title: id }));
  const users = new Map([alice, bob, admin, outsider].map(user => [user.id, { ...user }]));
  const memberships = new Map([['group-a', new Set(['alice', 'bob', 'admin'])], ['group-b', new Set(['alice', 'outsider', 'admin'])]]);
  const messages = [], events = [], checks = [];
  const authorize = ({ sessionId, actorId, phase }) => {
    checks.push({ sessionId, actorId, phase });
    const user = users.get(actorId);
    if (!user || user.disabled || !memberships.get(sessionId)?.has(actorId)) throw new HttpError(403, 'Denied');
    return user;
  };
  let service = new WorkTaskService(store, { execute: async () => ({ result: 'Verified fixture result' }), authorize,
    onMessage: message => messages.push(message), onEvent: event => events.push(event), ...options });
  t.after(async () => {
    await service.stop(); store.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('pi-work-tasks-'));
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, users, memberships, messages, events, checks, authorize,
    get service() { return service; },
    recreate() { service = new WorkTaskService(store, { execute: async () => ({ result: 'Recreated result' }), authorize, ...options }); return service; },
    create(patch = {}) { return service.create({ sessionId: 'group-a', actor: alice, instruction: 'Run isolated fixture work.', ...patch }); },
  };
}

test('persists real actors, skills, task events and one initial group message atomically', t => {
  const f = fixture(t), task = f.create({ actor: { ...alice, displayName: 'Forged Admin', role: 'admin' }, assigneeId: bob.id, skillId: 'skill-a' });
  assert.equal(task.status, 'queued'); assert.equal(task.createdByName, 'Alice'); assert.equal(task.assigneeName, 'Bob'); assert.equal(task.skillId, 'skill-a');
  assert.equal(task.events.length, 1); assert.equal(task.events[0].actorId, alice.id);
  const messages = f.service.messages('group-a', bob);
  assert.equal(messages.length, 1); assert.equal(messages[0].role, 'user'); assert.equal(messages[0].authorName, 'Alice'); assert.equal(messages[0].workTaskId, task.id);
  assert.equal(f.messages.length, 1); assert.equal(f.events.length, 1);
});

test('group-scoped reads, mutation rights and canonical actor roles prevent cross-group access', t => {
  const f = fixture(t), task = f.create();
  assert.throws(() => f.service.get('group-b', task.id, alice), { status: 404 });
  assert.throws(() => f.service.list('group-a', outsider), { status: 403 });
  assert.throws(() => f.service.messages('group-a', outsider), { status: 403 });
  assert.throws(() => f.service.cancel('group-a', task.id, { ...bob, role: 'admin' }), { status: 403 });
  assert.equal(f.service.cancel('group-a', task.id, admin).status, 'cancelled');
});

test('clientRequestId deduplicates tasks and initial messages without duplicate notifications', t => {
  const f = fixture(t), first = f.create({ clientRequestId: 'request-a' });
  const duplicate = f.create({ instruction: 'Changed retry payload', clientRequestId: 'request-a' });
  assert.equal(duplicate.id, first.id); assert.equal(duplicate.instruction, first.instruction);
  assert.equal(f.service.list('group-a', alice).total, 1); assert.equal(f.messages.length, 1);
  assert.notEqual(f.create({ actor: bob, clientRequestId: 'request-a' }).id, first.id);
});

test('ordinary discussions persist without invoking AI, with safe references and genuine mentions', t => {
  let calls = 0;
  const f = fixture(t, { execute: async () => { calls++; return { result: 'No invocation expected' }; } });
  const first = f.service.postMessage({ sessionId: 'group-a', actor: alice, content: 'Business discussion', clientRequestId: 'msg-a' });
  const second = f.service.postMessage({ sessionId: 'group-a', actor: bob, content: 'I will check.', replyTo: first.id, mentions: ['alice', 'agent', 'alice'] });
  assert.deepEqual(second.mentions, ['alice', 'agent']); assert.equal(second.replySnapshot.content, 'Business discussion');
  assert.equal(f.service.postMessage({ sessionId: 'group-a', actor: alice, content: 'Retry', clientRequestId: 'msg-a' }).id, first.id);
  assert.equal(f.service.tick(), 0); assert.equal(calls, 0);
  assert.throws(() => f.service.postMessage({ sessionId: 'group-b', actor: alice, content: 'Cross group', replyTo: first.id }), { status: 404 });
  assert.throws(() => f.service.postMessage({ sessionId: 'group-a', actor: alice, content: 'Outside mention', mentions: ['outsider'] }), { status: 403 });
  assert.throws(() => f.service.postMessage({ sessionId: 'group-a', actor: alice, content: 'Invalid', mentions: 'alice' }), { status: 400 });
});

test('legacy reply resolver must confirm the same reference and produces a bounded snapshot', t => {
  const f = fixture(t, { resolveReply: ({ sessionId, replyTo, actor }) => sessionId === 'group-a' && replyTo === 'pi:legacy-a' && actor.id === alice.id
    ? { id: replyTo, content: 'x'.repeat(900), authorName: 'Legacy author' } : null });
  const message = f.service.postMessage({ sessionId: 'group-a', actor: alice, content: 'Legacy reply', replyTo: 'pi:legacy-a' });
  assert.equal(message.replySnapshot.content.length, 500);
  assert.equal(message.replySnapshot.authorName, 'Legacy author');
  assert.throws(() => f.service.postMessage({ sessionId: 'group-b', actor: alice, content: 'No cross group', replyTo: 'pi:legacy-a' }), { status: 404 });
});

test('one group is FIFO and independent groups execute concurrently, always as current creator', async t => {
  const gates = new Map(), started = [], actors = [];
  const f = fixture(t, { execute: ({ task, actor }) => { started.push(task.id); actors.push(actor); const gate = deferred(); gates.set(task.id, gate); return gate.promise; } });
  const first = f.create(), second = f.create(), third = f.create({ sessionId: 'group-b', actor: outsider });
  assert.equal(f.service.tick(), 2); await until(() => started.length === 2);
  assert.deepEqual(new Set(started), new Set([first.id, third.id]));
  assert.equal(f.service.get('group-a', second.id, alice).status, 'queued');
  gates.get(first.id).resolve({ result: 'First result' });
  await until(() => !f.service.active.has('group-a'));
  f.service.tick(); await until(() => started.length === 3);
  assert.equal(started[2], second.id); assert.deepEqual(actors.map(actor => actor.id).sort(), ['alice', 'alice', 'outsider']);
  gates.get(second.id).resolve({ result: 'Second result' }); gates.get(third.id).resolve({ result: 'Other group' });
  await until(() => f.service.active.size === 0);
  const final = f.service.get('group-a', first.id, alice);
  assert.equal(final.status, 'succeeded'); assert.equal(final.result, 'First result'); assert.equal(final.progress, 100);
  assert.equal(f.messages.filter(message => message.role === 'assistant' && message.workTaskId === first.id).length, 1);
});

test('dispatch rechecks disabled creator and revoked assignee before running', async t => {
  let executions = 0;
  const f = fixture(t, { execute: async () => { executions++; return 'Unexpected execution'; } });
  const first = f.create(); f.users.get(alice.id).disabled = true;
  assert.equal(f.service.tick(), 0); assert.equal(executions, 0);
  f.users.get(alice.id).disabled = false;
  assert.equal(f.service.get('group-a', first.id, alice).status, 'failed');
  const second = f.create({ assigneeId: bob.id }); f.memberships.get('group-a').delete(bob.id);
  f.service.tick(); await delay(10);
  assert.equal(executions, 0); assert.equal(f.service.get('group-a', second.id, alice).status, 'failed');
});

test('queued cancellation prevents execution and running cancellation aborts without late output', async t => {
  const gate = deferred(); let signal;
  const f = fixture(t, { execute: input => { signal = input.signal; return gate.promise; } });
  const first = f.create(), second = f.create();
  f.service.cancel('group-a', second.id, alice); f.service.tick(); await until(() => signal);
  const cancelled = f.service.cancel('group-a', first.id, alice);
  assert.equal(signal.aborted, true); assert.equal(cancelled.status, 'cancelled');
  gate.resolve({ result: 'Must not be published' }); await until(() => f.service.active.size === 0);
  assert.equal(f.service.get('group-a', first.id, alice).result, null);
  assert.equal(f.messages.filter(message => message.role === 'assistant').length, 0);
  assert.equal(f.service.tick(), 0);
});

test('takeover respects existing assignees, aborts AI and requires explicit resume after human input', async t => {
  const gate = deferred(); let signal, calls = 0;
  const f = fixture(t, { execute: input => { calls++; signal = input.signal; return gate.promise; } });
  const task = f.create({ assigneeId: alice.id });
  assert.throws(() => f.service.takeover('group-a', task.id, bob), { status: 409 });
  f.service.tick(); await until(() => signal);
  assert.equal(f.service.takeover('group-a', task.id, alice).status, 'waiting_human'); assert.equal(signal.aborted, true);
  f.service.assign('group-a', task.id, bob.id, alice);
  const supplemented = f.service.supplement('group-a', task.id, 'Human checked the requested scope.', bob);
  assert.equal(supplemented.status, 'waiting_human');
  gate.resolve('Discard aborted output'); await until(() => f.service.active.size === 0);
  f.service.tick(); assert.equal(calls, 1);
  const resumed = f.service.resume('group-a', task.id, bob); assert.equal(resumed.status, 'queued');
  assert.equal(resumed.events.at(-1).actorId, bob.id);
  f.service.cancel('group-a', task.id, bob);
});

test('unassigned work may be claimed by any real group member and manually completed', t => {
  const f = fixture(t), task = f.create();
  const claimed = f.service.takeover('group-a', task.id, bob);
  assert.equal(claimed.status, 'waiting_human'); assert.equal(claimed.assigneeId, bob.id);
  const completed = f.service.complete('group-a', task.id, 'Human verified the actual business result.', bob);
  assert.equal(completed.status, 'succeeded'); assert.equal(completed.progress, 100);
  assert.equal(completed.events.at(-1).actorId, bob.id);
  assert.throws(() => f.service.resume('group-a', task.id, bob), { status: 409 });
  assert.throws(() => f.service.complete('group-a', task.id, 'Repeat', admin), { status: 409 });
});

test('progress and final results use authoritative state and revoke output when permissions change', async t => {
  const gate = deferred(); let progress;
  const f = fixture(t, { execute: ({ onProgress }) => { progress = onProgress; return gate.promise; } });
  const task = f.create(); f.service.tick(); await until(() => progress);
  progress({ progress: 35, message: 'Checked fixture input' });
  assert.equal(f.service.get('group-a', task.id, alice).progress, 35);
  assert.throws(() => progress(101), { status: 400 });
  f.memberships.get('group-a').delete(alice.id);
  gate.resolve({ result: 'Private output after revocation' }); await until(() => f.service.active.size === 0);
  const final = f.service.get('group-a', task.id, admin);
  assert.equal(final.status, 'failed'); assert.equal(final.result, null);
  assert.ok(!f.messages.some(message => message.content.includes('Private output')));
});

test('execution failures and empty outputs are stored truthfully and redacted', async t => {
  const f = fixture(t, { execute: async () => { throw new Error('Fixture failure secret'); }, redact: value => String(value).replaceAll('secret', '[redacted]') });
  const task = f.create(); f.service.tick(); await until(() => f.service.active.size === 0);
  const failed = f.service.get('group-a', task.id, alice);
  assert.equal(failed.status, 'failed'); assert.equal(failed.error, 'Fixture failure [redacted]'); assert.equal(failed.result, null);
  assert.ok(f.messages.some(message => message.role === 'assistant' && message.content.includes('执行失败')));
  assert.ok(failed.events.every(event => !JSON.stringify(event).includes('secret')));
});

test('database restart interrupts in-flight work and never automatically replays it', t => {
  const f = fixture(t), task = f.create();
  f.store.db.prepare("UPDATE work_tasks SET status='running',attempt=1 WHERE id=?").run(task.id);
  const restarted = f.recreate(), persisted = restarted.get('group-a', task.id, alice);
  assert.equal(persisted.status, 'interrupted'); assert.match(persisted.error, /不会|核对/);
  assert.equal(restarted.tick(), 0);
  assert.equal(restarted.resume('group-a', task.id, alice).status, 'queued');
  restarted.cancel('group-a', task.id, alice);
});

test('shutdown aborts and drains running promises before store closure, preserving queued work', async t => {
  let aborted = false;
  const f = fixture(t, { execute: ({ signal }) => new Promise(resolve => signal.addEventListener('abort', () => { aborted = true; setTimeout(() => resolve({ result: 'Aborted result' }), 20); }, { once: true })) });
  const first = f.create(), queued = f.create(); f.service.start();
  await until(() => f.service.get('group-a', first.id, alice).status === 'running');
  await delay(0);
  await f.service.stop({ drain: true });
  assert.equal(aborted, true); assert.equal(f.service.active.size, 0);
  assert.equal(f.service.get('group-a', first.id, alice).status, 'interrupted');
  assert.equal(f.service.get('group-a', queued.id, alice).status, 'queued');
  assert.equal(f.messages.filter(message => message.role === 'assistant').length, 0);
  assert.equal(f.service.tick(), 0);
});

test('invalidation cancels only matching groups, including queued and human work', async t => {
  let signal;
  const f = fixture(t, { execute: input => { signal = input.signal; return new Promise(resolve => signal.addEventListener('abort', () => resolve('Aborted'), { once: true })); } });
  const running = f.create(), queued = f.create(), human = f.create(), other = f.create({ sessionId: 'group-b' });
  f.service.takeover('group-a', human.id, bob);
  f.service.tick(); await until(() => signal);
  assert.equal(f.service.invalidateUser(alice.id, 'group-a'), 3);
  await until(() => !f.service.active.has('group-a'));
  for (const task of [running, queued, human]) assert.equal(f.service.get('group-a', task.id, admin).status, 'cancelled');
  assert.equal(f.service.get('group-b', other.id, admin).status, 'running');
  f.service.invalidateUser(alice.id); await until(() => f.service.active.size === 0);
});

test('queue size is bounded and duplicate retries remain safe even at capacity', t => {
  const f = fixture(t, { maxQueuedPerGroup: 2 }), first = f.create({ clientRequestId: 'dedupe-at-capacity' }); f.create();
  assert.throws(() => f.create(), { status: 429 });
  assert.equal(f.create({ clientRequestId: 'dedupe-at-capacity' }).id, first.id);
  assert.equal(f.create({ sessionId: 'group-b' }).status, 'queued');
});

test('parallel group limit is respected without preventing FIFO execution', async t => {
  const gates = [], started = [];
  const f = fixture(t, { maxConcurrentGroups: 1, execute: ({ task }) => { started.push(task.id); const gate = deferred(); gates.push(gate); return gate.promise; } });
  const first = f.create(), second = f.create({ sessionId: 'group-b' });
  assert.equal(f.service.tick(), 1); await until(() => started.length === 1);
  assert.equal(f.service.get('group-b', second.id, alice).status, 'queued');
  gates[0].resolve('Group A complete'); await until(() => f.service.active.size === 0);
  f.service.tick(); await until(() => started.length === 2);
  assert.deepEqual(started, [first.id, second.id]); gates[1].resolve('Group B complete'); await until(() => f.service.active.size === 0);
});

test('task update cannot mutate executable instruction or lifecycle, deletion preserves dedupe and transcript', t => {
  const f = fixture(t), task = f.create({ clientRequestId: 'deleted-request' });
  assert.throws(() => f.service.update('group-a', task.id, { instruction: 'Escalated command' }, alice), { status: 400 });
  assert.equal(f.service.update('group-a', task.id, { title: 'New title', assigneeId: bob.id }, alice).title, 'New title');
  assert.throws(() => f.service.remove('group-a', task.id, alice), { status: 409 });
  f.service.cancel('group-a', task.id, bob); f.service.remove('group-a', task.id, alice);
  assert.equal(f.service.list('group-a', alice).total, 0);
  assert.throws(() => f.service.get('group-a', task.id, alice), { status: 404 });
  assert.throws(() => f.create({ clientRequestId: 'deleted-request' }), { status: 409 });
  assert.equal(f.service.messages('group-a', alice).length, 1);
});

test('committed records survive failing observer callbacks', t => {
  const f = fixture(t, { onMessage() { throw new Error('Observer failure'); }, onEvent() { throw new Error('Observer failure'); } });
  const task = f.create();
  assert.equal(f.service.get('group-a', task.id, alice).status, 'queued');
  assert.equal(f.service.messages('group-a', alice).length, 1);
  assert.equal(f.service.cancel('group-a', task.id, alice).status, 'cancelled');
});

test('invalid group, actor, fields, pagination and reply contracts are rejected', t => {
  const f = fixture(t);
  assert.throws(() => f.create({ sessionId: 'absent' }), { status: 404 });
  assert.throws(() => f.create({ instruction: '' }), { status: 400 });
  assert.throws(() => f.create({ skillId: 'file:///private' }), { status: 400 });
  assert.throws(() => f.create({ assigneeId: outsider.id }), { status: 403 });
  assert.throws(() => f.service.list('group-a', alice, { limit: 0 }), { status: 400 });
  assert.throws(() => f.service.messages('group-a', alice, { offset: -1 }), { status: 400 });
  assert.throws(() => f.service.list('group-a', alice, { status: 'invented' }), { status: 400 });
  assert.throws(() => new WorkTaskService(f.store, { execute: async () => 'x' }), TypeError);
});

test('supplements require human takeover and cannot silently change a running request', async t => {
  const gate = deferred(); let invoked = false;
  const f = fixture(t, { execute: () => { invoked = true; return gate.promise; } }), task = f.create();
  assert.throws(() => f.service.supplement('group-a', task.id, 'Queued input', alice), { status: 409 });
  f.service.tick(); await until(() => invoked);
  assert.throws(() => f.service.supplement('group-a', task.id, 'Ignored live input', alice), { status: 409 });
  f.service.takeover('group-a', task.id, alice);
  assert.equal(f.service.supplement('group-a', task.id, 'Explicit human input', alice).status, 'waiting_human');
  gate.resolve('Aborted output'); await until(() => f.service.active.size === 0);
  assert.equal(f.service.tick(), 0);
});

test('assigning queued or running work pauses it and requires explicit creator-authorized dispatch', async t => {
  const gates = [], creators = []; let calls = 0;
  const f = fixture(t, { execute: ({ actor }) => { calls++; creators.push(actor.id); const gate = deferred(); gates.push(gate); return gate.promise; } });
  const task = f.create();
  assert.equal(f.service.assign('group-a', task.id, bob.id, alice).status, 'waiting_human');
  assert.equal(f.service.tick(), 0);
  f.service.resume('group-a', task.id, bob); f.service.tick(); await until(() => calls === 1);
  assert.equal(f.service.assign('group-a', task.id, alice.id, bob).status, 'waiting_human');
  const entry = f.service.active.get('group-a'); assert.equal(entry.controller.signal.aborted, true);
  gates[0].resolve('Old assignee output'); await until(() => f.service.active.size === 0);
  assert.equal(f.service.get('group-a', task.id, alice).result, null);
  assert.equal(f.service.tick(), 0);
  f.service.resume('group-a', task.id, alice); f.service.tick(); await until(() => calls === 2);
  gates[1].resolve('Resumed as creator'); await until(() => f.service.active.size === 0);
  assert.deepEqual(creators, [alice.id, alice.id]);
});

test('PATCH assignee also pauses a running task so it cannot bypass transfer safeguards', async t => {
  const gate = deferred(); let invoked = false;
  const f = fixture(t, { execute: () => { invoked = true; return gate.promise; } }), task = f.create();
  f.service.tick(); await until(() => invoked);
  const changed = f.service.update('group-a', task.id, { assigneeId: bob.id }, alice);
  assert.equal(changed.status, 'waiting_human'); assert.equal(f.service.active.get('group-a').controller.signal.aborted, true);
  gate.resolve('Must not leak'); await until(() => f.service.active.size === 0);
  assert.equal(f.service.tick(), 0);
});

test('resuming human work respects the same queue bound as creation', t => {
  const f = fixture(t, { maxQueuedPerGroup: 1 }), human = f.create();
  f.service.takeover('group-a', human.id, alice); f.create();
  assert.throws(() => f.service.resume('group-a', human.id, alice), { status: 429 });
  assert.equal(f.service.get('group-a', human.id, alice).status, 'waiting_human');
});

test('empty executor responses never create a fabricated success result', async t => {
  const f = fixture(t, { execute: async () => ({ result: '' }) }), task = f.create();
  f.service.tick(); await until(() => f.service.active.size === 0);
  const final = f.service.get('group-a', task.id, alice);
  assert.equal(final.status, 'failed'); assert.match(final.error, /未返回/); assert.equal(final.result, null);
  assert.equal(f.service.messageCount('group-a'), 2);
});

test('latest history remains chronological and includes newly posted results beyond the first page', t => {
  const f = fixture(t), messages = [];
  for (let i = 0; i < 12; i++) messages.push(f.service.postMessage({ sessionId: 'group-a', actor: alice, content: `Discussion ${i}` }));
  assert.deepEqual(f.service.messages('group-a', alice, { limit: 3 }).map(message => message.id), messages.slice(0, 3).map(message => message.id));
  assert.deepEqual(f.service.messages('group-a', alice, { limit: 3, latest: true }).map(message => message.id), messages.slice(-3).map(message => message.id));
  const earlier = f.service.listMessages('group-a', alice, { limit: 3, offset: 3, latest: true });
  assert.deepEqual(earlier.messages.map(message => message.id), messages.slice(-6, -3).map(message => message.id));
  assert.equal(earlier.total, 12);
  assert.throws(() => f.service.messages('group-a', alice, { latest: 'true' }), { status: 400 });
  assert.throws(() => f.service.messages('group-a', outsider, { latest: true }), { status: 403 });
});
