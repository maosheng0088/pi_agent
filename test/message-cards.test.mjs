import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createFixture, configure, session } from './auth-helpers.mjs';
import { durableMessageIds } from '../lib/pi.mjs';
import { taskResultCard } from '../lib/message-cards.mjs';

const password = 'Card-fixture-only-2026!';
async function call(client, route, options = {}, expected = 200) {
  const response = await client.request(route, options);
  assert.equal(response.response.status, expected, `${route}: ${JSON.stringify(response.data)}`);
  return response.data;
}
async function until(check, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('Card fixture did not reach the expected terminal state.');
}
async function fixture(t) {
  const tasks = [];
  const f = await createFixture({ prefix: 'message-cards', options: { scheduler: { autoStart: false }, channels: { autoStart: false }, business: { tasks }, workTasks: { pollIntervalMs: 20 } },
    async seed({ workspace }) {
      const scriptPath = path.join(workspace, 'fake-business.mjs'), registrationPath = path.join(workspace, 'registration.json');
      await fs.writeFile(scriptPath, 'console.log("Only a local fixture was run.");process.exit(9);');
      await fs.writeFile(registrationPath, '{}');
      tasks.push({ id: 'card-failing-business', name: 'Local failing business fixture', pythonPath: process.execPath, scriptPath, registrationPath, cwd: workspace, timeoutSeconds: 10 });
    },
  });
  t.after(() => f.close());
  const admin = f.client(), member = f.client(), outsider = f.client(), guest = f.client();
  await call(admin, '/auth/setup', { method: 'POST', body: { username: 'card-admin', displayName: 'Card Admin', password } }, 201);
  await configure(admin, f);
  const user = (await call(admin, '/admin/users', { method: 'POST', body: { username: 'card-member', displayName: 'Card Member', password, role: 'member' } }, 201)).user;
  await call(admin, '/admin/users', { method: 'POST', body: { username: 'card-other-admin', displayName: 'Other Admin', password, role: 'admin' } }, 201);
  await call(member, '/auth/login', { method: 'POST', body: { username: 'card-member', password } });
  await call(outsider, '/auth/login', { method: 'POST', body: { username: 'card-other-admin', password } });
  const group = await session(admin, '卡片业务空间'), other = await session(outsider, '外部卡片空间');
  await call(admin, `/sessions/${group.id}/members`, { method: 'POST', body: { userIds: [user.id] } });
  return { f, admin, member, outsider, guest, group, other,
    route: suffix => `/sessions/${group.id}/${suffix}`,
    async document(content = '提柜时间依据操作表。ORIGINAL-KNOWLEDGE-a91') { return (await call(admin, `/sessions/${group.id}/knowledge`, { method: 'POST', body: { title: '提柜时间规范', sourceName: '提柜.md', content } }, 201)).document; },
    async work(instruction) {
      const task = (await call(member, `/sessions/${group.id}/tasks`, { method: 'POST', body: { instruction } }, 202)).task;
      return until(async () => { const value = (await call(admin, `/sessions/${group.id}/tasks/${task.id}`)).task; return ['succeeded', 'failed'].includes(value.status) ? value : null; });
    },
    async history() { return (await call(member, `/sessions/${group.id}`)).messages; },
  };
}

test('task card factories use authoritative execution states and bounded real fields, never delivery state or inferred business correctness', () => {
  assert.equal(taskResultCard({ id: 'x', status: 'running' }), null);
  assert.equal(taskResultCard({ id: '../x', status: 'succeeded' }), null);
  const good = taskResultCard({ id: 'work-fixture', title: '核对提柜', status: 'succeeded', result: '已返回数据', createdByName: '员工', assigneeName: '负责人', startedAt: '2026-10-29T00:00:00Z', finishedAt: '2026-10-29T00:00:15Z' });
  assert.equal(good.kind, 'task_result'); assert.equal(good.title, '核对提柜'); assert.equal(good.status, 'succeeded');
  assert.ok(good.fields.some(field => field.label === '耗时' && field.value === '15 秒'));
  assert.ok(good.fields.some(field => field.label.includes('北京时间') && field.value.includes('08:00')));
  assert.ok(!JSON.stringify(good).includes('业务正确'));
  const bad = taskResultCard({ id: 'run-fixture', scheduleName: '业务运行', status: 'failed', error: '真实非零退出码' }, 'schedule');
  assert.equal(bad.kind, 'task_exception'); assert.equal(bad.summary, '真实非零退出码'); assert.equal(bad.taskKind, 'schedule');
});

