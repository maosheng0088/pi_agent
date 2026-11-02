import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { adminConversationMessages, discussionPage } from '../lib/admin-conversations.mjs';
import { loadPi } from '../lib/pi.mjs';
import { Store } from '../lib/store.mjs';
import { WorkTaskService } from '../lib/work-tasks.mjs';

function fixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'pi-admin-conversations-'));
  const store = new Store(directory, directory);
  for (const id of ['group-a', 'group-b']) store.db.prepare('INSERT INTO session_meta VALUES (?,?)').run(id, JSON.stringify({ id, title: id }));
  const tasks = new WorkTaskService(store, { execute: async () => ({ result: 'isolated' }), authorize: () => ({ id: 'alice', displayName: 'Alice' }) });
  t.after(async () => {
    await tasks.stop(); store.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('pi-admin-conversations-'));
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, store, tasks };
}

test('discussion pages expose all 1001+ records without gaps or duplicates and never cross groups', t => {
  const { store, tasks } = fixture(t);
  const expected = [], foreign = [];
  store.transaction(() => {
    for (let index = 0; index < 1007; index++) {
      expected.push(tasks.insertMessage({ sessionId: 'group-a', actor: { id: 'alice', displayName: 'Alice' }, content: `讨论 ${index}` }).id);
      if (index % 10 === 0) foreign.push(tasks.insertMessage({ sessionId: 'group-b', actor: { id: 'bob', displayName: 'Bob' }, content: `其他群 ${index}` }).id);
    }
  });
  const first = discussionPage(store, tasks, 'group-a');
  assert.equal(first.total, 1007); assert.equal(first.messages.length, 1000); assert.equal(first.hasMore, true);
  assert.equal(first.messages[0].content, '讨论 7');
  assert.equal(first.messages.at(-1).content, '讨论 1006');
  const second = discussionPage(store, tasks, 'group-a', { before: first.nextBefore });
  assert.equal(second.total, 1007); assert.equal(second.messages.length, 7); assert.equal(second.hasMore, false); assert.equal(second.nextBefore, null);
  const combined = [...second.messages, ...first.messages].map(message => message.id);
  assert.deepEqual(combined, expected); assert.equal(new Set(combined).size, 1007);
  assert.ok(combined.every(id => !foreign.includes(id)));
  const foreignCursor = store.db.prepare('SELECT seq FROM collaboration_messages WHERE id=?').get(foreign[50]).seq;
  const page = discussionPage(store, tasks, 'group-a', { before: foreignCursor, limit: 17 });
  assert.equal(page.messages.length, 17); assert.ok(page.messages.every(message => message.sessionId === 'group-a'));
  assert.ok(page.messages.every(message => store.db.prepare('SELECT seq FROM collaboration_messages WHERE id=?').get(message.id).seq < foreignCursor));
  assert.deepEqual(discussionPage(store, tasks, 'group-a', { before: 1 }), { messages: [], total: 1007, hasMore: false, nextBefore: null });
  assert.deepEqual(discussionPage(store, tasks, 'no-records'), { messages: [], total: 0, hasMore: false, nextBefore: null });
});

test('discussion cursors and page sizes reject unsafe or coerced input', t => {
  const { store, tasks } = fixture(t);
  for (const before of [0, -1, 1.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '2', null, {}, true]) {
    assert.throws(() => discussionPage(store, tasks, 'group-a', { before }), { status: 400 });
  }
  for (const limit of [0, -1, 1001, 1.1, NaN, Infinity, '1', null, true]) {
    assert.throws(() => discussionPage(store, tasks, 'group-a', { limit }), { status: 400 });
  }
  assert.throws(() => discussionPage(store, tasks, '../group-a'), { status: 400 });
});

