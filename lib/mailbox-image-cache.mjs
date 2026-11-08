import { createHash } from 'node:crypto';
import { matchesRaster, referencedImageCids } from './email-adapter.mjs';
import { HttpError } from './security.mjs';

const inlineCount = 8;
const inlineBytes = 1024 * 1024;
const inlineTotalBytes = 4 * 1024 * 1024;
const externalBytes = 4 * 1024 * 1024;
const htmlBytes = 1024 * 1024;
let savepointSequence = 0;

const digest = value => createHash('sha256').update(value).digest('hex');
export const mailboxImageHtmlHash = html => digest(html);

function scopeKey(scope) {
  const { accountId, archiveVersion, folder } = scope || {};
  const uidValidity = String(scope?.uidValidity ?? ''), uid = String(scope?.uid ?? '');
  if (typeof accountId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(accountId)
    || !Number.isSafeInteger(archiveVersion) || archiveVersion < 1
    || typeof folder !== 'string' || !folder || folder.length > 1000 || /[\x00-\x1f\x7f]/.test(folder)
    || !/^[1-9]\d{0,9}$/.test(uidValidity) || Number(uidValidity) > 0xffffffff
    || !/^[1-9]\d{0,9}$/.test(uid) || Number(uid) > 0xffffffff) throw new HttpError(400, '邮件图片引用无效。');
  return [accountId, archiveVersion, folder, uidValidity, Number(uid)];
}

function cid(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim().replace(/^<([^<>]+)>$/, '$1').toLowerCase();
  return normalized.length <= 255 && /^[^\s<>"'\\\x00-\x1f\x7f]+$/.test(normalized) ? normalized : '';
}

function expectedCids(html) {
  if (typeof html !== 'string' || Buffer.byteLength(html) > htmlBytes) throw new HttpError(400, '邮件图片正文无效。');
  return [...referencedImageCids(html)];
}

function inlineImage(value) {
  if (typeof value?.data !== 'string' || !value.data || value.data.length % 4
    || value.data.length > Math.ceil(inlineBytes / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.data)) return null;
  const content = Buffer.from(value.data, 'base64');
  if (!content.length || content.length > inlineBytes || content.toString('base64') !== value.data
    || !matchesRaster(content, value.mimeType)) return null;
  return { content, mimeType: value.mimeType };
}

function externalUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) throw new HttpError(400, '邮件外链图片地址无效。');
  let url;
  try { url = new URL(value); } catch { throw new HttpError(400, '邮件外链图片地址无效。'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    throw new HttpError(400, '邮件外链图片地址无效。');
  }
  return url.href;
}

/** Image bytes remain scoped by message while identical content is stored only once. */
export class MailboxImageCache {
  constructor(store, { retryBaseMs = 60_000 } = {}) {
    this.db = store.db;
    this.retryBaseMs = Math.max(10, Math.min(60 * 60_000, retryBaseMs));
    this.db.exec(`CREATE TABLE IF NOT EXISTS mailbox_image_blobs (
      sha256 TEXT PRIMARY KEY,mime_type TEXT NOT NULL,size INTEGER NOT NULL,content BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS mailbox_inline_images (
      account_id TEXT NOT NULL,account_version INTEGER NOT NULL,path TEXT NOT NULL,uid_validity TEXT NOT NULL,uid INTEGER NOT NULL,
      cid TEXT NOT NULL,sha256 TEXT NOT NULL REFERENCES mailbox_image_blobs(sha256),
      PRIMARY KEY(account_id,account_version,path,uid_validity,uid,cid),
      FOREIGN KEY(account_id,account_version,path,uid_validity,uid) REFERENCES mailbox_messages(account_id,account_version,path,uid_validity,uid) ON DELETE CASCADE);
      CREATE INDEX IF NOT EXISTS mailbox_inline_images_blob ON mailbox_inline_images(sha256);
      CREATE TABLE IF NOT EXISTS mailbox_inline_image_state (
      account_id TEXT NOT NULL,account_version INTEGER NOT NULL,path TEXT NOT NULL,uid_validity TEXT NOT NULL,uid INTEGER NOT NULL,
      html_hash TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('ready','partial')),failures INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(account_id,account_version,path,uid_validity,uid),
      FOREIGN KEY(account_id,account_version,path,uid_validity,uid) REFERENCES mailbox_messages(account_id,account_version,path,uid_validity,uid) ON DELETE CASCADE);
      CREATE INDEX IF NOT EXISTS mailbox_inline_image_due ON mailbox_inline_image_state(account_id,account_version,status,next_attempt_at);
      CREATE TABLE IF NOT EXISTS mailbox_external_image_cache (
      account_id TEXT NOT NULL,account_version INTEGER NOT NULL,path TEXT NOT NULL,uid_validity TEXT NOT NULL,uid INTEGER NOT NULL,
      url TEXT NOT NULL,sha256 TEXT NOT NULL REFERENCES mailbox_image_blobs(sha256),
      PRIMARY KEY(account_id,account_version,path,uid_validity,uid,url),
      FOREIGN KEY(account_id,account_version,path,uid_validity,uid) REFERENCES mailbox_messages(account_id,account_version,path,uid_validity,uid) ON DELETE CASCADE);
      CREATE INDEX IF NOT EXISTS mailbox_external_images_blob ON mailbox_external_image_cache(sha256);`);
    // Cascaded message removal and content replacement also reclaim unreferenced bytes.
    for (const table of ['mailbox_inline_images', 'mailbox_external_image_cache']) {
      const reclaim = `DELETE FROM mailbox_image_blobs WHERE sha256=OLD.sha256
        AND NOT EXISTS (SELECT 1 FROM mailbox_inline_images WHERE sha256=OLD.sha256)
        AND NOT EXISTS (SELECT 1 FROM mailbox_external_image_cache WHERE sha256=OLD.sha256);`;
      this.db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_delete_blob AFTER DELETE ON ${table} BEGIN ${reclaim} END;
        CREATE TRIGGER IF NOT EXISTS ${table}_replace_blob AFTER UPDATE OF sha256 ON ${table}
        WHEN OLD.sha256<>NEW.sha256 BEGIN ${reclaim} END;`);
    }
  }

  transaction(write) {
    const savepoint = `mailbox_image_cache_${++savepointSequence}`;
    this.db.exec(`SAVEPOINT ${savepoint}`);
    try {
      const result = write();
      this.db.exec(`RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      this.db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      throw error;
    }
  }

