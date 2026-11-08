import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Store } from '../lib/store.mjs';
import { HttpError } from '../lib/security.mjs';
import { WecomService } from '../lib/wecom-channels.mjs';

const admin = { id: 'media-admin', role: 'admin', displayName: 'Administrator' };
const webhookUrl = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=fixture-media-hook';

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-wecom-media-'));
  const store = new Store(directory, directory), at = new Date().toISOString();
  store.db.prepare('INSERT INTO users(id,username,display_name,role,password_hash,created_at) VALUES (?,?,?,?,?,?)')
    .run(admin.id, admin.id, admin.displayName, 'admin', 'not-a-password-hash', at);
  for (const id of ['group-a', 'group-b']) {
    const meta = { id, title: id, ownerId: admin.id, createdAt: at };
    store.sessions.push(meta);
    store.db.prepare('INSERT INTO session_meta(id,data) VALUES (?,?)').run(id, JSON.stringify(meta));
    store.db.prepare('INSERT INTO group_members VALUES (?,?,?,?)').run(id, admin.id, admin.id, at);
  }
  const files = new Map(), sent = [], reads = [], websocket = [];
  const settings = {
    webhookIntervalMs: 0, retryMs: 10, pollIntervalMs: 10,
    webhookSender: async value => { sent.push(value); },
    clientFactory: callbacks => ({ start() { callbacks.onState({ status: 'connected' }); }, close() {}, async sendText(value) { websocket.push(value); } }),
    resolveAttachment: ({ sessionId, id }) => {
      const entry = files.get(id);
      if (!entry || entry.sessionId !== sessionId) throw new HttpError(404, 'Missing fixture attachment');
      return { ...entry.metadata };
    },
    readAttachment: async input => {
      reads.push(input); input.authorize(); input.signal?.throwIfAborted();
      const entry = files.get(input.id);
      if (!entry || entry.sessionId !== input.sessionId) throw new HttpError(404, 'Missing fixture attachment');
      return { name: entry.metadata.name, mimeType: entry.metadata.mimeType, content: entry.content };
    },
    ...options,
  };
  let service = new WecomService(store, settings);
  t.after(async () => { await service.close(); store.close(); assert.equal(path.dirname(directory), os.tmpdir()); assert.ok(path.basename(directory).startsWith('pi-wecom-media-')); await fs.rm(directory, { recursive: true, force: true }); });
  return {
    store, files, sent, reads, websocket,
    get service() { return service; },
    attachment({ name = 'report.pdf', mimeType = 'application/pdf', content = Buffer.from('fixture file content'), sessionId = 'group-a', size = content.length } = {}) {
      const id = randomUUID(); files.set(id, { metadata: { id, name, mimeType, size, kind: mimeType.startsWith('image/') ? 'image' : 'file' }, content, sessionId }); return id;
    },
    hook() { const channel = service.create({ type: 'wecom', name: 'Media reports', connectionMode: 'webhook', webhookUrl }, admin); service.bind('group-a', [channel.id], admin); return service.get(channel.id); },
    async send(id) { service._send(service._row(id)); await Promise.allSettled([...service.work]); },
    rows() { return store.db.prepare('SELECT * FROM wecom_outbox ORDER BY rowid').all(); },
    async restart() { await service.close(); service = new WecomService(store, settings); },
  };
}

test('media queue stores only attachment IDs, resolves canonical type and sends each image/file/voice once', async t => {
  const f = await fixture(t), channel = f.hook();
  const image = f.attachment({ name: 'image.png', mimeType: 'image/png', content: Buffer.from('fixture png bytes') });
  const file = f.attachment();
  const voice = f.attachment({ name: 'voice.amr', mimeType: 'application/octet-stream' });
  const input = { text: 'Result with internal links', webhookText: '检查完成。', authorName: 'Pi', messageId: 'media-result', attachments: [
    { id: image, name: 'fake-path', mimeType: 'invalid' }, { id: file }, { id: voice }, { id: file },
  ] };
  assert.equal(f.service.publish('group-a', input).queued, 4);
  assert.equal(f.service.publish('group-a', input).queued, 0);
  assert.deepEqual(f.rows().map(row => row.message_type), ['markdown', 'image', 'file', 'voice']);
  assert.equal(f.rows()[0].text, 'Pi：\n检查完成。');
  assert.ok(f.rows().slice(1).every(row => row.text === '' && row.attachment_id));
  const stored = JSON.stringify(f.rows());
  assert.ok(!stored.includes('fake-path')); assert.ok(!stored.includes('fixture png bytes')); assert.ok(!stored.includes('cgi-bin'));
  for (let i = 0; i < 5; i++) await f.send(channel.id);
  assert.deepEqual(f.sent.map(item => item.messageType), ['markdown', 'image', 'file', 'voice']);
  assert.ok(f.sent.slice(1).every(item => Buffer.isBuffer(item.attachment.content)));
  assert.ok(f.reads.every(item => item.sessionId === 'group-a' && item.maxBytes === 20 * 1024 * 1024));
  assert.ok(f.rows().every(row => row.status === 'sent'));
});

