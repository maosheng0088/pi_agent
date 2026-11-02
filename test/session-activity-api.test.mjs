import assert from 'node:assert/strict';
import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { collectSSE, configure, createFixture, session } from './auth-helpers.mjs';

const password = 'Activity-fixture-only-2026!';
async function checked(client, route, options = {}, status = 200) {
  const result = await client.request(route, options);
  assert.equal(result.response.status, status, `${route}: ${JSON.stringify(result.data)}`);
  return result.data;
}
async function until(check, message, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out: ${message}`);
}
async function setup(t, { autoStart = true } = {}) {
  const tasks = [];
  let started, release;
  const fixture = await createFixture({ prefix: 'session-activity',
    options: { scheduler: { autoStart: false }, channels: { autoStart: false }, workTasks: { autoStart, pollIntervalMs: 20 }, business: { tasks } },
    seed: async ({ workspace }) => {
      const cwd = path.join(workspace, 'isolated-business');
      await mkdir(cwd);
      started = path.join(cwd, 'started'); release = path.join(cwd, 'release');
      const scriptPath = path.join(cwd, 'wait.mjs'), registrationPath = path.join(cwd, 'registration.json');
      await writeFile(scriptPath, `import fs from 'node:fs';
const config=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
fs.writeFileSync(config.started,'ready');
const timer=setInterval(()=>{if(fs.existsSync(config.release)){clearInterval(timer);console.log('Isolated business completed.');}},20);
`);
      await writeFile(registrationPath, JSON.stringify({ started, release }));
      tasks.push({ id: 'isolated-activity-business', name: 'Isolated activity business', source: 'fixture', projectVersion: 'fixture',
        pythonPath: process.execPath, scriptPath, cwd, registrationPath, args: [], timeoutSeconds: 30 });
    },
  });
  t.after(() => fixture.close());
  const admin = fixture.client(), alice = fixture.client(), bob = fixture.client(), outsider = fixture.client();
  const owner = (await checked(admin, '/auth/setup', { method: 'POST', body: { username: 'activity-admin', displayName: 'Activity admin', password } }, 201)).user;
  await configure(admin, fixture);
  const users = {};
  for (const [username, client] of [['activity-alice', alice], ['activity-bob', bob], ['activity-outsider', outsider]]) {
    users[username] = (await checked(admin, '/admin/users', { method: 'POST', body: { username, displayName: username, role: 'member', password } }, 201)).user;
    await checked(client, '/auth/login', { method: 'POST', body: { username, password } });
  }
  const group = await session(admin, 'Activity target');
  await checked(admin, `/sessions/${group.id}/members`, { method: 'POST', body: { userIds: [users['activity-alice'].id, users['activity-bob'].id] } });
  const otherGroup = await session(admin, 'Other target');
  const pathFor = tail => `/sessions/${group.id}${tail ? `/${tail}` : ''}`;
  const status = async (id = group.id, client = alice) => (await checked(client, '/sessions?limit=200')).sessions.find(value => value.id === id);
  const detail = async (id = group.id, client = alice) => (await checked(client, `/sessions/${id}`)).session;
  const task = async (instruction, client = alice) => (await checked(client, pathFor('tasks'), { method: 'POST', body: { instruction } }, 202)).task;
  const action = async (id, action, client = alice) => (await checked(client, pathFor(`tasks/${id}/actions`), { method: 'POST', body: { action } })).task;
  const plan = async body => (await checked(admin, '/admin/schedules', { method: 'POST', body: { name: 'Activity plan', targetSessionId: group.id,
    executionMode: 'read-only', prompt: '[slow-response] hold scheduled AI', scheduleType: 'daily', time: '09:00', enabled: false, ...body } }, 201)).schedule;
  const run = async schedule => (await checked(admin, `/admin/schedules/${schedule.id}/run`, { method: 'POST', body: {} }, 202)).run;
  const cancelRun = async id => checked(admin, `/admin/task-runs/${id}/cancel`, { method: 'POST', body: {} });
  return { fixture, admin, alice, bob, outsider, owner, users, group, otherGroup, status, detail, task, action, plan, run, cancelRun, started, release };
}
function state(value, running, queued, conversation = false) {
  assert.ok(value);
  assert.equal(value.runningTaskCount, running, JSON.stringify(value));
  assert.equal(value.queuedTaskCount, queued, JSON.stringify(value));
  assert.equal(value.running, running > 0, JSON.stringify(value));
  assert.equal(value.conversationRunning, conversation, JSON.stringify(value));
}

test('work queue counts running and queued once, and terminal or human work stops marking the group as running', { timeout: 45000 }, async t => {
  const f = await setup(t, { autoStart: false });
  const first = await f.task('[slow-response] first work task');
  const second = await f.task('queued work task');
  state(await f.status(), 0, 2);
  state(await f.detail(), 0, 2);
  f.fixture.server.piWeb.workTasks.start();
  await until(() => f.fixture.mock.requests.length === 1, 'the actual SDK worker starts');
  state(await f.status(), 1, 1);
  const current = await f.detail(); state(current, 1, 1);
  assert.equal(current.activeUserId, undefined, 'a background worker is not the current group speaker');
  assert.equal(current.activeUserName, undefined);
  await f.action(second.id, 'cancel');
  state(await f.status(), 1, 0);
  await f.action(first.id, 'takeover');
  state(await f.status(), 0, 0);
  await until(() => f.fixture.server.piWeb.workTasks.active.size === 0, 'the cancelled worker drains');
  await f.action(first.id, 'resume');
  await until(() => f.fixture.mock.requests.length === 2, 'explicit resume starts a fresh actual SDK worker');
  state(await f.status(), 1, 0);
  await f.fixture.server.piWeb.workTasks.stop({ drain: true });
  state(await f.status(), 0, 0);
  await f.fixture.stop(); await f.fixture.start();
  state(await f.status(), 0, 0);
  f.fixture.server.piWeb.workTasks.start();
  // A clean group keeps slow-response fixture markers out of subsequent shared
  // context, so success and failure exercise the intended provider branches.
  const cleanGroup = await session(f.admin, 'Clean terminal state fixture');
  const cleanTask = async instruction => (await checked(f.admin, `/sessions/${cleanGroup.id}/tasks`, { method: 'POST', body: { instruction } }, 202)).task;
  const completed = await cleanTask('complete real work normally');
  await until(async () => (await checked(f.admin, `/sessions/${cleanGroup.id}/tasks/${completed.id}`)).task.status === 'succeeded', 'real work completes');
  state(await f.status(cleanGroup.id, f.admin), 0, 0);
  state(await f.status(), 0, 0);
  const failed = await cleanTask('[provider-error] fail real work');
  await until(async () => (await checked(f.admin, `/sessions/${cleanGroup.id}/tasks/${failed.id}`)).task.status === 'failed', 'provider failure becomes terminal', 20000);
  state(await f.status(cleanGroup.id, f.admin), 0, 0);
  state(await f.status(), 0, 0);
});

test('direct chat, work, scheduled AI and business execution aggregate on one group without worker duplication', { timeout: 45000 }, async t => {
  const f = await setup(t);
  const directResponse = await f.bob.fetch(`/sessions/${f.group.id}/messages`, { method: 'POST', body: { message: '[slow-response] direct group turn' } });
  assert.equal(directResponse.status, 200);
  const direct = collectSSE(directResponse);
  const work = await f.task('[slow-response] independent work');
  const aiRun = await f.run(await f.plan({ name: 'Scheduled AI' }));
  const businessRun = await f.run(await f.plan({ name: 'Scheduled native business', taskType: 'business', businessTaskId: 'isolated-activity-business', executionMode: 'workspace' }));
  await until(async () => await access(f.started).then(() => true, () => false) && f.fixture.mock.requests.length === 3, 'all real execution engines begin');
  const value = await f.status(); state(value, 4, 0, true);
  assert.equal(value.activeUserId, f.users['activity-bob'].id);
  assert.equal(value.activeUserName, 'activity-bob');
  state(await f.detail(), 4, 0, true);
  state(await f.status(f.otherGroup.id, f.admin), 0, 0);
  await writeFile(f.release, 'release isolated process');
  await until(async () => (await checked(f.admin, '/admin/task-runs')).runs.find(run => run.id === businessRun.id)?.status === 'succeeded', 'the isolated native business finishes');
  state(await f.status(), 3, 0, true);
  await f.cancelRun(aiRun.id);
  await f.fixture.server.piWeb.schedules.waitForIdle();
  state(await f.status(), 2, 0, true);
  await f.action(work.id, 'cancel');
  state(await f.status(), 1, 0, true);
  await checked(f.bob, `/sessions/${f.group.id}/abort`, { method: 'POST', body: {} });
  await direct;
  state(await f.status(), 0, 0);
});

test('queued and running schedules stay with their captured group after the plan changes', { timeout: 30000 }, async t => {
  const f = await setup(t);
  const schedules = f.fixture.server.piWeb.schedules;
  const originalLaunch = schedules.launch;
  let pending;
  schedules.launch = id => { pending = id; };
  const plan = await f.plan();
  let run;
  try {
    run = await f.run(plan);
    state(await f.status(), 0, 1);
    await checked(f.admin, `/admin/schedules/${plan.id}`, { method: 'PATCH', body: { targetSessionId: f.otherGroup.id } });
    state(await f.status(), 0, 1);
    state(await f.status(f.otherGroup.id, f.admin), 0, 0);
  } finally { schedules.launch = originalLaunch; }
  assert.equal(pending, run.id);
  schedules.launch(pending);
  await until(() => f.fixture.mock.requests.length === 1, 'the queued snapshot starts');
  state(await f.status(), 1, 0);
  state(await f.status(f.otherGroup.id, f.admin), 0, 0);
  await f.cancelRun(run.id); await schedules.waitForIdle();
  state(await f.status(), 0, 0);
});

test('completed schedule awaiting delivery is no longer execution in progress', { timeout: 30000 }, async t => {
  const f = await setup(t);
  const channels = f.fixture.server.piWeb.channels;
  const originalPublish = channels.publishTask;
  let delivering = false, release;
  const gate = new Promise(resolve => { release = resolve; });
  channels.publishTask = async function (...args) { delivering = true; await gate; return originalPublish.apply(this, args); };
  try {
    const run = await f.run(await f.plan({ prompt: 'finish actual scheduled AI normally' }));
    await until(() => delivering, 'delivery reaches a controlled wait after execution');
    assert.equal((await checked(f.admin, '/admin/task-runs')).runs.find(value => value.id === run.id)?.status, 'succeeded');
    assert.ok(f.fixture.server.piWeb.schedules.running.has(run.id), 'the schedule promise is still delivering');
    state(await f.status(), 0, 0);
    state(await f.detail(), 0, 0);
  } finally { release(); await f.fixture.server.piWeb.schedules.waitForIdle(); channels.publishTask = originalPublish; }
});

test('activity summaries preserve membership boundaries and separate administrator audit access', { timeout: 30000 }, async t => {
  const f = await setup(t);
  const task = await f.task('[slow-response] members only activity');
  await until(() => f.fixture.mock.requests.length === 1, 'private work begins');
  state(await f.status(), 1, 0);
  assert.equal(await f.status(f.group.id, f.outsider), undefined);
  assert.equal((await f.outsider.request(`/sessions/${f.group.id}`)).response.status, 404);
  assert.equal((await f.fixture.client().request('/sessions')).response.status, 401);
  assert.equal((await f.alice.request('/admin/sessions')).response.status, 403);
  const audited = (await checked(f.admin, '/admin/sessions')).sessions.find(value => value.id === f.group.id);
  state(audited, 1, 0);
  await f.action(task.id, 'cancel');
  state(await f.status(), 0, 0);
});
