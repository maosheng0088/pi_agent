import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { BusinessTaskService } from '../lib/business-tasks.mjs';
import { TaskDeliveryService } from '../lib/task-delivery.mjs';
import { Store } from '../lib/store.mjs';
import { createFixture, configure, session } from './auth-helpers.mjs';
import { sessionTools } from '../lib/shared-tools.mjs';

const fixtures = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.store.close();
    assert.equal(path.dirname(fixture.directory), os.tmpdir());
    await fs.rm(fixture.directory, { recursive: true, force: true });
  }
});
const attention = (runId, overrides = {}) => ({ schemaVersion: 1, runId, status: 'waiting_human',
  kind: 'verification_required', carrier: 'KAPE', browser: 'Chromium', message: '需要完成浏览器验证',
  createdAt: new Date().toISOString(), ...overrides });
async function isolated({ humanAttention = true, event = {}, released = false } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-business-attention-'));
  const cwd = path.join(directory, 'project');
  const resultDirectory = path.join(cwd, 'results');
  await fs.mkdir(resultDirectory, { recursive: true });
  const registrationPath = path.join(cwd, 'registration.json');
  const scriptPath = path.join(cwd, 'run.mjs');
  const release = path.join(cwd, 'release');
  await fs.writeFile(registrationPath, JSON.stringify({ resultDirectory, release, event }));
  if (released) await fs.writeFile(release, 'done');
  await fs.writeFile(scriptPath, `
    import fs from 'node:fs'; import path from 'node:path';
    const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    const runId = process.env.PI_BUSINESS_RUN_ID;
    const event = {schemaVersion:1,runId,status:'waiting_human',kind:'verification_required',carrier:'KAPE',browser:'Chromium',message:'Do not share secret D:/private/cookies.json https://private.invalid/?token=SECRET',createdAt:new Date().toISOString(),...config.event};
    const file = path.join(config.resultDirectory, runId+'.attention.json');
    fs.writeFileSync(file+'.tmp', JSON.stringify(event)); fs.renameSync(file+'.tmp', file);
    console.log('Waiting for local fixture verification.');
    while (!fs.existsSync(config.release)) await new Promise(resolve=>setTimeout(resolve,20));
    fs.writeFileSync(path.join(config.resultDirectory,runId+'.json'), JSON.stringify({schemaVersion:1,runId,status:'completed',summary:'已完成检查，共检查 8 个预约，无零值异常。'}));
  `);
  const store = new Store(path.join(directory, '.data'), cwd);
  const task = { id: 'unit-count-fixture', name: '预约件数检查', pythonPath: process.execPath,
    scriptPath, registrationPath, cwd, resultDirectory, humanAttention, timeoutSeconds: 10, claimScope: 'occurrence' };
  const service = new BusinessTaskService(store, { tasks: [task] });
  const fixture = { directory, cwd, resultDirectory, release, task, service, store };
  fixtures.push(fixture);
  return fixture;
}
async function until(check) {
  const limit = Date.now() + 6000;
  while (Date.now() < limit) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail('Expected isolated task state was not reached');
}

