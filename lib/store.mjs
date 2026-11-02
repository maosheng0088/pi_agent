import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

export class Store {
  constructor(directory, defaultCwd) {
    this.directory = path.resolve(directory);
    this.sessionDir = path.join(this.directory, 'sessions');
    fs.mkdirSync(this.sessionDir, { recursive: true });
    this.configFile = path.join(this.directory, 'config.json');
    this.indexFile = path.join(this.directory, 'sessions.json');
    this.config = readJson(this.configFile, {
      provider: 'deepseek', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1',
      apiKey: '', cwd: path.resolve(defaultCwd), mode: 'read-only',
      systemPrompt: '你是企业业务与开发助手。请用中文清晰回答，先了解工作区内容，再给出有依据的结论。调用工具前尊重用户要求，不编造执行结果。',
    });
    this.db = new DatabaseSync(path.join(this.directory, 'workspace.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin','member')), password_hash TEXT NOT NULL,
        disabled INTEGER NOT NULL DEFAULT 0, auth_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS logins (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
        auth_version INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS logins_expiry ON logins(expires_at);
      CREATE TABLE IF NOT EXISTS session_meta (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_authors (
        session_id TEXT NOT NULL, message_id TEXT NOT NULL, author_id TEXT,
        author_name TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(session_id,message_id));
      CREATE INDEX IF NOT EXISTS session_authors_user ON session_authors(author_id,session_id);
      CREATE TABLE IF NOT EXISTS group_members (
        session_id TEXT NOT NULL REFERENCES session_meta(id), user_id TEXT NOT NULL REFERENCES users(id),
        added_by TEXT REFERENCES users(id), added_at TEXT NOT NULL,
        PRIMARY KEY(session_id,user_id));
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, action TEXT NOT NULL,
        actor_id TEXT, actor_name TEXT NOT NULL, target_id TEXT, details TEXT NOT NULL, ip TEXT);
      CREATE INDEX IF NOT EXISTS audit_time ON audit(at DESC);
    `);
    if (!this.db.prepare('SELECT value FROM metadata WHERE key=?').get('session_index_migrated')) {
      const legacy = readJson(this.indexFile, []);
      this.transaction(() => {
        const insert = this.db.prepare('INSERT OR IGNORE INTO session_meta(id,data) VALUES (?,?)');
        for (const meta of legacy) insert.run(meta.id, JSON.stringify({ ...meta, ownerId: null, legacyUnknownOwner: true }));
        this.db.prepare('INSERT INTO metadata(key,value) VALUES (?,?)').run('session_index_migrated', '1');
      });
    }
    this.sessions = this.db.prepare('SELECT data FROM session_meta').all().map((row) => JSON.parse(row.data));
    // Migrate historical participants once. Repeating this on startup would
    // silently re-invite a removed member merely because they spoke before.
    if (!this.db.prepare('SELECT value FROM metadata WHERE key=?').get('group_members_seeded')) {
      this.transaction(() => {
        this.db.exec(`INSERT OR IGNORE INTO group_members(session_id,user_id,added_by,added_at)
          SELECT a.session_id,a.author_id,NULL,MIN(a.created_at) FROM session_authors a
          JOIN users u ON u.id=a.author_id JOIN session_meta s ON s.id=a.session_id
          GROUP BY a.session_id,a.author_id;`);
        const seedMember = this.db.prepare('INSERT OR IGNORE INTO group_members VALUES (?,?,NULL,?)');
        for (const meta of this.sessions) if (meta.ownerId && this.db.prepare('SELECT id FROM users WHERE id=?').get(meta.ownerId)) seedMember.run(meta.id,meta.ownerId,meta.createdAt);
        this.db.prepare('INSERT INTO metadata(key,value) VALUES (?,?)').run('group_members_seeded', '1');
      });
    }
  }
  saveConfig(config) { writeJson(this.configFile, config); this.config = config; }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  saveSessions() {
    this.transaction(() => {
      const upsert = this.db.prepare('INSERT INTO session_meta(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data');
      for (const meta of this.sessions) upsert.run(meta.id, JSON.stringify(meta));
    });
  }
  recordSessionAuthor(sessionId, messageId, user, createdAt = new Date().toISOString()) {
    this.db.prepare('INSERT OR IGNORE INTO session_authors(session_id,message_id,author_id,author_name,created_at) VALUES (?,?,?,?,?)')
      .run(sessionId, messageId, user?.id || null, user?.displayName || '历史发言人未记录', createdAt);
  }
  sessionAuthors(sessionId) {
    return new Map(this.db.prepare('SELECT message_id,author_id,author_name FROM session_authors WHERE session_id=?').all(sessionId)
      .map((row) => [row.message_id, {
        authorId: row.author_id, authorName: row.author_name, ...(!row.author_id ? { authorUnknown: true } : {}),
      }]));
  }
  sessionParticipants(sessionId) {
    return this.db.prepare('SELECT DISTINCT author_id,author_name FROM session_authors WHERE session_id=?').all(sessionId);
  }
  close() { this.db.close(); }
  publicConfig() { const { apiKey, ...config } = this.config; return { ...config, apiKeySet: Boolean(apiKey) }; }
}
