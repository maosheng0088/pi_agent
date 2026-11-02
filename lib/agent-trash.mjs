import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { HttpError } from './security.mjs';

const idPattern = /^[a-z0-9-]{1,128}$/i;
const within = (root, value) => { const relative = path.relative(root, value); return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
const overlap = (a, b) => within(a, b) || within(b, a);
const unavailable = () => new HttpError(404, '智能体不存在或不在垃圾箱中。');
const identifier = value => `"${value.replaceAll('"', '""')}"`;

/** Tombstones retain ownership and files. Purge intents persist before filesystem changes. */
export class AgentTrashService {
  constructor(store, { workspaces, authorize, suspendChannels = () => {}, busy = () => false, audit = () => {}, protectedPaths = [], protectedTrees = [] }) {
    this.store = store; this.db = store.db; this.workspaces = workspaces; this.authorize = authorize;
    this.suspendChannels = suspendChannels; this.busy = busy; this.audit = audit;
    this.protectedPaths = [store.directory, os.homedir(), ...protectedPaths].map(value => path.resolve(value));
    this.protectedTrees = [store.directory, ...protectedTrees.filter(Boolean)].map(value => path.resolve(value));
  }
  family(meta) { return [meta, ...this.store.sessions.filter(row => row.taskWorker && row.taskTargetSessionId === meta.id)]; }
  require(id, actor, trashed) {
    const meta = this.store.sessions.find(row => row.id === id && !row.taskWorker);
    if (!meta || Boolean(meta.deletedAt) !== trashed) throw unavailable();
    this.authorize(meta, actor); return meta;
  }
  view(meta) {
    return { id: meta.id, title: meta.title, avatarId: meta.avatarId || '', deletedAt: meta.deletedAt,
      deletedByName: meta.deletedByName, cwd: meta.cwd, pausedScheduleCount: meta.trash?.pausedScheduleIds?.length || 0,
      purging: Boolean(meta.purgePending), purgeError: meta.purgeError || '' };
  }
  list(actor) {
    this.authorize(null, actor);
    return this.store.sessions.filter(meta => {
      if (meta.taskWorker || !meta.deletedAt) return false;
      try { this.authorize(meta, actor); return true; } catch (error) { if ([401, 403, 404].includes(error.status)) return false; throw error; }
    }).sort((a, b) => b.deletedAt.localeCompare(a.deletedAt)).map(meta => this.view(meta));
  }
  table(name) { return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)); }
  assertIdle(meta) {
    const ids = this.family(meta).map(row => row.id), placeholders = ids.map(() => '?').join(',');
    if (this.busy(ids)) throw new HttpError(409, '此智能体仍有任务执行或排队，请先停止任务，再移入垃圾箱或永久删除。');
    for (const [table, column, states] of [
      ['work_tasks', 'session_id', ['queued', 'running', 'cancelling']],
      ['execution_traces', 'session_id', ['running', 'starting', 'cancelling']],
      ['email_drafts', 'session_id', ['sending']],
      ['im_channel_outbox', 'session_id', ['sending']], ['wecom_outbox', 'session_id', ['sending']],
    ]) if (this.table(table) && this.db.prepare(`SELECT 1 FROM ${table} WHERE ${column} IN (${placeholders}) AND status IN (${states.map(() => '?').join(',')}) LIMIT 1`).get(...ids, ...states)) throw new HttpError(409, '此智能体仍有任务或消息正在执行，请先停止任务，再重试。');
    if (this.table('task_runs') && this.db.prepare(`SELECT 1 FROM task_runs WHERE status IN ('queued','running') AND (session_id IN (${placeholders}) OR schedule_id IN (SELECT id FROM schedules WHERE target_session_id=?) OR CASE WHEN json_valid(snapshot_json) THEN json_extract(snapshot_json,'$.targetSessionId') END=?) LIMIT 1`).get(...ids, meta.id, meta.id)) throw new HttpError(409, '此智能体的定时任务正在执行或排队，请先取消本次运行。');
  }
  async directoryPlan(meta, expected, missingAllowed = false) {
    if (!idPattern.test(meta.id) || !path.isAbsolute(meta.cwd)) throw new HttpError(409, '智能体工作目录无效，已停止删除。');
    const cwd = path.resolve(meta.cwd);
    // An agent directory must never be a drive root, the project, shared factory,
    // service storage, home, or framework/OS installation directory.
    const protectedPaths = [...this.protectedPaths, path.resolve(this.store.config.cwd)];
    if (cwd === path.parse(cwd).root || protectedPaths.some(value => within(cwd, value)) || this.protectedTrees.some(value => overlap(value, cwd))) throw new HttpError(409, '工作目录包含受保护的共享文件，已停止删除。');
    for (const other of this.store.sessions.filter(row => !row.taskWorker && row.id !== meta.id)) {
      const real = await fs.realpath(other.cwd).catch(error => { if (error.code === 'ENOENT') return path.resolve(other.cwd); throw error; });
      if (overlap(cwd, real)) throw new HttpError(409, '工作目录与其他智能体重叠，已停止删除。');
    }
    let stat;
    try { stat = await fs.lstat(cwd); }
    catch (error) {
      if (error.code === 'ENOENT' && missingAllowed && expected?.cwd === cwd) return expected;
      throw new HttpError(409, '工作目录不存在，请先恢复目录后重试。');
    }
    const real = await fs.realpath(cwd);
    if (!stat.isDirectory() || stat.isSymbolicLink() || real !== cwd) throw new HttpError(409, '工作目录位置已变化或是链接，已停止删除。');
    const result = { cwd, dev: String(stat.dev), ino: String(stat.ino) };
    if (expected && (expected.cwd !== cwd || expected.dev !== result.dev || expected.ino !== result.ino)) throw new HttpError(409, '工作目录已被替换，已停止删除。');
    return result;
  }
  async trash(id, actor) {
    return this.workspaces.exclusive(async () => {
      const meta = this.require(id, actor, false); this.assertIdle(meta);
      const directory = await this.directoryPlan(meta);
      this.require(id, actor, false); this.assertIdle(meta);
      const now = new Date().toISOString();
      const pausedScheduleIds = this.db.prepare('SELECT id FROM schedules WHERE target_session_id=? AND enabled=1').all(id).map(row => row.id);
      const previous = { ...meta };
      try {
        this.store.transaction(() => {
          this.db.prepare('UPDATE schedules SET enabled=0,next_run_at=NULL,updated_at=? WHERE target_session_id=?').run(now, id);
          Object.assign(meta, { deletedAt: now, deletedBy: actor.id, deletedByName: actor.displayName, trash: { directory, pausedScheduleIds } });
          this.db.prepare('UPDATE session_meta SET data=? WHERE id=?').run(JSON.stringify(meta), id);
        });
      } catch (error) { Object.assign(meta, previous); delete meta.deletedAt; delete meta.deletedBy; delete meta.deletedByName; delete meta.trash; throw error; }
      this.suspendChannels(id);
      this.audit('agent.trashed', actor, id, { pausedSchedules: pausedScheduleIds.length });
      return this.view(meta);
    });
  }
  async restore(id, actor, expectedDeletedAt) {
    return this.workspaces.exclusive(async () => {
      const meta = this.require(id, actor, true);
      if (meta.purgePending) throw new HttpError(409, '此智能体已开始永久删除，不能恢复；请完成清理。');
      if (expectedDeletedAt && expectedDeletedAt !== meta.deletedAt) throw new HttpError(409, '垃圾箱状态已变化，请刷新后重试。');
      await this.directoryPlan(meta, meta.trash?.directory);
      this.require(id, actor, true);
      const restored = { ...meta };
      delete restored.deletedAt; delete restored.deletedBy; delete restored.deletedByName; delete restored.trash; delete restored.purgeError;
      restored.updatedAt = new Date().toISOString(); restored.revision = (meta.revision || 0) + 1;
      this.db.prepare('UPDATE session_meta SET data=? WHERE id=?').run(JSON.stringify(restored), id);
      delete meta.deletedAt; delete meta.deletedBy; delete meta.deletedByName; delete meta.trash; delete meta.purgeError;
      Object.assign(meta, restored); this.audit('agent.restored', actor, id, { schedulesRemainPaused: true });
      return meta;
    });
  }
  async dataFile(file, root) {
    const absolute = path.resolve(file);
    if (path.dirname(absolute) !== root) throw new HttpError(409, '关联文件不在指定存储目录中，已停止删除。');
    const parent = await fs.realpath(root);
    if (parent !== root) throw new HttpError(409, '存储目录位置已变化，已停止删除。');
    return absolute;
  }
  async makePlan(meta) {
    const directory = await this.directoryPlan(meta, meta.trash?.directory);
    const sessions = this.family(meta), ids = sessions.map(row => row.id);
    const files = [];
    for (const row of sessions) if (row.file) {
      if (this.store.sessions.some(other => !ids.includes(other.id) && other.file && path.resolve(other.file) === path.resolve(row.file))) throw new HttpError(409, '会话文件被其他智能体使用，已停止删除。');
      files.push(await this.dataFile(row.file, path.resolve(this.store.sessionDir)));
    }
    const marks = ids.map(() => '?').join(',');
    for (const row of this.db.prepare(`SELECT id FROM attachments WHERE session_id IN (${marks})`).all(...ids)) {
      if (!idPattern.test(row.id)) throw new HttpError(409, '附件编号无效，已停止删除。');
      files.push(await this.dataFile(path.join(this.store.directory, 'attachments', `${row.id}.bin`), path.resolve(this.store.directory, 'attachments')));
    }
    return { directory, sessionIds: ids, files: [...new Set(files)] };
  }
  removeRecords(meta, plan) {
    const db = this.db, ids = plan.sessionIds, marks = ids.map(() => '?').join(',');
    const scheduleIds = db.prepare('SELECT id FROM schedules WHERE target_session_id=?').all(meta.id).map(row => row.id);
    const runIds = db.prepare(`SELECT id FROM task_runs WHERE session_id IN (${marks}) OR CASE WHEN json_valid(snapshot_json) THEN json_extract(snapshot_json,'$.targetSessionId') END=?`).all(...ids, meta.id).map(row => row.id);
    if (scheduleIds.length) runIds.push(...db.prepare(`SELECT id FROM task_runs WHERE schedule_id IN (${scheduleIds.map(() => '?').join(',')})`).all(...scheduleIds).map(row => row.id));
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row => ({ name: row.name, columns: db.prepare(`PRAGMA table_info(${identifier(row.name)})`).all().map(col => col.name) }));
    this.store.transaction(() => {
      db.exec('PRAGMA defer_foreign_keys=ON');
      for (const table of ['im_channels', 'wecom_channels']) if (this.table(table)) db.prepare(`UPDATE ${table} SET session_id=NULL,bound_by=NULL,binding_epoch=binding_epoch+1 WHERE session_id=?`).run(meta.id);
      for (const { name, columns } of tables) {
        if (['im_channels', 'wecom_channels', 'business_execution_claims'].includes(name)) continue;
        const clauses = [], args = [];
        for (const column of ['session_id', 'target_session_id', 'group_id']) if (columns.includes(column)) { clauses.push(`${column} IN (${marks})`); args.push(...ids); }
        if (columns.includes('run_id') && runIds.length) { clauses.push(`run_id IN (${runIds.map(() => '?').join(',')})`); args.push(...runIds); }
        if (name === 'task_runs' && runIds.length) { clauses.push(`id IN (${runIds.map(() => '?').join(',')})`); args.push(...runIds); }
        if (clauses.length) db.prepare(`DELETE FROM ${identifier(name)} WHERE ${clauses.join(' OR ')}`).run(...args);
        if (columns.includes('group_ids_json')) {
          for (const row of db.prepare(`SELECT id,group_ids_json${columns.includes('scope') ? ',scope' : ''} FROM ${identifier(name)}`).all()) {
            const old = JSON.parse(row.group_ids_json || '[]'), next = old.filter(id => !ids.includes(id));
            if (next.length !== old.length) db.prepare(`UPDATE ${identifier(name)} SET group_ids_json=?${columns.includes('enabled') && row.scope === 'groups' && !next.length ? ',enabled=0' : ''} WHERE id=?`).run(JSON.stringify(next), row.id);
          }
        }
      }
      db.prepare(`DELETE FROM session_meta WHERE id IN (${marks})`).run(...ids);
    });
    this.store.sessions = this.store.sessions.filter(row => !ids.includes(row.id));
  }
  async clean(meta) {
    const plan = meta.purgePlan;
    try {
      await this.directoryPlan(meta, plan.directory, true);
      for (const file of plan.files) {
        const allowed = [path.resolve(this.store.sessionDir), path.resolve(this.store.directory, 'attachments')].find(root => path.dirname(file) === root);
        if (!allowed) throw new HttpError(409, '关联文件路径无效，已停止删除。');
        await this.dataFile(file, allowed);
      }
      // The resolved absolute directory and its identity were checked against its
      // owning agent, all other agents, shared roots and protected trees above.
      await this.directoryPlan(meta, plan.directory, true);
      await fs.rm(plan.directory.cwd, { recursive: true, force: true });
      for (const file of plan.files) await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
      const inboxRoot = path.resolve(this.store.directory, 'attachment-inbox');
      for (const id of plan.sessionIds) {
        if (!idPattern.test(id)) throw new HttpError(409, '会话编号无效。');
        const target = path.join(inboxRoot, id);
        const stat = await fs.lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (stat) {
          if (stat.isSymbolicLink() || await fs.realpath(inboxRoot) !== inboxRoot || await fs.realpath(target) !== target || path.dirname(target) !== inboxRoot) throw new HttpError(409, '附件临时目录位置已变化，已停止删除。');
          await fs.rm(target, { recursive: true, force: true });
        }
      }
      this.removeRecords(meta, plan);
    } catch (error) {
      meta.purgeError = error instanceof HttpError ? error.message : '文件清理未完成，请重试永久删除。';
      this.store.saveSessions(); throw error;
    }
  }
  async purge(id, actor, { confirmTitle, deletedAt } = {}) {
    return this.workspaces.exclusive(async () => {
      const meta = this.require(id, actor, true); this.assertIdle(meta);
      if (confirmTitle !== meta.title || deletedAt !== meta.deletedAt) throw new HttpError(409, '请确认智能体名称和最新垃圾箱状态后重试。');
      if (!meta.purgePending) {
        const plan = await this.makePlan(meta);
        this.require(id, actor, true); this.assertIdle(meta);
        meta.purgePlan = plan; meta.purgePending = true;
      }
      this.store.saveSessions();
      await this.clean(meta);
      this.audit('agent.purged', actor, id, {}); return { ok: true };
    });
  }
  async recover() {
    for (const meta of this.store.sessions.filter(row => row.deletedAt && row.purgePending)) {
      try { await this.workspaces.exclusive(() => this.clean(meta)); } catch { /* Visible in trash for a safe manual retry. */ }
    }
  }
}
