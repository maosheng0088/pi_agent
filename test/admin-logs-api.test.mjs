import assert from 'node:assert/strict';
import { before, after, describe, it } from 'node:test';
import { collectSSE, configure, createFixture, session } from './auth-helpers.mjs';

const password = 'Runtime-log-fixture-2026!';
async function checked(client, route, options, status = 200) {
  const result = await client.request(route, options);
  assert.equal(result.response.status, status, `${route}: ${JSON.stringify(result.data)}`);
  return result.data;
}
async function until(check, message, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error(`Timed out: ${message}`);
}

describe('Administrator runtime log APIs and real lifecycle hooks', { concurrency: false, timeout: 90000 }, () => {
  let fixture, admin, member, guest, memberUser, group;
  before(async () => {
    fixture = await createFixture({ prefix: 'admin-logs', options: { scheduler: { autoStart: false }, channels: { autoStart: false }, workTasks: { pollIntervalMs: 20 }, logs: { authIntervalMs: 50 } } });
    admin = fixture.client(); member = fixture.client(); guest = fixture.client();
    await checked(admin, '/auth/setup', { method: 'POST', body: { username: 'logs-admin', displayName: '日志管理员', password } }, 201);
    await configure(admin, fixture);
    memberUser = (await checked(admin, '/admin/users', { method: 'POST', body: { username: 'logs-member', displayName: '日志员工', role: 'member', password } }, 201)).user;
    await checked(member, '/auth/login', { method: 'POST', body: { username: 'logs-member', password } });
    group = await session(admin, '日志回归业务空间');
    await checked(admin, `/sessions/${group.id}/members`, { method: 'POST', body: { userIds: [memberUser.id] } });
  });
  after(async () => fixture?.close());

  it('protects every history/live/export route and does not produce self-poll feedback', async () => {
    for (const route of ['/admin/logs', '/admin/logs/live?after=0', '/admin/logs/export?format=txt']) {
      assert.equal((await guest.request(route)).response.status, 401);
      assert.equal((await member.request(route)).response.status, 403);
    }
    const first = await checked(admin, '/admin/logs');
    assert.ok(first.logs.some(log => log.source === 'system' && log.message.includes('已启动')));
    assert.deepEqual(first.sources, ['system', 'model', 'tasks', 'schedules', 'channels', 'auth', 'http', 'skills']);
    assert.deepEqual(first.retention, { maxEntries: 20000, maxAgeDays: 7 });
    for (let i = 0; i < 4; i++) assert.equal((await checked(admin, '/admin/logs')).cursor, first.cursor);
    for (const query of ['limit=0', 'after=-1', 'before=2&after=1', 'source=console', 'level=warn', 'from=2026-02-30T00%3A00%3A00Z', 'q=%00private', 'limit=1&limit=2']) assert.equal((await admin.request(`/admin/logs?${query}`)).response.status, 400, query);
    assert.equal((await checked(admin, '/admin/logs')).cursor, first.cursor);
    assert.equal((await admin.request('/admin/logs/live?before=1')).response.status, 400);
    assert.equal((await admin.request('/admin/logs/export?format=zip')).response.status, 400);
  });

  it('captures model completions and provider failures without storing employee text, tool output or API keys', async () => {
    await admin.send(group.id, 'employee-private-model-input-6571');
    await admin.send(group.id, '[provider-error] employee-private-provider-input-6572');
    const result = await checked(admin, `/admin/logs?source=model&q=${group.id}`);
    assert.ok(result.logs.some(log => log.message === '模型处理结束' && log.details.status === 'succeeded' && Number.isInteger(log.details.durationMs)));
    assert.ok(result.logs.some(log => log.level === 'ERROR' && log.message === '模型调用失败' && log.details.statusCode === 500));
    const all = JSON.stringify(await checked(admin, '/admin/logs'));
    for (const value of ['employee-private-model-input-6571', 'employee-private-provider-input-6572', 'shared-test-model-key-do-not-return', 'Local fixture provider failure', '本次回复来自本地集成测试模型']) assert.ok(!all.includes(value), value);
  });

  it('captures actual queued/running/succeeded and failed work tasks with exact searchable IDs', async () => {
    const taskGroup = await session(admin, '独立任务日志回归');
    await checked(admin, `/sessions/${taskGroup.id}/members`, { method: 'POST', body: { userIds: [memberUser.id] } });
    const start = async instruction => (await checked(member, `/sessions/${taskGroup.id}/tasks`, { method: 'POST', body: { instruction } }, 202)).task;
    const success = await start('employee-private-task-input-9534');
    await until(async () => { const task = (await checked(member, `/sessions/${taskGroup.id}/tasks/${success.id}`)).task; if (task.status === 'failed') assert.fail(JSON.stringify(task)); return task.status === 'succeeded'; }, 'work task success');
    const events = (await checked(admin, `/admin/logs?source=tasks&q=${success.id}`)).logs;
    assert.deepEqual(events.map(log => log.details.event), ['created', 'running', 'succeeded']);
    assert.ok(events.every(log => log.taskId === success.id && log.sessionId === taskGroup.id));
    const failure = await start('[provider-error] employee-private-task-input-9535');
    await until(async () => (await checked(member, `/sessions/${taskGroup.id}/tasks/${failure.id}`)).task.status === 'failed', 'work task failure');
    assert.ok((await checked(admin, `/admin/logs?source=tasks&q=${failure.id}`)).logs.some(log => log.level === 'ERROR' && log.details.event === 'failed' && log.details.reason));
    const all = JSON.stringify(await checked(admin, '/admin/logs'));
    assert.ok(!all.includes('employee-private-task-input-9534')); assert.ok(!all.includes('employee-private-task-input-9535'));
  });

  it('records successful execution separately when durable result delivery fails internally', async () => {
    const plan = (await checked(admin, '/admin/schedules', { method: 'POST', body: { name: '日志投递测试', targetSessionId: group.id, prompt: 'employee-private-schedule-input-4629', executionMode: 'read-only', scheduleType: 'daily', time: '09:00', enabled: false } }, 201)).schedule;
    const delivery = fixture.server.piWeb.taskDelivery, originalPublish = delivery.publish;
    try {
      delivery.publish = () => { throw new Error('结果投递失败 token=fixture-delivery-token employee-private-delivery-output'); };
      const run = (await checked(admin, `/admin/schedules/${plan.id}/run`, { method: 'POST', body: {} }, 202)).run;
      await fixture.server.piWeb.schedules.waitForIdle();
      assert.equal(fixture.server.piWeb.schedules.getRun(run.id).status, 'succeeded');
      assert.equal(delivery.get(run.id).status, 'failed');
      const logs = (await checked(admin, `/admin/logs?source=schedules&q=${run.id}`)).logs;
      assert.ok(logs.some(log => log.details.action === 'schedule.run_finished' && log.details.status === 'succeeded'));
      assert.ok(logs.some(log => log.level === 'ERROR' && log.details.phase === 'delivery' && log.details.status === 'failed' && log.message === '定时任务结果投递失败'));
      assert.ok(!JSON.stringify(logs).includes('fixture-delivery-token')); assert.ok(!JSON.stringify(logs).includes('employee-private-delivery-output'));
    } finally { delivery.publish = originalPublish; }
  });

  it('records group membership revocation and stops the affected real task without logging its text', async () => {
    const taskGroup = await session(admin, '成员撤权日志回归');
    await checked(admin, `/sessions/${taskGroup.id}/members`, { method: 'POST', body: { userIds: [memberUser.id] } });
    const task = (await checked(member, `/sessions/${taskGroup.id}/tasks`, { method: 'POST', body: { instruction: '[slow-response] employee-private-revoked-task-7831' } }, 202)).task;
    await until(async () => (await checked(admin, `/sessions/${taskGroup.id}/tasks/${task.id}`)).task.status === 'running', 'real task running');
    await checked(admin, `/sessions/${taskGroup.id}/members/${memberUser.id}`, { method: 'DELETE', body: {} });
    await until(async () => (await checked(admin, `/sessions/${taskGroup.id}/tasks/${task.id}`)).task.status === 'cancelled', 'revoked task cancelled');
    const logs = (await checked(admin, `/admin/logs?source=tasks&q=${task.id}`)).logs;
    assert.ok(logs.some(log => log.details.event === 'cancelled' && log.details.reason.includes('权限')));
    assert.ok(!JSON.stringify(logs).includes('employee-private-revoked-task-7831'));
  });

  it('logs safe HTTP failures and important auth/skill operations while preserving operation audit', async () => {
    await admin.request('/sessions/missing-private-path-539/profile');
    const httpLogs = (await checked(admin, '/admin/logs?source=http')).logs;
    assert.ok(httpLogs.some(log => log.details.path === '/api/sessions/:id/profile' && log.details.statusCode === 404));
    assert.ok(!JSON.stringify(httpLogs).includes('missing-private-path-539'));
    await guest.request('/auth/login', { method: 'POST', body: { username: 'unknown', password: 'never-return-password-758' } });
    const skill = (await checked(admin, '/admin/skills', { method: 'POST', body: { name: 'runtime-log-fixture-skill', description: '测试技能', content: 'employee-private-skill-body-9841', enabled: false } }, 201)).skill;
    assert.ok((await checked(admin, '/admin/logs?source=skills')).logs.some(log => log.details.action === 'skill.created' && log.details.targetId === skill.id));
    assert.ok((await checked(admin, '/admin/logs?source=auth')).logs.some(log => log.details.action === 'auth.login_failed' && log.level === 'WARNING'));
    assert.ok((await checked(admin, '/admin/audit')).events.some(event => event.action === 'auth.login_failed'));
    assert.ok(!JSON.stringify(await checked(admin, '/admin/logs')).includes('never-return-password-758'));
    assert.ok(!JSON.stringify(await checked(admin, '/admin/logs')).includes('employee-private-skill-body-9841'));
  });

  it('exports only sanitized bounded NDJSON/TXT and labels truncation explicitly', async () => {
    const logs = fixture.server.piWeb.logs;
    for (let i = 0; i < 5003; i++) {
      logs.write({ source: 'system', message: `export-fixture ${i} shared-test-model-key-do-not-return`, details: { apiKey: 'arbitrary-private-key', stdout: 'never-export-tool-output' } });
      // Let HTTP keep-alive timers run while seeding a large fixture backlog.
      if (i % 100 === 0) await new Promise(resolve => setImmediate(resolve));
    }
    const response = await admin.fetch('/admin/logs/export?q=export-fixture');
    assert.equal(response.status, 200); assert.equal(response.headers.get('x-log-export-truncated'), 'true'); assert.equal(response.headers.get('x-log-export-count'), '5000');
    const text = await response.text(), rows = text.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(rows.length, 5001); assert.equal(rows[0].type, 'meta'); assert.equal(rows[0].truncated, true);
    assert.ok(rows.slice(2).every((row, index) => row.id > rows[index + 1].id));
    for (const value of ['shared-test-model-key-do-not-return', 'arbitrary-private-key', 'never-export-tool-output']) assert.ok(!text.includes(value), value);
    const txt = await admin.fetch('/admin/logs/export?format=txt&source=auth');
    assert.equal(txt.headers.get('x-log-export-truncated'), 'false'); assert.match(await txt.text(), /未截断/u);
  });

  it('live backlog resumes all unseen rows and ends on logout, password reset, disable or role loss', async () => {
    async function administrator(username) {
      const client = fixture.client();
      const user = (await checked(admin, '/admin/users', { method: 'POST', body: { username, displayName: username, role: 'admin', password } }, 201)).user;
      await checked(client, '/auth/login', { method: 'POST', body: { username, password } });
      return { client, user };
    }
    for (const action of ['logout', 'reset', 'disable', 'role']) {
      const { client, user } = await administrator(`logs-${action}`);
      const cursor = (await checked(client, '/admin/logs')).cursor;
      const controller = new AbortController();
      const response = await fetch(`${fixture.baseUrl}/api/admin/logs/live?after=${cursor}&source=tasks`, { headers: { cookie: client.cookie }, signal: controller.signal });
      assert.equal(response.status, 200);
      const received = []; const collecting = collectSSE(response, event => received.push(event));
      try {
        for (let i = 0; i < 305; i++) fixture.server.piWeb.logs.write({ source: 'tasks', message: `live-fixture-${action}-${i}` });
        await until(() => received.filter(event => event.type === 'logs').flatMap(event => event.logs).length === 305, `${action} backlog`);
        if (action === 'logout') await checked(client, '/auth/logout', { method: 'POST', body: {} });
        else if (action === 'reset') await checked(admin, `/admin/users/${user.id}`, { method: 'PATCH', body: { password: 'Reset-runtime-fixture-only-321!' } });
        else if (action === 'disable') await checked(admin, `/admin/users/${user.id}`, { method: 'PATCH', body: { disabled: true } });
        else fixture.server.piWeb.logs.db.prepare("UPDATE users SET role='member' WHERE id=?").run(user.id);
        await Promise.race([collecting, new Promise((_, reject) => setTimeout(() => reject(new Error('Stream remained open after authorization loss')), 3000).unref())]);
        assert.equal(received.at(-1).type, 'auth_expired', action);
        const count = received.length;
        fixture.server.piWeb.logs.write({ source: 'tasks', message: 'post-revocation must not be delivered' });
        await new Promise(resolve => setTimeout(resolve, 60)); assert.equal(received.length, count);
        assert.equal(fixture.server.piWeb.logs.streams.size, 0);
      } finally { controller.abort(); await collecting.catch(() => {}); }
    }
  });

  it('persists logs across restart and closes streams before SQLite during service shutdown', async () => {
    const interrupted = (await checked(admin, `/sessions/${group.id}/tasks`, { method: 'POST', body: { instruction: '[slow-response] restart fixture', title: '重启中断任务' } }, 202)).task;
    await fixture.server.piWeb.workTasks.stop({ drain: true });
    fixture.server.piWeb.logs.db.prepare("UPDATE work_tasks SET status='running' WHERE id=?").run(interrupted.id);
    const marker = fixture.server.piWeb.logs.write({ message: 'restart-persistence-fixture', source: 'system' });
    const oldService = fixture.server.piWeb.logs;
    const response = await fetch(`${fixture.baseUrl}/api/admin/logs/live?after=${marker.id}`, { headers: { cookie: admin.cookie } });
    const collecting = collectSSE(response);
    await fixture.stop(); await collecting;
    assert.equal(oldService.streams.size, 0); assert.equal(oldService.closed, true);
    await fixture.start();
    const persisted = await checked(admin, '/admin/logs?q=restart-persistence-fixture');
    assert.equal(persisted.logs.length, 1); assert.equal(persisted.logs[0].id, marker.id);
    assert.ok((await checked(admin, '/admin/logs?source=system&limit=10')).logs.some(log => log.message === 'Pi Web 服务已停止'));
    assert.ok((await checked(admin, `/admin/logs?source=tasks&q=${interrupted.id}`)).logs.some(log => log.details.event === 'interrupted' && log.details.reason.includes('重启')));
  });
});
