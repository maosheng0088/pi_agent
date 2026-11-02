import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { createFixture, configure, session, legacySession } from './auth-helpers.mjs';

const password = 'Group-leave-fixture-2026!';
async function people(fixture) {
  const admin = fixture.client(), owner = fixture.client(), member = fixture.client(), other = fixture.client();
  const administrator = (await admin.request('/auth/setup', { method: 'POST', body: { username: 'leave-admin', displayName: 'Admin', password } })).data.user;
  await configure(admin, fixture);
  const users = {};
  for (const [name, client] of [['owner', owner], ['member', member], ['other', other]]) {
    users[name] = (await admin.request('/admin/users', { method: 'POST', body: { username: `leave-${name}`, displayName: name, password, role: 'member' } })).data.user;
    await client.request('/auth/login', { method: 'POST', body: { username: `leave-${name}`, password } });
  }
  return { admin, owner, member, other, users, administrator };
}
async function invite(client, id, userIds) {
  const result = await client.request(`/sessions/${id}/members`, { method: 'POST', body: { userIds } });
  assert.equal(result.response.status, 200, JSON.stringify(result.data));
  return result.data;
}
const leave = (client, id) => client.request(`/sessions/${id}/leave`, { method: 'POST', body: {} });

test('members and member administrators can leave while creators remain; leaving revokes access and preserves history', async () => {
  const fixture = await createFixture({ prefix: 'group-leave' });
  try {
    const { admin, owner, member, other, users, administrator } = await people(fixture);
    const chat = await legacySession(fixture, owner, 'Leave permissions');
    const route = `/sessions/${chat.id}/members`;
    const ownerInfo = (await owner.request(route)).data;
    assert.equal(ownerInfo.canLeave, false);
    assert.match(ownerInfo.leaveBlockedReason, /创建人.*不能退出/);
    const rejected = await leave(owner, chat.id);
    assert.equal(rejected.response.status, 409);
    assert.match(rejected.data.error, /转让/);
    for (const outsider of [other, admin]) {
      const denied = await leave(outsider, chat.id);
      assert.equal(denied.response.status, 404);
      assert.equal(denied.data.code, 'GROUP_ACCESS_DENIED');
    }
    assert.equal((await leave(fixture.client(), chat.id)).response.status, 401);
    const added = await invite(owner, chat.id, [users.member.id, administrator.id]);
    assert.equal(added.canLeave, false);
    const memberInfo = (await member.request(route)).data;
    assert.equal(memberInfo.canLeave, true);
    assert.equal(memberInfo.leaveBlockedReason, undefined);
    await member.send(chat.id, 'Historical speaker remains after voluntary exit.');
    assert.equal((await member.request(`${route}/${users.member.id}`, { method: 'DELETE', body: {} })).response.status, 403);
    assert.equal((await admin.request(`${route}/${administrator.id}`, { method: 'DELETE', body: {} })).response.status, 400);
    const exited = await leave(member, chat.id);
    assert.equal(exited.response.status, 200);
    assert.deepEqual(exited.data, { ok: true, left: true, sessionId: chat.id });
    assert.equal((await leave(member, chat.id)).response.status, 404);
    const beforeRequests = fixture.mock.requests.length;
    for (const [routeToCall, method = 'GET', body] of [
      [`/sessions/${chat.id}`], [route], [`/sessions/${chat.id}/search?q=Historical`],
      [`/sessions/${chat.id}`, 'PATCH', { title: 'Forbidden rename' }],
      [route, 'POST', { userIds: [users.member.id] }],
      [`${route}/${administrator.id}`, 'DELETE', {}],
      [`/sessions/${chat.id}/messages`, 'POST', { message: 'Forbidden task' }],
      [`/sessions/${chat.id}/abort`, 'POST', {}],
    ]) {
      const denied = await member.request(routeToCall, { method, body });
      assert.equal(denied.response.status, 404, routeToCall);
      assert.equal(denied.data.code, 'GROUP_ACCESS_DENIED', routeToCall);
    }
    assert.equal((await member.request('/sessions')).data.total, 0);
    assert.equal((await member.request('/sessions?q=Leave')).data.total, 0);
    assert.equal(fixture.mock.requests.length, beforeRequests);
    const history = (await owner.request(`/sessions/${chat.id}`)).data;
    assert.ok(history.messages.some(message => message.authorId === users.member.id && message.content.includes('Historical speaker')));
    assert.equal((await admin.request(route)).data.canLeave, true);
    assert.equal((await leave(admin, chat.id)).response.status, 200);
    assert.equal((await admin.request(`/sessions/${chat.id}`)).response.status, 404);
    assert.equal((await admin.request(`/admin/sessions/${chat.id}`)).response.status, 200);
    const event = (await admin.request('/admin/audit')).data.events.find(event => event.action === 'group.member_left' && event.actorId === users.member.id);
    assert.ok(event);
    assert.equal(event.actorName, 'member');
    assert.equal(event.targetId, chat.id);
    await fixture.stop(); await fixture.start();
    assert.equal((await member.request('/sessions')).data.total, 0);
    assert.deepEqual((await owner.request(route)).data.members.map(user => user.id), [users.owner.id]);
    await invite(owner, chat.id, [users.member.id]);
    assert.equal((await member.request(`/sessions/${chat.id}`)).response.status, 200);
    assert.equal((await member.request(`/sessions/${chat.id}/search?q=Historical`)).data.total, 1);
    const adminCreated = await session(admin, 'Admin creator');
    assert.equal((await leave(admin, adminCreated.id)).response.status, 409);
  } finally { await fixture.close(); }
});

