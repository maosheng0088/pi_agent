import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { ChannelService } from '../lib/channels.mjs';

const admin = { id: 'admin-test', displayName: '管理员', role: 'admin' };
const member = { id: 'member-test', displayName: '员工', role: 'member' };
const scanner = 'scanner-private-123456';
const bot = 'bot-private-abcdef';
const rawMessage = (id, text = '查询订单', overrides = {}) => ({ message_type: 1, message_id: id, from_user_id: scanner,
  to_user_id: bot, context_token: 'private-context-token', create_time_ms: Date.now() + 1000,
  item_list: [{ type: 1, text_item: { text } }], ...overrides });

async function until(check, message = 'condition did not become true') {
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 5)); }
  assert.fail(message);
}

function backend() {
  const state = { queues: new Map(), waiters: new Map(), sent: [], cursors: [], qr: 0, sendFailures: 0, pollError: null,
    status: 'confirmed', statusCalls: [], statusFailures: 0, pendingStatuses: [], pauseStatuses: false, pendingSends: [], pauseSends: false };
  state.push = (token, messages, cursor = 'cursor-private') => {
    const result = { messages, cursor };
    const waiter = state.waiters.get(token);
    if (waiter) { state.waiters.delete(token); waiter.finish(result); }
    else { const queue = state.queues.get(token) || []; queue.push(result); state.queues.set(token, queue); }
  };
  state.clientFactory = ({ token = '', baseUrl = 'https://ilinkai.weixin.qq.com' } = {}) => ({
    baseUrl,
    async getQrCode() { const id = ++state.qr; return { qrcode: `private-qr-${id}`, qrCodeUrl: `https://weixin.qq.com/private-qr-${id}` }; },
    async getQrStatus(qrcode, { signal, verifyCode } = {}) {
      state.statusCalls.push({ qrcode, verifyCode });
      if (state.statusFailures > 0) { state.statusFailures--; throw new Error('SECRET-QR-NETWORK-DETAIL'); }
      if (state.pauseStatuses) await new Promise((resolve, reject) => {
        const abort = () => reject(new DOMException('cancelled', 'AbortError'));
        state.pendingStatuses.push({ finish() { signal?.removeEventListener('abort', abort); resolve(); } });
        signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
      });
      return { status: state.status, token: `private-token-${qrcode}`, accountId: bot, userId: scanner, baseUrl };
    },
    async getUpdates(cursor, { signal }) {
      state.cursors.push({ token, cursor });
      if (state.pollError) throw state.pollError;
      const queued = state.queues.get(token)?.shift(); if (queued) return queued;
      return new Promise((resolve, reject) => {
        const abort = () => { if (state.waiters.get(token) === waiter) state.waiters.delete(token); reject(new DOMException('cancelled', 'AbortError')); };
        const waiter = { finish(value) { signal.removeEventListener('abort', abort); resolve(value); } };
        state.waiters.set(token, waiter); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
      });
    },
    async sendText(value) {
      if (state.sendFailures > 0) { state.sendFailures--; throw new Error('SECRET-UPSTREAM-NETWORK-DETAIL'); }
      if (state.pauseSends) await new Promise((resolve, reject) => {
        state.pendingSends.push(resolve); value.signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
      });
      state.sent.push({ ...value, token }); return { clientId: value.clientId };
    },
  });
  return state;
}

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-web-channels-')); const store = new Store(directory, directory);
  for (const user of [admin, member]) store.db.prepare('INSERT INTO users(id,username,display_name,role,password_hash,created_at) VALUES (?,?,?,?,?,?)')
    .run(user.id, user.id, user.displayName, user.role, 'not-a-real-password-hash', new Date().toISOString());
  for (const id of ['group-a', 'group-b']) {
    const meta = { id, title: id, ownerId: admin.id, createdAt: new Date().toISOString() }; store.sessions.push(meta);
    store.db.prepare('INSERT INTO session_meta(id,data) VALUES (?,?)').run(id, JSON.stringify(meta));
    store.db.prepare('INSERT INTO group_members(session_id,user_id,added_by,added_at) VALUES (?,?,?,?)').run(id, admin.id, admin.id, new Date().toISOString());
  }
  const mock = backend(); let service = new ChannelService(store, { clientFactory: mock.clientFactory, pollIntervalMs: 10, retryMs: 10, ...options });
  t.after(async () => {
    await service.close(); store.close();
    assert.equal(path.dirname(directory), os.tmpdir()); assert.ok(path.basename(directory).startsWith('pi-web-channels-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { store, mock, get service() { return service; }, async restart(nextOptions = {}) {
    await service.close(); service = new ChannelService(store, { clientFactory: mock.clientFactory, pollIntervalMs: 10, retryMs: 10, ...nextOptions }); return service;
  }, async connect(name = '个人微信') {
    const channel = service.create({ name }, admin); const login = await service.startLogin(channel.id, admin);
    const confirmed = await service.loginStatus(channel.id, login.login.id, admin); assert.equal(confirmed.channel.status, 'connected');
    const token = store.db.prepare('SELECT auth_token FROM im_channels WHERE id=?').get(channel.id).auth_token;
    return { channel: confirmed.channel, token, login: login.login };
  } };
}

test('channel administration and QR content are admin-only; responses never expose credentials or scanner ids', async (t) => {
  const f = await fixture(t); const { service } = f;
  assert.throws(() => service.create({ name: '微信' }, member), { status: 403 });
  const channel = service.create({ name: '微信' }, admin);
  await assert.rejects(service.startLogin(channel.id, member), { status: 403 });
  const pending = await service.startLogin(channel.id, admin);
  assert.match(pending.login.qrCodeUrl, /^\/api\/admin\/channels\/.+\/logins\/.+\/qr\.svg$/);
  assert.equal(service.qrContent(channel.id, pending.login.id, admin), 'https://weixin.qq.com/private-qr-1');
  assert.throws(() => service.qrContent(channel.id, pending.login.id, member), { status: 403 });
  const confirmed = await service.loginStatus(channel.id, pending.login.id, admin);
  assert.equal(confirmed.login.status, 'confirmed');
  assert.throws(() => service.qrContent(channel.id, pending.login.id, admin), { status: 410 });
  const response = JSON.stringify([confirmed, service.list()]);
  for (const secret of ['private-token', scanner, bot, 'private-context-token', 'private-qr']) assert.ok(!response.includes(secret), secret);
});

test('only the confirmed scanner can enter the bound group; messages are durable and deduplicated', async (t) => {
  const calls = []; const f = await fixture(t, { onMessage: async (value) => { assert.equal(f.service.assertActor(value.sessionId, value.actor), true); calls.push(value); } });
  const { channel, token } = await f.connect(); f.service.bind('group-a', [channel.id], admin);
  const listed = f.service.forSession('group-a')[0];
  assert.equal(listed.externalMember.id, `weixin:${channel.id}`);
  assert.throws(() => f.service.assertActor('group-a', listed.externalMember), { status: 403 });
  f.service.start();
  f.mock.push(token, [rawMessage('other-contact', '别人的消息', { from_user_id: 'unapproved-contact' }),
    rawMessage('native-group', '微信群消息', { group_id: 'native-wechat-group' }), rawMessage('one'), rawMessage('one')], 'cursor-one');
  await until(() => calls.length === 1);
  assert.equal(calls[0].sessionId, 'group-a'); assert.equal(calls[0].actor.role, 'member'); assert.equal(calls[0].actor.source, 'weixin');
  assert.equal(calls[0].message.text, '查询订单');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM im_channel_inbox').get().n, 1);
  assert.equal(f.store.db.prepare('SELECT cursor FROM im_channels WHERE id=?').get(channel.id).cursor, 'cursor-one');
  f.mock.push(token, [rawMessage('one')], 'cursor-two');
  await until(() => f.store.db.prepare('SELECT cursor FROM im_channels WHERE id=?').get(channel.id).cursor === 'cursor-two');
  assert.equal(calls.length, 1);
});

test('binding is exclusive, admin-only and requires membership; changing it revokes old actors and queued work', async (t) => {
  let started; const entered = new Promise((resolve) => { started = resolve; }); let actor; let signal;
  const f = await fixture(t, { onMessage: async (value) => { actor = value.actor; signal = value.signal; started();
    await new Promise((resolve) => value.signal.addEventListener('abort', resolve, { once: true })); } });
  const { channel, token } = await f.connect();
  assert.throws(() => f.service.bind('group-a', [channel.id], member), { status: 403 });
  f.service.bind('group-a', [channel.id], admin);
  assert.throws(() => f.service.validateBindings([channel.id], 'group-b'), { status: 409 });
  f.service.start(); f.mock.push(token, [rawMessage('running'), rawMessage('queued')]); await entered;
  assert.equal(f.service.assertActor('group-a', actor), true);
  f.service.bind('group-a', [], admin);
  assert.equal(signal.aborted, true); assert.throws(() => f.service.assertActor('group-a', actor), { status: 403 });
  assert.equal(f.store.db.prepare("SELECT status FROM im_channel_inbox WHERE message_id='queued'").get().status, 'cancelled');
  f.service.bind('group-b', [channel.id], admin);
  assert.throws(() => f.service.assertActor('group-b', actor), { status: 403 });
  assert.equal(f.service.forSession('group-a').length, 0); assert.equal(f.service.forSession('group-b').length, 1);
});

test('publish mirrors only new messages and never echoes ingress or leaks to an unconfirmed contact', async (t) => {
  const calls = []; const f = await fixture(t, { onMessage: async (value) => { calls.push(value); } });
  const { channel, token } = await f.connect(); f.service.bind('group-a', [channel.id], admin);
  assert.deepEqual(f.service.publish('group-a', { text: '扫码人尚未发言' }), { queued: 0 });
  f.service.start(); f.mock.push(token, [rawMessage('hello', '你好')]); await until(() => calls.length === 1);
  assert.deepEqual(f.service.publish('group-a', { text: '你好', excludeChannelId: channel.id, messageId: 'hello' }), { queued: 0 });
  assert.deepEqual(f.service.publish('group-a', { text: '收到', authorName: 'Pi', messageId: 'answer' }), { queued: 1 });
  assert.deepEqual(f.service.publish('group-a', { text: '收到', authorName: 'Pi', messageId: 'answer' }), { queued: 0 });
  await until(() => f.mock.sent.length === 1);
  assert.equal(f.mock.sent[0].toUserId, scanner); assert.equal(f.mock.sent[0].text, 'Pi：\n收到');
  assert.equal(f.mock.sent[0].contextToken, 'private-context-token');
  assert.equal(f.store.db.prepare('SELECT status FROM im_channel_outbox').get().status, 'sent');
});

test('group work is serialized and busy turns retry without dropping the inbox item', async (t) => {
  let active = 0; let peak = 0; const seen = []; let busy = true;
  const f = await fixture(t, { onMessage: async ({ message }) => {
    if (busy) { busy = false; const error = new Error('busy'); error.status = 409; throw error; }
    active++; peak = Math.max(peak, active); await new Promise((resolve) => setTimeout(resolve, 15)); seen.push(message.text); active--;
  } });
  const { channel, token } = await f.connect(); f.service.bind('group-a', [channel.id], admin); f.service.start();
  f.mock.push(token, [rawMessage('one', 'first'), rawMessage('two', 'second')]);
  await until(() => seen.length === 2); assert.equal(peak, 1);
  assert.deepEqual(seen, ['first', 'second']);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM im_channel_inbox WHERE status='done'").get().n, 2);
  assert.equal(f.store.db.prepare("SELECT attempts FROM im_channel_inbox WHERE message_id='one'").get().attempts, 2);
});

test('pending messages persist across restart, interrupted turns do not replay, and cursors resume', async (t) => {
  const f = await fixture(t); const { channel, token } = await f.connect(); f.service.bind('group-a', [channel.id], admin);
  const row = f.store.db.prepare('SELECT * FROM im_channels WHERE id=?').get(channel.id);
  f.store.db.prepare('UPDATE im_channels SET cursor=? WHERE id=?').run('saved-cursor', channel.id);
  for (const [id, status] of [['pending-1', 'pending'], ['running-1', 'running']]) {
    f.store.db.prepare('INSERT INTO im_channel_inbox(id,channel_id,message_id,session_id,binding_epoch,text,status,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, channel.id, id, 'group-a', row.binding_epoch, id, status, new Date().toISOString());
  }
  const seen = []; await f.restart({ onMessage: async ({ message }) => { seen.push(message.text); } }); f.service.start();
  await until(() => seen.length === 1); assert.deepEqual(seen, ['pending-1']);
  assert.equal(f.store.db.prepare("SELECT status FROM im_channel_inbox WHERE id='running-1'").get().status, 'interrupted');
  assert.ok(f.mock.cursors.some((value) => value.token === token && value.cursor === 'saved-cursor'));
});

test('removing the binding administrator or disabling the owner revokes an active external turn immediately', async (t) => {
  let value; const f = await fixture(t, { onMessage: async (incoming) => { value = incoming;
    await new Promise((resolve) => incoming.signal.addEventListener('abort', resolve, { once: true })); } });
  const { channel, token } = await f.connect(); f.service.bind('group-a', [channel.id], admin); f.service.start();
  f.mock.push(token, [rawMessage('work')]); await until(() => value);
  f.store.db.prepare('DELETE FROM group_members WHERE session_id=? AND user_id=?').run('group-a', admin.id); f.service.invalidateUser(admin.id);
  assert.equal(value.signal.aborted, true); assert.throws(() => f.service.assertActor('group-a', value.actor), { status: 403 });
  assert.equal(f.service.list()[0].status, 'unavailable'); assert.deepEqual(f.service.publish('group-a', { text: 'private' }), { queued: 0 });
});

test('expired QR and invalid provider sessions expose only safe status messages', async (t) => {
  let clock = Date.now(); const f = await fixture(t, { now: () => clock }); const channel = f.service.create({ name: '微信' }, admin);
  const pending = await f.service.startLogin(channel.id, admin); clock += 5 * 60_000 + 1;
  const expired = await f.service.loginStatus(channel.id, pending.login.id, admin); assert.equal(expired.login.status, 'expired');
  assert.equal(expired.channel.status, 'login_required');
  const next = await f.service.startLogin(channel.id, admin); await f.service.loginStatus(channel.id, next.login.id, admin);
  f.mock.pollError = Object.assign(new Error('SECRET-TOKEN-AND-CONTEXT'), { authExpired: true, code: -14 }); f.service.start();
  await until(() => f.service.get(channel.id).status === 'login_required');
  assert.equal(f.store.db.prepare('SELECT auth_token FROM im_channels WHERE id=?').get(channel.id).auth_token, null);
  assert.ok(!JSON.stringify(f.service.list()).includes('SECRET'));
});

test('outbox retries use a durable stable client id and stop when the binding is revoked', async (t) => {
  const calls = []; const f = await fixture(t, { onMessage: async (value) => { calls.push(value); } });
  const { channel, token } = await f.connect(); f.service.bind('group-a', [channel.id], admin); f.service.start();
  f.mock.push(token, [rawMessage('context')]); await until(() => calls.length);
  f.mock.sendFailures = 1; f.service.publish('group-a', { text: '需要重试', messageId: 'retry-answer' });
  await until(() => f.mock.sent.length === 1);
  const outbox = f.store.db.prepare('SELECT * FROM im_channel_outbox').get(); assert.equal(outbox.attempts, 2); assert.equal(f.mock.sent[0].clientId, outbox.id);
  f.mock.pauseSends = true; f.service.publish('group-a', { text: '不应泄漏', messageId: 'cancel-answer' });
  await until(() => f.mock.pendingSends.length === 1); f.service.bind('group-a', [], admin);
  await until(() => f.store.db.prepare("SELECT status FROM im_channel_outbox WHERE dedupe_key='cancel-answer'").get().status === 'cancelled');
  assert.equal(f.mock.sent.length, 1);
});

test('a confirmed bot account cannot be connected twice, including when the original channel is paused', async (t) => {
  const f = await fixture(t); const first = await f.connect('原微信'); f.service.bind('group-a', [first.channel.id], admin);
  f.service.update(first.channel.id, { enabled: false }, admin);
  const other = f.service.create({ name: '重复微信' }, admin); const login = await f.service.startLogin(other.id, admin);
  await assert.rejects(f.service.loginStatus(other.id, login.login.id, admin), { status: 409 });
  assert.equal(f.service.get(other.id).connected, false);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM im_channels WHERE auth_token IS NOT NULL').get().n, 1);
  assert.equal(f.store.db.prepare('SELECT auth_token FROM im_channels WHERE id=?').get(first.channel.id).auth_token, first.token);
});

test('large Unicode replies are delivered in order and survive a first-part retry', async (t) => {
  let received = false; const f = await fixture(t, { onMessage: async () => { received = true; } });
  const { channel, token } = await f.connect(); f.service.bind('group-a', [channel.id], admin); f.service.start();
  f.mock.push(token, [rawMessage('ready')]); await until(() => received);
  const reply = '结果😀'.repeat(2600); f.mock.sendFailures = 1;
  const result = f.service.publish('group-a', { text: reply, messageId: 'large-result' }); assert.ok(result.queued > 1);
  await until(() => f.mock.sent.length === result.queued);
  assert.equal(f.mock.sent.map((value) => value.text).join(''), reply);
  assert.ok(f.mock.sent.every((value) => value.text.length <= 4000));
  assert.equal(new Set(f.mock.sent.map((value) => value.clientId)).size, result.queued);
  assert.deepEqual(f.service.publish('group-a', { text: reply, messageId: 'large-result' }), { queued: 0 });
});

test('messages from before the binding and in-flight polls from the previous binding are not replayed', async (t) => {
  const seen = []; const f = await fixture(t, { onMessage: async ({ message }) => { seen.push(message.text); } });
  const { channel, token } = await f.connect(); f.service.bind('group-a', [channel.id], admin); f.service.start();
  f.mock.push(token, [rawMessage('old', 'old-history', { create_time_ms: Date.now() - 60_000 })]);
  await until(() => f.store.db.prepare('SELECT cursor FROM im_channels WHERE id=?').get(channel.id).cursor === 'cursor-private');
  assert.deepEqual(seen, []);
  await until(() => f.mock.waiters.has(token));
  f.service.bind('group-a', [], admin); f.service.bind('group-b', [channel.id], admin);
  f.mock.push(token, [rawMessage('new', 'new-group')], 'new-group-cursor');
  await until(() => seen.length === 1); assert.deepEqual(seen, ['new-group']);
});

test('task failures send a safe origin-only notice; cancellation never sends one', async (t) => {
  let cancel = false;
  const f = await fixture(t, { onMessage: async () => { if (cancel) throw new DOMException('private-cancel-detail', 'AbortError'); throw new Error('SECRET-PROVIDER-ERROR'); } });
  const { channel, token } = await f.connect(); f.service.bind('group-a', [channel.id], admin); f.service.start();
  f.mock.push(token, [rawMessage('failure')]); await until(() => f.mock.sent.length === 1);
  assert.equal(f.mock.sent[0].toUserId, scanner); assert.ok(f.mock.sent[0].text.includes('暂时未能完成'));
  assert.ok(!f.mock.sent[0].text.includes('SECRET')); assert.equal(f.store.db.prepare("SELECT status FROM im_channel_inbox WHERE message_id='failure'").get().status, 'failed');
  cancel = true; f.mock.push(token, [rawMessage('cancelled')], 'cancel-cursor');
  await until(() => f.store.db.prepare("SELECT status FROM im_channel_inbox WHERE message_id='cancelled'").get()?.status === 'cancelled');
  assert.equal(f.mock.sent.length, 1); assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM im_channel_outbox').get().n, 1);
});

test('QR confirmation continues in the background without a status request from the page', async (t) => {
  const f = await fixture(t, { loginPollIntervalMs: 10 }); f.mock.status = 'wait'; f.service.start();
  const channel = f.service.create({ name: '关闭弹窗后扫码' }, admin); const { login } = await f.service.startLogin(channel.id, admin);
  assert.equal(f.store.db.prepare('SELECT created_by FROM im_channel_logins WHERE id=?').get(login.id).created_by, admin.id);
  await until(() => f.mock.statusCalls.length === 1);
  assert.equal(f.service.get(channel.id).status, 'connecting'); f.mock.status = 'confirmed';
  await until(() => f.service.get(channel.id).connected);
  assert.equal(f.store.db.prepare('SELECT status FROM im_channel_logins WHERE id=?').get(login.id).status, 'confirmed');
  assert.ok(f.mock.statusCalls.length >= 2);
});

test('pending QR logins resume after restart and legacy login rows use their current channel owner', async (t) => {
  const f = await fixture(t); const channel = f.service.create({ name: '重启后继续登录' }, admin);
  const { login } = await f.service.startLogin(channel.id, admin); await f.service.close();
  // Recreate the pre-migration schema using this isolated test database.
  for (const name of ['created_by', 'next_poll_at', 'poll_failures']) f.store.db.exec(`ALTER TABLE im_channel_logins DROP COLUMN ${name}`);
  await f.restart({ loginPollIntervalMs: 10 }); f.service.start();
  await until(() => f.service.get(channel.id).connected);
  assert.equal(f.store.db.prepare('SELECT status,created_by FROM im_channel_logins WHERE id=?').get(login.id).created_by, null);
  assert.equal(f.mock.statusCalls.length, 1);
});

test('unattended expired QR logins stop polling and return to login-required', async (t) => {
  let clock = Date.now(); const f = await fixture(t, { now: () => clock, loginPollIntervalMs: 10 }); f.mock.status = 'wait';
  const channel = f.service.create({ name: '过期二维码' }, admin); const { login } = await f.service.startLogin(channel.id, admin);
  f.service.start(); await until(() => f.mock.statusCalls.length === 1); clock += 5 * 60_000 + 1;
  await until(() => f.service.get(channel.id).status === 'login_required');
  assert.equal(f.store.db.prepare('SELECT status FROM im_channel_logins WHERE id=?').get(login.id).status, 'expired');
  const calls = f.mock.statusCalls.length; await new Promise((resolve) => setTimeout(resolve, 30)); assert.equal(f.mock.statusCalls.length, calls);
});

test('pairing-code challenges pause background polling and preserve the administrator code submission', async (t) => {
  const f = await fixture(t, { loginPollIntervalMs: 10 }); f.mock.status = 'need_verifycode'; f.service.start();
  const channel = f.service.create({ name: '需要配对码' }, admin); const { login } = await f.service.startLogin(channel.id, admin);
  await until(() => f.store.db.prepare('SELECT status FROM im_channel_logins WHERE id=?').get(login.id).status === 'need_verifycode');
  const pending = await f.service.loginStatus(channel.id, login.id, admin); assert.equal(pending.login.status, 'need_verifycode');
  await new Promise((resolve) => setTimeout(resolve, 30)); assert.equal(f.mock.statusCalls.length, 1);
  f.mock.status = 'confirmed'; const result = await f.service.loginStatus(channel.id, login.id, admin, '123456');
  assert.equal(result.channel.connected, true); assert.equal(f.mock.statusCalls.at(-1).verifyCode, '123456');
});

test('blocked pairing-code verification stops background polling and requires a fresh QR', async (t) => {
  const f = await fixture(t, { loginPollIntervalMs: 10 }); f.mock.status = 'verify_code_blocked'; f.service.start();
  const channel = f.service.create({ name: '验证被阻止' }, admin); const { login } = await f.service.startLogin(channel.id, admin);
  await until(() => f.service.get(channel.id).status === 'login_required');
  assert.equal(f.store.db.prepare('SELECT status FROM im_channel_logins WHERE id=?').get(login.id).status, 'verify_code_blocked');
  await new Promise((resolve) => setTimeout(resolve, 30)); assert.equal(f.mock.statusCalls.length, 1);
  assert.throws(() => f.service.qrContent(channel.id, login.id, admin), { status: 410 });
});

test('revoking a QR channel owner prevents an unattended login request', async (t) => {
  const f = await fixture(t, { loginPollIntervalMs: 10 }); const channel = f.service.create({ name: '权限已撤销' }, admin);
  const { login } = await f.service.startLogin(channel.id, admin); f.store.db.prepare('UPDATE users SET disabled=1 WHERE id=?').run(admin.id);
  f.service.start(); await until(() => f.store.db.prepare('SELECT status FROM im_channels WHERE id=?').get(channel.id).status === 'login_required');
  assert.equal(f.mock.statusCalls.length, 0); assert.equal(f.store.db.prepare('SELECT status FROM im_channel_logins WHERE id=?').get(login.id).status, 'expired');
});

test('the initiating administrator is rechecked after an in-flight QR confirmation', async (t) => {
  const f = await fixture(t, { loginPollIntervalMs: 10 }); const operator = { id: 'operator-admin', role: 'admin' };
  f.store.db.prepare('INSERT INTO users(id,username,display_name,role,password_hash,created_at) VALUES (?,?,?,?,?,?)')
    .run(operator.id, operator.id, '扫码管理员', 'admin', 'not-a-real-password-hash', new Date().toISOString());
  const channel = f.service.create({ name: '发起人权限变更' }, admin); const { login } = await f.service.startLogin(channel.id, operator);
  f.mock.pauseStatuses = true; f.service.start(); await until(() => f.mock.pendingStatuses.length === 1);
  f.store.db.prepare("UPDATE users SET role='member' WHERE id=?").run(operator.id); f.mock.pendingStatuses[0].finish();
  await until(() => f.service.get(channel.id).status === 'login_required');
  assert.equal(f.store.db.prepare('SELECT auth_token FROM im_channels WHERE id=?').get(channel.id).auth_token, null);
  assert.equal(f.store.db.prepare('SELECT status FROM im_channel_logins WHERE id=?').get(login.id).status, 'expired');
});

test('background QR status failures retry with backoff and never expose upstream details', async (t) => {
  const f = await fixture(t, { loginPollIntervalMs: 10, retryMs: 100 }); f.mock.statusFailures = 1; f.service.start();
  const channel = f.service.create({ name: '临时网络失败' }, admin); const { login } = await f.service.startLogin(channel.id, admin);
  await until(() => f.store.db.prepare('SELECT poll_failures FROM im_channel_logins WHERE id=?').get(login.id).poll_failures === 1);
  assert.equal(f.service.get(channel.id).status, 'connecting'); assert.ok(f.service.get(channel.id).lastError.includes('正在重试'));
  assert.ok(!JSON.stringify(f.service.list()).includes('SECRET'));
  await new Promise((resolve) => setTimeout(resolve, 30)); assert.equal(f.mock.statusCalls.length, 1);
  await until(() => f.service.get(channel.id).connected); assert.equal(f.mock.statusCalls.length, 2); assert.equal(f.service.get(channel.id).lastError, null);
});

test('page and background QR checks share one request lock, and shutdown cancels the tracked poll', async (t) => {
  const f = await fixture(t, { loginPollIntervalMs: 10 }); f.mock.pauseStatuses = true; f.mock.status = 'wait';
  const channel = f.service.create({ name: '无重叠扫码请求' }, admin); const { login } = await f.service.startLogin(channel.id, admin);
  f.service.start(); await until(() => f.mock.pendingStatuses.length === 1);
  const pending = await f.service.loginStatus(channel.id, login.id, admin); assert.equal(pending.login.status, 'wait');
  await new Promise((resolve) => setTimeout(resolve, 30)); assert.equal(f.mock.statusCalls.length, 1);
  await f.service.close(); assert.equal(f.service.loginRequests.size, 0); assert.equal(f.service.work.size, 0);
});
