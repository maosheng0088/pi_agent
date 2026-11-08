import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { MailboxImageCache, mailboxImageHtmlHash } from '../lib/mailbox-image-cache.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1sAAAAASUVORK5CYII=', 'base64');
const html = '<p>Body</p><img src="cid:logo"><img src="cid:other">';
const scope = { accountId: 'mail-one', archiveVersion: 1, folder: 'INBOX', uidValidity: '11', uid: '8' };
const picture = (cid, content = png) => ({ cid, mimeType: 'image/png', data: content.toString('base64') });
const externalUrl = 'https://cdn.example.test/logo.png?version=1';

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE mailbox_messages(account_id TEXT,account_version INTEGER,path TEXT,uid_validity TEXT,uid INTEGER,
      PRIMARY KEY(account_id,account_version,path,uid_validity,uid));
    CREATE TABLE mailbox_rich_bodies(account_id TEXT,account_version INTEGER,path TEXT,uid_validity TEXT,uid INTEGER,html TEXT,
      PRIMARY KEY(account_id,account_version,path,uid_validity,uid),
      FOREIGN KEY(account_id,account_version,path,uid_validity,uid) REFERENCES mailbox_messages(account_id,account_version,path,uid_validity,uid) ON DELETE CASCADE);`);
  const cache = new MailboxImageCache({ db });
  t.after(() => db.close());
  const key = value => [value.accountId, value.archiveVersion, value.folder, value.uidValidity, Number(value.uid)];
  const seed = (value = scope, source = html) => {
    db.prepare('INSERT INTO mailbox_messages VALUES (?,?,?,?,?)').run(...key(value));
    db.prepare('INSERT INTO mailbox_rich_bodies VALUES (?,?,?,?,?,?)').run(...key(value), source);
  };
  const count = table => db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
  return { db, cache, seed, key, count };
}

test('inline image attempts merge cached CIDs, remain incomplete until all referenced bytes exist, and deduplicate content', t => {
  const { cache, db, seed, count } = fixture(t); seed();
  assert.equal(cache.readInline(scope, html), null);
  assert.equal(cache.prepareInline(scope, html), false);
  assert.equal(db.prepare('SELECT failures,next_attempt_at FROM mailbox_inline_image_state').get().failures, 0);

  const partial = cache.storeInline(scope, html, { images: [picture('LOGO')], truncated: false });
  assert.equal(partial.truncated, true);
  assert.deepEqual(partial.images, [picture('logo')]);
  assert.equal(cache.isInlineReady(scope, html), false);
  const failed = cache.recordInlineFailure(scope, html);
  assert.deepEqual(failed.images, [picture('logo')]);
  const state = db.prepare('SELECT * FROM mailbox_inline_image_state').get();
  assert.equal(state.failures, 2); assert.ok(state.next_attempt_at > Date.now());

  const complete = cache.storeInline(scope, html, { images: [picture('<other>')], truncated: true });
  assert.equal(complete.truncated, undefined);
  assert.equal(complete.images.length, 2);
  assert.equal(cache.isInlineReady(scope, html), true);
  assert.equal(count('mailbox_image_blobs'), 1);
  assert.equal(db.prepare('SELECT failures,next_attempt_at FROM mailbox_inline_image_state').get().failures, 0);
  assert.equal(db.prepare('SELECT failures,next_attempt_at FROM mailbox_inline_image_state').get().next_attempt_at, 0);
});

test('known no-CID HTML has a complete empty state, invalid or unreferenced bytes cannot complete an image archive', t => {
  const { cache, seed, count } = fixture(t); seed(scope, '<p>No picture</p>');
  assert.equal(cache.prepareInline(scope, '<p>No picture</p>'), true);
  assert.deepEqual(cache.readInline(scope, '<p>No picture</p>'), { images: [] });
  const other = { ...scope, uid: '9' }; seed(other, '<img src="cid:approved">');
  const result = cache.storeInline(other, '<img src="cid:approved">', { images: [
    picture('not-approved'), { cid: 'approved', mimeType: 'image/svg+xml', data: png.toString('base64') },
    { cid: 'approved', mimeType: 'image/png', data: 'invalid base64!' },
  ] });
  assert.deepEqual(result, { images: [], truncated: true });
  assert.equal(count('mailbox_image_blobs'), 0);
});

test('inline count, per-image bytes and total bytes stay bounded and cannot be hidden by a false truncated flag', t => {
  const { cache, seed } = fixture(t);
  const many = Array.from({ length: 9 }, (_, index) => `image-${index}`);
  const source = many.map(value => `<img src="cid:${value}">`).join(''); seed(scope, source);
  const result = cache.storeInline(scope, source, { images: many.map(value => picture(value)) });
  assert.equal(result.truncated, true); assert.equal(result.images.length, 8);

  const bytes = Buffer.alloc(1024 * 1024); png.copy(bytes);
  const largeScope = { ...scope, uid: '9' }, largeCids = many.slice(0, 5);
  const largeHtml = largeCids.map(value => `<img src="cid:${value}">`).join(''); seed(largeScope, largeHtml);
  const large = cache.storeInline(largeScope, largeHtml, { images: largeCids.map(value => picture(value, bytes)) });
  assert.equal(large.truncated, true); assert.equal(large.images.length, 4);
  const oversizedScope = { ...scope, uid: '10' }, oneHtml = '<img src="cid:big">'; seed(oversizedScope, oneHtml);
  assert.deepEqual(cache.storeInline(oversizedScope, oneHtml, { images: [picture('big', Buffer.concat([bytes, Buffer.from([0])]))] }), { images: [], truncated: true });
});

test('a changed HTML hash invalidates state and rejects a late result without replacing the current image bytes', t => {
  const { cache, db, seed, key, count } = fixture(t); seed();
  cache.storeInline(scope, html, { images: [picture('logo'), picture('other')] });
  const changed = '<p>Expanded body</p><img src="cid:new">';
  db.prepare('UPDATE mailbox_rich_bodies SET html=? WHERE account_id=? AND account_version=? AND path=? AND uid_validity=? AND uid=?').run(changed, ...key(scope));
  assert.equal(cache.storeInline(scope, html, { images: [picture('logo')] }), null);
  assert.equal(cache.readInline(scope, html), null);
  assert.equal(cache.isInlineReady(scope, html), false);
  assert.equal(cache.readInline(scope, changed), null);
  assert.equal(cache.prepareInline(scope, changed), false);
  assert.equal(count('mailbox_image_blobs'), 0);
  assert.equal(db.prepare('SELECT html_hash FROM mailbox_inline_image_state').get().html_hash, mailboxImageHtmlHash(changed));
  assert.equal(cache.readInline({ ...scope, archiveVersion: 2 }, changed), null);
  assert.equal(cache.readInline({ ...scope, uidValidity: '12' }, changed), null);
  cache.storeInline(scope, changed, { images: [picture('new')] });
  assert.equal(cache.isInlineReady(scope, changed), true);
});

test('image cache participates in an outer SQLite transaction and failed references leave no orphan bytes', t => {
  const { cache, db, seed, count } = fixture(t); seed();
  db.exec('BEGIN');
  cache.storeInline(scope, html, { images: [picture('logo'), picture('other')] });
  assert.equal(cache.isInlineReady(scope, html), true);
  db.exec('ROLLBACK');
  assert.equal(count('mailbox_inline_image_state'), 0);
  assert.equal(count('mailbox_image_blobs'), 0);
  assert.throws(() => cache.storeExternal({ ...scope, uid: '99' }, externalUrl, { content: png, mimeType: 'image/png' }), /FOREIGN KEY/);
  assert.equal(count('mailbox_image_blobs'), 0);
});

test('external cache is message-scoped, shares content bytes and cascaded removal reclaims the last reference', t => {
  const { cache, db, seed, key, count } = fixture(t); seed();
  const other = { ...scope, accountId: 'mail-two' }; seed(other);
  cache.storeInline(scope, html, { images: [picture('logo'), picture('other')] });
  cache.storeInline(other, html, { images: [picture('logo'), picture('other')] });
  assert.equal(cache.readExternal(scope, externalUrl), null);
  const image = cache.storeExternal(scope, externalUrl, { content: png, mimeType: 'image/png' });
  assert.deepEqual(image, { content: png, mimeType: 'image/png' });
  assert.equal(cache.readExternal(other, externalUrl), null);
  assert.equal(cache.readExternal(scope, `${externalUrl}&different=1`), null);
  assert.equal(count('mailbox_image_blobs'), 1);
  assert.throws(() => cache.storeExternal(scope, 'http://cdn.example.test/image.png', { content: png, mimeType: 'image/png' }), error => error.status === 400);
  assert.throws(() => cache.storeExternal(scope, externalUrl, { content: png, mimeType: 'text/html' }), error => error.status === 415);
  db.prepare('DELETE FROM mailbox_messages WHERE account_id=? AND account_version=? AND path=? AND uid_validity=? AND uid=?').run(...key(scope));
  assert.equal(count('mailbox_external_image_cache'), 0); assert.equal(count('mailbox_image_blobs'), 1);
  db.prepare('DELETE FROM mailbox_messages WHERE account_id=? AND account_version=? AND path=? AND uid_validity=? AND uid=?').run(...key(other));
  assert.equal(count('mailbox_inline_images'), 0); assert.equal(count('mailbox_inline_image_state'), 0); assert.equal(count('mailbox_image_blobs'), 0);
});