test('SDK message identities follow durable source entries instead of the display index or projection order', () => {
  const one = { role: 'user', content: '问题', timestamp: 1 }, two = { role: 'assistant', content: '回复', timestamp: 2 };
  const manager = { buildSessionProjection: () => ({ entries: [{ sourceEntry: { id: 'entry-one' }, messages: [one] }, { sourceEntry: { id: 'entry-two' }, messages: [two] }] }) };
  const ids = durableMessageIds(manager, [one, two], 'group');
  assert.deepEqual(durableMessageIds(manager, [two, one], 'group'), [ids[1], ids[0]]);
  assert.deepEqual(durableMessageIds(manager, [JSON.parse(JSON.stringify(two))], 'group'), [ids[1]]);
  assert.equal(ids[1], 'pi:group:entry-two:0');
});

test('ordinary replies retain actual retrieval snapshots across updates, deletion and restart; every source endpoint remains group guarded', { timeout: 30000 }, async t => {
  const x = await fixture(t), doc = await x.document();
  await x.member.send(x.group.id, '请查提柜时间');
  let messages = await x.history();
  const reply = messages.findLast(message => message.role === 'assistant');
  const card = reply.cards?.find(item => item.kind === 'knowledge');
  assert.ok(card); assert.equal(card.title, '本次参考资料');
  assert.equal(card.sources[0].documentId, doc.id); assert.equal(card.sources[0].version, 1); assert.equal(card.sources[0].cited, false);
  assert.match(card.sources[0].excerpt, /ORIGINAL-KNOWLEDGE-a91/);
  assert.ok(!reply.id.includes(':pending-'));
  const route = x.route(`message-cards/${card.id}/sources/${doc.id}`);
  assert.equal((await call(x.member, route)).state, 'current');
  await call(x.admin, x.route(`knowledge/${doc.id}`), { method: 'PATCH', body: { content: '提柜时间更新 NEW-KNOWLEDGE-b32', expectedVersion: 1 } });
  const updated = await call(x.member, route);
  assert.equal(updated.state, 'updated'); assert.equal(updated.current.version, 2); assert.equal(updated.source.version, 1);
  assert.ok(!updated.source.excerpt.includes('NEW-KNOWLEDGE-b32'));
  for (const actor of [x.outsider, x.guest]) assert.equal((await actor.request(route)).response.status, actor === x.guest ? 401 : 404);
  assert.equal((await x.outsider.request(`/sessions/${x.other.id}/message-cards/${card.id}/sources/${doc.id}`)).response.status, 404);
  await call(x.admin, x.route(`knowledge/${doc.id}?expectedVersion=2`), { method: 'DELETE', body: {} });
  assert.equal((await call(x.member, route)).state, 'deleted');
  await x.f.stop(); await x.f.start();
  messages = await x.history();
  const restored = messages.find(message => message.id === reply.id);
  assert.deepEqual(restored.cards, reply.cards); assert.equal((await call(x.member, route)).current, null);
});

test('knowledge cards distinguish exact genuine citation markers from merely retrieved material and reject cross-group snapshots', { timeout: 30000 }, async t => {
  const x = await fixture(t), doc = await x.document();
  const matches = x.f.server.piWeb.knowledge.search(x.group.id, { query: '提柜时间' }, (await call(x.admin, '/auth/status')).user);
  const service = x.f.server.piWeb.messageCards;
  const cited = service.captureKnowledge(x.group.id, 'fixture-real-citation', matches, `依据：${matches[0].citation}`);
  assert.equal(cited.title, '引用资料'); assert.equal(cited.sources[0].cited, true);
  const unchanged = service.captureKnowledge(x.group.id, 'fixture-real-citation', [{ ...matches[0], excerpt: '不应覆盖旧快照' }], '没有引用');
  assert.deepEqual(unchanged, cited);
  assert.equal(service.source(x.group.id, cited.id, doc.id).source.excerpt, matches[0].excerpt);
  assert.throws(() => service.captureKnowledge(x.other.id, 'bad-group', matches, 'x'), { status: 400 });
  const forged = (await x.member.fetch(x.route('messages'), { method: 'POST', body: { message: '没有相关词的普通问候', cards: [{ kind: 'knowledge', sources: [{ documentId: doc.id }] }], sources: [{ documentId: doc.id }], url: 'javascript:alert(1)' } }));
  assert.equal(forged.status, 200); await forged.text();
  const last = (await x.history()).findLast(message => message.role === 'assistant');
  assert.equal(last.cards, undefined);
});

