import { storedCards, taskResultCard } from './message-cards.mjs';

/** Durable final-result messages kept outside Pi's active session transcript. */
export class TaskDeliveryService {
  constructor(store, { publish = () => {}, validateTarget = () => {}, redact = String,
    now = () => new Date(), onPosted = () => {}, preparePublish = () => {} } = {}) {
    this.store = store; this.db = store.db;
    this.publish = publish; this.validateTarget = validateTarget;
    this.redact = redact; this.now = now; this.onPosted = onPosted;
    this.preparePublish = preparePublish;
    this.inFlight = new Map();
    this.db.exec(`CREATE TABLE IF NOT EXISTS task_group_messages (
      run_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS task_group_messages_session ON task_group_messages(session_id,created_at,run_id);
      CREATE TABLE IF NOT EXISTS task_deliveries (
        run_id TEXT PRIMARY KEY,target_session_id TEXT NOT NULL,status TEXT NOT NULL,
        error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_admin_attention (
        run_id TEXT NOT NULL, carrier TEXT NOT NULL, kind TEXT NOT NULL,
        session_id TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, closed_at TEXT,
        PRIMARY KEY(run_id,carrier,kind));
      CREATE INDEX IF NOT EXISTS task_admin_attention_session ON task_admin_attention(session_id,created_at);`);
    if (!this.db.prepare('PRAGMA table_info(task_group_messages)').all().some(row => row.name === 'cards_json')) this.db.exec("ALTER TABLE task_group_messages ADD COLUMN cards_json TEXT NOT NULL DEFAULT '[]'");
    if (!this.db.prepare('PRAGMA table_info(task_admin_attention)').all().some(row => row.name === 'closed_at')) this.db.exec('ALTER TABLE task_admin_attention ADD COLUMN closed_at TEXT');
  }

  get(runId) {
    const row = this.db.prepare('SELECT * FROM task_deliveries WHERE run_id=?').get(runId);
    return row ? { runId: row.run_id, targetSessionId: row.target_session_id, status: row.status,
      error: row.error, createdAt: row.created_at, updatedAt: row.updated_at }
      : { runId, targetSessionId: null, status: 'not_required', error: null };
  }

  pending() {
    return this.db.prepare("SELECT run_id FROM task_deliveries WHERE status='pending' ORDER BY created_at,run_id")
      .all().map(row => this.get(row.run_id));
  }

  _attentionContent(row) {
    const status = row.execution_status;
    let ended;
    if (status === 'cancelled') ended = '本次任务已取消，检查未完成；本轮不再等待验证码。';
    else if (status === 'interrupted') ended = '本次任务已中断，检查未完成；本轮不再等待验证码。需要检查时请重新发起任务。';
    else if (row.closed_at || ['succeeded', 'failed', 'skipped'].includes(status)) {
      ended = row.has_final_result ? '本次任务已结束，请查看本次最终检查结果。'
        : '本次任务已结束，本轮不再等待验证码；尚无已投递的检查结果，请查看管理员运行记录。';
    }
    return ended ? this.redact(`管理员处理记录：Amazon 登录验证\n\n承运人：${row.carrier}\n${ended}\n此记录仅管理员可见。`)
      : row.content.replace('验证码、二次验证或账户选择', '验证码或二次验证');
  }

  history(sessionId, { includeAttention = false } = {}) {
    const messages = this.db.prepare('SELECT * FROM task_group_messages WHERE session_id=? ORDER BY created_at,run_id')
      .all(sessionId).map(row => ({ id: `task:${row.run_id}`, role: 'assistant', content: row.content,
        timestamp: Date.parse(row.created_at), createdAt: row.created_at,
        taskRunId: row.run_id, authorName: 'Pi · 定时任务', ...(storedCards(row.cards_json).length ? { cards: storedCards(row.cards_json) } : {}) }));
    if (includeAttention) {
      // Cancellation, shutdown and recovery can finish a run without a final
      // delivery. Read the persisted execution status rather than leaving its
      // old verification prompt waiting forever. Standalone delivery clients do
      // not necessarily have a scheduler table.
      const hasRuns = Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_runs'").get());
      const rows = this.db.prepare(`SELECT a.*, ${hasRuns ? 'r.status' : 'NULL'} AS execution_status,
        EXISTS(SELECT 1 FROM task_group_messages m WHERE m.run_id=a.run_id) AS has_final_result
        FROM task_admin_attention a ${hasRuns ? 'LEFT JOIN task_runs r ON r.id=a.run_id' : ''}
        WHERE a.session_id=? ORDER BY a.created_at,a.run_id,a.carrier`).all(sessionId);
      messages.push(...rows.map(row => ({ id: `attention:${row.run_id}:${row.carrier}:${row.kind}`, role: 'assistant',
        content: this._attentionContent(row), timestamp: Date.parse(row.created_at), createdAt: row.created_at,
        authorName: 'Pi · 管理员通知' })));
    }
    return messages.sort((left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id));
  }

  context(sessionId) { return this.history(sessionId); }

