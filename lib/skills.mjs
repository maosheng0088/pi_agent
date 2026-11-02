import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HttpError } from './security.mjs';
import { readSkillZip } from './skill-zip.mjs';
import { validateAvatarId } from './avatar-options.mjs';

const scopeFor = row => ({ scope: row.scope ?? 'all', groupIds: JSON.parse(row.group_ids_json || '[]') });
const metadata = row => ({ id: row.id, name: row.name, description: row.description, enabled: Boolean(row.enabled), version: row.version, avatarId: row.avatar_id ?? '', ...scopeFor(row), createdAt: row.created_at, updatedAt: row.updated_at });
const matchesScope = (row, sessionId) => row.scope === 'all' || (row.scope === 'groups' && typeof sessionId === 'string' && scopeFor(row).groupIds.includes(sessionId));
const unavailable = () => new HttpError(400, '技能不存在、已停用或不在当前群可用范围。');
function normalized(body, current = {}) {
  const next = { ...current };
  for (const field of ['name', 'description', 'content']) if (field in body) {
    if (typeof body[field] !== 'string') throw new HttpError(400, `${field} 须为文本。`);
    next[field] = body[field].trim();
  }
  if (!next.name || next.name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(next.name)) throw new HttpError(400, '技能名称须为 1–64 位小写字母、数字与短横线，不得以短横线开头、结尾或连续使用短横线。');
  if (!next.description || next.description.length > 1024) throw new HttpError(400, '技能说明须为 1–1024 个字符。');
  if (!next.content || next.content.length > 60000) throw new HttpError(400, '技能正文须为 1–60,000 个字符。');
  if ('enabled' in body && typeof body.enabled !== 'boolean') throw new HttpError(400, 'enabled 须为布尔值。');
  next.enabled = body.enabled ?? next.enabled ?? true;
  next.avatarId = 'avatarId' in body ? validateAvatarId(body.avatarId) : next.avatarId ?? '';
  next.scope = 'scope' in body ? body.scope : next.scope ?? 'all';
  if (!['all', 'groups'].includes(next.scope)) throw new HttpError(400, '技能共享范围须为 all 或 groups。');
  const groupIds = 'groupIds' in body ? body.groupIds : next.groupIds ?? [];
  if (!Array.isArray(groupIds) || groupIds.length > 500 || groupIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id))) throw new HttpError(400, '群聊列表须包含至多 500 个有效群聊 ID。');
  next.groupIds = next.scope === 'all' ? [] : [...new Set(groupIds)];
  if (next.scope === 'groups' && !next.groupIds.length) throw new HttpError(400, '请至少选择一个可使用此技能的群聊。');
  return next;
}