test('administrator history retains real SDK messages from compacted and abandoned branches with durable authors and IDs', async t => {
  const { directory, store } = fixture(t);
  const sdk = await loadPi(process.env.PI_SDK_PATH || 'D:/code/pi/packages/coding-agent/dist/index.js');
  const manager = sdk.SessionManager.create(directory, store.sessionDir);
  const root = manager.appendMessage({ role: 'user', content: '压缩以前的原始业务要求', timestamp: 10 });
  store.recordSessionAuthor('group-a', root, { id: 'alice', displayName: 'Alice' });
  const old = manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: '旧分支原文仍需审计' }], timestamp: 20 });
  manager.appendCompaction('仅模型摘要', null, 1000);
  const compacted = manager.appendMessage({ role: 'user', content: '压缩以后', timestamp: 30 });
  store.recordSessionAuthor('group-a', compacted, { id: 'bob', displayName: 'Bob' });
  assert.ok(!JSON.stringify(manager.buildSessionContext().messages).includes('压缩以前的原始业务要求'));
  manager.branch(root);
  const other = manager.appendMessage({ role: 'user', content: '另一个分支', timestamp: 40 });
  manager.appendMessage({ role: 'custom', customType: 'private-extension', content: '不应作为聊天展示', display: false, timestamp: 50 });
  const final = manager.appendMessage({ role: 'assistant', content: [{ type: 'thinking', thinking: '不可公开的推理' }, { type: 'text', text: '新分支回复' }], timestamp: 60 });
  assert.ok(!JSON.stringify(manager.buildSessionContext().messages).includes('压缩以后'));
  const messages = adminConversationMessages(manager, store, { id: 'group-a' });
  assert.deepEqual(messages.map(message => message.content), ['压缩以前的原始业务要求', '旧分支原文仍需审计', '压缩以后', '另一个分支', '新分支回复']);
  assert.deepEqual(messages.map(message => message.id), [root, old, compacted, other, final].map(id => `pi:group-a:${id}:0`));
  assert.equal(messages[0].authorName, 'Alice'); assert.equal(messages[2].authorName, 'Bob');
  assert.equal(messages[3].authorId, null); assert.equal(messages[3].authorUnknown, true);
  assert.ok(!JSON.stringify(messages).includes('不可公开的推理'));
  assert.deepEqual(adminConversationMessages(null, store, { id: 'group-a' }), []);
});

test('attachment projection preserves persisted IDs after skipped roles and synthesized rows, and never mutates SDK entries', t => {
  const { store } = fixture(t);
  const attachment = { id: 'report', kind: 'file', name: '报告.pdf', url: '/api/sessions/group-a/attachments/report' };
  const entries = [
    { type: 'message', id: 'ignored', parentId: null, message: { role: 'custom', content: 'private' } },
    { type: 'message', id: 'tool', parentId: 'ignored', message: { role: 'toolResult', toolName: 'attach_file', toolCallId: 'call-1', content: [{ type: 'text', text: 'registered' }], details: { attachment: { id: 'report' } }, timestamp: 10 } },
    { type: 'message', id: 'user', parentId: 'tool', message: { role: 'user', content: '下一轮', timestamp: 20 } },
    { type: 'message', id: 'final', parentId: 'user', message: { role: 'assistant', content: [{ type: 'text', text: '这一轮回复' }], timestamp: 30 } },
  ];
  store.recordSessionAuthor('group-a', 'user', { id: 'alice', displayName: 'Alice' });
  const original = JSON.stringify(entries);
  const manager = { getEntries: () => entries, buildSessionContext: () => { throw new Error('Model context must not be used for administrator history.'); } };
  const messages = adminConversationMessages(manager, store, { id: 'group-a' }, id => id === 'report' ? attachment : null);
  assert.equal(messages.length, 4);
  assert.equal(messages[0].id, 'pi:group-a:tool:0');
  assert.match(messages[1].id, /^pi:group-a:tool:attachment-/); assert.match(messages[1].content, /报告\.pdf/);
  assert.equal(messages[2].id, 'pi:group-a:user:0'); assert.equal(messages[2].authorName, 'Alice');
  assert.equal(messages[3].id, 'pi:group-a:final:0'); assert.doesNotMatch(messages[3].content, /attachments/);
  assert.deepEqual(adminConversationMessages(manager, store, { id: 'group-a' }, () => attachment), messages);
  assert.equal(JSON.stringify(entries), original);
  const denied = adminConversationMessages(manager, store, { id: 'group-a' }, () => { throw new Error('foreign group attachment'); });
  assert.equal(denied.length, 3); assert.ok(!JSON.stringify(denied).includes('/attachments/'));

  const withFinal = entries.slice(0, 2).concat({ type: 'message', id: 'attachment-final', parentId: 'tool', message: { role: 'assistant', content: [{ type: 'text', text: '交付完成' }], timestamp: 15 } });
  const projected = adminConversationMessages({ getEntries: () => withFinal }, store, { id: 'group-a' }, () => attachment);
  assert.equal(projected[1].id, 'pi:group-a:attachment-final:0'); assert.match(projected[1].content, /交付完成[\s\S]*报告\.pdf/);

  const branch = entries.slice(0, 2).concat({ type: 'message', id: 'branch-final', parentId: 'ignored', message: { role: 'assistant', content: '其他分支回复', timestamp: 25 } });
  const separated = adminConversationMessages({ getEntries: () => branch }, store, { id: 'group-a' }, () => attachment);
  assert.equal(separated.at(-1).id, 'pi:group-a:branch-final:0'); assert.equal(separated.at(-1).content, '其他分支回复');
  assert.match(separated[1].content, /报告\.pdf/);
});