  attention({ schedule, run, event }) {
    if (schedule.taskType !== 'business' || !schedule.targetSessionId || !run?.id || event?.runId !== run.id
      || event?.status !== 'waiting_human' || event.kind !== 'verification_required'
      || event.browser !== 'Chromium' || typeof event.carrier !== 'string'
      || !/^[\p{L}\p{N}][\p{L}\p{N} _.-]{0,47}$/u.test(event.carrier)) throw new Error('人工验证通知无效。');
    // Revalidate the current administrator and bound-group membership each time.
    // This is an administrator-only local notice, never a channel publication or
    // an AI round, and it cannot consume or overwrite the final-result delivery.
    this.validateTarget(schedule, { phase: 'delivery' });
    const existing = this.db.prepare('SELECT session_id FROM task_admin_attention WHERE run_id=? AND carrier=? AND kind=?')
      .get(run.id, event.carrier, event.kind);
    if (existing && existing.session_id !== schedule.targetSessionId) throw new Error('人工验证通知的业务群不能变更。');
    const content = this.redact(`管理员处理：Amazon 登录验证\n\n承运人：${event.carrier}\n请在本机该承运人的专属 Chromium 窗口完成验证码或二次验证。\n当前任务仍在运行，最多等待 10 分钟。\n完成浏览器验证后程序会继续；若等待超时，本次检查会记录失败。\n此通知仅管理员可见，检查结果将在任务结束后另行投递。`);
    const inserted = this.db.prepare('INSERT OR IGNORE INTO task_admin_attention(run_id,carrier,kind,session_id,content,created_at) VALUES (?,?,?,?,?,?)')
      .run(run.id, event.carrier, event.kind, schedule.targetSessionId, content, this.now().toISOString());
    if (inserted.changes) this.onPosted(schedule.targetSessionId);
    return { posted: Boolean(inserted.changes), targetSessionId: schedule.targetSessionId };
  }

  deliver(input) {
    const runId = input.run.id;
    if (this.inFlight.has(runId)) return this.inFlight.get(runId);
    const work = this._deliver(input).finally(() => this.inFlight.delete(runId));
    this.inFlight.set(runId, work);
    return work;
  }

  retry(input) { return this.deliver(input); }

  async _deliver({ schedule, run, result }) {
    const existing = this.get(run.id);
    // External-channel retries are handled against the channel snapshot by the
    // hub. Re-publishing a completed result could notify a newly bound channel.
    if (existing.status === 'delivered') return existing;
    const targetSessionId = existing.targetSessionId || schedule.targetSessionId;
    if (!targetSessionId) return existing;
    const at = this.now().toISOString();
    this.db.prepare('UPDATE task_admin_attention SET closed_at=? WHERE run_id=? AND closed_at IS NULL').run(at, run.id);
    try {
      if (existing.targetSessionId && existing.targetSessionId !== schedule.targetSessionId) {
        throw new Error('任务结果的投递群聊不能变更。');
      }
      this.validateTarget(schedule, { phase: 'delivery' });
      let posted = false;
      this.store.transaction(() => {
        let content = this.redact(`定时任务：${schedule.name}\n\n${String(result ?? '')}`);
        if (content.length > 99000) content = `${content.slice(0, 98500)}\n\n（结果过长，完整内容请查看管理员运行记录。）`;
        const saved = this.db.prepare('SELECT content FROM task_group_messages WHERE run_id=?').get(run.id);
        // Capture channel epochs in the same transaction as the group result;
        // even a crash before enqueue cannot expose old output to a new binding.
        this.preparePublish(targetSessionId, { text: saved?.content || content, authorName: 'Pi · 定时任务', messageId: `task:${run.id}` });
        const card = taskResultCard({ ...run, scheduleName: schedule.name, result: String(result ?? '') }, 'schedule');
        const inserted = this.db.prepare('INSERT OR IGNORE INTO task_group_messages(run_id,session_id,content,created_at,cards_json) VALUES (?,?,?,?,?)')
          .run(run.id, targetSessionId, content, at, JSON.stringify(card ? [card] : []));
        posted = Boolean(inserted.changes);
        this.db.prepare(`INSERT INTO task_deliveries(run_id,target_session_id,status,error,created_at,updated_at)
          VALUES (?,?,'pending',NULL,?,?) ON CONFLICT(run_id) DO UPDATE SET status='pending',error=NULL,updated_at=excluded.updated_at`)
          .run(run.id, targetSessionId, at, at);
      });
      if (posted) this.onPosted(targetSessionId);
      const message = this.db.prepare('SELECT content FROM task_group_messages WHERE run_id=?').get(run.id);
      await this.publish(targetSessionId, { text: message.content,
        authorName: 'Pi · 定时任务', messageId: `task:${run.id}` });
      this.db.prepare("UPDATE task_deliveries SET status='delivered',error=NULL,updated_at=? WHERE run_id=?")
        .run(this.now().toISOString(), run.id);
    } catch (error) {
      // Execution has already finished. A notification failure must never make
      // the scheduler repeat the business action or discard its final result.
      this.db.prepare(`INSERT INTO task_deliveries(run_id,target_session_id,status,error,created_at,updated_at)
        VALUES (?,?,'failed',?,?,?) ON CONFLICT(run_id) DO UPDATE SET status='failed',error=excluded.error,updated_at=excluded.updated_at`)
        .run(run.id, targetSessionId, this.redact(String(error?.message || error)).slice(0, 2000), at, this.now().toISOString());
    }
    return this.get(run.id);
  }
}
