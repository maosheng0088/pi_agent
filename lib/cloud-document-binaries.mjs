import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';
import yauzl from 'yauzl';
import { parseDocument } from 'yaml';

export const CLOUD_DOCUMENT_PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));
export const CLOUD_DOCUMENT_VERSIONS = Object.freeze({ kdocs: '2.7.1', wps365: '0.3.6', mcpSdk: '1.32.2' });
export function cloudDocumentPaths(root = CLOUD_DOCUMENT_PROJECT_ROOT) {
  const directory = path.join(path.resolve(root), '.tools', 'cloud-docs');
  return {
    directory,
    tencent: { sdkRoot: path.join(directory, 'mcp-runtime') },
    kdocs: { executable: path.join(directory, 'kdocs', 'kdocs-cli.exe') },
    wps365: { executable: path.join(directory, 'wps365', 'wps365-cli.exe') },
  };
}

export const CLOUD_DOCUMENT_SOURCES = Object.freeze({
  kdocs: Object.freeze({ version: CLOUD_DOCUMENT_VERSIONS.kdocs, archiveName: 'kdocs-cli-2.7.1-windows-amd64.zip', executable: 'kdocs-cli.exe',
    archiveUrl: 'https://wpsai.wpscdn.cn/skillhub/pro/v2.7.1/releases/kdocs-cli-2.7.1-windows-amd64.zip',
    checksumsUrl: 'https://wpsai.wpscdn.cn/skillhub/pro/v2.7.1/releases/checksums.txt',
    installerSource: 'https://raw.githubusercontent.com/kdocs-app/kdocs-skill/master/scripts/setup.ps1',
    skillUrl: 'https://wpsai.wpscdn.cn/skillhub/pro/v2.7.1/kdocs.zip' }),
  wps365: Object.freeze({ version: CLOUD_DOCUMENT_VERSIONS.wps365, archiveName: 'wps365-cli-x86_64-pc-windows-gnu.zip', executable: 'wps365-cli.exe',
    archiveUrl: 'https://open-docs.wpscdn.cn/cli/releases/download/v0.3.6/wps365-cli-x86_64-pc-windows-gnu.zip',
    checksumsUrl: 'https://open-docs.wpscdn.cn/cli/releases/download/v0.3.6/checksums-sha256.txt',
    installerSource: 'https://raw.githubusercontent.com/wps365-open/cli/main/install.ps1',
    referenceUrl: 'https://raw.githubusercontent.com/wps365-open/cli/main/README.md' }),
  tencent: Object.freeze({ skillUrl: 'https://cdn.addon.tencentsuite.com/static/tencent-docs.zip' }),
});

export function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
export function verifyVendorChecksum(bytes, checksums, archiveName) {
  const matches = String(checksums).split(/\r?\n/).map(line => /^\s*([a-f0-9]{64})\s+\*?(.+?)\s*$/i.exec(line))
    .filter(match => match && match[2] === archiveName);
  if (matches.length !== 1) throw new Error('Official archive checksum is missing or ambiguous');
  const actual = sha256(bytes);
  if (actual !== matches[0][1].toLowerCase()) throw new Error('Official archive SHA-256 mismatch');
  return actual;
}

function safeEntry(name) {
  const parts = name.replace(/\/$/, '').split('/');
  return name.length <= 240 && parts.every(part => part && part !== '.' && part !== '..' && !/[\\<>:"|?*\x00-\x1f]/.test(part)
    && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part));
}

export function verifyWindowsExecutable(bytes) {
  if (bytes.length < 64 || bytes.toString('ascii', 0, 2) !== 'MZ') throw new Error('Archive does not contain a Windows executable');
  const offset = bytes.readUInt32LE(0x3c);
  if (offset > bytes.length - 24 || bytes.readUInt32LE(offset) !== 0x00004550 || bytes.readUInt16LE(offset + 4) !== 0x8664) throw new Error('Windows executable architecture is not AMD64');
  return true;
}

