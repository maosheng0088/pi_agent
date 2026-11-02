import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Store } from '../lib/store.mjs';
import { ScheduleService, nextOccurrence, mostRecentOccurrence } from '../lib/schedules.mjs';

const actor = { id: 'business-admin', displayName: 'Business administrator' };
const plan = (body = {}) => ({ name: 'Fixed business task', prompt: 'Run the configured business project.',
  taskType: 'business', businessTaskId: 'fixture-business', executionMode: 'workspace', skillId: null,
  scheduleType: 'daily', time: '08:00', enabled: false, ...body });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-business-schedule-'));
  const store = new Store(directory, directory);
  store.db.prepare('INSERT INTO users(id,username,display_name,role,password_hash,created_at) VALUES (?,?,?,?,?,?)')
    .run(actor.id, 'business-admin', actor.displayName, 'admin', 'unused-unit-test-hash', new Date().toISOString());
  const service = new ScheduleService(store, { execute: async () => ({ reply: 'Business completed.' }), ...options });
  t.after(async () => {
    await service.stop(); store.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('pi-business-schedule-'));
    await rm(directory, { recursive: true, force: true });
  });
  return { store, service };
}

test('fixed business schedules require a project and execution permission without an Agent skill', async (t) => {
  const f = await fixture(t);
  assert.throws(() => f.service.create(plan({ taskType: 'unknown' }), actor), /执行类型/);
  assert.throws(() => f.service.create(plan({ businessTaskId: '' }), actor), /业务项目/);
  assert.throws(() => f.service.create(plan({ businessTaskId: 42 }), actor), /业务项目/);
  assert.throws(() => f.service.create(plan({ executionMode: 'read-only' }), actor), /允许执行/);
  assert.throws(() => f.service.create(plan({ skillId: 'agent-skill' }), actor), /不能同时选择/);
  assert.throws(() => f.service.create(plan({ startDate: '2026-02-30' }), actor), /开始日期/);
  assert.throws(() => f.service.create(plan({ startDate: '2026-10-29T00:00:00Z' }), actor), /开始日期/);
  const created = f.service.create(plan({ startDate: '2026-10-29', timeoutSeconds: 1 }), actor);
  assert.equal(created.taskType, 'business');
  assert.equal(created.businessTaskId, 'fixture-business');
  assert.equal(created.startDate, '2026-10-29');
  assert.equal('timeoutSeconds' in created, false);
  assert.throws(() => f.service.update(created.id, { executionMode: 'read-only' }), /允许执行/);
  const agent = f.service.create({ name: 'Agent task', prompt: 'Summarize.', scheduleType: 'daily', time: '09:00' }, actor);
  assert.equal(agent.taskType, 'agent');
  assert.equal(agent.businessTaskId, null);
  assert.equal(agent.startDate, null);
  assert.throws(() => f.service.update(agent.id, { businessTaskId: 'fixture-business' }), /仅适用于业务任务/);
  assert.throws(() => f.service.update(agent.id, { startDate: '2026-10-29' }), /仅适用于业务任务/);
});

test('business project, type and start date are immutable per-run snapshots', async (t) => {
  const executed = [];
  const f = await fixture(t, { execute: async ({ schedule }) => { executed.push(schedule); return { reply: 'Fixed result.' }; } });
  const created = f.service.create(plan({ startDate: '2026-10-29' }), actor);
  const run = f.service.run(created.id, actor);
  f.service.update(created.id, { businessTaskId: 'next-business', startDate: '2026-10-30' });
  await f.service.waitForIdle();
  assert.equal(executed.length, 1);
  assert.equal(executed[0].businessTaskId, 'fixture-business');
  assert.equal(executed[0].startDate, '2026-10-29');
  const finished = f.service.getRun(run.id);
  assert.equal(finished.taskType, 'business');
  assert.equal(finished.businessTaskId, 'fixture-business');
  assert.equal(finished.startDate, '2026-10-29');
  assert.equal(finished.snapshot.businessTaskId, 'fixture-business');
  assert.equal(finished.status, 'succeeded');
});

