import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFixture, configure } from './auth-helpers.mjs';

const hook = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=fixture-api-webhook-key-20261105';
async function until(check) {
  const end = Date.now() + 10000;
  while (Date.now() < end) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 15)); }
  throw new Error('Timed out waiting for isolated Webhook delivery');
}

test('Webhook API protects credentials and sends chat replies without opening a WebSocket', async t => {
  const sent = [];
  const fixture = await createFixture({ prefix: 'webhook-api', options: { channels: { wecom: {
    clientFactory: () => assert.fail('Webhook-only channels must not connect to the live enterprise API'),
    webhookSender: async value => { sent.push(value); }, webhookIntervalMs: 0, pollIntervalMs: 10,
  } } } });
  t.after(() => fixture.close());
  const admin = fixture.client(), member = fixture.client();
  const password = 'Webhook-fixture-password-2026!';
  await admin.request('/auth/setup', { method: 'POST', body: { username: 'webhook-admin', displayName: '管理员', password } });
  await configure(admin, fixture);
  const account = await admin.request('/admin/users', { method: 'POST', body: { username: 'webhook-member', displayName: '测试员工', password, role: 'member' } });
  await member.request('/auth/login', { method: 'POST', body: { username: 'webhook-member', password } });
  const created = await admin.request('/admin/channels', { method: 'POST', body: {
    type: 'wecom', name: '报告推送', connectionMode: 'webhook', webhookUrl: hook,
  } });
  assert.equal(created.response.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.channel.connectionMode, 'webhook');
  assert.equal(created.data.channel.replyMode, 'webhook');
  assert.equal(created.data.channel.webhookSet, true);
  assert.equal(created.data.channel.connected, false);
  assert.equal(created.data.channel.botId, '');
  assert.ok(!JSON.stringify(created.data).includes('fixture-api-webhook-key'));
  const channelId = created.data.channel.id;
  const made = await admin.request('/sessions', { method: 'POST', body: { title: 'Webhook 测试助手', channelIds: [channelId] } });
  assert.equal(made.response.status, 201, JSON.stringify(made.data));
  const groupId = made.data.session.id;
  await admin.request(`/sessions/${groupId}/members`, { method: 'POST', body: { userIds: [account.data.user.id] } });
  const publicChannel = await member.request(`/sessions/${groupId}/channels`);
  assert.equal(publicChannel.response.status, 200);
  assert.equal(publicChannel.data.channels[0].canSend, true);
  assert.equal(publicChannel.data.channels[0].canReceive, false);
  assert.ok(!JSON.stringify(publicChannel.data).includes('fixture-api-webhook-key'));
  const roster = await member.request(`/sessions/${groupId}/members`);
  assert.ok(!(roster.data.externalMembers || []).some(item => item.channelId === channelId));
  assert.equal((await member.request(`/admin/channels/${channelId}`, { method: 'PATCH', body: { webhookUrl: hook } })).response.status, 403);
  for (const webhookUrl of ['http://127.0.0.1/private', 'https://example.com/send?key=fixture-key']) {
    assert.equal((await admin.request(`/admin/channels/${channelId}`, { method: 'PATCH', body: { webhookUrl } })).response.status, 400);
  }
  const preserved = await admin.request(`/admin/channels/${channelId}`, { method: 'PATCH', body: { webhookUrl: '' } });
  assert.equal(preserved.response.status, 200);
  assert.equal(preserved.data.channel.webhookSet, true);
  await member.send(groupId, '请简短回复测试消息');
  await until(() => sent.some(item => item.text.includes('Pi SDK 已连接')));
  assert.equal(sent.filter(item => item.text.includes('Pi SDK 已连接')).length, 1);
  assert.ok(sent.every(item => item.webhookUrl === hook));
  fixture.server.piWeb.logs.write({ source: 'system', message: `Webhook diagnostic ${hook} bare-key=fixture-api-webhook-key-20261105` });
  const recorded = JSON.stringify(fixture.server.piWeb.logs.list());
  assert.ok(!recorded.includes('fixture-api-webhook-key-20261105'), 'full URLs and bare Webhook keys must be hidden in runtime logs');
  const audit = JSON.stringify(fixture.server.piWeb.channels.store.db.prepare('SELECT details FROM audit').all());
  assert.ok(!audit.includes('fixture-api-webhook-key-20261105'), 'credential updates must not write secrets to the audit trail');
});
