import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseDocument } from 'yaml';
import { packageCloudDocumentSkills } from '../scripts/package-cloud-document-skills.mjs';
import { readSkillZip } from '../lib/skill-zip.mjs';
import { Store } from '../lib/store.mjs';
import { SkillCatalog } from '../lib/skills.mjs';

const sourceDirectory = fileURLToPath(new URL('../cloud-document-skills', import.meta.url));
const expected = new Map([['tencent-docs', 'tencent'], ['kdocs', 'kdocs'], ['wps365', 'wps365']]);

async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-cloud-skill-packages-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('pi-cloud-skill-packages-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test('all three packages pass the real Pi ZIP parser with intact references and truthful provider metadata', async t => {
  const directory = await temporary(t), outputDirectory = path.join(directory, 'packages');
  const manifest = await packageCloudDocumentSkills({ outputDirectory });
  assert.equal(manifest.formatVersion, 1); assert.equal(manifest.packages.length, 3);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(outputDirectory, 'manifest.json'), 'utf8')), manifest);
  for (const item of manifest.packages) {
    assert.equal(item.provider, expected.get(item.name)); assert.equal(item.zipPath, path.join(outputDirectory, `${item.name}.zip`));
    const bytes = await fs.readFile(item.zipPath), archive = await readSkillZip(bytes.toString('base64'));
    assert.equal(bytes.length, item.bytes); assert.equal(createHash('sha256').update(bytes).digest('hex'), item.sha256);
    assert.equal(archive.name, item.name); assert.equal(archive.description, item.description);
    assert.ok(archive.content.includes(`<!-- pi-cloud-documents-adapter:v1 provider=${item.provider} -->`), 'Repair marker must survive the actual ZIP import parser');
    assert.match(archive.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/); assert.ok(archive.description.length <= 1024);
    assert.equal(archive.files.length, item.fileCount);
    assert.deepEqual(archive.files.map(file => file.path).sort(), ['SKILL.md', 'references/capabilities.md', 'references/sources-and-license.md', 'references/tool-contract.json']);
    for (const file of archive.files) {
      assert.deepEqual(file.data, await fs.readFile(path.join(sourceDirectory, item.name, ...file.path.split('/'))), `${item.name}/${file.path}`);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(file.data);
      assert.ok(!text.includes('\0'));
    }
    const source = archive.files.find(file => file.path === 'SKILL.md').data.toString('utf8');
    const metadata = parseDocument(source.match(/^---\n([\s\S]+?)\n---\n/)[1]).toJS();
    assert.equal(metadata.metadata.provider, item.provider); assert.equal(metadata.license, 'MIT');
    assert.ok(source.length < 60000);
    for (const [, reference] of source.matchAll(/\]\((references\/[^)]+)\)/g)) assert.ok(archive.files.some(file => file.path === reference), reference);
  }
});

test('per-provider discovery/call contracts support current schemas without accepting credentials or arbitrary outer fields', async t => {
  const directory = await temporary(t), manifest = await packageCloudDocumentSkills({ outputDir: path.join(directory, 'packages') });
  for (const item of manifest.packages) {
    const archive = await readSkillZip((await fs.readFile(item.zipPath)).toString('base64'));
    const schema = JSON.parse(archive.files.find(file => file.path === 'references/tool-contract.json').data.toString('utf8'));
    assert.equal(schema.oneOf.length, 2);
    const discover = schema.oneOf.find(branch => branch.properties.action.const === 'list_tools');
    const call = schema.oneOf.find(branch => branch.properties.action.const === 'call');
    for (const branch of [discover, call]) {
      assert.equal(branch.type, 'object'); assert.equal(branch.properties.provider.const, item.provider);
      assert.equal(branch.additionalProperties, false); assert.deepEqual(Object.keys(branch.properties).sort(), ['action', 'params', 'provider']);
    }
    assert.deepEqual(schema.examples, [{ provider: item.provider, action: 'list_tools' }]);
    assert.equal(discover.properties.params.properties.query.type, 'string'); assert.equal(discover.properties.params.properties.query.maxLength, 100);
    assert.equal(discover.properties.params.properties.offset.type, 'integer'); assert.equal(discover.properties.params.properties.offset.minimum, 0);
    assert.equal(discover.properties.params.additionalProperties, false);
    assert.deepEqual(call.required, ['provider', 'action', 'params']);
    assert.deepEqual(call.properties.params.required, ['tool', 'arguments']);
    assert.deepEqual(Object.keys(call.properties.params.properties).sort(), ['arguments', 'tool']);
    assert.equal(call.properties.params.additionalProperties, false);
    assert.equal(call.properties.params.properties.arguments.type, 'object');
    assert.equal(call.properties.params.properties.tool.type, 'string');
  }
});

