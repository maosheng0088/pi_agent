import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createFixture, configure, collaborativeSession } from './auth-helpers.mjs';

const password = 'Native-business-fixture-2026!';
const privateOutput = 'PRIVATE-BUSINESS-STDOUT-9d43';
const registeredSecret = 'registration-private-fixture-value';
const providerSecret = 'shared-test-model-key-do-not-return';
const script = `import fs from 'node:fs';
const registration = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
fs.appendFileSync(registration.counter, 'run\\n');
console.log('${privateOutput}');
console.log(registration.privateValue);
console.log('${providerSecret}');
if (registration.mode === 'slow') {
  fs.writeFileSync(registration.started, 'started');
  setInterval(() => {}, 1000);
} else if (registration.mode === 'failure') process.exitCode = 7;
`;

async function setup(t, mode = 'success') {
  const tasks = [];
  let counter, started;
  const fakeNow = new Date('2026-10-27T18:17:00Z'); // October 28, 02:17 Beijing.
  const fixture = await createFixture({ prefix: 'native-business-api',
    options: { scheduler: { autoStart: false, now: () => fakeNow }, channels: { autoStart: false },
      business: { tasks, now: () => fakeNow } },
    seed: async ({ workspace }) => {
      const cwd = path.join(workspace, '业务 项目 固定');
      await mkdir(cwd);
      counter = path.join(cwd, '执行 次数.txt');
      started = path.join(cwd, '执行 已开始.txt');
      const scriptPath = path.join(cwd, '业务 脚本.mjs');
      const registrationPath = path.join(cwd, '固定 注册.json');
      await writeFile(scriptPath, script, 'utf8');
      await writeFile(registrationPath, JSON.stringify({ counter, started, mode, privateValue: registeredSecret }), 'utf8');
      tasks.push({ id: 'fixture-native-project', name: '固定业务 项目', source: 'RPAC', projectVersion: 'v-fixture',
        pythonPath: process.execPath, scriptPath, cwd, registrationPath, args: ['--fixture-only'], timeoutSeconds: 30 });
    },
  });
  t.after(() => fixture.close());
  const admin = fixture.client(), member = fixture.client();
  const setup = await admin.request('/auth/setup', { method: 'POST', body: { username: 'native-admin', displayName: '业务管理员', password } });
  assert.equal(setup.response.status, 201, JSON.stringify(setup.data));
  await configure(admin, fixture);
  const employee = await admin.request('/admin/users', { method: 'POST', body: { username: 'native-member', displayName: '业务员工', role: 'member', password } });
  assert.equal(employee.response.status, 201);
  assert.equal((await member.request('/auth/login', { method: 'POST', body: { username: 'native-member', password } })).response.status, 200);
  const target = await collaborativeSession(admin, '固定业务结果群');
  const body = (overrides = {}) => ({ name: '固定项目定时执行', taskType: 'business', businessTaskId: tasks[0].id,
    executionMode: 'workspace', targetSessionId: target.id, skillId: null, prompt: '执行已注册的固定项目。',
    scheduleType: 'daily', time: '08:00', enabled: false, ...overrides });
  const task = async (overrides = {}, client = admin) => {
    const response = await client.request('/admin/schedules', { method: 'POST', body: body(overrides) });
    assert.equal(response.response.status, 201, JSON.stringify(response.data));
    return response.data.schedule;
  };
  const run = async (schedule, client = admin) => {
    const response = await client.request(`/admin/schedules/${schedule.id}/run`, { method: 'POST', body: {} });
    assert.equal(response.response.status, 202, JSON.stringify(response.data));
    await fixture.server.piWeb.schedules.waitForIdle();
    const runs = await admin.request('/admin/task-runs');
    assert.equal(runs.response.status, 200);
    return runs.data.runs.find((entry) => entry.id === response.data.run.id);
  };
  return { fixture, admin, member, target, tasks, counter, started, body, task, run };
}

