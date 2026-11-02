import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, scryptSync } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { collectSSE, configure, createFixture, deltaText, rawRequest, collaborativeSession as session, legacyCollaborativeSession, inviteAll } from './auth-helpers.mjs';

const adminPassword = 'Shared-admin-fixture-123!';
const memberPassword = 'Shared-member-fixture-123!';
const resetPassword = 'Shared-reset-fixture-123!';
const changedPassword = 'Shared-changed-fixture-123!';

describe('Authenticated company workspace', { concurrency: false, timeout: 120_000 }, () => {
  let fixture;
  let admin;
  let adminUser;
  let alice;
  let bob;
  let aliceUser;
  let bobUser;
  let aliceSession;
  let bobSession;

  before(async () => {
    fixture = await createFixture({ prefix: 'auth', options: { host: '0.0.0.0' } });
    admin = fixture.client();
    alice = fixture.client();
    bob = fixture.client();
    await writeFile(path.join(fixture.tempDir, 'outside-secret.txt'), 'outside-only-secret-f9ab-do-not-leak', 'utf8');
    await mkdir(path.join(fixture.tempDir, 'outside-dir'));
    await writeFile(path.join(fixture.tempDir, 'outside-dir', 'secret.txt'), 'junction-only-secret-91ea-do-not-leak', 'utf8');
  });
  after(async () => { await fixture?.close(); });

  it('requires authentication for all application and admin APIs', async () => {
    const status = await admin.request('/auth/status');
    assert.equal(status.response.status, 200);
    assert.equal(status.data.setupRequired, true);
    assert.equal(status.data.authenticated, false);
    assert.equal(status.data.user, null);
    assert.ok(status.data.workspace);
    for (const route of ['/status', '/config', '/models', '/sessions', '/admin/users', '/admin/sessions', '/admin/audit']) {
      const result = await admin.request(route);
      assert.equal(result.response.status, 401, `${route}: ${JSON.stringify(result.data)}`);
    }
    const post = await admin.request('/sessions', { method: 'POST', body: { title: 'Unauthenticated' } });
    assert.equal(post.response.status, 401);
  });

  it('allows LAN access while restricting first setup and rejecting untrusted origins', async (t) => {
    const port = fixture.server.address().port;
    const lan = Object.values(os.networkInterfaces()).flat().find((entry) => entry && entry.family === 'IPv4' && !entry.internal)?.address;
    if (lan) {
      const host = `${lan}:${port}`;
      const status = await rawRequest(fixture.baseUrl, '/auth/status', { headers: { host, origin: `http://${host}` } });
      assert.equal(status.status, 200, JSON.stringify(status.data));
      assert.equal(status.data.setupAllowed, false);
      const setup = await rawRequest(fixture.baseUrl, '/auth/setup', {
        method: 'POST', body: { username: 'remote-admin', displayName: 'Remote Admin', password: adminPassword },
        headers: { host, origin: `http://${host}` },
      });
      assert.equal(setup.status, 403, JSON.stringify(setup.data));
    } else t.diagnostic('No LAN interface present; loopback and Origin checks still ran.');
    const rebinding = await rawRequest(fixture.baseUrl, '/auth/status', { headers: { host: `untrusted.example:${port}` } });
    assert.equal(rebinding.status, 403);
    const origin = await admin.request('/auth/setup', {
      method: 'POST', body: { username: 'evil-admin', displayName: 'Evil Admin', password: adminPassword },
      headers: { origin: 'https://untrusted.example' },
    });
    assert.equal(origin.response.status, 403);
    const fetchSite = await admin.request('/auth/status', { headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(fetchSite.response.status, 403);
  });

  it('initializes exactly one administrator with a protected session cookie', async () => {
    const weak = await admin.request('/auth/setup', { method: 'POST', body: { username: 'admin', displayName: 'Admin', password: 'short' } });
    assert.equal(weak.response.status, 400);
    const setup = await admin.request('/auth/setup', { method: 'POST', body: {
      username: 'Company-Admin', displayName: 'Company Admin', password: adminPassword,
    } });
    assert.ok([200, 201].includes(setup.response.status), JSON.stringify(setup.data));
    assert.equal(setup.data.user?.role, 'admin');
    assert.equal(setup.data.user?.username, 'company-admin');
    adminUser = setup.data.user;
    const cookie = setup.response.headers.getSetCookie().join(';');
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
    assert.ok(admin.cookie.startsWith('pi_web_session='));
    const repeated = await fixture.client().request('/auth/setup', { method: 'POST', body: {
      username: 'another-admin', displayName: 'Another Admin', password: adminPassword,
    } });
    assert.equal(repeated.response.status, 409);
    const status = await admin.request('/auth/status');
    assert.equal(status.data.setupRequired, false);
    assert.equal(status.data.authenticated, true);
    assert.ok(!JSON.stringify(status.data).includes(adminPassword));
    await configure(admin, fixture);
  });

  it('creates employees using salted hashes and never returns passwords or login tokens', async () => {
    for (const [username, displayName] of [['alice', 'Alice Employee'], ['bob', 'Bob Employee']]) {
      const result = await admin.request('/admin/users', { method: 'POST', body: { username, displayName, password: memberPassword, role: 'member' } });
      assert.equal(result.response.status, 201, JSON.stringify(result.data));
      assert.equal(result.data.user?.role, 'member');
      if (username === 'alice') aliceUser = result.data.user;
      else bobUser = result.data.user;
      assert.ok(!JSON.stringify(result.data).includes(memberPassword));
      assert.ok(!JSON.stringify(result.data).includes('password_hash'));
    }
    const duplicate = await admin.request('/admin/users', { method: 'POST', body: { username: 'Alice', displayName: 'Duplicate', password: memberPassword, role: 'member' } });
    assert.equal(duplicate.response.status, 409);
    for (const [client, username] of [[alice, 'alice'], [bob, 'bob']]) {
      const login = await client.request('/auth/login', { method: 'POST', body: { username, password: memberPassword } });
      assert.equal(login.response.status, 200, JSON.stringify(login.data));
    }
    const db = new DatabaseSync(path.join(fixture.dataDir, 'workspace.sqlite'), { readOnly: true });
    try {
      const users = db.prepare('SELECT username,password_hash FROM users ORDER BY username').all();
      assert.equal(users.length, 3);
      assert.ok(users.every((row) => row.password_hash.startsWith('scrypt:')));
      assert.notEqual(users.find((row) => row.username === 'alice').password_hash, users.find((row) => row.username === 'bob').password_hash);
      assert.ok(!JSON.stringify(users).includes(memberPassword));
      const logins = db.prepare('SELECT token_hash FROM logins').all();
      assert.ok(!JSON.stringify(logins).includes(admin.cookie.split('=', 2)[1]));
    } finally { db.close(); }
    const users = await admin.request('/admin/users');
    assert.equal(users.response.status, 200);
    assert.equal(users.data.users.length, 3);
    assert.ok(!/password|token_hash|scrypt:/.test(JSON.stringify(users.data)));
  });

  it('allows administrators to create agents while employees can only join existing groups', async () => {
    const before = (await admin.request('/admin/sessions')).data.total;
    for (const client of [alice, bob]) {
      for (const body of [{}, { title: 'Employee-created agent' }]) {
        const result = await client.request('/sessions', { method: 'POST', body });
        assert.equal(result.response.status, 403, JSON.stringify(result.data));
      }
      assert.equal((await client.request('/sessions')).data.total, 0);
    }
    assert.equal((await admin.request('/admin/sessions')).data.total, before);
    const created = await admin.request('/sessions', { method: 'POST', body: { title: 'Administrator-created specialist' } });
    assert.equal(created.response.status, 201, JSON.stringify(created.data));
    assert.equal(created.data.session.ownerId, adminUser.id);
    const id = created.data.session.id;
    assert.equal((await alice.request(`/sessions/${id}`)).response.status, 404);
    assert.equal((await admin.request(`/sessions/${id}/members`, { method: 'POST', body: { userIds: [aliceUser.id] } })).response.status, 200);
    assert.equal((await alice.request(`/sessions/${id}`)).response.status, 200);
    await alice.send(id, 'An invited employee can use this administrator-created agent.');
  });

  it('lets everyone read shared topics and continue the same Pi context with real message authors', async () => {
    aliceSession = await legacyCollaborativeSession(fixture, alice, 'Alice shared conversation');
    bobSession = await legacyCollaborativeSession(fixture, bob, 'Bob shared conversation');
    assert.equal(path.dirname(aliceSession.cwd), fixture.workspace);
    assert.equal(path.dirname(bobSession.cwd), fixture.workspace);
    assert.notEqual(aliceSession.cwd, bobSession.cwd);
    await writeFile(path.join(aliceSession.cwd, 'fixture.txt'), 'shared-file-fixture-8ce2\n', 'utf8');
    await symlink(path.join(fixture.tempDir, 'outside-dir'), path.join(aliceSession.cwd, 'escape-junction'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(aliceSession.mode, 'read-only');
    assert.equal(bobSession.mode, 'read-only');
    await alice.send(aliceSession.id, 'Remember shared-alice-context-18c7.');
    const aliceRequest = fixture.mock.requests.at(-1);
    assert.match(JSON.stringify(aliceRequest.messages), /shared-alice-context-18c7/);
    await bob.send(aliceSession.id, 'Continue with shared-bob-context-bc82.');
    const bobRequest = fixture.mock.requests.at(-1);
    assert.match(JSON.stringify(bobRequest.messages), /shared-bob-context-bc82/);
    assert.match(JSON.stringify(bobRequest.messages), /shared-alice-context-18c7/);
    assert.deepEqual(bobRequest.messages.filter((message) => message.role === 'user').map((message) => wireText(message.content).replace(/^<server_runtime_notice>[\s\S]*?<\/server_runtime_notice>/, '')), [
      'Remember shared-alice-context-18c7.', 'Continue with shared-bob-context-bc82.',
    ]);
    await bob.send(bobSession.id, 'Separate topic marker separate-bob-topic-6e18.');
    assert.ok(!JSON.stringify(fixture.mock.requests.at(-1).messages).includes('shared-alice-context-18c7'));
    await alice.send(aliceSession.id, '[resume-check] Continue our shared conversation.');
    const resumed = fixture.mock.requests.at(-1);
    assert.match(JSON.stringify(resumed.messages), /shared-alice-context-18c7/);
    assert.match(JSON.stringify(resumed.messages), /shared-bob-context-bc82/);
    assert.ok(!JSON.stringify(resumed.messages).includes('separate-bob-topic-6e18'));
    for (const client of [alice, bob, admin]) {
      const list = await client.request('/sessions');
      assert.ok(list.data.sessions.some((entry) => entry.id === aliceSession.id));
      assert.ok(list.data.sessions.some((entry) => entry.id === bobSession.id));
      const detail = await client.request(`/sessions/${aliceSession.id}`);
      assert.equal(detail.response.status, 200);
      const first = detail.data.messages.find((message) => message.role === 'user' && message.content.includes('shared-alice-context-18c7'));
      const second = detail.data.messages.find((message) => message.role === 'user' && message.content.includes('shared-bob-context-bc82'));
      assert.equal(first?.authorId, aliceUser.id);
      assert.equal(first?.authorName, 'Alice Employee');
      assert.equal(second?.authorId, bobUser.id);
      assert.equal(second?.authorName, 'Bob Employee');
    }
  });

  it('persists every speaker across a restart without adding UI labels to model messages', async () => {
    await fixture.stop();
    await fixture.start();
    for (const [client, username, password] of [[admin, 'company-admin', adminPassword], [alice, 'alice', memberPassword], [bob, 'bob', memberPassword]]) {
      assert.equal((await client.request('/auth/login', { method: 'POST', body: { username, password } })).response.status, 200);
    }
    const detail = await bob.request(`/sessions/${aliceSession.id}`);
    assert.equal(detail.response.status, 200);
    const messages = detail.data.messages.filter((message) => message.role === 'user');
    assert.deepEqual(messages.slice(0, 2).map((message) => [message.authorId, message.authorName, message.content]), [
      [aliceUser.id, 'Alice Employee', 'Remember shared-alice-context-18c7.'],
      [bobUser.id, 'Bob Employee', 'Continue with shared-bob-context-bc82.'],
    ]);
    await bob.send(aliceSession.id, '[resume-check] Resume shared topic after restart.');
    const wireUsers = fixture.mock.requests.at(-1).messages.filter((message) => message.role === 'user').map((message) => wireText(message.content));
    assert.equal(wireUsers[0], 'Remember shared-alice-context-18c7.');
    assert.equal(wireUsers[1], 'Continue with shared-bob-context-bc82.');
  });

  it('uses the authenticated author and blocks employee configuration and workspace overrides', async () => {
    const spoofed = await alice.fetch(`/sessions/${bobSession.id}/messages`, { method: 'POST', body: {
      message: 'Spoof-attempt-marker-b1d2', authorId: bobUser.id, authorName: 'Forged Bob', userId: adminUser.id,
    } });
    assert.equal(spoofed.status, 200, spoofed.ok ? '' : await spoofed.text());
    await collectSSE(spoofed);
    const detail = await bob.request(`/sessions/${bobSession.id}`);
    const recorded = detail.data.messages.find((message) => message.role === 'user' && message.content.includes('Spoof-attempt-marker-b1d2'));
    assert.equal(recorded?.authorId, aliceUser.id);
    assert.equal(recorded?.authorName, 'Alice Employee');
    for (const route of ['/config', '/admin/users', '/admin/sessions', '/admin/audit']) {
      const result = await alice.request(route);
      assert.equal(result.response.status, 403, `${route}: ${JSON.stringify(result.data)}`);
    }
    const changed = await alice.request('/config', { method: 'PUT', body: { cwd: fixture.tempDir, mode: 'workspace' } });
    assert.equal(changed.response.status, 403);
    for (const body of [{ cwd: fixture.tempDir }, { mode: 'workspace' }]) {
      const override = await alice.request('/sessions', { method: 'POST', body: { title: 'Forbidden override', ...body } });
      assert.ok([400, 403].includes(override.response.status), JSON.stringify(override.data));
    }
  });

  it('runs overlapping shared topics without mixing their Pi context or creators', async () => {
    const first = await legacyCollaborativeSession(fixture, alice, 'Concurrent Alice session');
    const second = await legacyCollaborativeSession(fixture, bob, 'Concurrent Bob session');
    const timeline = [];
    const beforeRequests = fixture.mock.requests.length;
    const observe = (name) => (event) => {
      if (event.type === 'text_delta' && !timeline.includes(`start:${name}`)) timeline.push(`start:${name}`);
      if (event.type === 'done') timeline.push(`done:${name}`);
    };
    const [aliceEvents, bobEvents] = await Promise.all([
      alice.send(first.id, '[concurrent-response] parallel-alice-context-23d9', observe('alice')),
      bob.send(second.id, '[concurrent-response] parallel-bob-context-f501', observe('bob')),
    ]);
    assert.equal(timeline.slice(0, 2).filter((entry) => entry.startsWith('start:')).length, 2, JSON.stringify(timeline));
    assert.ok(aliceEvents.some((event) => event.type === 'done'));
    assert.ok(bobEvents.some((event) => event.type === 'done'));
    const requests = fixture.mock.requests.slice(beforeRequests);
    const aliceRequest = requests.find((request) => JSON.stringify(request.messages).includes('parallel-alice-context-23d9'));
    const bobRequest = requests.find((request) => JSON.stringify(request.messages).includes('parallel-bob-context-f501'));
    assert.ok(aliceRequest);
    assert.ok(bobRequest);
    assert.ok(!JSON.stringify(aliceRequest.messages).includes('parallel-bob-context-f501'));
    assert.ok(!JSON.stringify(bobRequest.messages).includes('parallel-alice-context-23d9'));
    const audit = await admin.request('/admin/sessions');
    assert.equal(audit.data.sessions.find((entry) => entry.id === first.id)?.ownerId, aliceUser.id);
    assert.equal(audit.data.sessions.find((entry) => entry.id === second.id)?.ownerId, bobUser.id);
  });

  it('admits only one concurrent prompt per session, then supports stopping and continuing it', async () => {
    const target = await legacyCollaborativeSession(fixture, alice, 'Concurrent prompts in one session');
    const responses = await Promise.all([
      alice.fetch(`/sessions/${target.id}/messages`, { method: 'POST', body: { message: '[slow-response] same-session-first-8a22' } }),
      alice.fetch(`/sessions/${target.id}/messages`, { method: 'POST', body: { message: '[slow-response] same-session-second-03d1' } }),
    ]);
    try {
      assert.deepEqual(responses.map((response) => response.status).sort((a, b) => a - b), [200, 409]);
      const conflict = responses.find((response) => response.status === 409);
      const error = await conflict.json();
      assert.equal(typeof error.error, 'string');
      const accepted = responses.find((response) => response.status === 200);
      let aborting;
      const events = await collectSSE(accepted, (event) => {
        if (event.type === 'text_delta' && !aborting) aborting = alice.request(`/sessions/${target.id}/abort`, { method: 'POST', body: {} });
      });
      assert.ok(aborting, 'The accepted SDK request must start streaming');
      assert.equal((await aborting).response.status, 200);
      assert.equal(events.find((event) => event.type === 'done')?.aborted, true, JSON.stringify(events));
      const continued = await alice.send(target.id, 'Continue after the concurrent request was rejected.');
      assert.match(deltaText(continued), /Pi SDK 已连接/);
      assert.equal(continued.find((event) => event.type === 'done')?.aborted, false);
    } finally {
      await alice.request(`/sessions/${target.id}/abort`, { method: 'POST', body: {} });
      await Promise.allSettled(responses.filter((response) => !response.bodyUsed).map((response) => response.body.cancel()));
    }
  });

  it('lets administrators join shared discussions and retains admin history filters and audits', async () => {
    const own = await admin.request('/sessions');
    assert.ok(own.data.sessions.some((entry) => entry.id === aliceSession.id));
    assert.ok(own.data.sessions.some((entry) => entry.id === bobSession.id));
    const all = await admin.request('/admin/sessions');
    assert.equal(all.response.status, 200);
    assert.ok(all.data.sessions.some((entry) => entry.id === aliceSession.id));
    assert.ok(all.data.sessions.some((entry) => entry.id === bobSession.id));
    const byOwner = await admin.request(`/admin/sessions?userId=${aliceUser.id}`);
    assert.ok(byOwner.data.sessions.some((entry) => entry.id === aliceSession.id));
    assert.ok(byOwner.data.sessions.some((entry) => entry.id === bobSession.id), 'Alice also contributed to Bob’s shared topic');
    const byName = await admin.request('/admin/sessions?q=Alice');
    assert.ok(byName.data.sessions.some((entry) => entry.id === aliceSession.id));
    assert.ok(byName.data.sessions.some((entry) => entry.id === bobSession.id), 'Search includes participants as well as topic creators');
    const byTitle = await admin.request('/admin/sessions?q=Alice%20shared%20conversation');
    assert.ok(byTitle.data.sessions.some((entry) => entry.id === aliceSession.id));
    assert.ok(!byTitle.data.sessions.some((entry) => entry.id === bobSession.id));
    const future = await admin.request(`/admin/sessions?from=${encodeURIComponent('2099-01-01T00:00:00.000Z')}`);
    assert.equal(future.data.sessions.length, 0);
    const before = await admin.request(`/admin/sessions?to=${encodeURIComponent('2000-01-01T00:00:00.000Z')}`);
    assert.equal(before.data.sessions.length, 0);
    const detail = await admin.request(`/admin/sessions/${aliceSession.id}`);
    assert.equal(detail.response.status, 200);
    assert.match(JSON.stringify(detail.data.messages), /shared-alice-context-18c7/);
    await admin.send(aliceSession.id, 'Admin contribution marker shared-admin-8fa1.');
    const joined = await alice.request(`/sessions/${aliceSession.id}`);
    const contribution = joined.data.messages.find((message) => message.role === 'user' && message.content.includes('shared-admin-8fa1'));
    assert.equal(contribution?.authorId, adminUser.id);
    assert.equal(contribution?.authorName, 'Company Admin');
    const audit = await admin.request('/admin/audit');
    assert.equal(audit.response.status, 200);
    assert.ok(JSON.stringify(audit.data).includes('session'));
    for (const secret of [adminPassword, memberPassword, 'shared-test-model-key-do-not-return', admin.cookie]) assert.ok(!JSON.stringify(audit.data).includes(secret));
  });

  it('allows only the current run initiator or an administrator to stop a shared task', async () => {
    for (const stopBy of ['initiator', 'admin']) {
      let stopping;
      let events;
      try {
        events = await bob.send(aliceSession.id, `[slow-response] Bob run stopped by ${stopBy}`, (event) => {
          if (event.type === 'text_delta' && !stopping) stopping = (async () => {
            const creatorAttempt = await alice.request(`/sessions/${aliceSession.id}/abort`, { method: 'POST', body: {} });
            const detail = await alice.request(`/sessions/${aliceSession.id}`);
            const stopped = await (stopBy === 'admin' ? admin : bob).request(`/sessions/${aliceSession.id}/abort`, { method: 'POST', body: {} });
            return { creatorAttempt, detail, stopped };
          })();
        });
        assert.ok(stopping);
        const result = await stopping;
        assert.equal(result.creatorAttempt.response.status, 403, JSON.stringify(result.creatorAttempt.data));
        assert.equal(result.detail.data.session.activeUserId, bobUser.id);
        assert.equal(result.detail.data.session.running, true);
        assert.equal(result.stopped.response.status, 200);
        assert.equal(events.find((event) => event.type === 'done')?.aborted, true, JSON.stringify(events));
      } finally {
        await admin.request(`/sessions/${aliceSession.id}/abort`, { method: 'POST', body: {} });
      }
    }
  });

  it('lets members use the administrator-configured shared execution mode', async () => {
    const updated = await admin.request('/config', { method: 'PUT', body: { mode: 'workspace' } });
    assert.equal(updated.response.status, 200);
    try {
      const elevated = await session(admin, 'Admin and members shared topic');
      assert.equal(elevated.mode, 'workspace');
      await admin.send(elevated.id, 'Admin workspace tool catalog marker-first.');
      let names = fixture.mock.requests.at(-1).tools.map((tool) => tool.function.name);
      assert.ok(names.includes('write') && names.includes('edit'));
      await alice.send(elevated.id, 'Member safely continues admin topic marker-second.');
      const memberRequest = fixture.mock.requests.at(-1);
      names = memberRequest.tools.map((tool) => tool.function.name);
      assert.ok(names.includes('read'));
      assert.ok(names.includes('write') && names.includes('edit'));
      const memberCreated=await alice.request('/sessions',{method:'POST',body:{title:'Member task'}});assert.equal(memberCreated.response.status,403);
      assert.match(JSON.stringify(memberRequest.messages), /marker-first/);
      await admin.send(elevated.id, 'Admin continues with own permissions marker-third.');
      names = fixture.mock.requests.at(-1).tools.map((tool) => tool.function.name);
      assert.ok(names.includes('write') && names.includes('edit'));
      const detail = await bob.request(`/sessions/${elevated.id}`);
      const authors = detail.data.messages.filter((message) => message.role === 'user').map((message) => message.authorId);
      assert.deepEqual(authors, [adminUser.id, aliceUser.id, adminUser.id]);
    } finally {
      assert.equal((await admin.request('/config', { method: 'PUT', body: { mode: 'read-only' } })).response.status, 200);
    }
  });

  it('runs guarded Pi tools against shared files and refuses parent paths and junction escapes', async () => {
    const allowed = await alice.send(aliceSession.id, 'Please [read-workspace].');
    assert.match(deltaText(allowed), /shared-file-fixture-8ce2/);
    for (const marker of ['[read-outside]', '[read-junction]']) {
      const events = await alice.send(aliceSession.id, `Please ${marker}.`);
      const toolEnd = events.find((event) => event.type === 'tool_end');
      assert.equal(toolEnd?.isError, true, JSON.stringify(events));
      const all = JSON.stringify({ events, request: fixture.mock.requests.at(-1) });
      assert.ok(!all.includes('outside-only-secret-f9ab-do-not-leak'));
      assert.ok(!all.includes('junction-only-secret-91ea-do-not-leak'));
      assert.ok(events.some((event) => event.type === 'done'));
    }
    const unsafeConfig = await admin.request('/config', { method: 'PUT', body: { cwd: fixture.tempDir } });
    assert.ok([400, 403].includes(unsafeConfig.response.status), 'The shared directory must not include the server credential directory');
  });

  it('exports an attributed and redacted transcript only for administrators and records the export', async () => {
    // This is a synthetic test credential, deliberately placed in a user message to verify redaction.
    await alice.send(aliceSession.id, 'Redaction fixture shared-test-model-key-do-not-return.');
    const exported = await admin.request(`/admin/sessions/${aliceSession.id}/export`);
    assert.equal(exported.response.status, 200, JSON.stringify(exported.data));
    assert.match(exported.response.headers.get('content-type'), /application\/json/);
    assert.equal(exported.response.headers.get('content-disposition'), `attachment; filename="pi-session-${aliceSession.id}.json"`);
    assert.ok(Number.isFinite(Date.parse(exported.data.exportedAt)));
    assert.ok(exported.data.workspace);
    assert.equal(exported.data.session.ownerId, aliceUser.id);
    assert.equal(exported.data.session.ownerName, 'Alice Employee');
    const text = JSON.stringify(exported.data);
    assert.match(text, /shared-alice-context-18c7/);
    const exportedAlice = exported.data.messages.find((message) => message.role === 'user' && message.content.includes('shared-alice-context-18c7'));
    const exportedBob = exported.data.messages.find((message) => message.role === 'user' && message.content.includes('shared-bob-context-bc82'));
    const exportedAdmin = exported.data.messages.find((message) => message.role === 'user' && message.content.includes('shared-admin-8fa1'));
    assert.equal(exportedAlice?.authorId, aliceUser.id);
    assert.equal(exportedAlice?.authorName, 'Alice Employee');
    assert.equal(exportedBob?.authorId, bobUser.id);
    assert.equal(exportedBob?.authorName, 'Bob Employee');
    assert.equal(exportedAdmin?.authorId, adminUser.id);
    assert.match(text, /\[REDACTED\]/);
    assert.ok(!text.includes('shared-test-model-key-do-not-return'));
    assert.ok(!text.includes(adminPassword));
    assert.ok(!text.includes(memberPassword));
    const forbidden = await alice.request(`/admin/sessions/${aliceSession.id}/export`);
    assert.equal(forbidden.response.status, 403);
    const audit = await admin.request('/admin/audit');
    const events = audit.data.events ?? audit.data.audit ?? [];
    assert.ok(events.some((event) => event.action === 'session.exported' && event.targetId === aliceSession.id && event.details.ownerId === aliceUser.id), JSON.stringify(audit.data));
  });

  it('revokes existing cookies when administrators disable or reset an employee account', async () => {
    const staleAlice = fixture.client();
    staleAlice.cookie = alice.cookie;
    let disabling;
    const interrupted = await alice.send(aliceSession.id, '[slow-response] running when account is disabled', (event) => {
      if (event.type === 'text_delta' && !disabling) disabling = admin.request(`/admin/users/${aliceUser.id}`, { method: 'PATCH', body: { disabled: true } });
    });
    assert.ok(disabling, 'The employee must start a real streaming SDK request before being disabled');
    const disabled = await disabling;
    assert.equal(disabled.response.status, 200);
    assert.equal(interrupted.find((event) => event.type === 'done')?.aborted, true, JSON.stringify(interrupted));
    assert.equal((await staleAlice.request('/sessions')).response.status, 401);
    const loginDisabled = await fixture.client().request('/auth/login', { method: 'POST', body: { username: 'alice', password: memberPassword } });
    assert.equal(loginDisabled.response.status, 401);
    const enabled = await admin.request(`/admin/users/${aliceUser.id}`, { method: 'PATCH', body: { disabled: false } });
    assert.equal(enabled.response.status, 200);
    assert.equal((await staleAlice.request('/sessions')).response.status, 401, 'Re-enabling must not revive revoked cookies');

    const staleBob = fixture.client();
    staleBob.cookie = bob.cookie;
    const reset = await admin.request(`/admin/users/${bobUser.id}`, { method: 'PATCH', body: { password: resetPassword, displayName: 'Bob Updated' } });
    assert.equal(reset.response.status, 200);
    assert.equal((await staleBob.request('/sessions')).response.status, 401);
    const wrong = await bob.request('/auth/login', { method: 'POST', body: { username: 'bob', password: memberPassword } });
    assert.equal(wrong.response.status, 401);
    const loggedIn = await bob.request('/auth/login', { method: 'POST', body: { username: 'bob', password: resetPassword } });
    assert.equal(loggedIn.response.status, 200);
    assert.equal(loggedIn.data.user.displayName, 'Bob Updated');
    const preserved = await bob.request(`/sessions/${bobSession.id}`);
    assert.equal(preserved.response.status, 200);
    assert.match(JSON.stringify(preserved.data.messages), /separate-bob-topic-6e18/);
  });

  it('requires the current password, revokes other logins on change, and invalidates logout cookies', async () => {
    const otherLogin = fixture.client();
    assert.equal((await otherLogin.request('/auth/login', { method: 'POST', body: { username: 'bob', password: resetPassword } })).response.status, 200);
    const oldCookie = otherLogin.cookie;
    const incorrect = await bob.request('/auth/password', { method: 'POST', body: { currentPassword: 'Incorrect-fixture-123!', newPassword: changedPassword } });
    assert.equal(incorrect.response.status, 400);
    const changed = await bob.request('/auth/password', { method: 'POST', body: { currentPassword: resetPassword, newPassword: changedPassword } });
    assert.equal(changed.response.status, 200);
    assert.equal((await bob.request('/sessions')).response.status, 200);
    assert.equal((await otherLogin.request('/sessions')).response.status, 401);
    assert.notEqual(bob.cookie, oldCookie);
    const stale = fixture.client();
    stale.cookie = bob.cookie;
    const logout = await bob.request('/auth/logout', { method: 'POST', body: {} });
    assert.equal(logout.response.status, 200);
    assert.equal((await stale.request('/sessions')).response.status, 401);
    const lastAdmin = await admin.request(`/admin/users/${(await admin.request('/auth/status')).data.user.id}`, { method: 'PATCH', body: { disabled: true } });
    assert.equal(lastAdmin.response.status, 409);
  });

  it('keeps authenticated mutations origin checked and admin audit credential free', async () => {
    const sameOrigin = await admin.request('/config', {
      method: 'PUT', body: { systemPrompt: 'Same-origin settings verification.' },
      headers: { origin: fixture.baseUrl },
    });
    assert.equal(sameOrigin.response.status, 200, JSON.stringify(sameOrigin.data));
    const rejectedConfig = await admin.request('/config', {
      method: 'PUT', body: { systemPrompt: 'Cross-origin overwrite must fail.' },
      headers: { origin: 'https://untrusted.example' },
    });
    assert.equal(rejectedConfig.response.status, 403);
    const config = await admin.request('/config', { headers: { origin: fixture.baseUrl } });
    assert.equal(config.response.status, 200);
    assert.equal(config.data.systemPrompt, 'Same-origin settings verification.');
    assert.ok(!JSON.stringify(config.data).includes('shared-test-model-key-do-not-return'));
    const wrongType = await admin.request('/config', { method: 'PUT', body: {}, headers: { 'content-type': 'application/jsonx' } });
    assert.equal(wrongType.response.status, 415);
    const forbidden = await admin.request('/admin/users', {
      method: 'POST', body: { username: 'csrf-user', displayName: 'CSRF User', password: memberPassword, role: 'admin' },
      headers: { origin: 'https://untrusted.example' },
    });
    assert.equal(forbidden.response.status, 403);
    const users = await admin.request('/admin/users');
    assert.equal(users.data.users.length, 3);
    const audit = await admin.request('/admin/audit');
    const text = JSON.stringify(audit.data);
    assert.ok(text.includes('user.password_changed'));
    for (const secret of [adminPassword, memberPassword, resetPassword, changedPassword, 'shared-test-model-key-do-not-return']) assert.ok(!text.includes(secret));
  });
});

describe('Legacy JSON session migration', { concurrency: false, timeout: 60_000 }, () => {
  let fixture;
  let legacy;
  before(async () => {
    fixture = await createFixture({ prefix: 'migration', seed: async ({ workspace, dataDir }) => {
      const sdk = await import(pathToFileURL(process.env.PI_SDK_PATH || 'D:/code/pi/packages/coding-agent/dist/index.js').href);
      const manager = sdk.SessionManager.create(workspace, path.join(dataDir, 'sessions'));
      manager.appendMessage({ role: 'user', content: 'legacy-original-message-c45e', timestamp: Date.now() });
      manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'legacy-original-response-a3f9' }], api: 'openai-completions', provider: 'custom', model: 'test-model',
        usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() });
      const now = new Date().toISOString();
      legacy = { id: manager.getSessionId(), title: 'Existing local conversation', createdAt: now, updatedAt: now, cwd: workspace, mode: 'read-only', provider: 'custom', model: 'test-model', messageCount: 2, file: manager.getSessionFile() };
      await writeFile(path.join(dataDir, 'sessions.json'), JSON.stringify([legacy]), 'utf8');
    } });
  });
  after(async () => { await fixture?.close(); });

  it('retains old transcripts, marks unknown ownership, and only migrates the index once', async () => {
    const admin = fixture.client();
    const setup = await admin.request('/auth/setup', { method: 'POST', body: { username: 'migration-admin', displayName: 'Migration Admin', password: adminPassword } });
    assert.ok([200, 201].includes(setup.response.status), JSON.stringify(setup.data));
    const list = await admin.request('/admin/sessions');
    assert.equal(list.response.status, 200);
    assert.equal(list.data.sessions.filter((entry) => entry.id === legacy.id).length, 1);
    const migrated = list.data.sessions.find((entry) => entry.id === legacy.id);
    assert.equal(migrated.legacyUnknownOwner, true);
    const detail = await admin.request(`/admin/sessions/${legacy.id}`);
    assert.equal(detail.response.status, 200);
    assert.match(JSON.stringify(detail.data.messages), /legacy-original-message-c45e/);
    assert.match(JSON.stringify(detail.data.messages), /legacy-original-response-a3f9/);
    const created = await admin.request('/admin/users', { method: 'POST', body: { username: 'migration-member', displayName: 'Migration Member', password: memberPassword, role: 'member' } });
    assert.equal(created.response.status, 201);
    const member = fixture.client();
    assert.equal((await member.request('/auth/login', { method: 'POST', body: { username: 'migration-member', password: memberPassword } })).response.status, 200);
    assert.ok(!(await member.request('/sessions')).data.sessions.some((entry) => entry.id === legacy.id));
    assert.equal((await member.request(`/sessions/${legacy.id}`)).response.status,404);
    const unknown=detail.data.messages.find(message=>message.role==='user');
    assert.equal(unknown.authorId,null);assert.equal(unknown.authorUnknown,true);
    await fixture.stop();
    await fixture.start();
    const login = await admin.request('/auth/login', { method: 'POST', body: { username: 'migration-admin', password: adminPassword } });
    assert.equal(login.response.status, 200);
    const reloaded = await admin.request('/admin/sessions');
    assert.equal(reloaded.data.sessions.filter((entry) => entry.id === legacy.id).length, 1);
    const transcript = await admin.request(`/admin/sessions/${legacy.id}`);
    assert.match(JSON.stringify(transcript.data.messages), /legacy-original-response-a3f9/);
    const original = transcript.data.messages.find((message) => message.role === 'user' && message.content.includes('legacy-original-message-c45e'));
    assert.equal(original.authorId, null);
    assert.equal(original.authorUnknown, true);

  });
});

