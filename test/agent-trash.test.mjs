import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { AgentTrashService } from '../lib/agent-trash.mjs';
import { createFixture, configure, session, collectSSE } from './auth-helpers.mjs';

const password = 'Agent-trash-fixture-2026!';
async function checked(client, route, options, status = 200) {
  const result = await client.request(route, options);
  assert.equal(result.response.status, status, JSON.stringify(result.data)); return result.data;
}
function database(f, operation) {
  const db = new DatabaseSync(path.join(f.dataDir, 'workspace.sqlite'));
  try { return operation(db); } finally { db.close(); }
}
async function setup(options = {}) {
  const f = await createFixture({ prefix: 'agent-trash', options: { scheduler: { autoStart: false }, channels: { autoStart: false }, workTasks: { pollIntervalMs: 20 }, ...options } });
  const admin = f.client();
  await checked(admin, '/auth/setup', { method: 'POST', body: { username: 'trash-admin', displayName: 'Administrator', password } }, 201);
  await configure(admin, f); return { f, admin };
}
async function until(check) {
  for (let i = 0; i < 300; i++) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 30)); }
  throw new Error('Task did not finish');
}

test('administrator trash/restore preserves conversations, files and memberships; permanent deletion cleans only the selected agent family', { timeout: 60000 }, async () => {
  const { f, admin } = await setup();
  try {
    const member = f.client(), otherAdmin = f.client();
    const employee = (await checked(admin, '/admin/users', { method: 'POST', body: { username: 'trash-employee', displayName: 'Employee', password, role: 'member' } }, 201)).user;
    await checked(admin, '/admin/users', { method: 'POST', body: { username: 'other-admin', displayName: 'Other Admin', password, role: 'admin' } }, 201);
    await checked(member, '/auth/login', { method: 'POST', body: { username: 'trash-employee', password } });
    await checked(otherAdmin, '/auth/login', { method: 'POST', body: { username: 'other-admin', password } });
    const a = await session(admin, 'Trash lifecycle agent'), b = await session(admin, 'Kept agent');
    await checked(admin, `/sessions/${a.id}/members`, { method: 'POST', body: { userIds: [employee.id] } });
    await checked(admin, `/sessions/${a.id}`, { method: 'PATCH', body: { mode: 'workspace' } });
    await fs.writeFile(path.join(a.cwd, 'fixture.txt'), 'AGENT-A-KEPT-UNTIL-PURGE');
    await fs.writeFile(path.join(b.cwd, 'keep.txt'), 'AGENT-B-NEVER-DELETE');
    await fs.symlink(b.cwd, path.join(a.cwd, 'other-agent-link'), process.platform === 'win32' ? 'junction' : 'dir');
    await admin.send(a.id, 'Conversation before trash lifecycle. [attach-file:fixture.txt]');
    const attachment = database(f, db => db.prepare('SELECT id FROM attachments WHERE session_id=?').get(a.id));
    assert.ok(attachment?.id);
    const task = (await checked(admin, `/sessions/${a.id}/tasks`, { method: 'POST', body: { instruction: '[read-workspace]' } }, 202)).task;
    await until(async () => (await checked(admin, `/sessions/${a.id}/tasks/${task.id}`)).task.status === 'succeeded');
    const family = database(f, db => db.prepare('SELECT data FROM session_meta').all().map(row => JSON.parse(row.data)).filter(row => row.id === a.id || row.taskTargetSessionId === a.id));
    assert.ok(family.length > 1);
    const schedule = (await checked(admin, '/admin/schedules', { method: 'POST', body: { name: 'Paused when trashed', targetSessionId: a.id, prompt: 'Check agent documents', scheduleType: 'daily', time: '23:56', enabled: true } }, 201)).schedule;
    const sharedSkill = (await checked(admin, '/admin/skills', { method: 'POST', body: { name: 'trash-shared-skill', description: 'Shared skill', content: 'Use assigned files.', scope: 'groups', groupIds: [a.id, b.id], enabled: true } }, 201)).skill;
    const privateSkill = (await checked(admin, '/admin/skills', { method: 'POST', body: { name: 'trash-private-skill', description: 'Private skill', content: 'Use assigned files.', scope: 'groups', groupIds: [a.id], enabled: true } }, 201)).skill;
    const globalSkill = (await checked(admin, '/admin/skills', { method: 'POST', body: { name: 'trash-global-skill', description: 'Global skill', content: 'Shared globally.', scope: 'all', enabled: true } }, 201)).skill;
    database(f, db => db.prepare('UPDATE skills SET group_ids_json=? WHERE id=?').run(JSON.stringify([a.id]), globalSkill.id));
    await checked(member, `/sessions/${a.id}`, { method: 'DELETE', body: {} }, 403);
    await checked(otherAdmin, `/sessions/${a.id}`, { method: 'DELETE', body: {} }, 404);
    await checked(member, '/admin/agent-trash', undefined, 403);
    const trashed = (await checked(admin, `/sessions/${a.id}`, { method: 'DELETE', body: {} })).agent;
    assert.equal(trashed.pausedScheduleCount, 1);
    assert.equal(await fs.readFile(path.join(a.cwd, 'fixture.txt'), 'utf8'), 'AGENT-A-KEPT-UNTIL-PURGE');
    assert.equal((await checked(admin, '/admin/schedules')).schedules.find(row => row.id === schedule.id).enabled, false);
    await checked(admin, `/admin/schedules/${schedule.id}/run`, { method: 'POST', body: {} }, 404);
    for (const client of [admin, member]) {
      assert.ok(!(await checked(client, '/sessions')).sessions.some(row => row.id === a.id));
      for (const suffix of ['', '/members', '/skills', '/tasks', '/profile', '/search?q=Conversation']) await checked(client, `/sessions/${a.id}${suffix}`, undefined, 404);
      assert.equal((await client.fetch(`/sessions/${a.id}/attachments/${attachment.id}`)).status, 404);
      await checked(client, `/sessions/${a.id}/messages`, { method: 'POST', body: { message: 'Should not execute' } }, 404);
    }
    assert.equal((await checked(otherAdmin, '/admin/agent-trash')).agents.length, 0);
    await checked(member, `/admin/agent-trash/${a.id}/restore`, { method: 'POST', body: { deletedAt: trashed.deletedAt } }, 403);
    await f.stop(); await f.start();
    assert.equal((await checked(admin, '/admin/agent-trash')).agents[0].id, a.id);
    const restored = await checked(admin, `/admin/agent-trash/${a.id}/restore`, { method: 'POST', body: { deletedAt: trashed.deletedAt } });
    assert.equal(restored.session.id, a.id); assert.equal(restored.session.cwd, a.cwd); assert.equal(restored.schedulesRemainPaused, true);
    assert.match(JSON.stringify((await checked(member, `/sessions/${a.id}`)).messages), /Conversation before trash/);
    assert.equal((await member.fetch(`/sessions/${a.id}/attachments/${attachment.id}`)).status, 200);
    const second = (await checked(admin, `/sessions/${a.id}`, { method: 'DELETE', body: {} })).agent;
    await checked(admin, `/admin/agent-trash/${a.id}`, { method: 'DELETE', body: { confirmTitle: 'wrong', deletedAt: second.deletedAt } }, 409);
    await checked(admin, `/admin/agent-trash/${a.id}`, { method: 'DELETE', body: { confirmTitle: a.title, deletedAt: trashed.deletedAt } }, 409);
    assert.equal(await fs.readFile(path.join(a.cwd, 'fixture.txt'), 'utf8'), 'AGENT-A-KEPT-UNTIL-PURGE');
    await checked(admin, `/admin/agent-trash/${a.id}`, { method: 'DELETE', body: { confirmTitle: a.title, deletedAt: second.deletedAt } });
    await assert.rejects(fs.stat(a.cwd), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.join(f.dataDir, 'attachments', `${attachment.id}.bin`)), { code: 'ENOENT' });
    for (const meta of family) if (meta.file) await assert.rejects(fs.stat(meta.file), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(b.cwd, 'keep.txt'), 'utf8'), 'AGENT-B-NEVER-DELETE');
    database(f, db => {
      for (const meta of family) assert.equal(db.prepare('SELECT id FROM session_meta WHERE id=?').get(meta.id), undefined);
      assert.equal(db.prepare('SELECT id FROM work_tasks WHERE id=?').get(task.id), undefined);
      assert.equal(db.prepare('SELECT id FROM schedules WHERE id=?').get(schedule.id), undefined);
      const shared = db.prepare('SELECT group_ids_json,enabled FROM skills WHERE id=?').get(sharedSkill.id);
      assert.deepEqual(JSON.parse(shared.group_ids_json), [b.id]); assert.equal(shared.enabled, 1);
      const own = db.prepare('SELECT group_ids_json,enabled,scope FROM skills WHERE id=?').get(privateSkill.id);
      assert.equal(own.scope, 'groups'); assert.equal(own.enabled, 0); assert.deepEqual(JSON.parse(own.group_ids_json), []);
      assert.equal(db.prepare('SELECT enabled FROM skills WHERE id=?').get(globalSkill.id).enabled, 1);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    });
    await checked(admin, `/admin/agent-trash/${a.id}/restore`, { method: 'POST', body: {} }, 404);
    await f.stop(); await f.start();
    assert.equal((await checked(admin, '/admin/agent-trash')).agents.length, 0);
    assert.equal((await checked(admin, `/sessions/${b.id}`)).session.id, b.id);
  } finally { await f.close(); }
});

