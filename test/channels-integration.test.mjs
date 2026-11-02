import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFixture, configure, session } from './auth-helpers.mjs';

const password = 'Wechat-bridge-test-only-2026!';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, description) {
  const end = Date.now() + 10000;
  while (Date.now() < end) { if (await check()) return; await pause(25); }
  throw new Error(`Timed out: ${description}`);
}

function mockWechat() {
  let serial = 0;
  const queues = new Map(), sent = [], polls = [], confirmed = new Set();
  class Client {
    constructor(options) { Object.assign(this, options); }
    async getQrCode() {
      const qrcode = `test-qr-${++serial}`;
      return { qrcode, qrCodeUrl: `https://weixin.qq.com/test-login/${qrcode}` };
    }
    async getQrStatus(qrcode) {
      if (!confirmed.has(qrcode)) return { status: 'wait' };
      return { status: 'confirmed', token: `private-token-${qrcode}`, accountId: `bot-${qrcode}`, userId: `owner-${qrcode}`, baseUrl: 'https://ilinkai.weixin.qq.com' };
    }
    async getUpdates(cursor = '', { signal } = {}) {
      polls.push(this.token);
      while (!signal?.aborted && !queues.get(this.token)?.length) await pause(15);
      if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
      const messages = queues.get(this.token).splice(0);
      return { messages, cursor: `${Number(cursor || 0) + 1}` };
    }
    async sendText(message) { sent.push({ ...message, token: this.token }); return { ret: 0 }; }
  }
  return {
    sent, polls, factory: options => new Client(options),
    get lastQr() { return `test-qr-${serial}`; },
    confirm(qrcode) { confirmed.add(qrcode); },
    push(qrcode, text, { userId = `owner-${qrcode}`, id = `message-${Date.now()}-${Math.random()}` } = {}) {
      const token = `private-token-${qrcode}`;
      const raw = { message_id: id, message_type: 1, from_user_id: userId, to_user_id: `bot-${qrcode}`,
        context_token: `private-context-${qrcode}`, create_time_ms: Date.now(), item_list: [{ type: 1, text_item: { text } }] };
      queues.set(token, [...(queues.get(token) || []), raw]); return raw;
    },
  };
}

async function setup() {
  const wechat = mockWechat();
  const fixture = await createFixture({ prefix: 'channel-bridge', options: { channels: { clientFactory: wechat.factory, pollIntervalMs: 10, loginPollIntervalMs: 20, retryMs: 20 } } });
  const admin = fixture.client();
  await admin.request('/auth/setup', { method: 'POST', body: { username: 'channel-admin', displayName: 'Administrator', password } });
  await configure(admin, fixture);
  return { fixture, admin, wechat };
}

async function loggedChannel(admin, wechat, name = '测试微信') {
  const made = await admin.request('/admin/channels', { method: 'POST', body: { name } });
  assert.equal(made.response.status, 201, JSON.stringify(made.data));
  const id = made.data.channel.id;
  const started = await admin.request(`/admin/channels/${id}/logins`, { method: 'POST', body: {} });
  assert.equal(started.response.status, 200, JSON.stringify(started.data));
  const loginId = started.data.login.id;
  const image = await admin.fetch(`/admin/channels/${id}/logins/${loginId}/qr.svg`);
  assert.equal(image.status, 200); assert.match(await image.text(), /<svg/);
  const qrcode = wechat.lastQr;
  wechat.confirm(qrcode);
  const result = await admin.request(`/admin/channels/${id}/logins/${loginId}`);
  assert.equal(result.response.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.login.status, 'confirmed');
  assert.doesNotMatch(JSON.stringify(result.data), /private-token|private-context|owner-test-qr|bot-test-qr/);
  return { id, qrcode };
}

