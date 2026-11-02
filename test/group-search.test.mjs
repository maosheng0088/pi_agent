import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadPi } from '../lib/pi.mjs';
import { createFixture, configure, legacySession, collectSSE } from './auth-helpers.mjs';

async function accounts(fixture) {
  const admin = fixture.client(), alice = fixture.client(), bob = fixture.client();
  const password = 'Group-search-fixture-2026!';
  await admin.request('/auth/setup', { method: 'POST', body: { username: 'search-admin', displayName: 'Admin', password } });
  await configure(admin, fixture);
  const users = [];
  for (const [username, displayName] of [['search-alice', 'Alice'], ['search-bob', 'Bob']]) {
    const created = await admin.request('/admin/users', { method: 'POST', body: { username, displayName, password, role: 'member' } });
    assert.equal(created.response.status, 201);
    users.push(created.data.user);
  }
  await alice.request('/auth/login', { method: 'POST', body: { username: 'search-alice', password } });
  await bob.request('/auth/login', { method: 'POST', body: { username: 'search-bob', password } });
  return { admin, alice, bob, aliceUser: users[0], bobUser: users[1] };
}

test('group members may rename a group, including during a task, while mode changes remain administrator-only', async () => {
  const fixture = await createFixture({ prefix: 'group-rename' });
  try {
    const { admin, alice, bob, bobUser } = await accounts(fixture);
    const chat = await legacySession(fixture, alice, 'Original group');
    const route = `/sessions/${chat.id}`;
    for (const outsider of [bob, admin]) {
      assert.equal((await outsider.request(route, { method: 'PATCH', body: { title: 'Unauthorized' } })).response.status, 404);
    }
    await alice.request(`${route}/members`, { method: 'POST', body: { userIds: [bobUser.id] } });
    const changed = await bob.request(route, { method: 'PATCH', body: { title: '  报价协作群  ' } });
    assert.equal(changed.response.status, 200);
    assert.equal(changed.data.session.title, '报价协作群');
    assert.ok(changed.data.session.revision > chat.revision);
    assert.equal((await alice.request('/sessions?q=' + encodeURIComponent('报价协作群'))).data.total, 1);
    for (const body of [{}, { title: '' }, { title: ' \n ' }, { title: 'x'.repeat(121) }, { title: null }, { title: 'Valid', cwd: fixture.workspace }]) {
      assert.equal((await bob.request(route, { method: 'PATCH', body })).response.status, 400);
    }
    assert.equal((await bob.request(route, { method: 'PATCH', body: { title: 'No partial change', mode: 'workspace' } })).response.status, 403);
    assert.equal((await bob.request(route)).data.session.title, '报价协作群');
    assert.equal((await bob.request(route, { method: 'PATCH', body: { title: '新对话' } })).response.status, 200);
    await alice.send(chat.id, 'The first message must preserve the explicitly chosen default-looking group name.');
    assert.equal((await alice.request(route)).data.session.title, '新对话');

    const stream = await alice.fetch(`${route}/messages`, { method: 'POST', body: { message: '[slow-response] Pending user query' } });
    assert.equal(stream.status, 200);
    try {
      const renameWhileRunning = await bob.request(route, { method: 'PATCH', body: { title: '运行中也能改群名' } });
      assert.equal(renameWhileRunning.response.status, 200);
      assert.equal(renameWhileRunning.data.session.running, true);
      const pendingSearch = (await bob.request(`${route}/search?q=Starting%20slow%20reply`)).data;
      assert.equal(pendingSearch.session.running, true);
      assert.equal(pendingSearch.total, 0);
      assert.equal((await bob.request(`${route}/search?q=Pending%20user%20query`)).data.total, 1);
    } finally {
      await alice.request(`${route}/abort`, { method: 'POST', body: {} });
      await collectSSE(stream);
    }
    const event = (await admin.request('/admin/audit?limit=100')).data.events.find(event => event.action === 'session.renamed' && event.details.title === '运行中也能改群名');
    assert.equal(event.actorName, 'Bob');
    await fixture.stop(); await fixture.start();
    assert.equal((await bob.request(route)).data.session.title, '运行中也能改群名');
  } finally { await fixture.close(); }
});

