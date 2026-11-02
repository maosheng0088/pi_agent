import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { createFixture } from './auth-helpers.mjs';

const eightCharacterPassword = 'Test-8!x';
const nineCharacterPassword = 'Test-9!xy';
const shortPasswords = ['T4!x', 'Test-7!'];

describe('Account password policy', { concurrency: false, timeout: 30_000 }, () => {
  let fixture;
  let admin;

  before(async () => {
    fixture = await createFixture({ prefix: 'password-policy' });
    admin = fixture.client();
  });
  after(async () => { await fixture?.close(); });

  it('requires 8–128 characters for setup and allows an eight-character administrator to log in', async () => {
    for (const password of shortPasswords) {
      const rejected = await admin.request('/auth/setup', { method: 'POST', body: {
        username: 'policy-admin', displayName: 'Policy Admin', password,
      } });
      assert.equal(rejected.response.status, 400);
    }
    const setup = await admin.request('/auth/setup', { method: 'POST', body: {
      username: 'policy-admin', displayName: 'Policy Admin', password: eightCharacterPassword,
    } });
    assert.equal(setup.response.status, 201);
    const login = await fixture.client().request('/auth/login', { method: 'POST', body: {
      username: 'policy-admin', password: eightCharacterPassword,
    } });
    assert.equal(login.response.status, 200);
    assert.equal(login.data.user.role, 'admin');
  });

  it('creates and authenticates eight- and nine-character employees while preserving leading-zero usernames', async () => {
    for (const [username, password] of [['000008', eightCharacterPassword], ['000009', nineCharacterPassword]]) {
      const created = await admin.request('/admin/users', { method: 'POST', body: {
        username, displayName: `Fixture ${username}`, password, role: 'member',
      } });
      assert.equal(created.response.status, 201);
      assert.equal(created.data.user.username, username);
      const login = await fixture.client().request('/auth/login', { method: 'POST', body: { username, password } });
      assert.equal(login.response.status, 200);
      assert.equal(login.data.user.username, username);
    }
  });

  it('rejects new four- and seven-character passwords and values exceeding the maximum', async () => {
    for (const [index, password] of [...shortPasswords, 'x'.repeat(129)].entries()) {
      const created = await admin.request('/admin/users', { method: 'POST', body: {
        username: `rejected-${index}`, displayName: 'Rejected Fixture', password, role: 'member',
      } });
      assert.equal(created.response.status, 400);
    }
    const created = await admin.request('/admin/users', { method: 'POST', body: {
      username: 'maximum-fixture', displayName: 'Maximum Fixture', password: 'x'.repeat(128), role: 'member',
    } });
    assert.equal(created.response.status, 201);
    const login = await fixture.client().request('/auth/login', { method: 'POST', body: {
      username: 'maximum-fixture', password: 'x'.repeat(128),
    } });
    assert.equal(login.response.status, 200);
  });

  it('authenticates existing imported short credentials without allowing empty, non-string, or overlong login passwords', async () => {
    const importedPassword = shortPasswords[0];
    const salt = randomBytes(16).toString('hex');
    const derived = scryptSync(importedPassword, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const db = new DatabaseSync(path.join(fixture.dataDir, 'workspace.sqlite'));
    try {
      db.prepare('INSERT INTO users(id,username,display_name,role,password_hash,created_at) VALUES (?,?,?,?,?,?)')
        .run(randomUUID(), 'imported-fixture', 'Imported Fixture Admin', 'admin', `scrypt:${salt}:${derived.toString('hex')}`, new Date().toISOString());
    } finally { db.close(); }
    const login = await fixture.client().request('/auth/login', { method: 'POST', body: {
      username: 'imported-fixture', password: importedPassword,
    } });
    assert.equal(login.response.status, 200);
    assert.equal(login.data.user.role, 'admin');
    for (const password of ['', null, 1234, 'x'.repeat(129)]) {
      const rejected = await fixture.client().request('/auth/login', { method: 'POST', body: {
        username: 'imported-fixture', password,
      } });
      assert.equal(rejected.response.status, 400);
    }
  });

  it('uses the same eight-character minimum for password resets and self-service changes', async () => {
    const users = await admin.request('/admin/users');
    const target = users.data.users.find((user) => user.username === '000009');
    const member = fixture.client();
    await member.request('/auth/login', { method: 'POST', body: { username: target.username, password: nineCharacterPassword } });
    for (const password of shortPasswords) {
      const reset = await admin.request(`/admin/users/${target.id}`, { method: 'PATCH', body: { password } });
      assert.equal(reset.response.status, 400);
      const changed = await member.request('/auth/password', { method: 'POST', body: {
        currentPassword: nineCharacterPassword, newPassword: password,
      } });
      assert.equal(changed.response.status, 400);
    }
    const reset = await admin.request(`/admin/users/${target.id}`, { method: 'PATCH', body: { password: eightCharacterPassword } });
    assert.equal(reset.response.status, 200);
    const login = await member.request('/auth/login', { method: 'POST', body: { username: target.username, password: eightCharacterPassword } });
    assert.equal(login.response.status, 200);
    const changed = await member.request('/auth/password', { method: 'POST', body: {
      currentPassword: eightCharacterPassword, newPassword: nineCharacterPassword,
    } });
    assert.equal(changed.response.status, 200);
    const relogin = await fixture.client().request('/auth/login', { method: 'POST', body: { username: target.username, password: nineCharacterPassword } });
    assert.equal(relogin.response.status, 200);
  });
});
