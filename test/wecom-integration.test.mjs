import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFixture, configure, session } from './auth-helpers.mjs';

const password = 'Wecom-bridge-test-only-2026!';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, description) {
  const end = Date.now() + 10000;
  while (Date.now() < end) { if (await check()) return; await pause(20); }
  throw new Error(`Timed out: ${description}`);
}
function mockWecom() {
  const clients = [], sent = [];
  return {
    clients, sent,
    factory(options) {
      const client = { ...options, closed: false,
        start() { queueMicrotask(() => { if (!client.closed) options.onState({ status: 'connected' }); }); },
        async close() { client.closed = true; },
        async sendText(message) { if (client.closed || message.signal?.aborted) throw new DOMException('Stopped', 'AbortError'); sent.push({ ...message, botId: options.botId }); },
      };
      clients.push(client); return client;
    },
    emit(botId, text, { targetId = 'selected-group', chatType = 'group', userId = 'employee-wecom-1001', messageId = `msg-${Date.now()}-${Math.random()}` } = {}) {
      const client = [...clients].reverse().find(item => item.botId === botId && !item.closed);
      assert.ok(client, 'expected an active mock Wecom connection');
      client.onMessage({ botId, text, targetId, chatType, userId, messageId, timestamp: Date.now(), requestId: `req-${messageId}` });
    },
  };
}
async function setup() {
  const wecom = mockWecom();
  const fixture = await createFixture({ prefix: 'wecom-bridge', options: { channels: { wecom: { clientFactory: options => wecom.factory(options), pollIntervalMs: 10, retryMs: 20 } } } });
  const admin = fixture.client();
  await admin.request('/auth/setup', { method: 'POST', body: { username: 'wecom-admin', displayName: 'Admin', password } });
  await configure(admin, fixture);
  return { fixture, admin, wecom };
}
async function channel(admin, botId = 'test-wecom-bot') {
  const response = await admin.request('/admin/channels', { method: 'POST', body: { type: 'wecom', name: '企微业务助手', botId, secret: 'private-wecom-secret-do-not-return' } });
  assert.equal(response.response.status, 201, JSON.stringify(response.data));
  const id = response.data.channel.id;
  await until(async () => (await admin.request('/admin/channels')).data.channels.find(item => item.id === id)?.connected, 'Wecom authentication state');
  assert.doesNotMatch(JSON.stringify(response.data), /private-wecom-secret/);
  return id;
}

test('Wecom needs explicit observed conversation selection; only that conversation shares the real Pi group', async () => {
  const { fixture, admin, wecom } = await setup();
  try {
    const member = fixture.client();
    const made = await admin.request('/admin/users', { method: 'POST', body: { username: 'wecom-member', displayName: 'Member', password, role: 'member' } });
    await member.request('/auth/login', { method: 'POST', body: { username: 'wecom-member', password } });
    assert.equal((await member.request('/admin/channels')).response.status, 403);
    const id = await channel(admin);
    const created = await admin.request('/sessions', { method: 'POST', body: { title: '企微协作群', channelIds: [id] } });
    assert.equal(created.response.status, 201, JSON.stringify(created.data));
    const groupId = created.data.session.id;
    await admin.request(`/sessions/${groupId}/members`, { method: 'POST', body: { userIds: [made.data.user.id] } });
    assert.equal((await admin.request(`/admin/channels/${id}/logins`, { method: 'POST', body: {} })).response.status, 400);
    assert.equal((await admin.request(`/admin/channels/${id}`, { method: 'PATCH', body: { target: { id: 'never-observed', chatType: 'group' } } })).response.status, 400);
    wecom.emit('test-wecom-bot', 'Discovery must not run an Agent', { messageId: 'discovery-1' });
    wecom.emit('test-wecom-bot', 'Other group discovery', { targetId: 'other-group', messageId: 'discovery-2' });
    await until(async () => (await admin.request(`/admin/channels/${id}/conversations`)).data.conversations.length === 2, 'conversation discovery');
    assert.equal(fixture.mock.requests.length, 0);
    assert.equal((await admin.request(`/sessions/${groupId}`)).data.messages.length, 0);
    const list = (await admin.request(`/admin/channels/${id}/conversations`)).data;
    assert.doesNotMatch(JSON.stringify(list), /Discovery must|Other group discovery|private-wecom-secret/);
    assert.equal((await member.request(`/admin/channels/${id}/conversations`)).response.status, 403);
    const selected = await admin.request(`/admin/channels/${id}`, { method: 'PATCH', body: { target: { id: 'selected-group', chatType: 'group' } } });
    assert.equal(selected.response.status, 200, JSON.stringify(selected.data));
    wecom.emit('test-wecom-bot', 'Cross-group message must stay outside', { targetId: 'other-group', messageId: 'other-1' });
    wecom.emit('test-wecom-bot', '企微发起业务查询', { messageId: 'accepted-1' });
    await until(async () => (await admin.request(`/sessions/${groupId}`)).data.messages.some(item => item.role === 'user' && item.content.includes('企微发起业务查询')), 'Wecom message in Pi transcript');
    await until(() => wecom.sent.some(item => item.text.includes('Pi SDK 已连接')), 'AI reply returns to selected Wecom conversation');
    assert.ok(wecom.sent.every(item => item.targetId === 'selected-group'));
    assert.equal(wecom.sent.filter(item => item.text.includes('Pi SDK 已连接')).length, 1);
    assert.ok(wecom.sent.every(item => !item.text.includes('企微发起业务查询')), 'incoming message is not echoed');
    const roster = (await member.request(`/sessions/${groupId}/members`)).data;
    assert.ok(roster.externalMembers.some(item => item.source === 'wecom'));
    assert.doesNotMatch(JSON.stringify(roster), /private-wecom-secret/);
    const before = fixture.mock.requests.length;
    wecom.emit('test-wecom-bot', '企微发起业务查询', { messageId: 'accepted-1' });
    await member.send(groupId, 'Web员工继续查询');
    await until(() => wecom.sent.some(item => item.text.includes('Web员工继续查询')), 'Web member message is forwarded');
    await until(() => wecom.sent.filter(item => item.text.includes('Pi SDK 已连接')).length === 2, 'Web member reply is forwarded');
    assert.equal(fixture.mock.requests.length, before + 1, 'duplicate callback does not repeat the model task');
    const history = (await member.request(`/sessions/${groupId}`)).data;
    assert.ok(history.messages.every(item => !item.content.includes('Cross-group message')));
    const other = await session(admin, 'Unrelated private Web group');
    await admin.request(`/sessions/${other.id}/members`, { method: 'POST', body: { userIds: [made.data.user.id] } });
    assert.equal((await member.request(`/sessions/${other.id}`)).data.messages.length, 0);
    const bound = (await admin.request(`/sessions/${groupId}/channels`)).data;
    assert.equal(bound.channels[0].type, 'wecom');
    assert.doesNotMatch(JSON.stringify(bound), /private-wecom-secret/);
    await fixture.stop(); await fixture.start();
    await until(async () => (await admin.request('/admin/channels')).data.channels.find(item => item.id === id)?.connected, 'Wecom reconnect after restart');
    assert.equal((await admin.request(`/sessions/${groupId}/channels`)).data.channels[0].target.id, 'selected-group');
  } finally { await fixture.close(); }
});

