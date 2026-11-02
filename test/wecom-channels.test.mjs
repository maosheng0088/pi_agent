import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { WecomService } from '../lib/wecom-channels.mjs';

const admin = { id: 'admin-wecom', role: 'admin', displayName: '管理员' };
const member = { id: 'member-wecom', role: 'member', displayName: '员工' };
const message = (messageId, options = {}) => ({ messageId, userId: 'remote-user-0001', targetId: 'remote-group-001', chatType: 'group', botId: 'bot-001', timestamp: Date.now() + 1000, text: messageId, ...options });
async function until(check) {
  const end = Date.now() + 2500;
  while (Date.now() < end) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Expected asynchronous state was not reached');
}
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-web-wecom-')), store = new Store(directory, directory);
  for (const user of [admin, member]) store.db.prepare('INSERT INTO users(id,username,display_name,role,password_hash,created_at) VALUES (?,?,?,?,?,?)').run(user.id, user.id, user.displayName, user.role, 'test-password-hash', new Date().toISOString());
  for (const id of ['group-a', 'group-b']) {
    const meta = { id, title: id, ownerId: admin.id, createdAt: new Date().toISOString() }; store.sessions.push(meta);
    store.db.prepare('INSERT INTO session_meta(id,data) VALUES (?,?)').run(id, JSON.stringify(meta));
    store.db.prepare('INSERT INTO group_members(session_id,user_id,added_by,added_at) VALUES (?,?,?,?)').run(id, admin.id, admin.id, new Date().toISOString());
  }
  const mock = { clients: [], sent: [], attempts: [], failures: 0, pause: false, active: 0, peak: 0 };
  mock.clientFactory = options => {
    const entry = { options, closed: false, start() { options.onState({ status: 'connected' }); }, close() { entry.closed = true; },
      async sendText(value) {
        mock.attempts.push(value.clientId); mock.active++; mock.peak = Math.max(mock.peak, mock.active);
        try {
          if (mock.failures-- > 0) throw new Error('PRIVATE-UPSTREAM-DETAILS');
          if (mock.pause) await new Promise((resolve, reject) => value.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
          mock.sent.push(value);
        } finally { mock.active--; }
      } };
    mock.clients.push(entry); return entry;
  };
  let service = new WecomService(store, { clientFactory: mock.clientFactory, pollIntervalMs: 10, retryMs: 10, ...options });
  t.after(async () => { await service.close(); store.close(); assert.equal(path.dirname(directory), os.tmpdir()); assert.ok(path.basename(directory).startsWith('pi-web-wecom-')); await fs.rm(directory, { recursive: true, force: true }); });
  return { store, mock, get service() { return service; }, push(value, index = mock.clients.length - 1) { mock.clients[index].options.onMessage(value); },
    async restart(options = {}) { await service.close(); service = new WecomService(store, { clientFactory: mock.clientFactory, pollIntervalMs: 10, retryMs: 10, ...options }); return service; },
    setup() {
      service.start(); const channel = service.create({ name: '企业微信', type: 'wecom', botId: 'bot-001', secret: 'PRIVATE-SECRET' }, admin);
      const entry = mock.clients.at(-1); entry.options.onMessage(message('discovery'));
      service.update(channel.id, { target: { id: 'remote-group-001', chatType: 'group' } }, admin); service.bind('group-a', [channel.id], admin); return channel;
    } };
}

test('Wecom management is admin-only, bot IDs are unique while paused, credentials stay private', async t => {
  const f = await fixture(t);
  assert.throws(() => f.service.create({ name: '企微', botId: 'b', secret: 's' }, member), { status: 403 });
  assert.throws(() => f.service.create({ name: '企微', botId: 'b', secret: ' ' }, admin), { status: 400 });
  const channel = f.setup(); f.service.update(channel.id, { enabled: false }, admin);
  assert.throws(() => f.service.create({ name: '重复', botId: 'bot-001', secret: 'another' }, admin), { status: 409 });
  assert.throws(() => f.service.conversations(channel.id, member), { status: 403 });
  assert.throws(() => f.service.connect(channel.id, member), { status: 403 });
  assert.throws(() => f.service.remove(channel.id, member), { status: 403 });
  assert.ok(!JSON.stringify([f.service.list(), f.service.forSession('group-a'), f.service.conversations(channel.id, admin)]).includes('PRIVATE-SECRET'));
  assert.equal(f.service.get(channel.id).secretSet, true);
});

