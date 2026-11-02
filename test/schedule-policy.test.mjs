import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Store } from '../lib/store.mjs';
import { ScheduleService } from '../lib/schedules.mjs';

const actor = { id: 'schedule-admin', displayName: 'Task administrator' };
const plan = (body = {}) => ({ name: 'Business report', prompt: 'Read the selected skill and prepare the report.',
  scheduleType: 'daily', time: '09:30', enabled: false, ...body });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

async function fixture(t, options = {}, prepare = () => {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-schedule-policy-'));
  const store = new Store(directory, directory);
  store.db.prepare('INSERT INTO users(id,username,display_name,role,password_hash,created_at) VALUES (?,?,?,?,?,?)')
    .run(actor.id, 'schedule-admin', actor.displayName, 'admin', 'unused-unit-test-hash', new Date().toISOString());
  prepare(store);
  const service = new ScheduleService(store, { execute: async () => ({ reply: 'Completed.' }), ...options });
  t.after(async () => {
    await service.stop(); store.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('pi-schedule-policy-'));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, store, service };
}

test('plans persist their business group and administrator-selected execution mode with ownership validation', async (t) => {
  const validations = [];
  const f = await fixture(t, { validateTarget: (schedule, context) => {
    validations.push({ schedule: structuredClone(schedule), ...context });
    if (!schedule.targetSessionId && (!context.previous || schedule.enabled)) throw new Error('Choose a business group.');
  } });
  assert.throws(() => f.service.create(plan(), actor), /business group/);
  const created = f.service.create(plan({ targetSessionId: 'sales', executionMode: 'workspace', createdBy: 'forged' }), actor);
  assert.equal(created.targetSessionId, 'sales');
  assert.equal(created.executionMode, 'workspace');
  assert.equal(created.createdBy, actor.id);
  assert.equal(validations.at(-1).phase, 'save');
  assert.equal(validations.at(-1).schedule.createdBy, actor.id);
  assert.equal(validations.at(-1).previous, null);
  const updated = f.service.update(created.id, { targetSessionId: 'support', executionMode: 'read-only', createdBy: 'forged' });
  assert.equal(updated.targetSessionId, 'support');
  assert.equal(updated.executionMode, 'read-only');
  assert.equal(validations.at(-1).previous.targetSessionId, 'sales');
  assert.throws(() => f.service.update(created.id, { executionMode: 'unrestricted' }), /执行权限/);
  assert.throws(() => f.service.update(created.id, { targetSessionId: 12 }), /业务群/);
});

test('each queued run uses an immutable target, skill, prompt and permission snapshot', async (t) => {
  const executions = [], validations = [];
  const f = await fixture(t, { skills: { get: () => ({ enabled: true }) },
    validateTarget: (schedule, context) => validations.push({ target: schedule.targetSessionId, phase: context.phase }),
    execute: async ({ schedule }) => { executions.push(schedule); return { sessionId: 'private-worker', reply: 'Business result.' }; },
  });
  const created = f.service.create(plan({ targetSessionId: 'sales', executionMode: 'workspace', skillId: 'approved-skill' }), actor);
  const run = f.service.run(created.id, actor);
  f.service.update(created.id, { targetSessionId: 'other-group', executionMode: 'read-only', prompt: 'New task.', skillId: null });
  await f.service.waitForIdle();
  assert.equal(executions.length, 1);
  assert.equal(executions[0].targetSessionId, 'sales');
  assert.equal(executions[0].executionMode, 'workspace');
  assert.equal(executions[0].skillId, 'approved-skill');
  assert.equal(executions[0].prompt, created.prompt);
  const completed = f.service.getRun(run.id);
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.targetSessionId, 'sales');
  assert.equal(completed.executionMode, 'workspace');
  assert.equal(completed.snapshot.prompt, created.prompt);
  assert.equal(completed.sessionId, 'private-worker');
  assert.equal(completed.hasResult, true);
  assert.equal('resultText' in completed, false);
  assert.equal(f.service.result(run.id), 'Business result.');
  assert.ok(validations.some((entry) => entry.phase === 'run' && entry.target === 'sales'));
});

