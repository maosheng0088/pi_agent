import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CloudCredentialVault } from '../lib/cloud-document-credentials.mjs';
import { CloudDocumentService } from '../lib/cloud-documents.mjs';
import { HttpError } from '../lib/security.mjs';
import { Store } from '../lib/store.mjs';
import { SkillCatalog } from '../lib/skills.mjs';
import { packageCloudDocumentSkills } from '../scripts/package-cloud-document-skills.mjs';

const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const readTool = { name: 'general.read', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }, annotations: { readOnlyHint: true } };
const editTool = { ...readTool, name: 'general.edit', annotations: { readOnlyHint: false } };
const call = { provider: 'tencent', action: 'call', params: { tool: readTool.name, arguments: { id: 'fixture-file' } } };

function fixture(t, options = {}) {
  const record = { id: 'fixture-skill', name: 'tencent-docs', enabled: true, scope: 'groups', groupIds: ['group-a'] };
  let credentials = { token: 'ONLY_FIXTURE_TOKEN_2317' }, generation = 1, catalogCalls = 0, toolCalls = 0;
  const vault = { get: () => credentials && { ...credentials }, version: () => generation, knownSecrets: () => ['ONLY_FIXTURE_TOKEN_2317'] };
  const skills = { list: () => [record], isAvailable: (_id, sessionId) => record.enabled && (record.scope === 'all' || record.groupIds.includes(sessionId)), assertAvailable(id, sessionId) { if (!this.isAvailable(id, sessionId)) throw new HttpError(403, 'scope revoked'); } };
  const adapter = {
    installed: async () => ({ installed: true }),
    listTools: async () => { catalogCalls++; return [readTool, editTool]; },
    callTool: async () => { toolCalls++; return { text: 'Cloud fixture result.' }; },
    checkConnection: async () => {},
  };
  const service = new CloudDocumentService({ vault, skills, adapters: { tencent: adapter, kdocs: adapter, wps365: adapter }, ...options });
  t.after(() => service.close());
  const context = { sessionId: 'group-a', mode: 'workspace', authorize: () => {} };
  return { service, adapter, record, context, vault, noCredentials: () => { credentials = null; }, rotate: () => { generation++; service.invalidate('tencent'); }, catalogCalls: () => catalogCalls, toolCalls: () => toolCalls };
}

async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-cloud-policy-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('pi-cloud-policy-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test('vault rechecks authority after the final asynchronous filesystem guard before committing', async t => {
  const directory = await temporary(t);
  // Test-only reversible codec; the production default remains Windows DPAPI.
  const vault = await CloudCredentialVault.open(directory, { codec: async (_operation, bytes) => Buffer.from(bytes).map(byte => byte ^ 0x67) });
  await vault.update('tencent', { token: 'ORIGINAL_FIXTURE_TOKEN_8913' });
  const originalDisk = await fs.readFile(vault.file), originalGuard = vault.guard.bind(vault); let checks = 0, revoked = false;
  vault.guard = async () => { await originalGuard(); if (++checks === 2) revoked = true; };
  await assert.rejects(vault.update('tencent', { token: 'REJECTED_FIXTURE_TOKEN_5742' }, { authorize: () => { if (revoked) throw new HttpError(403, 'admin revoked during filesystem guard'); } }), { status: 403 });
  assert.equal(vault.get('tencent').token, 'ORIGINAL_FIXTURE_TOKEN_8913'); assert.equal(vault.version('tencent'), 1);
  assert.deepEqual(await fs.readFile(vault.file), originalDisk);
  assert.deepEqual((await fs.readdir(directory)).filter(name => name.startsWith('.cloud-documents-')), []);
});

test('missing assignment, revoked actor or missing credentials cannot reach any provider adapter', async t => {
  const f = fixture(t);
  await assert.rejects(f.service.execute(call, { ...f.context, sessionId: 'group-b' }), { status: 403 });
  await assert.rejects(f.service.execute(call, { ...f.context, authorize: () => { throw new HttpError(403, 'actor revoked'); } }), { status: 403 });
  f.noCredentials(); await assert.rejects(f.service.execute(call, f.context), { status: 409 });
  assert.equal(f.catalogCalls(), 0); assert.equal(f.toolCalls(), 0);
});