/** Validate every archive entry; extract only one named binary, never vendor scripts. */
export async function readVendorExecutable(bytes, executableName) {
  const zip = await new Promise((resolve, reject) => yauzl.fromBuffer(bytes, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, value) => error ? reject(error) : resolve(value)));
  let count = 0, expanded = 0, executable; const names = new Set();
  try {
    await new Promise((resolve, reject) => {
      zip.on('error', reject); zip.once('end', resolve);
      zip.on('entry', entry => {
        (async () => {
          if (++count > 200 || !safeEntry(entry.fileName)) throw new Error('Unsafe vendor archive path or entry count');
          const key = entry.fileName.replace(/\/$/, '').toLowerCase();
          if (names.has(key)) throw new Error('Duplicate vendor archive entry'); names.add(key);
          const mode = entry.externalFileAttributes >>> 16 & 0xf000;
          if (mode && mode !== 0x8000 && mode !== 0x4000 || entry.generalPurposeBitFlag & 1 || ![0, 8].includes(entry.compressionMethod)) throw new Error('Unsupported vendor archive entry');
          expanded += entry.uncompressedSize;
          if (entry.uncompressedSize > 80 * 1024 * 1024 || expanded > 128 * 1024 * 1024) throw new Error('Vendor archive expansion limit exceeded');
          if (entry.fileName.endsWith('/')) { zip.readEntry(); return; }
          if (entry.fileName.split('/').at(-1) !== executableName) { zip.readEntry(); return; }
          if (executable) throw new Error('Vendor archive contains multiple matching executables');
          const stream = await new Promise((res, rej) => zip.openReadStream(entry, (error, value) => error ? rej(error) : res(value)));
          const chunks = []; let size = 0, checksum = 0;
          for await (const chunk of stream) {
            size += chunk.length; if (size > 80 * 1024 * 1024 || size > entry.uncompressedSize) throw new Error('Executable expansion limit exceeded');
            checksum = crc32(chunk, checksum); chunks.push(chunk);
          }
          if (size !== entry.uncompressedSize || checksum !== entry.crc32) throw new Error('Vendor executable CRC mismatch');
          executable = Buffer.concat(chunks); verifyWindowsExecutable(executable); zip.readEntry();
        })().catch(error => { reject(error); zip.close(); });
      });
      zip.readEntry();
    });
  } finally { zip.close(); }
  if (!executable) throw new Error('Expected vendor executable is missing');
  return executable;
}

