import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import { Store } from '../lib/store.mjs';
import { SkillCatalog } from '../lib/skills.mjs';

const sdk = { createSyntheticSourceInfo: file => ({ file }) };
const body = name => ({ name, description: `${name} description`, content: `${name} private instructions`, enabled: true });
const badRequest = error => error.status === 400;

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-skill-scope-'));
  const store = new Store(directory, directory);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  return { store, directory };
}

function zip(entries) {
  const locals = [], records = []; let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const filename = Buffer.from(name), data = Buffer.from(value), checksum = crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt32LE(checksum, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
    const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x800, 8); record.writeUInt32LE(checksum, 16); record.writeUInt32LE(data.length, 20); record.writeUInt32LE(data.length, 24); record.writeUInt16LE(filename.length, 28); record.writeUInt32LE(offset, 42);
    locals.push(local, filename, data); records.push(record, filename); offset += local.length + filename.length + data.length;
  }
  const central = Buffer.concat(records), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]).toString('base64');
}
const packageZip = asset => zip({ 'SKILL.md': '---\nname: scoped-package\ndescription: A scoped ZIP package.\n---\nRead references/data.txt\n', 'references/data.txt': asset });

test('skill catalog migration preserves existing skills as shared across all groups', async t => {
  const { store } = await fixture(t);
  store.db.exec(`CREATE TABLE skills (id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,description TEXT NOT NULL,content TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)`);
  store.db.prepare('INSERT INTO skills(id,name,description,content,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('legacy-id', 'legacy-skill', 'Existing skill', 'Existing instructions', '2026-01-01', '2026-01-01');
  const catalog = new SkillCatalog(store);
  assert.equal(catalog.get('legacy-id').scope, 'all');
  assert.deepEqual(catalog.get('legacy-id').groupIds, []);
  assert.deepEqual(catalog.available().map(skill => skill.id), ['legacy-id']);
  assert.equal((await catalog.create(body('new-shared'))).scope, 'all');
  assert.equal(catalog.assertAvailable('legacy-id', 'any-group').id, 'legacy-id');
  new SkillCatalog(store); // Additive migrations also remain safe on restart.
});

test('scope validation rejects malformed and empty selections and deduplicates authorized group IDs', async t => {
  const { store } = await fixture(t), catalog = new SkillCatalog(store);
  const scoped = await catalog.create({ ...body('group-skill'), scope: 'groups', groupIds: ['group-a', 'group-a', 'group-b'] });
  assert.deepEqual(scoped.groupIds, ['group-a', 'group-b']);
  for (const invalid of [
    { scope: 'private' }, { scope: null }, { scope: 'groups' }, { scope: 'groups', groupIds: [] },
    { scope: 'groups', groupIds: 'group-a' }, { scope: 'groups', groupIds: [''] },
    { scope: 'groups', groupIds: ['../group-a'] }, { scope: 'groups', groupIds: [null] },
    { scope: 'groups', groupIds: Array.from({ length: 501 }, (_, i) => `group-${i}`) },
  ]) await assert.rejects(catalog.create({ ...body('invalid-skill'), ...invalid }), badRequest);
  const shared = await catalog.update(scoped.id, { scope: 'all', groupIds: ['group-a'] });
  assert.equal(shared.scope, 'all'); assert.deepEqual(shared.groupIds, []);
});

test('runtime resources, explicit skill choices and slash commands respect the business group scope', async t => {
  const { store } = await fixture(t), catalog = new SkillCatalog(store);
  const shared = await catalog.create(body('shared-skill'));
  const groupA = await catalog.create({ ...body('group-a-secret'), scope: 'groups', groupIds: ['group-a'] });
  const groupB = await catalog.create({ ...body('group-b-secret'), scope: 'groups', groupIds: ['group-b'] });
  const disabled = await catalog.create({ ...body('disabled-a'), scope: 'groups', groupIds: ['group-a'], enabled: false });
  assert.deepEqual(catalog.available('group-a').map(skill => skill.id).sort(), [shared.id, groupA.id].sort());
  assert.deepEqual(catalog.available().map(skill => skill.id), [shared.id]);
  assert.equal(catalog.isAvailable(groupA.id, 'group-b'), false);
  assert.equal(catalog.isAvailable(disabled.id, 'group-a'), false);
  assert.equal(catalog.assertScope(disabled.id, 'group-a').id, disabled.id);
  assert.throws(() => catalog.assertAvailable(disabled.id, 'group-a'), badRequest);
  assert.throws(() => catalog.assertScope(groupB.id, 'group-a'), badRequest);

  const selected = await catalog.prepare(sdk, { message: 'Process this business request', skillId: groupA.id, allowSkills: true, sessionId: 'group-a' });
  assert.equal(selected.skill.id, groupA.id);
  assert.deepEqual(selected.skillIds.sort(), [shared.id, groupA.id].sort());
  assert.deepEqual(selected.skills.map(skill => skill.name).sort(), [shared.name, groupA.name].sort());
  assert.ok(selected.skillFiles.every(file => !file.includes(groupB.id) && !file.includes(disabled.id)));
  assert.ok(!JSON.stringify(selected).includes(groupB.name));
  const slash = await catalog.prepare(sdk, { message: '/skill:group-a-secret Read data', allowSkills: true, sessionId: 'group-a' });
  assert.equal(slash.message, 'Read data'); assert.equal(slash.skill.id, groupA.id);
  for (const options of [
    { skillId: groupB.id, sessionId: 'group-a' }, { message: '/skill:group-b-secret Read data', sessionId: 'group-a' },
    { skillId: groupA.id }, { skillId: disabled.id, sessionId: 'group-a' },
  ]) await assert.rejects(catalog.prepare(sdk, { message: 'Read data', allowSkills: true, ...options }), error => badRequest(error) && !error.message.includes('group-b-secret'));
  const noGroup = await catalog.prepare(sdk, { message: 'Read data', allowSkills: true });
  assert.deepEqual(noGroup.skillIds, [shared.id]);
});

test('scope-only changes keep immutable ZIP contents and the content version unchanged', async t => {
  const { store } = await fixture(t), catalog = new SkillCatalog(store);
  const skill = await catalog.importZip({ zipBase64: packageZip('IMMUTABLE-ASSET-V1'), enabled: true });
  const main = catalog.file(skill.id, 1), asset = path.join(path.dirname(main), 'references', 'data.txt');
  const original = await readFile(main, 'utf8');
  await new Promise(resolve => setTimeout(resolve, 5));
  const restricted = await catalog.update(skill.id, { scope: 'groups', groupIds: ['group-a'] });
  assert.equal(restricted.version, 1); assert.notEqual(restricted.updatedAt, skill.updatedAt);
  assert.equal(await readFile(main, 'utf8'), original);
  assert.equal(await readFile(asset, 'utf8'), 'IMMUTABLE-ASSET-V1');
  assert.deepEqual(await readdir(path.dirname(path.dirname(main))), ['v1']);
  const broad = await catalog.update(skill.id, { scope: 'all' });
  assert.equal(broad.version, 1); assert.deepEqual(broad.groupIds, []);
  const enabledOnly = await catalog.update(skill.id, { enabled: false });
  assert.equal(enabledOnly.version, 2);
  assert.equal(await readFile(main, 'utf8'), original);
});

test('replacing a ZIP inherits its group scope unless a new scope is explicitly supplied', async t => {
  const { store } = await fixture(t), catalog = new SkillCatalog(store);
  const original = await catalog.importZip({ zipBase64: packageZip('V1'), enabled: true, scope: 'groups', groupIds: ['group-a'] });
  const replacement = await catalog.importZip({ zipBase64: packageZip('V2'), enabled: true }, original.id);
  assert.equal(replacement.version, 2); assert.equal(replacement.scope, 'groups'); assert.deepEqual(replacement.groupIds, ['group-a']);
  assert.equal(catalog.isAvailable(original.id, 'group-b'), false);
  assert.equal(await readFile(path.join(path.dirname(catalog.file(original.id, 1)), 'references', 'data.txt'), 'utf8'), 'V1');
  const shared = await catalog.importZip({ zipBase64: packageZip('V3'), enabled: true, scope: 'all' }, original.id);
  assert.equal(shared.scope, 'all'); assert.deepEqual(shared.groupIds, []);
});

test('the synchronous authorization hook is rechecked immediately before committing files and scope changes', async t => {
  const { store } = await fixture(t), catalog = new SkillCatalog(store);
  let checks = 0;
  await assert.rejects(catalog.create(body('denied-create'), { authorize: () => { if (++checks === 2) throw new Error('authority revoked'); } }), /authority revoked/);
  assert.equal(catalog.list().length, 0);
  const skill = await catalog.create(body('authorized-skill'));
  checks = 0;
  await assert.rejects(catalog.update(skill.id, { content: 'Changed contents' }, { authorize: value => { assert.equal(value.scope, 'all'); if (++checks === 2) throw new Error('authority revoked'); } }), /authority revoked/);
  assert.equal(catalog.get(skill.id).version, 1);
  assert.equal((await catalog.update(skill.id, { content: 'Changed again' })).version, 2);
  checks = 0;
  await assert.rejects(catalog.update(skill.id, { scope: 'groups', groupIds: ['group-a'] }, { authorize: () => { if (++checks === 2) throw new Error('scope authority revoked'); } }), /scope authority revoked/);
  assert.equal(catalog.get(skill.id).scope, 'all');
  assert.equal(catalog.get(skill.id).version, 2);
});