test('history search is member-scoped, literal, paginated and excludes hidden execution steps', async () => {
  const fixture = await createFixture({ prefix: 'group-search' });
  try {
    const { admin, alice, bob, aliceUser, bobUser } = await accounts(fixture);
    const chat = await legacySession(fixture, alice, 'Search group');
    const route = `/sessions/${chat.id}`;
    await alice.send(chat.id, 'Cost [x].* 50%_ 中文记录 BatchKey one');
    await alice.send(chat.id, 'BatchKey two');
    await alice.send(chat.id, 'BatchKey three');
    const callsBefore = fixture.mock.requests.length;
    for (const outsider of [bob, admin]) assert.equal((await outsider.request(`${route}/search?q=BatchKey`)).response.status, 404);
    assert.equal((await fixture.client().request(`${route}/search?q=BatchKey`)).response.status, 401);
    await alice.request(`${route}/members`, { method: 'POST', body: { userIds: [bobUser.id] } });
    const match = (await bob.request(`${route}/search?q=${encodeURIComponent('[x].*')}`)).data;
    assert.equal(match.total, 1);
    assert.equal(match.results[0].authorId, aliceUser.id);
    assert.equal(match.results[0].authorName, 'Alice');
    assert.equal(match.results[0].role, 'user');
    assert.equal(match.results[0].messageIndex, 0);
    assert.match(match.results[0].snippet, /50%_ 中文记录/);
    assert.ok(match.results[0].timestamp);
    assert.equal((await bob.request(`${route}/search?q=${encodeURIComponent('[x].+')}`)).data.total, 0);
    assert.equal((await bob.request(`${route}/search?q=cost`)).data.total, 1);
    const page = (await bob.request(`${route}/search?q=batchkey&limit=1&offset=1`)).data;
    assert.equal(page.total, 3); assert.equal(page.limit, 1); assert.equal(page.offset, 1);
    assert.equal(page.results[0].content, 'BatchKey two');
    for (const query of ['', 'q=', 'q=%20%20', `q=${'a'.repeat(201)}`, 'q=valid&limit=0', 'q=valid&limit=101', 'q=valid&offset=-1', 'q=valid&offset=100001']) {
      assert.equal((await bob.request(`${route}/search?${query}`)).response.status, 400, query);
    }
    assert.equal(fixture.mock.requests.length, callsBefore, 'search does not invoke the model');

    // Add durable native SDK entries with private tool output and an assistant
    // planning step, then ensure search uses the same visibility as the UI.
    await fixture.stop();
    const db = new DatabaseSync(path.join(fixture.dataDir, 'workspace.sqlite'), { readOnly: true });
    const meta = JSON.parse(db.prepare('SELECT data FROM session_meta WHERE id=?').get(chat.id).data);
    db.close();
    const sdk = await loadPi(process.env.PI_SDK_PATH || 'D:/code/pi/packages/coding-agent/dist/index.js');
    const manager = sdk.SessionManager.open(meta.file, path.join(fixture.dataDir, 'sessions'), meta.cwd);
    manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'HiddenPlan123' }, { type: 'toolCall', id: 'hidden-call', name: 'read', arguments: { path: 'fixture.txt' } }], timestamp: Date.now() });
    manager.appendMessage({ role: 'toolResult', toolCallId: 'hidden-call', toolName: 'read', content: [{ type: 'text', text: 'HiddenTool456' }], isError: false, timestamp: Date.now() });
    manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'PUBLIC-FINAL789' }], timestamp: Date.now() });
    await fixture.start();
    for (const text of ['HiddenPlan123', 'HiddenTool456']) assert.equal((await bob.request(`${route}/search?q=${text}`)).data.total, 0);
    const final = (await bob.request(`${route}/search?q=public-final789`)).data;
    assert.equal(final.total, 1); assert.equal(final.results[0].authorName, 'Pi');
    const transcript = (await bob.request(route)).data.messages;
    assert.equal(transcript[final.results[0].messageIndex].content, 'PUBLIC-FINAL789');
  } finally { await fixture.close(); }
});