/** Upstream Windows ZIPs can use backslashes; retain the original and canonicalize a reviewed copy only. */
export async function readVendorSkillPackage(bytes) {
  if (bytes.length > 10 * 1024 * 1024) throw new Error('Vendor skill package exceeds size limit');
  const zip = await new Promise((resolve, reject) => yauzl.fromBuffer(bytes, { lazyEntries: true, strictFileNames: false, validateEntrySizes: true }, (error, value) => error ? reject(error) : resolve(value)));
  const files = [], names = new Set(); let total = 0, count = 0;
  try {
    await new Promise((resolve, reject) => {
      zip.on('error', reject); zip.once('end', resolve);
      zip.on('entry', entry => {
        (async () => {
          if (++count > 1500 || !safeEntry(entry.fileName)) throw new Error(`Unsafe vendor skill archive path or entry count: ${count} ${JSON.stringify(entry.fileName).slice(0, 300)}`);
          const key = entry.fileName.replace(/\/$/, '').toLowerCase();
          if (names.has(key)) throw new Error('Duplicate vendor skill archive path'); names.add(key);
          const mode = entry.externalFileAttributes >>> 16 & 0xf000;
          if (mode && mode !== 0x8000 && mode !== 0x4000 || entry.generalPurposeBitFlag & 1 || ![0, 8].includes(entry.compressionMethod)) throw new Error('Unsupported vendor skill archive entry');
          if (entry.uncompressedSize > 10 * 1024 * 1024 || total + entry.uncompressedSize > 40 * 1024 * 1024) throw new Error('Vendor skill expansion limit exceeded');
          if (entry.fileName.endsWith('/')) { zip.readEntry(); return; }
          const stream = await new Promise((res, rej) => zip.openReadStream(entry, (error, value) => error ? rej(error) : res(value)));
          const chunks = []; let size = 0, checksum = 0;
          for await (const chunk of stream) {
            total += chunk.length; size += chunk.length;
            if (size > 10 * 1024 * 1024 || total > 40 * 1024 * 1024) throw new Error('Vendor skill expansion limit exceeded');
            chunks.push(chunk); checksum = crc32(chunk, checksum);
          }
          if (size !== entry.uncompressedSize || checksum !== entry.crc32) throw new Error('Vendor skill CRC mismatch');
          if (!entry.fileName.split('/').includes('__MACOSX') && !entry.fileName.endsWith('/.DS_Store')) files.push({ path: entry.fileName, data: Buffer.concat(chunks) });
          zip.readEntry();
        })().catch(error => { reject(error); zip.close(); });
      });
      zip.readEntry();
    });
  } finally { zip.close(); }
  const local = [], central = []; let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.path), compressed = deflateRawSync(file.data), checksum = crc32(file.data);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8);
    header.writeUInt32LE(checksum, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(file.data.length, 22); header.writeUInt16LE(name.length, 26);
    const index = Buffer.alloc(46); index.writeUInt32LE(0x02014b50); index.writeUInt16LE(20, 4); index.writeUInt16LE(20, 6); index.writeUInt16LE(0x800, 8); index.writeUInt16LE(8, 10);
    index.writeUInt32LE(checksum, 16); index.writeUInt32LE(compressed.length, 20); index.writeUInt32LE(file.data.length, 24); index.writeUInt16LE(name.length, 28); index.writeUInt32LE(offset, 42);
    local.push(header, name, compressed); central.push(index, name); offset += header.length + name.length + compressed.length;
  }
  const index = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16);
  const archive = Buffer.concat([...local, index, end]);
  const mains = files.filter(file => file.path.split('/').at(-1) === 'SKILL.md');
  if (mains.length !== 1 || mains[0].data.length > 256 * 1024) throw new Error('Vendor package must contain exactly one bounded SKILL.md');
  const prefix = mains[0].path.slice(0, -'SKILL.md'.length);
  if (files.some(file => !file.path.startsWith(prefix))) throw new Error('Vendor skill files must share one package root');
  const source = new TextDecoder('utf-8', { fatal: true }).decode(mains[0].data).replace(/^\uFEFF/, '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(source);
  if (!match) throw new Error('Vendor skill frontmatter is missing');
  const yaml = parseDocument(match[1]); if (yaml.errors.length) throw new Error('Vendor skill frontmatter is invalid');
  const metadata = yaml.toJS({ maxAliasCount: 20 });
  return { archive, skill: { name: metadata?.name, description: metadata?.description, content: match[2],
    files: files.map(file => ({ ...file, path: file.path.slice(prefix.length) })) } };
}

export async function ensureVendorDirectory(root, relative) {
  const absoluteRoot = await fs.realpath(root), parts = relative.split(/[\\/]/);
  if (parts.some(part => !part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]/.test(part))) throw new Error('Invalid vendor directory path');
  let current = absoluteRoot;
  for (const part of parts) {
    current = path.join(current, part);
    try { await fs.mkdir(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(current) !== current) throw new Error('Vendor directory must not be a link');
  }
  return current;
}

/** Idempotent byte-for-byte reuse; never overwrite an existing or linked file. */
export async function writeVendorFile(filePath, bytes) {
  try {
    const handle = await fs.open(filePath, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    return 'created';
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== bytes.length || sha256(await fs.readFile(filePath)) !== sha256(bytes)) throw new Error('Existing vendor file differs; refusing to overwrite');
    return 'unchanged';
  }
}
