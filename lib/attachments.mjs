import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { HttpError } from './security.mjs';

export const ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const inboxId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function safeError(error) {
  if (error instanceof HttpError) return error;
  if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return new HttpError(404, '附件或文件不存在。');
  if (error?.code === 'EACCES' || error?.code === 'EPERM' || error?.code === 'ELOOP') return new HttpError(403, '无法访问此附件文件。');
  if (error?.code === 'EISDIR') return new HttpError(400, '只能发布普通文件。');
  return new HttpError(500, '附件处理失败，请重试。');
}

function safeName(value, fallback) {
  const source = typeof value === 'string' && value.trim() ? value : fallback;
  const leaf = source.replaceAll('\\', '/').split('/').at(-1) || fallback;
  const clean = leaf.toWellFormed().normalize('NFC').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim();
  return clean && !/^\.+$/.test(clean) ? [...clean].slice(0, 180).join('') : 'attachment';
}

function disposition(name, inline) {
  const fallback = name.replace(/[^\x20-\x7e]|["\\;]/g, '_') || 'attachment';
  const encoded = encodeURIComponent(name).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${inline ? 'inline' : 'attachment'}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function mediaType(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif';
  if (bytes.length >= 16 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('ascii', 12, 16))) return 'image/webp';
  return 'application/octet-stream';
}

function portableName(value) {
  const normalized = safeName(value, 'attachment').replace(/[<>:"/\\|?*]/g, '_').replace(/[ .]+$/g, '') || 'attachment';
  const extension = path.extname(normalized).slice(0, 20);
  const stem = extension ? normalized.slice(0, -path.extname(normalized).length) : normalized;
  // The attachment UUID prefix also makes Windows device names ordinary names.
  return `${[...stem].slice(0, 80).join('') || 'attachment'}${extension}`;
}

async function writeBytes(handle, chunk, position) {
  let written = 0;
  while (written < chunk.length) {
    const result = await handle.write(chunk, written, chunk.length - written, position + written);
    if (!result.bytesWritten) throw new Error('Attachment write did not progress');
    written += result.bytesWritten;
  }
}

async function inboxDirectory(root, segments, create = false) {
  let directory = root;
  for (const segment of segments) {
    directory = path.join(directory, segment);
    if (!within(root, directory)) throw new HttpError(403, '附件接收路径无效。');
    if (create) {
      try { await fs.mkdir(directory, { mode: 0o700 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    const stat = await fs.lstat(directory), real = await fs.realpath(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || real !== directory || !within(root, real)) throw new HttpError(403, '附件接收目录不能是链接。');
  }
  return directory;
}

async function removeOwnedFile(file, root) {
  try {
    await inboxDirectory(root, file.segments);
    const current = await fs.lstat(file.path);
    if (current.isFile() && !current.isSymbolicLink() && current.nlink === 1 && current.dev === file.dev && current.ino === file.ino
      && current.birthtimeMs === file.birthtimeMs && await fs.realpath(file.path) === file.path) {
      await fs.unlink(file.path);
      return true;
    }
  } catch {}
  return false;
}

/** Private, immutable snapshots. Callers must separately authorize group access. */
export class AttachmentService {
  constructor(store) {
    this.store = store;
    this.materialized = new Map();
    this.dataDirectory = fsSync.realpathSync(store.directory);
    this.directory = path.join(this.dataDirectory, 'attachments');
    if (fsSync.existsSync(this.directory) && fsSync.lstatSync(this.directory).isSymbolicLink()) throw new HttpError(403, '附件目录不能是外部链接。');
    fsSync.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (!within(this.dataDirectory, fsSync.realpathSync(this.directory))) throw new HttpError(403, '附件目录必须位于服务数据目录内。');
    this.store.db.exec(`CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session_meta(id) ON DELETE CASCADE,
      name TEXT NOT NULL, size INTEGER NOT NULL CHECK(size>=0), mime_type TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('image','file')), created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS attachments_session ON attachments(session_id,created_at);`);
  }

  metadata(row) {
    const url = `/api/sessions/${encodeURIComponent(row.session_id)}/attachments/${row.id}`;
    return { id: row.id, name: row.name, size: row.size, mimeType: row.mime_type, kind: row.kind, url, downloadUrl: `${url}?download=1` };
  }

  get(id, sessionId) {
    if (typeof id !== 'string' || !uuid.test(id) || typeof sessionId !== 'string' || !sessionId) throw new HttpError(404, '附件不存在。');
    const row = this.store.db.prepare('SELECT * FROM attachments WHERE id=? AND session_id=?').get(id, sessionId);
    if (!row) throw new HttpError(404, '附件不存在。');
    return this.metadata(row);
  }

  async assertStorage() {
    const stat = await fs.lstat(this.directory);
    const real = await fs.realpath(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || real !== this.directory || !within(this.dataDirectory, real)) throw new HttpError(403, '附件存储目录无效。');
  }

  async readBytes({sessionId,id,authorize=()=>{},signal,maxBytes=20*1024*1024}={}) {
    let handle;
    try {
      authorize();signal?.throwIfAborted();const metadata=this.get(id,sessionId);
      if(metadata.size>maxBytes)throw new HttpError(413,'邮件附件总大小不能超过 20 MiB。');
      await this.assertStorage();authorize();
      const file=path.join(this.directory,`${metadata.id}.bin`);
      const before=await fs.lstat(file);
      if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size!==metadata.size)throw new HttpError(404,'附件不存在。');
      if(await fs.realpath(file)!==file)throw new HttpError(404,'附件不存在。');
      handle=await fs.open(file,fsSync.constants.O_RDONLY|(fsSync.constants.O_NOFOLLOW||0));
      const stat=await handle.stat();
      if(!stat.isFile()||stat.nlink!==1||stat.size!==metadata.size||stat.dev!==before.dev||stat.ino!==before.ino||stat.birthtimeMs!==before.birthtimeMs)throw new HttpError(404,'附件不存在。');
      authorize();signal?.throwIfAborted();const content=Buffer.alloc(stat.size);let position=0;
      while(position<content.length){authorize();signal?.throwIfAborted();const read=await handle.read(content,position,Math.min(65536,content.length-position),position);if(!read.bytesRead)throw new HttpError(404,'附件内容不完整。');position+=read.bytesRead;}
      const final=await handle.stat(),current=await fs.lstat(file);
      if(final.size!==stat.size||final.mtimeMs!==stat.mtimeMs||current.isSymbolicLink()||!current.isFile()||current.dev!==stat.dev||current.ino!==stat.ino||current.birthtimeMs!==stat.birthtimeMs||current.nlink!==1)throw new HttpError(409,'附件内容已变化，请重新上传。');
      authorize();signal?.throwIfAborted();return {name:metadata.name,mimeType:metadata.mimeType,content};
    } catch(error){throw safeError(error);}
    finally {await handle?.close();}
  }

  async upload({ sessionId, name, stream, contentLength, authorize = () => {} } = {}) {
    let output, temporary, snapshot, iterator;
    let committed = false, interruption, rejectInterrupted, timer, timeout;
    const interrupted = new Promise((_, reject) => { rejectInterrupted = reject; });
    interrupted.catch(() => {});
    const fail = error => { if (!interruption) { interruption = error; rejectInterrupted(error); } };
    const disconnected = () => fail(new HttpError(400, '文件上传已中断，请重新上传。'));
    const closed = () => { if (!stream?.readableEnded) disconnected(); };
    try {
      authorize();
      if (typeof sessionId !== 'string' || !this.store.db.prepare('SELECT id FROM session_meta WHERE id=?').get(sessionId)) throw new HttpError(404, '群聊不存在。');
      if (typeof name !== 'string' || !name.trim() || name.length > 1024 || !stream?.[Symbol.asyncIterator]) throw new HttpError(400, '请提供有效的文件名与文件内容。');
      let declared;
      if (contentLength !== undefined) {
        if (!/^\d+$/.test(String(contentLength)) || !Number.isSafeInteger(Number(contentLength))) throw new HttpError(400, '文件大小无效。');
        declared = Number(contentLength);
        if (declared > ATTACHMENT_MAX_BYTES) throw new HttpError(413, '附件不能超过 50 MiB。');
      }
      await this.assertStorage(); authorize();
      if (stream.aborted || stream.destroyed && !stream.readableEnded) throw new HttpError(400, '文件上传已中断，请重新上传。');
      const id = randomUUID();
      temporary = path.join(this.directory, `${id}.${randomUUID()}.tmp`);
      snapshot = path.join(this.directory, `${id}.bin`);
      output = await fs.open(temporary, 'wx', 0o600);
      stream.once?.('aborted', disconnected); stream.once?.('error', disconnected); stream.once?.('close', closed);
      timer = setInterval(() => { try { authorize(); } catch (error) { fail(error); } }, 1000);
      timeout = setTimeout(() => fail(new HttpError(408, '文件上传超时，请重新上传。')), 5 * 60 * 1000);
      timer.unref?.(); timeout.unref?.();
      iterator = stream.iterator ? stream.iterator({ destroyOnReturn: false }) : stream[Symbol.asyncIterator]();
      let bytes = 0, signature = Buffer.alloc(0);
      while (true) {
        if (interruption) throw interruption;
        const next = await Promise.race([iterator.next(), interrupted]);
        if (next.done) break;
        authorize();
        if (!Buffer.isBuffer(next.value) && !(next.value instanceof Uint8Array) && typeof next.value !== 'string') throw new HttpError(400, '文件内容格式无效。');
        const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
        if (bytes + chunk.length > ATTACHMENT_MAX_BYTES) throw new HttpError(413, '附件不能超过 50 MiB。');
        if (signature.length < 32) signature = Buffer.concat([signature, chunk.subarray(0, 32 - signature.length)]);
        await writeBytes(output, chunk, bytes);
        bytes += chunk.length;
      }
      if (interruption) throw interruption;
      if (declared !== undefined && bytes !== declared) throw new HttpError(400, '文件上传不完整，请重新上传。');
      await output.sync(); await output.close(); output = undefined;
      authorize();
      if (stream.aborted) throw new HttpError(400, '文件上传已中断，请重新上传。');
      await this.assertStorage();
      await fs.rename(temporary, snapshot); temporary = undefined;
      const mimeType = mediaType(signature);
      const row = { id, name: safeName(name, 'attachment'), size: bytes, mime_type: mimeType, kind: mimeType.startsWith('image/') ? 'image' : 'file' };
      authorize();
      this.store.db.prepare('INSERT INTO attachments(id,session_id,name,size,mime_type,kind,created_at) VALUES (?,?,?,?,?,?,?)')
        .run(id, sessionId, row.name, bytes, mimeType, row.kind, new Date().toISOString());
      committed = true;
      return this.metadata({ ...row, session_id: sessionId });
    } catch (error) {
      if (interruption) throw safeError(interruption);
      if (error?.code === 'ERR_STREAM_PREMATURE_CLOSE' || error?.code === 'ECONNRESET') throw new HttpError(400, '文件上传已中断，请重新上传。');
      throw safeError(error);
    } finally {
      clearInterval(timer); clearTimeout(timeout);
      stream?.off?.('aborted', disconnected); stream?.off?.('error', disconnected); stream?.off?.('close', closed);
      iterator?.return?.().catch?.(() => {});
      await Promise.allSettled([output?.close()]);
      if (!committed) await Promise.allSettled([temporary && fs.rm(temporary, { force: true }), snapshot && fs.rm(snapshot, { force: true })]);
    }
  }

  async materialize({ sessionId, attachmentIds, cwd, taskId, authorize = () => {} } = {}) {
    const created = [], results = [];
    try {
      authorize();
      if (typeof sessionId !== 'string' || typeof taskId !== 'string' || !inboxId.test(sessionId) || !inboxId.test(taskId)) throw new HttpError(400, '附件任务或群聊编号无效。');
      if (!Array.isArray(attachmentIds) || attachmentIds.length > 10 || attachmentIds.some(id => typeof id !== 'string' || !uuid.test(id)) || new Set(attachmentIds).size !== attachmentIds.length) throw new HttpError(400, '每次最多选择 10 个不重复的同群附件。');
      const attachments = attachmentIds.map(id => this.get(id, sessionId));
      if (!attachments.length) return [];
      if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new HttpError(400, '工作目录无效。');
      const workspaceRoot = await fs.realpath(cwd);
      if (!(await fs.stat(workspaceRoot)).isDirectory() || within(workspaceRoot, this.dataDirectory) || within(this.dataDirectory, workspaceRoot)) throw new HttpError(403, '附件工作目录须与服务数据目录分开。');
      const root = this.dataDirectory;
      for (const metadata of attachments) {
        let source, output;
        try {
          authorize(); await this.assertStorage();
          const snapshot = path.join(this.directory, `${metadata.id}.bin`);
          const before = await fs.lstat(snapshot), real = await fs.realpath(snapshot);
          if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size !== metadata.size || before.size > ATTACHMENT_MAX_BYTES || real !== snapshot) throw new HttpError(403, '附件快照无效。');
          source = await fs.open(snapshot, fsSync.constants.O_RDONLY | (fsSync.constants.O_NOFOLLOW || 0));
          const opened = await source.stat();
          if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== metadata.size || await fs.realpath(snapshot) !== snapshot) throw new HttpError(409, '附件快照已变化。');
          const segments = ['attachment-inbox', sessionId, taskId, metadata.id];
          const directory = await inboxDirectory(root, segments, true);
          const target = path.join(directory, `${metadata.id}-${portableName(metadata.name)}`);
          await inboxDirectory(root, segments); authorize();
          try { output = await fs.open(target, fsSync.constants.O_WRONLY | fsSync.constants.O_CREAT | fsSync.constants.O_EXCL | (fsSync.constants.O_NOFOLLOW || 0), 0o600); }
          catch (error) { if (error.code === 'EEXIST') throw new HttpError(409, '此任务的附件副本已存在，不能覆盖。'); throw error; }
          const destination = await output.stat();
          created.push({ path: target, segments, dev: destination.dev, ino: destination.ino, birthtimeMs: destination.birthtimeMs });
          await inboxDirectory(root, segments);
          if (!destination.isFile() || destination.nlink !== 1 || await fs.realpath(target) !== target) throw new HttpError(403, '附件接收文件无效。');
          const buffer = Buffer.allocUnsafe(64 * 1024);
          let bytes = 0;
          while (true) {
            authorize();
            const { bytesRead } = await source.read(buffer, 0, buffer.length, bytes);
            if (!bytesRead) break;
            if (bytes + bytesRead > metadata.size) throw new HttpError(409, '附件快照已变化。');
            await writeBytes(output, buffer.subarray(0, bytesRead), bytes);
            bytes += bytesRead;
          }
          const after = await source.stat();
          if (bytes !== metadata.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || after.nlink !== 1) throw new HttpError(409, '附件快照已变化。');
          await output.sync(); await output.close(); output = undefined;
          await source.close(); source = undefined;
          await inboxDirectory(root, segments);
          const final = await fs.lstat(target);
          if (!final.isFile() || final.isSymbolicLink() || final.nlink !== 1 || final.dev !== destination.dev || final.ino !== destination.ino || final.size !== metadata.size) throw new HttpError(409, '附件接收文件已变化。');
          authorize();
          results.push({ ...metadata, path: target });
        } finally { await Promise.allSettled([source?.close(), output?.close()]); }
      }
      authorize();
      for (const file of created) this.materialized.set(file.path, file);
      return results;
    } catch (error) {
      await Promise.allSettled(created.map(file => removeOwnedFile(file, this.dataDirectory)));
      throw safeError(error);
    }
  }

  /** Trusted server lifecycle cleanup; never accepts ownership from caller metadata. */
  async cleanupMaterialized(files = []) {
    let removed = 0;
    for (const candidate of Array.isArray(files) ? files : []) {
      if (typeof candidate?.path !== 'string') continue;
      const owned = this.materialized.get(candidate.path);
      if (!owned) continue;
      this.materialized.delete(candidate.path);
      if (await removeOwnedFile(owned, this.dataDirectory)) removed++;
    }
    return removed;
  }

  async publish({ sessionId, cwd, filePath, name, authorize = () => {} } = {}) {
    let source;
    let output;
    let temporary;
    let snapshot;
    let committed = false;
    try {
      authorize();
      await this.assertStorage();
      if (typeof sessionId !== 'string' || !sessionId || !this.store.db.prepare('SELECT id FROM session_meta WHERE id=?').get(sessionId)) throw new HttpError(404, '群聊不存在。');
      if (typeof cwd !== 'string' || !cwd || !path.isAbsolute(cwd) || typeof filePath !== 'string' || !filePath.trim() || filePath.includes('\0')) throw new HttpError(400, '工作目录或文件路径无效。');
      const root = await fs.realpath(cwd);
      if (!(await fs.stat(root)).isDirectory()) throw new HttpError(400, '工作目录无效。');
      if (within(root, this.dataDirectory) || within(this.dataDirectory, root)) throw new HttpError(403, '工作目录须与服务数据目录分开。');
      const requested = path.resolve(root, filePath);
      if (!within(root, requested)) throw new HttpError(403, '只能发布工作目录内的文件。');
      const real = await fs.realpath(requested);
      if (!within(root, real) || within(this.dataDirectory, real)) throw new HttpError(403, '已拒绝发布工作目录之外的链接目标。');
      const before = await fs.stat(real);
      if (!before.isFile()) throw new HttpError(400, '只能发布普通文件。');
      if (before.nlink > 1) throw new HttpError(403, '不能发布硬链接文件。');
      if (before.size > ATTACHMENT_MAX_BYTES) throw new HttpError(413, '附件不能超过 50 MiB。');
      source = await fs.open(real, fsSync.constants.O_RDONLY | (fsSync.constants.O_NOFOLLOW || 0));
      const opened = await source.stat();
      const openedReal = await fs.realpath(requested);
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || openedReal !== real || !within(root, openedReal) || opened.nlink > 1) throw new HttpError(409, '文件已变化，请重新发布。');
      const id = randomUUID();
      temporary = path.join(this.directory, `${id}.${randomUUID()}.tmp`);
      snapshot = path.join(this.directory, `${id}.bin`);
      output = await fs.open(temporary, 'wx', 0o600);
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let bytes = 0;
      let signature = Buffer.alloc(0);
      while (true) {
        const { bytesRead } = await source.read(buffer, 0, buffer.length, bytes);
        if (!bytesRead) break;
        if (bytes + bytesRead > ATTACHMENT_MAX_BYTES) throw new HttpError(413, '附件不能超过 50 MiB。');
        if (!bytes) signature = Buffer.from(buffer.subarray(0, Math.min(32, bytesRead)));
        let written = 0;
        while (written < bytesRead) {
          const result = await output.write(buffer, written, bytesRead - written, bytes + written);
          if (!result.bytesWritten) throw new Error('Snapshot write did not progress');
          written += result.bytesWritten;
        }
        bytes += bytesRead;
      }
      const after = await source.stat();
      if (bytes !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw new HttpError(409, '文件在发布期间被修改，请重新发布。');
      await output.sync();
      await output.close(); output = undefined;
      await source.close(); source = undefined;
      const mimeType = mediaType(signature);
      const row = { id, session_id: sessionId, name: safeName(name, path.basename(real)), size: bytes, mime_type: mimeType, kind: mimeType.startsWith('image/') ? 'image' : 'file' };
      await this.assertStorage();
      await fs.rename(temporary, snapshot);
      temporary = undefined;
      authorize();
      this.store.db.prepare('INSERT INTO attachments(id,session_id,name,size,mime_type,kind,created_at) VALUES (?,?,?,?,?,?,?)')
        .run(id, sessionId, row.name, row.size, row.mime_type, row.kind, new Date().toISOString());
      committed = true;
      return this.metadata(row);
    } catch (error) {
      throw safeError(error);
    } finally {
      if (source || output) await Promise.allSettled([source?.close(), output?.close()]);
      if (!committed) await Promise.allSettled([temporary && fs.rm(temporary, { force: true }), snapshot && fs.rm(snapshot, { force: true })]);
    }
  }

  async serve(req, res, { sessionId, id, authorize = () => {} }) {
    let handle;
    try {
      authorize();
      const metadata = this.get(id, sessionId);
      if (!['GET', 'HEAD'].includes(req.method)) { res.setHeader('Allow', 'GET, HEAD'); throw new HttpError(405, '附件只支持 GET 或 HEAD。'); }
      await this.assertStorage();
      const file = path.join(this.directory, `${metadata.id}.bin`);
      const real = await fs.realpath(file);
      if (!within(this.directory, real) || real !== file) throw new HttpError(404, '附件不存在。');
      handle = await fs.open(file, fsSync.constants.O_RDONLY | (fsSync.constants.O_NOFOLLOW || 0));
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== metadata.size || stat.nlink > 1) throw new HttpError(404, '附件不存在。');
      const download = new URL(req.url || metadata.url, 'http://localhost').searchParams.get('download') === '1';
      authorize();
      res.writeHead(200, {
        'Content-Type': metadata.kind === 'image' ? metadata.mimeType : 'application/octet-stream',
        'Content-Length': metadata.size,
        'Content-Disposition': disposition(metadata.name, metadata.kind === 'image' && !download),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Content-Security-Policy': "default-src 'none'; sandbox; frame-ancestors 'none'",
      });
      if (req.method === 'HEAD') { res.end(); return; }
      await pipeline(handle.createReadStream({ autoClose: false }), res);
    } catch (error) {
      if (!res.destroyed) throw safeError(error);
    } finally { await handle?.close(); }
  }
}
