import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const safeId = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const dayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
const logTruncationNotice = '\n[Pi 日志已截断：超过单次日志保存上限，任务仍继续执行。]\n';
const logTruncationBytes = Buffer.from(logTruncationNotice, 'utf8');
const maxResultBytes = 1024 * 1024;
const maxSummaryBytes = 16 * 1024;
const maxAttentionBytes = 8 * 1024;
const attentionCarrier = /^[\p{L}\p{N}][\p{L}\p{N} _.-]{0,47}$/u;

function failure(message, status = 400, details = {}) {
  return Object.assign(new Error(message), { status, ...details });
}

function identifier(value, label) {
  if (typeof value !== 'string' || !safeId.test(value)) throw failure(`${label}格式无效。`);
  return value;
}

function aborted(logId) {
  return Object.assign(new Error('业务任务已取消，请在管理员执行日志中查看。'), { name: 'AbortError', logId });
}

function within(directory, file) {
  const relative = path.relative(directory, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function businessDay(date) {
  const parts = Object.fromEntries(dayFormatter.formatToParts(date).map((entry) => [entry.type, entry.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function claimKey(task, day, runId, scheduledFor) {
  if (task.claimScope !== 'occurrence') return day;
  if (scheduledFor === null) return `manual:${runId}`;
  if (typeof scheduledFor !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(scheduledFor) || !Number.isFinite(Date.parse(scheduledFor))) throw failure('业务任务的定时执行时间无效。');
  return `scheduled:${new Date(scheduledFor).toISOString()}`;
}

function resultFailure(message, runId, exitCode) {
  return failure(`业务任务结果未完成：${message}请在管理员执行日志中查看。`, 500, { logId: runId, ...(exitCode !== undefined ? { exitCode } : {}) });
}

function safeSummary(value, task, redact) {
  let summary = String(redact(value)).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '').trim();
  // A business summary is shareable; interpreter/configuration locations and
  // diagnostic paths belong only in the administrator's private execution log.
  for (const key of ['pythonPath', 'scriptPath', 'cwd', 'registrationPath', 'resultDirectory']) summary = summary.split(task[key]).join('[内部路径]');
  summary = summary.replace(/(^|[\s(`"'])(?:[A-Za-z]:[\\/]|\\\\|\/(?!\/))[^\s`"'<>|]*/gu, '$1[内部路径]');
  return Buffer.from(summary, 'utf8').subarray(0, maxSummaryBytes).toString('utf8').replace(/\uFFFD$/u, '');
}

function trustedTask(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw failure('业务任务白名单配置无效。', 500);
  const id = identifier(raw.id, '业务任务编号');
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name || name.length > 120 || /[\r\n]/.test(name)) throw failure('业务任务名称配置无效。', 500);
  const task = { ...raw, id, name, source: raw.source || 'RPAC', timeoutSeconds: raw.timeoutSeconds ?? 7200 };
  for (const key of ['pythonPath', 'scriptPath', 'cwd', 'registrationPath']) {
    if (typeof task[key] !== 'string' || !path.isAbsolute(task[key]) || task[key].includes('\0')) throw failure('业务任务必须配置固定绝对路径。', 500);
    task[key] = path.normalize(task[key]);
  }
  if (!within(task.cwd, task.scriptPath)) throw failure('业务任务入口必须位于指定项目目录中。', 500);
  if (!Number.isInteger(task.timeoutSeconds) || task.timeoutSeconds < 1 || task.timeoutSeconds > 86400) throw failure('业务任务超时配置无效。', 500);
  if (task.args !== undefined && (!Array.isArray(task.args) || task.args.length > 100 || task.args.some((value) => typeof value !== 'string' || value.includes('\0')))) throw failure('业务任务参数配置无效。', 500);
  if (task.resultDirectory !== undefined) {
    if (typeof task.resultDirectory !== 'string' || !path.isAbsolute(task.resultDirectory) || task.resultDirectory.includes('\0')) throw failure('业务任务结果目录必须配置固定绝对路径。', 500);
    task.resultDirectory = path.normalize(task.resultDirectory);
  }
  if (task.claimScope !== undefined && !['daily', 'occurrence'].includes(task.claimScope)) throw failure('业务任务去重范围配置无效。', 500);
  if (task.humanAttention !== undefined && typeof task.humanAttention !== 'boolean') throw failure('业务任务人工验证通知配置无效。', 500);
  if (task.humanAttention && !task.resultDirectory) throw failure('人工验证通知需要固定业务结果目录。', 500);
  // Additional arguments are server configuration only. The interpreter and entry
  // script can never be supplied by an HTTP request or replaced by an argument.
  task.args = Object.freeze([...(task.args ?? ['--mode', 'manual'])]);
  return Object.freeze(task);
}

/** Runs administrator-registered local business projects without an AI round. */
export class BusinessTaskService {
  constructor(store, { tasks, configFile, redact = String, maxLogBytes = 256 * 1024, maxLogFileBytes = 32 * 1024 * 1024, now = () => new Date() } = {}) {
    this.store = store;
    this.db = store.db;
    this.redact = redact;
    this.now = now;
    this.maxLogBytes = Number.isSafeInteger(maxLogBytes) && maxLogBytes > 0 ? maxLogBytes : 256 * 1024;
    this.maxLogFileBytes = Number.isSafeInteger(maxLogFileBytes) && maxLogFileBytes >= 256 && maxLogFileBytes <= 128 * 1024 * 1024 ? maxLogFileBytes : 32 * 1024 * 1024;
    this.logDirectory = path.join(store.directory, 'business-logs');
    fs.mkdirSync(this.logDirectory, { recursive: true, mode: 0o700 });
    let configuration = tasks;
    if (configuration === undefined) {
      try { configuration = JSON.parse(fs.readFileSync(configFile || path.join(store.directory, 'business-tasks.json'), 'utf8')); }
      catch (error) {
        if (error.code === 'ENOENT') configuration = [];
        else throw failure('业务任务白名单配置无法读取。', 500);
      }
    }
    const records = Array.isArray(configuration) ? configuration : configuration?.tasks;
    if (!Array.isArray(records)) throw failure('业务任务白名单配置无效。', 500);
    this.tasks = new Map();
    for (const raw of records) {
      const task = trustedTask(raw);
      if (this.tasks.has(task.id)) throw failure('业务任务白名单存在重复编号。', 500);
      this.tasks.set(task.id, task);
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS business_execution_claims (
      task_id TEXT NOT NULL, business_day TEXT NOT NULL, run_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL, scheduled_for TEXT, created_at TEXT NOT NULL,
      started_at TEXT, finished_at TEXT, exit_code INTEGER,
      PRIMARY KEY(task_id,business_day));`);
  }

  get(id) {
    identifier(id, '业务任务编号');
    const task = this.tasks.get(id);
    if (!task) throw failure('业务任务不在服务端白名单中。', 404);
    return task;
  }

  list() {
    return [...this.tasks.values()].map((task) => {
      let ready = false;
      try { this._preflight(task); ready = true; } catch {}
      return { id: task.id, name: task.name, source: task.source, projectVersion: task.projectVersion ?? null, timeoutSeconds: task.timeoutSeconds, ready };
    });
  }

  _preflight(task) {
    try {
      if (!fs.statSync(task.cwd).isDirectory()) throw new Error();
      for (const file of [task.pythonPath, task.scriptPath, task.registrationPath]) if (!fs.statSync(file).isFile()) throw new Error();
      if (!within(fs.realpathSync(task.cwd), fs.realpathSync(task.scriptPath))) throw new Error();
      if (task.resultDirectory !== undefined) {
        const resultDirectory = fs.lstatSync(task.resultDirectory);
        if (!resultDirectory.isDirectory() || resultDirectory.isSymbolicLink()) throw new Error();
      }
      return task;
    } catch { throw failure('业务任务运行环境未就绪，请由管理员检查固定项目、解释器和注册文件。', 409); }
  }

  async preflight(id) { return this._preflight(this.get(id)); }

  _resultPath(task, runId) { return path.join(task.resultDirectory, `${runId}.json`); }

  _attentionPath(task, runId) { return path.join(task.resultDirectory, `${runId}.attention.json`); }

  _readAttention(task, runId) {
    let handle;
    try {
      const file = this._attentionPath(task, runId);
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxAttentionBytes) return null;
      handle = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      const opened = fs.fstatSync(handle);
      if (!opened.isFile() || opened.size > maxAttentionBytes || opened.dev !== stat.dev || opened.ino !== stat.ino) return null;
      const buffer = Buffer.alloc(maxAttentionBytes + 1);
      const bytes = fs.readSync(handle, buffer, 0, buffer.length, 0);
      if (bytes !== opened.size || bytes > maxAttentionBytes) return null;
      const event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes)));
      if (!event || Array.isArray(event) || event.schemaVersion !== 1 || event.runId !== runId
        || event.status !== 'waiting_human' || event.kind !== 'verification_required'
        || event.browser !== 'Chromium' || typeof event.carrier !== 'string' || !attentionCarrier.test(event.carrier)
        || typeof event.message !== 'string' || event.message.length > 1000
        || typeof event.createdAt !== 'string' || !Number.isFinite(Date.parse(event.createdAt))) return null;
      // Only fixed, non-secret metadata crosses into the notification path. The
      // program's free-form message and any other fields stay out of chat.
      return { schemaVersion: 1, runId, status: 'waiting_human', kind: 'verification_required',
        carrier: event.carrier, browser: 'Chromium', createdAt: event.createdAt };
    } catch { return null; }
    finally { if (handle !== undefined) fs.closeSync(handle); }
  }

  _assertFreshResult(task, runId) {
    try {
      fs.lstatSync(this._resultPath(task, runId));
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw resultFailure('无法检查本次结果文件。', runId);
    }
    throw resultFailure('本次结果文件已存在，拒绝使用旧结果。', runId);
  }

  _readResult(task, runId, exitCode) {
    let handle;
    try {
      const file = this._resultPath(task, runId);
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxResultBytes) throw new Error();
      handle = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      const opened = fs.fstatSync(handle);
      if (!opened.isFile() || opened.size > maxResultBytes || opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error();
      // A bounded read also protects against a file growing after its stat.
      const buffer = Buffer.alloc(Math.min(opened.size, maxResultBytes) + 1);
      let bytes = 0;
      while (bytes < buffer.length) {
        const read = fs.readSync(handle, buffer, bytes, buffer.length - bytes, bytes);
        if (!read) break;
        bytes += read;
      }
      if (bytes > maxResultBytes || bytes !== opened.size) throw new Error();
      const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes)));
      if (!result || typeof result !== 'object' || Array.isArray(result) || result.schemaVersion !== 1 || result.runId !== runId || !['completed', 'partial', 'failed'].includes(result.status) || typeof result.summary !== 'string' || !result.summary.trim() || Buffer.byteLength(result.summary, 'utf8') > maxSummaryBytes) throw new Error();
      const summary = safeSummary(result.summary, task, this.redact);
      if (!summary) throw new Error();
      return { status: result.status, summary };
    } catch (error) {
      if (error.code === 'ENOENT') throw resultFailure('本次没有生成业务检查结果，不能判定为成功。', runId, exitCode);
      throw resultFailure('本次业务检查结果无效，不能判定为成功。', runId, exitCode);
    } finally { if (handle !== undefined) fs.closeSync(handle); }
  }

  async readLog(runId) {
    identifier(runId, '执行日志编号');
    const file = path.join(this.logDirectory, `${runId}.log`);
    let raw;
    let handle;
    let fileTruncated = false;
    try {
      handle = await fs.promises.open(file, 'r');
      const stat = await handle.stat();
      fileTruncated = stat.size > this.maxLogFileBytes;
      const bytes = Math.min(stat.size, this.maxLogFileBytes);
      const buffer = Buffer.alloc(bytes);
      let offset = 0;
      while (offset < bytes) {
        const read = await handle.read(buffer, offset, bytes - offset, offset);
        if (!read.bytesRead) break;
        offset += read.bytesRead;
      }
      raw = buffer.subarray(0, offset);
    }
    catch (error) {
      if (error.code === 'ENOENT') return { content: '本次尚无执行日志（未启动或已跳过）。', truncated: false };
      throw failure('执行日志暂时无法读取。', 500);
    } finally { await handle?.close(); }
    const truncated = fileTruncated || raw.includes(logTruncationBytes) || raw.length > this.maxLogBytes;
    // Redact the bounded file text before selecting the tail so a configured secret
    // crossing a stream chunk or response boundary cannot escape redaction.
    const redacted = Buffer.from(this.redact(raw.toString('utf8')) + (fileTruncated ? logTruncationNotice : ''), 'utf8');
    const content = redacted.length > this.maxLogBytes ? redacted.subarray(-this.maxLogBytes).toString('utf8').replace(/^\uFFFD+/, '') : redacted.toString('utf8');
    return { content, truncated: truncated || redacted.length > this.maxLogBytes };
  }

  async run(id, { runId, scheduledFor = null, signal, onLog = () => {}, onAttention = () => {} } = {}) {
    identifier(runId, '业务执行编号');
    if (signal?.aborted) throw aborted(runId);
    const task = await this.preflight(id);
    if (signal?.aborted) throw aborted(runId);
    const date = this.now();
    const day = businessDay(date);
    const key = claimKey(task, day, runId, scheduledFor);
    const claimed = this.db.prepare(`INSERT OR IGNORE INTO business_execution_claims
      (task_id,business_day,run_id,status,scheduled_for,created_at) VALUES (?,?,?,'starting',?,?)`)
      .run(task.id, key, runId, scheduledFor, date.toISOString());
    if (!claimed.changes) {
      const reason = task.claimScope === 'occurrence' ? '本次计划时间已有执行记录，本次未重复执行。' : `北京时间 ${day} 已有执行记录，本次未重复执行。`;
      return { reply: `业务任务：${task.name}\n重复跳过：${reason}`, skipped: true, exitCode: null, logId: null };
    }
    const logFile = path.join(this.logDirectory, `${runId}.log`);
    let log;
    try { log = fs.openSync(logFile, 'wx', 0o600); }
    catch {
      this.db.prepare("DELETE FROM business_execution_claims WHERE run_id=? AND status='starting'").run(runId);
      throw failure('无法创建业务执行日志，任务未启动。', 500, { logId: runId });
    }
    const started = Date.now();
    let launched = false;
    let child;
    let timer;
    let attentionTimer;
    const attentionSeen = new Set();
    const attentionPending = new Map();
    const checkAttention = () => {
      if (!task.humanAttention || cancellation) return;
      const event = this._readAttention(task, runId);
      if (!event) return;
      const key = `${event.kind}:${event.carrier}`;
      if (attentionSeen.has(key) || attentionPending.has(key) || attentionSeen.size >= 128) return;
      let work;
      try { work = Promise.resolve(onAttention(event)); }
      catch { return; }
      let deadline;
      // A notification problem must never hold the completed business result
      // open indefinitely. Failed notifications can be retried by the next poll.
      const bounded = Promise.race([work.then(() => true, () => false), new Promise(resolve => {
        deadline = setTimeout(() => resolve(false), 2000); deadline.unref?.();
      })]);
      const pending = bounded.then(posted => { if (posted) attentionSeen.add(key); }).finally(() => {
        clearTimeout(deadline); attentionPending.delete(key);
      });
      attentionPending.set(key, pending);
    };
    let cancellation = null;
    let treeTermination = Promise.resolve();
    let logBytes = 0;
    let logTruncated = false;
    const write = (data) => {
      if (logTruncated) return;
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
      // Reserve room for one clear notice and keep draining child output after
      // reaching the cap; a noisy task must not exhaust disk or stall its pipes.
      const remaining = this.maxLogFileBytes - logTruncationBytes.length - logBytes;
      if (buffer.length <= remaining) {
        fs.writeSync(log, buffer);
        logBytes += buffer.length;
        return;
      }
      if (remaining > 0) fs.writeSync(log, buffer.subarray(0, remaining));
      fs.writeSync(log, logTruncationBytes);
      logBytes += Math.max(0, remaining) + logTruncationBytes.length;
      logTruncated = true;
    };
    const completeClaim = (status, exitCode = null) => this.db.prepare('UPDATE business_execution_claims SET status=?,finished_at=?,exit_code=? WHERE run_id=?')
      .run(status, this.now().toISOString(), exitCode, runId);
    const terminate = (reason) => {
      if (cancellation) return;
      cancellation = reason;
      if (!child?.pid) return;
      if (process.platform === 'win32') {
        treeTermination = new Promise((resolve) => {
          const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
          killer.once('error', () => { try { child.kill(); } catch {} resolve(); });
          killer.once('close', () => resolve());
        });
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
      }
    };
    const abort = () => terminate('cancelled');
    try {
      write(`任务：${task.name}\n执行编号：${runId}\n业务日：${day}\n开始时间：${date.toISOString()}\n\n`);
      if (signal?.aborted) throw aborted(runId);
      if (task.resultDirectory !== undefined) this._assertFreshResult(task, runId);
      if (task.humanAttention) {
        try { fs.lstatSync(this._attentionPath(task, runId)); throw resultFailure('本次人工验证通知文件已存在，拒绝使用旧通知。', runId); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      child = spawn(task.pythonPath, [task.scriptPath, task.registrationPath, ...task.args], {
        cwd: task.cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        // Python pipes otherwise buffer ordinary print() output until process exit.
        env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', RPAC_EXECUTION_ID: runId, RPAC_ATTEMPT: '1', PI_BUSINESS_RUN_ID: runId },
      });
      const result = new Promise((resolve, reject) => {
        child.once('spawn', () => {
          launched = true;
          this.db.prepare("UPDATE business_execution_claims SET status='running',started_at=? WHERE run_id=?").run(this.now().toISOString(), runId);
          if (signal?.aborted) abort();
        });
        child.once('error', () => reject(failure('业务任务进程无法启动，请检查管理员运行环境。', 500, { logId: runId })));
        child.once('close', (code, exitSignal) => resolve({ code, signal: exitSignal }));
        for (const [stream, source] of [['stdout', child.stdout], ['stderr', child.stderr]]) source.on('data', (chunk) => {
          try {
            write(chunk);
            // Progress consumers receive metadata only, never business output.
            try { onLog({ logId: runId, stream, bytes: chunk.length }); } catch {}
          } catch { terminate('log_error'); }
        });
      });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      timer = setTimeout(() => terminate('timed_out'), task.timeoutSeconds * 1000);
      timer.unref?.();
      if (task.humanAttention) {
        attentionTimer = setInterval(checkAttention, 1000);
        attentionTimer.unref?.();
      }
      const outcome = await result;
      clearInterval(attentionTimer);
      checkAttention();
      await Promise.all([...attentionPending.values()]);
      await treeTermination;
      if (cancellation) {
        completeClaim(cancellation === 'cancelled' ? 'cancelled' : cancellation === 'timed_out' ? 'timed_out' : 'failed', outcome.code);
        write(`\n结束状态：${cancellation}\n`);
        if (cancellation === 'cancelled') throw aborted(runId);
        throw failure(cancellation === 'timed_out' ? '业务任务超过执行时限，请在管理员执行日志中查看。' : '业务任务日志保存失败，已终止执行。', 500, { logId: runId });
      }
      if (task.resultDirectory !== undefined) {
        const businessResult = this._readResult(task, runId, outcome.code);
        if (outcome.code !== 0 || businessResult.status !== 'completed') {
          completeClaim('failed', outcome.code);
          write(`\n结束状态：failed；业务结果：${businessResult.status}；退出码：${outcome.code ?? 'signal'}\n`);
          throw failure(`业务任务：${task.name}\n${businessResult.summary}\n本次检查未完整完成，请在管理员执行日志中查看。`, 500, { logId: runId, exitCode: outcome.code });
        }
        completeClaim('succeeded', 0);
        const seconds = Math.max(0, (Date.now() - started) / 1000).toFixed(1);
        write(`\n结束状态：succeeded；业务结果：completed；耗时：${seconds} 秒\n`);
        return { reply: `业务任务：${task.name}\n${businessResult.summary}`, exitCode: 0, logId: runId };
      }
      if (outcome.code !== 0) {
        completeClaim('failed', outcome.code);
        write(`\n结束状态：failed；退出码：${outcome.code ?? 'signal'}\n`);
        throw failure(`业务任务执行失败${Number.isInteger(outcome.code) ? `（退出码 ${outcome.code}）` : ''}，请在管理员执行日志中查看。`, 500, { logId: runId, exitCode: outcome.code });
      }
      completeClaim('succeeded', 0);
      const seconds = Math.max(0, (Date.now() - started) / 1000).toFixed(1);
      write(`\n结束状态：succeeded；耗时：${seconds} 秒\n`);
      return { reply: `业务任务：${task.name}\n执行成功\n业务日期：${day}（北京时间）\n耗时：${seconds} 秒`, exitCode: 0, logId: runId };
    } catch (error) {
      if (!launched) this.db.prepare("DELETE FROM business_execution_claims WHERE run_id=? AND status='starting'").run(runId);
      else if (!cancellation) completeClaim('failed', Number.isInteger(error.exitCode) ? error.exitCode : null);
      if (error.name === 'AbortError' || error.logId) throw error;
      throw failure('业务任务执行失败，请在管理员执行日志中查看。', 500, { logId: runId });
    } finally {
      clearTimeout(timer);
      clearInterval(attentionTimer);
      signal?.removeEventListener('abort', abort);
      fs.closeSync(log);
    }
  }
}