test('registered native projects expose readiness and safe metadata only to administrators', { timeout: 30_000 }, async (t) => {
  const f = await setup(t);
  assert.equal((await f.fixture.client().request('/admin/business-tasks')).response.status, 401);
  assert.equal((await f.member.request('/admin/business-tasks')).response.status, 403);
  const result = await f.admin.request('/admin/business-tasks');
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.data.tasks, [{ id: 'fixture-native-project', name: '固定业务 项目', source: 'RPAC',
    projectVersion: 'v-fixture', timeoutSeconds: 30, ready: true }]);
  const serialized = JSON.stringify(result.data);
  for (const value of [registeredSecret, providerSecret, 'pythonPath', 'scriptPath', 'registrationPath', 'args']) assert.ok(!serialized.includes(value));
  assert.ok(!serialized.includes(f.fixture.workspace));
});

test('native project plans validate fixed execution policy and retain tomorrow’s Beijing start time', { timeout: 30_000 }, async (t) => {
  const f = await setup(t);
  for (const [changes, status] of [
    [{ businessTaskId: 'unregistered-project' }, 404],
    [{ executionMode: 'read-only' }, 400],
    [{ skillId: 'different-agent-skill' }, 400],
    [{ scheduleType: 'interval', intervalMinutes: 5 }, 400],
  ]) {
    const result = await f.admin.request('/admin/schedules', { method: 'POST', body: f.body(changes) });
    assert.equal(result.response.status, status, JSON.stringify(result.data));
  }
  assert.equal((await f.member.request('/admin/schedules', { method: 'POST', body: f.body() })).response.status, 403);
  const schedule = await f.task({ startDate: '2026-10-29', enabled: true, time: '08:05',
    scriptPath: 'C:\\forged-entry.mjs', pythonPath: 'C:\\forged-interpreter.exe', timeoutSeconds: 1 });
  assert.equal(schedule.taskType, 'business');
  assert.equal(schedule.startDate, '2026-10-29');
  assert.equal(schedule.nextRunAt, '2026-10-29T00:05:00.000Z');
  assert.equal(schedule.businessTaskId, 'fixture-native-project');
  assert.equal('scriptPath' in schedule, false);
  assert.equal('timeoutSeconds' in schedule, false);
  assert.equal(f.fixture.mock.requests.length, 0);
});

test('fixed project executes from a Chinese directory with spaces and publishes only a safe summary without a model round', { timeout: 30_000 }, async (t) => {
  const f = await setup(t);
  const run = await f.run(await f.task());
  assert.equal(run.status, 'succeeded', JSON.stringify(run));
  assert.equal(run.delivery.status, 'delivered', JSON.stringify(run));
  assert.equal(run.taskType, 'business');
  assert.equal(run.businessTaskId, 'fixture-native-project');
  assert.equal(run.sessionId, null);
  assert.equal(await readFile(f.counter, 'utf8'), 'run\n');
  assert.equal(f.fixture.mock.requests.length, 0);
  const history = await f.member.request(`/sessions/${f.target.id}`);
  assert.equal(history.response.status, 200);
  const results = history.data.messages.filter((message) => message.taskRunId === run.id);
  assert.equal(results.length, 1);
  assert.match(results[0].content, /执行成功/);
  assert.equal(results[0].role, 'assistant');
  assert.equal(results[0].tools, undefined);
  for (const value of [privateOutput, registeredSecret, providerSecret, f.fixture.workspace]) assert.ok(!results[0].content.includes(value));
  const log = await f.admin.request(`/admin/task-runs/${run.id}/log`);
  assert.equal(log.response.status, 200);
  assert.match(log.data.content, new RegExp(privateOutput));
  assert.ok(log.data.content.includes(registeredSecret));
  assert.ok(!log.data.content.includes(providerSecret));
  assert.equal((await f.member.request(`/admin/task-runs/${run.id}/log`)).response.status, 403);
});