test('leaving while running closes the departing speaker stream with a safe event and cancels only that task', async () => {
  const fixture = await createFixture({ prefix: 'group-leave-running' });
  try {
    const { owner, member, users } = await people(fixture);
    const chat = await legacySession(fixture, owner, 'Running voluntary exit');
    await invite(owner, chat.id, [users.member.id]);
    let receivedDelta;
    const started = new Promise(resolve => { receivedDelta = resolve; });
    const streaming = member.send(chat.id, '[slow-response] departing speaker stream', event => { if (event.type === 'text_delta') receivedDelta(); });
    await started;
    assert.equal((await leave(member, chat.id)).response.status, 200);
    const events = await streaming;
    const revokeIndex = events.findIndex(event => event.type === 'access_revoked');
    assert.ok(revokeIndex >= 0);
    assert.equal(events.length, revokeIndex + 1);
    assert.deepEqual(events[revokeIndex], { type: 'access_revoked', message: '你已退出此群聊。' });
    assert.ok(!events.some(event => event.type === 'done'));
    for (let attempt = 0; attempt < 40 && (await owner.request('/sessions')).data.sessions[0].running; attempt++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal((await owner.request('/sessions')).data.sessions[0].running, false);
    await invite(owner, chat.id, [users.member.id]);
    let ownerDelta;
    const ownerStarted = new Promise(resolve => { ownerDelta = resolve; });
    const ownerStreaming = owner.send(chat.id, '[slow-response] owner remains', event => { if (event.type === 'text_delta') ownerDelta(); });
    await ownerStarted;
    assert.equal((await leave(member, chat.id)).response.status, 200);
    assert.equal((await owner.request('/sessions')).data.sessions[0].running, true);
    await owner.request(`/sessions/${chat.id}/abort`, { method: 'POST', body: {} });
    assert.ok(!(await ownerStreaming).some(event => event.type === 'access_revoked'));
  } finally { await fixture.close(); }
});

async function delayedBody(fixture, client, id) {
  const url = new URL(fixture.baseUrl);
  let request;
  const arrived = new Promise(resolve => {
    fixture.server.once('request', resolve);
  });
  const result = new Promise((resolve, reject) => {
    request = http.request({ hostname: url.hostname, port: url.port, path: `/api/sessions/${id}/leave`, method: 'POST',
      headers: { cookie: client.cookie, 'content-type': 'application/json', 'content-length': 2 } }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, data: JSON.parse(text) }));
    });
    request.on('error', reject);
    request.setTimeout(10_000, () => request.destroy(new Error('Leave body race timed out')));
    request.write('{');
  });
  await arrived;
  return { finish() { request.end('}'); return result; }, destroy() { request.destroy(); } };
}

test('leave rechecks membership and account validity after awaiting the request body', async () => {
  const fixture = await createFixture({ prefix: 'group-leave-races' });
  let pending;
  try {
    const { admin, owner, member, users } = await people(fixture);
    const chat = await legacySession(fixture, owner, 'Leave race');
    await invite(owner, chat.id, [users.member.id]);
    pending = await delayedBody(fixture, member, chat.id);
    await owner.request(`/sessions/${chat.id}/members/${users.member.id}`, { method: 'DELETE', body: {} });
    const removedWhileWaiting = await pending.finish();
    pending = undefined;
    assert.equal(removedWhileWaiting.status, 404);
    assert.equal(removedWhileWaiting.data.code, 'GROUP_ACCESS_DENIED');
    await invite(owner, chat.id, [users.member.id]);
    pending = await delayedBody(fixture, member, chat.id);
    await admin.request(`/admin/users/${users.member.id}`, { method: 'PATCH', body: { disabled: true } });
    const disabledWhileWaiting = await pending.finish();
    pending = undefined;
    assert.equal(disabledWhileWaiting.status, 401);
    assert.ok((await owner.request(`/sessions/${chat.id}/members`)).data.members.some(user => user.id === users.member.id));
  } finally { pending?.destroy(); await fixture.close(); }
});
