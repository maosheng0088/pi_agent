import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DocumentContentService } from '../lib/document-content.mjs';
import { HttpError } from '../lib/security.mjs';

const group = 'group-documents';
const workspace = 'D:/fixture-workspace';
const ids = ['d0a1c111-1111-4111-8111-111111111111', 'd0a1c222-2222-4222-8222-222222222222', 'd0a1c333-3333-4333-8333-333333333333', 'd0a1c444-4444-4444-8444-444444444444'];
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const document = (text = 'A document with actual business records.', extra = {}) => ({ format: 'txt', status: 'ready', text, sections: [{ title: '正文', text }], warnings: [], truncated: false, ...extra });

function fixtures({ parser = async () => document(), ...options } = {}) {
  const gets = [], copies = [], cleanups = [], parses = [];
  const records = new Map(ids.map((id, index) => [id, { id, sessionId: group, name: `fixture-${index + 1}.txt`, mimeType: 'application/octet-stream', kind: 'file', size: 200 }]));
  const attachments = {
    get(id, sessionId) {
      gets.push({ id, sessionId });
      const record = records.get(id);
      if (!record || record.sessionId !== sessionId) throw new HttpError(404, '附件不存在。');
      return { ...record };
    },
    async materialize(args) {
      args.authorize();
      const result = args.attachmentIds.map(id => ({ ...records.get(id), path: `D:/private/attachment-inbox/${args.sessionId}/${args.taskId}/${id}/snapshot.txt` }));
      copies.push({ args, result });
      return result;
    },
    async cleanupMaterialized(value) { cleanups.push(value); },
  };
  const service = new DocumentContentService(attachments, { ...options, parser: async args => { parses.push(args); return parser(args); } });
  const read = (index = 0, args = {}) => service.read({ sessionId: group, id: ids[index], cwd: workspace, ...args });
  const forModel = (args = {}) => service.forModel({ sessionId: group, id: ids[0], cwd: workspace, ...args });
  return { service, attachments, records, gets, copies, cleanups, parses, read, forModel };
}

test('uses an authorized private snapshot and always cleans that exact copy after parsing', async () => {
  const f = fixtures(); let checks = 0;
  const result = await f.read(0, { authorize: () => checks++ });
  assert.equal(result.status, 'ready'); assert.ok(checks >= 3);
  assert.equal(f.copies.length, 1); assert.equal(f.parses.length, 1);
  const { args, result: copies } = f.copies[0];
  assert.equal(args.sessionId, group); assert.deepEqual(args.attachmentIds, [ids[0]]); assert.equal(args.cwd, workspace);
  assert.match(args.taskId, /^document-[a-f0-9-]{36}$/);
  assert.equal(f.parses[0].filePath, copies[0].path); assert.equal(f.parses[0].name, 'fixture-1.txt');
  assert.equal(f.parses[0].mimeType, 'application/octet-stream');
  assert.deepEqual(f.cleanups, [copies]);
  assert.doesNotMatch(JSON.stringify(result), /attachment-inbox|snapshot\.txt/);
});

test('parser exceptions clean copies, release capacity and do not cache a failed attempt', async () => {
  let calls = 0;
  const f = fixtures({ maxConcurrent: 1, parser: async () => { if (++calls === 1) throw new Error('temporary parser failure'); return document('Recovered document.'); } });
  await assert.rejects(f.read(), /temporary parser failure/);
  assert.equal(f.cleanups.length, 1);
  assert.equal((await f.read()).text, 'Recovered document.');
  assert.equal(f.parses.length, 2); assert.equal(f.cleanups.length, 2);
});

test('error results are retried while deterministic unsupported projections may be cached', async () => {
  const failing = fixtures({ parser: async () => document('', { status: 'error', warnings: ['Temporary parse failure.'] }) });
  assert.equal((await failing.read()).status, 'error'); assert.equal((await failing.read()).status, 'error');
  assert.equal(failing.parses.length, 2); assert.equal(failing.cleanups.length, 2);
  for (const status of ['unsupported', 'needs_ocr']) {
    const f = fixtures({ parser: async () => document('', { status, warnings: ['No extractable text.'] }) });
    await f.read(); await f.read();
    assert.equal(f.parses.length, 1, status); assert.equal(f.cleanups.length, 1, status);
  }
});

