import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { cloudDocumentPaths, CLOUD_DOCUMENT_PROJECT_ROOT, CLOUD_DOCUMENT_SOURCES, CLOUD_DOCUMENT_VERSIONS,
  sha256, verifyVendorChecksum, readVendorExecutable, readVendorSkillPackage, ensureVendorDirectory, writeVendorFile } from '../lib/cloud-document-binaries.mjs';

const run = promisify(execFile);
const allowedHosts = new Set(['wpsai.wpscdn.cn', 'open-docs.wpscdn.cn', 'cdn.addon.tencentsuite.com', 'raw.githubusercontent.com',
  'github.com', 'api.github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);

async function download(source, maxBytes = 128 * 1024 * 1024) {
  let url = source;
  for (let hop = 0; hop < 6; hop++) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !allowedHosts.has(parsed.hostname)) throw new Error('Download URL is not an approved vendor source');
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(60_000), headers: { 'user-agent': 'PiWeb-CloudDocument-Installer/1.0' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel(); url = new URL(response.headers.get('location'), url).href; continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Vendor download failed: ${response.status} (${parsed.hostname}${parsed.pathname})`); }
    if (Number(response.headers.get('content-length')) > maxBytes) { await response.body.cancel(); throw new Error('Vendor download exceeds size limit'); }
    const chunks = []; let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > maxBytes) throw new Error('Vendor download exceeds size limit');
      chunks.push(Buffer.from(chunk));
    }
    return { bytes: Buffer.concat(chunks), url };
  }
  throw new Error('Vendor download redirect limit exceeded');
}

export async function installCloudDocumentTools({ root = CLOUD_DOCUMENT_PROJECT_ROOT } = {}) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This pinned installation currently supports Windows AMD64 only');
  const project = await fs.realpath(root), paths = cloudDocumentPaths(project);
  const auditDirectory = await ensureVendorDirectory(project, 'qa/vendor-docs-20261030');
  const downloads = await ensureVendorDirectory(project, 'qa/vendor-docs-20261030/downloads');
  await ensureVendorDirectory(project, '.tools/cloud-docs');
  const artifacts = [], tools = {};
  async function retained(url, filename, maxBytes) {
    const target = path.join(downloads, filename); let downloaded;
    try {
      const stat = await fs.lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > (maxBytes || 128 * 1024 * 1024)) throw new Error('Existing vendor download is invalid');
      downloaded = { bytes: await fs.readFile(target), url };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      downloaded = await download(url, maxBytes); await writeVendorFile(target, downloaded.bytes);
    }
    artifacts.push({ filename, sourceUrl: url, resolvedUrl: downloaded.url, sha256: sha256(downloaded.bytes), bytes: downloaded.bytes.length });
    return downloaded.bytes;
  }
  for (const provider of ['kdocs', 'wps365']) {
    const source = CLOUD_DOCUMENT_SOURCES[provider];
    const checksums = await retained(source.checksumsUrl, `${provider}-checksums.txt`, 1024 * 1024);
    const archive = await retained(source.archiveUrl, source.archiveName);
    const archiveSha256 = verifyVendorChecksum(archive, checksums.toString('utf8'), source.archiveName);
    const executable = await readVendorExecutable(archive, source.executable);
    await ensureVendorDirectory(project, `.tools/cloud-docs/${provider}`);
    await writeVendorFile(paths[provider].executable, executable);
    // These commands are local metadata probes. Never login, initialize an account, or read a stored token here.
    const versionArgs = provider === 'kdocs' ? ['version'] : ['--version'];
    const version = await run(paths[provider].executable, versionArgs, { windowsHide: true, timeout: 15_000, maxBuffer: 512 * 1024 });
    const help = await run(paths[provider].executable, ['--help'], { windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024 });
    await writeVendorFile(path.join(auditDirectory, `${provider}-help.txt`), Buffer.from(help.stdout + help.stderr));
    if (!`${version.stdout} ${version.stderr}`.includes(source.version)) throw new Error('Installed vendor executable reports an unexpected version');
    tools[provider] = { version: source.version, executable: paths[provider].executable, sha256: sha256(executable), archiveSha256, versionOutput: version.stdout.trim() || version.stderr.trim() };
    await retained(source.installerSource, `${provider}-upstream-installer.ps1`, 1024 * 1024);
  }
  for (const provider of ['kdocs', 'tencent']) {
    const archive = await retained(CLOUD_DOCUMENT_SOURCES[provider].skillUrl, `${provider}-original-skill.zip`, 10 * 1024 * 1024);
    const { archive: canonical, skill } = await readVendorSkillPackage(archive);
    await writeVendorFile(path.join(downloads, `${provider}-canonical-review-skill.zip`), canonical);
    const destination = await ensureVendorDirectory(project, `qa/vendor-docs-20261030/extracted/${provider}`);
    for (const file of skill.files) {
      const parent = path.posix.dirname(file.path);
      if (parent !== '.') await ensureVendorDirectory(destination, parent);
      await writeVendorFile(path.join(destination, file.path), file.data);
    }
    tools[`${provider}Skill`] = { name: skill.name, description: skill.description, files: skill.files.length, directory: destination };
  }
  const sdkDirectory = await ensureVendorDirectory(project, '.tools/cloud-docs/mcp-runtime');
  const sdkPackage = path.join(sdkDirectory, 'package.json');
  let existing;
  try { existing = JSON.parse(await fs.readFile(sdkPackage, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing && (existing.dependencies?.['@modelcontextprotocol/sdk'] !== CLOUD_DOCUMENT_VERSIONS.mcpSdk || existing.name !== 'pi-web-cloud-documents-runtime')) throw new Error('Existing MCP runtime differs; refusing to replace it');
  if (!existing) await writeVendorFile(sdkPackage, Buffer.from(JSON.stringify({ name: 'pi-web-cloud-documents-runtime', version: '1.0.0', private: true, type: 'module', dependencies: { '@modelcontextprotocol/sdk': CLOUD_DOCUMENT_VERSIONS.mcpSdk } }, null, 2) + '\n'));
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  await fs.access(npmCli);
  await run(process.execPath, [npmCli, 'install', '--prefix', sdkDirectory, '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org'], { windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024 });
  const sdk = JSON.parse(await fs.readFile(path.join(sdkDirectory, 'node_modules/@modelcontextprotocol/sdk/package.json'), 'utf8'));
  if (sdk.version !== CLOUD_DOCUMENT_VERSIONS.mcpSdk) throw new Error('Installed MCP SDK version differs from the pinned version');
  tools.tencent = { sdkRoot: sdkDirectory, sdkVersion: sdk.version };
  const manifest = { schemaVersion: 1, platform: 'windows-amd64', tools, artifacts };
  await writeVendorFile(path.join(auditDirectory, 'installation.json'), Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  installCloudDocumentTools().then(manifest => console.log(JSON.stringify(manifest, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
