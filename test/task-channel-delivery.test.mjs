import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Store } from '../lib/store.mjs';
import { ChannelHub } from '../lib/channel-hub.mjs';
import { TaskDeliveryService } from '../lib/task-delivery.mjs';

const admin = { id: 'task-channel-admin', role: 'admin', displayName: '任务管理员' };
const message = (id = 'task:fixture-run') => ({ messageId: id, authorName: 'Pi · 定时任务', text: '任务执行成功。' });

function fixture(t, options = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'pi-task-channels-'));
  const store = new Store(directory, directory), sent = { weixin: [], wecom: [] };
  const at = new Date().toISOString();
  store.db.prepare('INSERT INTO users(id,username,display_name,role,password_hash,created_at) VALUES (?,?,?,?,?,?)')
    .run(admin.id, admin.id, admin.displayName, 'admin', 'fixture-not-a-password-hash', at);
  for (const id of ['group-a', 'group-b']) {
    const meta = { id, title: id, ownerId: admin.id, createdAt: at };
    store.sessions.push(meta);
    store.db.prepare('INSERT INTO session_meta(id,data) VALUES (?,?)').run(id, JSON.stringify(meta));
    store.db.prepare('INSERT INTO group_members VALUES (?,?,?,?)').run(id, admin.id, admin.id, at);
  }
  const hub = new ChannelHub(store, {
    clientFactory: () => ({ async sendText(value) { sent.weixin.push(value); } }),
    wecom: { clientFactory: () => assert.fail('Network clients must not be started by task-delivery tests'), ...options.wecom },
  });
  t.after(async () => {
    await hub.close(); store.close();
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.ok(path.basename(directory).startsWith('pi-task-channels-'));
    rmSync(directory, { recursive: true, force: true });
  });
  function weixin(id = 'wx-original', { context = 'fixture-context', sessionId = 'group-a' } = {}) {
    store.db.prepare(`INSERT INTO im_channels(id,name,status,owner_id,account_id,scanner_id,auth_token,
      session_id,bound_by,binding_epoch,context_token,created_at,updated_at)
      VALUES (?,?,'connected',?,?,?,?,?,?,1,?,?,?)`)
      .run(id, id, admin.id, `bot-${id}`, `scanner-${id}`, `token-${id}`, sessionId, admin.id, context, at, at);
    return id;
  }
  function wecom(id = 'wecom-original', { sessionId = 'group-a' } = {}) {
    store.db.prepare(`INSERT INTO wecom_channels(id,name,owner_id,bot_id,secret,status,session_id,
      bound_by,binding_epoch,target_id,target_type,created_at,updated_at)
      VALUES (?,?,?,?,?,'connected',?,?,1,?,'group',?,?)`)
      .run(id, id, admin.id, `bot-${id}`, `secret-${id}`, sessionId, admin.id, `remote-${id}`, at, at);
    hub.wecom.clients.set(id, { client: { async sendText(value) { sent.wecom.push(value); }, close() {} } });
    return id;
  }
  async function sendOne(type, id) {
    const service = hub[type], table = type === 'weixin' ? 'im_channels' : 'wecom_channels';
    service._send(store.db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id));
    await Promise.allSettled([...service.work]);
  }
  return { store, hub, sent, weixin, wecom, sendOne };
}

test('task publication snapshots both transports and never adds a later channel or replacement result', async t => {
  const { store, hub, weixin, wecom } = fixture(t);
  weixin(); wecom();
  assert.deepEqual(hub.publishTask('group-a', message()), { queued: 2, sent: 0, failed: 0, pending: 2 });
  weixin('wx-added-later'); wecom('wecom-added-later');
  hub.publishTask('group-a', { ...message(), text: 'This replacement must not be sent.' });
  hub.retryDelivery(message().messageId);
  for (const table of ['im_channel_outbox', 'wecom_outbox']) {
    const rows = store.db.prepare(`SELECT * FROM ${table}`).all();
    assert.equal(rows.length, 1);
    assert.match(rows[0].channel_id, /original$/);
    assert.match(rows[0].text, /任务执行成功/);
    assert.ok(!rows[0].text.includes('replacement'));
  }
  assert.throws(() => hub.publishTask('group-b', message()), { status: 409 });
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM task_channel_batches').get().n, 1);
});

