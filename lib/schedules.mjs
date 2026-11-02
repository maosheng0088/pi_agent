import { randomUUID } from 'node:crypto';
import { HttpError } from './security.mjs';

export const SCHEDULE_TIME_ZONE = 'Asia/Shanghai';
const DAY = 86400000;
const OFFSET = 8 * 3600000;
const ACTIVE = new Set(['queued', 'running']);
const RESULT_LIMIT = 100000;
const BUSINESS_TIMEOUT_LIMIT = 2 * 3600000 + 60000;

const millis = (value) => value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
const iso = (value) => new Date(value).toISOString();
function localDay(value) { return Math.floor((value + OFFSET) / DAY) * DAY - OFFSET; }
function clockOffset(time) { const [hour, minute] = time.split(':').map(Number); return (hour * 60 + minute) * 60000; }
function businessStart(schedule) {
  return schedule.taskType === 'business' && schedule.startDate ? Date.parse(`${schedule.startDate}T00:00:00+08:00`) : -Infinity;
}

/** The first occurrence after a time; Shanghai uses UTC+08:00 all year. */
export function nextOccurrence(schedule, after, { inclusive = false } = {}) {
  let at = millis(after);
  if (!Number.isFinite(at)) throw new HttpError(400, '调度时间无效。');
  const start = businessStart(schedule);
  if (at < start) { at = start; inclusive = true; }
  const accepts = (candidate) => candidate >= start && (inclusive ? candidate >= at : candidate > at);
  if (schedule.scheduleType === 'once') {
    const candidate = millis(schedule.runAt);
    return Number.isFinite(candidate) && accepts(candidate) ? iso(candidate) : null;
  }
  if (schedule.scheduleType === 'interval') {
    const anchor = millis(schedule.createdAt);
    const step = schedule.intervalMinutes * 60000;
    if (!Number.isFinite(anchor) || !Number.isFinite(step) || step < 60000) return null;
    const index = Math.max(1, inclusive ? Math.ceil((at - anchor) / step) : Math.floor((at - anchor) / step) + 1);
    return iso(anchor + index * step);
  }
  for (let day = 0; day <= 7; day++) {
    const candidate = localDay(at) + day * DAY + clockOffset(schedule.time);
    const weekday = new Date(candidate + OFFSET).getUTCDay();
    if (accepts(candidate) && (schedule.scheduleType === 'daily' || schedule.weekdays.includes(weekday))) return iso(candidate);
  }
  return null;
}

/** Only the most recent missed occurrence is charged after a service outage. */
export function mostRecentOccurrence(schedule, now) {
  const at = millis(now);
  const start = businessStart(schedule);
  if (at < start) return null;
  if (schedule.scheduleType === 'once') return millis(schedule.runAt) >= start && millis(schedule.runAt) <= at ? iso(millis(schedule.runAt)) : null;
  if (schedule.scheduleType === 'interval') {
    const anchor = millis(schedule.createdAt);
    const step = schedule.intervalMinutes * 60000;
    const index = Math.floor((at - anchor) / step);
    return index >= 1 && anchor + index * step >= start ? iso(anchor + index * step) : null;
  }
  for (let day = 0; day <= 7; day++) {
    const candidate = localDay(at) - day * DAY + clockOffset(schedule.time);
    const weekday = new Date(candidate + OFFSET).getUTCDay();
    if (candidate >= start && candidate <= at && (schedule.scheduleType === 'daily' || schedule.weekdays.includes(weekday))) return iso(candidate);
  }
  return null;
}

