import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createFixture, configure, collaborativeSession, collectSSE } from './auth-helpers.mjs';
import { Store } from '../lib/store.mjs';
import { SkillCatalog } from '../lib/skills.mjs';

const password = 'Business-schedule-fixture-2026!';
async function setup() {
  const fixture = await createFixture({ prefix: 'business-schedule', options: { scheduler: { autoStart: false }, channels: { autoStart: false } } });
  const admin = fixture.client(), member = fixture.client();
  await admin.request('/auth/setup', { method: 'POST', body: { username: 'schedule-admin', displayName: '任务管理员', password } });
  await configure(admin, fixture);
  await admin.request('/admin/users', { method: 'POST', body: { username: 'schedule-member', displayName: '业务员工', role: 'member', password } });
  await member.request('/auth/login', { method: 'POST', body: { username: 'schedule-member', password } });
  const target = await collaborativeSession(admin, '报价业务群');
  async function task(body = {}, actor = admin) {
    const result = await actor.request('/admin/schedules', { method: 'POST', body: {
      name: '业务报表', targetSessionId: target.id, executionMode: 'read-only', prompt: 'Generate the scheduled report.',
      scheduleType: 'daily', time: '09:00', enabled: false, ...body,
    } });
    assert.equal(result.response.status, 201, JSON.stringify(result.data)); return result.data.schedule;
  }
  async function run(task) {
    const started = await admin.request(`/admin/schedules/${task.id}/run`, { method: 'POST', body: {} });
    assert.equal(started.response.status, 202, JSON.stringify(started.data));
    await fixture.server.piWeb.schedules.waitForIdle();
    return (await admin.request('/admin/task-runs')).data.runs.find(run => run.id === started.data.run.id);
  }
  return { fixture, admin, member, target, task, run };
}

test('business task permissions run a real script; final results are searchable by members and usable for follow-up', { timeout: 45_000 }, async () => {
  const f = await setup();
  try {
    const { fixture, admin, member, target } = f;
    await admin.send(target.id, 'BUSINESS-HISTORY-NOT-WORKER-CONTEXT');
    const store = new Store(fixture.dataDir, fixture.workspace);
    let skill;
    try {
      skill = await new SkillCatalog(store).createSnapshot({ name: 'scheduled-business-fixture', description: 'Run the supplied business script.', content: 'Run scripts/report.mjs and return its output.', enabled: true }, [
        { path: 'SKILL.md', data: Buffer.from('# Fixture') },
        { path: 'scripts/report.mjs', data: Buffer.from("import fs from 'node:fs';fs.appendFileSync('execution-count.txt','run\\n');console.log('BUSINESS-SCRIPT-FINAL-983c');") },
      ]);
    } finally { store.close(); }
    const script = path.join(fixture.dataDir, 'skills', skill.id, 'v1', 'scripts', 'report.mjs');
    const plan = await f.task({ skillId: skill.id, executionMode: 'workspace', prompt: `Please [run-skill-script:${script}] and return the final result.` });
    const before = fixture.mock.requests.length;
    const run = await f.run(plan);
    assert.equal(run.status, 'succeeded', JSON.stringify(run));
    assert.equal(run.delivery.status, 'delivered', JSON.stringify(run));
    assert.equal(run.targetSessionId, target.id);
    assert.equal(run.executionMode, 'workspace');
    assert.equal(await readFile(path.join(target.cwd, 'execution-count.txt'), 'utf8'), 'run\n');
    const wire = fixture.mock.requests.slice(before);
    assert.ok(wire.some(request => request.tools.some(tool => ['powershell', 'bash'].includes(tool.function.name))));
    assert.ok(!JSON.stringify(wire).includes('BUSINESS-HISTORY-NOT-WORKER-CONTEXT'));
    const history = await member.request(`/sessions/${target.id}`);
    const final = history.data.messages.filter(message => message.taskRunId === run.id);
    assert.equal(final.length, 1); assert.match(final[0].content, /BUSINESS-SCRIPT-FINAL-983c/);
    assert.equal(final[0].role, 'assistant'); assert.equal(final[0].tools, undefined);
    assert.equal((await member.request(`/sessions/${run.sessionId}`)).response.status, 404);
    const search = await member.request(`/sessions/${target.id}/search?q=BUSINESS-SCRIPT-FINAL-983c`);
    assert.equal(search.response.status, 200); assert.equal(search.data.total, 1);
    await member.send(target.id, 'Explain the latest scheduled report.');
    assert.match(JSON.stringify(fixture.mock.requests.at(-1).messages), /BUSINESS-SCRIPT-FINAL-983c/);
    assert.equal((await member.request(`/admin/task-runs/${run.id}/retry-delivery`, { method: 'POST', body: {} })).response.status, 403);
    const requests = fixture.mock.requests.length;
    assert.equal((await admin.request(`/admin/task-runs/${run.id}/retry-delivery`, { method: 'POST', body: {} })).response.status, 200);
    assert.equal(fixture.mock.requests.length, requests);
    assert.equal((await member.request(`/sessions/${target.id}`)).data.messages.filter(message => message.taskRunId === run.id).length, 1);
    const readOnly = await f.task({ skillId: skill.id, prompt: `Please [run-skill-script:${script}].` });
    const readStart = fixture.mock.requests.length;
    await f.run(readOnly);
    assert.ok(fixture.mock.requests.slice(readStart).every(request => !request.tools.some(tool => ['write', 'edit', 'powershell', 'bash'].includes(tool.function.name))));
    assert.equal(await readFile(path.join(target.cwd, 'execution-count.txt'), 'utf8'), 'run\n');
  } finally { await f.fixture.close(); }
});