test('attachment-only messages do not produce empty author text or require a receiving conversation', async t => {
  const f = await fixture(t), channel = f.hook(), id = f.attachment();
  assert.equal(f.service.publish('group-a', { authorName: 'Pi', attachments: [{ id }] }).queued, 1);
  assert.equal(f.rows()[0].text, ''); assert.equal(f.rows()[0].message_type, 'file');
  await f.send(channel.id);
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].attachment.name, 'report.pdf');
  assert.equal(f.service.get(channel.id).target, null);
});

test('large images and non-AMR audio/video are preserved as ordinary files', async t => {
  const f = await fixture(t), channel = f.hook();
  const ids = [f.attachment({ name: 'large.png', mimeType: 'image/png', size: 3 * 1024 * 1024 }),
    f.attachment({ name: 'voice.mp3', mimeType: 'audio/mpeg' }), f.attachment({ name: 'video.mp4', mimeType: 'video/mp4' }),
    f.attachment({ name: '动画.gif', mimeType: 'image/gif' }), f.attachment({ name: 'data.xlsx', mimeType: 'application/octet-stream' })];
  f.service.publish('group-a', { attachments: ids.map(id => ({ id })) });
  assert.ok(f.rows().every(row => row.message_type === 'file'));
  for (const id of ids) await f.send(channel.id);
  assert.equal(f.sent.length, 5); assert.ok(f.sent.every(item => item.messageType === 'file'));
});

test('unknown, cross-group, unconfigured and oversized attachments remain explicit failed deliveries without reading bytes', async t => {
  const f = await fixture(t), channel = f.hook();
  const foreign = f.attachment({ sessionId: 'group-b' }), tooLarge = f.attachment({ size: 21 * 1024 * 1024 });
  f.service.publish('group-a', { attachments: [{ id: foreign }, { id: randomUUID() }, { id: tooLarge }] });
  assert.ok(f.rows().every(row => row.status === 'failed'));
  assert.match(f.rows()[0].last_error, /不属于当前智能体/);
  assert.match(f.rows()[2].last_error, /20 MiB/);
  assert.match(f.service.get(channel.id).lastDeliveryError, /20 MiB/);
  await f.send(channel.id); assert.equal(f.sent.length, 0); assert.equal(f.reads.length, 0);
  assert.throws(() => f.service.publish('group-a', { attachments: [{ id: 'D:/other/private.pdf' }] }), { status: 400 });
  const g = await fixture(t, { resolveAttachment: undefined }); const second = g.hook(); const id = g.attachment();
  g.service.publish('group-a', { attachments: [{ id }] });
  assert.match(g.service.get(second.id).lastDeliveryError, /尚未配置/);
});

test('a missing snapshot fails locally and does not retry acknowledged text or transmit another group file', async t => {
  const f = await fixture(t), channel = f.hook(), id = f.attachment();
  f.service.publish('group-a', { text: 'Results', attachments: [{ id }], messageId: 'missing-snapshot' });
  await f.send(channel.id); f.files.delete(id); await f.send(channel.id); await f.send(channel.id);
  assert.equal(f.sent.length, 1); assert.equal(f.rows()[0].status, 'sent');
  assert.equal(f.rows()[1].status, 'failed'); assert.equal(f.rows()[1].attempts, 1);
  assert.match(f.rows()[1].last_error, /附件已不存在/);
});