test('rebinding a channel invalidates its old task epoch rather than notifying the new binding', async t => {
  const { store, hub, weixin, wecom, sent, sendOne } = fixture(t);
  const wx = weixin(), enterprise = wecom();
  hub.publishTask('group-a', message());
  hub.weixin.bind('group-a', [], admin);
  hub.weixin.bind('group-a', [wx], admin);
  hub.wecom.bind('group-a', [], admin);
  hub.wecom.bind('group-a', [enterprise], admin);
  const state = hub.retryDelivery(message().messageId);
  assert.deepEqual(state, { queued: 2, sent: 0, failed: 2, pending: 0 });
  assert.equal(store.db.prepare('SELECT binding_epoch FROM im_channels WHERE id=?').get(wx).binding_epoch, 3);
  for (const table of ['im_channel_outbox', 'wecom_outbox']) {
    const rows = store.db.prepare(`SELECT * FROM ${table}`).all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].binding_epoch, 1);
    assert.equal(rows[0].status, 'cancelled');
  }
  await sendOne('weixin', wx); await sendOne('wecom', enterprise);
  assert.deepEqual(sent, { weixin: [], wecom: [] });
});

test('retry resets only failed chunks and sends no duplicate for already sent chunks', async t => {
  const { store, hub, weixin, wecom, sent, sendOne } = fixture(t);
  const wx = weixin(), enterprise = wecom();
  hub.publishTask('group-a', { ...message(), text: 'x'.repeat(4500) });
  const sentIds = new Map();
  for (const table of ['im_channel_outbox', 'wecom_outbox']) {
    const rows = store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
    assert.ok(rows.length > 1);
    sentIds.set(table, rows[0].id);
    store.db.prepare(`UPDATE ${table} SET status='failed',attempts=5,next_attempt_at=9999999999999,last_error='fixture failure'`).run();
    store.db.prepare(`UPDATE ${table} SET status='sent',finished_at=? WHERE id=?`).run(new Date().toISOString(), rows[0].id);
  }
  const reset = hub.retryDelivery(message().messageId);
  assert.equal(reset.failed, 0);
  assert.equal(reset.sent, 2);
  for (const [table, sentId] of sentIds) {
    assert.equal(store.db.prepare(`SELECT status FROM ${table} WHERE id=?`).get(sentId).status, 'sent');
    const pending = store.db.prepare(`SELECT * FROM ${table} WHERE status='pending'`).all();
    assert.ok(pending.length);
    for (const row of pending) { assert.equal(row.attempts, 0); assert.equal(row.next_attempt_at, 0); assert.equal(row.last_error, null); }
  }
  for (let remaining = 0; remaining < 4; remaining++) {
    await sendOne('weixin', wx); await sendOne('wecom', enterprise);
  }
  assert.equal(sent.weixin.length, 2);
  assert.equal(sent.wecom.length, 1);
  assert.ok(!sent.weixin.some(entry => entry.clientId === sentIds.get('im_channel_outbox')));
  assert.ok(!sent.wecom.some(entry => entry.clientId === sentIds.get('wecom_outbox')));
  assert.deepEqual(hub.deliveryStatus(message().messageId), { queued: 5, sent: 5, failed: 0, pending: 0 });
});

test('personal Weixin keeps a task result pending until its confirmed owner supplies a reply context', async t => {
  const { store, hub, weixin, sent, sendOne } = fixture(t);
  const id = weixin('wx-no-context', { context: null });
  assert.deepEqual(hub.weixin.publish('group-a', { text: 'Ordinary chat is not queued before first contact.' }), { queued: 0 });
  assert.deepEqual(hub.publishTask('group-a', message()), { queued: 1, sent: 0, failed: 0, pending: 1 });
  await sendOne('weixin', id);
  assert.equal(sent.weixin.length, 0);
  const pending = store.db.prepare('SELECT * FROM im_channel_outbox').get();
  assert.equal(pending.status, 'pending'); assert.equal(pending.attempts, 0);
  store.db.prepare('UPDATE im_channels SET context_token=? WHERE id=?').run('context-from-confirmed-owner', id);
  await sendOne('weixin', id);
  assert.equal(sent.weixin.length, 1);
  assert.equal(sent.weixin[0].clientId, pending.id);
  assert.equal(sent.weixin[0].contextToken, 'context-from-confirmed-owner');
  assert.deepEqual(hub.deliveryStatus(message().messageId), { queued: 1, sent: 1, failed: 0, pending: 0 });
});

test('a lost binding administrator cannot retry task notifications', async t => {
  const { store, hub, weixin, wecom, sent, sendOne } = fixture(t);
  const wx = weixin(), enterprise = wecom(); hub.publishTask('group-a', message());
  for (const table of ['im_channel_outbox', 'wecom_outbox']) store.db.prepare(`UPDATE ${table} SET status='failed',attempts=5`).run();
  store.db.prepare('DELETE FROM group_members WHERE session_id=? AND user_id=?').run('group-a', admin.id);
  assert.equal(hub.retryDelivery(message().messageId).failed, 2);
  await sendOne('weixin', wx); await sendOne('wecom', enterprise);
  assert.deepEqual(sent, { weixin: [], wecom: [] });
  for (const table of ['im_channel_outbox', 'wecom_outbox']) assert.equal(store.db.prepare(`SELECT status FROM ${table}`).get().status, 'failed');
});

