import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { collectSSE, configure, createFixture, deltaText, collaborativeSession as session } from './auth-helpers.mjs';
import { SkillCatalog } from '../lib/skills.mjs';
import { Store } from '../lib/store.mjs';
import { createRuntime, loadPi, resourceLoader } from '../lib/pi.mjs';
import { sessionTools } from '../lib/shared-tools.mjs';

const password = 'Skills-fixture-123!';
const skillBody = '# Fixture skill\n\nSKILL-BODY-CONTEXT-MARKER-49ba. Read fixture.txt and report its real contents.\n';

describe('Administrator skills and scheduled real Pi tasks', { concurrency: false, timeout: 120_000 }, () => {
  let fixture;
  let admin;
  let member;
  let adminUser;
  let skill;
  let fakeNow = new Date('2026-10-27T01:00:00.000Z');

  before(async () => {
    fixture = await createFixture({ prefix: 'skills-schedules', options: { scheduler: { autoStart: false, now: () => new Date(fakeNow) } } });
    admin = fixture.client();
    member = fixture.client();
    const setup = await admin.request('/auth/setup', { method: 'POST', body: { username: 'skills-admin', displayName: 'Skills Admin', password } });
    assert.equal(setup.response.status, 201, JSON.stringify(setup.data));
    adminUser = setup.data.user;
    await configure(admin, fixture);
    assert.equal((await admin.request('/admin/users', { method: 'POST', body: { username: 'skills-member', displayName: 'Skills Member', password, role: 'member' } })).response.status, 201);
    assert.equal((await member.request('/auth/login', { method: 'POST', body: { username: 'skills-member', password } })).response.status, 200);
    await writeFile(path.join(fixture.dataDir, 'private-fixture.txt'), 'DATA-DIR-PRIVATE-MARKER-18cb', 'utf8');
  });
  after(async () => { await fixture?.close(); });

  async function createSkill(overrides = {}) {
    const result = await admin.request('/admin/skills', { method: 'POST', body: {
      name: `fixture-skill-${Date.now()}`, description: 'Fixture skill description for local tests.', content: skillBody, enabled: true, ...overrides,
    } });
    assert.equal(result.response.status, 201, JSON.stringify(result.data));
    return result.data.skill;
  }
  async function task(overrides = {}, client = admin) {
    const target = await session(client, 'Scheduled business group');
    await writeFile(path.join(target.cwd, 'fixture.txt'), 'scheduled-real-workspace-content-06bc\n', 'utf8');
    const result = await client.request('/admin/schedules', { method: 'POST', body: {
      targetSessionId: target.id,
      name: 'Fixture scheduled task', skillId: skill.id, prompt: 'Please [read-workspace] and report the actual file.',
      scheduleType: 'daily', time: '09:30', enabled: false, ...overrides,
    } });
    assert.equal(result.response.status, 201, JSON.stringify(result.data));
    return result.data.schedule;
  }
  async function run(taskId, client = admin) {
    const result = await client.request(`/admin/schedules/${taskId}/run`, { method: 'POST', body: {} });
    assert.equal(result.response.status, 202, JSON.stringify(result.data));
    assert.ok(result.data.run?.id);
    return result.data.run;
  }
  async function waitForRun(taskId, runId, states = ['succeeded', 'failed', 'cancelled', 'interrupted']) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const result = await admin.request(`/admin/schedules/${taskId}/runs`);
      assert.equal(result.response.status, 200, JSON.stringify(result.data));
      const current = result.data.runs.find((entry) => entry.id === runId);
      if (current && states.includes(current.status)) return current;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail(`Run ${runId} did not reach ${states.join('/')}`);
  }
  async function callSkill(target, message, skillId) {
    const response = await admin.fetch(`/sessions/${target.id}/messages`, { method: 'POST', body: { message, ...(skillId ? { skillId } : {}) } });
    assert.equal(response.status, 200, response.ok ? '' : await response.text());
    return collectSSE(response);
  }
  async function waitForModelRequest(fromIndex, marker) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (fixture.mock.requests.slice(fromIndex).some((request) => JSON.stringify(request.messages).includes(marker))) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail(`The real Pi request did not reach the provider: ${marker}`);
  }

  it('starts with no skills or enabled tasks and grants skill CRUD only to administrators', async () => {
    const empty = await admin.request('/skills');
    assert.equal(empty.response.status, 200);
    assert.deepEqual(empty.data.skills, []);
    const tasks = await admin.request('/admin/schedules');
    assert.equal(tasks.response.status, 200);
    assert.deepEqual(tasks.data.schedules, []);
    assert.equal((await fixture.client().request('/skills')).response.status, 401);
    assert.equal((await member.request('/skills')).response.status, 403);
    skill = await createSkill({ name: 'fixture-audit' });
    assert.equal(skill.name, 'fixture-audit');
    assert.equal(skill.enabled, true);
    assert.ok(Number.isInteger(skill.version));
    const detail = await admin.request(`/skills/${skill.id}`);
    assert.equal(detail.response.status, 200);
    assert.match(detail.data.skill.content, /SKILL-BODY-CONTEXT-MARKER-49ba/);
    assert.equal((await member.request(`/skills/${skill.id}`)).response.status, 403);
    for (const [route, method, body] of [
      ['/admin/skills', 'POST', { name: 'member-forged-skill', description: 'Forbidden', content: skillBody }],
      [`/admin/skills/${skill.id}`, 'PATCH', { enabled: false }],
      [`/admin/skills/${skill.id}`, 'DELETE', {}],
    ]) assert.equal((await member.request(route, { method, body })).response.status, 403);
    const disposable = await createSkill({ name: 'disposable-fixture' });
    assert.equal((await admin.request(`/admin/skills/${disposable.id}`, { method: 'DELETE', body: {} })).response.status, 200);
    assert.equal((await admin.request(`/skills/${disposable.id}`)).response.status, 404);
  });

  it('makes skill descriptions discoverable to the real Pi model and loads bodies only when requested', async () => {
    const target = await session(admin, 'Skills discovery fixture');
    await admin.send(target.id, 'Describe the available tools without opening files.');
    const ordinaryRequest = JSON.stringify(fixture.mock.requests.at(-1));
    assert.ok(ordinaryRequest.includes(skill.name));
    assert.ok(ordinaryRequest.includes('Fixture skill description'));
    assert.ok(!ordinaryRequest.includes('SKILL-BODY-CONTEXT-MARKER-49ba'));
    const skillFile = path.join(fixture.dataDir, 'skills', skill.id, 'v1', 'SKILL.md');
    const loaded = await admin.send(target.id, `Please [read-path:${skillFile}].`);
    assert.match(deltaText(loaded), /SKILL-BODY-CONTEXT-MARKER-49ba/);
    assert.equal(loaded.find((event) => event.type === 'tool_end')?.isError, false);
    const privateRead = await admin.send(target.id, `Please [read-path:${path.join(fixture.dataDir, 'private-fixture.txt')}].`);
    assert.equal(privateRead.find((event) => event.type === 'tool_end')?.isError, true);
    assert.ok(!JSON.stringify(privateRead).includes('DATA-DIR-PRIVATE-MARKER-18cb'));
  });

  it('executes explicit skill IDs and slash commands through Pi without replacing the user task with the skill body', async () => {
    for (const slash of [false, true]) {
      const target = await session(admin, `Explicit skill ${slash}`);
      const userTask = slash ? `/skill:${skill.name} Read this actual task.` : 'Read this actual task with an explicit selected skill.';
      const events = await callSkill(target, userTask, slash ? undefined : skill.id);
      assert.ok(events.some((event) => event.type === 'done'));
      const request = fixture.mock.requests.at(-1);
      assert.match(JSON.stringify(request.messages.filter((message) => message.role === 'system' || message.role === 'developer')), /SKILL-BODY-CONTEXT-MARKER-49ba/);
      const stored = await member.request(`/sessions/${target.id}`);
      const user = stored.data.messages.find((message) => message.role === 'user');
      assert.equal(user.authorId, adminUser.id);
      assert.ok(user.content.includes('actual task'));
      assert.ok(!user.content.includes('SKILL-BODY-CONTEXT-MARKER-49ba'));
    }
  });

  it('allows members to invoke enabled skills while keeping management private', async () => {
    const target = await session(admin, 'Member skill invocation');
    const before = fixture.mock.requests.length;
    for (const body of [{ message: 'Use a skill.', skillId: skill.id }, { message: `/skill:${skill.name} Use a skill.` }]) {
      const response = await member.fetch(`/sessions/${target.id}/messages`, { method: 'POST', body });
      assert.equal(response.status, 200); await response.text();
    }
    assert.ok(fixture.mock.requests.length > before);
    await member.send(target.id, 'Show me ordinary tool assistance.');
    const request = JSON.stringify(fixture.mock.requests.at(-1));
    assert.ok(request.includes('Fixture skill description'));
    assert.ok(!request.includes('SKILL-BODY-CONTEXT-MARKER-49ba'));
    const forbidden = await member.send(target.id, `Please [read-path:${path.join(fixture.dataDir, 'skills', skill.id, 'v1', 'SKILL.md')}].`);
    assert.equal(forbidden.find((event) => event.type === 'tool_end')?.isError, false);
    assert.ok(JSON.stringify(forbidden).includes('SKILL-BODY-CONTEXT-MARKER-49ba'));
    const privateRead = await member.send(target.id, `Please [read-path:${path.join(fixture.dataDir, 'config.json')}].`);
    assert.equal(privateRead.find(event => event.type === 'tool_end')?.isError, true);
  });

  it('versions skill changes, rejects invalid content, and blocks disabled skills', async () => {
    const updated = await admin.request(`/admin/skills/${skill.id}`, { method: 'PATCH', body: { content: `${skillBody}\nUPDATED-SKILL-VERSION-216e\n` } });
    assert.equal(updated.response.status, 200, JSON.stringify(updated.data));
    assert.ok(updated.data.skill.version > skill.version);
    skill = updated.data.skill;
    const invalid = await admin.request(`/admin/skills/${skill.id}`, { method: 'PATCH', body: { content: '' } });
    assert.equal(invalid.response.status, 400);
    const disabled = await admin.request(`/admin/skills/${skill.id}`, { method: 'PATCH', body: { enabled: false } });
    assert.equal(disabled.response.status, 200);
    const target = await session(admin, 'Disabled skill call');
    const rejected = await admin.request(`/sessions/${target.id}/messages`, { method: 'POST', body: { message: 'Should not execute.', skillId: skill.id } });
    assert.ok([400, 409].includes(rejected.response.status), JSON.stringify(rejected.data));
    assert.equal((await admin.request(`/admin/skills/${skill.id}`, { method: 'PATCH', body: { enabled: true } })).response.status, 200);
  });

  it('keeps an in-flight skill snapshot readable across update and deletion without reusing its version file', async () => {
    const store = new Store(fixture.dataDir, fixture.workspace);
    let running;
    try {
      const sdk = await loadPi(process.env.PI_SDK_PATH || 'D:/code/pi/packages/coding-agent/dist/index.js');
      const catalog = new SkillCatalog(store);
      const original = await catalog.create({ name: 'immutable-snapshot-fixture', description: 'Snapshot regression fixture.', content: 'SNAPSHOT-ORIGINAL-V1-184e', enabled: true });
      const originalFile = path.join(fixture.dataDir, 'skills', original.id, 'v1', 'SKILL.md');
      const originalTask = `Please [read-path:${originalFile}].`;
      const [oldPrepared, updated] = await Promise.all([
        catalog.prepare(sdk, { message: originalTask, skillId: original.id, allowSkills: true }),
        catalog.update(original.id, { content: 'SNAPSHOT-UPDATED-V2-903c' }),
      ]);
      assert.equal(updated.version, 2);
      const currentPrepared = await catalog.prepare(sdk, { message: 'Use the current snapshot.', skillId: original.id, allowSkills: true });
      const currentFile = path.join(fixture.dataDir, 'skills', original.id, 'v2', 'SKILL.md');
      assert.ok(oldPrepared.skillFiles.includes(originalFile));
      assert.ok(!oldPrepared.skillFiles.includes(currentFile));
      assert.ok(currentPrepared.skillFiles.includes(currentFile));
      assert.match(oldPrepared.instructions, /SNAPSHOT-ORIGINAL-V1-184e/);
      assert.match(currentPrepared.instructions, /SNAPSHOT-UPDATED-V2-903c/);
      await catalog.remove(original.id);
      await assert.rejects(catalog.prepare(sdk, { message: 'A new invocation must fail.', skillId: original.id, allowSkills: true }), { status: 400 });
      assert.match(await readFile(originalFile, 'utf8'), /SNAPSHOT-ORIGINAL-V1-184e/);
      assert.match(await readFile(currentFile, 'utf8'), /SNAPSHOT-UPDATED-V2-903c/);

      const runtime = await createRuntime(sdk, store);
      running = (await sdk.createAgentSession({
        cwd: fixture.workspace, agentDir: path.join(fixture.dataDir, 'snapshot-agent'), modelRuntime: runtime,
        model: runtime.getModel(store.config.provider, store.config.model), thinkingLevel: 'off',
        ...await sessionTools(sdk, { cwd: fixture.workspace, dataDir: fixture.dataDir, mode: 'read-only', skillFiles: oldPrepared.skillFiles }),
        sessionManager: sdk.SessionManager.inMemory(fixture.workspace),
        settingsManager: sdk.SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: { mode: 'off' } }),
        resourceLoader: resourceLoader(sdk, store.config.systemPrompt, 'read-only', { skills: oldPrepared.skills, skillInstructions: oldPrepared.instructions }),
      })).session;
      await running.prompt(oldPrepared.message);
      const readResult = running.messages.find((message) => message.role === 'toolResult');
      assert.ok(readResult, 'The real Pi read tool must execute using the previously prepared snapshot');
      assert.equal(readResult.isError, false);
      assert.match(JSON.stringify(readResult.content), /SNAPSHOT-ORIGINAL-V1-184e/);
      assert.ok(!JSON.stringify(readResult.content).includes('SNAPSHOT-UPDATED-V2-903c'));
      assert.match(JSON.stringify(running.messages.at(-1).content), /SNAPSHOT-ORIGINAL-V1-184e/);
    } finally {
      running?.dispose();
      store.close();
    }
  });

  it('persists skills and pending schedules across restart, then claims a due occurrence exactly once', async () => {
    const due = new Date(fakeNow.getTime() + 60_000).toISOString();
    const pending = await task({ name: 'Once recovery fixture', scheduleType: 'once', runAt: due, enabled: true });
    assert.equal(pending.nextRunAt, due);
    await fixture.server.piWeb.schedules.tick();
    assert.equal((await admin.request(`/admin/schedules/${pending.id}/runs`)).data.runs.length, 0);
    await fixture.stop();
    fakeNow = new Date(fakeNow.getTime() + 61_000);
    await fixture.start();
    assert.equal((await admin.request('/auth/login', { method: 'POST', body: { username: 'skills-admin', password } })).response.status, 200);
    assert.equal((await member.request('/auth/login', { method: 'POST', body: { username: 'skills-member', password } })).response.status, 200);
    const loaded = await admin.request(`/skills/${skill.id}`);
    assert.match(loaded.data.skill.content, /UPDATED-SKILL-VERSION-216e/);
    await fixture.server.piWeb.schedules.tick();
    await fixture.server.piWeb.schedules.waitForIdle();
    const runs = (await admin.request(`/admin/schedules/${pending.id}/runs`)).data.runs;
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'succeeded', JSON.stringify(runs));
    await fixture.server.piWeb.schedules.tick();
    assert.equal((await admin.request(`/admin/schedules/${pending.id}/runs`)).data.runs.length, 1);
  });

  it('returns 202 for manual runs and stores real tools, shared messages and creator attribution', async () => {
    const scheduled = await task({ name: 'Real manual run fixture' });
    const started = await run(scheduled.id);
    const result = await waitForRun(scheduled.id, started.id);
    assert.equal(result.status, 'succeeded', JSON.stringify(result));
    assert.ok(result.sessionId);
    assert.equal((await member.request(`/sessions/${result.sessionId}`)).response.status,404);
    const detail = await admin.request(`/sessions/${result.sessionId}`);
    assert.equal(detail.response.status, 200);
    assert.match(JSON.stringify(detail.data.messages), /scheduled-real-workspace-content-06bc/);
    const user = detail.data.messages.find((message) => message.role === 'user');
    assert.equal(user.authorId, adminUser.id);
    assert.match(user.authorName, /任务/);
    assert.equal(result.requestedBy, adminUser.id);
    assert.equal(result.requestedByName, 'Skills Admin');
    assert.equal(detail.data.session.mode, 'read-only');
    const wire = fixture.mock.requests.at(-1);
    assert.match(JSON.stringify(wire.messages), /SKILL-BODY-CONTEXT-MARKER-49ba/);
    assert.ok(!wire.tools.some((tool) => ['write', 'edit', 'bash', 'powershell'].includes(tool.function.name)));
    const all = await admin.request('/admin/task-runs?limit=10');
    assert.ok(all.data.runs.some((entry) => entry.id === started.id));
  });

  it('records model errors and disabled skills as failed runs', async () => {
    const failing = await task({ name: 'Provider failure fixture', prompt: '[provider-error] fail this fixture.' });
    const first = await run(failing.id);
    const failed = await waitForRun(failing.id, first.id);
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /fixture provider failure/i);
    const disabledTask = await task({ name: 'Disabled skill fixture' });
    assert.equal((await admin.request(`/admin/skills/${skill.id}`, { method: 'PATCH', body: { enabled: false } })).response.status, 200);
    const before = fixture.mock.requests.length;
    const second = await run(disabledTask.id);
    const disabled = await waitForRun(disabledTask.id, second.id);
    assert.equal(disabled.status, 'failed');
    assert.ok(disabled.error);
    assert.equal(fixture.mock.requests.length, before);
    assert.equal((await admin.request(`/admin/skills/${skill.id}`, { method: 'PATCH', body: { enabled: true } })).response.status, 200);
  });

  it('prevents overlapping runs of the same task and cancels a real in-progress model request', async () => {
    const slow = await task({ name: 'Cancellation fixture', prompt: '[slow-response] cancellation-active-marker.' });
    const before = fixture.mock.requests.length;
    const first = await run(slow.id);
    await waitForRun(slow.id, first.id, ['running']);
    await waitForModelRequest(before, 'cancellation-active-marker');
    const repeated = await admin.request(`/admin/schedules/${slow.id}/run`, { method: 'POST', body: {} });
    assert.equal(repeated.response.status, 409, JSON.stringify(repeated.data));
    const cancelled = await admin.request(`/admin/task-runs/${first.id}/cancel`, { method: 'POST', body: {} });
    assert.equal(cancelled.response.status, 200);
    const result = await waitForRun(slow.id, first.id);
    assert.equal(result.status, 'cancelled', JSON.stringify(result));
    const after = await admin.request(`/admin/schedules/${slow.id}/runs`);
    assert.equal(after.data.runs.length, 1);
    const removed = await admin.request(`/admin/schedules/${slow.id}`, { method: 'DELETE', body: {} });
    assert.equal(removed.response.status, 200);
  });

  it('persists an interrupted active task on restart without automatically repeating its model request', async () => {
    const slow = await task({ name: 'Interrupted restart fixture', prompt: '[slow-response] restart-interrupted-marker.' });
    const before = fixture.mock.requests.length;
    const started = await run(slow.id);
    await waitForModelRequest(before, 'restart-interrupted-marker');
    await fixture.stop();
    await fixture.start();
    assert.equal((await admin.request('/auth/login', { method: 'POST', body: { username: 'skills-admin', password } })).response.status, 200);
    assert.equal((await member.request('/auth/login', { method: 'POST', body: { username: 'skills-member', password } })).response.status, 200);
    const saved = await waitForRun(slow.id, started.id);
    assert.equal(saved.status, 'interrupted', JSON.stringify(saved));
    assert.ok(saved.error);
    const requestCount = fixture.mock.requests.length;
    await fixture.server.piWeb.schedules.tick();
    await fixture.server.piWeb.schedules.waitForIdle();
    assert.equal(fixture.mock.requests.length, requestCount);
    assert.equal((await admin.request(`/admin/schedules/${slow.id}/runs`)).data.runs.length, 1);
  });

  it('blocks schedules owned by disabled creators before any model request', async () => {
    const other = await admin.request('/admin/users', { method: 'POST', body: { username: 'task-owner', displayName: 'Task Owner', password, role: 'admin' } });
    assert.equal(other.response.status, 201);
    const owner = fixture.client();
    assert.equal((await owner.request('/auth/login', { method: 'POST', body: { username: 'task-owner', password } })).response.status, 200);
    const owned = await task({ name: 'Disabled creator fixture' }, owner);
    assert.equal((await admin.request(`/admin/users/${other.data.user.id}`, { method: 'PATCH', body: { disabled: true } })).response.status, 200);
    const before = fixture.mock.requests.length;
    const started = await run(owned.id);
    const result = await waitForRun(owned.id, started.id);
    assert.equal(result.status, 'failed');
    assert.ok(result.error);
    assert.equal(fixture.mock.requests.length, before);
  });

  it('rejects member schedule access and malformed scheduling values', async () => {
    const scheduled = await task({ name: 'Permission fixture' });
    for (const [route, method, body] of [
      ['/admin/schedules', 'GET'], ['/admin/schedules', 'POST', {}],
      [`/admin/schedules/${scheduled.id}`, 'PATCH', { enabled: true }],
      [`/admin/schedules/${scheduled.id}`, 'DELETE', {}],
      [`/admin/schedules/${scheduled.id}/run`, 'POST', {}],
      [`/admin/schedules/${scheduled.id}/runs`, 'GET'], ['/admin/task-runs', 'GET'],
      ['/admin/task-runs/missing/cancel', 'POST', {}],
    ]) assert.equal((await member.request(route, { method, body })).response.status, 403, route);
    for (const values of [{ scheduleType: 'interval', intervalMinutes: 0 }, { scheduleType: 'daily', time: '25:80' }, { scheduleType: 'weekly', time: '09:00', weekdays: [7] }, { scheduleType: 'once', runAt: 'not-a-date' }]) {
      const result = await admin.request('/admin/schedules', { method: 'POST', body: { name: 'Invalid task', prompt: 'No execution', enabled: false, ...values } });
      assert.equal(result.response.status, 400, JSON.stringify(result.data));
    }
    const changed = await admin.request(`/admin/schedules/${scheduled.id}`, { method: 'PATCH', body: { name: 'Updated fixture', enabled: false } });
    assert.equal(changed.response.status, 200);
    assert.equal(changed.data.schedule.name, 'Updated fixture');
  });
});