test('a second daily project execution is skipped and notification retry never repeats the process', { timeout: 30_000 }, async (t) => {
  const f = await setup(t);
  const schedule = await f.task();
  const first = await f.run(schedule);
  const second = await f.run(schedule);
  assert.equal(first.status, 'succeeded');
  assert.equal(second.status, 'skipped', JSON.stringify(second));
  assert.equal(second.hasResult, true);
  assert.equal(second.delivery.status, 'delivered');
  assert.equal(await readFile(f.counter, 'utf8'), 'run\n');
  const retry = await f.admin.request(`/admin/task-runs/${second.id}/retry-delivery`, { method: 'POST', body: {} });
  assert.equal(retry.response.status, 200, JSON.stringify(retry.data));
  assert.equal(await readFile(f.counter, 'utf8'), 'run\n');
  assert.equal(f.fixture.mock.requests.length, 0);
  const history = (await f.member.request(`/sessions/${f.target.id}`)).data.messages;
  assert.equal(history.filter((message) => message.taskRunId === second.id).length, 1);
  assert.match(history.find((message) => message.taskRunId === second.id).content, /重复跳过/);
});

test('failed native business output remains in the admin log while members see only the failure summary', { timeout: 30_000 }, async (t) => {
  const f = await setup(t, 'failure');
  const run = await f.run(await f.task());
  assert.equal(run.status, 'failed');
  assert.equal(run.delivery.status, 'delivered');
  assert.match(run.error, /退出码 7/);
  const history = (await f.member.request(`/sessions/${f.target.id}`)).data.messages;
  const result = history.find((message) => message.taskRunId === run.id);
  assert.match(result.content, /执行失败/);
  assert.ok(!result.content.includes(privateOutput));
  const log = await f.admin.request(`/admin/task-runs/${run.id}/log`);
  assert.equal(log.response.status, 200);
  assert.match(log.data.content, new RegExp(privateOutput));
  assert.equal(await readFile(f.counter, 'utf8'), 'run\n');
  assert.equal(f.fixture.mock.requests.length, 0);
});

test('removing the task owner from its target group aborts a native process and suppresses result delivery', { timeout: 30_000 }, async (t) => {
  const f = await setup(t, 'slow');
  const ownerResponse = await f.admin.request('/admin/users', { method: 'POST', body: {
    username: 'native-owner', displayName: '固定任务所有人', role: 'admin', password,
  } });
  assert.equal(ownerResponse.response.status, 201);
  const owner = f.fixture.client();
  assert.equal((await owner.request('/auth/login', { method: 'POST', body: { username: 'native-owner', password } })).response.status, 200);
  assert.equal((await f.admin.request(`/sessions/${f.target.id}/members`, { method: 'POST', body: { userIds: [ownerResponse.data.user.id] } })).response.status, 200);
  const schedule = await f.task({}, owner);
  const requested = await f.admin.request(`/admin/schedules/${schedule.id}/run`, { method: 'POST', body: {} });
  assert.equal(requested.response.status, 202);
  const deadline = Date.now() + 10000;
  let started = false;
  while (!started && Date.now() < deadline) {
    try { await access(f.started); started = true; }
    catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  assert.equal(started, true, 'The fixture process must start before its owner is removed.');
  const removed = await f.admin.request(`/sessions/${f.target.id}/members/${ownerResponse.data.user.id}`, { method: 'DELETE', body: {} });
  assert.equal(removed.response.status, 200, JSON.stringify(removed.data));
  await f.fixture.server.piWeb.schedules.waitForIdle();
  const current = f.fixture.server.piWeb.schedules.getRun(requested.data.run.id);
  assert.equal(current.status, 'cancelled', JSON.stringify(current));
  assert.equal(current.hasResult, false);
  const messages = (await f.member.request(`/sessions/${f.target.id}`)).data.messages;
  assert.equal(messages.filter((message) => message.taskRunId === current.id).length, 0);
  assert.equal(await readFile(f.counter, 'utf8'), 'run\n');
  assert.equal(f.fixture.mock.requests.length, 0);
});
