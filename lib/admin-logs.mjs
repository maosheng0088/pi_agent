import { HttpError } from './security.mjs';

export const LOG_LEVELS = Object.freeze(['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL']);
export const LOG_SOURCES = Object.freeze(['system', 'model', 'tasks', 'schedules', 'channels', 'auth', 'http', 'skills']);
export const LOG_RETENTION = Object.freeze({ maxEntries: 20000, maxAgeDays: 7 });
const safeKeys = new Set(['action', 'event', 'status', 'statusCode', 'method', 'path', 'provider', 'model', 'durationMs', 'messageCount', 'aborted', 'mode', 'executionMode', 'trigger', 'scheduleId', 'channelId', 'platform', 'errorType', 'errorCode', 'attempt', 'attempts', 'count', 'bytes', 'version', 'enabled', 'role', 'changedFields', 'reason', 'phase', 'targetId', 'nextRetryMs', 'truncated']);
const credentialKey = /password|passwd|pwd|token|secret|api[-_]?key|authorization|cookie|credential|webhook/i;
const forbiddenKey = /prompt|instruction|content|stdout|stderr|request|response|payload|stack|messages|result|body|headers/i;
const identifier = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/;
const safeReasons = new Set(['发生运行错误，请结合来源和任务记录排查。', '认证失败或凭据未配置，请检查管理员配置。', '账号、群成员或执行权限已失效。', '上游请求受到限流。', '调用超时或超过运行时限。', '运行已取消、中断或服务正在关闭。', '结果投递失败，执行结果与通知状态应分别检查。', '网络或上游连接失败。', '上游或服务端返回错误。', '服务重启，先前任务已中断，需人工核对后恢复。', '渠道登录二维码或配对码已失效，请重新连接。']);
const byteText = (value, max) => Buffer.from(String(value), 'utf8').subarray(0, max).toString('utf8').replace(/\uFFFD$/u, '');

function integer(value, label, maximum = Number.MAX_SAFE_INTEGER, minimum = 0) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum) return value;
  if (typeof value !== 'string' || !/^\d+$/u.test(value)) throw new HttpError(400, `${label} 参数无效。`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw new HttpError(400, `${label} 参数无效。`);
  return result;
}
function dateValue(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) throw new HttpError(400, `${label} 须为带时区的 ISO 时间。`);
  const [year, month, day, hour, minute, second] = value.match(/^\d{4}|\d{2}/gu).slice(0, 6).map(Number);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() || hour > 23 || minute > 59 || second > 59) throw new HttpError(400, `${label} 时间无效。`);
  return date.toISOString();
}

/** Bounded structured diagnostics, independent of the existing operation audit.
 * No console interception, arbitrary file reading or request body collection.
 */
