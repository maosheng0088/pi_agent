import { createHash } from 'node:crypto';
import { projectAttachmentMessages } from './attachment-output.mjs';
import { publicMessages } from './pi.mjs';
import { HttpError } from './security.mjs';

const sourceEntry = Symbol('administrator-conversation-source');
const sessionIdentifier = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;

/** Administrator-only projection of persisted entries, including abandoned
 * branches and messages omitted from the compacted model context. Authorization
 * and final redaction belong to the caller; normal chat history is unaffected. */
export function adminConversationMessages(manager, store, meta, lookupAttachment = () => null) {
  if (!manager) return [];
  const recorded = store.sessionAuthors(meta.id), authors = new Map(), result = [];
  let segment = [], previousId, previousSource = 'attachments';
  const flush = () => {
    for (const message of projectAttachmentMessages(segment, lookupAttachment)) {
      const visible = publicMessages([message], authors)[0];
      if (!visible) continue;
      const entryId = message[sourceEntry];
      if (entryId) previousSource = entryId;
      // A tool-only turn may add a synthetic attachment row. Keep its ID separate
      // from every persisted message so later entries cannot inherit its index.
      const id = entryId ? `pi:${meta.id}:${entryId}:0`
        : `pi:${meta.id}:${previousSource}:attachment-${createHash('sha256').update(JSON.stringify(visible)).digest('hex').slice(0, 24)}`;
      result.push({ ...visible, id });
    }
    segment = [];
  };
  for (const entry of manager.getEntries()) {
    // A changed parent marks a new persisted branch. Its attachment projection
    // must not consume an unfinished attachment from the abandoned branch.
    if (previousId !== undefined && entry.parentId !== undefined && entry.parentId !== previousId) flush();
    previousId = entry.id;
    if (entry.type !== 'message' || !entry.message) continue;
    const message = { ...entry.message, timestamp: entry.message.timestamp ?? entry.timestamp, [sourceEntry]: entry.id };
    if (message.role === 'user' && recorded.has(entry.id)) authors.set(message, recorded.get(entry.id));
    segment.push(message);
  }
  flush();
  return result;
}

/** Bounded cursor pages across the complete stored discussion. This helper is
 * private to authenticated administrator routes, not a group access bypass. */
export function discussionPage(store, workTasks, sessionId, { before, limit = 1000 } = {}) {
  if (typeof sessionId !== 'string' || !sessionIdentifier.test(sessionId)) throw new HttpError(400, '群聊编号无效。');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new HttpError(400, '讨论分页大小须为 1–1000 的安全整数。');
  if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) throw new HttpError(400, '讨论分页游标须为正安全整数。');
  const rows = store.db.prepare(`SELECT * FROM collaboration_messages WHERE session_id=?${before === undefined ? '' : ' AND seq<?'} ORDER BY seq DESC LIMIT ?`)
    .all(sessionId, ...(before === undefined ? [] : [before]), limit + 1);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).reverse();
  return {
    messages: page.map(row => workTasks.messageView(row)),
    total: store.db.prepare('SELECT COUNT(*) AS total FROM collaboration_messages WHERE session_id=?').get(sessionId).total,
    hasMore,
    nextBefore: hasMore ? page[0].seq : null,
  };
}
