import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { importUsers } from '../scripts/import-users.mjs';

test('local batch import preserves string accounts, hashes secrets, and skips existing credentials', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-user-import-test-'));
  const store = new Store(directory, path.join(directory, 'workspace'));
  try {
    const users = [
      { username: 'admin', displayName: '管理员', role: 'admin', password: '4826' },
      { username: '003001', displayName: '  测试员工  ', password: 'NinePass9' },
    ];
    await assert.rejects(importUsers({ dataDir: directory, users }), /少于 8/);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0);
    const result = await importUsers({ dataDir: directory, users, allowShortInitialAdmin: true });
    assert.equal(result.created, 2); assert.equal(result.createdAdmins, 1); assert.equal(result.createdMembers, 1);
    const member = store.db.prepare('SELECT * FROM users WHERE username=?').get('003001');
    assert.equal(member.display_name, '测试员工'); assert.match(member.password_hash, /^scrypt:/); assert.ok(!member.password_hash.includes('NinePass9'));
    users[1].password = 'ChangedPass9';
    const repeated = await importUsers({ dataDir: directory, users, allowShortInitialAdmin: true });
    assert.equal(repeated.created, 0); assert.equal(repeated.skipped, 2);
    assert.equal(store.db.prepare('SELECT password_hash FROM users WHERE username=?').get('003001').password_hash, member.password_hash);
    const audit = store.db.prepare('SELECT details FROM audit').all().map(row => row.details).join('');
    assert.ok(!audit.includes('4826') && !audit.includes('NinePass9') && !audit.includes('ChangedPass9'));
  } finally { store.close(); assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); await fs.rm(directory, { recursive: true, force: true }); }
});

test('invalid batch rows leave the database unchanged and require explicit administrative bootstrap', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-user-import-test-'));
  const store = new Store(directory, directory);
  try {
    await assert.rejects(importUsers({ dataDir: directory, users:[{ username:'003002',displayName:'测试员工',password:'ValidPass9' }] }), /管理员/);
    await assert.rejects(importUsers({ dataDir: directory, users:[{ username:3002,displayName:'测试员工',password:'ValidPass9' }] }), /字符串/);
    await assert.rejects(importUsers({ dataDir: directory, users:[{username:'admin',displayName:'管理员',role:'admin',password:'StrongAdmin9'},{username:'003002',displayName:'测试员工',password:'short7x'}] }), /少于 8/);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0);
  } finally { store.close(); assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); await fs.rm(directory, { recursive: true, force: true }); }
});