test('failed delivery retries saved output only; a result posted during a group turn remains searchable', { timeout: 30_000 }, async () => {
  const f = await setup();
  try {
    const { fixture, admin, member, target } = f;
    const original = fixture.server.piWeb.channels.publishTask.bind(fixture.server.piWeb.channels);
    let attempts = 0;
    fixture.server.piWeb.channels.publishTask = (...args) => { if (++attempts === 1) throw new Error('Fixture delivery unavailable'); return original(...args); };
    const plan = await f.task(); const run = await f.run(plan);
    assert.equal(run.status, 'succeeded'); assert.equal(run.delivery.status, 'failed');
    const count = fixture.mock.requests.length;
    const retry = await admin.request(`/admin/task-runs/${run.id}/retry-delivery`, { method: 'POST', body: {} });
    assert.equal(retry.response.status, 200); assert.equal(retry.data.run.delivery.status, 'delivered');
    assert.equal(fixture.mock.requests.length, count);
    const response = await admin.fetch(`/sessions/${target.id}/messages`, { method: 'POST', body: { message: '[slow-response] hold business group active' } });
    const stream = collectSSE(response);
    const next = await f.run(await f.task({ name: '运行中群结果' }));
    const search = await member.request(`/sessions/${target.id}/search?q=${encodeURIComponent('运行中群结果')}`);
    assert.equal(search.response.status, 200); assert.equal(search.data.total, 1);
    assert.equal(search.data.results[0].taskRunId, next.id);
    assert.equal(search.data.session.running, true);
    await admin.request(`/sessions/${target.id}/abort`, { method: 'POST', body: {} }); await stream;
    const history = await member.request(`/sessions/${target.id}`);
    assert.equal(history.data.messages.filter(message => message.taskRunId === run.id).length, 1);
  } finally { await f.fixture.close(); }
});