test('opt-in verification notice arrives while the real process is running, is deduplicated, and final delivery is independent', { timeout: 15000 }, async () => {
  const f = await isolated();
  const sent = [], prepared = [], posted = [];
  const delivery = new TaskDeliveryService(f.store, { publish: (...args) => sent.push(args),
    preparePublish: (...args) => prepared.push(args), onPosted: id => posted.push(id),
    validateTarget: (schedule, phase) => { assert.equal(schedule.targetSessionId, 'unit-group'); assert.equal(phase.phase, 'delivery'); } });
  const schedule = { name: '预约件数检查', taskType: 'business', targetSessionId: 'unit-group' };
  const run = { id: 'waiting-first', status: 'running' };
  let notices = 0, finished = false;
  const work = f.service.run(f.task.id, { runId: run.id, onAttention: event => {
    notices++;
    assert.equal(event.message, undefined, 'Free-form program messages never enter the callback');
    assert.equal(finished, false);
    assert.equal(f.store.db.prepare('SELECT status FROM business_execution_claims WHERE run_id=?').get(run.id).status, 'running');
    return delivery.attention({ schedule, run, event });
  } });
  work.finally(() => { finished = true; }).catch(() => {});
  try {
    await until(() => delivery.history('unit-group', { includeAttention: true }).length === 1);
    const pending = delivery.history('unit-group', { includeAttention: true })[0];
    assert.match(pending.content, /完成浏览器验证后程序会继续/);
    assert.match(pending.content, /10 分钟/);
    assert.doesNotMatch(pending.content, /SECRET|cookies|private.invalid|D:\//);
    assert.equal(pending.taskRunId, undefined, 'A waiting notice is not a final-result card');
    assert.deepEqual(delivery.history('unit-group'), []);
    assert.deepEqual(delivery.context('unit-group'), []);
    assert.equal(delivery.get(run.id).status, 'not_required');
    assert.equal(sent.length, 0); assert.equal(prepared.length, 0);
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.equal(notices, 1);
    assert.equal(finished, false);
    await fs.writeFile(f.release, 'verified');
    const result = await work;
    assert.equal(result.exitCode, 0);
    assert.match(result.reply, /8 个预约/);
    await delivery.deliver({ schedule, run: { ...run, status: 'succeeded' }, result: result.reply });
    assert.equal(delivery.get(run.id).status, 'delivered');
    assert.equal(delivery.history('unit-group').length, 1);
    const adminHistory = delivery.history('unit-group', { includeAttention: true });
    assert.equal(adminHistory.length, 2);
    assert.match(adminHistory.find(item => item.id.startsWith('attention:')).content, /本次任务已结束/);
    assert.doesNotMatch(adminHistory.find(item => item.id.startsWith('attention:')).content, /正在等待/);
    assert.equal(sent.length, 1); assert.equal(prepared.length, 1);
    assert.equal(sent[0][1].messageId, `task:${run.id}`);
    assert.deepEqual(posted, ['unit-group', 'unit-group']);
  } finally { await fs.writeFile(f.release, 'release'); await work.catch(() => {}); }
});

test('the original tasks remain silent without explicit opt-in and malformed attention never invalidates a valid final result', async t => {
  for (const [label, options] of [
    ['not-enabled', { humanAttention: false }],
    ['wrong-run', { event: { runId: 'some-other-run' } }],
    ['wrong-status', { event: { status: 'completed' } }],
    ['unsafe-carrier', { event: { carrier: 'KAPE\nD:/private/cookie' } }],
    ['too-large', { event: { message: 'x'.repeat(9000) } }],
  ]) await t.test(label, async () => {
    const f = await isolated({ ...options, released: true });
    const result = await f.service.run(f.task.id, { runId: `invalid-${label}`, onAttention: () => assert.fail('Unexpected notice') });
    assert.equal(result.exitCode, 0);
    assert.match(result.reply, /8 个预约/);
  });
});

test('a notice callback failure cannot discard the completed check and old notification files cannot be replayed', async () => {
  const f = await isolated({ released: true, event: { carrier: '承运人甲' } });
  let called = false;
  const result = await f.service.run(f.task.id, { runId: 'callback-failure', onAttention: () => { called = true; throw new Error('Notification unavailable'); } });
  assert.equal(called, true); assert.equal(result.exitCode, 0);
  await fs.writeFile(path.join(f.resultDirectory, 'old-notice.attention.json'), JSON.stringify(attention('old-notice')));
  await assert.rejects(f.service.run(f.task.id, { runId: 'old-notice' }), /拒绝使用旧通知/);
  assert.equal(f.store.db.prepare('SELECT status FROM business_execution_claims WHERE run_id=?').get('old-notice'), undefined);
});

test('attention posting revalidates current authorization, persists once per carrier, never changes final delivery, and binds its original group', async () => {
  const f = await isolated({ released: true });
  let authorized = false, validations = 0;
  const delivery = new TaskDeliveryService(f.store, { publish: () => assert.fail('Must not publish externally'),
    preparePublish: () => assert.fail('Must not prepare external publication'),
    validateTarget: () => { validations++; if (!authorized) throw new Error('Current administrator is no longer a group member'); } });
  const input = { schedule: { name: 'Check', taskType: 'business', targetSessionId: 'original-group' }, run: { id: 'notice-auth' }, event: attention('notice-auth') };
  assert.throws(() => delivery.attention(input), /no longer/);
  assert.equal(delivery.history('original-group', { includeAttention: true }).length, 0);
  authorized = true;
  assert.equal(delivery.attention(input).posted, true);
  assert.equal(delivery.attention(input).posted, false);
  assert.equal(delivery.attention({ ...input, event: attention('notice-auth', { carrier: '承运人甲' }) }).posted, true);
  assert.throws(() => delivery.attention({ ...input, schedule: { ...input.schedule, targetSessionId: 'changed-group' } }), /不能变更/);
  assert.equal(delivery.history('changed-group', { includeAttention: true }).length, 0);
  assert.equal(delivery.get('notice-auth').status, 'not_required');
  assert.equal(validations, 5);
  authorized = false;
  assert.throws(() => delivery.attention(input), /no longer/);
});

test('HTTP history exposes verification notices to current group administrators only, excludes search and quotations for employees, and never triggers AI', { timeout: 20000 }, async () => {
  const fixture = await createFixture({ prefix: 'attention-authorization' });
  try {
    const admin = fixture.client(), employee = fixture.client(), outsider = fixture.client();
    const password = 'Attention-fixture-2026!';
    await admin.request('/auth/setup', { method: 'POST', body: { username: 'attention-admin', displayName: '管理员', password } });
    await configure(admin, fixture);
    const adminUser = (await admin.request('/auth/status')).data.user;
    const employeeUser = (await admin.request('/admin/users', { method: 'POST', body: { username: 'attention-member', displayName: '员工', password, role: 'member' } })).data.user;
    await admin.request('/admin/users', { method: 'POST', body: { username: 'outside-admin', displayName: '群外管理员', password, role: 'admin' } });
    await employee.request('/auth/login', { method: 'POST', body: { username: 'attention-member', password } });
    await outsider.request('/auth/login', { method: 'POST', body: { username: 'outside-admin', password } });
    const group = await session(admin, '预约件数检查助手');
    await admin.request(`/sessions/${group.id}/members`, { method: 'POST', body: { userIds: [employeeUser.id] } });
    const schedule = { name: '预约件数检查', taskType: 'business', targetSessionId: group.id, createdBy: adminUser.id };
    const notice = { schedule, run: { id: 'http-notice' }, event: attention('http-notice') };
    fixture.server.piWeb.taskDelivery.attention(notice);
    const adminHistory = (await admin.request(`/sessions/${group.id}`)).data.messages;
    const message = adminHistory.find(item => item.id.startsWith('attention:'));
    assert.ok(message); assert.match(message.content, /管理员处理/);
    assert.equal((await employee.request(`/sessions/${group.id}`)).data.messages.some(item => item.id.startsWith('attention:')), false);
    assert.equal((await outsider.request(`/sessions/${group.id}`)).response.status, 404);
    assert.equal((await employee.request(`/sessions/${group.id}/search?q=Amazon`)).data.total, 0);
    const quote = await employee.request(`/sessions/${group.id}/discussion`, { method: 'POST', body: { content: 'Try hidden notice', replyTo: message.id } });
    assert.ok([400, 404].includes(quote.response.status));
    assert.equal(fixture.mock.requests.length, 0);
    const disabled = await outsider.request(`/admin/users/${adminUser.id}`, { method: 'PATCH', body: { disabled: true } });
    assert.equal(disabled.response.status, 200);
    assert.throws(() => fixture.server.piWeb.taskDelivery.attention(notice), /登录状态已变更/);
    assert.equal((await admin.request(`/sessions/${group.id}`)).response.status, 401);
  } finally { await fixture.close(); }
});

test('the fixed UnitCount tool takes no arguments, respects mode, cancellation and live authorization, and returns a submission receipt', async () => {
  const f = await isolated({ released: true });
  const sdk = Object.fromEntries(['Read', 'Ls', 'Find', 'Grep', 'Write', 'Edit', 'PowerShell', 'Bash'].map(name => [
    `create${name}ToolDefinition`, () => ({ name: name.toLowerCase(), execute: async () => ({ content: [] }) }),
  ]));
  let authorized = true, submitted = 0;
  const options = { cwd: f.cwd, dataDir: f.store.directory, mode: 'workspace',
    authorize: () => { if (!authorized) throw new Error('Actor revoked'); },
    runUnitCountCheck: () => { submitted++; return { runId: 'fixed-run', status: 'queued', secret: 'DO-NOT-SHARE' }; } };
  const tools = await sessionTools(sdk, options);
  const tool = tools.customTools.find(value => value.name === 'run_unit_count_check');
  assert.ok(tool); assert.equal(tool.parameters.additionalProperties, false);
  const receipt = await tool.execute('call', {}, new AbortController().signal);
  assert.deepEqual(receipt.details, { runId: 'fixed-run', status: 'queued' });
  assert.match(receipt.content[0].text, /尚未完成/); assert.doesNotMatch(JSON.stringify(receipt), /DO-NOT-SHARE/);
  for (const args of [{ taskId: 'other-project' }, { groupId: 'other-group' }, { script: '../run.py' }, null, []]) {
    await assert.rejects(tool.execute('call', args), /不接受参数/);
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(tool.execute('call', {}, controller.signal), { name: 'AbortError' });
  authorized = false;
  await assert.rejects(tool.execute('call', {}), /Actor revoked/);
  assert.equal(submitted, 1);
  assert.ok(!(await sessionTools(sdk, { ...options, mode: 'read-only' })).tools.includes('run_unit_count_check'));
  assert.ok(!(await sessionTools(sdk, { ...options, runUnitCountCheck: undefined })).tools.includes('run_unit_count_check'));
});

async function unitCountProvider() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'test-model' }] })); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    const messages = body.messages || [];
    const user = [...messages].reverse().find(value => value.role === 'user');
    const text = typeof user?.content === 'string' ? user.content : (user?.content || []).map(value => value.text || '').join('');
    const available = body.tools?.some(value => value.function?.name === 'run_unit_count_check');
    const call = text.includes('[invoke-unit-count]') && available && messages.at(-1)?.role !== 'tool';
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'local-unit-count', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    send({ role: 'assistant', content: '' });
    if (call) send({ tool_calls: [{ index: 0, id: 'call_unit_count', type: 'function', function: { name: 'run_unit_count_check', arguments: '{}' } }] });
    else send({ content: messages.at(-1)?.role === 'tool' ? '任务提交信息已收到，最终结果等待 Pi 投递。' : '已检查当前可用工具。' });
    send({}, call ? 'tool_calls' : 'stop'); res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { requests, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}

