import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createFixture, session } from './auth-helpers.mjs';
import { sessionTools } from '../lib/shared-tools.mjs';

const poTaskId = 'amazon-po-duplicate-archive';
const poToolName = 'run_po_duplicate_check';
const unitToolName = 'run_unit_count_check';

test('fixed PO tool accepts no arguments, observes cancellation and current authorization, and returns only a pending receipt', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-po-tool-parameters-'));
  try {
    const cwd = path.join(directory, 'workspace'), dataDir = path.join(directory, 'data');
    await fs.mkdir(cwd); await fs.mkdir(dataDir);
    const sdk = Object.fromEntries(['Read', 'Ls', 'Find', 'Grep', 'Write', 'Edit', 'PowerShell', 'Bash'].map(name => [
      `create${name}ToolDefinition`, () => ({ name: name.toLowerCase(), execute: async () => ({ content: [] }) }),
    ]));
    let authorized = true, submitted = 0, unitSubmitted = 0;
    const options = { cwd, dataDir, mode: 'workspace',
      authorize: () => { if (!authorized) throw new Error('Current actor revoked'); },
      runPoDuplicateCheck: () => { submitted++; return { runId: 'po-fixed-run', status: 'queued', secret: 'DO-NOT-RETURN' }; },
      runUnitCountCheck: () => { unitSubmitted++; return { runId: 'unit-fixed-run', status: 'running' }; },
    };
    const tools = await sessionTools(sdk, options);
    const tool = tools.customTools.find(value => value.name === poToolName);
    assert.ok(tool); assert.deepEqual(tool.parameters, { type: 'object', properties: {}, additionalProperties: false });
    const receipt = await tool.execute('call', {}, new AbortController().signal);
    assert.deepEqual(receipt.details, { runId: 'po-fixed-run', status: 'queued' });
    assert.match(receipt.content[0].text, /尚未完成/);
    assert.doesNotMatch(JSON.stringify(receipt), /DO-NOT-RETURN/);
    for (const args of [{ taskId: 'other' }, { groupId: 'other' }, { script: '../run.py' },
      { path: 'private.xlsx' }, { scheduleId: 'other' }, null, [], '']) {
      await assert.rejects(tool.execute('call', args), /不接受参数/);
    }
    const controller = new AbortController(); controller.abort();
    await assert.rejects(tool.execute('call', {}, controller.signal), { name: 'AbortError' });
    authorized = false;
    await assert.rejects(tool.execute('call', {}), /Current actor revoked/);
    assert.equal(submitted, 1); assert.equal(unitSubmitted, 0);
    for (const name of [poToolName, unitToolName]) assert.ok(!(await sessionTools(sdk, { ...options, mode: 'read-only' })).tools.includes(name));
    const withoutPO = await sessionTools(sdk, { ...options, runPoDuplicateCheck: undefined });
    assert.ok(!withoutPO.tools.includes(poToolName)); assert.ok(withoutPO.tools.includes(unitToolName));
    authorized = true;
    await withoutPO.customTools.find(value => value.name === unitToolName).execute('call', {});
    assert.equal(unitSubmitted, 1);
  } finally {
    assert.equal(path.dirname(directory), os.tmpdir());
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function providerFixture() {
  const requests = [];
  let beforeTool;
  const server = http.createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'test-model' }] })); return;
    }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    const messages = body.messages || [], lastUser = [...messages].reverse().find(value => value.role === 'user');
    const text = typeof lastUser?.content === 'string' ? lastUser.content : (lastUser?.content || []).map(value => value.text || '').join('');
    const available = body.tools?.some(value => value.function?.name === poToolName);
    const call = text.includes('[invoke-po]') && available && messages.at(-1)?.role !== 'tool';
    if (call && beforeTool) { const hook = beforeTool; beforeTool = undefined; await hook(); }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'po-offline-provider',
      object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    send({ role: 'assistant', content: '' });
    if (call) send({ tool_calls: [{ index: 0, id: 'call_po_duplicate', type: 'function', function: { name: poToolName, arguments: '{}' } }] });
    else send({ content: messages.at(-1)?.role === 'tool' ? '已收到提交回执，等待 Pi 的真实业务结果。' : '已检查当前可用工具。' });
    send({}, call ? 'tool_calls' : 'stop'); res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { requests, url: `http://127.0.0.1:${server.address().port}`, beforeNextTool(hook) { beforeTool = hook; },
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}

async function until(check) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('Offline business fixture did not reach expected state');
}