test('admin configures Weixin; bound scanner joins the real Pi group, peers stay isolated and final replies relay once', async () => {
  const { fixture, admin, wechat } = await setup();
  try {
    const member = fixture.client(), outsider = fixture.client();
    const made = await admin.request('/admin/users', { method: 'POST', body: { username: 'channel-member', displayName: 'Member', password, role: 'member' } });
    await member.request('/auth/login', { method: 'POST', body: { username: 'channel-member', password } });
    assert.equal((await outsider.request('/admin/channels')).response.status, 401);
    for (const method of ['GET', 'POST']) assert.equal((await member.request('/admin/channels', { method, ...(method === 'POST' ? { body: { name: 'forbidden' } } : {}) })).response.status, 403);
    const channel = await loggedChannel(admin, wechat);
    const created = await admin.request('/sessions', { method: 'POST', body: { title: '微信协作群', channelIds: [channel.id] } });
    assert.equal(created.response.status, 201, JSON.stringify(created.data));
    const id = created.data.session.id;
    await admin.request(`/sessions/${id}/members`, { method: 'POST', body: { userIds: [made.data.user.id] } });
    const members = (await member.request(`/sessions/${id}/members`)).data;
    assert.equal(members.externalMembers.length, 1);
    assert.equal(members.externalMembers[0].source, 'weixin');
    assert.doesNotMatch(JSON.stringify(members), /private-token|private-context|owner-test-qr/);
    assert.equal((await member.request(`/sessions/${id}/channels`, { method: 'PUT', body: { channelIds: [] } })).response.status, 403);
    assert.equal((await outsider.request(`/sessions/${id}/channels`)).response.status, 401);
    const other = await session(admin, 'Other private group');
    await admin.request(`/sessions/${other.id}/members`, { method: 'POST', body: { userIds: [made.data.user.id] } });
    assert.equal((await member.request(`/sessions/${other.id}/channels`)).data.channels.length, 0);
    assert.equal((await member.request('/sessions', { method: 'POST', body: { channelIds: [channel.id] } })).response.status, 403);
    const before = (await admin.request('/sessions')).data.total;
    assert.equal((await admin.request('/sessions', { method: 'POST', body: { title: 'Conflict', channelIds: [channel.id] } })).response.status, 409);
    assert.equal((await admin.request('/sessions')).data.total, before);

    wechat.push(channel.qrcode, 'Rejected stranger', { userId: 'uninvited-wechat-user', id: 'uninvited-1' });
    const message = wechat.push(channel.qrcode, '来自微信的业务查询', { id: 'incoming-1' });
    await until(async () => (await admin.request(`/sessions/${id}`)).data.messages.some(item => item.authorName?.includes('微信') && item.content.includes('来自微信的业务查询')), 'incoming message saved in group');
    await until(() => wechat.sent.some(item => item.text.includes('Pi SDK 已连接')), 'AI final answer sent to Weixin');
    assert.equal(wechat.sent.filter(item => item.text.includes('Pi SDK 已连接')).length, 1);
    assert.ok(wechat.sent.every(item => item.toUserId === `owner-${channel.qrcode}`));
    assert.ok(wechat.sent.every(item => !item.text.includes('Rejected stranger')));
    const history = (await admin.request(`/sessions/${id}`)).data;
    assert.ok(history.messages.every(item => !item.content.includes('Rejected stranger')));
    const requests = fixture.mock.requests.length;
    wechat.push(channel.qrcode, message.item_list[0].text_item.text, { id: 'incoming-1' });
    await member.send(id, '员工继续此群任务');
    await until(() => wechat.sent.some(item => item.text.includes('员工继续此群任务')), 'member message relayed');
    await until(() => wechat.sent.filter(item => item.text.includes('Pi SDK 已连接')).length === 2, 'member final answer relayed');
    assert.equal(fixture.mock.requests.length, requests + 1, 'duplicate inbound must not invoke the model');
    assert.ok(wechat.sent.every(item => !item.text.includes('tool_execution') && !item.text.includes('private-token')));
    assert.equal((await member.request(`/sessions/${other.id}`)).data.messages.length, 0);
  } finally { await fixture.close(); }
});

test('unbinding cancels a Weixin task and prevents subsequent incoming and outgoing access', async () => {
  const { fixture, admin, wechat } = await setup();
  try {
    const channel = await loggedChannel(admin, wechat);
    const created = await admin.request('/sessions', { method: 'POST', body: { title: '撤销渠道权限', channelIds: [channel.id] } });
    const id = created.data.session.id;
    wechat.push(channel.qrcode, '[slow-response] 微信任务', { id: 'slow-1' });
    await until(async () => (await admin.request(`/sessions/${id}`)).data.session.running, 'channel task started');
    assert.equal((await admin.request(`/sessions/${id}/channels`, { method: 'PUT', body: { channelIds: [] } })).response.status, 200);
    await until(async () => !(await admin.request(`/sessions/${id}`)).data.session.running, 'channel task aborted');
    assert.equal((await admin.request(`/sessions/${id}/members`)).data.externalMembers.length, 0);
    const before = fixture.mock.requests.length;
    wechat.push(channel.qrcode, 'unbind rejected', { id: 'after-unbind' });
    await admin.send(id, '本群仍正常工作');
    assert.equal(fixture.mock.requests.length, before + 1);
    assert.equal(wechat.sent.length, 0, 'revoked channel receives no group output');
  } finally { await fixture.close(); }
});

test('a scanned channel confirms without browser login polling and remains connected across server restart', async () => {
  const { fixture, admin, wechat } = await setup();
  try {
    const created = await admin.request('/admin/channels', { method: 'POST', body: { name: '关闭扫码窗口后确认' } });
    const id = created.data.channel.id;
    const started = await admin.request(`/admin/channels/${id}/logins`, { method: 'POST', body: {} });
    assert.equal(started.response.status, 200);
    const group = await admin.request('/sessions', { method: 'POST', body: { title: '扫码自动确认', channelIds: [id] } });
    assert.equal(group.response.status, 201);
    // The browser now closes its QR modal. No GET /logins/:id is made.
    wechat.confirm(wechat.lastQr);
    await until(async () => (await admin.request('/admin/channels')).data.channels.find(channel => channel.id === id)?.connected,
      'server confirms the scanned QR without browser status requests');
    assert.equal(fixture.mock.requests.length, 0, 'confirming a login must not start a model task');
    await fixture.stop(); await fixture.start();
    const list = (await admin.request('/admin/channels')).data;
    const channel = list.channels.find(item => item.id === id);
    assert.equal(channel.connected, true);
    assert.equal(channel.sessionId, group.data.session.id);
    assert.equal(channel.canReceive, false);
    assert.doesNotMatch(JSON.stringify(list), /private-token|private-context|owner-test-qr/);
  } finally { await fixture.close(); }
});
