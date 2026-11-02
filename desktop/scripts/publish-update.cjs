'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const yaml = require('yaml');
const semver = require('semver');
const { validatePolicy } = require('../src/updates.cjs');
const root = path.resolve(__dirname, '..'), output = path.join(root, 'release', 'installer'), feed = path.resolve(root, '..', 'public', 'desktop-updates', 'windows');
async function digest(file, algorithm) { const hash = crypto.createHash(algorithm); const handle = await fs.open(file); try { for await (const chunk of handle.createReadStream()) hash.update(chunk); } finally { await handle.close(); } return hash.digest(algorithm === 'sha512' ? 'base64' : 'hex'); }
async function atomic(name, text) { const target = path.join(feed, name), temporary = `${target}.next`; await fs.writeFile(temporary, text); await fs.rename(temporary, target); }
void (async () => {
  const packageInfo = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const manifestText = await fs.readFile(path.join(output, 'latest.yml'), 'utf8'), manifest = yaml.parse(manifestText);
  if (manifest.version !== packageInfo.version || !Array.isArray(manifest.files) || manifest.files.length !== 1) throw new Error('Build output and package version do not match.');
  const artifact = manifest.files[0];
  if (!/^PiConsole-Setup-\d+\.\d+\.\d+-x64\.exe$/.test(artifact.url) || manifest.path !== artifact.url) throw new Error('Unexpected installer path.');
  const installer = path.join(output, artifact.url), sha512 = await digest(installer, 'sha512');
  if (artifact.sha512 !== sha512 || manifest.sha512 !== sha512 || artifact.size !== (await fs.stat(installer)).size) throw new Error('Installer checksum or size does not match update metadata.');
  let previous = null; try { previous = validatePolicy(JSON.parse(await fs.readFile(path.join(feed, 'policy.json'), 'utf8'))); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const argument = process.argv.indexOf('--minimum-version');
  const policy = validatePolicy({ schemaVersion: 1, latestVersion: packageInfo.version, minimumVersion: argument >= 0 ? process.argv[argument + 1] : packageInfo.version, notes: JSON.parse(await fs.readFile(path.join(root, 'RELEASE_NOTES.json'), 'utf8')) });
  if (previous && (semver.lt(policy.minimumVersion, previous.minimumVersion) || semver.lt(policy.latestVersion, previous.latestVersion))) throw new Error('An update must not downgrade the published version or minimum version.');
  await fs.mkdir(feed, { recursive: true });
  for (const filename of [artifact.url, `${artifact.url}.blockmap`]) {
    const source = path.join(output, filename), target = path.join(feed, filename), checksum = await digest(source, 'sha512');
    try { if (await digest(target, 'sha512') !== checksum) throw new Error(`Refusing to replace an already-published artifact: ${filename}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; const temporary = `${target}.next`; await fs.copyFile(source, temporary); if (await digest(temporary, 'sha512') !== checksum) throw new Error('Published artifact checksum failed'); await fs.rename(temporary, target); }
  }
  await atomic('SHA256SUMS.txt', `${await digest(installer, 'sha256')}  ${artifact.url}\n`);
  await atomic('latest.yml', manifestText);
  await atomic('policy.json', JSON.stringify({ ...policy, publishedAt: new Date().toISOString() }, null, 2) + '\n');
  console.log(JSON.stringify({ published: true, version: policy.latestVersion, minimumVersion: policy.minimumVersion, installer: `https://ai.junweirpa.asia/desktop-updates/windows/${artifact.url}` }));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