  currentHtml(key, html) {
    return Boolean(this.db.prepare(`SELECT 1 FROM mailbox_rich_bodies
      WHERE account_id=? AND account_version=? AND path=? AND uid_validity=? AND uid=? AND html=?`).get(...key, html));
  }

  inlineRows(key) {
    return this.db.prepare(`SELECT i.cid,b.mime_type,b.size,b.content FROM mailbox_inline_images i
      JOIN mailbox_image_blobs b ON b.sha256=i.sha256
      WHERE i.account_id=? AND i.account_version=? AND i.path=? AND i.uid_validity=? AND i.uid=?`).all(...key);
  }

  inlineMetadata(key) {
    return this.db.prepare(`SELECT i.cid,b.size FROM mailbox_inline_images i JOIN mailbox_image_blobs b ON b.sha256=i.sha256
      WHERE i.account_id=? AND i.account_version=? AND i.path=? AND i.uid_validity=? AND i.uid=?`).all(...key);
  }

  state(key) {
    return this.db.prepare(`SELECT html_hash,status,failures,next_attempt_at FROM mailbox_inline_image_state
      WHERE account_id=? AND account_version=? AND path=? AND uid_validity=? AND uid=?`).get(...key);
  }

  complete(references, rows) {
    if (references.length > inlineCount || rows.length !== references.length) return false;
    const cached = new Map(rows.map(row => [row.cid, row.size]));
    return references.every(value => cached.has(value)) && rows.reduce((total, row) => total + row.size, 0) <= inlineTotalBytes;
  }

  prepareInline(scope, html) {
    const key = scopeKey(scope), references = expectedCids(html), htmlHash = mailboxImageHtmlHash(html);
    return this.transaction(() => {
      if (!this.currentHtml(key, html)) return false;
      const previous = this.state(key);
      if (previous?.html_hash === htmlHash) return this.isInlineReady(scope, html);
      const wanted = new Set(references);
      for (const row of this.inlineMetadata(key)) if (!wanted.has(row.cid)) {
        this.db.prepare(`DELETE FROM mailbox_inline_images
          WHERE account_id=? AND account_version=? AND path=? AND uid_validity=? AND uid=? AND cid=?`).run(...key, row.cid);
      }
      const ready = this.complete(references, this.inlineMetadata(key));
      this.db.prepare(`INSERT INTO mailbox_inline_image_state(account_id,account_version,path,uid_validity,uid,html_hash,status)
        VALUES (?,?,?,?,?,?,?) ON CONFLICT(account_id,account_version,path,uid_validity,uid) DO UPDATE SET
        html_hash=excluded.html_hash,status=excluded.status,failures=0,next_attempt_at=0`)
        .run(...key, htmlHash, ready ? 'ready' : 'partial');
      return ready;
    });
  }

  isInlineReady(scope, html) {
    const key = scopeKey(scope), references = expectedCids(html), state = this.state(key);
    return this.currentHtml(key, html) && state?.html_hash === mailboxImageHtmlHash(html) && state.status === 'ready'
      && this.complete(references, this.inlineMetadata(key));
  }

