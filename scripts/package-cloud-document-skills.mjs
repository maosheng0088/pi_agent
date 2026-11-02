import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { readSkillZip } from '../lib/skill-zip.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export const cloudSkillPackages = Object.freeze([
  Object.freeze({ name: 'tencent-docs', provider: 'tencent' }),
  Object.freeze({ name: 'kdocs', provider: 'kdocs' }),
  Object.freeze({ name: 'wps365', provider: 'wps365' }),
]);

async function packageFiles(directory, relative = '') {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Skill source must be a real directory without links.');
  const files = [];
  for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    const source = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Skill package cannot contain links: ${name}`);
    if (entry.isDirectory()) {
      if (name !== 'references' && !name.startsWith('references/')) throw new Error(`Unexpected skill directory: ${name}`);
      files.push(...await packageFiles(source, name));
    } else if (entry.isFile()) {
      if (name !== 'SKILL.md' && !(name.startsWith('references/') && /\.(md|json)$/.test(name))) throw new Error(`Unexpected skill file: ${name}`);
      const data = await fs.readFile(source);
      if (data.length > 1024 * 1024) throw new Error(`Skill reference is too large: ${name}`);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
      if (text.includes('\0')) throw new Error(`Skill package must contain text only: ${name}`);
      if (name.endsWith('.json')) JSON.parse(text);
      files.push({ name, data });
    } else throw new Error(`Skill package cannot contain special files: ${name}`);
  }
  return files;
}

// A stable, standard ZIP with UTF-8 names. No executables, remote downloads or ZIP dependencies.
function archive(files) {
  const localParts = [], centralParts = []; let offset = 0;
  for (const file of files) {
    const filename = Buffer.from(file.name), checksum = crc32(file.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(33, 12);
    local.writeUInt32LE(checksum, 14); local.writeUInt32LE(file.data.length, 18); local.writeUInt32LE(file.data.length, 22); local.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt16LE(33, 14);
    central.writeUInt32LE(checksum, 16); central.writeUInt32LE(file.data.length, 20); central.writeUInt32LE(file.data.length, 24); central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    localParts.push(local, filename, file.data); centralParts.push(central, filename); offset += local.length + filename.length + file.data.length;
  }
  const central = Buffer.concat(centralParts), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, central, end]);
}

export async function packageCloudDocumentSkills({ sourceDirectory = path.join(root, 'cloud-document-skills'), outputDirectory, outputDir } = {}) {
  outputDirectory = path.resolve(outputDirectory ?? outputDir ?? path.join(root, 'qa', 'cloud-docs-20261030', 'packages'));
  const packages = [];
  for (const definition of cloudSkillPackages) {
    const files = await packageFiles(path.join(sourceDirectory, definition.name));
    const data = archive(files), parsed = await readSkillZip(data.toString('base64'));
    if (parsed.name !== definition.name || !parsed.description || parsed.description.length > 1024) throw new Error(`Invalid cloud skill metadata: ${definition.name}`);
    const contract = JSON.parse(files.find(file => file.name === 'references/tool-contract.json')?.data.toString('utf8') || 'null');
    if (!contract?.oneOf?.every(branch => branch.properties?.provider?.const === definition.provider)) throw new Error(`Cloud provider contract mismatch: ${definition.name}`);
    packages.push({ ...definition, filename: `${definition.name}.zip`, data, description: parsed.description, fileCount: parsed.files.length });
  }
  // Validate all three packages before publishing any artifact.
  await fs.mkdir(outputDirectory, { recursive: true });
  for (const item of packages) await fs.writeFile(path.join(outputDirectory, item.filename), item.data);
  const manifest = { formatVersion: 1, packages: packages.map(({ data, ...item }) => ({ ...item, zipPath: path.join(outputDirectory, item.filename), bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') })) };
  await fs.writeFile(path.join(outputDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const manifest = await packageCloudDocumentSkills();
  for (const item of manifest.packages) console.log(`${item.filename}: ${item.bytes} bytes; ${item.fileCount} files; ${item.sha256}`);
}
