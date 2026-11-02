import fs from 'node:fs/promises';
import { renameSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { HttpError } from './security.mjs';

export const CLOUD_PROVIDERS = Object.freeze(['tencent', 'kdocs', 'wps365']);
export function assertCloudProvider(provider) {
  if (!CLOUD_PROVIDERS.includes(provider)) throw new HttpError(404, '云文档连接不存在。');
  return provider;
}

// The only process input is stdin. Neither credentials nor ciphertext appear in
// command arguments, environment variables, console output or application logs.
export async function windowsCredentialCodec(operation, value) {
  if (process.platform !== 'win32') throw new Error('云文档凭据需要 Windows 用户加密存储。');
  const script = `Add-Type -AssemblyName System.Security; $ErrorActionPreference='Stop'; $v=[Console]::In.ReadToEnd(); $b=[Convert]::FromBase64String($v); $r=[System.Security.Cryptography.ProtectedData]::${operation === 'protect' ? 'Protect' : 'Unprotect'}($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))`;
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', size = 0, settled = false;
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(result); };
    const timer = setTimeout(() => { child.kill(); finish(new Error('云文档凭据加密操作超时。')); }, 15000);
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 256 * 1024) { child.kill(); finish(new Error('云文档凭据加密结果无效。')); } else output += chunk; });
    child.stderr.resume(); child.stdin.on('error', () => {});
    child.on('error', () => finish(new Error('无法启动 Windows 凭据加密。')));
    child.on('close', code => {
      if (code !== 0 || !/^[A-Za-z0-9+/=]+$/.test(output)) return finish(new Error('无法访问当前 Windows 用户的云文档凭据。'));
      finish(null, Buffer.from(output, 'base64'));
    });
    child.stdin.end(Buffer.from(value).toString('base64'));
  });
}

export class CloudCredentialVault {
  static async open(directory, options = {}) {
    const vault = new CloudCredentialVault(directory, options);
    await vault.load(); return vault;
  }
  constructor(directory, { codec = windowsCredentialCodec } = {}) {
    this.directory = path.resolve(directory); this.file = path.join(this.directory, 'cloud-document-credentials.json');
    this.codec = codec; this.values = {}; this.generations = new Map(); this.secretHistory = new Set(); this.queue = Promise.resolve();
  }
  async guard() {
    const stat = await fs.lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('云文档凭据目录无效。');
    try { const file = await fs.lstat(this.file); if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || file.size > 256 * 1024) throw new Error('云文档凭据文件无效。'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  remember(values) { for (const item of Object.values(values)) for (const secret of Object.values(item)) if (typeof secret === 'string' && secret.length >= 4) this.secretHistory.add(secret); }
  async load() {
    await this.guard(); let record;
    try { record = JSON.parse(await fs.readFile(this.file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return; throw new Error('云文档加密凭据读取失败。'); }
    if (record?.version !== 1 || record?.protection !== 'windows-current-user' || typeof record.ciphertext !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(record.ciphertext)) throw new Error('云文档加密凭据格式无效。');
    let values;
    try { values = JSON.parse((await this.codec('unprotect', Buffer.from(record.ciphertext, 'base64'))).toString('utf8')); }
    catch { throw new Error('无法解密云文档凭据，请使用原 Windows 用户启动 Pi Web。'); }
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('云文档凭据格式无效。');
    for (const [provider, fields] of Object.entries(values)) {
      const required = this.validate(provider, fields);
      if (required.some(key => !fields[key]?.trim())) throw new Error('云文档凭据格式无效。');
    }
    this.values = values; this.remember(values);
  }
  get(provider) { assertCloudProvider(provider); return this.values[provider] ? { ...this.values[provider] } : null; }
  version(provider) { return this.generations.get(provider) || 0; }
  knownSecrets() { return [...this.secretHistory]; }
  validate(provider, body) {
    assertCloudProvider(provider);
    const fields = provider === 'wps365' ? ['clientId', 'clientSecret'] : ['token'];
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !fields.includes(key))) throw new HttpError(400, '云文档凭据字段无效。');
    for (const [key, value] of Object.entries(body)) if (typeof value !== 'string' || value.length > (key === 'clientId' ? 200 : 8192) || value.trim() && key !== 'clientId' && value.trim().length < 8 || /[\x00-\x1f\x7f]/.test(value)) throw new HttpError(400, '云文档凭据格式无效（Token / 应用密钥至少 8 个字符）。');
    return fields;
  }
  serialize(action) { const next = this.queue.then(action); this.queue = next.catch(() => {}); return next; }
  async persist(next, authorize, onCommit = () => {}) {
    authorize(); await this.guard();
    const encrypted = await this.codec('protect', Buffer.from(JSON.stringify(next)));
    authorize(); const temporary = path.join(this.directory, `.cloud-documents-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, JSON.stringify({ version: 1, protection: 'windows-current-user', ciphertext: encrypted.toString('base64') }), { flag: 'wx', mode: 0o600 });
      await this.guard(); authorize();
      // Commit and memory update share one synchronous authorization boundary,
      // just like the surrounding SQLite account/skill changes.
      renameSync(temporary, this.file);
      this.values = next; this.remember(next); onCommit();
    } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  update(provider, body, { authorize = () => {} } = {}) {
    const fields = this.validate(provider, body);
    return this.serialize(async () => {
      authorize(); const merged = { ...this.values[provider] };
      for (const key of fields) if (body[key]?.trim()) merged[key] = body[key].trim();
      if (fields.some(key => !merged[key])) throw new HttpError(400, provider === 'wps365' ? '请填写应用 ID 和应用密钥。' : '请填写官方授权 Token。');
      await this.persist({ ...this.values, [provider]: merged }, authorize, () => this.generations.set(provider, this.version(provider) + 1));
    });
  }
  clear(provider, { authorize = () => {} } = {}) {
    assertCloudProvider(provider);
    return this.serialize(async () => { const next = { ...this.values }; delete next[provider]; await this.persist(next, authorize, () => this.generations.set(provider, this.version(provider) + 1)); });
  }
}
