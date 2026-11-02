import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import fs from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createFixture, configure, legacySession } from './auth-helpers.mjs';

const password = 'Group-remove-fixture-2026!';
async function people(fixture) {
  const admin = fixture.client(), owner = fixture.client(), member = fixture.client(), other = fixture.client();
  const administrator = (await admin.request('/auth/setup', { method: 'POST', body: { username: 'remove-admin', displayName: 'Admin', password } })).data.user;
  await configure(admin, fixture);
  const users = {};
  for (const [name, client] of [['owner', owner], ['member', member], ['other', other]]) {
    users[name] = (await admin.request('/admin/users', { method: 'POST', body: { username: `remove-${name}`, displayName: name, password, role: 'member' } })).data.user;
    await client.request('/auth/login', { method: 'POST', body: { username: `remove-${name}`, password } });
  }
  return { admin, owner, member, other, users, administrator };
}
async function invite(client, id, userIds) {
  const result = await client.request(`/sessions/${id}/members`, { method: 'POST', body: { userIds } });
  assert.equal(result.response.status, 200, JSON.stringify(result.data));
  return result.data;
}

test('only creator and administrators in the group may remove others; access and history follow membership', async () => {
  const fixture = await createFixture({ prefix: 'group-remove' });
  try {
    const { admin, owner, member, other, users, administrator } = await people(fixture);
    const chat = await legacySession(fixture, owner, 'Removal permissions');
    const route = `/sessions/${chat.id}/members`;
    const remove = (client, id) => client.request(`${route}/${id}`, { method: 'DELETE', body: {} });
    await invite(owner, chat.id, [users.member.id, users.other.id]);
    await member.send(chat.id, 'Historical speaker remains attributed after removal.');
    assert.equal((await owner.request(route)).data.canRemoveMembers, true);
    assert.equal((await owner.request(route)).data.ownerId, users.owner.id);
    assert.equal((await member.request(route)).data.canRemoveMembers, false);
    assert.equal((await remove(member, users.other.id)).response.status, 403);
    const outsider = await remove(admin, users.other.id);
    assert.equal(outsider.response.status, 404);
    assert.equal(outsider.data.code, 'GROUP_ACCESS_DENIED');
    assert.equal((await remove(owner, users.owner.id)).response.status, 400);
    await invite(member, chat.id, [administrator.id]);
    assert.equal((await admin.request(route)).data.canRemoveMembers, true);
    assert.equal((await remove(admin, users.owner.id)).response.status, 400);
    assert.equal((await remove(admin, administrator.id)).response.status, 400);
    const removed = await remove(owner, users.member.id);
    assert.equal(removed.response.status, 200);
    assert.equal(removed.data.removedUserId, users.member.id);
    assert.equal(removed.data.visibility, 'members');
    assert.equal(removed.data.canRemoveMembers, true);
    assert.ok(!removed.data.members.some(user => user.id === users.member.id));
    assert.equal((await remove(owner, users.member.id)).response.status, 404);
    const beforeRequests = fixture.mock.requests.length;
    for (const [routeToCall, method = 'GET', body] of [
      [`/sessions/${chat.id}`], [route], [`/sessions/${chat.id}/search?q=Historical`],
      [`/sessions/${chat.id}`, 'PATCH', { title: 'Forbidden rename' }],
      [route, 'POST', { userIds: [users.member.id] }],
      [`${route}/${users.other.id}`, 'DELETE', {}],
      [`/sessions/${chat.id}/messages`, 'POST', { message: 'Forbidden task' }],
      [`/sessions/${chat.id}/abort`, 'POST', {}],
    ]) {
      const denied = await member.request(routeToCall, { method, body });
      assert.equal(denied.response.status, 404, routeToCall);
      assert.equal(denied.data.code, 'GROUP_ACCESS_DENIED', routeToCall);
    }
    assert.equal((await member.request('/sessions')).data.total, 0);
    assert.equal(fixture.mock.requests.length, beforeRequests);
    const history = (await owner.request(`/sessions/${chat.id}`)).data;
    assert.ok(history.messages.some(message => message.authorId === users.member.id && message.content.includes('Historical speaker')));
    assert.equal((await remove(admin, users.other.id)).response.status, 200);
    const events = (await admin.request('/admin/audit')).data.events;
    assert.ok(events.some(event => event.action === 'group.member_removed' && event.targetId === chat.id));
    await fixture.stop(); await fixture.start();
    assert.ok(!(await owner.request(route)).data.members.some(user => user.id === users.member.id));
    assert.equal((await member.request('/sessions')).data.total, 0);
    await invite(owner, chat.id, [users.member.id]);
    assert.equal((await member.request(`/sessions/${chat.id}`)).response.status, 200);
    assert.equal((await member.request(`/sessions/${chat.id}/search?q=Historical`)).data.total, 1);
  } finally { await fixture.close(); }
});

