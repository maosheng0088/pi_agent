import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { executeEmailAction } from '../lib/email-skill.mjs';
import { Store } from '../lib/store.mjs';
import { AttachmentService } from '../lib/attachments.mjs';
import { HttpError } from '../lib/security.mjs';

const accountId = '00000000-0000-4000-8000-000000000001';
const draftId = '00000000-0000-4000-8000-000000000002';
const context = extra => ({ actor: { id: 'current-employee', role: 'member' }, sessionId: 'current-group', mode: 'workspace', authorize() {}, ...extra });

test('mail tool cannot replace captured actor, group, mode or endpoint through action parameters', async () => {
  let calls = 0, received;
  const service = { async prepareDraft(id, params, actor) { calls++; received = actor; assert.equal(id, accountId); return { id: draftId }; } };
  const current = context();
  await executeEmailAction(service, { action: 'prepare_draft', accountId, params: { to: ['x@example.test'], text: 'draft', subject: 'subject' } }, current);
  assert.equal(received, current); assert.equal(received.actor.id, 'current-employee'); assert.equal(received.sessionId, 'current-group');
  for (const injected of [{ actor: { id: 'admin' } }, { sessionId: 'another-group' }, { mode: 'workspace' }, { host: 'attacker.example.test' }]) {
    await assert.rejects(executeEmailAction(service, { action: 'prepare_draft', accountId, params: {}, ...injected }, current), { status: 400 });
  }
  assert.equal(calls, 1);
});

test('mail reads and attachment publication require UIDVALIDITY, and readonly tool cannot send', async () => {
  const calls = [];
  const service = { readMessage() { calls.push('read'); return {}; }, downloadAttachment() { calls.push('attachment'); return {}; }, sendDraft() { calls.push('send'); return {}; } };
  await assert.rejects(executeEmailAction(service, { action: 'read', accountId, params: { uid: 10 } }, context()), { status: 400 });
  await assert.rejects(executeEmailAction(service, { action: 'download_attachment', accountId, params: { uid: 10, part: '2' } }, context(), { publishAttachment() {} }), { status: 400 });
  await assert.rejects(executeEmailAction(service, { action: 'send_draft', draftId, params: { idempotencyKey: 'do-not-send' } }, context({ mode: 'read-only' })), { status: 403 });
  assert.deepEqual(calls, []);
});

test('revocation after attachment download prevents publication and exposes no bytes', async () => {
  let allowed = true, published = false;
  const current = context({ authorize() { if (!allowed) throw Object.assign(new Error('revoked'), { status: 403 }); } });
  const service = { async downloadAttachment() { allowed = false; return { name: 'private.pdf', content: Buffer.from('private-mail-data') }; } };
  await assert.rejects(executeEmailAction(service, { action: 'download_attachment', accountId, params: { uid: 10, uidValidity: '123', part: '2' } }, current,
    { publishAttachment() { published = true; } }), { status: 403 });
  assert.equal(published, false);
});

test('publication authorization rechecks email account scope before committing the group attachment', async () => {
  let scopeAllowed = true, committed = false;
  const service = { async downloadAttachment() { return { name: 'booking.pdf', content: Buffer.from('fixture') }; }, access() { if (!scopeAllowed) throw Object.assign(new Error('scope revoked'), { status: 403 }); } };
  await assert.rejects(executeEmailAction(service, { action: 'download_attachment', accountId, params: { uid: 10, uidValidity: '123', part: '2' } }, context(), {
    async publishAttachment(_file, authorize) { scopeAllowed = false; authorize(); committed = true; },
  }), { status: 403 });
  assert.equal(committed, false);
});

async function fileFixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-email-policy-'));
  const data = path.join(temporary, 'data'), workspace = path.join(temporary, 'workspace');
  await fs.mkdir(data); await fs.mkdir(workspace);
  const store = new Store(data, workspace);
  for (const id of ['one', 'two']) store.db.prepare('INSERT INTO session_meta VALUES (?,?)').run(id, JSON.stringify({ id }));
  const attachments = new AttachmentService(store);
  t.after(async () => {
    t.mock.restoreAll(); store.close();
    const resolved = path.resolve(temporary);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir())); assert.ok(path.basename(resolved).startsWith('pi-email-policy-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return { attachments };
}

test('attachment byte bridge checks actual group and per-call remaining byte budget', async t => {
  const { attachments } = await fileFixture(t);
  const item = await attachments.upload({ sessionId: 'one', name: 'small.csv', stream: Readable.from([Buffer.from('abcdef')]) });
  await assert.rejects(attachments.readBytes({ sessionId: 'two', id: item.id }), { status: 404 });
  await assert.rejects(attachments.readBytes({ sessionId: 'one', id: item.id, maxBytes: 5 }), { status: 413 });
  assert.equal((await attachments.readBytes({ sessionId: 'one', id: item.id, maxBytes: 6 })).content.toString(), 'abcdef');
  let checks = 0;
  await assert.rejects(attachments.readBytes({ sessionId: 'one', id: item.id, authorize() { if (++checks === 4) throw new HttpError(403, 'revoked'); } }), { status: 403 });
});

test('attachment byte bridge refuses an inode replacement between path validation and open', async t => {
  const { attachments } = await fileFixture(t);
  const one = await attachments.upload({ sessionId: 'one', name: 'one.txt', stream: Readable.from([Buffer.from('group-ONE')]) });
  const two = await attachments.upload({ sessionId: 'two', name: 'two.txt', stream: Readable.from([Buffer.from('group-TWO')]) });
  const target = path.join(attachments.directory, `${one.id}.bin`), other = path.join(attachments.directory, `${two.id}.bin`), realOpen = fs.open;
  let replaced = false;
  t.mock.method(fs, 'open', async (file, ...args) => {
    if (file === target && !replaced) {
      replaced = true;
      await fs.rename(target, `${target}.original`);
      await fs.rename(other, target);
    }
    return realOpen(file, ...args);
  });
  await assert.rejects(attachments.readBytes({ sessionId: 'one', id: one.id }), error => [403, 404, 409].includes(error.status));
  assert.equal(replaced, true);
});