test('imported cloud skills remain disabled until an administrator enables and assigns their existing scope controls', async t => {
  const directory = await temporary(t), store = new Store(path.join(directory, 'data'), directory);
  try {
  const manifest = await packageCloudDocumentSkills({ outputDirectory: path.join(directory, 'packages') });
  const catalog = new SkillCatalog(store), imported = [];
  for (const item of manifest.packages) {
    const skill = await catalog.importZip({ zipBase64: (await fs.readFile(item.zipPath)).toString('base64'), scope: 'groups', groupIds: ['business-a'] });
    assert.equal(skill.enabled, false); assert.deepEqual(skill.groupIds, ['business-a']); imported.push(skill);
  }
  assert.deepEqual(catalog.available('business-a'), []);
  for (const skill of imported) await catalog.update(skill.id, { enabled: true });
  assert.equal(catalog.available('business-a').length, 3); assert.equal(catalog.available('business-b').length, 0);
  const sdk = { createSyntheticSourceInfo: file => ({ file }) };
  const prepared = await catalog.prepare(sdk, { sessionId: 'business-a', message: 'Read a cloud document', allowSkills: true });
  assert.equal(prepared.skills.length, 3); assert.equal(prepared.skillFiles.length, 12);
  const denied = await catalog.prepare(sdk, { sessionId: 'business-b', message: 'Read a cloud document', allowSkills: true });
  assert.equal(denied.skills.length, 0); assert.equal(denied.skillFiles.length, 0);
  await catalog.update(imported[0].id, { scope: 'all' });
  assert.deepEqual(catalog.available('business-b').map(skill => skill.name), ['tencent-docs']);
  const changed = catalog.get(imported[0].id);
  assert.deepEqual(changed.groupIds, []); assert.equal(changed.enabled, true);
  } finally { store.close(); }
});

test('ZIP artifacts are reproducible and carry no executable installers or bundled CLI dependencies', async t => {
  const directory = await temporary(t), a = await packageCloudDocumentSkills({ outputDirectory: path.join(directory, 'a') }), b = await packageCloudDocumentSkills({ outputDirectory: path.join(directory, 'b') });
  for (let index = 0; index < a.packages.length; index++) {
    assert.equal(a.packages[index].sha256, b.packages[index].sha256);
    assert.deepEqual(await fs.readFile(a.packages[index].zipPath), await fs.readFile(b.packages[index].zipPath));
    const archive = await readSkillZip((await fs.readFile(a.packages[index].zipPath)).toString('base64'));
    assert.ok(archive.files.every(file => file.path === 'SKILL.md' || /^references\/[^/]+\.(md|json)$/.test(file.path)));
    const notices = archive.files.find(file => file.path === 'references/sources-and-license.md').data.toString('utf8');
    assert.match(notices, /本地适配说明的 MIT/);
    assert.match(notices, /https:\/\/(docs\.qq\.com|github\.com)/);
  }
});

test('packaging refuses unexpected credential/binary files before publishing any of the packages', async t => {
  const directory = await temporary(t), sources = path.join(directory, 'sources'), outputDirectory = path.join(directory, 'packages');
  await fs.cp(sourceDirectory, sources, { recursive: true });
  await fs.writeFile(path.join(sources, 'wps365', '.env'), 'This fixture must never be shipped.');
  await assert.rejects(packageCloudDocumentSkills({ sourceDirectory: sources, outputDirectory }), /Unexpected skill file/);
  await assert.rejects(fs.stat(outputDirectory), { code: 'ENOENT' });
});
