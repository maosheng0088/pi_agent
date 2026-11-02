import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createFixture, configure, collaborativeSession as session, deltaText } from './auth-helpers.mjs';
import { readSkillZip } from '../lib/skill-zip.mjs';

export function makeZip(entries) {
  let offset = 0; const locals = [], central = [];
  for (const [name, value] of Object.entries(entries)) {
    const filename = Buffer.from(name), data = Buffer.from(value); let crc = 0xffffffff;
    for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
    const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x800, 8); record.writeUInt32LE(crc, 16); record.writeUInt32LE(data.length, 20); record.writeUInt32LE(data.length, 24); record.writeUInt16LE(filename.length, 28); record.writeUInt32LE(offset, 42);
    locals.push(local, filename, data); central.push(record, filename); offset += local.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]).toString('base64');
}
const source = '---\nname: zip-review\ndescription: |\n  Review package references.\nlicense: MIT\n---\n# Review\nRead references/check.txt relative to this skill directory.\n';
test('ZIP parser handles a wrapper directory and multiline YAML without losing package assets', async () => {
  const parsed = await readSkillZip(makeZip({'my-skill/SKILL.md':source,'my-skill/references/check.txt':'REFERENCE-V1','my-skill/scripts/run.py':'print("hello")'}));
  assert.equal(parsed.name,'zip-review'); assert.match(parsed.description,/Review/); assert.equal(parsed.files.length,3); assert.ok(parsed.files.some(f=>f.path==='references/check.txt'));
});
test('ZIP parser rejects traversal, Windows collisions, ambiguous packages and malformed metadata', async () => {
  for(const entries of [ {'../SKILL.md':source}, {'C:/SKILL.md':source}, {'SKILL.md':source,'A.txt':'a','a.txt':'b'}, {'a/SKILL.md':source,'b/SKILL.md':source}, {'SKILL.md':'no yaml'}, {'SKILL.md':source,'NUL.txt':'bad'}, {'SKILL.md':source,'x':'file','x/y':'nested'} ]) await assert.rejects(readSkillZip(makeZip(entries)),e=>e.status===400);
  await assert.rejects(readSkillZip('not-a-zip'),e=>e.status===400);
  const broken = Buffer.from(makeZip({'SKILL.md':source}),'base64'); broken[30 + Buffer.byteLength('SKILL.md') + 10] ^= 1;
  await assert.rejects(readSkillZip(broken.toString('base64')),e=>e.status===400);
});
test('administrator imports, enables, reads assets through real Pi and replaces ZIP without losing active versions', async () => {
  const fixture = await createFixture({prefix:'zip-import'});
  try {
    const admin=fixture.client(),member=fixture.client(),password='Zip-fixture-2026!';
    await admin.request('/auth/setup',{method:'POST',body:{username:'zip-admin',displayName:'ZIP Admin',password}}); await configure(admin,fixture);
    await admin.request('/admin/users',{method:'POST',body:{username:'zip-member',displayName:'Member',password,role:'member'}}); await member.request('/auth/login',{method:'POST',body:{username:'zip-member',password}});
    const zipBase64=makeZip({'SKILL.md':source,'references/check.txt':'REFERENCE-V1','assets/sample.bin':Buffer.from([0,1,2,255])});
    assert.equal((await member.request('/admin/skills/import',{method:'POST',body:{zipBase64}})).response.status,403);
    const imported=await admin.request('/admin/skills/import',{method:'POST',body:{zipBase64}}); assert.equal(imported.response.status,201,JSON.stringify(imported.data)); const skill=imported.data.skill; assert.equal(skill.enabled,false); assert.equal(skill.files.length,2);
    assert.equal((await admin.request('/admin/skills/import',{method:'POST',body:{zipBase64}})).response.status,409);
    await admin.request(`/admin/skills/${skill.id}`,{method:'PATCH',body:{enabled:true}});
    const asset=path.join(fixture.dataDir,'skills',skill.id,'v2','references/check.txt');
    const target=await session(admin,'ZIP fixture'); const result=await admin.send(target.id,`Please [read-path:${asset}]`); assert.match(deltaText(result),/REFERENCE-V1/);
    const allowed=await member.send(target.id,`Please [read-path:${asset}]`); assert.match(deltaText(allowed),/REFERENCE-V1/);
    const replacement=await admin.request(`/admin/skills/import/${skill.id}`,{method:'POST',body:{zipBase64:makeZip({'SKILL.md':source,'references/check.txt':'REFERENCE-V2'}),enabled:true}});
    assert.equal(replacement.response.status,200,JSON.stringify(replacement.data)); assert.equal(replacement.data.skill.version,3); assert.equal(replacement.data.skill.files.length,1);
    assert.equal(await readFile(asset,'utf8'),'REFERENCE-V1'); assert.equal(await readFile(path.join(fixture.dataDir,'skills',skill.id,'v3','references/check.txt'),'utf8'),'REFERENCE-V2');
    assert.match(await readFile(path.join(fixture.dataDir,'skills',skill.id,'v2','SKILL.md'),'utf8'),/license: MIT/);
    await fixture.stop(); await fixture.start(); assert.equal((await admin.request(`/skills/${skill.id}`)).data.skill.files.length,1);
  } finally { await fixture.close(); }
});
