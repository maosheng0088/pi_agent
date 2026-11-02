import { HttpError } from './security.mjs';

/** Per-member receipts. Only public messages enter this index, never tool output
 * or administrator-only verification notices. Existing history starts read. */
export class SessionAttention {
  constructor(store) {
    this.store = store; this.db = store.db; this.collaborationSeq = 0; this.scheduleRow = 0;
    this.db.exec(`CREATE TABLE IF NOT EXISTS session_attention_messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, source_id TEXT NOT NULL,
      role TEXT NOT NULL, author_id TEXT, mentions_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL,
      UNIQUE(session_id,source_id));
      CREATE INDEX IF NOT EXISTS session_attention_group ON session_attention_messages(session_id,seq);
      CREATE TABLE IF NOT EXISTS session_read_receipts (
      session_id TEXT NOT NULL,user_id TEXT NOT NULL,read_seq INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(session_id,user_id));`);
    if (!this.db.prepare("SELECT value FROM metadata WHERE key='attention_v1'").get()) {
      store.transaction(() => {
        this.sync();
        this.db.exec(`INSERT OR IGNORE INTO session_read_receipts(session_id,user_id,read_seq)
          SELECT g.session_id,g.user_id,COALESCE((SELECT MAX(seq) FROM session_attention_messages m WHERE m.session_id=g.session_id),0) FROM group_members g;`);
        this.db.prepare("INSERT INTO metadata(key,value) VALUES ('attention_v1','1')").run();
      });
    }
  }
  sync() {
    // Reconcile from durable sources, including a crash after the message was
    // committed. Only rows not already indexed are inserted.
    this.db.prepare(`INSERT INTO session_attention_messages(session_id,source_id,role,author_id,mentions_json,created_at)
      SELECT c.session_id,'discussion:'||c.id,c.role,c.author_id,c.mentions_json,c.created_at FROM collaboration_messages c
      WHERE c.seq>? AND NOT EXISTS(SELECT 1 FROM session_attention_messages m WHERE m.session_id=c.session_id AND m.source_id='discussion:'||c.id)
      ORDER BY c.seq`).run(this.collaborationSeq);
    this.collaborationSeq = this.db.prepare('SELECT COALESCE(MAX(seq),0) AS value FROM collaboration_messages').get().value;
    this.db.prepare(`INSERT INTO session_attention_messages(session_id,source_id,role,created_at)
      SELECT c.session_id,'task:'||c.run_id,'assistant',c.created_at FROM task_group_messages c
      WHERE c.rowid>? AND NOT EXISTS(SELECT 1 FROM session_attention_messages m WHERE m.session_id=c.session_id AND m.source_id='task:'||c.run_id)
      ORDER BY c.rowid`).run(this.scheduleRow);
    this.scheduleRow = this.db.prepare('SELECT COALESCE(MAX(rowid),0) AS value FROM task_group_messages').get().value;
  }
  record(sessionId, sourceId, role, authorId = null) {
    this.db.prepare(`INSERT OR IGNORE INTO session_attention_messages(session_id,source_id,role,author_id,created_at) VALUES (?,?,?,?,?)`)
      .run(sessionId, sourceId, role, authorId, new Date().toISOString());
  }
  cursor(sessionId) {
    return this.db.prepare('SELECT COALESCE(MAX(seq),0) AS value FROM session_attention_messages WHERE session_id=?').get(sessionId).value;
  }
  join(sessionId,userId) {
    this.db.prepare(`INSERT INTO session_read_receipts(session_id,user_id,read_seq) VALUES (?,?,?)
      ON CONFLICT(session_id,user_id) DO UPDATE SET read_seq=MAX(read_seq,excluded.read_seq)`).run(sessionId,userId,this.cursor(sessionId));
  }
  summary(sessionId, user) {
    const row = this.db.prepare(`SELECT COUNT(*) AS unreadCount,
      COALESCE(SUM(m.role='assistant'),0) AS resultCount,
      COALESCE(SUM(EXISTS(SELECT 1 FROM json_each(m.mentions_json) j WHERE j.value=?)),0) AS mentionCount
      FROM session_attention_messages m JOIN group_members g ON g.session_id=m.session_id AND g.user_id=?
      LEFT JOIN session_read_receipts r ON r.session_id=m.session_id AND r.user_id=g.user_id
      WHERE m.session_id=? AND m.seq>COALESCE(r.read_seq,0) AND m.created_at>=g.added_at
      AND (m.author_id IS NULL OR m.author_id<>?)`).get(user.id,user.id,sessionId,user.id);
    const pending = this.db.prepare(`SELECT COUNT(*) AS count FROM work_tasks WHERE session_id=? AND deleted_at IS NULL
      AND status IN ('waiting_human','interrupted') AND (assignee_id=? OR (assignee_id IS NULL AND created_by=?))`).get(sessionId,user.id,user.id);
    return { ...row, pendingCount: pending.count };
  }
  read(sessionId, user, cursor) {
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > this.cursor(sessionId)) throw new HttpError(400, '已读位置无效，请刷新聊天记录。');
    this.db.prepare(`INSERT INTO session_read_receipts(session_id,user_id,read_seq) VALUES (?,?,?)
      ON CONFLICT(session_id,user_id) DO UPDATE SET read_seq=MAX(read_seq,excluded.read_seq)`).run(sessionId,user.id,cursor);
    return this.summary(sessionId,user);
  }
}