test('atomic recipient capture survives a failure before channel enqueue and excludes channels added before retry', async t => {
  const { store, hub, weixin } = fixture(t); weixin();
  let unavailable = true;
  const service = new TaskDeliveryService(store, {
    preparePublish: (id, body) => hub.prepareTask(id, body),
    publish: (id, body) => { if (unavailable) throw new Error('Simulated interruption before enqueue'); return hub.publishTask(id, body); },
  });
  const input = { schedule: { name: 'Captured task', targetSessionId: 'group-a' }, run: { id: 'captured-run' }, result: 'Saved final output' };
  assert.equal((await service.deliver(input)).status, 'failed');
  assert.equal(service.history('group-a').length, 1);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM task_channel_batches').get().n, 1);
  weixin('wx-after-interruption'); unavailable = false;
  assert.equal((await service.retry(input)).status, 'delivered');
  assert.deepEqual(store.db.prepare('SELECT channel_id FROM im_channel_outbox').all().map(row => row.channel_id), ['wx-original']);
});

test('a failed recipient snapshot rolls back the group post and long final messages fit enterprise transport limits', async t => {
  const { store, hub, wecom } = fixture(t); wecom();
  let unavailable = true;
  const service = new TaskDeliveryService(store, {
    preparePublish: (id, body) => { hub.prepareTask(id, body); if (unavailable) throw new Error('Simulated commit failure'); },
    publish: (id, body) => hub.publishTask(id, body),
  });
  const input = { schedule: { name: 'Long report', targetSessionId: 'group-a' }, run: { id: 'long-run' }, result: 'x'.repeat(100000) };
  assert.equal((await service.deliver(input)).status, 'failed');
  assert.equal(service.history('group-a').length, 0);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM task_channel_batches').get().n, 0);
  unavailable = false; await service.retry(input);
  assert.ok(service.history('group-a')[0].content.length < 100000);
  assert.ok(hub.deliveryStatus('task:long-run').pending > 0);
});

test('Webhook-only task recipients work without an external conversation or a WebSocket connection', async t => {
  const delivered = [];
  const { hub, sendOne, sent } = fixture(t, { wecom: {
    webhookSender: async value => { delivered.push(value); }, webhookIntervalMs: 0,
  } });
  const channel = hub.create({ type: 'wecom', name: '定时报告群', connectionMode: 'webhook',
    replyMode: 'webhook', webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=fixture-task-hook-a' }, admin);
  hub.bind('group-a', [channel.id], admin);
  const service = new TaskDeliveryService(hub.store, {
    preparePublish: (id, body) => hub.prepareTask(id, body),
    publish: (id, body) => hub.publishTask(id, body),
  });
  const input = { schedule: { name: 'Webhook 定时报告', targetSessionId: 'group-a' }, run: { id: 'webhook-run' }, result: '本次业务检查正常。' };
  await service.deliver(input);
  assert.equal(hub.deliveryStatus('task:webhook-run').pending, 1);
  await sendOne('wecom', channel.id);
  assert.equal(delivered.length, 1);
  assert.match(delivered[0].text, /本次业务检查正常/);
  assert.deepEqual(sent, { weixin: [], wecom: [] });
  assert.deepEqual(hub.deliveryStatus('task:webhook-run'), { queued: 1, sent: 1, failed: 0, pending: 0 });
  await service.retry(input); await sendOne('wecom', channel.id);
  assert.equal(delivered.length, 1, 'retry never repeats an acknowledged Webhook result');
});

test('changing a Webhook recipient invalidates captured results before they can be retried', async t => {
  const delivered = [];
  const { hub, sendOne } = fixture(t, { wecom: {
    webhookSender: async value => { delivered.push(value); }, webhookIntervalMs: 0,
  } });
  const channel = hub.create({ type: 'wecom', name: '报告群', connectionMode: 'webhook',
    webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=fixture-old-task-hook' }, admin);
  hub.bind('group-a', [channel.id], admin);
  hub.publishTask('group-a', message('task:old-webhook-result'));
  hub.update(channel.id, { webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=fixture-new-task-hook' }, admin);
  assert.equal(hub.retryDelivery('task:old-webhook-result').failed, 1);
  await sendOne('wecom', channel.id);
  assert.equal(delivered.length, 0, 'old results cannot be sent to a replacement group');
  hub.publishTask('group-a', message('task:new-webhook-result'));
  await sendOne('wecom', channel.id);
  assert.equal(delivered.length, 1);
  assert.match(delivered[0].webhookUrl, /fixture-new-task-hook$/);
});