describe('Asia/Shanghai schedule calculations', () => {
  it('computes daily, weekly, once and anchored intervals using Beijing civil time', async () => {
    const { nextOccurrence, mostRecentOccurrence } = await import('../lib/schedules.mjs');
    const daily = { scheduleType: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' };
    assert.equal(nextOccurrence(daily, new Date('2026-10-27T00:59:00Z')), '2026-10-27T01:00:00.000Z');
    assert.equal(nextOccurrence(daily, new Date('2026-10-27T01:00:00Z')), '2026-10-28T01:00:00.000Z');
    assert.equal(nextOccurrence(daily, new Date('2026-10-27T01:00:00Z'), { inclusive: true }), '2026-10-27T01:00:00.000Z');
    const weekly = { scheduleType: 'weekly', time: '09:00', weekdays: [1], timeZone: 'Asia/Shanghai' };
    assert.equal(nextOccurrence(weekly, new Date('2026-10-27T00:59:00Z')), '2026-11-02T01:00:00.000Z');
    assert.equal(mostRecentOccurrence(weekly, new Date('2026-10-27T00:59:00Z')), '2026-10-26T01:00:00.000Z');
    const once = { scheduleType: 'once', runAt: '2026-10-28T09:00:00+08:00' };
    assert.equal(nextOccurrence(once, new Date('2026-10-27T00:00:00Z')), '2026-10-28T01:00:00.000Z');
    assert.equal(nextOccurrence(once, new Date('2026-10-29T00:00:00Z')), null);
    const interval = { scheduleType: 'interval', intervalMinutes: 15, createdAt: '2026-10-27T01:00:00.000Z' };
    assert.equal(nextOccurrence(interval, new Date('2026-10-27T01:07:00Z')), '2026-10-27T01:15:00.000Z');
    assert.equal(nextOccurrence(interval, new Date('2026-10-27T01:15:00Z')), '2026-10-27T01:30:00.000Z');
    assert.equal(mostRecentOccurrence(interval, new Date('2026-10-27T01:31:00Z')), '2026-10-27T01:30:00.000Z');
  });
});

describe('Scheduled task runtime limit', { timeout: 30_000 }, () => {
  it('aborts a real streaming SDK request when the injected runtime deadline expires', async () => {
    const fixture = await createFixture({ prefix: 'task-deadline', options: { scheduler: { autoStart: false, maxRunMs: 800 } } });
    try {
      const admin = fixture.client();
      assert.equal((await admin.request('/auth/setup', { method: 'POST', body: { username: 'deadline-admin', displayName: 'Deadline Admin', password } })).response.status, 201);
      await configure(admin, fixture);
      const target = await session(admin, 'Deadline business group');
      const created = await admin.request('/admin/schedules', { method: 'POST', body: {
        targetSessionId: target.id,
        name: 'Runtime deadline fixture', prompt: '[slow-response] runtime-deadline-marker-91ec',
        scheduleType: 'interval', intervalMinutes: 1, enabled: false,
      } });
      assert.equal(created.response.status, 201, JSON.stringify(created.data));
      const started = await admin.request(`/admin/schedules/${created.data.schedule.id}/run`, { method: 'POST', body: {} });
      assert.equal(started.response.status, 202);
      await fixture.server.piWeb.schedules.waitForIdle();
      const runs = await admin.request(`/admin/schedules/${created.data.schedule.id}/runs`);
      assert.equal(runs.data.runs.length, 1);
      assert.equal(runs.data.runs[0].status, 'failed', JSON.stringify(runs.data));
      assert.match(runs.data.runs[0].error, /上限|超时|timeout/i);
      assert.ok(fixture.mock.requests.some((request) => JSON.stringify(request.messages).includes('runtime-deadline-marker-91ec')));
      const detail = await admin.request(`/sessions/${runs.data.runs[0].sessionId}`);
      assert.equal(detail.data.session.running, false);
    } finally { await fixture.close(); }
  });
});