test('unbinding a Wecom channel cancels its active task and revokes further group access', async () => {
  const { fixture, admin, wecom } = await setup();
  try {
    const id = await channel(admin);
    wecom.emit('test-wecom-bot', 'discover', { messageId: 'discover-before-binding' });
    await until(async () => (await admin.request(`/admin/channels/${id}/conversations`)).data.conversations.length === 1, 'discover');
    const selected = await admin.request(`/admin/channels/${id}`, { method: 'PATCH', body: { target: { id: 'selected-group', chatType: 'group' } } });
    assert.equal(selected.response.status, 200);
    const created = await admin.request('/sessions', { method: 'POST', body: { title: '撤销企微渠道', channelIds: [id] } });
    const groupId = created.data.session.id;
    wecom.emit('test-wecom-bot', '[slow-response] 企微任务', { messageId: 'slow-wecom-1' });
    await until(async () => (await admin.request(`/sessions/${groupId}`)).data.session.running, 'Wecom task starts');
    assert.equal((await admin.request(`/sessions/${groupId}/channels`, { method: 'PUT', body: { channelIds: [] } })).response.status, 200);
    await until(async () => !(await admin.request(`/sessions/${groupId}`)).data.session.running, 'Wecom task cancelled');
    const requests = fixture.mock.requests.length;
    wecom.emit('test-wecom-bot', 'Unauthorized after unbind', { messageId: 'after-unbind' });
    await admin.send(groupId, '群内继续工作');
    assert.equal(fixture.mock.requests.length, requests + 1);
    assert.equal(wecom.sent.length, 0);
  } finally { await fixture.close(); }
});

test('mixed Weixin and Wecom bindings retain the other transport and validate conflicts before changing a group', async () => {
  const { fixture, admin } = await setup();
  try {
    const personal = await admin.request('/admin/channels', { method: 'POST', body: { type: 'weixin', name: '已有个人微信' } });
    const personalId = personal.data.channel.id, enterpriseId = await channel(admin);
    const created = await admin.request('/sessions', { method: 'POST', body: { title: '多个渠道共用一个群', channelIds: [personalId, enterpriseId] } });
    assert.equal(created.response.status, 201);
    const groupId = created.data.session.id;
    assert.deepEqual(new Set((await admin.request(`/sessions/${groupId}/channels`)).data.channels.map(item => item.id)), new Set([personalId, enterpriseId]));
    const spare = (await admin.request('/admin/channels', { method: 'POST', body: { name: '尚未绑定的微信' } })).data.channel.id;
    const before = (await admin.request('/sessions')).data.total;
    const conflict = await admin.request('/sessions', { method: 'POST', body: { title: '不应创建', channelIds: [spare, enterpriseId] } });
    assert.equal(conflict.response.status, 409);
    assert.equal((await admin.request('/sessions')).data.total, before);
    assert.equal((await admin.request('/admin/channels')).data.channels.find(item => item.id === spare).sessionId, null);
    const unbound = await admin.request(`/sessions/${groupId}/channels`, { method: 'PUT', body: { channelIds: [personalId] } });
    assert.equal(unbound.response.status, 200);
    assert.deepEqual(unbound.data.channels.map(item => item.id), [personalId]);
    assert.equal((await admin.request('/admin/channels')).data.channels.find(item => item.id === enterpriseId).sessionId, null);
    assert.equal((await admin.request(`/admin/channels/${personalId}/connect`, { method: 'POST', body: {} })).response.status, 400);
  } finally { await fixture.close(); }
});
