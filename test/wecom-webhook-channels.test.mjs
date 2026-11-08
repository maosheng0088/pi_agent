import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { WecomService } from '../lib/wecom-channels.mjs';

const admin = { id: 'webhook-admin', role: 'admin', displayName: '管理员' };
const employee = { id: 'webhook-employee', role: 'member', displayName: '员工' };
const webhookUrl = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=fixture-original-key';
const replacementUrl = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=fixture-replacement-key';
const incoming = (text, overrides = {}) => ({ messageId: text, text, userId: 'external-user', targetId: 'external-group', chatType: 'group', botId: 'fixture-bot', timestamp: Date.now() + 1000, ...overrides });
async function until(check) {
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Expected webhook asynchronous state was not reached');
}
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-web-wecom-webhook-'));
  const store = new Store(directory, directory), sent = [], attempts = [], clients = [], audits = [];
  for (const actor of [admin, employee]) store.db.prepare('INSERT INTO users(id,username,display_name,role,password_hash,created_at) VALUES (?,?,?,?,?,?)').run(actor.id, actor.id, actor.displayName, actor.role, 'fixture-hash', new Date().toISOString());
  for (const id of ['group-a', 'group-b']) {
    const meta = { id, title: id, ownerId: admin.id }; store.sessions.push(meta);
    store.db.prepare('INSERT INTO session_meta(id,data) VALUES (?,?)').run(id, JSON.stringify(meta));
    store.db.prepare('INSERT INTO group_members(session_id,user_id,added_by,added_at) VALUES (?,?,?,?)').run(id, admin.id, admin.id, new Date().toISOString());
  }
  if (options.legacy) {
    store.db.exec(`CREATE TABLE wecom_channels (id TEXT PRIMARY KEY,name TEXT NOT NULL,owner_id TEXT NOT NULL,bot_id TEXT NOT NULL UNIQUE,secret TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'disconnected',session_id TEXT,bound_by TEXT,binding_epoch INTEGER NOT NULL DEFAULT 0,bound_at INTEGER NOT NULL DEFAULT 0,target_id TEXT,target_type TEXT,last_error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)`);
    store.db.prepare('INSERT INTO wecom_channels(id,name,owner_id,bot_id,secret,session_id,bound_by,target_id,target_type,binding_epoch,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run('legacy-channel', '旧企微', admin.id, 'fixture-bot', 'fixture-original-secret', 'group-a', admin.id, 'external-group', 'group', 5, '2026-10-01', '2026-10-01');
  }
  const mocks = { failures: 0, paused: false };
  const clientFactory = callbacks => {
    const client = { callbacks, sent: [], start() { callbacks.onState({ status: 'connected' }); }, close() {}, async sendText(message) { client.sent.push(message); } };
    clients.push(client); return client;
  };
  const webhookSender = async message => {
    attempts.push(message);
    if (mocks.failures-- > 0) throw new Error('private webhook sender ' + message.webhookUrl);
    if (mocks.paused) await new Promise((resolve, reject) => message.signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true }));
    sent.push(message);
  };
  const configuration = { clientFactory, webhookSender, webhookIntervalMs: 0, pollIntervalMs: 10, retryMs: 10, audit: (...args) => audits.push(args), ...options };
  let service = new WecomService(store, configuration);
  t.after(async () => { await service.close(); store.close(); assert.equal(path.dirname(directory), os.tmpdir()); assert.ok(path.basename(directory).startsWith('pi-web-wecom-webhook-')); await fs.rm(directory, { recursive: true, force: true }); });
  return { store, clients, sent, attempts, mocks, audits, get service() { return service; },
    async restart() { await service.close(); service = new WecomService(store, configuration); },
    standalone(groupId = 'group-a', title = 'Webhook 结果推送') { const channel = service.create({ name: title, connectionMode: 'webhook', webhookUrl }, admin); service.bind(groupId, [channel.id], admin); return service.get(channel.id); },
    websocket() { service.start(); const channel = service.create({ name: '长连接智能体', botId: 'fixture-bot', secret: 'fixture-original-secret' }, admin); clients.at(-1).callbacks.onMessage(incoming('discovery')); service.update(channel.id, { target: { id: 'external-group', chatType: 'group' } }, admin); service.bind('group-a', [channel.id], admin); return service.get(channel.id); },
  };
}

test('Webhook schema migration keeps legacy credentials, binding, target and default reply transport', async t => {
  const f = await fixture(t, { legacy: true });
  const channel = f.service.get('legacy-channel');
  assert.equal(channel.connectionMode, 'websocket'); assert.equal(channel.replyMode, 'websocket'); assert.equal(channel.webhookSet, false);
  assert.equal(channel.sessionId, 'group-a'); assert.deepEqual(channel.target, { id: 'external-group', chatType: 'group' });
  const row = f.store.db.prepare('SELECT secret,binding_epoch FROM wecom_channels WHERE id=?').get(channel.id);
  assert.equal(row.secret, 'fixture-original-secret'); assert.equal(row.binding_epoch, 5);
  await f.restart(); assert.equal(f.service.get(channel.id).replyMode, 'websocket');
});

