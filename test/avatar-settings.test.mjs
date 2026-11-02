import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import { Store } from '../lib/store.mjs';
import { SkillCatalog } from '../lib/skills.mjs';
import { validateAvatarId } from '../lib/avatar-options.mjs';
import { createFixture, configure, session } from './auth-helpers.mjs';

const invalidAvatars = ['portrait-00', 'portrait-15', 'portrait-1', 'portrait-01.png', '../portrait-01', '/assets/portrait-01.webp', 'https://example.com/a.png', 'data:image/png;base64,x', ' portrait-01', null, 42, true, {}, []];
const skillBody = (overrides = {}) => ({ name: 'avatar-fixture', description: 'Avatar configuration fixture.', content: '# Fixture\nKeep existing instructions.', enabled: true, ...overrides });

function skillZip() {
  const name = Buffer.from('SKILL.md');
  const data = Buffer.from('---\nname: avatar-zip-fixture\ndescription: Imported avatar fixture.\n---\n# ZIP skill\nKeep this package.\n');
  const checksum = crc32(data);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt32LE(checksum, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt32LE(checksum, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + data.length, 16);
  return Buffer.concat([local, name, data, central, name, end]).toString('base64');
}

async function catalogFixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-avatar-settings-'));
  const store = new Store(directory, directory);
  t.after(async () => { store.close(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); await fs.rm(directory, { recursive: true, force: true }); });
  return { store, directory };
}

test('avatar IDs are exact bundled choices or empty, never paths, URLs or coerced values', () => {
  assert.equal(validateAvatarId(''), '');
  for (let index = 1; index <= 14; index++) {
    const id = `portrait-${String(index).padStart(2, '0')}`;
    assert.equal(validateAvatarId(id), id);
  }
  for (const value of [...invalidAvatars, undefined]) assert.throws(() => validateAvatarId(value), { status: 400 });
});

test('legacy skills migrate to automatic avatars without losing instructions, enabled state or version', async t => {
  const { store } = await catalogFixture(t);
  store.db.exec(`CREATE TABLE skills (id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,description TEXT NOT NULL,content TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);`);
  store.db.prepare('INSERT INTO skills VALUES (?,?,?,?,?,?,?,?)').run('legacy', 'legacy-avatar', 'Original skill', 'Original private instructions', 1, 7, '2026-01-01', '2026-01-02');
  const catalog = new SkillCatalog(store);
  const legacy = catalog.get('legacy');
  assert.equal(legacy.avatarId, '');
  assert.equal(legacy.content, 'Original private instructions');
  assert.equal(legacy.version, 7);
  assert.equal(legacy.enabled, true);
  assert.equal(legacy.scope, 'all');
  assert.equal(new SkillCatalog(store).get('legacy').avatarId, '');
});

test('skill avatars create, update, retain on omission and clear without replacing immutable skill files', async t => {
  const { store } = await catalogFixture(t);
  const catalog = new SkillCatalog(store);
  const created = await catalog.create(skillBody({ avatarId: 'portrait-03' }));
  assert.equal(created.avatarId, 'portrait-03');
  assert.equal(catalog.list()[0].avatarId, 'portrait-03');
  assert.equal(catalog.available('any-group')[0].avatarId, 'portrait-03');
  const originalFile = await fs.readFile(catalog.file(created.id, created.version), 'utf8');
  const changed = await catalog.update(created.id, { avatarId: 'portrait-14' });
  assert.equal(changed.avatarId, 'portrait-14');
  assert.equal(changed.version, created.version);
  assert.equal(await fs.readFile(catalog.file(created.id, created.version), 'utf8'), originalFile);
  assert.equal((await catalog.update(created.id, { description: 'Updated description only.' })).avatarId, 'portrait-14');
  assert.equal((await catalog.update(created.id, { avatarId: '' })).avatarId, '');
  assert.equal(new SkillCatalog(store).get(created.id).avatarId, '');
  for (const avatarId of invalidAvatars) {
    await assert.rejects(catalog.update(created.id, { avatarId }), { status: 400 });
    await assert.rejects(catalog.create(skillBody({ name: 'invalid-avatar', avatarId })), { status: 400 });
  }
  assert.equal(catalog.list().length, 1);
  assert.equal(catalog.get(created.id).avatarId, '');
});

test('ZIP create and replacement honor avatar configuration and preserve it when omitted', async t => {
  const { store } = await catalogFixture(t);
  const catalog = new SkillCatalog(store), zipBase64 = skillZip();
  const imported = await catalog.importZip({ zipBase64, enabled: true, avatarId: 'portrait-08' });
  assert.equal(imported.avatarId, 'portrait-08');
  assert.equal((await catalog.importZip({ zipBase64, enabled: true }, imported.id)).avatarId, 'portrait-08');
  assert.equal((await catalog.importZip({ zipBase64, enabled: true, avatarId: 'portrait-09' }, imported.id)).avatarId, 'portrait-09');
  assert.equal((await catalog.importZip({ zipBase64, enabled: true, avatarId: '' }, imported.id)).avatarId, '');
  const version = catalog.get(imported.id).version;
  await assert.rejects(catalog.importZip({ zipBase64, avatarId: '../avatar' }, imported.id), { status: 400 });
  assert.equal(catalog.get(imported.id).version, version);
});