test('Discovery never grants access: explicit observed conversation and Web binding are both required', async t => {
  const calls = [], f = await fixture(t, { onMessage: async value => calls.push(value) });
  f.service.start(); const channel = f.service.create({ name: '企微', botId: 'bot-001', secret: 'PRIVATE-SECRET' }, admin);
  assert.throws(() => f.service.update(channel.id, { target: { id: 'unknown', chatType: 'group' } }, admin), { status: 400 });
  f.push(message('discovery', { text: 'PRIVATE-DISCOVERY-BODY' }));
  assert.equal(f.service.get(channel.id).target, null); assert.equal(f.service.get(channel.id).canReceive, false);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM wecom_inbox').get().n, 0);
  assert.equal(f.service.conversations(channel.id, admin).length, 1);
  assert.ok(!JSON.stringify(f.service.conversations(channel.id, admin)).includes('PRIVATE-DISCOVERY-BODY'));
  f.service.update(channel.id, { target: { id: 'remote-group-001', chatType: 'group' } }, admin);
  f.push(message('unbound')); assert.equal(calls.length, 0); assert.deepEqual(f.service.publish('group-a', { text: 'no' }), { queued: 0 });
  f.service.bind('group-a', [channel.id], admin);
  f.push(message('wrong-target', { targetId: 'another-group' }));
  f.push(message('wrong-bot', { botId: 'bot-other' }));
  f.push(message('old', { timestamp: 1 }));
  f.push(message('one')); f.push(message('one'));
  await until(() => calls.length === 1);
  assert.equal(calls[0].message.text, 'one'); assert.equal(f.service.assertActor('group-a', calls[0].actor), true);
  assert.throws(() => f.service.assertActor('group-a', { ...calls[0].actor }), { status: 403 });
  assert.ok(!calls[0].actor.id.includes('remote-user')); assert.equal(calls[0].actor.role, 'member');
});

test('Exclusive bindings and target changes revoke executing actors and pending work', async t => {
  let active; const entered = new Promise(resolve => { active = resolve; }); let current;
  const f = await fixture(t, { onMessage: async value => { current = value; active(); await new Promise(resolve => value.signal.addEventListener('abort', resolve, { once: true })); } });
  const channel = f.setup(); assert.throws(() => f.service.bind('group-a', [channel.id], member), { status: 403 });
  assert.throws(() => f.service.validateBindings([channel.id], 'group-b'), { status: 409 });
  f.push(message('active')); f.push(message('queued')); await entered;
  f.push(message('discover-other', { targetId: 'other' }));
  f.service.update(channel.id, { target: { id: 'other', chatType: 'group' } }, admin);
  assert.equal(current.signal.aborted, true); assert.throws(() => f.service.assertActor('group-a', current.actor), { status: 403 });
  assert.equal(f.store.db.prepare("SELECT status FROM wecom_inbox WHERE message_id='queued'").get().status, 'cancelled');
  assert.equal(f.mock.clients.length, 1, 'target selection keeps the existing transport');
  f.service.bind('group-a', [], admin); f.service.bind('group-b', [channel.id], admin);
  assert.equal(f.service.forSession('group-a').length, 0);
});

test('Outbox is deduplicated, serial, UTF-8 bounded and retries with one stable client ID', async t => {
  const f = await fixture(t); const channel = f.setup(); f.mock.failures = 1;
  const text = '中😀'.repeat(1500), payload = { text, authorName: 'Pi', messageId: 'answer' };
  const { queued } = f.service.publish('group-a', payload); assert.ok(queued > 1);
  assert.equal(f.service.publish('group-a', payload).queued, 0);
  assert.equal(f.service.publish('group-a', { text: 'echo', excludeChannelId: channel.id }).queued, 0);
  await until(() => f.mock.sent.length === queued);
  assert.equal(f.mock.attempts[0], f.mock.attempts[1]); assert.equal(f.mock.peak, 1);
  assert.equal(f.mock.sent.map(item => item.text).join(''), `Pi：\n${text}`);
  assert.ok(f.mock.sent.every(item => Buffer.byteLength(item.text) <= 3800 && item.targetId === 'remote-group-001'));
});

test('Group FIFO waits through busy responses and real failures return one safe origin notice', async t => {
  let busy = true; const seen = [];
  const f = await fixture(t, { onMessage: async ({ message }) => {
    if (busy) { busy = false; throw Object.assign(new Error('busy'), { status: 409 }); }
    seen.push(message.text); if (message.text === 'fail') throw new Error('PRIVATE-BUSINESS-ERROR');
  } });
  f.setup(); f.push(message('first')); f.push(message('second')); f.push(message('fail'));
  await until(() => seen.length === 3 && f.mock.sent.length === 1);
  assert.deepEqual(seen, ['first', 'second', 'fail']); assert.ok(!f.mock.sent[0].text.includes('PRIVATE'));
  assert.equal(f.store.db.prepare("SELECT attempts FROM wecom_inbox WHERE message_id='first'").get().attempts, 2);
});