test('Webhook-only channels require admin, need no Bot credentials, and never create a receiving identity', async t => {
  const f = await fixture(t); f.service.start();
  assert.throws(() => f.service.create({ name: '不允许', connectionMode: 'webhook', webhookUrl }, employee), { status: 403 });
  const unbound = f.service.create({ name: '仅推送', connectionMode: 'webhook', webhookUrl }, admin);
  assert.equal(unbound.status, 'configured'); assert.equal(unbound.connected, false); assert.equal(unbound.canSend, false); assert.equal(unbound.webhookSet, true); assert.equal(unbound.botId, '');
  assert.equal(f.clients.length, 0); f.service.bind('group-a', [unbound.id], admin);
  assert.equal(f.service.get(unbound.id).canSend, true); assert.equal(f.service.get(unbound.id).canReceive, false);
  assert.deepEqual(f.service.conversations(unbound.id, admin), []); assert.deepEqual(f.service.externalMembers('group-a'), []);
  assert.throws(() => f.service.connect(unbound.id, admin), { status: 400 });
  assert.throws(() => f.service.update(unbound.id, { webhookUrl: replacementUrl }, employee), { status: 403 });
  assert.throws(() => f.service.assertActor('group-a', { source: 'wecom', channelId: unbound.id, role: 'member' }), { status: 403 });
  const privateBot = f.store.db.prepare('SELECT bot_id FROM wecom_channels WHERE id=?').get(unbound.id).bot_id;
  f.service._receive(unbound.id, incoming('forged', { botId: privateBot }));
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM wecom_inbox').get().n, 0);
  f.service.publish('group-a', { text: '完成', messageId: 'send-only' }); await until(() => f.sent.length === 1);
  assert.equal(f.sent[0].webhookUrl, webhookUrl);
  assert.ok(!JSON.stringify([f.service.list(), f.service.forSession('group-a'), f.audits]).includes('fixture-original-key'));
});

test('An existing long connection can reply via Webhook while offline and switches back without duplicate sends', async t => {
  const f = await fixture(t), channel = f.websocket(); const original = f.service.get(channel.id);
  f.service.update(channel.id, { replyMode: 'webhook', webhookUrl }, admin);
  assert.deepEqual(f.service.get(channel.id).target, original.target); assert.equal(f.clients.length, 1);
  f.clients[0].callbacks.onState({ status: 'disconnected' });
  f.service.publish('group-a', { text: 'Webhook 回答', messageId: 'offline-result' }); await until(() => f.sent.length === 1);
  assert.equal(f.clients[0].sent.length, 0);
  f.service.update(channel.id, { replyMode: 'websocket', webhookUrl: '' }, admin);
  assert.equal(f.service.get(channel.id).webhookSet, true); assert.equal(f.clients.length, 1);
  f.clients[0].callbacks.onState({ status: 'connected' });
  f.service.publish('group-a', { text: '长连接回答', messageId: 'online-result' }); await until(() => f.clients[0].sent.length === 1);
  assert.equal(f.sent.length, 1); assert.equal(f.clients[0].sent[0].text, '长连接回答');
});

test('Webhook outbox retries with a stable ID, deduplicates messages, and keeps UTF-8 chunks within the limit', async t => {
  const f = await fixture(t); f.standalone(); f.service.start(); f.mocks.failures = 1;
  const text = '结果中😀'.repeat(1500), message = { text, messageId: 'large-result' };
  const { queued } = f.service.publish('group-a', message); assert.ok(queued > 1);
  assert.equal(f.service.publish('group-a', message).queued, 0);
  await until(() => f.sent.length === queued);
  assert.equal(f.attempts[0].clientId, f.attempts[1].clientId); assert.equal(f.sent.map(item => item.text).join(''), text);
  assert.ok(f.sent.every(item => Buffer.byteLength(item.text) <= 3800));
  assert.equal(f.clients.length, 0);
  assert.ok(!JSON.stringify(f.store.db.prepare('SELECT last_error FROM wecom_outbox').all()).includes('fixture-original-key'));
});