test('real SDK PO invocation revalidates administrator, membership, current binding and enabled state, then prevents duplicate active PO runs', { timeout: 45_000 }, async () => {
  const tasks = [];
  let release, started;
  const provider = await providerFixture();
  const fixture = await createFixture({ prefix: 'po-managed-tool', options: {
    scheduler: { autoStart: false }, channels: { autoStart: false }, workTasks: { autoStart: false }, business: { tasks },
  }, seed: async ({ workspace }) => {
    const cwd = path.join(workspace, 'fixed-po-executor'), resultDirectory = path.join(cwd, 'results');
    await fs.mkdir(resultDirectory, { recursive: true });
    release = path.join(cwd, 'release'); started = path.join(cwd, 'started');
    const registrationPath = path.join(cwd, 'registration.json'), scriptPath = path.join(cwd, 'fixture.mjs');
    await fs.writeFile(registrationPath, JSON.stringify({ release, started, resultDirectory }));
    await fs.writeFile(scriptPath, `
      import fs from 'node:fs'; import path from 'node:path';
      const config=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
      const runId=process.env.PI_BUSINESS_RUN_ID;
      fs.writeFileSync(config.started,runId);
      while(!fs.existsSync(config.release)) await new Promise(resolve=>setTimeout(resolve,20));
      fs.writeFileSync(path.join(config.resultDirectory,runId+'.json'),JSON.stringify({schemaVersion:1,runId,
        status:'completed',summary:'离线 PO 检查完成，共核对 3 个预约，发现 1 组重复 PO；归档结果已保存。'}));
    `);
    for (const id of [poTaskId, 'amazon-unit-count']) tasks.push({ id, name: id === poTaskId ? 'PO 重复检查' : 'UnitCount 检查',
      cwd, resultDirectory, pythonPath: process.execPath, scriptPath, registrationPath,
      claimScope: 'occurrence', args: [], timeoutSeconds: 15 });
  } });
  const checked = async (client, route, method = 'GET', body, expected = 200) => {
    const result = await client.request(route, { method, ...(body === undefined ? {} : { body }) });
    assert.equal(result.response.status, expected, `${method} ${route}: ${JSON.stringify(result.data)}`);
    return result.data;
  };
  try {
    const admin = fixture.client(), member = fixture.client(), outsider = fixture.client();
    const password = 'PO-managed-offline-fixture-2026!';
    const adminUser = (await checked(admin, '/auth/setup', 'POST', { username: 'po-admin', displayName: 'PO 管理员', password }, 201)).user;
    const employee = (await checked(admin, '/admin/users', 'POST', { username: 'po-member', displayName: 'PO 员工', role: 'member', password }, 201)).user;
    await checked(admin, '/admin/users', 'POST', { username: 'po-outsider', displayName: '群外管理员', role: 'admin', password }, 201);
    await checked(member, '/auth/login', 'POST', { username: 'po-member', password });
    await checked(outsider, '/auth/login', 'POST', { username: 'po-outsider', password });
    await checked(admin, '/config', 'PUT', { provider: 'custom', model: 'test-model', baseUrl: `${provider.url}/v1`,
      apiKey: 'offline-test-only', cwd: fixture.workspace, mode: 'workspace', systemPrompt: 'Offline fixed PO tool validation.' });
    const group = await session(admin, '重复 PO 检查助手'), unitGroup = await session(admin, 'UnitCount 助手'), other = await session(admin, '无任务的智能体');
    await checked(admin, `/sessions/${group.id}/members`, 'POST', { userIds: [employee.id] });
    const createPlan = async (id, targetSessionId, time = '04:00') => (await checked(admin, '/admin/schedules', 'POST', {
      name: `${id} ${time}`, taskType: 'business', businessTaskId: id, executionMode: 'workspace',
      targetSessionId, prompt: '执行固定离线入口。', scheduleType: 'daily', time, enabled: true,
    }, 201)).schedule;
    const plan = await createPlan(poTaskId, group.id), alternate = await createPlan(poTaskId, group.id, '14:00');
    await createPlan('amazon-unit-count', unitGroup.id);
    const toolNames = () => provider.requests.at(-1)?.tools?.map(value => value.function?.name) ?? [];
    const inspect = async (client, id) => { await client.send(id, 'Inspect fixed business tools.'); return toolNames(); };
    assert.ok(!(await inspect(admin, other.id)).includes(poToolName));
    assert.ok(!(await inspect(member, group.id)).includes(poToolName));
    assert.equal((await outsider.request(`/sessions/${group.id}/messages`, { method: 'POST', body: { message: '[invoke-po]' } })).response.status, 404);
    await checked(admin, `/sessions/${group.id}`, 'PATCH', { mode: 'read-only' });
    assert.ok(!(await inspect(admin, group.id)).includes(poToolName));
    await checked(admin, `/sessions/${group.id}`, 'PATCH', { mode: 'workspace' });
    const poTools = await inspect(admin, group.id);
    assert.ok(poTools.includes(poToolName)); assert.ok(!poTools.includes(unitToolName));
    const unitTools = await inspect(admin, unitGroup.id);
    assert.ok(unitTools.includes(unitToolName)); assert.ok(!unitTools.includes(poToolName));
    await checked(admin, `/admin/schedules/${plan.id}`, 'PATCH', { enabled: false });
    await checked(admin, `/admin/schedules/${alternate.id}`, 'PATCH', { enabled: false });
    assert.ok(!(await inspect(admin, group.id)).includes(poToolName));
    await checked(admin, `/admin/schedules/${plan.id}`, 'PATCH', { enabled: true });

    // Mutation happens after the SDK/model has seen the tool catalog but before
    // the tool call reaches its server-side authorization boundary.
    provider.beforeNextTool(() => checked(admin, `/admin/schedules/${plan.id}`, 'PATCH', { enabled: false }));
    let events = await admin.send(group.id, '[invoke-po] disabled after advertisement');
    assert.ok(events.some(event => event.type === 'tool_end' && event.name === poToolName && event.isError));
    assert.equal(fixture.server.piWeb.schedules.runs().length, 0);
    await checked(admin, `/admin/schedules/${plan.id}`, 'PATCH', { enabled: true });
    provider.beforeNextTool(() => checked(admin, `/admin/schedules/${plan.id}`, 'PATCH', { targetSessionId: other.id }));
    events = await admin.send(group.id, '[invoke-po] binding moved after advertisement');
    assert.ok(events.some(event => event.type === 'tool_end' && event.name === poToolName && event.isError));
    assert.equal(fixture.server.piWeb.schedules.runs().length, 0);
    await checked(admin, `/admin/schedules/${plan.id}`, 'PATCH', { targetSessionId: group.id });
    const db = fixture.server.piWeb.schedules.db;
    provider.beforeNextTool(() => db.prepare("UPDATE users SET role='member' WHERE id=?").run(adminUser.id));
    try {
      await admin.send(group.id, '[invoke-po] administrator role revoked after advertisement');
      assert.equal(fixture.server.piWeb.schedules.runs().length, 0);
    } finally { db.prepare("UPDATE users SET role='admin' WHERE id=?").run(adminUser.id); }
    const membership = db.prepare('SELECT * FROM group_members WHERE session_id=? AND user_id=?').get(group.id, adminUser.id);
    provider.beforeNextTool(() => db.prepare('DELETE FROM group_members WHERE session_id=? AND user_id=?').run(group.id, adminUser.id));
    try {
      await admin.send(group.id, '[invoke-po] membership revoked after advertisement');
      assert.equal(fixture.server.piWeb.schedules.runs().length, 0);
    } finally {
      db.prepare('INSERT INTO group_members(session_id,user_id,added_by,added_at) VALUES (?,?,?,?)')
        .run(group.id, adminUser.id, membership.added_by, membership.added_at);
    }
    await checked(admin, `/admin/schedules/${alternate.id}`, 'PATCH', { enabled: true });
    events = await admin.send(group.id, '[invoke-po] submit fixed PO job');
    const accepted = events.find(event => event.type === 'tool_end' && event.name === poToolName && !event.isError);
    assert.ok(accepted);
    assert.match(JSON.stringify(accepted), /尚未完成/);
    const runs = fixture.server.piWeb.schedules.runs();
    assert.equal(runs.length, 1); assert.equal(runs[0].businessTaskId, poTaskId);
    assert.equal(runs[0].trigger, 'manual'); assert.equal(runs[0].targetSessionId, group.id);
    assert.ok(['queued', 'running'].includes(runs[0].status));
    assert.equal(fixture.server.piWeb.taskDelivery.history(group.id).length, 0);
    await until(() => fs.access(started).then(() => true, () => false));
    const duplicate = await admin.send(group.id, '[invoke-po] duplicate must not use alternate plan');
    assert.ok(duplicate.some(event => event.type === 'tool_end' && event.name === poToolName && event.isError));
    assert.equal(fixture.server.piWeb.schedules.runs().length, 1);
    await fs.writeFile(release, 'done');
    await fixture.server.piWeb.schedules.waitForIdle();
    assert.equal(fixture.server.piWeb.schedules.getRun(runs[0].id).status, 'succeeded');
    const final = fixture.server.piWeb.taskDelivery.history(group.id);
    assert.equal(final.length, 1); assert.equal(final[0].taskRunId, runs[0].id);
    assert.match(final[0].content, /发现 1 组重复 PO/);
    assert.equal(fixture.server.piWeb.taskDelivery.history(unitGroup.id).length, 0);
    assert.equal(fixture.server.piWeb.taskDelivery.history(other.id).length, 0);
    const audit = db.prepare("SELECT details FROM audit WHERE action='schedule.manual_run' AND target_id=?").get(runs[0].id);
    assert.equal(JSON.parse(audit.details).source, poToolName);
  } finally {
    if (release) await fs.writeFile(release, 'release');
    await fixture.close(); await provider.close();
  }
});