test('deletion refuses active model work and queued work without changing the directory or membership', { timeout: 30000 }, async () => {
  const { f, admin } = await setup({ workTasks: { autoStart: false } });
  try {
    const a = await session(admin, 'Busy agent');
    const response = await admin.fetch(`/sessions/${a.id}/messages`, { method: 'POST', body: { message: '[slow-response]' } });
    await checked(admin, `/sessions/${a.id}`, { method: 'DELETE', body: {} }, 409);
    await checked(admin, `/sessions/${a.id}/abort`, { method: 'POST', body: {} }); await collectSSE(response);
    await checked(admin, `/sessions/${a.id}/tasks`, { method: 'POST', body: { instruction: 'Queued task' } }, 202);
    await checked(admin, `/sessions/${a.id}`, { method: 'DELETE', body: {} }, 409);
    assert.equal((await checked(admin, '/admin/agent-trash')).agents.length, 0);
    assert.equal((await fs.stat(a.cwd)).isDirectory(), true);
    const b = await session(admin, 'Legacy queued schedule');
    const schedule = (await checked(admin, '/admin/schedules', { method: 'POST', body: { name: 'Legacy scheduled run', targetSessionId: b.id, prompt: 'Check', scheduleType: 'daily', time: '23:55', enabled: false } }, 201)).schedule;
    const actor = (await checked(admin, '/auth/status')).user;
    database(f, db => db.prepare('INSERT INTO task_runs(id,schedule_id,schedule_name,status,requested_by,requested_by_name,trigger,created_at,snapshot_json) VALUES (?,?,?,?,?,?,?,?,NULL)').run(randomUUID(), schedule.id, schedule.name, 'queued', actor.id, actor.displayName, 'manual', new Date().toISOString()));
    await checked(admin, `/sessions/${b.id}`, { method: 'DELETE', body: {} }, 409);
  } finally { await f.close(); }
});