function text(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new HttpError(400, `${label}不能为空，且不能超过 ${max} 个字符。`);
  return value.trim();
}
function scheduleFrom(row) {
  if (!row) return null;
  return { id: row.id, name: row.name, skillId: row.skill_id, prompt: row.prompt, scheduleType: row.schedule_type,
    taskType: row.task_type || 'agent', businessTaskId: row.business_task_id || null, startDate: row.start_date || null,
    targetSessionId: row.target_session_id || null, executionMode: row.execution_mode || 'read-only',
    runAt: row.run_at, time: row.time, weekdays: JSON.parse(row.weekdays), intervalMinutes: row.interval_minutes,
    enabled: Boolean(row.enabled), timeZone: row.time_zone, nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at, lastStatus: row.last_status, createdBy: row.created_by,
    createdByName: row.created_by_name, createdAt: row.created_at, updatedAt: row.updated_at };
}
function runFrom(row) {
  if (!row) return null;
  const snapshot = row.snapshot_json ? JSON.parse(row.snapshot_json) : null;
  return { id: row.id, scheduleId: row.schedule_id, scheduleName: row.schedule_name, skillId: row.skill_id,
    taskType: snapshot?.taskType || 'agent', businessTaskId: snapshot?.businessTaskId || null, startDate: snapshot?.startDate || null,
    snapshot, targetSessionId: snapshot?.targetSessionId || null, executionMode: snapshot?.executionMode || 'read-only',
    hasResult: row.result_text != null,
    status: row.status, sessionId: row.session_id, requestedBy: row.requested_by, requestedByName: row.requested_by_name,
    trigger: row.trigger, scheduledFor: row.scheduled_for, startedAt: row.started_at, finishedAt: row.finished_at,
    error: row.error, createdAt: row.created_at };
}