test('notification failure preserves execution success and retries only the stored result after plan deletion', async (t) => {
  let executions = 0, deliveries = 0;
  const attempts = [];
  const f = await fixture(t, { redact: (value) => String(value).replaceAll('secret-value', '[redacted]'),
    execute: async () => { executions++; return { reply: 'Report secret-value.' }; },
    deliver: async ({ schedule, run, result }) => {
      deliveries++; attempts.push({ schedule, run, result });
      assert.equal(f.service.getRun(run.id).status, 'succeeded');
      assert.equal(f.service.result(run.id), 'Report [redacted].');
      if (deliveries === 1) throw new Error('Transport temporarily offline.');
    },
  });
  const created = f.service.create(plan({ targetSessionId: 'sales' }), actor);
  const run = f.service.run(created.id, actor);
  await f.service.waitForIdle();
  assert.equal(f.service.getRun(run.id).status, 'succeeded');
  assert.equal(f.service.getRun(run.id).error, null);
  assert.equal(deliveries, 1);
  f.service.remove(created.id);
  const retried = await f.service.retryDelivery(run.id);
  assert.equal(retried.status, 'succeeded');
  assert.equal(executions, 1);
  assert.equal(deliveries, 2);
  assert.equal(attempts[1].schedule.targetSessionId, 'sales');
  assert.equal(attempts[1].result, 'Report [redacted].');
});

test('failed business execution persists a safe readable summary and does not rerun on delivery retry', async (t) => {
  let executions = 0;
  const results = [];
  const f = await fixture(t, { redact: (value) => String(value).replaceAll('fixture-secret', '[redacted]'),
    execute: async () => { executions++; throw new Error('provider fixture-secret is unavailable'); },
    deliver: async ({ result }) => results.push(result),
  });
  const created = f.service.create(plan({ targetSessionId: 'sales' }), actor);
  const run = f.service.run(created.id, actor);
  await f.service.waitForIdle();
  const finished = f.service.getRun(run.id);
  assert.equal(finished.status, 'failed');
  assert.equal(finished.error, 'provider [redacted] is unavailable');
  assert.equal(f.service.result(run.id), '执行失败：provider [redacted] is unavailable');
  await f.service.retryDelivery(run.id);
  assert.equal(executions, 1);
  assert.deepEqual(results, ['执行失败：provider [redacted] is unavailable', '执行失败：provider [redacted] is unavailable']);
});

test('target access is checked again at run time and owner and skill revocation block execution', async (t) => {
  let allowed = true, skillEnabled = true, executions = 0;
  const f = await fixture(t, { skills: { get: () => ({ enabled: skillEnabled }) },
    validateTarget: (_schedule, { phase }) => { if (phase === 'run' && !allowed) throw new Error('Group membership was revoked.'); },
    execute: async () => { executions++; return { reply: 'Executed.' }; },
  });
  const created = f.service.create(plan({ targetSessionId: 'sales', skillId: 'approved-skill' }), actor);
  allowed = false;
  const accessDenied = f.service.run(created.id, actor); await f.service.waitForIdle();
  assert.match(f.service.getRun(accessDenied.id).error, /membership was revoked/);
  allowed = true; skillEnabled = false;
  const disabledSkill = f.service.run(created.id, actor); await f.service.waitForIdle();
  assert.match(f.service.getRun(disabledSkill.id).error, /技能已停用/);
  skillEnabled = true;
  f.store.db.prepare("UPDATE users SET role='member' WHERE id=?").run(actor.id);
  const revokedOwner = f.service.run(created.id, actor); await f.service.waitForIdle();
  assert.match(f.service.getRun(revokedOwner.id).error, /管理员权限/);
  assert.equal(executions, 0);
});