test('oversized, cyclic, deeply nested and non-JSON arguments are rejected before discovery or remote calls', async t => {
  const f = fixture(t), cycle = {}; cycle.self = cycle;
  let nested = { value: 'fixture' }; for (let depth = 0; depth < 20; depth++) nested = { child: nested };
  const invalid = [{ text: '中'.repeat(50000) }, cycle, nested, { value: Infinity }, { value: NaN }, { value: undefined }, { value: new Date() }, JSON.parse('{"constructor":"blocked"}')];
  for (const args of invalid) await assert.rejects(f.service.execute({ ...call, params: { tool: readTool.name, arguments: args } }, f.context), error => error.status >= 400 && error.status < 500);
  assert.equal(f.catalogCalls(), 0); assert.equal(f.toolCalls(), 0); assert.equal(f.service.operations.size, 0);
});

test('revocation while discovering a catalog prevents a later cloud business call and catalog publication', async t => {
  const entered = deferred(), release = deferred(), f = fixture(t); let calls = 0;
  f.adapter.listTools = async () => { entered.resolve(); await release.promise; return [readTool]; };
  f.adapter.callTool = async () => { calls++; return { text: 'Must not be returned.' }; };
  const pending = f.service.execute(call, f.context); await entered.promise;
  f.record.enabled = false; const rejected = assert.rejects(pending, { status: 403 }); release.resolve(); await rejected;
  assert.equal(calls, 0); assert.equal(f.service.catalogs.size, 0); assert.equal(f.service.operations.size, 0);
});

test('cached discovery still checks fresh scope and only explicitly read-only tools run in read-only mode', async t => {
  const f = fixture(t);
  await f.service.execute({ provider: 'tencent', action: 'list_tools' }, f.context); assert.equal(f.catalogCalls(), 1);
  await assert.rejects(f.service.execute({ ...call, params: { tool: editTool.name, arguments: { id: 'x' } } }, { ...f.context, mode: 'read-only' }), { status: 403 });
  f.adapter.listTools = async () => [{ ...readTool, name: 'general.unclassified', annotations: undefined }];
  f.rotate(); await assert.rejects(f.service.execute({ ...call, params: { tool: 'general.unclassified', arguments: { id: 'x' } } }, { ...f.context, mode: 'read-only' }), { status: 403 });
  f.record.scope = 'groups'; f.record.groupIds = ['group-b'];
  await assert.rejects(f.service.execute({ provider: 'tencent', action: 'list_tools' }, f.context), { status: 403 });
  assert.equal(f.toolCalls(), 0);
});

test('scope revocation before an adapter response resolves prevents returning its business contents', async t => {
  const entered = deferred(), release = deferred(), f = fixture(t);
  f.adapter.callTool = async () => { entered.resolve(); await release.promise; return { private: 'MUST_NOT_LEAVE_THIS_OPERATION' }; };
  const pending = f.service.execute(call, f.context); await entered.promise;
  f.record.groupIds = []; const rejected = assert.rejects(pending, { status: 403 }); release.resolve(); await rejected;
  assert.equal(f.service.operations.size, 0);
});