test('a real SDK UnitCount invocation uses the fixed Pi schedule, sends attention during verification, and delivers exactly one final business result', { timeout: 30000 }, async () => {
  const f = await isolated();
  const provider = await unitCountProvider();
  const fixture = await createFixture({ prefix: 'unit-count-managed-tool', options: { scheduler: { autoStart: false }, channels: { autoStart: false },
    business: { tasks: [{ ...f.task, id: 'amazon-unit-count' }] } } });
  try {
    const admin = fixture.client(), employee = fixture.client();
    const password = 'Managed-unit-count-fixture-2026!';
    await admin.request('/auth/setup', { method: 'POST', body: { username: 'managed-admin', displayName: '管理员', password } });
    const employeeUser = (await admin.request('/admin/users', { method: 'POST', body: { username: 'managed-member', displayName: '员工', password, role: 'member' } })).data.user;
    await employee.request('/auth/login', { method: 'POST', body: { username: 'managed-member', password } });
    const configured = await admin.request('/config', { method: 'PUT', body: { provider: 'custom', model: 'test-model', baseUrl: `${provider.url}/v1`,
      apiKey: 'local-test-only', cwd: fixture.workspace, mode: 'workspace', systemPrompt: 'Offline managed UnitCount tool test.' } });
    assert.equal(configured.response.status, 200, JSON.stringify(configured.data));
    const group = await session(admin, '预约件数检查助手');
    const other = await session(admin, '其他智能体');
    await admin.request(`/sessions/${group.id}/members`, { method: 'POST', body: { userIds: [employeeUser.id] } });
    const scheduleResponse = await admin.request('/admin/schedules', { method: 'POST', body: { name: 'UnitCount 04:00', taskType: 'business', businessTaskId: 'amazon-unit-count',
      executionMode: 'workspace', targetSessionId: group.id, prompt: '执行固定检查。', scheduleType: 'daily', time: '04:00', enabled: true } });
    assert.equal(scheduleResponse.response.status, 201, JSON.stringify(scheduleResponse.data));
    const schedule = scheduleResponse.data.schedule;
    const visible = () => provider.requests.at(-1)?.tools?.some(value => value.function?.name === 'run_unit_count_check');
    await admin.send(other.id, 'Inspect unrelated group tools.'); assert.equal(visible(), false);
    await employee.send(group.id, 'Inspect employee tools.'); assert.equal(visible(), false);
    await admin.request(`/sessions/${group.id}`, { method: 'PATCH', body: { mode: 'read-only' } });
    await admin.send(group.id, 'Inspect read-only tools.'); assert.equal(visible(), false);
    await admin.request(`/sessions/${group.id}`, { method: 'PATCH', body: { mode: 'workspace' } });
    await admin.send(group.id, 'Inspect administrator tools.'); assert.equal(visible(), true);
    await admin.request(`/admin/schedules/${schedule.id}`, { method: 'PATCH', body: { enabled: false } });
    await admin.send(group.id, 'Inspect disabled schedule tools.'); assert.equal(visible(), false);
    await admin.request(`/admin/schedules/${schedule.id}`, { method: 'PATCH', body: { enabled: true } });
    const events = await admin.send(group.id, '[invoke-unit-count]');
    assert.ok(events.some(value => value.type === 'tool_end' && value.name === 'run_unit_count_check' && !value.isError));
    const runs = fixture.server.piWeb.schedules.runs();
    assert.equal(runs.length, 1); assert.equal(runs[0].businessTaskId, 'amazon-unit-count');
    assert.equal(runs[0].trigger, 'manual'); assert.equal(runs[0].targetSessionId, group.id);
    assert.ok(['queued', 'running'].includes(runs[0].status));
    assert.equal(fixture.server.piWeb.taskDelivery.history(group.id).length, 0);
    await until(() => fixture.server.piWeb.taskDelivery.history(group.id, { includeAttention: true }).some(value => value.id.startsWith('attention:')));
    const duplicate = await admin.send(group.id, '[invoke-unit-count]');
    assert.ok(duplicate.some(value => value.type === 'tool_end' && value.name === 'run_unit_count_check' && value.isError));
    assert.equal(fixture.server.piWeb.schedules.runs().length, 1);
    assert.equal((await employee.request(`/sessions/${group.id}`)).data.messages.some(value => value.id.startsWith('attention:')), false);
    await fs.writeFile(f.release, 'verification complete');
    await fixture.server.piWeb.schedules.waitForIdle();
    assert.equal(fixture.server.piWeb.schedules.getRun(runs[0].id).status, 'succeeded');
    const final = fixture.server.piWeb.taskDelivery.history(group.id);
    assert.equal(final.length, 1); assert.equal(final[0].taskRunId, runs[0].id); assert.match(final[0].content, /8 个预约/);
    assert.equal(fixture.server.piWeb.taskDelivery.history(other.id, { includeAttention: true }).length, 0);
    assert.match(fixture.server.piWeb.taskDelivery.history(group.id, { includeAttention: true }).find(value => value.id.startsWith('attention:')).content, /本次任务已结束/);
  } finally { await fs.writeFile(f.release, 'release'); await fixture.close(); await provider.close(); }
});