test('Webhook reply changes abort active sends, cancel old work and retain discovery without reconnecting', async t => {
  let entered; const received = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { onMessage: async context => { entered(context); await new Promise(resolve => context.signal.addEventListener('abort', resolve, { once: true })); } });
  const channel = f.websocket(); f.service.update(channel.id, { replyMode: 'webhook', webhookUrl }, admin);
  f.clients[0].callbacks.onMessage(incoming('active-query')); const actor = await received;
  f.mocks.paused = true; f.service.publish('group-a', { text: '旧地址发送中', messageId: 'old-running' }); f.service.publish('group-a', { text: '旧地址待发', messageId: 'old-pending' });
  await until(() => f.attempts.length === 1);
  const oldEpoch = f.store.db.prepare('SELECT binding_epoch FROM wecom_channels WHERE id=?').get(channel.id).binding_epoch;
  f.service.update(channel.id, { webhookUrl: replacementUrl }, admin);
  assert.equal(actor.signal.aborted, true); assert.throws(() => f.service.assertActor('group-a', actor.actor), { status: 403 });
  await until(() => f.service.senders.size === 0);
  assert.equal(f.sent.length, 0); assert.equal(f.clients.length, 1); assert.equal(f.service.conversations(channel.id, admin).length, 1);
  assert.deepEqual(f.service.get(channel.id).target, { id: 'external-group', chatType: 'group' });
  assert.equal(f.store.db.prepare('SELECT binding_epoch FROM wecom_channels WHERE id=?').get(channel.id).binding_epoch, oldEpoch + 1);
  assert.ok(f.store.db.prepare('SELECT status FROM wecom_outbox').all().every(item => item.status === 'cancelled'));
  f.mocks.paused = false; f.service.publish('group-a', { text: '新地址结果', messageId: 'new-result' }); await until(() => f.sent.length === 1);
  assert.equal(f.sent[0].webhookUrl, replacementUrl);
});

test('Pending Webhook delivery survives restart, disabling pauses new messages, and sent items do not replay', async t => {
  const f = await fixture(t), channel = f.standalone();
  f.service.publish('group-a', { text: '尚未启动的结果', messageId: 'persisted-result' });
  await f.restart(); f.service.start(); await until(() => f.sent.length === 1);
  await f.restart(); f.service.start();
  f.service.update(channel.id, { enabled: false }, admin);
  assert.equal(f.service.publish('group-a', { text: '暂停不投递', messageId: 'paused-result' }).queued, 0);
  f.service.update(channel.id, { enabled: true }, admin);
  assert.equal(f.service.get(channel.id).status, 'configured');
  f.service.publish('group-a', { text: '恢复投递', messageId: 'enabled-result' }); await until(() => f.sent.length === 2);
  assert.equal(f.sent.filter(item => item.text === '尚未启动的结果').length, 1);
});

test('One Webhook key shares a persistent rate limit across channels and service restarts', async t => {
  let clock = 10_000;
  const f = await fixture(t, { now: () => clock, webhookIntervalMs: 3100 }); f.standalone('group-a', '第一个'); f.standalone('group-b', '第二个'); f.service.start();
  f.service.publish('group-a', { text: 'a', messageId: 'rate-a' }); f.service.publish('group-b', { text: 'b', messageId: 'rate-b' });
  await until(() => f.sent.length === 1);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM wecom_outbox WHERE status='pending'").get().n, 1);
  await f.restart(); f.service.start(); clock += 3099; f.service._tick();
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(f.sent.length, 1);
  clock++; f.service._tick(); await until(() => f.sent.length === 2);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM wecom_webhook_rate').get().n, 1);
  assert.ok(!JSON.stringify(f.store.db.prepare('SELECT * FROM wecom_webhook_rate').all()).includes('fixture-original-key'));
});

test('Webhook configuration validates immutable modes, retained secrets and group authorization', async t => {
  const f = await fixture(t), channel = f.websocket();
  assert.throws(() => f.service.create({ name: '错误', connectionMode: 'other' }, admin), { status: 400 });
  assert.throws(() => f.service.create({ name: '缺地址', connectionMode: 'webhook' }, admin), { status: 400 });
  assert.throws(() => f.service.update(channel.id, { replyMode: 'webhook' }, admin), { status: 400 });
  assert.throws(() => f.service.update(channel.id, { connectionMode: 'webhook' }, admin), { status: 400 });
  f.service.update(channel.id, { replyMode: 'webhook', webhookUrl }, admin);
  assert.throws(() => f.service.update(channel.id, { webhookUrl: null }, admin), { status: 400 });
  f.service.update(channel.id, { webhookUrl: '  ' }, admin); assert.equal(f.service.get(channel.id).webhookSet, true);
  f.service.update(channel.id, { replyMode: 'websocket', webhookUrl: null }, admin); assert.equal(f.service.get(channel.id).webhookSet, false);
  f.service.update(channel.id, { replyMode: 'webhook', webhookUrl }, admin);
  f.store.db.prepare('DELETE FROM group_members WHERE session_id=? AND user_id=?').run('group-a', admin.id);
  f.service.invalidateUser(admin.id);
  assert.equal(f.service.get(channel.id).canSend, false); assert.equal(f.service.publish('group-a', { text: '无权限不投递' }).queued, 0);
});
