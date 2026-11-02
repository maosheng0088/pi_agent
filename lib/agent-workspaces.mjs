import fs from 'node:fs/promises';
import path from 'node:path';
import { backup } from 'node:sqlite';
import { HttpError } from './security.mjs';
import { validateWorkspace } from './shared-tools.mjs';
import { writeJson } from './store.mjs';

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
const overlaps = (a, b) => within(a, b) || within(b, a);

/** One directory per business agent. Internal task sessions belong to their target agent. */
export class AgentWorkspaces {
  constructor(store) { this.store = store; this.pending = Promise.resolve(); }

  async exclusive(operation) {
    const previous = this.pending;
    let release;
    this.pending = new Promise(resolve => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }

  async directory(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > 4096 || !path.isAbsolute(value)) throw new HttpError(400, '工作目录必须是存在的绝对路径。');
    let stat;
    try { stat = await fs.stat(value); } catch { throw new HttpError(400, '工作目录不存在。'); }
    if (!stat.isDirectory()) throw new HttpError(400, '工作目录必须是文件夹。');
    return validateWorkspace(value, this.store.directory);
  }

  async managedDirectory(root, id) {
    if (!/^[a-z0-9-]{1,128}$/i.test(id)) throw new Error('智能体编号无效。');
    const destination = path.join(root, id);
    try { await fs.mkdir(destination); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // An interrupted allocation can leave an empty directory. Never adopt unrelated files.
      const stat = await fs.lstat(destination);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (await fs.readdir(destination)).length) throw new HttpError(409, '专属工作目录已被占用，请联系管理员检查。');
    }
    const canonical = await this.directory(destination);
    if (path.relative(root, canonical) !== id) throw new HttpError(400, '专属工作目录不能指向其他位置。');
    return canonical;
  }

  async initialize() {
    const store = this.store;
    const first = store.config.workspaceLayoutVersion !== 1;
    const oldDefault = path.resolve(store.config.cwd);
    const legacyDefault = first ? await fs.realpath(oldDefault) : oldDefault;
    const requestedRoot = first ? path.join(path.dirname(store.directory), 'workspaces') : oldDefault;
    await fs.mkdir(requestedRoot, { recursive: true });
    const root = await this.directory(requestedRoot);
    const groups = store.sessions.filter(meta => !meta.taskWorker && !meta.deletedAt);
    const original = new Map();
    for (const meta of groups) {
      try { original.set(meta.id, await this.directory(meta.cwd)); }
      catch (error) { throw new Error(`智能体 ${meta.id} 的工作目录无效，请先恢复目录：${error.message}`); }
    }
    const changes = [];
    const assigned = new Map();
    for (const meta of groups) {
      const current = original.get(meta.id);
      // Move the broader legacy directory, rather than moving an already independent
      // child directory merely because a newly imported legacy group points at its parent.
      const conflict = groups.some(other => other.id !== meta.id && within(current, original.get(other.id)));
      const mustAllocate = within(current, root) || (first && current === legacyDefault) || conflict;
      const cwd = mustAllocate ? await this.managedDirectory(root, meta.id) : current;
      if (cwd !== meta.cwd) changes.push({ id: meta.id, oldCwd: meta.cwd, cwd });
      assigned.set(meta.id, cwd);
    }
    // The factory root may contain agent directories, but cannot be inside an agent directory.
    for (const cwd of assigned.values()) if (within(cwd, root)) throw new Error('工作区根目录不能位于某个智能体的工作目录内。');
    const assignedPaths = [...assigned.values()];
    if (assignedPaths.some((cwd, index) => assignedPaths.slice(index + 1).some(other => overlaps(cwd, other)))) throw new Error('智能体工作目录仍有重叠，已停止加载。');
    for (const meta of store.sessions.filter(meta => meta.taskWorker)) {
      if (store.sessions.some(group => group.id === meta.taskTargetSessionId && group.deletedAt)) continue;
      const cwd = assigned.get(meta.taskTargetSessionId);
      if (!cwd) throw new Error(`任务会话 ${meta.id} 缺少所属智能体，无法确认工作目录。`);
      if (cwd !== meta.cwd) changes.push({ id: meta.id, oldCwd: meta.cwd, cwd, targetSessionId: meta.taskTargetSessionId });
    }
    if (changes.length) {
      const directory = path.join(store.directory, 'backups', `workspace-layout-${Date.now()}`);
      await fs.mkdir(directory, { recursive: true });
      await backup(store.db, path.join(directory, 'workspace.sqlite'));
      writeJson(path.join(directory, 'migration.json'), { createdAt: new Date().toISOString(), oldDefault, root, changes });
      for (const change of changes) store.sessions.find(meta => meta.id === change.id).cwd = change.cwd;
      store.saveSessions();
    }
    if (first || root !== store.config.cwd) store.saveConfig({ ...store.config, cwd: root, workspaceLayoutVersion: 1 });
  }

  async assertAvailable(cwd) {
    for (const meta of this.store.sessions.filter(meta => !meta.taskWorker)) {
      const existing = meta.deletedAt ? await fs.realpath(meta.cwd).catch(error => { if (error.code === 'ENOENT') return path.resolve(meta.cwd); throw error; }) : await this.directory(meta.cwd);
      if (overlaps(existing, cwd)) throw new HttpError(409, '工作目录与另一个智能体重叠，请选择独立文件夹。');
    }
  }

  async configureRoot(value, commit) {
    return this.exclusive(async () => {
      const root = await this.directory(value);
      for (const meta of this.store.sessions.filter(meta => !meta.taskWorker)) {
        const existing = meta.deletedAt ? path.resolve(meta.cwd) : await this.directory(meta.cwd);
        if (within(existing, root)) throw new HttpError(409, '工作区根目录不能位于某个智能体的工作目录内。');
      }
      return commit(root);
    });
  }

  async create({ id, cwd, targetSessionId }, commit) {
    return this.exclusive(async () => {
      let directory;
      if (targetSessionId) {
        const target = this.store.sessions.find(meta => meta.id === targetSessionId && !meta.taskWorker && !meta.deletedAt);
        if (!target) throw new HttpError(404, '任务所属智能体不存在。');
        directory = await this.directory(target.cwd);
      } else {
        directory = cwd === undefined
          ? await this.managedDirectory(await this.directory(this.store.config.cwd), id)
          : await this.directory(cwd);
        await this.assertAvailable(directory);
        if (within(directory, await this.directory(this.store.config.cwd))) throw new HttpError(409, '智能体工作目录不能包含工作区根目录。');
      }
      return commit(directory);
    });
  }
}