test('per-provider concurrency is bounded and closing the service cancels outstanding adapter work', { timeout: 5000 }, async t => {
  const f = fixture(t), entered = deferred(); let started = 0;
  f.adapter.callTool = async (_name, _args, _credentials, { signal }) => {
    if (++started === 3) entered.resolve();
    await new Promise((_, reject) => { if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
  };
  const requests = Array.from({ length: 3 }, () => f.service.execute(call, f.context));
  const assertions = requests.map(request => assert.rejects(request, { status: 409 }));
  await entered.promise; await assert.rejects(f.service.execute(call, f.context), { status: 429 });
  f.service.close(); await Promise.all(assertions);
  assert.equal(f.service.operations.size, 0); await assert.rejects(f.service.execute(call, f.context), { status: 503 });
});

test('operation timeout propagates abort to adapters and releases its operation slot', { timeout: 5000 }, async t => {
  const f = fixture(t, { operationTimeout: 20 }); let aborted = false;
  f.adapter.callTool = async (_name, _args, _credentials, { signal }) => new Promise((_, reject) => {
    const stop = () => { aborted = true; reject(signal.reason); };
    if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
  });
  await assert.rejects(f.service.execute(call, f.context), { status: 409 });
  assert.equal(aborted, true); assert.equal(f.service.operations.size, 0);
});

test('failed or invalid catalog discovery is not cached and can recover on the next request', async t => {
  const f = fixture(t); let calls = 0;
  f.adapter.listTools = async () => { calls++; return calls === 1 ? [readTool, readTool] : [readTool]; };
  await assert.rejects(f.service.execute({ provider: 'tencent', action: 'list_tools' }, f.context), { status: 502 });
  assert.equal(f.service.catalogs.size, 0);
  const result = await f.service.execute({ provider: 'tencent', action: 'list_tools' }, f.context);
  assert.equal(result.tools.length, 1); assert.equal(calls, 2);
});

test('a catalog-only Tencent check cannot be reported as verified document authorization', async t => {
  const f = fixture(t);
  f.adapter.checkConnection = async () => ({ verification: 'service_only', toolCount: 2, message: 'Tool endpoint reachable.' });
  const result = await f.service.check('tencent', () => {});
  assert.notEqual(result.status, 'ready'); assert.match(result.message, /尚未验证|以实际读取为准/);
  assert.doesNotMatch(result.message, /授权检测通过/);
});

async function installing(t) {
  const directory = await temporary(t), store = new Store(path.join(directory, 'data'), directory), skills = new SkillCatalog(store);
  const manifest = await packageCloudDocumentSkills({ outputDir: path.join(directory, 'packages') });
  const adapter = { installed: async () => ({ installed: true }) }, vault = { get: () => null, version: () => 0, knownSecrets: () => [] };
  const service = new CloudDocumentService({ vault, skills, adapters: { tencent: adapter }, packageSkills: async () => manifest });
  return { store, skills, service, manifest, close: () => { service.close(); store.close(); } };
}

test('repair refuses unrelated same-name skills and leaves their body and scope intact', async t => {
  const f = await installing(t);
  try {
    const manual = await f.skills.create({ name: 'tencent-docs', description: 'Administrator-owned skill', content: 'Manual business rules', enabled: true, scope: 'groups', groupIds: ['manual-group'] });
    await assert.rejects(f.service.installSkills('tencent'), { status: 409 });
    const after = f.skills.get(manual.id); assert.equal(after.content, 'Manual business rules'); assert.equal(after.version, manual.version);
    assert.equal(after.enabled, true); assert.deepEqual(after.groupIds, ['manual-group']);
  } finally { f.close(); }
});

test('repair cannot overwrite a concurrent administrator scope or enable-state change during ZIP import', async t => {
  const f = await installing(t);
  try {
    const bundle = f.manifest.packages.find(item => item.provider === 'tencent');
    const original = await f.skills.importZip({ zipBase64: (await fs.readFile(bundle.zipPath)).toString('base64'), enabled: true, scope: 'groups', groupIds: ['original-group'] });
    const realImport = f.skills.importZip.bind(f.skills), entered = deferred(), release = deferred();
    f.skills.importZip = async (...args) => { entered.resolve(); await release.promise; return realImport(...args); };
    const pending = f.service.installSkills('tencent'); await entered.promise;
    await f.skills.update(original.id, { enabled: false, scope: 'groups', groupIds: ['new-admin-choice'] });
    const rejected = assert.rejects(pending, { status: 409 }); release.resolve(); await rejected;
    const preserved = f.skills.get(original.id); assert.equal(preserved.enabled, false); assert.deepEqual(preserved.groupIds, ['new-admin-choice']);
  } finally { f.close(); }
});
