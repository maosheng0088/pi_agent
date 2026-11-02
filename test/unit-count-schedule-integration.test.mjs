import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { collaborativeSession, configure, createFixture } from './auth-helpers.mjs';

const password = 'Unit-count-offline-fixture-2026!';
const printMarker = 'OFFLINE-UNITCOUNT-PRINT-72d1';
const stderrMarker = 'OFFLINE-UNITCOUNT-STDERR-72d2';
const providerSecret = 'shared-test-model-key-do-not-return';
const rawReportMarker = 'PRIVATE-UNITCOUNT-REPORT-72d3';
const completedSummary = '已检查 8 个账号、26 条预约；发现 2 条 UnitCount 为 0 的预约，请业务人员核对。';
const partialSummary = '8 个账号中 2 个登录失败，已检查其余 6 个账号；本次检查不完整，不能认定全部正常。';

test('offline UnitCount reports flow through scheduled and manual runs, group delivery, and administrator-only print logs', { timeout: 45_000 }, async t => {
  const tasks = [];
  let registrationPath, counter;
  let now = new Date('2026-10-28T19:59:30Z'); // October 29, 03:59:30 Asia/Shanghai.
  const fixture = await createFixture({
    prefix: 'unit-count-schedule-integration',
    options: {
      scheduler: { autoStart: false, now: () => new Date(now) },
      channels: { autoStart: false },
      workTasks: { autoStart: false },
      business: { tasks, now: () => new Date(now) },
    },
    seed: async ({ workspace, dataDir }) => {
      const cwd = path.join(workspace, '离线 UnitCount 固定入口');
      const resultDirectory = path.join(dataDir, 'unit-count-results');
      await mkdir(cwd);
      await mkdir(resultDirectory);
      const scriptPath = path.join(cwd, 'unit-count-fixture.mjs');
      registrationPath = path.join(cwd, 'registration.json');
      counter = path.join(cwd, 'executions.jsonl');
      await writeFile(registrationPath, JSON.stringify({ mode: 'completed', resultDirectory, counter }));
      // This fixed Node fixture substitutes only the Python executable. It makes
      // no business requests; the actual server, scheduler and delivery run.
      await writeFile(scriptPath, `
        import fs from 'node:fs';
        import path from 'node:path';
        const config=JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
        const runId=process.env.PI_BUSINESS_RUN_ID;
        fs.appendFileSync(config.counter, JSON.stringify({runId,legacyRunId:process.env.RPAC_EXECUTION_ID})+'\\n');
        console.log('${printMarker}');
        console.error('${stderrMarker}');
        console.log('${providerSecret}');
        const partial=config.mode==='partial';
        const result={schemaVersion:1,runId,status:partial?'partial':'completed',businessOutcome:partial?'incomplete':'abnormal',complete:!partial,
          summary:partial?${JSON.stringify(partialSummary)}:${JSON.stringify(completedSummary)},
          counts:{accounts:8,checked:partial?6:8,anomalies:2},findings:[{privateValue:'${rawReportMarker}'}]};
        const file=path.join(config.resultDirectory,runId+'.json');
        fs.writeFileSync(file+'.tmp',JSON.stringify(result));
        fs.renameSync(file+'.tmp',file);
        process.exitCode=partial?2:0;
      `, 'utf8');
      tasks.push({ id: 'unit-count-offline-fixture', name: 'Amazon UnitCount 异常检查', source: 'local',
        pythonPath: process.execPath, scriptPath, cwd, registrationPath, args: [], resultDirectory,
        claimScope: 'occurrence', timeoutSeconds: 20 });
    },
  });
  t.after(() => fixture.close());
  const admin = fixture.client(), member = fixture.client();
  const checked = async (client, route, options = {}, status = 200) => {
    const response = await client.request(route, options);
    assert.equal(response.response.status, status, `${route}: ${JSON.stringify(response.data)}`);
    return response.data;
  };
  await checked(admin, '/auth/setup', { method: 'POST', body: { username: 'unitcount-admin', displayName: '检查管理员', password } }, 201);
  await configure(admin, fixture);
  await checked(admin, '/admin/users', { method: 'POST', body: { username: 'unitcount-member', displayName: '检查业务员工', role: 'member', password } }, 201);
  await checked(member, '/auth/login', { method: 'POST', body: { username: 'unitcount-member', password } });
  const target = await collaborativeSession(admin, 'UnitCount 检查结果群');
  const other = await collaborativeSession(admin, '其他业务群');
  const schedule = (await checked(admin, '/admin/schedules', { method: 'POST', body: {
    name: 'UnitCount 每日 04:00', taskType: 'business', businessTaskId: tasks[0].id,
    executionMode: 'workspace', targetSessionId: target.id, prompt: '执行固定的离线 UnitCount 测试入口。',
    scheduleType: 'daily', time: '04:00', startDate: '2026-10-29', enabled: true,
  } }, 201)).schedule;
  assert.equal(schedule.nextRunAt, '2026-10-28T20:00:00.000Z');
  assert.equal(fixture.mock.requests.length, 0);

  const getRuns = async () => (await checked(admin, '/admin/task-runs')).runs.filter(run => run.scheduleId === schedule.id);
  const messages = async sessionId => (await checked(member, `/sessions/${sessionId}`)).messages;
  const assertSingleDelivery = async (run, expected) => {
    const rows = (await messages(target.id)).filter(message => message.taskRunId === run.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].content, expected);
    assert.equal(rows[0].role, 'assistant');
    assert.equal(rows[0].tools, undefined);
    for (const value of [printMarker, stderrMarker, rawReportMarker, providerSecret, fixture.workspace, 'schemaVersion', 'findings']) assert.ok(!rows[0].content.includes(value), value);
    assert.equal((await messages(other.id)).filter(message => message.taskRunId === run.id).length, 0);
    assert.equal(run.delivery.status, 'delivered');
  };
  const manual = async () => {
    const started = (await checked(admin, `/admin/schedules/${schedule.id}/run`, { method: 'POST', body: {} }, 202)).run;
    await fixture.server.piWeb.schedules.waitForIdle();
    return (await getRuns()).find(run => run.id === started.id);
  };

  now = new Date('2026-10-28T20:00:05Z');
  await fixture.server.piWeb.schedules.tick();
  await fixture.server.piWeb.schedules.waitForIdle();
  const first = (await getRuns())[0];
  assert.equal(first.trigger, 'scheduled');
  assert.equal(first.scheduledFor, '2026-10-28T20:00:00.000Z');
  assert.equal(first.status, 'succeeded', JSON.stringify(first));
  assert.equal(first.businessTaskId, tasks[0].id);
  assert.equal(first.sessionId, null);
  const successfulDelivery = `定时任务：${schedule.name}\n\n业务任务：${tasks[0].name}\n${completedSummary}`;
  await assertSingleDelivery(first, successfulDelivery);

  // The same business task can be manually rechecked after its scheduled run.
  const second = await manual();
  assert.notEqual(second.id, first.id);
  assert.equal(second.trigger, 'manual');
  assert.equal(second.businessTaskId, first.businessTaskId);
  assert.equal(second.status, 'succeeded', JSON.stringify(second));
  await assertSingleDelivery(second, successfulDelivery);

  const registration = JSON.parse(await readFile(registrationPath, 'utf8'));
  await writeFile(registrationPath, JSON.stringify({ ...registration, mode: 'partial' }));
  const partial = await manual();
  assert.equal(partial.status, 'failed', JSON.stringify(partial));
  assert.match(partial.error, /2 个登录失败/);
  assert.match(partial.error, /未完整完成/);
  await assertSingleDelivery(partial, `定时任务：${schedule.name}\n\n执行失败：业务任务：${tasks[0].name}\n${partialSummary}\n本次检查未完整完成，请在管理员执行日志中查看。`);

  for (const run of [first, second, partial]) {
    const log = await checked(admin, `/admin/task-runs/${run.id}/log`);
    assert.ok(log.content.includes(printMarker));
    assert.ok(log.content.includes(stderrMarker));
    assert.ok(!log.content.includes(providerSecret));
    assert.equal(log.run.status, run.status);
    assert.equal((await member.request(`/admin/task-runs/${run.id}/log`)).response.status, 403);
  }
  await checked(admin, `/admin/task-runs/${partial.id}/retry-delivery`, { method: 'POST', body: {} });
  assert.equal((await messages(target.id)).filter(message => message.taskRunId === partial.id).length, 1);
  const executions = (await readFile(counter, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(executions.length, 3, 'notification retries never repeat business execution');
  assert.deepEqual(new Set(executions.map(row => row.runId)), new Set([first.id, second.id, partial.id]));
  assert.ok(executions.every(row => row.runId === row.legacyRunId));
  assert.equal(fixture.mock.requests.length, 0, 'native checks and delivery must not invoke the AI provider');
});
