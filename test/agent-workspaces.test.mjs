import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Store } from '../lib/store.mjs';
import { AgentWorkspaces } from '../lib/agent-workspaces.mjs';
import { sessionTools } from '../lib/shared-tools.mjs';

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-agent-workspaces-'));
  const legacy = path.join(directory, 'legacy'); await fs.mkdir(legacy);
  const store = new Store(path.join(directory, 'data'), legacy);
  const service = new AgentWorkspaces(store);
  const create = (options = {}) => {
    const id = randomUUID();
    return service.create({ id, ...options }, cwd => {
      const meta = { id, cwd, ...(options.targetSessionId ? { taskWorker: true, taskTargetSessionId: options.targetSessionId } : {}) };
      store.sessions.push(meta); store.saveSessions(); return meta;
    });
  };
  return { directory, legacy, store, service, create, async close() {
    store.db.close();
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.ok(path.basename(directory).startsWith('pi-agent-workspaces-'));
    await fs.rm(directory, { recursive: true, force: true });
  } };
}

test('legacy shared directories split without moving originals or changing session identity; dedicated directories and task ownership survive restart', async () => {
  const f = await fixture();
  try {
    const dedicated = path.join(f.directory, 'dedicated'); await fs.mkdir(dedicated);
    await fs.writeFile(path.join(f.legacy, 'unclassified.txt'), 'legacy bytes');
    f.store.sessions = [
      { id: randomUUID(), cwd: f.legacy, title: 'First', file: 'first.jsonl' },
      { id: randomUUID(), cwd: f.legacy, title: 'Second', file: 'second.jsonl' },
      { id: randomUUID(), cwd: dedicated, title: 'Dedicated' },
    ];
    const [first, second, own] = f.store.sessions;
    const worker = { id: randomUUID(), cwd: f.legacy, taskWorker: true, taskTargetSessionId: first.id };
    f.store.sessions.push(worker); f.store.saveSessions();
    await f.service.initialize();
    assert.equal(first.cwd, path.join(f.directory, 'workspaces', first.id));
    assert.notEqual(first.cwd, second.cwd); assert.equal(own.cwd, dedicated);
    assert.equal(worker.cwd, first.cwd); assert.equal(first.file, 'first.jsonl');
    assert.equal(await fs.readFile(path.join(f.legacy, 'unclassified.txt'), 'utf8'), 'legacy bytes');
    assert.equal((await fs.readdir(first.cwd)).length, 0);
    const snapshot = JSON.stringify(f.store.sessions);
    await f.service.initialize(); assert.equal(JSON.stringify(f.store.sessions), snapshot);
    const backups = await fs.readdir(path.join(f.store.directory, 'backups')); assert.equal(backups.length, 1);
    const report = JSON.parse(await fs.readFile(path.join(f.store.directory, 'backups', backups[0], 'migration.json')));
    assert.equal(report.changes.length, 3);
    first.title = 'Renamed'; f.store.saveSessions();
    await f.service.initialize(); assert.equal(first.cwd, path.join(f.directory, 'workspaces', first.id));
    await fs.writeFile(path.join(first.cwd, 'keep.txt'), 'existing independent output');
    const imported = { id: randomUUID(), cwd: f.store.config.cwd };
    f.store.sessions.push(imported); f.store.saveSessions();
    await f.service.initialize();
    assert.equal(imported.cwd, path.join(f.store.config.cwd, imported.id));
    assert.equal(await fs.readFile(path.join(first.cwd, 'keep.txt'), 'utf8'), 'existing independent output');
  } finally { await f.close(); }
});

test('new agents use disjoint directories; concurrent custom allocations reject overlap; only internal workers reuse their owner directory', async () => {
  const f = await fixture();
  try {
    await f.service.initialize();
    const [a, b] = await Promise.all([f.create(), f.create()]);
    assert.notEqual(a.cwd, b.cwd);
    await fs.writeFile(path.join(a.cwd, 'result.txt'), 'A');
    await fs.writeFile(path.join(b.cwd, 'result.txt'), 'B');
    assert.equal(await fs.readFile(path.join(a.cwd, 'result.txt'), 'utf8'), 'A');
    assert.equal((await f.create({ targetSessionId: a.id })).cwd, a.cwd);
    await assert.rejects(f.create({ targetSessionId: 'unknown' }), /不存在/);
    await assert.rejects(f.create({ cwd: a.cwd }), /重叠/);
    await assert.rejects(f.service.configureRoot(a.cwd, () => {}), /不能位于/);
    const child = path.join(a.cwd, 'child'); await fs.mkdir(child);
    await assert.rejects(f.create({ cwd: child }), /重叠/);
    const custom = path.join(f.directory, 'custom'); await fs.mkdir(custom);
    const concurrent = await Promise.allSettled([f.create({ cwd: custom }), f.create({ cwd: custom })]);
    assert.equal(concurrent.filter(r => r.status === 'fulfilled').length, 1);
    assert.match(concurrent.find(r => r.status === 'rejected').reason.message, /重叠/);
    const alias = path.join(f.directory, 'alias');
    await fs.symlink(a.cwd, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(f.create({ cwd: alias }), /重叠/);
    await assert.rejects(f.service.configureRoot(f.directory, () => {}), /服务数据目录/);
    const nextRoot = path.join(f.directory, 'new-root'); await fs.mkdir(nextRoot);
    await f.service.configureRoot(nextRoot, cwd => f.store.saveConfig({ ...f.store.config, cwd }));
    assert.equal((await f.create()).cwd.startsWith(nextRoot + path.sep), true);
    assert.equal(await fs.readFile(path.join(a.cwd, 'result.txt'), 'utf8'), 'A');
  } finally { await f.close(); }
});

test('write and edit reject other agents, service files, junctions and hard links while allowing new nested output files', async () => {
  const f = await fixture();
  try {
    await f.service.initialize(); const a = await f.create(), b = await f.create();
    await fs.writeFile(path.join(b.cwd, 'result.txt'), 'B');
    const sdk = Object.fromEntries(['Read', 'Ls', 'Find', 'Grep', 'Write', 'Edit', 'PowerShell', 'Bash'].map(name => [`create${name}ToolDefinition`, () => ({ name: name.toLowerCase(), description: '', execute: async (_id, args) => args.path })]));
    const tools = await sessionTools(sdk, { cwd: a.cwd, dataDir: f.store.directory, mode: 'workspace' });
    const run = (name, file) => tools.customTools.find(tool => tool.name === name).execute('test', { path: file });
    await fs.symlink(b.cwd, path.join(a.cwd, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    await fs.link(path.join(b.cwd, 'result.txt'), path.join(a.cwd, 'hardlink.txt'));
    for (const name of ['write', 'edit']) {
      for (const file of [path.join(b.cwd, 'result.txt'), '../other.txt', path.join(f.store.directory, 'config.json'), 'escape/new/file.txt', 'hardlink.txt']) await assert.rejects(run(name, file), /仅允许|拒绝/);
      assert.equal(await run(name, 'output/new/result.txt'), path.join(a.cwd, 'output/new/result.txt'));
    }
    assert.ok(tools.tools.includes(process.platform === 'win32' ? 'powershell' : 'bash'));
    assert.equal(await fs.readFile(path.join(b.cwd, 'result.txt'), 'utf8'), 'B');
  } finally { await f.close(); }
});