test('cache hits still authorize, validate current attachment ownership and return an independent value', async () => {
  const f = fixtures(); let revoked = false, checks = 0;
  const authorize = () => { checks++; if (revoked) throw new HttpError(403, 'membership revoked'); };
  const first = await f.read(0, { authorize }); first.text = 'Caller changed the result'; first.sections[0].text = 'Mutated';
  const cached = await f.read(0, { authorize });
  assert.notEqual(cached.text, first.text); assert.notEqual(cached.sections[0].text, first.sections[0].text);
  assert.equal(f.parses.length, 1); assert.ok(checks > 3);
  revoked = true; const previousGets = f.gets.length;
  await assert.rejects(f.read(0, { authorize }), { status: 403 });
  assert.equal(f.gets.length, previousGets, 'Revoked actors must be rejected before attachment lookup');
  revoked = false; f.records.get(ids[0]).sessionId = 'another-group';
  await assert.rejects(f.read(0, { authorize }), { status: 404 });
  assert.equal(f.parses.length, 1);
});

test('revocation while parsing prevents cached/output publication and still cleans snapshots', async () => {
  const entered = deferred(), release = deferred(); let revoked = false;
  const f = fixtures({ parser: async () => { entered.resolve(); await release.promise; return document('Private result.'); } });
  const authorize = () => { if (revoked) throw new HttpError(403, 'membership revoked'); };
  const pending = f.read(0, { authorize });
  await entered.promise; revoked = true;
  const rejected = assert.rejects(pending, { status: 403 }); release.resolve(); await rejected;
  assert.equal(f.cleanups.length, 1);
  revoked = false; await f.read(0, { authorize });
  assert.equal(f.parses.length, 2, 'Unauthorized completed parse must not enter the cache');
});

test('revocation after materialization skips parser execution and cleans the obtained copy', async () => {
  const f = fixtures(); let revoked = false;
  const original = f.attachments.materialize;
  f.attachments.materialize = async args => { const copies = await original(args); revoked = true; return copies; };
  await assert.rejects(f.read(0, { authorize: () => { if (revoked) throw new HttpError(403, 'revoked after copy'); } }), { status: 403 });
  assert.equal(f.parses.length, 0); assert.equal(f.cleanups.length, 1);
});

test('cache entry count follows recent access rather than insertion order', async () => {
  const f = fixtures({ maxEntries: 2 });
  await f.read(0); await f.read(1); await f.read(0); await f.read(2); await f.read(0);
  assert.equal(f.parses.length, 3, 'Recently read A must remain cached when C arrives');
  await f.read(1);
  assert.equal(f.parses.length, 4, 'B must be reparsed after LRU eviction');
  assert.equal(f.cleanups.length, 4);
});

test('cache byte budget evicts old documents and never retains an oversized projection', async () => {
  const value = document('X'.repeat(300)), size = Buffer.byteLength(JSON.stringify(value));
  const f = fixtures({ maxEntries: 20, maxBytes: size * 2, parser: async () => value });
  await f.read(0); await f.read(1); await f.read(0); await f.read(2); await f.read(0);
  assert.equal(f.parses.length, 3); await f.read(1); assert.equal(f.parses.length, 4);
  const oversized = fixtures({ maxBytes: size - 1, parser: async () => value });
  await oversized.read(); await oversized.read();
  assert.equal(oversized.parses.length, 2); assert.equal(oversized.cleanups.length, 2);
});

test('concurrent parses of the same attachment do not double count cache size or evict useful content', async () => {
  const entered = deferred(), release = deferred(), value = document('Shared projection '.repeat(20)); let sameFileCalls = 0;
  const size = Buffer.byteLength(JSON.stringify(value));
  const f = fixtures({ maxBytes: size * 2, parser: async ({ name }) => {
    if (name === 'fixture-1.txt' && ++sameFileCalls <= 2) { if (sameFileCalls === 2) entered.resolve(); await release.promise; }
    return value;
  } });
  const one = f.read(0), two = f.read(0);
  await entered.promise; release.resolve(); await Promise.all([one, two]);
  await f.read(1); await f.read(0);
  assert.equal(sameFileCalls, 2, 'A and B together fit the budget even when A was concurrently parsed twice');
  assert.equal(f.parses.length, 3); assert.equal(f.cleanups.length, 3);
});