describe('Version 0.2 owner metadata migration', { concurrency: false, timeout: 60_000 }, () => {
  let fixture;
  let legacy;
  const oldOwnerId = randomUUID();
  const oldAdminId = randomUUID();
  before(async () => {
    fixture = await createFixture({ prefix: 'owner-migration', seed: async ({ workspace, dataDir }) => {
      const sdk = await import(pathToFileURL(process.env.PI_SDK_PATH || 'D:/code/pi/packages/coding-agent/dist/index.js').href);
      const manager = sdk.SessionManager.create(workspace, path.join(dataDir, 'sessions'));
      manager.appendMessage({ role: 'user', content: 'old-owner-original-message-8c11', timestamp: Date.now() });
      manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'old-owner-original-response-f322' }], api: 'openai-completions', provider: 'custom', model: 'test-model',
        usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() });
      const now = new Date().toISOString();
      legacy = { id: manager.getSessionId(), title: 'Old owned conversation', createdAt: now, updatedAt: now, cwd: workspace, mode: 'read-only', provider: 'custom', model: 'test-model', messageCount: 2, file: manager.getSessionFile(), ownerId: oldOwnerId, workspaceId: 'company', legacyUnknownOwner: false };
      const db = new DatabaseSync(path.join(dataDir, 'workspace.sqlite'));
      try {
        db.exec(`CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
          role TEXT NOT NULL, password_hash TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0,
          auth_version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
          CREATE TABLE session_meta (id TEXT PRIMARY KEY, data TEXT NOT NULL);`);
        db.prepare('INSERT INTO metadata(key,value) VALUES (?,?)').run('session_index_migrated', '1');
        for (const [id, username, name, role, password] of [[oldOwnerId, 'old-member', 'Previous Employee', 'member', memberPassword], [oldAdminId, 'old-admin', 'Previous Admin', 'admin', adminPassword]]) {
          const salt = randomUUID().replaceAll('-', '');
          const derived = scryptSync(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
          db.prepare('INSERT INTO users(id,username,display_name,role,password_hash,created_at) VALUES (?,?,?,?,?,?)').run(id, username, name, role, `scrypt:${salt}:${derived.toString('hex')}`, now);
        }
        db.prepare('INSERT INTO session_meta(id,data) VALUES (?,?)').run(legacy.id, JSON.stringify(legacy));
      } finally { db.close(); }
    } });
  });
  after(async () => { await fixture?.close(); });

  it('uses known old ownership for historical speakers and persists later shared contributors', async () => {
    const member = fixture.client();
    const admin = fixture.client();
    assert.equal((await member.request('/auth/login', { method: 'POST', body: { username: 'old-member', password: memberPassword } })).response.status, 200);
    assert.equal((await admin.request('/auth/login', { method: 'POST', body: { username: 'old-admin', password: adminPassword } })).response.status, 200);
    const detail = await member.request(`/sessions/${legacy.id}`);
    assert.equal(detail.response.status, 200);
    const original = detail.data.messages.find((message) => message.role === 'user');
    assert.equal(original.authorId, oldOwnerId);
    assert.equal(original.authorName, 'Previous Employee');
    await configure(admin, fixture);
    await inviteAll(member,legacy.id);
    await admin.send(legacy.id, 'New admin continuation old-topic-shared-bba8.');
    await fixture.stop();
    await fixture.start();
    assert.equal((await member.request('/auth/login', { method: 'POST', body: { username: 'old-member', password: memberPassword } })).response.status, 200);
    const reloaded = await member.request(`/sessions/${legacy.id}`);
    const speakers = reloaded.data.messages.filter((message) => message.role === 'user');
    assert.deepEqual(speakers.map((message) => [message.authorId, message.authorName]), [[oldOwnerId, 'Previous Employee'], [oldAdminId, 'Previous Admin']]);
  });
});

function wireText(content) {
  return typeof content === 'string' ? content : (content ?? []).map((part) => part.text ?? '').join('');
}
