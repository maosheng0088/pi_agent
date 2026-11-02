import { createHash } from 'node:crypto';
import { HttpError } from './security.mjs';

const stableId = value => createHash('sha256').update(value).digest('hex').slice(0, 32);
const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const terminal = new Set(['succeeded', 'failed', 'skipped', 'cancelled', 'interrupted']);
const statuses = { succeeded: '已完成', failed: '执行失败', skipped: '已跳过', cancelled: '已取消', interrupted: '已中断' };
const text = (value, limit = 500) => String(value ?? '').slice(0, limit);
const dateText = value => Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value)) : '';

/** Only real task-service records may be supplied here, never model JSON. */
export function taskResultCard(task, taskKind = 'work') {
  if (!task || !identifier.test(task.id) || !terminal.has(task.status) || !['work', 'schedule'].includes(taskKind)) return null;
  const failed = ['failed', 'interrupted'].includes(task.status);
  const title = text(task.title ?? task.scheduleName ?? task.name ?? '业务任务', 120);
  const fields = [{ label: '完成方式', value: taskKind === 'work' ? '智能体执行' : '定时执行' }];
  if (task.assigneeName) fields.push({ label: '负责人', value: text(task.assigneeName, 100) });
  if (task.createdByName ?? task.requestedByName) fields.push({ label: '提交人', value: text(task.createdByName ?? task.requestedByName, 100) });
  if (dateText(task.finishedAt)) fields.push({ label: '结束时间（北京时间）', value: dateText(task.finishedAt) });
  const elapsed = Date.parse(task.finishedAt) - Date.parse(task.startedAt);
  if (Number.isFinite(elapsed) && elapsed >= 0) fields.push({ label: '耗时', value: elapsed < 1000 ? '不足 1 秒' : `${Math.round(elapsed / 1000)} 秒` });
  return { version: 1, id: `mc-${stableId(`${taskKind}:${task.id}:${task.attempt ?? 0}:${task.status}:${task.finishedAt ?? ''}`)}`,
    kind: failed ? 'task_exception' : 'task_result', title,
    summary: text(failed ? task.error ?? task.result : task.result, 360), status: task.status, fields, taskId: task.id, taskKind };
}

export function storedCards(value) {
  if (!value) return [];
  try {
    const cards = JSON.parse(value);
    return Array.isArray(cards) ? cards.filter(card => card?.version === 1 && identifier.test(card.id) && ['task_result', 'task_exception', 'knowledge'].includes(card.kind)) : [];
  } catch { return []; }
}

/** Immutable snapshots of the actual retrieval handed to a particular turn.
 * Source contents are snippets, not a fresh read of the mutable document.
 * HTTP callers must establish group membership before reading this service.
 */
export class MessageCardService {
  constructor(store, { now = () => new Date() } = {}) {
    this.store = store; this.db = store.db; this.now = now;
    this.db.exec(`CREATE TABLE IF NOT EXISTS message_card_snapshots (
      group_id TEXT NOT NULL REFERENCES session_meta(id) ON DELETE CASCADE,
      message_key TEXT NOT NULL, card_id TEXT NOT NULL, card_json TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(group_id,message_key), UNIQUE(group_id,card_id));`);
  }