test('new plans require an accessible business group and failures post only a final summary', { timeout: 30_000 }, async () => {
  const f = await setup();
  try {
    const base = { name: 'No target', prompt: 'No work', scheduleType: 'daily', time: '09:00' };
    assert.equal((await f.admin.request('/admin/schedules', { method: 'POST', body: base })).response.status, 400);
    assert.equal((await f.admin.request('/admin/schedules', { method: 'POST', body: { ...base, targetSessionId: 'missing-group' } })).response.status, 404);
    const outsider = f.fixture.client();
    await f.admin.request('/admin/users', { method: 'POST', body: { username: 'outside-admin', displayName: '外部管理员', password, role: 'admin' } });
    await outsider.request('/auth/login', { method: 'POST', body: { username: 'outside-admin', password } });
    assert.equal((await outsider.request('/admin/schedules', { method: 'POST', body: { ...base, targetSessionId: f.target.id } })).response.status, 404);
    const plan = await f.task({ prompt: '[provider-error] fixture failure' });
    const run = await f.run(plan);
    assert.equal(run.status, 'failed'); assert.equal(run.delivery.status, 'delivered');
    const history = (await f.member.request(`/sessions/${f.target.id}`)).data.messages.filter(message => message.taskRunId === run.id);
    assert.equal(history.length, 1); assert.match(history[0].content, /失败/);
    const memberId = (await f.admin.request('/directory')).data.users.find(user => user.username === 'schedule-member').id;
    await f.admin.request(`/sessions/${f.target.id}/members/${memberId}`, { method: 'DELETE', body: {} });
    assert.equal((await f.member.request(`/sessions/${f.target.id}`)).response.status, 404);
  } finally { await f.fixture.close(); }
});

test('another administrator cannot edit a task outside their group and removing its owner cancels an active worker', { timeout: 30_000 }, async () => {
  const f = await setup();
  try {
    const ownerResult = await f.admin.request('/admin/users', { method: 'POST', body: { username: 'job-owner', displayName: '任务所有人', role: 'admin', password } });
    const outsiderResult = await f.admin.request('/admin/users', { method: 'POST', body: { username: 'job-outsider', displayName: '其他管理员', role: 'admin', password } });
    assert.equal(outsiderResult.response.status, 201);
    const owner = f.fixture.client(), outsider = f.fixture.client();
    await owner.request('/auth/login', { method: 'POST', body: { username: 'job-owner', password } });
    await outsider.request('/auth/login', { method: 'POST', body: { username: 'job-outsider', password } });
    await f.admin.request(`/sessions/${f.target.id}/members`, { method: 'POST', body: { userIds: [ownerResult.data.user.id] } });
    const plan = await f.task({ prompt: '[slow-response] revoked-scheduled-worker-98fe' }, owner);
    assert.equal((await outsider.request(`/admin/schedules/${plan.id}`, { method: 'PATCH', body: { executionMode: 'workspace', prompt: 'Forged work' } })).response.status, 404);
    const started = await f.admin.request(`/admin/schedules/${plan.id}/run`, { method: 'POST', body: {} });
    const deadline = Date.now() + 10000;
    while (!f.fixture.mock.requests.some(request => JSON.stringify(request.messages).includes('revoked-scheduled-worker-98fe')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(f.fixture.mock.requests.some(request => JSON.stringify(request.messages).includes('revoked-scheduled-worker-98fe')));
    await f.admin.request(`/sessions/${f.target.id}/members/${ownerResult.data.user.id}`, { method: 'DELETE', body: {} });
    await f.fixture.server.piWeb.schedules.waitForIdle();
    const run = f.fixture.server.piWeb.schedules.getRun(started.data.run.id);
    assert.equal(run.status, 'cancelled');
    assert.equal(f.fixture.server.piWeb.taskDelivery.history(f.target.id).length, 0);
  } finally { await f.fixture.close(); }
});

test('restart delivers a committed execution result without replaying its model or business action', { timeout: 30_000 }, async () => {
  const f = await setup();
  try {
    const run = await f.run(await f.task());
    const requests = f.fixture.mock.requests.length;
    await f.fixture.stop();
    const store = new Store(f.fixture.dataDir, f.fixture.workspace);
    try {
      // Reproduce the durable state after execution commits but before posting.
      store.db.prepare('DELETE FROM task_deliveries WHERE run_id=?').run(run.id);
      store.db.prepare('DELETE FROM task_group_messages WHERE run_id=?').run(run.id);
    } finally { store.close(); }
    await f.fixture.start();
    await f.fixture.server.piWeb.schedules.waitForIdle();
    assert.equal(f.fixture.mock.requests.length, requests);
    assert.equal(f.fixture.server.piWeb.taskDelivery.get(run.id).status, 'delivered');
    assert.equal(f.fixture.server.piWeb.taskDelivery.history(f.target.id).filter(message => message.taskRunId === run.id).length, 1);
  } finally { await f.fixture.close(); }
});