test('work results persist task and knowledge cards by message, without taking sources or status from a newer attempt', { timeout: 30000 }, async t => {
  const x = await fixture(t), doc = await x.document();
  const task = await x.work('查询提柜时间并解释'); assert.equal(task.status, 'succeeded');
  let result = (await x.history()).find(message => message.role === 'assistant' && message.workTaskId === task.id);
  const oldCards = result.cards; assert.equal(oldCards.length, 2);
  assert.equal(oldCards.find(card => card.kind === 'task_result').taskId, task.id);
  assert.equal(oldCards.find(card => card.kind === 'knowledge').sources[0].version, 1);
  await call(x.admin, x.route(`knowledge/${doc.id}`), { method: 'PATCH', body: { content: '提柜时间 NEW-ATTEMPT-KNOWLEDGE-d54', expectedVersion: 1 } });
  const database = new DatabaseSync(path.join(x.f.dataDir, 'workspace.sqlite'));
  database.prepare("UPDATE work_tasks SET attempt=2,status='failed',error='new attempt error' WHERE id=?").run(task.id); database.close();
  const actor = (await call(x.admin, '/auth/status')).user;
  const matches = x.f.server.piWeb.knowledge.search(x.group.id, { query: '提柜时间' }, actor);
  x.f.server.piWeb.messageCards.captureKnowledge(x.group.id, `work:${task.id}:2`, matches, 'new reply');
  result = (await x.history()).find(message => message.id === result.id);
  assert.deepEqual(result.cards, oldCards); assert.equal(result.cards[0].status, 'succeeded');
  assert.ok(!JSON.stringify(result.cards).includes('NEW-ATTEMPT-KNOWLEDGE-d54'));
  const failed = await x.work('[provider-error] 普通失败任务');
  assert.equal(failed.status, 'failed');
  const failureMessage = (await x.history()).find(message => message.role === 'assistant' && message.workTaskId === failed.id);
  assert.equal(failureMessage.cards[0].kind, 'task_exception');
  const mutate = new DatabaseSync(path.join(x.f.dataDir, 'workspace.sqlite'));
  mutate.prepare("UPDATE work_tasks SET attempt=2,status='succeeded',error=NULL WHERE id=?").run(failed.id); mutate.close();
  x.f.server.piWeb.messageCards.captureKnowledge(x.group.id, `work:${failed.id}:2`, matches, 'later success');
  const oldFailure = (await x.history()).find(message => message.id === failureMessage.id);
  assert.equal(oldFailure.cards[0].kind, 'task_exception'); assert.equal(oldFailure.cards[0].status, 'failed');
  assert.equal(oldFailure.cards.some(card => card.kind === 'knowledge'), false);
  const legacy = new DatabaseSync(path.join(x.f.dataDir, 'workspace.sqlite'));
  legacy.prepare("UPDATE collaboration_messages SET cards_json='[]' WHERE id=?").run(failureMessage.id);
  legacy.prepare("UPDATE work_task_events SET data_json=? WHERE task_id=? AND type='failed'").run(JSON.stringify({ error: 'Immutable legacy failure' }), failed.id);
  const legacyCard = (await x.history()).find(message => message.id === failureMessage.id).cards[0];
  legacy.prepare("UPDATE work_tasks SET attempt=3,title='New task title' WHERE id=?").run(failed.id); legacy.close();
  assert.deepEqual((await x.history()).find(message => message.id === failureMessage.id).cards[0], legacyCard);
  assert.equal(legacyCard.title, '历史任务结果');
});

test('scheduled task cards separate execution failure from notification failure and preserve textual delivery', { timeout: 30000 }, async t => {
  const x = await fixture(t);
  const plan = async body => (await call(x.admin, '/admin/schedules', { method: 'POST', body: { name: '卡片定时计划', prompt: '返回任务结果', scheduleType: 'daily', time: '09:00', enabled: false, targetSessionId: x.group.id, ...body } }, 201)).schedule;
  const run = async schedule => { const value = (await call(x.admin, `/admin/schedules/${schedule.id}/run`, { method: 'POST', body: {} }, 202)).run; await x.f.server.piWeb.schedules.waitForIdle(); return x.f.server.piWeb.schedules.getRun(value.id); };
  const original = x.f.server.piWeb.channels.publishTask;
  x.f.server.piWeb.channels.publishTask = async () => { throw new Error('fixture notification unavailable'); };
  const succeeded = await run(await plan({}));
  const successMessage = (await x.history()).find(message => message.taskRunId === succeeded.id);
  assert.equal(succeeded.status, 'succeeded'); assert.equal(x.f.server.piWeb.taskDelivery.get(succeeded.id).status, 'failed');
  assert.equal(successMessage.cards[0].kind, 'task_result'); assert.equal(successMessage.cards[0].status, 'succeeded');
  assert.match(successMessage.content, /^定时任务：卡片定时计划\n\nPi SDK/);
  x.f.server.piWeb.channels.publishTask = original;
  const failed = await run(await plan({ taskType: 'business', businessTaskId: 'card-failing-business', executionMode: 'workspace' }));
  assert.equal(failed.status, 'failed');
  const failureMessage = (await x.history()).find(message => message.taskRunId === failed.id);
  assert.equal(failureMessage.cards[0].kind, 'task_exception'); assert.equal(failureMessage.cards[0].taskKind, 'schedule'); assert.equal(failureMessage.cards[0].taskId, failed.id);
  assert.match(failureMessage.content, /退出码 9/);
});