test('future business start date keeps the original Beijing execution time on create, edit and enable', async (t) => {
  let now = new Date('2026-10-27T18:17:00Z'); // October 28, 02:17 Beijing.
  let executions = 0;
  const f = await fixture(t, { now: () => now, execute: async () => { executions++; return { reply: 'Done.' }; } });
  const created = f.service.create(plan({ startDate: '2026-10-29', enabled: true }), actor);
  assert.equal(created.nextRunAt, '2026-10-29T00:00:00.000Z');
  assert.equal(f.service.update(created.id, { time: '08:05' }).nextRunAt, '2026-10-29T00:05:00.000Z');
  f.service.update(created.id, { enabled: false });
  assert.equal(f.service.update(created.id, { enabled: true }).nextRunAt, '2026-10-29T00:05:00.000Z');
  // A stale persisted occurrence must not bypass the start date after a restart.
  f.store.db.prepare('UPDATE schedules SET next_run_at=? WHERE id=?').run('2026-10-28T00:05:00.000Z', created.id);
  now = new Date('2026-10-28T00:10:00Z');
  await f.service.tick(); await f.service.waitForIdle();
  assert.equal(executions, 0);
  assert.equal(f.service.runs().length, 0);
  assert.equal(f.service.get(created.id).nextRunAt, '2026-10-29T00:05:00.000Z');
  now = new Date('2026-10-29T00:05:00Z');
  await f.service.tick(); await f.service.waitForIdle();
  assert.equal(executions, 1);
  assert.equal(f.service.get(created.id).nextRunAt, '2026-10-30T00:05:00.000Z');
});

test('business occurrence helpers respect midnight, weekly and interval start boundaries', () => {
  const daily = plan({ startDate: '2026-10-29', time: '00:00' });
  assert.equal(nextOccurrence(daily, '2026-10-27T18:17:00Z'), '2026-10-28T16:00:00.000Z');
  assert.equal(mostRecentOccurrence(daily, '2026-10-28T15:59:00Z'), null);
  assert.equal(mostRecentOccurrence(daily, '2026-10-28T16:00:00Z'), '2026-10-28T16:00:00.000Z');
  const weekly = { ...daily, scheduleType: 'weekly', time: '08:00', weekdays: [1] };
  assert.equal(nextOccurrence(weekly, '2026-10-27T18:17:00Z'), '2026-11-02T00:00:00.000Z');
  assert.equal(mostRecentOccurrence(weekly, '2026-10-29T00:00:00Z'), null);
  const interval = { ...daily, scheduleType: 'interval', createdAt: '2026-10-27T18:17:00Z', intervalMinutes: 60 };
  assert.equal(nextOccurrence(interval, '2026-10-27T18:17:00Z'), '2026-10-28T16:17:00.000Z');
});

test('business plans skip stale business writes but retain a fresh same-day occurrence', async (t) => {
  let now = new Date('2026-10-28T23:00:00Z');
  const executions = [];
  const f = await fixture(t, { now: () => now, execute: async ({ schedule }) => { executions.push(schedule.name); return { reply: 'Done.' }; } });
  const stale = f.service.create(plan({ name: 'Expired write', enabled: true }), actor);
  const agent = f.service.create({ name: 'Agent missed summary', prompt: 'Summarize.', scheduleType: 'daily', time: '08:00', enabled: true }, actor);
  now = new Date('2026-10-29T00:16:00Z');
  await f.service.tick(); await f.service.waitForIdle();
  const skipped = f.service.runs({ scheduleId: stale.id });
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].status, 'skipped');
  assert.match(skipped[0].error, /补跑宽限/);
  assert.equal(skipped[0].scheduledFor, '2026-10-29T00:00:00.000Z');
  assert.equal(f.service.runs({ scheduleId: agent.id })[0].status, 'succeeded');
  assert.deepEqual(executions, ['Agent missed summary']);
  assert.equal(f.service.get(stale.id).nextRunAt, '2026-10-30T00:00:00.000Z');
  now = new Date('2026-10-30T00:14:00Z');
  await f.service.tick(); await f.service.waitForIdle();
  assert.equal(f.service.runs({ scheduleId: stale.id })[0].status, 'succeeded');
  assert.equal(executions.filter((name) => name === 'Expired write').length, 1);
});

test('an occurrence from a previous Beijing day is skipped even with a wider trusted grace period', async (t) => {
  let now = new Date('2026-10-28T15:55:00Z');
  const f = await fixture(t, { now: () => now, businessMisfireGraceMs: 3600000 });
  const created = f.service.create(plan({ time: '23:59', enabled: true }), actor);
  now = new Date('2026-10-28T16:01:00Z');
  await f.service.tick(); await f.service.waitForIdle();
  assert.equal(f.service.runs({ scheduleId: created.id })[0].status, 'skipped');
});