test('cancelled execution stores no result and never delivers or becomes retryable', async (t) => {
  const entered = deferred(); let deliveries = 0;
  const f = await fixture(t, {
    execute: async ({ signal }) => { entered.resolve(); await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); },
    deliver: async () => { deliveries++; },
  });
  const created = f.service.create(plan({ targetSessionId: 'sales' }), actor);
  const run = f.service.run(created.id, actor);
  await entered.promise;
  await assert.rejects(f.service.retryDelivery(run.id), { status: 409 });
  f.service.cancel(run.id); await f.service.waitForIdle();
  assert.equal(f.service.getRun(run.id).status, 'cancelled');
  assert.equal(f.service.result(run.id), null);
  assert.equal(deliveries, 0);
  await assert.rejects(f.service.retryDelivery(run.id), { status: 409 });
});

test('result survives shutdown and retries deduplicate an overlapping notification attempt', async (t) => {
  const entered = deferred(), release = deferred(); let deliveries = 0;
  const f = await fixture(t, { execute: async () => ({ reply: 'A'.repeat(100100) }),
    deliver: async () => { deliveries++; entered.resolve(); await release.promise; },
  });
  const created = f.service.create(plan({ targetSessionId: 'sales' }), actor);
  const run = f.service.run(created.id, actor); await entered.promise;
  const duplicateRetry = f.service.retryDelivery(run.id);
  const stopping = f.service.stop();
  assert.equal(f.service.getRun(run.id).status, 'succeeded');
  assert.equal(f.service.result(run.id).length, 100000);
  release.resolve(); await Promise.all([duplicateRetry, stopping]);
  assert.equal(deliveries, 1);
  const reopened = new ScheduleService(f.store);
  assert.equal(reopened.getRun(run.id).status, 'succeeded');
  assert.equal(reopened.result(run.id).length, 100000);
  await reopened.stop();
});

test('additive migration preserves historical plans, interrupted runs and read-only defaults', async (t) => {
  const f = await fixture(t, {}, (store) => {
    store.db.exec(`CREATE TABLE schedules (
      id TEXT PRIMARY KEY,name TEXT NOT NULL,skill_id TEXT,prompt TEXT NOT NULL,schedule_type TEXT NOT NULL,
      run_at TEXT,time TEXT,weekdays TEXT NOT NULL DEFAULT '[]',interval_minutes INTEGER,enabled INTEGER NOT NULL DEFAULT 0,
      time_zone TEXT NOT NULL DEFAULT 'Asia/Shanghai',next_run_at TEXT,last_run_at TEXT,last_status TEXT,
      created_by TEXT NOT NULL,created_by_name TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE task_runs (
      id TEXT PRIMARY KEY,schedule_id TEXT NOT NULL,schedule_name TEXT NOT NULL,skill_id TEXT,status TEXT NOT NULL,
      session_id TEXT,requested_by TEXT NOT NULL,requested_by_name TEXT NOT NULL,trigger TEXT NOT NULL,
      scheduled_for TEXT,started_at TEXT,finished_at TEXT,error TEXT,created_at TEXT NOT NULL);`);
    store.db.prepare(`INSERT INTO schedules(id,name,prompt,schedule_type,time,created_by,created_by_name,created_at,updated_at)
      VALUES ('legacy','Legacy task','Original task.','daily','09:30',?,?,?,?)`).run(actor.id, actor.displayName, '2026-10-27T01:00:00Z', '2026-10-27T01:00:00Z');
    store.db.prepare(`INSERT INTO task_runs(id,schedule_id,schedule_name,status,requested_by,requested_by_name,trigger,created_at)
      VALUES ('legacy-run','legacy','Legacy task','running',?,?,'manual',?)`).run(actor.id, actor.displayName, '2026-10-27T01:00:00Z');
  });
  const legacy = f.service.get('legacy');
  assert.equal(legacy.targetSessionId, null);
  assert.equal(legacy.executionMode, 'read-only');
  assert.equal(legacy.prompt, 'Original task.');
  assert.equal(f.service.getRun('legacy-run').status, 'interrupted');
  assert.equal(f.service.getRun('legacy-run').snapshot, null);
  assert.equal(f.service.getRun('legacy-run').hasResult, false);
  assert.equal(f.service.result('legacy-run'), null);
  const manual = f.service.run(legacy.id, actor); await f.service.waitForIdle();
  assert.equal(f.service.getRun(manual.id).executionMode, 'read-only');
  assert.equal(f.service.result(manual.id), 'Completed.');
});