  readInline(scope, html) {
    const key = scopeKey(scope), references = expectedCids(html), state = this.state(key);
    if (!this.currentHtml(key, html) || !state || state.html_hash !== mailboxImageHtmlHash(html)) return null;
    const wanted = new Set(references);
    const rows = this.inlineRows(key).filter(row => wanted.has(row.cid));
    const images = rows.map(row => ({ cid: row.cid, mimeType: row.mime_type, data: Buffer.from(row.content).toString('base64') }));
    return { images, ...(this.complete(references, rows) ? {} : { truncated: true }) };
  }

  storeBlob(image) {
    const hash = digest(image.content);
    this.db.prepare('INSERT OR IGNORE INTO mailbox_image_blobs(sha256,mime_type,size,content) VALUES (?,?,?,?)')
      .run(hash, image.mimeType, image.content.length, image.content);
    return hash;
  }

  storeInline(scope, html, result) {
    const key = scopeKey(scope), references = expectedCids(html), wanted = new Set(references);
    return this.transaction(() => {
      if (!this.currentHtml(key, html)) return null;
      this.prepareInline(scope, html);
      const candidates = new Map(this.inlineRows(key).map(row => [row.cid, { content: Buffer.from(row.content), mimeType: row.mime_type }]));
      for (const value of Array.isArray(result?.images) ? result.images.slice(0, inlineCount) : []) {
        const contentId = cid(value?.cid);
        if (!wanted.has(contentId)) continue;
        const image = inlineImage(value);
        if (image) candidates.set(contentId, image);
      }
      let total = 0;
      const selected = new Map();
      for (const contentId of references.slice(0, inlineCount)) {
        const image = candidates.get(contentId);
        if (!image || total + image.content.length > inlineTotalBytes) continue;
        total += image.content.length;
        selected.set(contentId, image);
      }
      for (const row of this.inlineMetadata(key)) if (!selected.has(row.cid)) {
        this.db.prepare(`DELETE FROM mailbox_inline_images
          WHERE account_id=? AND account_version=? AND path=? AND uid_validity=? AND uid=? AND cid=?`).run(...key, row.cid);
      }
      for (const [contentId, image] of selected) {
        const hash = this.storeBlob(image);
        this.db.prepare(`INSERT INTO mailbox_inline_images(account_id,account_version,path,uid_validity,uid,cid,sha256)
          VALUES (?,?,?,?,?,?,?) ON CONFLICT(account_id,account_version,path,uid_validity,uid,cid) DO UPDATE SET sha256=excluded.sha256`)
          .run(...key, contentId, hash);
      }
      const ready = this.complete(references, this.inlineMetadata(key));
      const previous = this.state(key), failures = ready ? 0 : Math.min(10, previous.failures + 1);
      const retryAt = ready ? 0 : Date.now() + Math.min(60 * 60_000, this.retryBaseMs * 2 ** failures);
      this.db.prepare(`UPDATE mailbox_inline_image_state SET status=?,failures=?,next_attempt_at=?
        WHERE account_id=? AND account_version=? AND path=? AND uid_validity=? AND uid=?`)
        .run(ready ? 'ready' : 'partial', failures, retryAt, ...key);
      return this.readInline(scope, html);
    });
  }

  recordInlineFailure(scope, html) {
    return this.storeInline(scope, html, { images: [] });
  }

  readExternal(scope, value) {
    const key = scopeKey(scope), url = externalUrl(value);
    const row = this.db.prepare(`SELECT b.mime_type,b.content FROM mailbox_external_image_cache e
      JOIN mailbox_image_blobs b ON b.sha256=e.sha256
      WHERE e.account_id=? AND e.account_version=? AND e.path=? AND e.uid_validity=? AND e.uid=? AND e.url=?`).get(...key, url);
    return row ? { content: Buffer.from(row.content), mimeType: row.mime_type } : null;
  }

  storeExternal(scope, value, image) {
    const key = scopeKey(scope), url = externalUrl(value);
    if (!Buffer.isBuffer(image?.content) || !image.content.length || image.content.length > externalBytes
      || !matchesRaster(image.content, image.mimeType)) throw new HttpError(415, '邮件图片内容无效。');
    return this.transaction(() => {
      const hash = this.storeBlob(image);
      this.db.prepare(`INSERT INTO mailbox_external_image_cache(account_id,account_version,path,uid_validity,uid,url,sha256)
        VALUES (?,?,?,?,?,?,?) ON CONFLICT(account_id,account_version,path,uid_validity,uid,url) DO UPDATE SET sha256=excluded.sha256`)
        .run(...key, url, hash);
      return this.readExternal(scope, url);
    });
  }
}