export class SkillCatalog {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.pending = Promise.resolve();
    this.directory = path.join(store.directory, 'skills');
    fsSync.mkdirSync(this.directory, { recursive: true });
    this.db.exec(`CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL,
      content TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`);
    if (!this.db.prepare('PRAGMA table_info(skills)').all().some(column => column.name === 'files_json')) this.db.exec("ALTER TABLE skills ADD COLUMN files_json TEXT NOT NULL DEFAULT '[]'");
    const columns = this.db.prepare('PRAGMA table_info(skills)').all();
    if (!columns.some(column => column.name === 'avatar_id')) this.db.exec("ALTER TABLE skills ADD COLUMN avatar_id TEXT NOT NULL DEFAULT ''");
    if (!columns.some(column => column.name === 'scope')) this.db.exec("ALTER TABLE skills ADD COLUMN scope TEXT NOT NULL DEFAULT 'all'");
    if (!columns.some(column => column.name === 'group_ids_json')) this.db.exec("ALTER TABLE skills ADD COLUMN group_ids_json TEXT NOT NULL DEFAULT '[]'");
  }
  row(id) { const row = this.db.prepare('SELECT * FROM skills WHERE id=?').get(id); if (!row) throw new HttpError(404, '技能不存在。'); return row; }
  list() { return this.db.prepare('SELECT * FROM skills ORDER BY name').all().map(metadata); }
  get(id) { const row = this.row(id); return { ...metadata(row), content: row.content, files: JSON.parse(row.files_json || '[]') }; }
  available(sessionId) { return this.db.prepare('SELECT * FROM skills WHERE enabled=1 ORDER BY name').all().filter(row => matchesScope(row, sessionId)).map(metadata); }
  isAvailable(id, sessionId, { requireEnabled = true } = {}) {
    const row = this.db.prepare('SELECT * FROM skills WHERE id=?').get(id);
    return Boolean(row && (!requireEnabled || row.enabled) && matchesScope(row, sessionId));
  }
  assertAvailable(id, sessionId) { if (!this.isAvailable(id, sessionId)) throw unavailable(); return this.get(id); }
  assertScope(id, sessionId) { if (!this.isAvailable(id, sessionId, { requireEnabled: false })) throw unavailable(); return this.get(id); }
  async importZip(body, id = null, options = {}) {
    const archive = await readSkillZip(body.zipBase64);
    const value = { name: archive.name, description: archive.description, content: archive.content, enabled: body.enabled ?? false };
    for (const field of ['scope', 'groupIds', 'avatarId']) if (field in body) value[field] = body[field];
    return this.serialize(() => id ? this.updateSnapshot(id, value, archive.files, options) : this.createSnapshot(value, archive.files, options));
  }
  async publishFiles(id, version, files) {
    const folder = path.dirname(this.file(id, version));
    const parent = path.dirname(folder);
    await fs.mkdir(parent, { recursive: true });
    const staging = path.join(parent, `.import-${randomUUID()}`);
    await fs.mkdir(staging);
    try {
      for (const file of files) {
        const destination = path.join(staging, file.path);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, file.data, { flag: 'wx', mode: 0o600 });
      }
      await fs.rename(staging, folder);
    } catch (error) {
      // The staging path is generated here, directly inside this skill's UUID directory.
      if (path.dirname(path.resolve(staging)) === path.resolve(parent) && path.basename(staging).startsWith('.import-')) await fs.rm(staging, { recursive: true, force: true });
      throw error;
    }
    return files.filter(file => file.path !== 'SKILL.md').map(file => ({ path: file.path, size: file.data.length }));
  }
  file(id, version) { return path.join(this.directory, id, `v${version}`, 'SKILL.md'); }
  serialize(operation) {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => {});
    return result;
  }
  async write(row) {
    const folder = path.dirname(this.file(row.id, row.version));
    await fs.mkdir(folder, { recursive: true });
    const root = await fs.realpath(this.directory), real = await fs.realpath(folder);
    const relative = path.relative(root, real);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new HttpError(400, '技能存储路径无效。');
    const destination = path.join(real, 'SKILL.md');
    // A running Agent owns this exact version. Later edits and deletion must not
    // replace or remove the file before its read tool finishes using it.
    if (await fs.stat(destination).catch(() => null)) return;
    const temporary = path.join(real, `.SKILL-${randomUUID()}.tmp`);
    const source = `---\nname: ${JSON.stringify(row.name)}\ndescription: ${JSON.stringify(row.description)}\n---\n\n${row.content}\n`;
    await fs.writeFile(temporary, source, { mode: 0o600 });
    await fs.rename(temporary, destination);
  }
  create(body, options = {}) { return this.serialize(() => this.createSnapshot(body, null, options)); }
  async createSnapshot(body, files = null, { authorize = () => {} } = {}) {
    const value = normalized(body);
    authorize(value);
    if (this.db.prepare('SELECT id FROM skills WHERE name=?').get(value.name)) throw new HttpError(409, '技能名称已存在。');
    const now = new Date().toISOString(), id = randomUUID();
    const row = { id, ...value, version: 1, created_at: now, updated_at: now };
    const manifest = files ? await this.publishFiles(id, 1, files) : [];
    await this.write(row);
    try {
      authorize(value);
      this.db.prepare('INSERT INTO skills(id,name,description,content,enabled,version,created_at,updated_at,files_json,scope,group_ids_json,avatar_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, value.name, value.description, value.content, Number(value.enabled), 1, now, now, JSON.stringify(manifest), value.scope, JSON.stringify(value.groupIds), value.avatarId);
    } catch (error) {
      await fs.unlink(this.file(id, 1)).catch(() => {});
      if (this.db.prepare('SELECT id FROM skills WHERE name=?').get(value.name)) throw new HttpError(409, '技能名称已存在。');
      throw error;
    }
    return this.get(id);
  }
  update(id, body, options = {}) { return this.serialize(() => this.updateSnapshot(id, body, null, options)); }
  async updateSnapshot(id, body, files = null, { authorize = () => {} } = {}) {
    const current = this.row(id), value = normalized(body, { ...current, ...metadata(current) });
    authorize(value);
    if (this.db.prepare('SELECT id FROM skills WHERE name=? AND id<>?').get(value.name, id)) throw new HttpError(409, '技能名称已存在。');
    const now = new Date(Math.max(Date.now(), (Date.parse(current.updated_at) || 0) + 1)).toISOString();
    if (!files && Object.keys(body).length && Object.keys(body).every(key => ['scope', 'groupIds', 'avatarId'].includes(key))) {
      authorize(value);
      this.db.prepare('UPDATE skills SET scope=?,group_ids_json=?,avatar_id=?,updated_at=? WHERE id=?').run(value.scope, JSON.stringify(value.groupIds), value.avatarId, now, id);
      return this.get(id);
    }
    // Publish only after the immutable file is ready; failed writes keep the old
    // database version intact.
    let manifest = JSON.parse(current.files_json || '[]');
    if (!files) {
      const paths = manifest.map(file => file.path);
      if (!['name', 'description', 'content'].some(key => key in body)) paths.push('SKILL.md');
      files = await Promise.all(paths.map(async name => ({ path: name, data: await fs.readFile(path.join(path.dirname(this.file(id, current.version)), name)) })));
    }
    manifest = await this.publishFiles(id, current.version + 1, files);
    await this.write({ id, ...value, version: current.version + 1 });
    try {
      authorize(value);
      this.db.prepare('UPDATE skills SET name=?,description=?,content=?,enabled=?,version=version+1,updated_at=?,files_json=?,scope=?,group_ids_json=?,avatar_id=? WHERE id=?')
        .run(value.name, value.description, value.content, Number(value.enabled), now, JSON.stringify(manifest), value.scope, JSON.stringify(value.groupIds), value.avatarId, id);
    } catch (error) {
      // This exact new version was staged by this serialized operation. A denied
      // commit must not leave an unpublished directory blocking the next edit.
      const unpublished = path.resolve(path.dirname(this.file(id, current.version + 1)));
      const relative = path.relative(path.resolve(this.directory), unpublished);
      if (this.row(id).version === current.version && relative && !relative.startsWith('..') && !path.isAbsolute(relative)
        && path.basename(unpublished) === `v${current.version + 1}` && path.basename(path.dirname(unpublished)) === id) {
        await fs.rm(unpublished, { recursive: true, force: true });
      }
      throw error;
    }
    return this.get(id);
  }
  remove(id) { return this.serialize(() => this.removeSnapshot(id)); }
  async removeSnapshot(id) {
    this.row(id);
    if (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schedules'").get()) {
      if (this.db.prepare('SELECT id FROM schedules WHERE skill_id=? LIMIT 1').get(id)) throw new HttpError(409, '仍有定时任务引用此技能，请先删除相关任务。');
    }
    this.db.prepare('DELETE FROM skills WHERE id=?').run(id);
    return { ok: true };
  }
  prepare(sdk, options) { return this.serialize(() => this.prepareSnapshot(sdk, options)); }
  async prepareSnapshot(sdk, { message, skillId, allowSkills = false, sessionId }) {
    const explicit = Boolean(skillId) || /^\/skill:/i.test(message);
    if (!allowSkills) {
      if (explicit) throw new HttpError(403, '仅管理员可调用技能。');
      return { message, skills: [], skillFiles: [], skillIds: [] };
    }
    const rows = this.db.prepare('SELECT * FROM skills WHERE enabled=1 ORDER BY name').all().filter(row => matchesScope(row, sessionId));
    let selected;
    let request = message;
    if (/^\/skill:/i.test(message)) {
      const command = message.match(/^\/skill:([a-z0-9]+(?:-[a-z0-9]+)*)(?:\s+([\s\S]*))?$/);
      if (!command) throw new HttpError(400, '技能命令格式为 /skill:技能名称 任务说明。');
      selected = rows.find(row => row.name === command[1]);
      if (!selected) throw unavailable();
      if (skillId && skillId !== selected.id) throw new HttpError(400, '选择的技能与命令不一致。');
      request = (command[2] || '').trim();
    } else if (skillId) {
      if (typeof skillId !== 'string') throw new HttpError(400, 'skillId 须为文本。');
      selected = rows.find(row => row.id === skillId);
      if (!selected) throw unavailable();
    }
    for (const row of rows) await this.write(row);
    const skills = rows.map(row => ({
      name: row.name, description: row.description, filePath: this.file(row.id, row.version), baseDir: path.dirname(this.file(row.id, row.version)),
      sourceInfo: sdk.createSyntheticSourceInfo(this.file(row.id, row.version), { source: 'sdk' }), disableModelInvocation: false,
    }));
    return {
      message: request || (selected ? `请执行技能 ${selected.name}；资料不足时先说明所需输入。` : message),
      skills, skillIds: rows.map(row => row.id), skillFiles: rows.flatMap(row => [this.file(row.id, row.version), ...JSON.parse(row.files_json || '[]').map(file => path.join(path.dirname(this.file(row.id, row.version)), file.path))]),
      ...(selected ? { skill: metadata(selected), instructions: `本次用户明确选择管理员已启用的技能 ${selected.name}（版本 ${selected.version}）。技能目录：${path.dirname(this.file(selected.id, selected.version))}。正文内的相对资料和脚本路径均相对于该目录。请执行以下技能说明，并遵守当前工具与工作区权限。\n\n${selected.content}` } : {}),
    };
  }
}