export class AdminLogService {
  constructor(store, { knownSecrets = () => [], now = () => new Date(), maxEntries = 20000, maxAgeDays = 7, maxStreams = 8, maxStreamsPerActor = 2, authIntervalMs = 2000 } = {}) {
    this.store = store; this.db = store.db; this.knownSecrets = knownSecrets; this.now = now;
    this.retention = { maxEntries: Math.min(20000, Math.max(1, maxEntries)), maxAgeDays: Math.min(7, Math.max(1, maxAgeDays)) };
    this.maxStreams = Math.min(8, Math.max(1, maxStreams)); this.maxStreamsPerActor = Math.min(2, Math.max(1, maxStreamsPerActor));
    this.authIntervalMs = Math.min(2000, Math.max(20, authIntervalMs));
    this.listeners = new Set(); this.streams = new Set(); this.closed = false;
    this.db.exec(`CREATE TABLE IF NOT EXISTS admin_runtime_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,timestamp TEXT NOT NULL,level TEXT NOT NULL,source TEXT NOT NULL,
      message TEXT NOT NULL,details_json TEXT,session_id TEXT,task_id TEXT,actor_id TEXT);
      CREATE INDEX IF NOT EXISTS admin_runtime_logs_time ON admin_runtime_logs(timestamp,id);
      CREATE INDEX IF NOT EXISTS admin_runtime_logs_filter ON admin_runtime_logs(source,level,id);`);
    this.prune();
  }
  redact(value) {
    let output = typeof value === 'string' ? value : String(value ?? '');
    if (output.length > 65536) return '[日志文本超过安全长度限制]';
    let secrets = []; try { secrets = this.knownSecrets() ?? []; } catch {}
    for (const secret of secrets) if (typeof secret === 'string' && secret.length >= 4) output = output.split(secret).join('[redacted]');
    return output.replace(/\bBearer\s+[^\s"'<>;,]+/giu, 'Bearer [redacted]')
      .replace(/(["']?(?:authorization|set-cookie|cookie)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\r\n]+)/giu, '$1[redacted]')
      .replace(/(["']?(?:password|passwd|pwd|[\w-]*token|[\w-]*secret|api[-_]?key|webhook(?:[-_]?url)?)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}&]+)/giu, '$1[redacted]')
      .replace(/https?:\/\/[^\s"'<>]+/giu, value => { try { const url = new URL(value); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.toString(); } catch { return '[redacted-url]'; } });
  }
  failure(error) {
    const raw = typeof error === 'string' ? error : String(error?.message ?? '');
    const status = Number(error?.status ?? error?.statusCode ?? /\b(401|403|404|408|429|5\d\d)\b/u.exec(raw)?.[1]);
    let reason = '发生运行错误，请结合来源和任务记录排查。';
    if (safeReasons.has(raw)) reason = raw;
    else if (status === 401 || /unauthorized|invalid.?api.?key|认证|鉴权|凭据|missing.*(?:key|token)|未配置|缺少.*(?:密钥|配置)/iu.test(raw)) reason = '认证失败或凭据未配置，请检查管理员配置。';
    else if (status === 403 || /权限|尚未加入|停用|不再|移出|未登录|登录.*失效|登录.*过期/iu.test(raw)) reason = '账号、群成员或执行权限已失效。';
    else if (status === 429 || /rate.?limit|限流|请求过多/iu.test(raw)) reason = '上游请求受到限流。';
    else if (/timeout|timed.?out|超时|超过.*(?:时限|上限)/iu.test(raw)) reason = '调用超时或超过运行时限。';
    else if (/abort|cancel|取消|关闭|中断/iu.test(raw)) reason = '运行已取消、中断或服务正在关闭。';
    else if (/deliver|publish|通知|投递|送达|发送.*失败/iu.test(raw)) reason = '结果投递失败，执行结果与通知状态应分别检查。';
    else if (/ECONN|ENOTFOUND|network|网络|连接/iu.test(raw)) reason = '网络或上游连接失败。';
    else if (/退出码\s*\d+/u.test(raw)) reason = `业务进程非正常退出（${/退出码\s*\d+/u.exec(raw)[0]}）。`;
    else if (status >= 500) reason = '上游或服务端返回错误。';
    else if (/二维码.*过期|配对码.*次数/u.test(raw)) reason = '渠道登录二维码或配对码已失效，请重新连接。';
    else if (/服务重启|restart/iu.test(raw)) reason = '服务重启，先前任务已中断，需人工核对后恢复。';
    else if (/shutdown/iu.test(raw)) reason = '运行已取消、中断或服务正在关闭。';
    return { reason: byteText(reason, 500), errorType: typeof error?.name === 'string' ? byteText(error.name, 80) : 'Error', ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { statusCode: status } : {}), ...(typeof error?.code === 'string' && /^[A-Z0-9_-]{1,50}$/u.test(error.code) ? { errorCode: error.code } : {}) };
  }
  details(value, depth = 0) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 3) return undefined;
    const output = {};
    for (const [key, item] of Object.entries(value).slice(0, 50)) {
      if (credentialKey.test(key)) { output[key.slice(0, 60)] = '[redacted]'; continue; }
      if (forbiddenKey.test(key) || !safeKeys.has(key)) continue;
      if (key === 'reason') { output[key] = this.failure(item).reason; continue; }
      if (item === null || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) output[key] = item;
      else if (typeof item === 'string') output[key] = byteText(this.redact(item), 500);
      else if (Array.isArray(item)) output[key] = item.slice(0, 20).filter(entry => ['string', 'number', 'boolean'].includes(typeof entry)).map(entry => typeof entry === 'string' ? byteText(this.redact(entry), 120) : entry);
      else if (typeof item === 'object') output[key] = this.details(item, depth + 1);
    }
    return Buffer.byteLength(JSON.stringify(output)) > 4096 ? { truncated: true } : Object.keys(output).length ? output : undefined;
  }
  prune() {
    if (this.closed) return;
    const cutoff = new Date(new Date(this.now()).getTime() - this.retention.maxAgeDays * 86400000).toISOString();
    this.db.prepare('DELETE FROM admin_runtime_logs WHERE timestamp<?').run(cutoff);
    const max = this.db.prepare('SELECT MAX(id) AS id FROM admin_runtime_logs').get().id ?? 0;
    if (max > this.retention.maxEntries) this.db.prepare('DELETE FROM admin_runtime_logs WHERE id<=?').run(max - this.retention.maxEntries);
  }
  write({ level = 'INFO', source = 'system', message, details, sessionId, taskId, actorId } = {}) {
    try {
      if (this.closed || !LOG_LEVELS.includes(level) || !LOG_SOURCES.includes(source) || typeof message !== 'string' || !message.trim()) return null;
      const record = { timestamp: new Date(this.now()).toISOString(), level, source, message: byteText(this.redact(message).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, ''), 2000), details: this.details(details) };
      for (const [key, value] of Object.entries({ sessionId, taskId, actorId })) if (typeof value === 'string' && identifier.test(value) && this.redact(value) === value) record[key] = value;
      const row = this.db.prepare('INSERT INTO admin_runtime_logs(timestamp,level,source,message,details_json,session_id,task_id,actor_id) VALUES (?,?,?,?,?,?,?,?)')
        .run(record.timestamp, level, source, record.message, record.details ? JSON.stringify(record.details) : null, record.sessionId ?? null, record.taskId ?? null, record.actorId ?? null);
      record.id = Number(row.lastInsertRowid); this.prune();
      for (const listener of this.listeners) { try { listener(); } catch {} }
      return record;
    } catch { return null; }
  }
  filters(input = {}) {
    if (input instanceof URLSearchParams) {
      for (const key of input.keys()) if (input.getAll(key).length !== 1) throw new HttpError(400, `${key} 不能重复。`);
      input = Object.fromEntries(input);
    }
    const allowed = ['limit', 'before', 'after', 'level', 'source', 'q', 'from', 'to'];
    if (!input || typeof input !== 'object' || Object.keys(input).some(key => !allowed.includes(key))) throw new HttpError(400, '日志筛选参数无效。');
    const result = { limit: input.limit === undefined ? 200 : integer(input.limit, 'limit', 500, 1) };
    for (const key of ['before', 'after']) if (input[key] !== undefined) result[key] = integer(input[key], key, Number.MAX_SAFE_INTEGER, key === 'before' ? 1 : 0);
    if (result.before !== undefined && result.after !== undefined) throw new HttpError(400, 'before 和 after 不能同时使用。');
    for (const [key, choices] of [['level', LOG_LEVELS], ['source', LOG_SOURCES]]) if (input[key] !== undefined && input[key] !== '') { if (!choices.includes(input[key])) throw new HttpError(400, `${key} 参数无效。`); result[key] = input[key]; }
    if (input.q !== undefined) { if (typeof input.q !== 'string' || input.q.length > 200 || /[\u0000-\u001F]/u.test(input.q)) throw new HttpError(400, 'q 关键词无效。'); result.q = input.q.trim(); }
    for (const key of ['from', 'to']) if (input[key] !== undefined) result[key] = dateValue(input[key], key);
    if (result.from && result.to && result.from > result.to) throw new HttpError(400, '开始时间不能晚于结束时间。');
    return result;
  }
  list(input = {}, { exportLimit = null } = {}) {
    const filters = this.filters(input); this.prune();
    const stats = this.db.prepare('SELECT MIN(id) AS oldest,MAX(id) AS maximum FROM admin_runtime_logs').get();
    const cursor = stats.maximum ?? this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='admin_runtime_logs'").get()?.seq ?? 0;
    const clauses = ['id<=?'], values = [cursor];
    for (const [key, op, column] of [['before', '<', 'id'], ['after', '>', 'id'], ['level', '=', 'level'], ['source', '=', 'source'], ['from', '>=', 'timestamp'], ['to', '<=', 'timestamp']]) if (filters[key] !== undefined) { clauses.push(`${column}${op}?`); values.push(filters[key]); }
    if (filters.q) { const term = `%${filters.q.replace(/[\\%_]/gu, '\\$&')}%`; clauses.push(`(${['message', 'details_json', 'task_id', 'session_id', 'actor_id'].map(column => `${column} LIKE ? ESCAPE '\\'`).join(' OR ')})`); values.push(term, term, term, term, term); }
    const maximum = exportLimit ?? filters.limit;
    const rows = this.db.prepare(`SELECT * FROM admin_runtime_logs WHERE ${clauses.join(' AND ')} ORDER BY id ${filters.after !== undefined ? 'ASC' : 'DESC'} LIMIT ?`).all(...values, maximum + 1);
    const hasMore = rows.length > maximum; if (hasMore) rows.pop(); if (filters.after === undefined) rows.reverse();
    const logs = rows.map(row => ({ id: row.id, timestamp: row.timestamp, level: row.level, source: row.source, message: this.redact(row.message),
      ...(row.details_json ? { details: this.details(JSON.parse(row.details_json)) } : {}), ...(row.session_id ? { sessionId: row.session_id } : {}), ...(row.task_id ? { taskId: row.task_id } : {}), ...(row.actor_id ? { actorId: row.actor_id } : {}) }));
    return { logs, nextBefore: hasMore && filters.after === undefined ? logs[0]?.id ?? null : null, nextAfter: filters.after !== undefined ? hasMore ? logs.at(-1)?.id ?? filters.after : cursor : null,
      cursor, hasMore, sources: [...LOG_SOURCES], retention: { ...this.retention }, gap: filters.after !== undefined && stats.oldest > filters.after + 1, oldestId: stats.oldest ?? null };
  }
  live(req, res, input, { authenticate, actorId }) {
    if (this.closed || this.acceptingStreams === false) throw new HttpError(503, '日志服务正在关闭。');
    const filters = this.filters(input);
    if (filters.before !== undefined) throw new HttpError(400, '实时日志不支持 before。');
    if (this.streams.size >= this.maxStreams || [...this.streams].filter(stream => stream.actorId === actorId).length >= this.maxStreamsPerActor) throw new HttpError(429, '实时日志连接过多，请关闭多余页面。');
    let cursor = filters.after ?? this.list({ limit: 1 }).cursor, closed = false, pumping = false, blocked = false, scheduled = false, gapSent = false, slowTimer;
    const stream = { actorId, close: (expired = false) => finish(expired) };
    const authorized = () => { try { const current = authenticate(); return current?.id === actorId && current.role === 'admin' && !current.disabled; } catch { return false; } };
    const finish = (expired = false) => {
      if (closed) return; closed = true; clearInterval(interval); clearTimeout(slowTimer); this.listeners.delete(wake); this.streams.delete(stream); res.off('close', stream.close);
      if (blocked) { res.destroy(); return; }
      if (!res.destroyed && !res.writableEnded) { if (expired) res.write(`data: ${JSON.stringify({ type: 'auth_expired', message: '登录已失效或管理员权限已变更。' })}\n\n`); res.end(); }
    };
    const writeFrame = frame => {
      if (!authorized()) { finish(true); return false; }
      if (closed || res.destroyed || res.writableEnded || res.writableLength > 131072) { finish(); return false; }
      const ok = res.write(frame);
      if (!ok) { blocked = true; slowTimer = setTimeout(() => { res.destroy(); finish(); }, 10000); slowTimer.unref?.(); res.once('drain', () => { clearTimeout(slowTimer); blocked = false; wake(); }); }
      return ok;
    };
    const send = payload => writeFrame(`data: ${JSON.stringify(payload)}\n\n`);
    const pump = () => {
      if (closed || pumping || blocked) return;
      if (!authorized()) { finish(true); return; }
      pumping = true;
      try {
        const result = this.list({ ...filters, after: cursor, limit: 100 });
        if (result.gap && !gapSent) { gapSent = true; if (!send({ type: 'gap', oldestId: result.oldestId, message: '部分旧日志已超过保留期或数量上限，仅补发仍保留的记录。' })) return; }
        const batch = []; let bytes = 0;
        for (const log of result.logs) { const size = Buffer.byteLength(JSON.stringify(log)); if (batch.length && bytes + size > 49152) break; batch.push(log); bytes += size; }
        const allSent = batch.length === result.logs.length && !result.hasMore;
        const next = allSent ? result.cursor : batch.at(-1)?.id ?? cursor;
        if (batch.length || next !== cursor) { cursor = next; send({ type: 'logs', logs: batch, cursor }); }
        if (!allSent && !blocked && !closed) wake();
      } catch { finish(); }
      finally { pumping = false; }
    };
    const wake = () => { if (!closed && !scheduled) { scheduled = true; setImmediate(() => { scheduled = false; pump(); }); } };
    const interval = setInterval(() => { if (!authorized()) finish(true); else { pump(); if (!closed && !blocked) writeFrame(': heartbeat\n\n'); } }, this.authIntervalMs); interval.unref?.();
    if (!authorized()) { clearInterval(interval); throw new HttpError(401, '登录已失效，请重新登录。'); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders?.(); writeFrame(': connected\n\n');
    if (!closed) { res.on('close', stream.close); this.streams.add(stream); this.listeners.add(wake); wake(); }
    return stream;
  }
  revokeActor(actorId) { for (const stream of [...this.streams]) if (stream.actorId === actorId) stream.close(true); }
  /** Observe only bounded diagnostic columns; never collect channel message text,
   * QR contents, SDK stdout or credential columns. Repeated poll failures are deduplicated. */
  observeChannels() {
    if (this.closed) return;
    try {
      const next = new Map(), previous = this.channelStates || new Map();
      const tables = new Set(this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
      for (const [table, platform] of [['im_channels', 'weixin'], ['wecom_channels', 'wecom'], ['im_channel_inbox', 'weixin'], ['im_channel_outbox', 'weixin'], ['wecom_inbox', 'wecom'], ['wecom_outbox', 'wecom'], ['im_channel_logins', 'weixin']]) {
        if (!tables.has(table)) continue;
        const connection = table.endsWith('_channels'), login = table.endsWith('_logins');
        const columns = new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
        const rows = this.db.prepare(`SELECT ${['id', 'channel_id', 'session_id', 'status', 'last_error', 'attempts', 'poll_failures'].filter(column => columns.has(column)).join(',')} FROM ${table} ORDER BY ${columns.has('updated_at') ? 'updated_at' : columns.has('created_at') ? 'created_at' : 'id'} DESC LIMIT ${connection ? 500 : login ? 100 : 500}`).all();
        for (const row of rows) {
          const signature = `${row.status}:${row.last_error ? this.failure(row.last_error).reason : ''}`, key = `${table}:${row.id}`; next.set(key, signature);
          if (previous.get(key) === signature) continue;
          const failed = ['failed', 'error', 'expired', 'verify_code_blocked', 'login_required', 'interrupted'].includes(row.status);
          const retrying = Boolean(row.last_error) && !['sent', 'confirmed', 'cancelled'].includes(row.status);
          if (!connection && !failed && !retrying) continue;
          const phase = connection ? 'connection' : login ? 'login' : table.includes('outbox') ? 'delivery' : 'receive';
          this.write({ level: failed ? row.status === 'failed' || row.status === 'error' ? 'ERROR' : 'WARNING' : retrying || row.status === 'disconnected' ? 'WARNING' : 'INFO', source: 'channels',
            message: connection ? '消息渠道连接状态更新' : login ? '消息渠道登录状态异常' : phase === 'delivery' ? '外部渠道消息投递异常' : '外部渠道消息处理异常',
            sessionId: row.session_id, details: { platform, channelId: row.channel_id || row.id, targetId: connection ? undefined : row.id,
              phase, status: row.status, attempts: row.attempts ?? row.poll_failures, ...(row.last_error ? this.failure(row.last_error) : failed ? this.failure(row.status === 'expired' ? '二维码已过期' : row.status === 'interrupted' ? '服务重启' : '权限已失效') : {}) } });
        }
      }
      this.channelStates = next;
    } catch { /* Diagnostic capture must never interrupt channel processing. */ }
  }
  closeStreams() { this.acceptingStreams = false; for (const stream of [...this.streams]) stream.close(); this.listeners.clear(); }
  close() { this.closeStreams(); this.closed = true; }
}