test('a transient file failure retries only that attachment with its stable persisted ID', async t => {
  let failures = 1; const sent = [], attempts = [];
  const f = await fixture(t, { webhookSender: async value => { attempts.push(value.clientId); if (value.attachment && failures-- > 0) throw new Error('private provider text'); sent.push(value); } });
  const channel = f.hook(), id = f.attachment();
  f.service.publish('group-a', { text: 'Results', attachments: [{ id }], messageId: 'retry-result' });
  await f.send(channel.id); await f.send(channel.id);
  assert.equal(f.rows()[1].status, 'pending');
  f.store.db.prepare('UPDATE wecom_outbox SET next_attempt_at=0').run(); await f.send(channel.id);
  assert.equal(sent.length, 2); assert.equal(sent[0].messageType, 'markdown'); assert.equal(sent[1].messageType, 'file');
  assert.equal(attempts[1], attempts[2]); assert.ok(f.rows().every(row => row.status === 'sent'));
});

test('changing the Webhook aborts an in-progress read and never sends old file bytes to the new address', async t => {
  let entered; const reading = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { readAttachment: async input => { entered(input); await new Promise((resolve, reject) => input.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })); } });
  const channel = f.hook(), id = f.attachment(); f.service.publish('group-a', { attachments: [{ id }] });
  f.service._send(f.service._row(channel.id)); const current = await reading;
  f.service.update(channel.id, { webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=fixture-new-recipient' }, admin);
  await Promise.allSettled([...f.service.work]);
  assert.equal(current.signal.aborted, true); assert.equal(f.rows()[0].status, 'cancelled'); assert.equal(f.sent.length, 0);
  assert.equal(f.service.get(channel.id).lastDeliveryError, null);
});

test('permissions are rechecked after a read that ignores cancellation', async t => {
  let entered, finish; const reading = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { readAttachment: async () => { entered(); await new Promise(resolve => { finish = resolve; }); return { name: 'private.pdf', mimeType: 'application/pdf', content: Buffer.from('private file data') }; } });
  const channel = f.hook(), id = f.attachment(); f.service.publish('group-a', { attachments: [{ id }] });
  f.service._send(f.service._row(channel.id)); await reading;
  f.store.db.prepare('DELETE FROM group_members WHERE session_id=? AND user_id=?').run('group-a', admin.id);
  finish(); await Promise.allSettled([...f.service.work]);
  assert.equal(f.sent.length, 0); assert.equal(f.rows()[0].status, 'failed');
});

test('pending media survives service restart while acknowledged rows never replay', async t => {
  const f = await fixture(t), channel = f.hook(), id = f.attachment();
  f.service.publish('group-a', { text: 'Results', attachments: [{ id }], messageId: 'durable-result' });
  await f.send(channel.id); await f.restart();
  assert.equal(f.rows()[1].attachment_id, id); assert.equal(f.rows()[1].status, 'pending');
  await f.send(channel.id); await f.send(channel.id);
  assert.equal(f.sent.length, 2); assert.ok(f.rows().every(row => row.status === 'sent'));
});

test('native media validation can fall back to a file without replaying or losing the attachment', async t => {
  const attempts = [];
  const f = await fixture(t, { webhookSender: async value => { attempts.push(value.messageType); if (value.messageType === 'voice') throw Object.assign(new Error('Safe validation failure'), { code: 'VOICE_TOO_LONG' }); } });
  const channel = f.hook(), id = f.attachment({ name: 'long.amr' });
  f.service.publish('group-a', { attachments: [{ id }] }); await f.send(channel.id);
  assert.deepEqual(attempts, ['voice', 'file']); assert.equal(f.rows()[0].message_type, 'file'); assert.equal(f.rows()[0].status, 'sent');
});

test('WebSocket reply channels retain their text link and do not enqueue native media', async t => {
  const f = await fixture(t), id = f.attachment();
  const channel = f.service.create({ type: 'wecom', name: 'Long connection', botId: 'test-media-bot', secret: 'fixture-secret' }, admin);
  f.service.start();
  f.service._receive(channel.id, { botId: 'test-media-bot', messageId: 'discover', userId: 'external', targetId: 'remote', chatType: 'group', text: 'discover', timestamp: Date.now() });
  f.service.update(channel.id, { target: { id: 'remote', chatType: 'group' } }, admin); f.service.bind('group-a', [channel.id], admin);
  f.service.publish('group-a', { text: 'Report with internal attachment link', webhookText: 'Report', attachments: [{ id }] });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(f.websocket.length, 1); assert.equal(f.websocket[0].text, 'Report with internal attachment link');
  assert.equal(f.rows().length, 1); assert.equal(f.rows()[0].message_type, 'markdown'); assert.equal(f.reads.length, 0);
});
