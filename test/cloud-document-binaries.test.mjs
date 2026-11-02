import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeZip } from './document-fixtures.mjs';
import { cloudDocumentPaths, CLOUD_DOCUMENT_SOURCES, sha256, verifyVendorChecksum, verifyWindowsExecutable,
  readVendorExecutable, readVendorSkillPackage, ensureVendorDirectory, writeVendorFile } from '../lib/cloud-document-binaries.mjs';

const directories = [];
afterEach(async () => { for (const directory of directories.splice(0)) {
  assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('pi-cloud-binaries-'));
  await fs.rm(directory, { recursive: true, force: true });
} });
async function temporary() { const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-cloud-binaries-')); directories.push(directory); return directory; }
function executable() { const bytes = Buffer.alloc(256); bytes.write('MZ'); bytes.writeUInt32LE(128, 0x3c); bytes.writeUInt32LE(0x00004550, 128); bytes.writeUInt16LE(0x8664, 132); return bytes; }

test('tool paths stay project-local and sources are fixed official HTTPS hosts', () => {
  const root = path.resolve('project'), paths = cloudDocumentPaths(root);
  assert.equal(paths.kdocs.executable, path.join(root, '.tools/cloud-docs/kdocs/kdocs-cli.exe'));
  assert.equal(paths.wps365.executable, path.join(root, '.tools/cloud-docs/wps365/wps365-cli.exe'));
  assert.equal(paths.tencent.sdkRoot, path.join(root, '.tools/cloud-docs/mcp-runtime'));
  for (const source of Object.values(CLOUD_DOCUMENT_SOURCES)) for (const [key, value] of Object.entries(source)) if (key.endsWith('Url') || key === 'installerSource') {
    const url = new URL(value); assert.equal(url.protocol, 'https:'); assert.ok(['wpsai.wpscdn.cn', 'open-docs.wpscdn.cn', 'cdn.addon.tencentsuite.com', 'raw.githubusercontent.com'].includes(url.hostname));
  }
});

test('vendor checksums are exact, unambiguous and mandatory', () => {
  const bytes = Buffer.from('pinned vendor archive'), hash = sha256(bytes);
  assert.equal(verifyVendorChecksum(bytes, `${hash}  package.zip\n`, 'package.zip'), hash);
  assert.throws(() => verifyVendorChecksum(bytes, `${'0'.repeat(64)}  package.zip`, 'package.zip'), /mismatch/);
  assert.throws(() => verifyVendorChecksum(bytes, `${hash}  other.zip`, 'package.zip'), /missing/);
  assert.throws(() => verifyVendorChecksum(bytes, `${hash} package.zip\n${hash} package.zip`, 'package.zip'), /ambiguous/);
});

test('binary archives validate PE architecture and reject escapes, duplicate payloads or missing executables', async () => {
  const bytes = executable(); assert.equal(verifyWindowsExecutable(bytes), true);
  const actual = await readVendorExecutable(makeZip([['vendor/kdocs-cli.exe', bytes], ['README.md', 'vendor']]), 'kdocs-cli.exe');
  assert.deepEqual(actual, bytes);
  for (const entries of [[['../escape.exe', bytes]], [['one/kdocs-cli.exe', bytes], ['two/kdocs-cli.exe', bytes]], [['readme', 'none']], [['kdocs-cli.exe', '<script>not an exe</script>']]]) {
    await assert.rejects(readVendorExecutable(makeZip(entries), 'kdocs-cli.exe'));
  }
  const wrong = executable(); wrong.writeUInt16LE(0x14c, 132); assert.throws(() => verifyWindowsExecutable(wrong), /AMD64/);
});

test('vendor skill canonicalization preserves content and metadata while normalizing upstream Windows paths', async () => {
  const source = '---\nname: vendor-docs\ndescription: Original vendor instructions\n---\nOriginal instructions';
  const raw = makeZip([['vendor\\SKILL.md', source], ['vendor\\references\\auth.md', 'No credentials in this fixture']]);
  const { skill, archive } = await readVendorSkillPackage(raw);
  assert.equal(skill.name, 'vendor-docs'); assert.equal(skill.content, 'Original instructions');
  assert.deepEqual(skill.files.map(value => value.path), ['SKILL.md', 'references/auth.md']);
  assert.equal(skill.files[0].data.toString(), source); assert.notDeepEqual(archive, raw);
  await assert.rejects(readVendorSkillPackage(makeZip([['../SKILL.md', source]])));
  await assert.rejects(readVendorSkillPackage(makeZip([['SKILL.md', source], ['second/SKILL.md', source]])));
});

test('existing vendor files are immutable and linked files or directories are refused', async () => {
  const root = await temporary(), directory = await ensureVendorDirectory(root, '.tools/cloud-docs/vendor');
  const file = path.join(directory, 'tool.exe'), bytes = executable();
  assert.equal(await writeVendorFile(file, bytes), 'created'); assert.equal(await writeVendorFile(file, bytes), 'unchanged');
  await assert.rejects(writeVendorFile(file, Buffer.from('replacement')), /refusing to overwrite/);
  assert.deepEqual(await fs.readFile(file), bytes);
  const alias = path.join(root, 'alias.exe'); await fs.link(file, alias);
  await assert.rejects(writeVendorFile(file, bytes), /refusing to overwrite/);
  await assert.rejects(ensureVendorDirectory(root, '../escape'));
  const outside = await temporary(); await fs.symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(ensureVendorDirectory(root, 'linked/new-folder'), /must not be a link/);
  assert.deepEqual(await fs.readdir(outside), []);
});