test('cancellation and service interruption close a waiting verification prompt without inventing a final result, including after restart', { timeout: 30000 }, async t => {
  for (const status of ['cancelled', 'interrupted']) await t.test(status, async () => {
    const f = await isolated();
    const fixture = await createFixture({ prefix: `attention-${status}`, options: { scheduler: { autoStart: false }, channels: { autoStart: false },
      business: { tasks: [{ ...f.task, id: 'amazon-unit-count' }] } } });
    try {
      const admin = fixture.client();
      await admin.request('/auth/setup', { method: 'POST', body: { username: 'attention-stop-admin', displayName: '管理员', password: 'Attention-stop-fixture-2026!' } });
      await configure(admin, fixture);
      const group = await session(admin, '预约件数检查助手');
      const created = await admin.request('/admin/schedules', { method: 'POST', body: { name: 'UnitCount 04:00', taskType: 'business', businessTaskId: 'amazon-unit-count',
        executionMode: 'workspace', targetSessionId: group.id, prompt: '执行固定检查。', scheduleType: 'daily', time: '04:00', enabled: true } });
      assert.equal(created.response.status, 201, JSON.stringify(created.data));
      const submitted = await admin.request(`/admin/schedules/${created.data.schedule.id}/run`, { method: 'POST', body: {} });
      assert.equal(submitted.response.status, 202, JSON.stringify(submitted.data));
      const runId = submitted.data.run.id;
      await until(() => fixture.server.piWeb.taskDelivery.history(group.id, { includeAttention: true }).some(value => value.id.startsWith('attention:')));
      const waiting = fixture.server.piWeb.taskDelivery.history(group.id, { includeAttention: true })[0];
      assert.match(waiting.content, /当前任务仍在运行/); assert.doesNotMatch(waiting.content, /账户选择/);
      if (status === 'cancelled') {
        const cancel = await admin.request(`/admin/task-runs/${runId}/cancel`, { method: 'POST', body: {} });
        assert.equal(cancel.response.status, 200, JSON.stringify(cancel.data));
        await fixture.server.piWeb.schedules.waitForIdle();
        assert.equal(fixture.server.piWeb.schedules.getRun(runId).status, 'cancelled');
      } else {
        await fixture.stop(); await fixture.start();
        assert.equal(fixture.server.piWeb.schedules.getRun(runId).status, 'interrupted');
      }
      const assertClosed = async () => {
        const messages = (await admin.request(`/sessions/${group.id}`)).data.messages;
        const notice = messages.find(value => value.id.startsWith('attention:'));
        assert.ok(notice);
        assert.match(notice.content, status === 'cancelled' ? /本次任务已取消/ : /本次任务已中断/);
        assert.match(notice.content, /检查未完成/); assert.match(notice.content, /不再等待验证码/);
        assert.doesNotMatch(notice.content, /当前任务仍在运行|完成浏览器验证后程序会继续|请查看本次最终检查结果/);
        assert.equal(messages.some(value => value.taskRunId === runId), false);
        assert.equal(fixture.server.piWeb.taskDelivery.get(runId).status, 'not_required');
      };
      await assertClosed();
      await fixture.stop(); await fixture.start();
      await assertClosed();
      assert.equal(fixture.mock.requests.length, 0);
    } finally { await fs.writeFile(f.release, 'release'); await fixture.close(); }
  });
});