describe('Administrator avatar configuration and member views', { concurrency: false, timeout: 120000 }, () => {
  const password = 'Avatar-settings-fixture-2026!';
  let f, admin, member, outsider, memberUser, group, skill, imported;
  before(async () => {
    f = await createFixture({ prefix: 'avatar-settings-api', options: { scheduler: { autoStart: false }, channels: { autoStart: false } } });
    admin = f.client(); member = f.client(); outsider = f.client();
    assert.equal((await admin.request('/auth/setup', { method: 'POST', body: { username: 'avatar-admin', displayName: 'Avatar Admin', password } })).response.status, 201);
    await configure(admin, f);
    memberUser = (await admin.request('/admin/users', { method: 'POST', body: { username: 'avatar-member', displayName: 'Avatar Member', password, role: 'member' } })).data.user;
    await admin.request('/admin/users', { method: 'POST', body: { username: 'avatar-outsider', displayName: 'Outside Admin', password, role: 'admin' } });
    assert.equal((await member.request('/auth/login', { method: 'POST', body: { username: 'avatar-member', password } })).response.status, 200);
    assert.equal((await outsider.request('/auth/login', { method: 'POST', body: { username: 'avatar-outsider', password } })).response.status, 200);
  });
  after(async () => { await f?.close(); });

  test('administrator sets an agent avatar on creation and members can see it in safe list/detail views', async () => {
    const created = await admin.request('/sessions', { method: 'POST', body: { title: '业务头像智能体', avatarId: 'portrait-02' } });
    assert.equal(created.response.status, 201, JSON.stringify(created.data));
    group = created.data.session;
    assert.equal(group.avatarId, 'portrait-02');
    assert.equal((await admin.request(`/sessions/${group.id}/members`, { method: 'POST', body: { userIds: [memberUser.id] } })).response.status, 200);
    const detail = await member.request(`/sessions/${group.id}`);
    assert.equal(detail.data.session.avatarId, 'portrait-02');
    assert.ok(!('file' in detail.data.session));
    const listed = (await member.request('/sessions')).data.sessions.find(value => value.id === group.id);
    assert.equal(listed.avatarId, 'portrait-02');
    assert.equal((await outsider.request(`/sessions/${group.id}`)).response.status, 404);
  });

  test('agent avatar updates are admin-only while members retain rename permission', async () => {
    assert.equal((await member.request(`/sessions/${group.id}`, { method: 'PATCH', body: { avatarId: 'portrait-04' } })).response.status, 403);
    assert.equal((await member.request(`/sessions/${group.id}`, { method: 'PATCH', body: { title: '不能部分修改', avatarId: '' } })).response.status, 403);
    assert.equal((await outsider.request(`/sessions/${group.id}`, { method: 'PATCH', body: { avatarId: 'portrait-04' } })).response.status, 404);
    const renamed = await member.request(`/sessions/${group.id}`, { method: 'PATCH', body: { title: '成员仍可改群名' } });
    assert.equal(renamed.response.status, 200);
    assert.equal(renamed.data.session.avatarId, 'portrait-02');
    const changed = await admin.request(`/sessions/${group.id}`, { method: 'PATCH', body: { avatarId: 'portrait-04' } });
    assert.equal(changed.response.status, 200);
    assert.equal(changed.data.session.avatarId, 'portrait-04');
    const unchanged = await admin.request(`/sessions/${group.id}`, { method: 'PATCH', body: { title: '只改名称保留头像' } });
    assert.equal(unchanged.data.session.avatarId, 'portrait-04');
  });

  test('invalid avatar choices never mutate an agent or create an unwanted group', async () => {
    const count = (await admin.request('/sessions')).data.sessions.length;
    for (const avatarId of invalidAvatars) {
      assert.equal((await admin.request('/sessions', { method: 'POST', body: { title: 'Invalid avatar', avatarId } })).response.status, 400);
      assert.equal((await admin.request(`/sessions/${group.id}`, { method: 'PATCH', body: { title: '不能部分改名', avatarId } })).response.status, 400);
    }
    const detail = (await member.request(`/sessions/${group.id}`)).data.session;
    assert.equal(detail.title, '只改名称保留头像');
    assert.equal(detail.avatarId, 'portrait-04');
    assert.equal((await admin.request('/sessions')).data.sessions.length, count);
  });

  test('skill creation and ZIP imports expose chosen avatars to group members without private skill content', async () => {
    const created = await admin.request('/admin/skills', { method: 'POST', body: skillBody({ avatarId: 'portrait-05' }) });
    assert.equal(created.response.status, 201, JSON.stringify(created.data));
    skill = created.data.skill;
    assert.equal(skill.avatarId, 'portrait-05');
    const zip = await admin.request('/admin/skills/import', { method: 'POST', body: { zipBase64: skillZip(), enabled: true, avatarId: 'portrait-06' } });
    assert.equal(zip.response.status, 201, JSON.stringify(zip.data));
    imported = zip.data.skill;
    assert.equal(imported.avatarId, 'portrait-06');
    const visible = (await member.request(`/sessions/${group.id}/skills`)).data.skills;
    assert.equal(visible.find(value => value.id === skill.id).avatarId, 'portrait-05');
    assert.equal(visible.find(value => value.id === imported.id).avatarId, 'portrait-06');
    assert.ok(visible.every(value => !('content' in value) && !('files' in value)));
    assert.equal((await admin.request(`/skills/${skill.id}`)).data.skill.avatarId, 'portrait-05');
    assert.equal((await admin.request('/skills')).data.skills.find(value => value.id === skill.id).avatarId, 'portrait-05');
  });

  test('employees cannot alter skill avatars through JSON or ZIP configuration endpoints', async () => {
    for (const [route, method, body] of [
      ['/admin/skills', 'POST', skillBody({ name: 'employee-avatar', avatarId: 'portrait-07' })],
      [`/admin/skills/${skill.id}`, 'PATCH', { avatarId: 'portrait-07' }],
      ['/admin/skills/import', 'POST', { zipBase64: skillZip(), avatarId: 'portrait-07' }],
      [`/admin/skills/import/${imported.id}`, 'POST', { zipBase64: skillZip(), avatarId: 'portrait-07' }],
    ]) assert.equal((await member.request(route, { method, body })).response.status, 403);
    assert.equal((await admin.request(`/skills/${skill.id}`)).data.skill.avatarId, 'portrait-05');
    for (const avatarId of invalidAvatars) {
      assert.equal((await admin.request(`/admin/skills/${skill.id}`, { method: 'PATCH', body: { avatarId } })).response.status, 400);
      assert.equal((await admin.request('/admin/skills', { method: 'POST', body: skillBody({ name: 'invalid-skill-avatar', avatarId }) })).response.status, 400);
    }
    assert.equal((await admin.request(`/admin/skills/import/${imported.id}`, { method: 'POST', body: { zipBase64: skillZip(), avatarId: 'https://example.com/a.png' } })).response.status, 400);
  });

  test('configured avatars survive service restart and clear explicitly to automatic', async () => {
    const changedSkill = await admin.request(`/admin/skills/${skill.id}`, { method: 'PATCH', body: { avatarId: 'portrait-13' } });
    assert.equal(changedSkill.response.status, 200);
    const zipUpdated = await admin.request(`/admin/skills/import/${imported.id}`, { method: 'POST', body: { zipBase64: skillZip(), enabled: true } });
    assert.equal(zipUpdated.data.skill.avatarId, 'portrait-06');
    await f.stop(); await f.start();
    assert.equal((await member.request(`/sessions/${group.id}`)).data.session.avatarId, 'portrait-04');
    assert.equal((await admin.request(`/skills/${skill.id}`)).data.skill.avatarId, 'portrait-13');
    assert.equal((await admin.request(`/skills/${imported.id}`)).data.skill.avatarId, 'portrait-06');
    assert.equal((await admin.request(`/sessions/${group.id}`, { method: 'PATCH', body: { avatarId: '' } })).data.session.avatarId, '');
    assert.equal((await admin.request(`/admin/skills/${skill.id}`, { method: 'PATCH', body: { avatarId: '' } })).data.skill.avatarId, '');
    assert.equal((await admin.request(`/admin/skills/import/${imported.id}`, { method: 'POST', body: { zipBase64: skillZip(), avatarId: '' } })).data.skill.avatarId, '');
    await f.stop(); await f.start();
    assert.equal((await member.request(`/sessions/${group.id}`)).data.session.avatarId, '');
    assert.equal((await admin.request(`/skills/${skill.id}`)).data.skill.avatarId, '');
    assert.equal((await admin.request(`/skills/${imported.id}`)).data.skill.avatarId, '');
    const automatic = await session(admin, '未设置头像的旧式创建');
    assert.equal(automatic.avatarId, '');
  });

  test('legacy sessions without an avatar field remain automatic and readable after restart', async () => {
    const legacy = await session(admin, '没有头像字段的历史智能体');
    assert.equal((await admin.request(`/sessions/${legacy.id}/members`, { method: 'POST', body: { userIds: [memberUser.id] } })).response.status, 200);
    const store = f.server.piWeb.taskDelivery.store;
    delete store.sessions.find(value => value.id === legacy.id).avatarId;
    store.saveSessions();
    assert.ok(!('avatarId' in JSON.parse(store.db.prepare('SELECT data FROM session_meta WHERE id=?').get(legacy.id).data)));
    await f.stop(); await f.start();
    const detail = await member.request(`/sessions/${legacy.id}`);
    assert.equal(detail.response.status, 200);
    assert.equal(detail.data.session.avatarId, '');
    const renamed = await member.request(`/sessions/${legacy.id}`, { method: 'PATCH', body: { title: '历史智能体仍可改名' } });
    assert.equal(renamed.response.status, 200);
    assert.equal(renamed.data.session.avatarId, '');
  });
});