export class ScheduleService {
  constructor(store, { execute, deliver, validateTarget, skills, redact = String, audit = () => {}, now = () => new Date(), pollIntervalMs = 1000, maxRunMs = 600000, businessTimeoutMs = () => 7200000, businessMisfireGraceMs = 15 * 60000 } = {}) {
    this.store = store; this.db = store.db; this.execute = execute; this.skills = skills; this.redact = redact; this.audit = audit; this.now = now;
    this.deliver = deliver; this.validateTarget = validateTarget; this.delivering = new Map();
    this.pollIntervalMs = Math.min(5000, Math.max(10, Number(pollIntervalMs) || 1000));
    this.maxRunMs = Math.min(600000, Math.max(10, Number(maxRunMs) || 600000));
    this.businessTimeoutMs = businessTimeoutMs;
    this.businessMisfireGraceMs = Math.min(DAY, Math.max(0, Number(businessMisfireGraceMs) || 0));
    this.running = new Map(); this.stopped = false; this.timer = null;
    this.db.exec(`CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, skill_id TEXT, prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL, run_at TEXT, time TEXT, weekdays TEXT NOT NULL DEFAULT '[]', interval_minutes INTEGER,
      enabled INTEGER NOT NULL DEFAULT 0, time_zone TEXT NOT NULL DEFAULT 'Asia/Shanghai', next_run_at TEXT,
      last_run_at TEXT, last_status TEXT, created_by TEXT NOT NULL, created_by_name TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS schedules_due ON schedules(enabled,next_run_at);
      CREATE TABLE IF NOT EXISTS task_runs (
      id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, schedule_name TEXT NOT NULL, skill_id TEXT, status TEXT NOT NULL,
      session_id TEXT, requested_by TEXT NOT NULL, requested_by_name TEXT NOT NULL, trigger TEXT NOT NULL,
      scheduled_for TEXT, started_at TEXT, finished_at TEXT, error TEXT, created_at TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS task_runs_occurrence ON task_runs(schedule_id,scheduled_for) WHERE scheduled_for IS NOT NULL;
      CREATE INDEX IF NOT EXISTS task_runs_schedule ON task_runs(schedule_id,created_at DESC);
      CREATE INDEX IF NOT EXISTS task_runs_status ON task_runs(status);`);
    // Additive migrations preserve existing plans and execution records. Old plans
    // retain their original read-only behavior until an administrator edits them.
    for (const [table, additions] of [
      ['schedules', [['target_session_id', 'TEXT'], ['execution_mode', "TEXT NOT NULL DEFAULT 'read-only'"],
        ['task_type', "TEXT NOT NULL DEFAULT 'agent'"], ['business_task_id', 'TEXT'], ['start_date', 'TEXT']]],
      ['task_runs', [['snapshot_json', 'TEXT'], ['result_text', 'TEXT']]],
    ]) {
      const columns = new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
      for (const [name, declaration] of additions) if (!columns.has(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${declaration}`);
    }
    const ended = iso(millis(this.now()));
    store.transaction(() => {
      this.db.prepare("UPDATE schedules SET last_status='interrupted' WHERE id IN (SELECT schedule_id FROM task_runs WHERE status IN ('queued','running'))").run();
      this.db.prepare("UPDATE task_runs SET status='interrupted',finished_at=?,error=? WHERE status IN ('queued','running')")
        .run(ended, '服务重启，先前任务已中断；不会自动重试。');
    });
  }

  list() { return this.db.prepare('SELECT * FROM schedules ORDER BY created_at DESC,id').all().map(scheduleFrom); }
  get(id) { const value = scheduleFrom(this.db.prepare('SELECT * FROM schedules WHERE id=?').get(id)); if (!value) throw new HttpError(404, '定时任务不存在。'); return value; }
  getRun(id) { const value = runFrom(this.db.prepare('SELECT * FROM task_runs WHERE id=?').get(id)); if (!value) throw new HttpError(404, '运行记录不存在。'); return value; }
  result(id) {
    const row = this.db.prepare('SELECT result_text FROM task_runs WHERE id=?').get(id);
    if (!row) throw new HttpError(404, '运行记录不存在。');
    return row.result_text ?? null;
  }
  runs({ scheduleId, limit = 100 } = {}) {
    return (scheduleId ? this.db.prepare('SELECT * FROM task_runs WHERE schedule_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?').all(scheduleId, limit)
      : this.db.prepare('SELECT * FROM task_runs ORDER BY created_at DESC,rowid DESC LIMIT ?').all(limit)).map(runFrom);
  }
  validate(body, previous = {}) {
    // Persisted identity/ownership and the interval anchor are never client fields.
    const value = { ...previous };
    for (const key of ['name', 'skillId', 'prompt', 'targetSessionId', 'executionMode', 'taskType', 'businessTaskId', 'startDate', 'scheduleType', 'runAt', 'time', 'weekdays', 'intervalMinutes', 'enabled', 'timeZone']) if (key in body) value[key] = body[key];
    value.name = text(value.name, '任务名称', 120); value.prompt = text(value.prompt, '任务提示词', 100000);
    if (!['once', 'daily', 'weekly', 'interval'].includes(value.scheduleType)) throw new HttpError(400, '调度类型无效。');
    if (value.enabled == null) value.enabled = false;
    if (typeof value.enabled !== 'boolean') throw new HttpError(400, 'enabled 须为布尔值。');
    if (value.timeZone != null && value.timeZone !== SCHEDULE_TIME_ZONE) throw new HttpError(400, '时区固定为 Asia/Shanghai。');
    value.skillId = value.skillId === '' || value.skillId == null ? null : text(value.skillId, '技能', 120);
    value.taskType ??= 'agent';
    if (!['agent', 'business'].includes(value.taskType)) throw new HttpError(400, '任务执行类型无效。');
    value.businessTaskId = value.businessTaskId === '' || value.businessTaskId == null ? null : text(value.businessTaskId, '业务项目', 120);
    value.startDate = value.startDate === '' || value.startDate == null ? null : value.startDate;
    value.targetSessionId = value.targetSessionId === '' || value.targetSessionId == null ? null : text(value.targetSessionId, '业务群', 120);
    value.executionMode ??= 'read-only';
    if (!['read-only', 'workspace'].includes(value.executionMode)) throw new HttpError(400, '技能执行权限无效。');
    if (value.taskType === 'business') {
      if (!value.businessTaskId) throw new HttpError(400, '业务任务须选择已配置的业务项目。');
      if (value.executionMode !== 'workspace') throw new HttpError(400, '业务任务须允许执行技能与系统命令。');
      if (value.skillId) throw new HttpError(400, '业务任务使用固定执行器，不能同时选择 Agent 技能。');
      if (value.startDate != null) {
        const parts = typeof value.startDate === 'string' && value.startDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!parts || Number(parts[2]) < 1 || Number(parts[2]) > 12 || Number(parts[3]) < 1
          || Number(parts[3]) > new Date(Date.UTC(Number(parts[1]), Number(parts[2]), 0)).getUTCDate()) throw new HttpError(400, '开始日期须为有效的 YYYY-MM-DD。');
      }
    } else {
      if (value.businessTaskId || value.startDate) throw new HttpError(400, '业务项目和开始日期仅适用于业务任务。');
      if (value.skillId) this.skills?.get(value.skillId);
    }
    if (value.scheduleType === 'once') {
      const parts = typeof value.runAt === 'string' && value.runAt.match(/^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i);
      const calendarValid = parts && Number(parts[2]) >= 1 && Number(parts[2]) <= 12
        && Number(parts[3]) >= 1 && Number(parts[3]) <= new Date(Date.UTC(Number(parts[1]), Number(parts[2]), 0)).getUTCDate();
      if (!calendarValid || !Number.isFinite(Date.parse(value.runAt))) throw new HttpError(400, '单次任务须提供含时区的有效 ISO runAt。');
      value.runAt = iso(Date.parse(value.runAt));
      if (millis(value.runAt) < businessStart(value)) throw new HttpError(400, '单次执行时间不能早于业务任务开始日期。');
    } else value.runAt = null;
    if (['daily', 'weekly'].includes(value.scheduleType)) {
      if (typeof value.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time)) throw new HttpError(400, '执行时间须为 HH:mm。');
    } else value.time = null;
    if (value.scheduleType === 'weekly') {
      if (!Array.isArray(value.weekdays) || !value.weekdays.length || value.weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) throw new HttpError(400, '每周任务须选择 0 至 6 的星期。');
      value.weekdays = [...new Set(value.weekdays)].sort();
    } else value.weekdays = [];
    if (value.scheduleType === 'interval') {
      if (!Number.isSafeInteger(value.intervalMinutes) || value.intervalMinutes < 1 || value.intervalMinutes > 5256000) throw new HttpError(400, '间隔须为 1 至 5,256,000 分钟的整数。');
    } else value.intervalMinutes = null;
    return value;
  }
  initialNext(value, now) { return !value.enabled ? null : value.scheduleType === 'once' ? value.runAt : nextOccurrence(value, now); }
  create(body, actor) {
    const value = this.validate(body); const now = iso(millis(this.now()));
    Object.assign(value, { id: randomUUID(), createdBy: actor.id, createdByName: actor.displayName, createdAt: now, updatedAt: now });
    this.validateTarget?.(value, { phase: 'save', previous: null });
    value.nextRunAt = this.initialNext(value, now);
    this.db.prepare(`INSERT INTO schedules(id,name,skill_id,prompt,schedule_type,run_at,time,weekdays,interval_minutes,enabled,time_zone,next_run_at,created_by,created_by_name,created_at,updated_at,target_session_id,execution_mode,task_type,business_task_id,start_date)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(value.id, value.name, value.skillId, value.prompt, value.scheduleType, value.runAt, value.time, JSON.stringify(value.weekdays), value.intervalMinutes, Number(value.enabled), SCHEDULE_TIME_ZONE, value.nextRunAt, value.createdBy, value.createdByName, now, now, value.targetSessionId, value.executionMode, value.taskType, value.businessTaskId, value.startDate);
    return this.get(value.id);
  }
  update(id, body) {
    const old = this.get(id); const value = this.validate(body, old); const now = iso(millis(this.now()));
    this.validateTarget?.(value, { phase: 'save', previous: old });
    const timingChanged = ['scheduleType', 'runAt', 'time', 'weekdays', 'intervalMinutes', 'taskType', 'startDate'].some((key) => JSON.stringify(old[key]) !== JSON.stringify(value[key]));
    const next = !value.enabled ? null : timingChanged || !old.enabled ? this.initialNext(value, now) : old.nextRunAt;
    this.db.prepare(`UPDATE schedules SET name=?,skill_id=?,prompt=?,schedule_type=?,run_at=?,time=?,weekdays=?,interval_minutes=?,enabled=?,next_run_at=?,updated_at=?,target_session_id=?,execution_mode=?,task_type=?,business_task_id=?,start_date=? WHERE id=?`)
      .run(value.name, value.skillId, value.prompt, value.scheduleType, value.runAt, value.time, JSON.stringify(value.weekdays), value.intervalMinutes, Number(value.enabled), next, now, value.targetSessionId, value.executionMode, value.taskType, value.businessTaskId, value.startDate, id);
    return this.get(id);
  }
  remove(id) {
    this.get(id);
    if (this.db.prepare("SELECT id FROM task_runs WHERE schedule_id=? AND status IN ('queued','running')").get(id)) throw new HttpError(409, '请先取消此任务的运行，再删除。');
    this.db.prepare('DELETE FROM schedules WHERE id=?').run(id);
  }
  createRun(schedule, actor, trigger, scheduledFor = null, status = 'queued', error = null) {
    const now = iso(millis(this.now())); const id = randomUUID();
    this.db.prepare(`INSERT INTO task_runs(id,schedule_id,schedule_name,skill_id,status,requested_by,requested_by_name,trigger,scheduled_for,finished_at,error,created_at,snapshot_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, schedule.id, schedule.name, schedule.skillId, status, actor.id, actor.displayName, trigger, scheduledFor, status === 'skipped' ? now : null, error, now, JSON.stringify(schedule));
    this.db.prepare('UPDATE schedules SET last_run_at=?,last_status=? WHERE id=?').run(now, status, schedule.id);
    return this.getRun(id);
  }
  run(id, actor) {
    if (this.stopped) throw new HttpError(503, '调度器正在关闭。');
    let run;
    this.store.transaction(() => {
      const schedule = this.get(id);
      if (this.db.prepare("SELECT id FROM task_runs WHERE schedule_id=? AND status IN ('queued','running')").get(id)) throw new HttpError(409, '此任务正在运行，请等待完成或先取消。');
      run = this.createRun(schedule, actor, 'manual');
    });
    this.launch(run.id); return run;
  }
  start() {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => { this.tick().catch(() => {}); }, this.pollIntervalMs); this.timer.unref?.();
    this.tick().catch(() => {});
  }
  async tick() {
    if (this.stopped) return;
    const now = iso(millis(this.now())); const launch = [];
    this.store.transaction(() => {
      const due = this.db.prepare('SELECT * FROM schedules WHERE enabled=1 AND next_run_at IS NOT NULL AND next_run_at<=? ORDER BY next_run_at').all(now);
      for (const row of due) {
        const schedule = scheduleFrom(row);
        if (millis(now) < businessStart(schedule)) {
          this.db.prepare('UPDATE schedules SET next_run_at=? WHERE id=?').run(this.initialNext(schedule, now), schedule.id);
          continue;
        }
        const scheduledFor = mostRecentOccurrence(schedule, now) || schedule.nextRunAt;
        const next = schedule.scheduleType === 'once' ? null : nextOccurrence(schedule, now);
        this.db.prepare('UPDATE schedules SET next_run_at=? WHERE id=? AND next_run_at=?').run(next, schedule.id, schedule.nextRunAt);
        if (this.db.prepare('SELECT id FROM task_runs WHERE schedule_id=? AND scheduled_for=?').get(schedule.id, scheduledFor)) continue;
        const overlapping = this.db.prepare("SELECT id FROM task_runs WHERE schedule_id=? AND status IN ('queued','running')").get(schedule.id);
        const expired = schedule.taskType === 'business' && (localDay(millis(scheduledFor)) !== localDay(millis(now))
          || millis(now) - millis(scheduledFor) > this.businessMisfireGraceMs || millis(scheduledFor) < businessStart(schedule));
        const skipReason = overlapping ? '上次运行尚未结束，本次已跳过以防止重叠。'
          : expired ? '业务计划已超过当日补跑宽限时间，本次已跳过；不会补做过期业务。' : null;
        const run = this.createRun(schedule, { id: schedule.createdBy, displayName: schedule.createdByName }, 'scheduled', scheduledFor,
          skipReason ? 'skipped' : 'queued', skipReason);
        if (!skipReason) launch.push(run.id);
      }
    });
    for (const id of launch) this.launch(id);
  }
  setSessionId(id, sessionId) { this.db.prepare('UPDATE task_runs SET session_id=? WHERE id=?').run(sessionId, id); }
  launch(id) {
    if (this.running.has(id) || this.stopped) return;
    const controller = new AbortController(); const entry = { controller, promise: null, timeout: null, stopStatus: null };
    this.running.set(id, entry);
    entry.promise = Promise.resolve().then(async () => {
      if (this.getRun(id).status !== 'queued') return;
      const run = this.getRun(id); const schedule = run.snapshot || this.get(run.scheduleId); const started = iso(millis(this.now()));
      this.db.prepare("UPDATE task_runs SET status='running',started_at=? WHERE id=? AND status='queued'").run(started, id);
      this.db.prepare("UPDATE schedules SET last_status='running' WHERE id=?").run(schedule.id);
      let status = 'succeeded'; let error = null; let result = null;
      try {
        const creator = this.db.prepare('SELECT id,display_name,role,disabled FROM users WHERE id=?').get(schedule.createdBy);
        if (!creator || creator.disabled || creator.role !== 'admin') throw new Error('任务创建人账号已停用或不再具有管理员权限。');
        if (schedule.skillId && !this.skills?.get(schedule.skillId)?.enabled) throw new Error('任务所引用的技能已停用。');
        this.validateTarget?.(schedule, { phase: 'run' });
        if (controller.signal.aborted) throw controller.signal.reason;
        const deadlineMs = schedule.taskType === 'business'
          ? Math.min(BUSINESS_TIMEOUT_LIMIT, Math.max(10, Number(this.businessTimeoutMs(schedule)) || 7200000)) : this.maxRunMs;
        const deadlineLabel = deadlineMs % 60000 === 0 ? `${deadlineMs / 60000} 分钟` : `${Math.ceil(deadlineMs / 1000)} 秒`;
        entry.timeout = setTimeout(() => { entry.stopStatus = 'failed'; controller.abort(new Error(`任务运行超过 ${deadlineLabel}上限，已停止。`)); }, deadlineMs);
        entry.timeout.unref?.();
        this.audit('schedule.run_started', schedule, run, {});
        const output = await this.execute({ schedule, run: this.getRun(id), signal: controller.signal });
        if (output?.sessionId) this.setSessionId(id, output.sessionId);
        if (controller.signal.aborted) throw controller.signal.reason;
        if (schedule.taskType === 'business' && output?.skipped === true) status = 'skipped';
        result = String(this.redact(typeof output?.reply === 'string' && output.reply.trim() ? output.reply : '任务已完成，未返回文字结果。')).slice(0, RESULT_LIMIT);
      } catch (cause) {
        status = entry.stopStatus || (controller.signal.aborted || cause?.name === 'AbortError' ? 'cancelled' : 'failed');
        error = String(this.redact(cause?.message || '任务执行失败。')).slice(0, RESULT_LIMIT);
        if (status === 'failed') result = String(this.redact(`执行失败：${error}`)).slice(0, RESULT_LIMIT);
      } finally {
        if (entry.timeout) clearTimeout(entry.timeout);
        const finished = iso(millis(this.now()));
        // Commit the outcome before notification. A failed notification must never
        // lose the result or cause an already completed business action to replay.
        this.store.transaction(() => {
          this.db.prepare('UPDATE task_runs SET status=?,finished_at=?,error=?,result_text=? WHERE id=?').run(status, finished, error, result, id);
          this.db.prepare('UPDATE schedules SET last_status=? WHERE id=?').run(status, schedule.id);
        });
        try { this.audit('schedule.run_finished', schedule, this.getRun(id), { status, error }); } catch {}
      }
      if (result != null && this.deliver) {
        try { await this.deliverResult(id, schedule, result); }
        catch (cause) {
          try { this.audit('schedule.delivery_failed', schedule, this.getRun(id), { error: String(this.redact(cause?.message || '结果投递失败。')).slice(0, RESULT_LIMIT) }); } catch {}
        }
      }
    }).catch((cause) => {
      const error = String(this.redact(cause?.message || '任务执行失败。')).slice(0, RESULT_LIMIT);
      this.db.prepare("UPDATE task_runs SET status='failed',finished_at=?,error=?,result_text=? WHERE id=? AND status IN ('queued','running')")
        .run(iso(millis(this.now())), error, String(this.redact(`执行失败：${error}`)).slice(0, RESULT_LIMIT), id);
    }).finally(() => this.running.delete(id));
  }
  deliverResult(id, schedule, result) {
    if (this.delivering.has(id)) return this.delivering.get(id);
    const promise = Promise.resolve().then(() => this.deliver({ schedule, run: this.getRun(id), result }))
      .finally(() => this.delivering.delete(id));
    this.delivering.set(id, promise);
    return promise;
  }
  async retryDelivery(id) {
    const run = this.getRun(id);
    if (!['succeeded', 'failed', 'skipped'].includes(run.status) || !run.hasResult) throw new HttpError(409, '运行尚未完成或没有可投递的结果。');
    if (!this.deliver) throw new HttpError(409, '结果投递服务未启用。');
    const schedule = run.snapshot || this.get(run.scheduleId);
    await this.deliverResult(id, schedule, this.result(id));
    return this.getRun(id);
  }
  cancel(id) {
    const run = this.getRun(id);
    if (!ACTIVE.has(run.status)) throw new HttpError(409, '任务已经结束，无法取消。');
    const entry = this.running.get(id);
    if (entry) { entry.stopStatus = 'cancelled'; entry.controller.abort(new Error('管理员已取消任务。')); }
    if (run.status === 'queued') {
      this.db.prepare("UPDATE task_runs SET status='cancelled',finished_at=?,error=? WHERE id=?").run(iso(millis(this.now())), '管理员已取消任务。', id);
      this.db.prepare("UPDATE schedules SET last_status='cancelled' WHERE id=?").run(run.scheduleId);
    }
    return this.getRun(id);
  }
  async waitForIdle() { await Promise.allSettled([...this.running.values()].map((entry) => entry.promise).concat([...this.delivering.values()])); }
  async stop() {
    this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = null;
    for (const [id, entry] of this.running) {
      entry.stopStatus = 'interrupted'; entry.controller.abort(new Error('服务正在关闭，任务已中断；不会自动重试。'));
      if (this.getRun(id).status === 'queued') {
        this.db.prepare("UPDATE task_runs SET status='interrupted',finished_at=?,error=? WHERE id=?").run(iso(millis(this.now())), '服务正在关闭，任务已中断；不会自动重试。', id);
        this.db.prepare("UPDATE schedules SET last_status='interrupted' WHERE id=?").run(this.getRun(id).scheduleId);
      }
    }
    await this.waitForIdle();
  }
}
