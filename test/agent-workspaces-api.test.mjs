import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { configure, createFixture, session, deltaText } from './auth-helpers.mjs';
import { loadPi } from '../lib/pi.mjs';
import { sessionTools } from '../lib/shared-tools.mjs';

async function until(check) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const value = await check(); if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('Execution did not complete');
}

test('real Pi conversations, same-name files, work tasks and scheduled AI runs stay with their owning agent after restart', { timeout: 90_000 }, async () => {
  const f = await createFixture({ prefix: 'agent-directories', options: { scheduler: { autoStart: false }, channels: { autoStart: false }, workTasks: { pollIntervalMs: 20 } } });
  try {
    const admin = f.client(); const password = 'Workspace-api-test-2026!';
    await admin.request('/auth/setup', { method: 'POST', body: { username: 'workspace-admin', displayName: 'Admin', password } });
    await configure(admin, f);
    const a = await session(admin, 'Agent A'), b = await session(admin, 'Agent B');
    assert.notEqual(a.cwd, b.cwd); assert.equal(path.dirname(a.cwd), f.workspace);
    await fs.writeFile(path.join(a.cwd, 'fixture.txt'), 'ONLY_AGENT_A_8e751');
    await fs.writeFile(path.join(b.cwd, 'fixture.txt'), 'ONLY_AGENT_B_47d28');
    const sdk = await loadPi(process.env.PI_SDK_PATH || 'D:/code/pi/packages/coding-agent/dist/index.js');
    const scopedTools = await sessionTools(sdk, { cwd: a.cwd, dataDir: f.dataDir, mode: 'workspace' });
    const write = scopedTools.customTools.find(tool => tool.name === 'write');
    const edit = scopedTools.customTools.find(tool => tool.name === 'edit');
    await write.execute('write-own', { path: 'output/nested/result.txt', content: 'original' });
    await edit.execute('edit-own', { path: 'output/nested/result.txt', edits: [{ oldText: 'original', newText: 'edited' }] });
    assert.equal(await fs.readFile(path.join(a.cwd, 'output/nested/result.txt'), 'utf8'), 'edited');
    await assert.rejects(write.execute('write-other', { path: path.join(b.cwd, 'fixture.txt'), content: 'overwrite' }), /仅允许修改/);
    await assert.rejects(edit.execute('edit-other', { path: path.join(b.cwd, 'fixture.txt'), edits: [{ oldText: 'ONLY_AGENT_B_47d28', newText: 'overwrite' }] }), /仅允许修改/);
    assert.equal(await fs.readFile(path.join(b.cwd, 'fixture.txt'), 'utf8'), 'ONLY_AGENT_B_47d28');
    assert.match(deltaText(await admin.send(a.id, '[read-workspace] context-agent-a')), /ONLY_AGENT_A_8e751/);
    assert.match(deltaText(await admin.send(b.id, '[read-workspace] context-agent-b')), /ONLY_AGENT_B_47d28/);
    assert.doesNotMatch(JSON.stringify(f.mock.requests.at(-1).messages), /ONLY_AGENT_A_8e751|context-agent-a/);
    const rejected = await admin.send(b.id, `[read-path:${path.join(a.cwd, 'fixture.txt')}]`);
    assert.equal(rejected.find(e => e.type === 'tool_end')?.isError, true);
    assert.doesNotMatch(JSON.stringify(rejected), /ONLY_AGENT_A_8e751/);
    assert.equal((await admin.request('/sessions', { method: 'POST', body: { cwd: a.cwd } })).response.status, 409);
    // A client cannot mark an ordinary new group as an internal task to bypass the allocator.
    assert.equal((await admin.request('/sessions', { method: 'POST', body: { cwd: a.cwd, taskWorker: true, taskTargetSessionId: a.id } })).response.status, 409);
    const taskResponse = await admin.request(`/sessions/${a.id}/tasks`, { method: 'POST', body: { instruction: '[read-workspace]' } });
    assert.equal(taskResponse.response.status, 202, JSON.stringify(taskResponse.data));
    const task = await until(async () => {
      const value = (await admin.request(`/sessions/${a.id}/tasks/${taskResponse.data.task.id}`)).data.task;
      return ['succeeded', 'failed'].includes(value.status) && value;
    });
    assert.equal(task.status, 'succeeded'); assert.match(JSON.stringify(task), /ONLY_AGENT_A_8e751/);
    const skill = (await admin.request('/admin/skills', { method: 'POST', body: { name: 'workspace-check', description: 'Read the agent fixture file', content: 'Read fixture.txt in the current agent directory.', enabled: true } })).data.skill;
    const scheduleResponse = await admin.request('/admin/schedules', { method: 'POST', body: { name: 'Agent B directory check', skillId: skill.id, prompt: '[read-workspace]', targetSessionId: b.id, scheduleType: 'daily', time: '09:30', enabled: false } });
    assert.equal(scheduleResponse.response.status, 201, JSON.stringify(scheduleResponse.data));
    const schedule = scheduleResponse.data.schedule;
    const triggered = await admin.request(`/admin/schedules/${schedule.id}/run`, { method: 'POST', body: {} });
    assert.equal(triggered.response.status, 202, JSON.stringify(triggered.data));
    const run = await until(async () => {
      const value = (await admin.request(`/admin/schedules/${schedule.id}/runs`)).data.runs.find(entry => entry.id === triggered.data.run.id);
      return value && ['succeeded', 'failed'].includes(value.status) && value;
    });
    assert.equal(run.status, 'succeeded');
    const db = new DatabaseSync(path.join(f.dataDir, 'workspace.sqlite'), { readOnly: true });
    try {
      const rows = db.prepare('SELECT data FROM session_meta').all().map(row => JSON.parse(row.data));
      assert.equal(rows.find(row => row.workTaskId === task.id)?.cwd, a.cwd);
      assert.equal(rows.find(row => row.taskRunId === run.id)?.cwd, b.cwd);
    } finally { db.close(); }
    await admin.request(`/sessions/${a.id}`, { method: 'PATCH', body: { title: 'Renamed Agent A' } });
    await f.stop(); await f.start();
    const detail = (await admin.request(`/sessions/${a.id}`)).data;
    assert.equal(detail.session.cwd, a.cwd); assert.equal(detail.session.title, 'Renamed Agent A');
    assert.match(JSON.stringify(detail.messages), /context-agent-a/);
    assert.match(deltaText(await admin.send(a.id, '[read-workspace]')), /ONLY_AGENT_A_8e751/);
    assert.match(deltaText(await admin.send(b.id, '[read-workspace]')), /ONLY_AGENT_B_47d28/);
  } finally { await f.close(); }
});