  captureKnowledge(groupId, messageKey, matches, reply) {
    if (!identifier.test(groupId) || typeof messageKey !== 'string' || messageKey.length > 240) throw new HttpError(400, '消息资料快照编号无效。');
    if (!Array.isArray(matches) || !matches.length) return null;
    const sources = [], seen = new Set();
    for (const match of matches.slice(0, 20)) {
      if (match.groupId !== groupId || !identifier.test(match.documentId) || !Number.isSafeInteger(match.version) || match.version < 1 ||
        typeof match.title !== 'string' || typeof match.excerpt !== 'string' || typeof match.citation !== 'string' ||
        !/^[a-f0-9]{64}$/i.test(match.contentHash ?? '') || !Number.isFinite(Date.parse(match.updatedAt))) throw new HttpError(400, '知识来源必须是当前业务群本轮实际检索的资料快照。');
      if (seen.has(match.documentId)) continue;
      seen.add(match.documentId);
      sources.push({ documentId: match.documentId, title: text(match.title, 120), sourceName: text(match.sourceName, 180), version: match.version,
        updatedAt: match.updatedAt, contentHash: match.contentHash, excerpt: text(match.excerpt, 1000), citation: text(match.citation, 250),
        cited: typeof reply === 'string' && reply.includes(match.citation) });
    }
    const cited = sources.every(source => source.cited);
    const card = { version: 1, id: `kc-${stableId(`${groupId}:${messageKey}`)}`, kind: 'knowledge', title: cited ? '引用资料' : '本次参考资料',
      summary: cited ? '回复中引用了以下实际检索资料。' : '以下资料曾提供给本轮智能体参考；不代表回复的每项结论都已获资料支持。', sources };
    this.db.prepare('INSERT OR IGNORE INTO message_card_snapshots(group_id,message_key,card_id,card_json,created_at) VALUES (?,?,?,?,?)')
      .run(groupId, messageKey, card.id, JSON.stringify(card), new Date(this.now()).toISOString());
    return this.get(groupId, messageKey);
  }
  get(groupId, messageKey) {
    const row = this.db.prepare('SELECT card_json FROM message_card_snapshots WHERE group_id=? AND message_key=?').get(groupId, messageKey);
    return row ? storedCards(`[${row.card_json}]`)[0] ?? null : null;
  }
  bindKnowledge(groupId, fromKey, messageKey) {
    const original = this.get(groupId, fromKey);
    if (!original) return;
    const card = { ...original, id: `kc-${stableId(`${groupId}:${messageKey}`)}` };
    this.db.prepare('INSERT OR IGNORE INTO message_card_snapshots(group_id,message_key,card_id,card_json,created_at) VALUES (?,?,?,?,?)')
      .run(groupId, messageKey, card.id, JSON.stringify(card), new Date(this.now()).toISOString());
  }
  enrich(groupId, messages) {
    return messages.map(message => {
      const cards = [...(message.cards ?? [])];
      if (message.role !== 'assistant') return message;
      let key = message.id;
      if (message.workTaskId) {
        const task = this.db.prepare('SELECT * FROM work_tasks WHERE id=? AND session_id=?').get(message.workTaskId, groupId);
        if (task) {
          key = message.id;
          // Old messages predate cards_json. Their terminal event is immutable;
          // never relabel an old failure using a newer task status.
          if (!cards.some(card => card.taskKind === 'work')) {
            const event = this.db.prepare("SELECT * FROM work_task_events WHERE task_id=? AND session_id=? AND type IN ('succeeded','failed') AND created_at=? ORDER BY seq DESC LIMIT 1").get(task.id, groupId, message.createdAt);
            if (event) {
              const data = JSON.parse(event.data_json);
              const card = taskResultCard({ id: task.id, title: data.title ?? '历史任务结果', status: event.type, result: message.content,
                error: data.error, attempt: data.attempt ?? 0, finishedAt: event.created_at }, 'work');
              if (card) cards.push(card);
            }
          }
        }
      } else if (message.taskRunId) {
        key = `task:${message.taskRunId}`;
        if (!cards.some(card => card.taskKind === 'schedule')) {
          const row = this.db.prepare('SELECT r.* FROM task_runs r JOIN task_group_messages m ON m.run_id=r.id WHERE r.id=? AND m.session_id=?').get(message.taskRunId, groupId);
          if (row) {
            const card = taskResultCard({ id: row.id, scheduleName: row.schedule_name, status: row.status, result: message.content, error: row.error, finishedAt: row.finished_at }, 'schedule');
            if (card) cards.push(card);
          }
        }
      }
      const knowledge = this.get(groupId, message.id) ?? (key && this.get(groupId, key));
      if (knowledge) cards.push(knowledge);
      return cards.length ? { ...message, cards: [...new Map(cards.map(card => [card.id, card])).values()] } : message;
    });
  }
  source(groupId, cardId, documentId) {
    if (!identifier.test(groupId) || !identifier.test(cardId) || !identifier.test(documentId)) throw new HttpError(400, '资料来源编号无效。');
    const row = this.db.prepare('SELECT card_json FROM message_card_snapshots WHERE group_id=? AND card_id=?').get(groupId, cardId);
    const source = row && storedCards(`[${row.card_json}]`)[0]?.sources?.find(item => item.documentId === documentId);
    if (!source) throw new HttpError(404, '此消息的资料来源不存在。');
    const current = this.db.prepare('SELECT * FROM agent_knowledge_documents WHERE group_id=? AND id=?').get(groupId, documentId);
    return { source, state: !current ? 'deleted' : current.version !== source.version || current.content_hash !== source.contentHash ? 'updated' : 'current',
      current: current ? { id: current.id, groupId, title: current.title, sourceName: current.source_name, format: current.format, version: current.version,
        updatedAt: current.updated_at, contentHash: current.content_hash, content: current.content } : null };
  }
}
