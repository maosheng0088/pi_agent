import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { collectSSE, configure, createFixture, session } from './auth-helpers.mjs';

const password = 'Workbench-fixture-only-2026!';

async function checked(client, route, options = {}, status = 200) {
  const result = await client.request(route, options);
  assert.equal(result.response.status, status, `${route}: ${JSON.stringify(result.data)}`);
  return result.data;
}
async function until(check, message, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out: ${message}`);
}
async function setup(t, { autoStart = true, channelOptions = { autoStart: false } } = {}) {
  const fixture = await createFixture({ prefix: 'agent-workbench', options: { scheduler: { autoStart: false }, channels: channelOptions, workTasks: { autoStart, pollIntervalMs: 20 } } });
  t.after(() => fixture.close());
  const admin = fixture.client(), alice = fixture.client(), bob = fixture.client(), otherAdmin = fixture.client(), guest = fixture.client();
  await checked(admin, '/auth/setup', { method: 'POST', body: { username: 'work-admin', displayName: '工作台管理员', password } }, 201);
  await configure(admin, fixture);
  const users = {};
  for (const [username, role, client] of [['work-alice', 'member', alice], ['work-bob', 'member', bob], ['work-other-admin', 'admin', otherAdmin]]) {
    users[username] = (await checked(admin, '/admin/users', { method: 'POST', body: { username, displayName: username, role, password } }, 201)).user;
    await checked(client, '/auth/login', { method: 'POST', body: { username, password } });
  }
  const group = await session(admin, '客服岗位智能体');
  await checked(admin, `/sessions/${group.id}/members`, { method: 'POST', body: { userIds: [users['work-alice'].id, users['work-bob'].id] } });
  const privateGroup = await session(otherAdmin, '独立财务智能体');
  return { fixture, admin, alice, bob, otherAdmin, guest, users, group, privateGroup,
    path: tail => `/sessions/${group.id}/${tail}`,
    async task(input, actor = alice) { return (await checked(actor, `/sessions/${group.id}/tasks`, { method: 'POST', body: typeof input === 'string' ? { instruction: input } : input }, 202)).task; },
    async readTask(taskId, actor = admin) { return (await checked(actor, `/sessions/${group.id}/tasks/${taskId}`)).task; },
    async action(taskId, body, actor = alice) { return (await checked(actor, `/sessions/${group.id}/tasks/${taskId}/actions`, { method: 'POST', body })).task; },
  };
}

test('workbench profile routes restrict admin writes and member reads, including administrators outside the group', { timeout: 30000 }, async t => {
  const f = await setup(t, { autoStart: false });
  const profile = (await checked(f.admin, f.path('profile'), { method: 'PATCH', body: { roleName: '专业客服', responsibilities: '回答提柜业务问题', rules: '回复带来源', workflow: '先核对柜号', outputTemplate: '柜号/日期/依据', expectedVersion: 0 } })).profile;
  assert.equal(profile.version, 1);
  assert.equal((await checked(f.alice, f.path('profile'))).profile.roleName, '专业客服');
  assert.equal((await f.alice.request(f.path('profile'), { method: 'PATCH', body: { roleName: '越权覆盖' } })).response.status, 403);
  assert.equal((await f.guest.request(f.path('profile'))).response.status, 401);
  assert.equal((await f.otherAdmin.request(f.path('profile'))).response.status, 404);
  const privatePath = `/sessions/${f.privateGroup.id}/profile`;
  assert.equal((await f.admin.request(privatePath)).response.status, 404);
  assert.equal((await f.admin.request(privatePath, { method: 'PATCH', body: { roleName: '跨群覆盖' } })).response.status, 404);
  const updated = (await checked(f.admin, f.path('profile'), { method: 'PATCH', body: { rules: '按当前资料回复', expectedVersion: 1 } })).profile;
  assert.equal(updated.version, 2); assert.equal(updated.responsibilities, profile.responsibilities);
  assert.equal((await f.admin.request(f.path('profile'), { method: 'PATCH', body: { roleName: '旧版本覆盖', expectedVersion: 1 } })).response.status, 409);
});

test('knowledge API preserves actual source/version, supports UTF-8 uploads and denies cross-group CRUD', { timeout: 30000 }, async t => {
  const f = await setup(t, { autoStart: false });
  const doc = (await checked(f.admin, f.path('knowledge'), { method: 'POST', body: { title: '提柜日期填写规范', sourceName: '提柜规则.md', fileBase64: Buffer.from('# 提柜时间\n以操作表提柜日期为准。').toString('base64') } }, 201)).document;
  assert.equal(doc.version, 1); assert.equal(doc.sourceName, '提柜规则.md'); assert.equal(doc.format, 'markdown');
  const listing = await checked(f.alice, f.path('knowledge?q=如何填写提柜时间'));
  assert.equal(listing.documents.length, 1); assert.equal(listing.documents[0].content, undefined);
  assert.equal(listing.matches[0].documentId, doc.id); assert.equal(listing.matches[0].sourceName, doc.sourceName);
  assert.match(listing.matches[0].citation, /提柜日期填写规范 v1 /);
  assert.equal((await checked(f.alice, f.path(`knowledge/${doc.id}`))).document.content, doc.content);
  assert.equal((await f.alice.request(f.path('knowledge'), { method: 'POST', body: { content: '员工越权资料' } })).response.status, 403);
  assert.equal((await f.alice.request(f.path(`knowledge/${doc.id}`), { method: 'PATCH', body: { content: '员工越权更新' } })).response.status, 403);
  assert.equal((await f.alice.request(f.path(`knowledge/${doc.id}`), { method: 'DELETE', body: {} })).response.status, 403);
  for (const actor of [f.admin, f.alice]) assert.equal((await actor.request(`/sessions/${f.privateGroup.id}/knowledge/${doc.id}`)).response.status, 404);
  assert.equal((await f.otherAdmin.request(`/sessions/${f.privateGroup.id}/knowledge/${doc.id}`)).response.status, 404);
  const changed = (await checked(f.admin, f.path(`knowledge/${doc.id}`), { method: 'PATCH', body: { content: '提柜日期更新后，核对柜号与日期。', expectedVersion: 1 } })).document;
  assert.equal(changed.version, 2); assert.notEqual(changed.contentHash, doc.contentHash);
  assert.equal((await f.admin.request(f.path(`knowledge/${doc.id}?expectedVersion=1`), { method: 'DELETE', body: {} })).response.status, 409);
  assert.equal((await f.admin.request(f.path(`knowledge/${doc.id}?expectedVersion=bad`), { method: 'DELETE', body: {} })).response.status, 400);
  assert.equal((await f.admin.request(f.path('knowledge'), { method: 'POST', body: { sourceName: '表格.xlsx', fileBase64: Buffer.from('not parsed').toString('base64') } })).response.status, 400);
  await checked(f.admin, f.path(`knowledge/${doc.id}?expectedVersion=2`), { method: 'DELETE', body: {} });
  assert.equal((await f.alice.request(f.path(`knowledge/${doc.id}`))).response.status, 404);
});

test('response-quality profile fields and knowledge purpose round-trip with existing permissions, versions and audit', { timeout: 30000 }, async t => {
  const f = await setup(t, { autoStart: false });
  const values = { audience: '客服与调度', commonTasks: '核对提柜时间', completionCriteria: '结果可核查', responseExamples: '缺资料：请补柜号。' };
  const created = (await checked(f.admin, f.path('profile'), { method: 'PATCH', body: { roleName: '客服岗位', ...values, expectedVersion: 0 } })).profile;
  const read = (await checked(f.alice, f.path('profile'))).profile;
  for (const [key, value] of Object.entries(values)) assert.equal(read[key], value);
  const legacy = (await checked(f.admin, f.path('profile'), { method: 'PATCH', body: { rules: '旧版客户端只修改规则', expectedVersion: created.version } })).profile;
  assert.equal(legacy.version, 2);for (const [key, value] of Object.entries(values)) assert.equal(legacy[key], value);
  assert.equal((await f.alice.request(f.path('profile'), { method: 'PATCH', body: { audience: '越权' } })).response.status, 403);
  const document = (await checked(f.admin, f.path('knowledge'), { method: 'POST', body: { title: '提柜开发资料', content: '提柜脚本开发说明。' } }, 201)).document;
  assert.equal(document.purpose, 'business');
  const changed = (await checked(f.admin, f.path(`knowledge/${document.id}`), { method: 'PATCH', body: { purpose: 'development', expectedVersion: 1 } })).document;
  assert.equal(changed.purpose, 'development');assert.equal(changed.version, 2);assert.equal(changed.contentHash, document.contentHash);
  assert.equal((await checked(f.alice, f.path(`knowledge/${document.id}`))).document.purpose, 'development');
  const listing = await checked(f.alice, f.path('knowledge?q=提柜'));
  assert.equal(listing.documents[0].purpose, 'development');assert.equal(listing.matches[0].purpose, 'development');
  assert.equal((await f.alice.request(f.path(`knowledge/${document.id}`), { method: 'PATCH', body: { purpose: 'business', expectedVersion: 2 } })).response.status, 403);
  assert.equal((await f.admin.request(f.path(`knowledge/${document.id}`), { method: 'PATCH', body: { purpose: 'business', expectedVersion: 1 } })).response.status, 409);
  assert.equal((await f.admin.request(f.path(`knowledge/${document.id}`), { method: 'PATCH', body: { purpose: 'unknown', expectedVersion: 2 } })).response.status, 400);
  const database = new DatabaseSync(path.join(f.fixture.dataDir, 'workspace.sqlite'), { readOnly: true });
  try {
    const events = database.prepare('SELECT action FROM audit WHERE target_id=? ORDER BY id').all(document.id).map(row => row.action);
    assert.deepEqual(events, ['agent.knowledge_created', 'agent.knowledge_updated']);
  } finally { database.close(); }
});

test('discussion is human-only until an explicit agent mention creates a real SDK task using profile, knowledge and group history', { timeout: 40000 }, async t => {
  const f = await setup(t);
  await checked(f.admin, f.path('profile'), { method: 'PATCH', body: { roleName: '提柜专员 ROLE-SUPPORT-46c', responsibilities: '仅处理本智能体的提柜业务', workflow: '核对后回复 PROFILE-WORKFLOW-773' } });
  const doc = (await checked(f.admin, f.path('knowledge'), { method: 'POST', body: { title: '提柜时间制度', sourceName: '提柜制度.md', content: '提柜时间按操作表核对。KNOWLEDGE-SUPPORT-855' } }, 201)).document;
  await checked(f.otherAdmin, `/sessions/${f.privateGroup.id}/profile`, { method: 'PATCH', body: { roleName: 'PRIVATE-FINANCE-ROLE-NOT-IN-PROMPT' } });
  await checked(f.otherAdmin, `/sessions/${f.privateGroup.id}/knowledge`, { method: 'POST', body: { title: '提柜秘密财务', content: '提柜时间 PRIVATE-FINANCE-KNOWLEDGE-NOT-IN-PROMPT' } }, 201);
  const before = f.fixture.mock.requests.length;
  const discussion = await checked(f.alice, f.path('discussion'), { method: 'POST', body: { content: '这里先沟通柜号需求 DISCUSSION-SUPPORT-c7b' } }, 201);
  assert.equal(discussion.message.authorId, f.users['work-alice'].id);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(f.fixture.mock.requests.length, before);
  assert.equal((await checked(f.alice, f.path('tasks'))).total, 0);
  const mentioned = await checked(f.alice, f.path('discussion'), { method: 'POST', body: { content: '@智能体 帮我查询提柜时间', mentions: ['agent'], clientRequestId: 'mention-real-sdk-1' } }, 202);
  const task = await until(async () => { const value = await f.readTask(mentioned.task.id); return value.status === 'succeeded' ? value : value.status === 'failed' ? Promise.reject(new Error(value.error)) : null; }, 'agent result returns through the real SDK');
  assert.equal(task.createdBy, f.users['work-alice'].id); assert.equal(task.attempt, 1); assert.match(task.result, /Pi SDK 已连接/);
  const wire = JSON.stringify(f.fixture.mock.requests.slice(before));
  for (const expected of ['ROLE-SUPPORT-46c', 'PROFILE-WORKFLOW-773', 'KNOWLEDGE-SUPPORT-855', 'DISCUSSION-SUPPORT-c7b', doc.updatedAt, '提柜时间制度 v1']) assert.ok(wire.includes(expected), `model must receive ${expected}`);
  assert.ok(!wire.includes('PRIVATE-FINANCE-ROLE-NOT-IN-PROMPT')); assert.ok(!wire.includes('PRIVATE-FINANCE-KNOWLEDGE-NOT-IN-PROMPT'));
  const history = await checked(f.bob, `/sessions/${f.group.id}`);
  const result = history.messages.find(message => message.workTaskId === task.id && message.role === 'assistant');
  assert.ok(result); assert.equal(result.content, task.result);
  const found = await checked(f.bob, f.path(`search?q=${encodeURIComponent('本次回复来自本地集成测试模型')}`));
  assert.ok(found.results.some(message => message.workTaskId === task.id));
});

test('same-group queue serializes real requests, queued cancel avoids execution and takeover/resume aborts actual streams', { timeout: 40000 }, async t => {
  const f = await setup(t);
  const before = f.fixture.mock.requests.length;
  const first = await f.task('[slow-response] 长任务准备人工处理');
  await until(() => f.fixture.mock.requests.length > before, 'first task starts a provider stream');
  const second = await f.task('排队任务不应启动', f.bob);
  assert.equal((await f.readTask(second.id)).status, 'queued');
  assert.equal(f.fixture.mock.requests.length, before + 1);
  await f.action(second.id, { action: 'cancel' }, f.bob);
  assert.equal((await f.readTask(second.id)).status, 'cancelled');
  const closed = f.fixture.mock.closedStreams;
  const human = await f.action(first.id, { action: 'takeover', content: '我先核对业务结果 HUMAN-TAKEOVER-831' });
  assert.equal(human.status, 'waiting_human'); assert.equal(human.assigneeId, f.users['work-alice'].id);
  await until(() => f.fixture.mock.closedStreams > closed && f.fixture.server.piWeb.workTasks.active.size === 0, 'takeover aborts the provider connection');
  await f.action(first.id, { action: 'supplement', content: '已核对，可以按补充信息继续 HUMAN-SUPPLEMENT-421' });
  const resumed = await f.action(first.id, { action: 'resume' });
  assert.ok(['queued', 'running'].includes(resumed.status));
  await until(() => f.fixture.mock.requests.length === before + 2, 'explicit resume starts one new provider request');
  assert.ok(JSON.stringify(f.fixture.mock.requests.at(-1)).includes('HUMAN-SUPPLEMENT-421'));
  assert.equal((await f.readTask(first.id)).attempt, 2);
  const closedAgain = f.fixture.mock.closedStreams;
  await f.action(first.id, { action: 'takeover' });
  await until(() => f.fixture.mock.closedStreams > closedAgain && f.fixture.server.piWeb.workTasks.active.size === 0, 'second takeover stops resumed AI');
  const finished = await f.action(first.id, { action: 'complete', content: '人工核对已完成 HUMAN-FINAL-501' });
  assert.equal(finished.status, 'succeeded'); assert.equal(finished.result, '人工核对已完成 HUMAN-FINAL-501');
  assert.ok(finished.events.some(event => event.type === 'resume'));
  assert.ok(finished.events.some(event => event.type === 'complete'));
  assert.equal(f.fixture.mock.requests.length, before + 2);
});

test('new discussions quote legacy Pi messages through a server-owned snapshot and reject forged cross-group replies', { timeout: 40000 }, async t => {
  const f = await setup(t, { autoStart: false });
  await f.admin.send(f.group.id, 'LEGACY-PI-TOPIC-11c');
  const history = await checked(f.alice, `/sessions/${f.group.id}`);
  const legacy = history.messages.find(message => message.role === 'assistant' && message.id?.startsWith('pi:'));
  assert.ok(legacy, 'a real pre-workbench Pi message must have a reference ID');
  const reply = await checked(f.alice, f.path('discussion'), { method: 'POST', body: { content: '我补充这条历史回复', replyTo: legacy.id, replySnapshot: { id: legacy.id, content: 'FORGED-CLIENT-SNAPSHOT' } } }, 201);
  assert.equal(reply.message.replyTo, legacy.id); assert.equal(reply.message.replySnapshot.content, legacy.content.slice(0, 500));
  assert.ok(!JSON.stringify(reply.message).includes('FORGED-CLIENT-SNAPSHOT'));
  await f.otherAdmin.send(f.privateGroup.id, 'PRIVATE-LEGACY-PI');
  const privateHistory = await checked(f.otherAdmin, `/sessions/${f.privateGroup.id}`);
  const privateMessage = privateHistory.messages.find(message => message.role === 'assistant');
  assert.equal((await f.alice.request(f.path('discussion'), { method: 'POST', body: { content: '跨群引用', replyTo: privateMessage.id } })).response.status, 404);
  const publicHistory = await checked(f.bob, `/sessions/${f.group.id}`);
  assert.ok(publicHistory.messages.some(message => message.id === reply.message.id && message.replySnapshot?.id === legacy.id));
});

test('removing the creating member cancels active and queued work and stops its real model output', { timeout: 40000 }, async t => {
  const f = await setup(t);
  const before = f.fixture.mock.requests.length;
  const running = await f.task('[slow-response] 员工离群前开始的任务');
  await until(() => f.fixture.mock.requests.length > before, 'member provider stream begins');
  const queued = await f.task('员工离群后不能启动这条队列任务');
  const closed = f.fixture.mock.closedStreams;
  await checked(f.admin, f.path(`members/${f.users['work-alice'].id}`), { method: 'DELETE', body: {} });
  await until(() => f.fixture.mock.closedStreams > closed && f.fixture.server.piWeb.workTasks.active.size === 0, 'membership revocation aborts execution');
  assert.equal((await f.readTask(running.id)).status, 'cancelled'); assert.equal((await f.readTask(queued.id)).status, 'cancelled');
  for (const area of ['profile', 'knowledge', 'tasks', 'discussion']) assert.equal((await f.alice.request(f.path(area))).response.status, 404);
  assert.equal((await f.alice.request(f.path('tasks'), { method: 'POST', body: { instruction: '不能继续执行' } })).response.status, 404);
  assert.equal(f.fixture.mock.requests.length, before + 1);
  const history = await checked(f.bob, `/sessions/${f.group.id}`);
  assert.ok(!history.messages.some(message => [running.id, queued.id].includes(message.workTaskId) && message.role === 'assistant'));
});

test('guest routes require login and employee task/mention submissions reject missing or out-of-scope skills before queueing', { timeout: 30000 }, async t => {
  const f = await setup(t, { autoStart: false });
  for (const area of ['profile', 'knowledge', 'tasks', 'discussion']) {
    assert.equal((await f.guest.request(f.path(area))).response.status, 401);
    assert.equal((await f.guest.request(f.path(area), { method: 'POST', body: { instruction: 'guest', content: 'guest' } })).response.status, 401);
  }
  const skill = (await checked(f.otherAdmin, '/admin/skills', { method: 'POST', body: { name: 'workbench-private-skill', description: 'Only private finance group.', content: 'PRIVATE-SKILL-CONTENT', enabled: true, scope: 'groups', groupIds: [f.privateGroup.id] } }, 201)).skill;
  for (const skillId of ['missing-skill', skill.id]) {
    assert.equal((await f.alice.request(f.path('tasks'), { method: 'POST', body: { instruction: '不应入队', skillId } })).response.status, 400);
    assert.equal((await f.alice.request(f.path('discussion'), { method: 'POST', body: { content: '@智能体 不应入队', mentions: ['agent'], skillId } })).response.status, 400);
  }
  assert.equal((await checked(f.alice, f.path('tasks'))).total, 0);
  assert.equal((await checked(f.alice, f.path('discussion'))).messages.length, 0);
  assert.equal(f.fixture.mock.requests.length, 0);
});

test('long task instructions stay intact while only the automatic knowledge query is bounded', { timeout: 30000 }, async t => {
  const f = await setup(t);
  await checked(f.admin, f.path('knowledge'), { method: 'POST', body: { title: '提柜说明', content: '提柜时间资料 LONG-TASK-KNOWLEDGE-30d' } }, 201);
  const instruction = `查询提柜时间。${'业务背景资料。'.repeat(150)}完整尾部要求 LONG-TASK-END-a94`;
  assert.ok(instruction.length > 500);
  const queued = await f.task(instruction);
  const complete = await until(async () => { const task = await f.readTask(queued.id); return task.status === 'succeeded' ? task : task.status === 'failed' ? Promise.reject(new Error(task.error)) : null; }, 'long task must execute rather than fail knowledge query validation');
  assert.equal(complete.instruction, instruction);
  const wire = JSON.stringify(f.fixture.mock.requests.at(-1));
  assert.ok(wire.includes('LONG-TASK-END-a94')); assert.ok(wire.includes('LONG-TASK-KNOWLEDGE-30d'));
});

test('malformed mention values return validation errors without queueing work or creating discussion messages', { timeout: 30000 }, async t => {
  const f = await setup(t, { autoStart: false });
  for (const mentions of [null, {}, 'agent', 123, ['agent', {}]]) {
    const response = await f.alice.request(f.path('discussion'), { method: 'POST', body: { content: '@智能体 这条无效输入不能执行', mentions } });
    assert.equal(response.response.status, 400, JSON.stringify(response.data));
  }
  assert.equal((await checked(f.alice, f.path('tasks'))).total, 0);
  assert.equal((await checked(f.alice, f.path('discussion'))).messages.length, 0);
  assert.equal(f.fixture.mock.requests.length, 0);
});

test('revoking the HTTP login while legacy quote lookup awaits IO prevents discussion, mention and task submission', { timeout: 40000 }, async t => {
  const f = await setup(t, { autoStart: false });
  await f.admin.send(f.group.id, '引用用的旧消息 LEGACY-COOKIE-ASYNC-8ba');
  const history = await checked(f.alice, `/sessions/${f.group.id}`);
  const legacy = history.messages.find(message => message.role === 'assistant');
  const database = new DatabaseSync(path.join(f.fixture.dataDir, 'workspace.sqlite'), { readOnly: true });
  const meta = JSON.parse(database.prepare('SELECT data FROM session_meta WHERE id=?').get(f.group.id).data);
  database.close();
  const originalStat = fs.stat;
  for (const [area, payload] of [['discussion', { content: '撤销后的讨论不能写入' }], ['discussion', { content: '@智能体 撤销后的提及不能入队', mentions: ['agent'] }], ['tasks', { instruction: '撤销后的任务不能入队' }]]) {
    let entered = false, armed = true, release;
    const gate = new Promise(resolve => { release = resolve; });
    fs.stat = async (target, ...args) => {
      if (armed && typeof target === 'string' && path.resolve(target) === path.resolve(meta.file)) {
        armed = false; entered = true; await gate;
      }
      return originalStat(target, ...args);
    };
    const pending = f.alice.request(f.path(area), { method: 'POST', body: { ...payload, replyTo: legacy.id } });
    try {
      await until(() => entered, 'quote lookup enters the controlled fixture IO wait');
      await checked(f.admin, `/admin/users/${f.users['work-alice'].id}`, { method: 'PATCH', body: { password } });
      release();
      const response = await pending;
      assert.equal(response.response.status, 401, `${area}: ${JSON.stringify(response.data)}`);
    } finally {
      release(); fs.stat = originalStat; await pending.catch(() => {});
    }
    await checked(f.alice, '/auth/login', { method: 'POST', body: { username: 'work-alice', password } });
  }
  assert.equal((await checked(f.alice, f.path('discussion'))).messages.length, 0);
  assert.equal((await checked(f.alice, f.path('tasks'))).total, 0);
});

test('oversized combined instruction and quoted data fail clearly without trimming the original requirement or calling the model', { timeout: 30000 }, async t => {
  const f = await setup(t, { autoStart: false });
  await f.admin.send(f.group.id, '用于任务引用的数据');
  const history = await checked(f.alice, `/sessions/${f.group.id}`);
  const quoted = history.messages.find(message => message.role === 'assistant');
  const instruction = '业务要求'.repeat(25000);
  const before = f.fixture.mock.requests.length;
  const task = await f.task({ instruction, replyTo: quoted.id });
  f.fixture.server.piWeb.workTasks.start();
  const failed = await until(async () => { const current = await f.readTask(task.id); return current.status === 'failed' ? current : null; }, 'combined requirements must be rejected before SDK execution');
  assert.equal(failed.instruction, instruction); assert.match(failed.error, /100,000/); assert.match(failed.error, /未被截断/);
  assert.equal(f.fixture.mock.requests.length, before);
});

test('bounded chat history keeps the newest collaboration messages after more than one thousand posts', { timeout: 30000 }, async t => {
  const f = await setup(t, { autoStart: false });
  const database = new DatabaseSync(path.join(f.fixture.dataDir, 'workspace.sqlite'));
  try {
    database.exec('BEGIN IMMEDIATE');
    const insert = database.prepare('INSERT INTO collaboration_messages(id,session_id,role,content,author_id,author_name,created_at) VALUES (?,?,?,?,?,?,?)');
    for (let index = 0; index <= 1000; index++) insert.run(`history-${index}`, f.group.id, 'user', `协作历史${index} NEWEST-FIXTURE-${index}`, f.users['work-alice'].id, 'work-alice', new Date(Date.UTC(2026, 9, 29, 0, 0, 0, index)).toISOString());
    database.exec('COMMIT');
  } finally { database.close(); }
  const history = await checked(f.bob, `/sessions/${f.group.id}`);
  assert.equal(history.messages.length, 1000);
  assert.ok(history.messages.some(message => message.id === 'history-1000'));
  assert.ok(!history.messages.some(message => message.id === 'history-0'));
  assert.equal(history.session.messageCount, 1001);
});

test('explicit administrator audit/export includes collaboration without granting normal non-member workbench access', { timeout: 30000 }, async t => {
  const f = await setup(t, { autoStart: false });
  await checked(f.alice, f.path('discussion'), { method: 'POST', body: { content: '仅成员正常访问，管理员仅经审计读取 AUDIT-COLLAB-82d' } }, 201);
  for (const suffix of ['', '/export']) {
    const result = await checked(f.otherAdmin, `/admin/sessions/${f.group.id}${suffix}`);
    assert.ok(result.messages.some(message => message.content.includes('AUDIT-COLLAB-82d')));
  }
  for (const suffix of ['', '/profile', '/knowledge', '/tasks', '/discussion']) assert.equal((await f.otherAdmin.request(`/sessions/${f.group.id}${suffix}`)).response.status, 404);
  for (const suffix of ['', '/export']) assert.equal((await f.alice.request(`/admin/sessions/${f.group.id}${suffix}`)).response.status, 403);
});

test('legacy direct chat reads real same-group collaboration and ignores client-supplied history context', { timeout: 30000 }, async t => {
  const f = await setup(t, { autoStart: false });
  await checked(f.alice, f.path('discussion'), { method: 'POST', body: { content: '客服群真实讨论 DIRECT-COLLAB-33b' } }, 201);
  await checked(f.otherAdmin, `/sessions/${f.privateGroup.id}/discussion`, { method: 'POST', body: { content: '财务群私有讨论 PRIVATE-OTHER-COLLAB-94a' } }, 201);
  const response = await f.alice.fetch(f.path('messages'), { method: 'POST', body: { message: '请总结刚才群内讨论', collaborationContext: 'CLIENT-FORGED-COLLAB-181', sharedContext: 'CLIENT-FORGED-INTERNAL-54a' } });
  assert.equal(response.status, 200);
  await collectSSE(response);
  const wire = JSON.stringify(f.fixture.mock.requests.at(-1));
  assert.ok(wire.includes('DIRECT-COLLAB-33b'));
  for (const forbidden of ['CLIENT-FORGED-COLLAB-181', 'CLIENT-FORGED-INTERNAL-54a', 'PRIVATE-OTHER-COLLAB-94a']) assert.ok(!wire.includes(forbidden), forbidden);
});

test('external IM follow-up receives shared Web discussion and task results through a currently bound channel', { timeout: 40000 }, async t => {
  const connections = [], sent = [];
  const f = await setup(t, { channelOptions: { wecom: { pollIntervalMs: 10, retryMs: 20,
    clientFactory(options) {
      const client = { ...options, closed: false,
        start() { queueMicrotask(() => { if (!client.closed) options.onState({ status: 'connected' }); }); },
        async close() { client.closed = true; },
        async sendText(value) { if (!client.closed) sent.push(value); },
      };
      connections.push(client); return client;
    },
  } } });
  const channel = (await checked(f.admin, '/admin/channels', { method: 'POST', body: { type: 'wecom', name: '工作台追问测试渠道', botId: 'workbench-im-fixture', secret: 'fixture-only-not-real' } }, 201)).channel;
  await until(async () => (await checked(f.admin, '/admin/channels')).channels.find(item => item.id === channel.id)?.connected, 'fixture IM channel is connected');
  const connection = connections.at(-1);
  const emit = (text, messageId) => connection.onMessage({ botId: 'workbench-im-fixture', text, targetId: 'workbench-im-group', chatType: 'group', userId: 'external-workbench-employee', messageId, timestamp: Date.now(), requestId: `req-${messageId}` });
  emit('仅用于发现会话', 'discover-workbench-im');
  await until(async () => (await checked(f.admin, `/admin/channels/${channel.id}/conversations`)).conversations.length === 1, 'fixture IM conversation discovery');
  await checked(f.admin, `/admin/channels/${channel.id}`, { method: 'PATCH', body: { target: { id: 'workbench-im-group', chatType: 'group' } } });
  await checked(f.admin, f.path('channels'), { method: 'PUT', body: { channelIds: [channel.id] } });
  await checked(f.alice, f.path('discussion'), { method: 'POST', body: { content: '网页员工确认的业务资料 IM-SHARED-DISCUSSION-6dd' } }, 201);
  const queued = await f.task('网页员工的提柜查询 IM-WEB-TASK-36e');
  await until(async () => { const current = await f.readTask(queued.id); return current.status === 'succeeded' ? current : current.status === 'failed' ? Promise.reject(new Error(current.error)) : null; }, 'Web task completes before IM follow-up');
  const before = f.fixture.mock.requests.length;
  emit('请解释刚才网页任务的结果', 'follow-up-workbench-im');
  await until(() => f.fixture.mock.requests.length > before, 'external actor starts a real SDK follow-up');
  const wire = JSON.stringify(f.fixture.mock.requests.at(-1));
  assert.ok(wire.includes('IM-SHARED-DISCUSSION-6dd'));
  assert.ok(wire.includes('IM-WEB-TASK-36e'));
  assert.ok(wire.includes('本次回复来自本地集成测试模型'));
  await until(() => sent.some(value => value.text?.includes('Pi SDK 已连接')), 'IM receives a reply');
  const roster = await checked(f.admin, f.path('members'));
  assert.ok(roster.externalMembers.some(value => value.source === 'wecom'));
});
