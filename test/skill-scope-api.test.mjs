import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import path from 'node:path';
import { collectSSE, configure, createFixture, deltaText, session, legacySession } from './auth-helpers.mjs';

const password = 'Skill-scope-fixture-2026!';
const restrictedMarker = 'GROUP-A-SKILL-CONTENT-ONLY-a749';

describe('Skill sharing scopes apply to group resources, tools and scheduled workers', { concurrency: false, timeout: 120_000 }, () => {
  let fixture, admin, member, outsider, memberUser, groupA, groupB, privateGroup, shared, restricted;
  before(async () => {
    fixture = await createFixture({ prefix: 'skill-scope', options: { scheduler: { autoStart: false } } });
    admin = fixture.client(); member = fixture.client(); outsider = fixture.client();
    assert.equal((await admin.request('/auth/setup', { method: 'POST', body: { username: 'scope-admin', displayName: 'Scope Admin', password } })).response.status, 201);
    await configure(admin, fixture);
    memberUser = (await admin.request('/admin/users', { method: 'POST', body: { username: 'scope-member', displayName: 'Scope Member', password, role: 'member' } })).data.user;
    await admin.request('/admin/users', { method: 'POST', body: { username: 'scope-outsider', displayName: 'Scope Outsider', password, role: 'member' } });
    assert.equal((await member.request('/auth/login', { method: 'POST', body: { username: 'scope-member', password } })).response.status, 200);
    assert.equal((await outsider.request('/auth/login', { method: 'POST', body: { username: 'scope-outsider', password } })).response.status, 200);
    groupA = await session(admin, 'Skill group A'); groupB = await session(admin, 'Skill group B');
    for (const group of [groupA, groupB]) assert.equal((await admin.request(`/sessions/${group.id}/members`, { method: 'POST', body: { userIds: [memberUser.id] } })).response.status, 200);
    privateGroup = await legacySession(fixture, outsider, 'Not joined by the administrator');
    shared = await createSkill({ name: 'shared-all-fixture' });
    restricted = await createSkill({ name: 'restricted-group-a-fixture', content: restrictedMarker, scope: 'groups', groupIds: [groupA.id] });
  });
  after(async () => { await fixture?.close(); });

  async function createSkill(overrides = {}) {
    const result = await admin.request('/admin/skills', { method: 'POST', body: { name: `scope-fixture-${Date.now()}`, description: 'Local scope integration skill.', content: 'Shared fixture skill content.', enabled: true, ...overrides } });
    assert.equal(result.response.status, 201, JSON.stringify(result.data));
    return result.data.skill;
  }
  async function send(client, group, body) {
    const response = await client.fetch(`/sessions/${group.id}/messages`, { method: 'POST', body });
    assert.equal(response.status, 200, response.ok ? '' : await response.text());
    return collectSSE(response);
  }
  async function waitForRun(scheduleId, runId) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const result = await admin.request(`/admin/schedules/${scheduleId}/runs`);
      assert.equal(result.response.status, 200, JSON.stringify(result.data));
      const run = result.data.runs.find(entry => entry.id === runId);
      if (run && ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(run.status)) return run;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('Scheduled scope test did not finish.');
  }
  async function runTask(scheduleId) {
    const result = await admin.request(`/admin/schedules/${scheduleId}/run`, { method: 'POST', body: {} });
    assert.equal(result.response.status, 202, JSON.stringify(result.data));
    return waitForRun(scheduleId, result.data.run.id);
  }

  it('defaults existing-style skills to everyone and exposes only available metadata to group members', async () => {
    assert.equal(shared.scope, 'all');
    assert.deepEqual(shared.groupIds, []);
    assert.equal(restricted.scope, 'groups');
    assert.deepEqual(restricted.groupIds, [groupA.id]);
    const management = await admin.request('/skills');
    assert.equal(management.response.status, 200);
    assert.ok(management.data.skills.some(skill => skill.id === restricted.id));
    for (const [group, expected] of [[groupA, [shared.id, restricted.id]], [groupB, [shared.id]]]) {
      const result = await member.request(`/sessions/${group.id}/skills`);
      assert.equal(result.response.status, 200, JSON.stringify(result.data));
      assert.deepEqual(new Set(result.data.skills.map(skill => skill.id)), new Set(expected));
      assert.ok(result.data.skills.every(skill => !('content' in skill) && !('files' in skill)));
    }
    assert.equal((await outsider.request(`/sessions/${groupA.id}/skills`)).response.status, 404);
    assert.equal((await admin.request(`/sessions/${privateGroup.id}/skills`)).response.status, 404);
  });

  it('keeps sharing management administrator-only and refuses new grants to groups the administrator has not joined', async () => {
    assert.equal((await member.request('/skills')).response.status, 403);
    assert.equal((await member.request(`/admin/skills/${restricted.id}`, { method: 'PATCH', body: { scope: 'all', groupIds: [] } })).response.status, 403);
    assert.equal((await member.request('/admin/skills', { method: 'POST', body: { name: 'forged-scope', description: 'Forbidden', content: 'Forbidden', scope: 'all' } })).response.status, 403);
    const before = (await admin.request(`/skills/${restricted.id}`)).data.skill;
    const grant = await admin.request(`/admin/skills/${restricted.id}`, { method: 'PATCH', body: { scope: 'groups', groupIds: [groupA.id, privateGroup.id] } });
    assert.equal(grant.response.status, 404, JSON.stringify(grant.data));
    const after = (await admin.request(`/skills/${restricted.id}`)).data.skill;
    assert.deepEqual(after.groupIds, before.groupIds);
    assert.equal(after.version, before.version);
    assert.equal((await admin.request('/admin/skills', { method: 'POST', body: { name: 'hidden-group-grant', description: 'Forbidden new group', content: 'Forbidden', scope: 'groups', groupIds: [privateGroup.id] } })).response.status, 404);
  });

  it('allows preserving an existing grant after leaving that group while still rejecting unrelated new grants', async () => {
    const retainedGroup = await legacySession(fixture, member, 'Previously authorized group');
    const adminUser = (await member.request('/directory')).data.users.find(user => user.username === 'scope-admin');
    assert.ok(adminUser);
    assert.equal((await member.request(`/sessions/${retainedGroup.id}/members`, { method: 'POST', body: { userIds: [adminUser.id] } })).response.status, 200);
    const skill = await createSkill({ name: 'retained-grant-fixture', scope: 'groups', groupIds: [retainedGroup.id] });
    assert.equal((await admin.request(`/sessions/${retainedGroup.id}/leave`, { method: 'POST', body: {} })).response.status, 200);
    const retained = await admin.request(`/admin/skills/${skill.id}`, { method: 'PATCH', body: { scope: 'groups', groupIds: [retainedGroup.id, groupB.id] } });
    assert.equal(retained.response.status, 200, JSON.stringify(retained.data));
    assert.deepEqual(new Set(retained.data.skill.groupIds), new Set([retainedGroup.id, groupB.id]));
    assert.equal((await admin.request(`/admin/skills/${skill.id}`, { method: 'PATCH', body: { scope: 'groups', groupIds: [retainedGroup.id, groupB.id, privateGroup.id] } })).response.status, 404);
    assert.equal((await admin.request(`/sessions/${retainedGroup.id}/skills`)).response.status, 404);
    assert.ok((await member.request(`/sessions/${retainedGroup.id}/skills`)).data.skills.some(entry => entry.id === skill.id));
  });

  it('filters model discovery and rejects both selected IDs and slash invocations outside the allowed group', async () => {
    await member.send(groupB.id, 'Describe available skills without opening files.');
    let request = JSON.stringify(fixture.mock.requests.at(-1));
    assert.ok(request.includes(shared.name));
    assert.ok(!request.includes(restricted.name));
    const before = fixture.mock.requests.length;
    for (const body of [{ message: 'Use selected skill.', skillId: restricted.id }, { message: `/skill:${restricted.name} Use the selected skill.` }]) {
      const result = await member.request(`/sessions/${groupB.id}/messages`, { method: 'POST', body });
      assert.ok([400, 403].includes(result.response.status), JSON.stringify(result.data));
    }
    assert.equal(fixture.mock.requests.length, before);
    await send(member, groupA, { message: 'Invoke the group-approved skill.', skillId: restricted.id });
    request = JSON.stringify(fixture.mock.requests.at(-1));
    assert.ok(request.includes(restrictedMarker));
    await member.send(groupA.id, 'Describe available skills without opening files.');
    assert.ok(JSON.stringify(fixture.mock.requests.at(-1)).includes(restricted.name));
  });

  it('denies read-only file access to another group skill even when the path is known', async () => {
    const file = path.join(fixture.dataDir, 'skills', restricted.id, 'v1', 'SKILL.md');
    const denied = await member.send(groupB.id, `Please [read-path:${file}].`);
    assert.equal(denied.find(event => event.type === 'tool_end')?.isError, true);
    assert.ok(!JSON.stringify(denied).includes(restrictedMarker));
    const permitted = await member.send(groupA.id, `Please [read-path:${file}].`);
    assert.equal(permitted.find(event => event.type === 'tool_end')?.isError, false);
    assert.match(deltaText(permitted), new RegExp(restrictedMarker));
  });

  it('authorizes scheduled skills against the target business group and refuses a previously configured task after scope revocation', async () => {
    const skill = await createSkill({ name: 'scheduled-scope-fixture', content: 'SCHEDULED-SCOPE-CONTENT-67d1', scope: 'groups', groupIds: [groupA.id] });
    const body = { name: 'Group-bound skill job', targetSessionId: groupA.id, executionMode: 'read-only', skillId: skill.id, prompt: 'Use the selected skill with independent context.', scheduleType: 'daily', time: '09:30', enabled: false };
    const saved = await admin.request('/admin/schedules', { method: 'POST', body });
    assert.equal(saved.response.status, 201, JSON.stringify(saved.data));
    const bad = await admin.request('/admin/schedules', { method: 'POST', body: { ...body, targetSessionId: groupB.id } });
    assert.ok([400, 403].includes(bad.response.status), JSON.stringify(bad.data));
    const first = await runTask(saved.data.schedule.id);
    assert.equal(first.status, 'succeeded', JSON.stringify(first));
    assert.equal(first.targetSessionId, groupA.id);
    assert.notEqual(first.sessionId, groupA.id);
    assert.ok(JSON.stringify(fixture.mock.requests.at(-1)).includes('SCHEDULED-SCOPE-CONTENT-67d1'));
    const workerSkills = await admin.request(`/sessions/${first.sessionId}/skills`);
    assert.equal(workerSkills.response.status, 200, JSON.stringify(workerSkills.data));
    assert.ok(workerSkills.data.skills.some(entry => entry.id === skill.id));
    assert.equal((await admin.request(`/admin/schedules/${saved.data.schedule.id}`, { method: 'PATCH', body: { enabled: true } })).response.status, 200);
    const updated = await admin.request(`/admin/skills/${skill.id}`, { method: 'PATCH', body: { scope: 'groups', groupIds: [groupB.id] } });
    assert.equal(updated.response.status, 200, JSON.stringify(updated.data));
    const before = fixture.mock.requests.length;
    const revoked = await runTask(saved.data.schedule.id);
    assert.equal(revoked.status, 'failed', JSON.stringify(revoked));
    assert.match(revoked.error, /技能|共享|群/);
    assert.equal(fixture.mock.requests.length, before);
    const disabled = await admin.request(`/admin/schedules/${saved.data.schedule.id}`, { method: 'PATCH', body: { enabled: false } });
    assert.equal(disabled.response.status, 200, JSON.stringify(disabled.data));
    assert.equal(disabled.data.schedule.enabled, false);
    assert.equal((await admin.request(`/admin/schedules/${saved.data.schedule.id}`, { method: 'PATCH', body: { enabled: true } })).response.status, 400);
  });

  it('stops an already running skill turn after its group grant is removed', async () => {
    const skill = await createSkill({ name: 'revoked-running-skill-fixture', scope: 'groups', groupIds: [groupA.id] });
    const before = fixture.mock.requests.length;
    const response = await member.fetch(`/sessions/${groupA.id}/messages`, { method: 'POST', body: { message: '[slow-response] Stop when the skill grant changes.', skillId: skill.id } });
    assert.equal(response.status, 200);
    const eventsPromise = collectSSE(response);
    const deadline = Date.now() + 10_000;
    while (fixture.mock.requests.length === before && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(fixture.mock.requests.length > before);
    const update = await admin.request(`/admin/skills/${skill.id}`, { method: 'PATCH', body: { scope: 'groups', groupIds: [groupB.id] } });
    assert.equal(update.response.status, 200, JSON.stringify(update.data));
    const events = await eventsPromise;
    assert.equal(events.find(event => event.type === 'done')?.aborted, true);
    assert.ok(events.some(event => event.type === 'error' && /技能|共享/.test(event.message)));
    const count = fixture.mock.requests.length;
    const rejected = await member.request(`/sessions/${groupA.id}/messages`, { method: 'POST', body: { message: 'Try the revoked skill again.', skillId: skill.id } });
    assert.ok([400, 403].includes(rejected.response.status));
    assert.equal(fixture.mock.requests.length, count);
    await member.send(groupA.id, 'Continue with the currently available skills.');
    const systemContext = JSON.stringify(fixture.mock.requests.at(-1).messages.filter(message => ['system', 'developer'].includes(message.role)));
    assert.ok(!systemContext.includes(skill.name));
    assert.ok(!(await member.request(`/sessions/${groupA.id}/skills`)).data.skills.some(entry => entry.id === skill.id));
  });
});