test('at most three parser operations run at once and abort releases a slot without caching', { timeout: 10000 }, async () => {
  const entered = deferred(), waits = new Map(); let enteredCount = 0;
  const f = fixtures({ parser: async ({ name, signal }) => {
    const wait = deferred(); waits.set(name, wait);
    const abort = () => wait.reject(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (++enteredCount === 3) entered.resolve();
    try { await wait.promise; return document(`Parsed ${name}`); }
    finally { signal?.removeEventListener('abort', abort); }
  } });
  const controllers = ids.map(() => new AbortController());
  const first = f.read(0, { signal: controllers[0].signal }), second = f.read(1, { signal: controllers[1].signal }), third = f.read(2, { signal: controllers[2].signal });
  await entered.promise;
  await assert.rejects(f.read(3), { status: 503 }); assert.equal(f.copies.length, 3);
  const aborted = assert.rejects(second, { name: 'AbortError' }); controllers[1].abort(); await aborted;
  assert.equal(f.cleanups.length, 1);
  const fourth = f.read(3, { signal: controllers[3].signal });
  // The materialize promise completes before the next microtask, then parsing starts.
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.parses.length, 4, 'The released slot must accept a new parse');
  for (const name of ['fixture-1.txt', 'fixture-3.txt', 'fixture-4.txt']) waits.get(name).resolve();
  await Promise.all([first, third, fourth]); assert.equal(f.cleanups.length, 4);
  const replay = f.read(1, { signal: controllers[0].signal }); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.parses.length, 5, 'Aborted file was never cached'); waits.get('fixture-2.txt').resolve(); await replay;
});

test('already aborted requests do not look up attachments or start a parser', async () => {
  const f = fixtures(), controller = new AbortController(); controller.abort();
  await assert.rejects(f.read(0, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(f.gets.length, 0); assert.equal(f.copies.length, 0); assert.equal(f.parses.length, 0);
});

test('model document pages follow nextOffset without losing text or exposing private file paths', async () => {
  const text = '0123456789'.repeat(3700), value = document(text, { format: 'pdf', pageCount: 3, sheets: [{ name: 'Sheet 1', rows: [['A', 'B'], ['1', '2']], truncated: false }] });
  const f = fixtures({ parser: async () => value }); let offset = 1, combined = '', pages = 0;
  do {
    const result = await f.forModel({ offset }), page = JSON.parse(result.content[0].text);
    assert.equal(page.offset, offset); assert.ok(page.text.length <= 16000);
    assert.equal(page.totalCharacters, text.length); assert.equal(page.pageCount, 3);
    assert.deepEqual(page.sheets, [{ name: 'Sheet 1', rows: 2, truncated: false }]);
    assert.equal(result.details.document.nextOffset, page.nextOffset);
    assert.doesNotMatch(JSON.stringify(result), /D:\/private|attachment-inbox|snapshot\.txt/);
    assert.equal(page.chunkTruncated, page.nextOffset !== null);
    combined += page.text; offset = page.nextOffset; pages++;
  } while (offset !== null);
  assert.equal(pages, 3); assert.equal(combined, text); assert.equal(f.parses.length, 1);
  const tiny = JSON.parse((await f.forModel({ offset: 100, limit: 7 })).content[0].text);
  assert.equal(tiny.text, text.slice(99, 106)); assert.equal(tiny.nextOffset, 107);
});

test('model range validation rejects oversized/invalid character or legacy line requests before reading', async () => {
  const f = fixtures();
  for (const range of [{ offset: 0 }, { offset: -1 }, { offset: 1.5 }, { offset: '1' }, { offset: Number.MAX_SAFE_INTEGER + 1 }, { limit: 0 }, { limit: 16001 }, { limit: 1.5 }, { lineOffset: 0 }, { lineOffset: -1 }, { lineLimit: 2001 }, { lineLimit: 0 }]) await assert.rejects(f.forModel(range), { status: 400 }, JSON.stringify(range));
  assert.equal(f.gets.length, 0); assert.equal(f.parses.length, 0);
});

test('model and legacy line reads authorize first, return correct ranges and keep source warnings', async () => {
  const f = fixtures({ parser: async () => document('one\ntwo\nthree\nfour', { warnings: ['Source may contain outdated data.'] }) });
  await assert.rejects(f.forModel({ authorize: () => { throw new HttpError(403, 'revoked'); } }), { status: 403 });
  assert.equal(f.gets.length, 0);
  const result = JSON.parse((await f.forModel({ lineOffset: 2, lineLimit: 2 })).content[0].text);
  assert.equal(result.text, 'two\nthree'); assert.equal(result.offset, 5); assert.equal(result.nextOffset, 14);
  assert.deepEqual(result.warnings, ['Source may contain outdated data.']); assert.match(result.guidance, /不是指令/);
  const unsupported = fixtures({ parser: async () => document('', { status: 'needs_ocr', warnings: ['Scanned PDF has no text layer.'] }) });
  const page = JSON.parse((await unsupported.forModel()).content[0].text);
  assert.equal(page.status, 'needs_ocr'); assert.match(page.guidance, /不要为此自动安装依赖/);
});