test('directory removal guard refuses factory, service, project and framework roots', async () => {
  const { f } = await setup();
  try {
    const project = path.join(f.tempDir, 'protected-project'), framework = path.join(f.tempDir, 'protected-framework');
    await fs.mkdir(project); await fs.mkdir(framework);
    await fs.writeFile(path.join(framework, 'engine.txt'), 'DO-NOT-DELETE');
    const store = { directory: f.dataDir, config: { cwd: f.workspace }, sessions: [] };
    const service = new AgentTrashService(store, { workspaces: {}, authorize: () => {}, protectedPaths: [project], protectedTrees: [framework] });
    for (const cwd of [f.tempDir, f.workspace, f.dataDir, project, framework, path.parse(f.tempDir).root]) await assert.rejects(service.directoryPlan({ id: 'guard-agent', cwd }), /受保护/);
    assert.equal(await fs.readFile(path.join(framework, 'engine.txt'), 'utf8'), 'DO-NOT-DELETE');
  } finally { await f.close(); }
});

test('permanent deletion refuses a replaced directory and recovers an interrupted cleanup after restart', { timeout: 30000 }, async () => {
  const { f, admin } = await setup();
  try {
    const a = await session(admin, 'Recovery agent');
    await fs.writeFile(path.join(a.cwd, 'result.txt'), 'Recoverable original');
    await admin.send(a.id, 'Recorded history for purge recovery');
    const trashed = (await checked(admin, `/sessions/${a.id}`, { method: 'DELETE', body: {} })).agent;
    const saved = `${a.cwd}-saved`;
    assert.equal(path.dirname(saved), f.workspace); assert.equal(path.dirname(a.cwd), f.workspace);
    await fs.rename(a.cwd, saved); await fs.mkdir(a.cwd);
    const body = { confirmTitle: a.title, deletedAt: trashed.deletedAt };
    await checked(admin, `/admin/agent-trash/${a.id}`, { method: 'DELETE', body }, 409);
    await checked(admin, `/admin/agent-trash/${a.id}/restore`, { method: 'POST', body: { deletedAt: trashed.deletedAt } }, 409);
    assert.equal(await fs.readFile(path.join(saved, 'result.txt'), 'utf8'), 'Recoverable original');
    await fs.rmdir(a.cwd); await fs.rename(saved, a.cwd);
    database(f, db => db.exec(`CREATE TRIGGER prevent_fixture_purge BEFORE DELETE ON session_meta WHEN OLD.id='${a.id}' BEGIN SELECT RAISE(ABORT,'fixture-purge-stop'); END;`));
    await checked(admin, `/admin/agent-trash/${a.id}`, { method: 'DELETE', body }, 500);
    await assert.rejects(fs.stat(a.cwd), { code: 'ENOENT' });
    const pending = (await checked(admin, '/admin/agent-trash')).agents[0]; assert.equal(pending.purging, true); assert.ok(pending.purgeError);
    await checked(admin, `/admin/agent-trash/${a.id}/restore`, { method: 'POST', body: {} }, 409);
    await f.stop(); database(f, db => db.exec('DROP TRIGGER prevent_fixture_purge')); await f.start();
    assert.equal((await checked(admin, '/admin/agent-trash')).agents.length, 0);
    assert.equal(database(f, db => db.prepare('SELECT id FROM session_meta WHERE id=?').get(a.id)), undefined);
  } finally { await f.close(); }
});