test('trusted business deadline is independent from the ten-minute Agent cap and client fields', async (t) => {
  const seen = [];
  const f = await fixture(t, { maxRunMs: 10,
    businessTimeoutMs: (schedule) => { seen.push(schedule.businessTaskId); return 200; },
    execute: async ({ signal }) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 50);
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
      });
      return { reply: 'Completed beyond Agent test deadline.' };
    },
  });
  const business = f.service.create(plan({ maxRunMs: 1, timeoutSeconds: 0.001 }), actor);
  const businessRun = f.service.run(business.id, actor);
  await f.service.waitForIdle();
  assert.equal(f.service.getRun(businessRun.id).status, 'succeeded');
  assert.deepEqual(seen, ['fixture-business']);
  const agent = f.service.create({ name: 'Agent deadline', prompt: 'Summarize.', scheduleType: 'daily', time: '08:00' }, actor);
  const agentRun = f.service.run(agent.id, actor);
  await f.service.waitForIdle();
  assert.equal(f.service.getRun(agentRun.id).status, 'failed');
  assert.match(f.service.getRun(agentRun.id).error, /1 秒上限/);
});

test('expired business executor receives abort and the error reports its actual trusted deadline', async (t) => {
  const f = await fixture(t, { businessTimeoutMs: () => 15,
    execute: async ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
  });
  const created = f.service.create(plan(), actor);
  const run = f.service.run(created.id, actor);
  await sleep(50); await f.service.waitForIdle();
  assert.equal(f.service.getRun(run.id).status, 'failed');
  assert.match(f.service.getRun(run.id).error, /1 秒上限/);
  assert.doesNotMatch(f.service.getRun(run.id).error, /10 分钟/);
});

test('the trusted business timeout has a hard two-hour-plus-one-minute ceiling', async (t) => {
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const f = await fixture(t, { businessTimeoutMs: () => Infinity,
    execute: async ({ signal }) => {
      entered();
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
  });
  const created = f.service.create(plan(), actor);
  const run = f.service.run(created.id, actor);
  await started;
  assert.equal(f.service.running.get(run.id).timeout._idleTimeout, 7260000);
  f.service.cancel(run.id);
  await f.service.waitForIdle();
  assert.equal(f.service.getRun(run.id).status, 'cancelled');
});

test('restart interrupts a queued business occurrence without rerunning its saved project snapshot', async (t) => {
  let executions = 0;
  const f = await fixture(t);
  const created = f.service.create(plan({ startDate: '2026-10-29' }), actor);
  const queued = f.service.createRun(created, actor, 'scheduled', '2026-10-29T00:00:00.000Z');
  const reopened = new ScheduleService(f.store, { execute: async () => { executions++; return { reply: 'Must not replay.' }; } });
  try {
    await reopened.tick(); await reopened.waitForIdle();
    const interrupted = reopened.getRun(queued.id);
    assert.equal(interrupted.status, 'interrupted');
    assert.equal(interrupted.businessTaskId, 'fixture-business');
    assert.equal(interrupted.startDate, '2026-10-29');
    assert.equal(reopened.get(created.id).lastStatus, 'interrupted');
    assert.equal(executions, 0);
  } finally { await reopened.stop(); }
});

test('executor business deduplication is recorded as skipped and only its saved explanation can be redelivered', async (t) => {
  let executions = 0;
  const delivered = [];
  const f = await fixture(t, {
    execute: async () => { executions++; return { skipped: true, reply: '该项目今日已领取执行，本次未重复运行。' }; },
    deliver: async ({ result }) => delivered.push(result),
  });
  const created = f.service.create(plan(), actor);
  const run = f.service.run(created.id, actor);
  await f.service.waitForIdle();
  assert.equal(f.service.getRun(run.id).status, 'skipped');
  assert.equal(f.service.getRun(run.id).hasResult, true);
  assert.equal(f.service.get(created.id).lastStatus, 'skipped');
  assert.equal(delivered.length, 1);
  await f.service.retryDelivery(run.id);
  assert.equal(executions, 1);
  assert.deepEqual(delivered, ['该项目今日已领取执行，本次未重复运行。', '该项目今日已领取执行，本次未重复运行。']);
  const overlap = f.service.createRun(created, actor, 'scheduled', '2026-10-29T00:00:00.000Z', 'skipped', 'Already running.');
  await assert.rejects(f.service.retryDelivery(overlap.id), { status: 409 });
});
