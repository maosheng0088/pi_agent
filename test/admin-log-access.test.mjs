import assert from 'node:assert/strict';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { loadPi } from '../lib/pi.mjs';
import { configure, createFixture, session } from './auth-helpers.mjs';

const password = 'Admin-access-fixture-2026!';
const apiKey = 'shared-test-model-key-do-not-return';
const bearerSecret = 'fixture-admin-business-bearer-8e312d';
const printMarker = 'ISOLATED-BUSINESS-PRINT-d243';
async function checked(client, route, options = {}, status = 200) {
  const response = await client.request(route, options);
  assert.equal(response.response.status, status, `${route}: ${JSON.stringify(response.data)}`);
  return response.data;
}
async function until(check, message, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out: ${message}`);
}
async function setup(t) {
  const tasks = [];
  let started, release;
  const fixture = await createFixture({ prefix: 'admin-log-access',
    options: { scheduler: { autoStart: false }, channels: { autoStart: false }, workTasks: { autoStart: false }, business: { tasks } },
    seed: async ({ workspace }) => {
      const cwd = path.join(workspace, 'isolated-admin-log-business');
      await mkdir(cwd);
      started = path.join(cwd, 'started'); release = path.join(cwd, 'release');
      const scriptPath = path.join(cwd, 'fixture.mjs'), registrationPath = path.join(cwd, 'registration.json');
      await writeFile(registrationPath, JSON.stringify({ started, release }));
      await writeFile(scriptPath, `import fs from 'node:fs';
const config=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
console.log('${printMarker}');
console.log('${apiKey}');
console.log('Authorization: Bearer ${bearerSecret}');
fs.writeFileSync(config.started,'ready');
const timer=setInterval(()=>{if(fs.existsSync(config.release)){clearInterval(timer);console.log('ISOLATED-BUSINESS-END-d244');}},20);
`);
      tasks.push({ id: 'admin-access-business', name: 'Isolated administrator log task', source: 'fixture', projectVersion: 'fixture',
        pythonPath: process.execPath, scriptPath, cwd, registrationPath, args: [], timeoutSeconds: 30 });
    },
  });
  t.after(() => fixture.close());
  const owner = fixture.client(), auditor = fixture.client(), member = fixture.client(), outsider = fixture.client(), guest = fixture.client();
  const ownerUser = (await checked(owner, '/auth/setup', { method: 'POST', body: { username: 'access-owner', displayName: 'Owner', password } }, 201)).user;
  await configure(owner, fixture);
  const users = {};
  for (const [username, role, client] of [['access-auditor', 'admin', auditor], ['access-member', 'member', member], ['access-outsider', 'member', outsider]]) {
    users[username] = (await checked(owner, '/admin/users', { method: 'POST', body: { username, displayName: username, role, password } }, 201)).user;
    await checked(client, '/auth/login', { method: 'POST', body: { username, password } });
  }
  const group = await session(owner, 'Private audit target');
  const other = await session(owner, 'Other private audit target');
  await checked(owner, `/sessions/${group.id}/members`, { method: 'POST', body: { userIds: [users['access-member'].id] } });
  const startBusiness = async () => {
    const schedule = (await checked(owner, '/admin/schedules', { method: 'POST', body: { name: 'Isolated print access plan', taskType: 'business',
      businessTaskId: 'admin-access-business', targetSessionId: group.id, executionMode: 'workspace', prompt: 'Run only the isolated registered fixture.',
      scheduleType: 'daily', time: '09:00', enabled: false } }, 201)).schedule;
    const run = (await checked(owner, `/admin/schedules/${schedule.id}/run`, { method: 'POST', body: {} }, 202)).run;
    await until(() => access(started).then(() => true, () => false), 'the actual isolated process prints and starts');
    return run;
  };
  return { fixture, owner, auditor, member, outsider, guest, ownerUser, users, group, other, started, release, startBusiness };
}

test('global administrators can read another group’s real program output with redaction and fresh run metadata after IO', { timeout: 30000 }, async t => {
  const f = await setup(t);
  assert.equal((await f.auditor.request(`/sessions/${f.group.id}`)).response.status, 404);
  const run = await f.startBusiness();
  const route = `/admin/task-runs/${run.id}/log`;
  assert.equal((await f.guest.request(route)).response.status, 401);
  assert.equal((await f.member.request(route)).response.status, 403);
  const first = await checked(f.auditor, route);
  assert.deepEqual(first.run, { id: run.id, status: 'running', taskType: 'business', scheduleName: 'Isolated print access plan' });
  assert.equal(typeof first.truncated, 'boolean');
  assert.ok(first.content.includes(printMarker));
  for (const secret of [apiKey, bearerSecret]) assert.ok(!JSON.stringify(first).includes(secret), secret);
  assert.match(first.content, /redacted/i);

  const business = f.fixture.server.piWeb.businessTasks, originalRead = business.readLog;
  let entered = false, releaseRead;
  const gate = new Promise(resolve => { releaseRead = resolve; });
  business.readLog = async function (...args) { entered = true; await gate; return originalRead.apply(this, args); };
  const pending = f.auditor.request(route);
  try {
    await until(() => entered, 'program log read waits in controlled IO');
    await writeFile(f.release, 'finish the isolated process');
    await f.fixture.server.piWeb.schedules.waitForIdle();
    assert.equal(f.fixture.server.piWeb.schedules.getRun(run.id).status, 'succeeded');
    releaseRead();
    const result = await pending;
    assert.equal(result.response.status, 200);
    assert.equal(result.data.run.status, 'succeeded', 'metadata is read after asynchronous program log IO');
    assert.ok(result.data.content.includes('ISOLATED-BUSINESS-END-d244'));
    assert.ok(!JSON.stringify(result.data).includes(apiKey));
    assert.ok(!JSON.stringify(result.data).includes(bearerSecret));
  } finally { releaseRead(); business.readLog = originalRead; await pending.catch(() => {}); }
});

test('administrator permission invalidated during program log IO prevents the pending response from returning private output', { timeout: 30000 }, async t => {
  const f = await setup(t);
  const run = await f.startBusiness();
  const business = f.fixture.server.piWeb.businessTasks, originalRead = business.readLog;
  let entered = false, releaseRead;
  const gate = new Promise(resolve => { releaseRead = resolve; });
  business.readLog = async function (...args) { entered = true; await gate; return originalRead.apply(this, args); };
  const pending = f.auditor.request(`/admin/task-runs/${run.id}/log`);
  try {
    await until(() => entered, 'authenticated administrator log read is pending');
    await checked(f.owner, `/admin/users/${f.users['access-auditor'].id}`, { method: 'PATCH', body: { disabled: true } });
    releaseRead();
    const result = await pending;
    assert.ok([401, 403].includes(result.response.status));
    assert.ok(!JSON.stringify(result.data).includes(printMarker));
    assert.ok(!Object.hasOwn(result.data, 'content'));
  } finally {
    releaseRead(); business.readLog = originalRead; await pending.catch(() => {});
    await writeFile(f.release, 'finish isolated cleanup'); await f.fixture.server.piWeb.schedules.waitForIdle();
  }
});

test('administrator discussion history pages beyond one thousand records without overlap, gaps, or foreign group data', { timeout: 30000 }, async t => {
  const f = await setup(t);
  const db = new DatabaseSync(path.join(f.fixture.dataDir, 'workspace.sqlite'));
  const expected = [], foreign = [];
  let foreignCursor;
  try {
    const insert = db.prepare('INSERT INTO collaboration_messages(id,session_id,role,content,author_id,author_name,created_at) VALUES (?,?,?,?,?,?,?)');
    db.exec('BEGIN IMMEDIATE');
    for (let index = 0; index < 1007; index++) {
      const id = `admin-page-${index}`;
      expected.push(id);
      insert.run(id, f.group.id, 'user', `Discussion record ${index}`, f.users['access-member'].id, 'access-member', new Date(1000 + index).toISOString());
      if (index % 7 === 0) {
        const foreignId = `foreign-admin-page-${index}`;
        foreign.push(foreignId);
        insert.run(foreignId, f.other.id, 'user', `FOREIGN-GROUP-RECORD-${index}`, f.ownerUser.id, 'Owner', new Date(1000 + index).toISOString());
      }
    }
    db.exec('COMMIT');
    foreignCursor = db.prepare('SELECT seq FROM collaboration_messages WHERE id=?').get(foreign[50]).seq;
  } finally { db.close(); }

  const route = `/admin/sessions/${f.group.id}`;
  const first = await checked(f.auditor, route);
  assert.deepEqual(first.discussionPage, { total: 1007, hasMore: true, nextBefore: first.discussionPage.nextBefore });
  assert.ok(Number.isSafeInteger(first.discussionPage.nextBefore));
  const initial = first.messages.filter(message => message.id.startsWith('admin-page-'));
  assert.equal(initial.length, 1000);
  assert.equal(initial[0].id, 'admin-page-7'); assert.equal(initial.at(-1).id, 'admin-page-1006');
  const older = await checked(f.auditor, `${route}/discussion?before=${first.discussionPage.nextBefore}&limit=200`);
  assert.equal(older.total, 1007); assert.equal(older.hasMore, false); assert.equal(older.nextBefore, null);
  assert.deepEqual([...older.messages, ...initial].map(message => message.id), expected);

  const all = [];
  let before;
  do {
    const page = await checked(f.auditor, `${route}/discussion?limit=200${before === undefined ? '' : `&before=${before}`}`);
    assert.equal(page.total, 1007);
    assert.ok(page.messages.every(message => message.sessionId === f.group.id && !foreign.includes(message.id)));
    all.unshift(...page.messages.map(message => message.id));
    before = page.nextBefore;
    if (!page.hasMore) break;
    assert.ok(Number.isSafeInteger(before));
  } while (all.length < 2000);
  assert.deepEqual(all, expected); assert.equal(new Set(all).size, 1007);
  const cursorInOtherGroup = await checked(f.auditor, `${route}/discussion?limit=17&before=${foreignCursor}`);
  assert.equal(cursorInOtherGroup.messages.length, 17);
  assert.ok(cursorInOtherGroup.messages.every(message => message.sessionId === f.group.id && !message.content.includes('FOREIGN-GROUP-RECORD')));
  assert.deepEqual(await checked(f.auditor, `${route}/discussion?before=1`), { messages: [], total: 1007, hasMore: false, nextBefore: null });

  for (const query of ['before=0', 'before=-1', 'before=1.5', 'before=NaN', 'before=9007199254740992', 'before=', 'before=01',
    'limit=0', 'limit=1001', 'limit=1.5', 'limit=', 'limit=1&limit=2', 'before=2&before=3', `sessionId=${f.other.id}`]) {
    assert.equal((await f.auditor.request(`${route}/discussion?${query}`)).response.status, 400, query);
  }
  assert.equal((await f.guest.request(`${route}/discussion`)).response.status, 401);
  assert.equal((await f.member.request(`${route}/discussion`)).response.status, 403);
  assert.equal((await f.auditor.request(`/sessions/${f.group.id}`)).response.status, 404);
  assert.equal((await f.outsider.request(`/sessions/${f.group.id}/discussion`)).response.status, 404);
  assert.equal((await f.auditor.request('/admin/sessions/missing-audit-group/discussion')).response.status, 404);
});

test('administrator audit and export include real persisted SDK branches and pre-compaction originals while normal group history stays unchanged', { timeout: 30000 }, async t => {
  const f = await setup(t);
  await f.owner.send(f.group.id, 'Create the persisted isolated SDK file.');
  await f.fixture.stop();
  const db = new DatabaseSync(path.join(f.fixture.dataDir, 'workspace.sqlite'));
  const meta = JSON.parse(db.prepare('SELECT data FROM session_meta WHERE id=?').get(f.group.id).data);
  const sdk = await loadPi(process.env.PI_SDK_PATH || 'D:/code/pi/packages/coding-agent/dist/index.js');
  const manager = sdk.SessionManager.open(meta.file, path.join(f.fixture.dataDir, 'sessions'), meta.cwd);
  const oldUser = manager.appendMessage({ role: 'user', content: 'PRE-COMPACTION-ORIGINAL-USER-2ab', timestamp: Date.now() });
  const oldAnswer = manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: `PRE-COMPACTION-ORIGINAL-ANSWER-3bc ${apiKey}` }], timestamp: Date.now() + 1 });
  const compact = manager.appendCompaction('MODEL-CONTEXT-SUMMARY-ONLY-8db', null, 1000);
  const abandonedUser = manager.appendMessage({ role: 'user', content: 'ABANDONED-BRANCH-USER-4cd', timestamp: Date.now() + 2 });
  const abandonedAnswer = manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'ABANDONED-BRANCH-ANSWER-5de' }], timestamp: Date.now() + 3 });
  manager.branch(compact);
  const currentUser = manager.appendMessage({ role: 'user', content: 'CURRENT-BRANCH-USER-6ef', timestamp: Date.now() + 4 });
  const currentAnswer = manager.appendMessage({ role: 'assistant', content: [{ type: 'thinking', thinking: 'PRIVATE-THINKING-NOT-A-CHAT-991' }, { type: 'text', text: 'CURRENT-BRANCH-ANSWER-7fa' }], timestamp: Date.now() + 5 });
  const author = db.prepare('INSERT INTO session_authors(session_id,message_id,author_id,author_name,created_at) VALUES (?,?,?,?,?)');
  for (const id of [oldUser, abandonedUser, currentUser]) author.run(f.group.id, id, f.users['access-member'].id, 'access-member', new Date().toISOString());
  db.close();
  await f.fixture.start();

  const ordinaryBefore = await checked(f.member, `/sessions/${f.group.id}`);
  const audit = await checked(f.auditor, `/admin/sessions/${f.group.id}`);
  const exported = await checked(f.auditor, `/admin/sessions/${f.group.id}/export`);
  const ordinaryAfter = await checked(f.member, `/sessions/${f.group.id}`);
  assert.deepEqual(ordinaryAfter.messages, ordinaryBefore.messages);
  for (const id of [oldUser, oldAnswer, abandonedUser, abandonedAnswer, currentUser, currentAnswer]) {
    const durableId = `pi:${f.group.id}:${id}:0`;
    assert.ok(audit.messages.some(message => message.id === durableId), durableId);
    assert.ok(exported.messages.some(message => message.id === durableId), durableId);
  }
  for (const id of [oldUser, abandonedUser, currentUser]) assert.equal(audit.messages.find(message => message.id === `pi:${f.group.id}:${id}:0`).authorName, 'access-member');
  const normalText = JSON.stringify(ordinaryBefore.messages), auditText = JSON.stringify(audit.messages);
  for (const marker of ['PRE-COMPACTION-ORIGINAL-USER', 'PRE-COMPACTION-ORIGINAL-ANSWER', 'ABANDONED-BRANCH-USER', 'ABANDONED-BRANCH-ANSWER']) {
    assert.ok(auditText.includes(marker), marker); assert.ok(!normalText.includes(marker), marker);
  }
  assert.ok(normalText.includes('CURRENT-BRANCH-USER')); assert.ok(normalText.includes('CURRENT-BRANCH-ANSWER'));
  for (const value of [apiKey, 'PRIVATE-THINKING-NOT-A-CHAT-991', 'MODEL-CONTEXT-SUMMARY-ONLY-8db']) {
    assert.ok(!auditText.includes(value), value); assert.ok(!JSON.stringify(exported.messages).includes(value), value);
  }
  assert.equal((await f.auditor.request(`/sessions/${f.group.id}`)).response.status, 404);
  assert.equal((await f.member.request(`/admin/sessions/${f.group.id}`)).response.status, 403);
  assert.equal((await f.guest.request(`/admin/sessions/${f.group.id}`)).response.status, 401);
});
