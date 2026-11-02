import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes, randomUUID, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

const scrypt = promisify(scryptCallback);

function normalizeUsers(input) {
  if (!Array.isArray(input) || !input.length || input.length > 1000) throw new Error('请提供 1 至 1000 个账号的 JSON 数组。');
  const names = new Set();
  return input.map((row, index) => {
    if (!row || typeof row !== 'object') throw new Error(`第 ${index + 1} 行格式无效。`);
    if (typeof row.username !== 'string') throw new Error(`第 ${index + 1} 行账号必须是字符串，以保留前导零。`);
    const username = row.username.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_.-]{2,47}$/.test(username)) throw new Error(`第 ${index + 1} 行账号格式无效。`);
    if (names.has(username)) throw new Error(`账号 ${username} 在导入数据中重复。`);
    names.add(username);
    const displayName = typeof row.displayName === 'string' ? row.displayName.trim() : '';
    if (!displayName || displayName.length > 80) throw new Error(`账号 ${username} 的姓名须为 1 至 80 个字符。`);
    const role = row.role ?? 'member';
    if (!['admin', 'member'].includes(role)) throw new Error(`账号 ${username} 的角色无效。`);
    if (typeof row.password !== 'string' || !row.password.length || row.password.length > 128) throw new Error(`账号 ${username} 的密码格式无效。`);
    return { username, displayName, role, password: row.password };
  });
}

/** Local administrator utility. Plaintext input is kept in memory and never written to a file. */
export async function importUsers({ dataDir, users, allowShortInitialAdmin = false }) {
  const rows = normalizeUsers(users);
  const database = path.resolve(dataDir, 'workspace.sqlite');
  await fs.access(database);
  const db = new DatabaseSync(database);
  try {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    const existing = new Set(db.prepare('SELECT username FROM users').all().map(row => row.username));
    const pending = rows.filter(row => !existing.has(row.username));
    const initialAdmin = !db.prepare("SELECT id FROM users WHERE role='admin' AND disabled=0 LIMIT 1").get();
    if (initialAdmin && !pending.some(row => row.role === 'admin')) throw new Error('首次导入必须包含一个管理员，避免锁定管理入口。');
    for (const row of pending) {
      const minimum = initialAdmin && allowShortInitialAdmin && row.role === 'admin' ? 4 : 8;
      if (row.password.length < minimum) throw new Error(`账号 ${row.username} 的密码少于 ${minimum} 位。`);
    }
    const hashed = [];
    for (const row of pending) {
      const salt = randomBytes(16).toString('hex');
      const derived = await scrypt(row.password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
      hashed.push({ id: randomUUID(), username: row.username, displayName: row.displayName, role: row.role, hash: `scrypt:${salt}:${derived.toString('hex')}` });
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      if (initialAdmin && allowShortInitialAdmin && db.prepare("SELECT id FROM users WHERE role='admin' AND disabled=0 LIMIT 1").get()) throw new Error('管理员状态已变化，请重新执行导入。');
      const now = new Date().toISOString();
      const insert = db.prepare('INSERT INTO users(id,username,display_name,role,password_hash,created_at) VALUES (?,?,?,?,?,?)');
      for (const row of hashed) insert.run(row.id, row.username, row.displayName, row.role, row.hash, now);
      const admin = db.prepare("SELECT id,display_name FROM users WHERE role='admin' AND disabled=0 ORDER BY created_at,username LIMIT 1").get();
      if (!admin) throw new Error('导入后需要保留一个可用管理员。');
      if (initialAdmin) {
        const update = db.prepare('UPDATE session_meta SET data=? WHERE id=?');
        for (const row of db.prepare('SELECT id,data FROM session_meta').all()) {
          const meta = JSON.parse(row.data);
          if (!meta.ownerId) update.run(JSON.stringify({ ...meta, ownerId: admin.id, legacyUnknownOwner: true }), row.id);
        }
        db.prepare('INSERT INTO audit(at,action,actor_id,actor_name,target_id,details,ip) VALUES (?,?,?,?,?,?,?)')
          .run(now, 'workspace.setup', admin.id, admin.display_name, admin.id, JSON.stringify({ source: 'local-stdin-import' }), null);
      }
      const result = { created: hashed.length, skipped: rows.length - hashed.length, total: rows.length, createdAdmins: hashed.filter(row => row.role === 'admin').length, createdMembers: hashed.filter(row => row.role === 'member').length };
      db.prepare('INSERT INTO audit(at,action,actor_id,actor_name,target_id,details,ip) VALUES (?,?,?,?,?,?,?)')
        .run(now, 'users.imported', admin.id, admin.display_name, null, JSON.stringify({ ...result, source: 'local-stdin-import' }), null);
      db.exec('COMMIT');
      return result;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    const dataIndex = args.indexOf('--data-dir');
    const dataDir = dataIndex >= 0 ? args[dataIndex + 1] : path.resolve(import.meta.dirname, '../.data');
    if (!dataDir) throw new Error('--data-dir 缺少目录。');
    let input = '';
    for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 1048576) throw new Error('导入数据超过 1 MB。'); }
    const users = JSON.parse(input);
    input = '';
    const result = await importUsers({ dataDir, users, allowShortInitialAdmin: args.includes('--allow-short-initial-admin') });
    for (const row of users) if (row && typeof row === 'object') delete row.password;
    console.log(JSON.stringify(result));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