test('Credential replacement clears discovery, cancels running send and ignores stale transport callbacks', async t => {
  const calls = [], f = await fixture(t, { onMessage: async value => calls.push(value) }); const channel = f.setup();
  f.mock.pause = true; f.service.publish('group-a', { text: 'pending' }); await until(() => f.mock.active === 1);
  f.service.update(channel.id, { botId: 'replacement-bot', secret: 'NEW-SECRET' }, admin);
  assert.equal(f.service.get(channel.id).target, null); assert.equal(f.service.conversations(channel.id, admin).length, 0);
  f.push(message('stale'), 0); await until(() => f.mock.active === 0);
  assert.equal(calls.length, 0); assert.equal(f.mock.sent.length, 0);
  assert.equal(f.store.db.prepare('SELECT status FROM wecom_outbox').get().status, 'cancelled');
});

test('Unrelated account invalidation preserves access; binder removal revokes it immediately', async t => {
  let received; const seen = new Promise(resolve => { received = resolve; }); let current;
  const f = await fixture(t, { onMessage: async value => { current = value; received(); await new Promise(resolve => value.signal.addEventListener('abort', resolve, { once: true })); } });
  const channel = f.setup(); f.push(message('active')); await seen;
  f.service.invalidateUser(member.id); assert.equal(current.signal.aborted, false);
  f.store.db.prepare('DELETE FROM group_members WHERE session_id=? AND user_id=?').run('group-a', admin.id); f.service.invalidateUser(admin.id);
  assert.equal(current.signal.aborted, true); assert.equal(f.service.get(channel.id).status, 'unavailable');
  assert.throws(() => f.service.assertActor('group-a', current.actor), { status: 403 });
});

test('Pending work survives restart while running work is marked interrupted and never replayed', async t => {
  const f = await fixture(t); const channel = f.setup(); await f.service.close();
  const row = f.store.db.prepare('SELECT * FROM wecom_channels WHERE id=?').get(channel.id);
  for (const [id, status] of [['persisted', 'pending'], ['partial', 'running']]) f.store.db.prepare('INSERT INTO wecom_inbox(id,channel_id,message_id,session_id,binding_epoch,user_id,text,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(id, channel.id, id, 'group-a', row.binding_epoch, 'remote-user-0001', id, status, new Date().toISOString());
  const seen = []; await f.restart({ onMessage: async ({ message }) => seen.push(message.text) }); f.service.start();
  await until(() => seen.length === 1); assert.deepEqual(seen, ['persisted']);
  assert.equal(f.store.db.prepare("SELECT status FROM wecom_inbox WHERE id='partial'").get().status, 'interrupted');
});

test('Disconnected pending work waits for reconnection instead of being discarded', async t => {
  const calls = [], f = await fixture(t, { onMessage: async value => calls.push(value) }); f.setup();
  f.push(message('pending')); f.mock.clients[0].options.onState({ status: 'disconnected' });
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(calls.length, 0);
  assert.equal(f.store.db.prepare("SELECT status FROM wecom_inbox WHERE message_id='pending'").get().status, 'pending');
  f.mock.clients[0].options.onState({ status: 'connected' }); await until(() => calls.length === 1);
});

test('Mid-task disconnect preserves actor permissions and queues both final replies and new Web messages', async t => {
  let entered; const running = new Promise(resolve => { entered = resolve; }); let finish; const wait = new Promise(resolve => { finish = resolve; });
  const f = await fixture(t, { onMessage: async value => {
    entered(value); await wait;
    assert.equal(f.service.assertActor('group-a', value.actor), true);
    f.service.publish('group-a', { text: 'task-completed', messageId: 'result' });
  } });
  const channel = f.setup(); f.push(message('start')); const current = await running;
  f.mock.clients[0].options.onState({ status: 'disconnected' });
  assert.equal(f.service.assertActor('group-a', current.actor), true);
  assert.equal(f.service.publish('group-a', { text: 'Web message while offline', messageId: 'web-offline' }).queued, 1);
  finish(); await until(() => f.store.db.prepare("SELECT status FROM wecom_inbox WHERE message_id='start'").get().status === 'done');
  assert.equal(f.mock.sent.length, 0); assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM wecom_outbox WHERE status='pending'").get().n, 2);
  f.mock.clients[0].options.onState({ status: 'connected' }); await until(() => f.mock.sent.length === 2);
  assert.deepEqual(f.mock.sent.map(item => item.text), ['Web message while offline', 'task-completed']);
  const before = f.mock.clients.length; f.service.update(channel.id, { name: '改名', secret: '' }, admin); assert.equal(f.mock.clients.length, before);
  assert.equal(f.store.db.prepare('SELECT secret FROM wecom_channels WHERE id=?').get(channel.id).secret, 'PRIVATE-SECRET');
});