test('legacy speakers and creators are migrated once and removed speakers stay removed after restart', async () => {
  const fixture = await createFixture({ prefix: 'group-removal-migration' });
  try {
    const { owner, member, users } = await people(fixture);
    const chat = await legacySession(fixture, owner, 'Legacy membership');
    await invite(owner, chat.id, [users.member.id]);
    await member.send(chat.id, 'Speaker before the membership migration.');
    await fixture.stop();
    const database = new DatabaseSync(path.join(fixture.dataDir, 'workspace.sqlite'));
    database.prepare('DELETE FROM metadata WHERE key=?').run('group_members_seeded');
    database.prepare('DELETE FROM group_members WHERE session_id=?').run(chat.id);
    database.close();
    await fixture.start();
    const route = `/sessions/${chat.id}/members`;
    assert.deepEqual(new Set((await owner.request(route)).data.members.map(user => user.id)), new Set([users.owner.id, users.member.id]));
    assert.equal((await owner.request(`${route}/${users.member.id}`, { method: 'DELETE', body: {} })).response.status, 200);
    await fixture.stop(); await fixture.start();
    assert.deepEqual((await owner.request(route)).data.members.map(user => user.id), [users.owner.id]);
  } finally { await fixture.close(); }
});

test('removing the running speaker immediately closes SSE and cancels its task without a final data payload', async () => {
  const fixture = await createFixture({ prefix: 'group-removal-running' });
  try {
    const { owner, member, users } = await people(fixture);
    const chat = await legacySession(fixture, owner, 'Running member');
    await invite(owner, chat.id, [users.member.id]);
    let receivedDelta;
    const started = new Promise(resolve => { receivedDelta = resolve; });
    const streaming = member.send(chat.id, '[slow-response] private stream', event => { if (event.type === 'text_delta') receivedDelta(); });
    await started;
    const removed = await owner.request(`/sessions/${chat.id}/members/${users.member.id}`, { method: 'DELETE', body: {} });
    assert.equal(removed.response.status, 200);
    const events = await streaming;
    const revokeIndex = events.findIndex(event => event.type === 'access_revoked');
    assert.ok(revokeIndex >= 0);
    assert.equal(events.length, revokeIndex + 1);
    assert.deepEqual(events[revokeIndex], { type: 'access_revoked', message: '你已被移出此群聊。' });
    assert.ok(!events.some(event => event.type === 'done'));
    for (let attempt = 0; attempt < 40 && (await owner.request('/sessions')).data.sessions[0].running; attempt++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal((await owner.request('/sessions')).data.sessions[0].running, false);
    assert.equal((await member.request(`/sessions/${chat.id}`)).response.status, 404);
  } finally { await fixture.close(); }
});

test('membership is rechecked after asynchronous workspace and transcript reads', async () => {
  const fixture = await createFixture({ prefix: 'group-removal-races' });
  const originalStat = fs.stat;
  let unblock;
  try {
    const { owner, member, users } = await people(fixture);
    const chat = await legacySession(fixture, owner, 'Membership race');
    await invite(owner, chat.id, [users.member.id]);
    await member.send(chat.id, 'Record before removal.');
    const database = new DatabaseSync(path.join(fixture.dataDir, 'workspace.sqlite'));
    const meta = JSON.parse(database.prepare('SELECT data FROM session_meta WHERE id=?').get(chat.id).data);
    database.close();
    for (const [route, method, body, waitPath] of [
      [`/sessions/${chat.id}/messages`, 'POST', { message: 'Must never reach provider' }, chat.cwd],
      [`/sessions/${chat.id}`, 'GET', undefined, meta.file],
      [`/sessions/${chat.id}/search?q=Record`, 'GET', undefined, meta.file],
    ]) {
      await invite(owner, chat.id, [users.member.id]);
      let markWaiting;
      const waiting = new Promise(resolve => { markWaiting = resolve; });
      const released = new Promise(resolve => { unblock = resolve; });
      fs.stat = async (...args) => {
        if (String(args[0]) === waitPath) { markWaiting(); await released; }
        return originalStat(...args);
      };
      const count = fixture.mock.requests.length;
      const pending = member.request(route, { method, body });
      await waiting;
      const removed = await owner.request(`/sessions/${chat.id}/members/${users.member.id}`, { method: 'DELETE', body: {} });
      assert.equal(removed.response.status, 200);
      unblock();
      const response = await pending;
      assert.equal(response.response.status, 404, route);
      assert.equal(response.data.code, 'GROUP_ACCESS_DENIED');
      assert.equal(fixture.mock.requests.length, count);
      fs.stat = originalStat;
    }
  } finally { unblock?.(); fs.stat = originalStat; await fixture.close(); }
});
