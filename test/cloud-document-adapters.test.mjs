import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { createCloudDocumentAdapters, TENCENT_DOCUMENT_ENDPOINTS } from '../lib/cloud-document-adapters.mjs';
import { cloudDocumentPaths } from '../lib/cloud-document-binaries.mjs';

const directories = [];
afterEach(async () => { for (const directory of directories.splice(0)) {
  assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('pi-cloud-adapters-'));
  await fs.rm(directory, { recursive: true, force: true });
} });
const actualPaths = cloudDocumentPaths();
const { AjvJsonSchemaValidator: Validator } = await import(pathToFileURL(path.join(actualPaths.tencent.sdkRoot, 'node_modules/@modelcontextprotocol/sdk/dist/esm/validation/ajv-provider.js')).href);
const inputSchema = { type: 'object', properties: { query: { type: 'string' }, data: { type: 'object' }, url: { type: 'string' }, token_type: { type: 'string' } }, additionalProperties: true };
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-cloud-adapters-')); directories.push(directory);
  const dataDir = path.join(directory, 'data'); await fs.mkdir(dataDir);
  const paths = { ...actualPaths, kdocs: { executable: path.join(directory, 'kdocs.exe') }, wps365: { executable: path.join(directory, 'wps365.exe') } };
  await fs.writeFile(paths.kdocs.executable, 'fixture, never executed'); await fs.writeFile(paths.wps365.executable, 'fixture, never executed');
  const state = { connections: [], calls: [], processes: [], closed: 0, toolResponse: { content: [{ type: 'text', text: '{"code":0,"data":{"items":[]}}' }] },
    cliResponse: { code: 0, data: { items: [] } }, tools: [{ name: 'read_cloud', description: 'Read fixture', inputSchema, annotations: { readOnlyHint: true } }] };
  class HttpTransport { constructor(url, options) { this.url = url; this.options = options; } }
  class StdioTransport { constructor(options) { this.options = options; this.stderr = { resume() {} }; } }
  class Client {
    async connect(transport) { this.transport = transport; state.connections.push(transport); if (state.connectError) throw state.connectError; }
    async listTools() { return { tools: state.tools }; }
    async callTool(params, _schema, options) { state.calls.push({ params, options, transport: this.transport }); if (state.callError) throw state.callError; return state.toolResponse; }
    async close() { state.closed++; }
  }
  const adapters = createCloudDocumentAdapters({ dataDir, paths }, { loadSdk: async () => ({ Client, HttpTransport, StdioTransport, Validator }),
    runProcess: async (command, args, options) => { state.processes.push({ command, args, options }); if (state.processError) throw state.processError; return JSON.stringify(state.cliResponse); } });
  return { directory, dataDir, paths, state, adapters };
}

test('installed checks are local and do not imply configured or authenticated providers', async () => {
  const f = await fixture();
  for (const adapter of Object.values(f.adapters)) assert.equal((await adapter.installed()).installed, true);
  assert.equal(f.state.connections.length, 0); assert.equal(f.state.processes.length, 0);
  await assert.rejects(f.adapters.kdocs.checkConnection({}), { code: 'credentials_required' });
  assert.equal(f.state.processes.length, 0);
});

test('Tencent uses four fixed HTTPS endpoints and exact raw Authorization, excluding auth and telemetry tools', async () => {
  const f = await fixture();
  f.state.tools.push({ name: 'feedback', inputSchema }, { name: 'auth_login', inputSchema });
  const tools = await f.adapters.tencent.listTools({ token: 'fixture-token-123456' });
  assert.deepEqual(tools.map(value => value.name), ['general.read_cloud', 'word.read_cloud', 'sheet.read_cloud', 'slides.read_cloud']);
  assert.deepEqual(f.state.connections.map(value => value.url.href).sort(), Object.values(TENCENT_DOCUMENT_ENDPOINTS).sort());
  for (const transport of f.state.connections) assert.equal(transport.options.requestInit.headers.Authorization, 'fixture-token-123456');
  assert.equal(tools[0].inputSchema.additionalProperties, false); assert.ok(!('token_type' in tools[0].inputSchema.properties));
  assert.equal(f.state.closed, 4);
});

test('Tencent schema discovery alone is service-only; authentication requires a verified account read', async () => {
  const f = await fixture(), credentials = { token: 'fixture-token-verification' };
  assert.equal((await f.adapters.tencent.checkConnection(credentials)).verification, 'service_only');
  assert.equal(f.state.calls.length, 0);
  f.state.tools.push({ name: 'manage.folder_list', inputSchema: { type: 'object', properties: { folder_id: { type: 'string' }, start: { type: 'integer' } } } });
  f.state.toolResponse = { content: [{ type: 'text', text: '{"list":[],"finish":true}' }] };
  const verified = await f.adapters.tencent.checkConnection(credentials);
  assert.equal(verified.verification, 'authenticated');
  assert.equal(f.state.calls[0].params.name, 'manage.folder_list'); assert.deepEqual(f.state.calls[0].params.arguments, {});
  const catalog = await f.adapters.tencent.listTools(credentials);
  assert.equal(catalog.find(tool => tool.name === 'general.manage.folder_list').annotations.readOnlyHint, true);
  f.state.toolResponse = { isError: true, content: [{ type: 'text', text: 'not authorized' }] };
  await assert.rejects(f.adapters.tencent.checkConnection(credentials), { code: 'provider_error' });
});

test('Tencent validates unknown, credential, path and URL arguments before invoking a tool', async () => {
  const f = await fixture(), credentials = { token: 'fixture-token-123456' };
  for (const args of [{ unknown: true }, { token_type: 'app' }, { data: { authorization: 'override' } }, { query: 'D:\\private\\file.txt' }, { query: '../private' }, { url: 'http://127.0.0.1/private' }, { url: 'https://untrusted.example/doc' }]) {
    await assert.rejects(f.adapters.tencent.callTool('general.read_cloud', args, credentials), { code: 'invalid_arguments' });
  }
  assert.equal(f.state.calls.length, 0);
  await assert.rejects(f.adapters.tencent.callTool('other.read_cloud', {}, credentials), { code: 'tool_not_allowed' });
  await assert.rejects(f.adapters.tencent.callTool('general.feedback', {}, credentials), { code: 'tool_not_allowed' });
  const result = await f.adapters.tencent.callTool('sheet.read_cloud', { query: 'Shipment', url: 'https://docs.qq.com/sheet/example' }, credentials);
  assert.ok(result.content.length); assert.equal(f.state.calls.length, 1); assert.equal(f.state.calls[0].params.name, 'read_cloud');
});

test('adapter errors are fixed messages and results redact credential echoes', async () => {
  const f = await fixture(), token = 'fixture-secret-never-display';
  f.state.toolResponse = { content: [{ type: 'text', text: `upstream echoed ${token}` }] };
  const result = await f.adapters.tencent.callTool('general.read_cloud', {}, { token });
  assert.ok(!JSON.stringify(result).includes(token)); assert.match(result.content[0].text, /REDACTED/);
  f.state.callError = new Error(`private error ${token}`);
  await assert.rejects(f.adapters.tencent.callTool('general.read_cloud', {}, { token }), error => error.code === 'provider_error' && !error.message.includes(token));
});

test('WPS365 stdio is app-only, private, domain-limited and removes token override arguments', async () => {
  const f = await fixture();
  f.state.tools = [{ name: 'drive_list', inputSchema }, { name: 'drive_file_create', inputSchema }, { name: 'im_message_send', inputSchema }, { name: 'auth_token', inputSchema }];
  const credentials = { clientId: 'fixture-client-id', clientSecret: 'fixture-client-secret' };
  const tools = await f.adapters.wps365.listTools(credentials);
  assert.deepEqual(tools.map(value => value.name), ['drive_list', 'drive_file_create']);
  assert.equal(tools[0].annotations.readOnlyHint, true); assert.equal(tools[1].annotations.readOnlyHint, false);
  const config = f.state.connections[0].options;
  assert.equal(config.command, f.paths.wps365.executable); assert.deepEqual(config.args, ['mcp', 'serve', '--domains', 'drive,airpage,airsheet,dbsheet']);
  assert.equal(config.env.WPS365_AUTH, 'app'); assert.equal(config.env.WPS365_CLIENT_SECRET, credentials.clientSecret);
  assert.equal(config.env.WPS365_CONFIG_DIR, path.join(f.dataDir, 'cloud-documents/wps365'));
  assert.ok(!config.args.some(value => value.includes(credentials.clientSecret))); assert.equal(config.stderr, 'pipe');
  assert.ok(!('KINGSOFT_DOCS_TOKEN' in config.env));
  await assert.rejects(f.adapters.wps365.callTool('drive_list', { token_type: 'delegated' }, credentials), { code: 'invalid_arguments' });
  await assert.rejects(f.adapters.wps365.callTool('im_message_send', {}, credentials), { code: 'tool_not_allowed' });
});

test('Kdocs uses a controlled catalog, env credentials, structured stdin and no shell or arbitrary tool', async () => {
  const f = await fixture(), credentials = { token: 'fixture-secret-never-argv' };
  const tools = await f.adapters.kdocs.listTools(credentials);
  assert.ok(tools.some(value => value.name === 'sheet.get_range_data')); assert.ok(tools.some(value => value.name === 'sheet.range_data_batch_update' && value.annotations.readOnlyHint === false));
  await f.adapters.kdocs.callTool('search_files', { keyword: '客户', page_size: 1 }, credentials);
  const process = f.state.processes[0];
  assert.deepEqual(process.args, ['call', 'search_files', '--output', 'json', '--timeout', '30000']);
  assert.deepEqual(JSON.parse(process.options.input), { keyword: '客户', page_size: 1 });
  assert.equal(process.options.env.KINGSOFT_DOCS_TOKEN, credentials.token); assert.ok(!JSON.stringify(process.args).includes(credentials.token));
  await assert.rejects(f.adapters.kdocs.callTool('auth login', {}, credentials), { code: 'tool_not_allowed' });
  await assert.rejects(f.adapters.kdocs.callTool('read_file', { file_id: 'known', url: 'https://www.kdocs.cn/l/same' }, credentials), { code: 'invalid_arguments' });
  await assert.rejects(f.adapters.kdocs.callTool('sheet.get_range_data', { file_id: 'known', worksheet_id: 1, range: { rowFrom: 0 } }, credentials), { code: 'invalid_arguments' });
  await assert.rejects(f.adapters.kdocs.callTool('search_files', { keyword: 'x', page_size: 1, endpoint: 'http://localhost' }, credentials), { code: 'invalid_arguments' });
  assert.equal(f.state.processes.length, 1);
});

test('Kdocs creation and smart document edits use validated actual CLI schemas', async () => {
  const f = await fixture(), credentials = { token: 'fixture-token-creation' };
  await f.adapters.kdocs.callTool('create_file_with_content', { name: '周报', file_extension: 'otl', content: '# 结果\n已完成' }, credentials);
  await f.adapters.kdocs.callTool('otl.insert_content', { file_id: 'known-id', content: '追加结果', format: 'markdown', mode: 'append' }, credentials);
  assert.equal(f.state.processes.length, 2);
  await assert.rejects(f.adapters.kdocs.callTool('create_file_with_content', { name: '周报', file_extension: 'otl' }, credentials), { code: 'invalid_arguments' });
  await assert.rejects(f.adapters.kdocs.callTool('otl.insert_content', { file_id: 'known-id', content: 'x', format: 'html', mode: 'append' }, credentials), { code: 'invalid_arguments' });
});

test('connection checks require positive business success and never expose file metadata', async () => {
  const f = await fixture(), credentials = { token: 'fixture-token-check' };
  const success = await f.adapters.kdocs.checkConnection(credentials);
  assert.ok(success.message); assert.deepEqual(Object.keys(success), ['message']);
  for (const response of [{}, { code: 401, message: 'unauthorized' }, { code: 0, data: { result: 'error', message: 'nested failure' } },
    { isError: true, content: [{ type: 'text', text: 'failed' }] }, { jsonrpc: '2.0', error: { code: -32000, message: 'failed' } }]) {
    f.state.cliResponse = response;
    await assert.rejects(f.adapters.kdocs.checkConnection(credentials), { code: 'provider_error' });
  }
  f.state.cliResponse = { code: 0, data: { items: [{ name: 'private-file-name' }] } };
  assert.ok(!JSON.stringify(await f.adapters.kdocs.checkConnection(credentials)).includes('private-file-name'));
});

test('WPS connection performs a read-only app drive call and rejects business failure', async () => {
  const f = await fixture();
  f.state.tools = [{ name: 'drive_list', inputSchema: { type: 'object', properties: { 'allotee-type': { type: 'string' }, 'page-size': { type: 'integer' } } } }];
  const credentials = { clientId: 'fixture-client-id', clientSecret: 'fixture-client-secret' };
  assert.ok((await f.adapters.wps365.checkConnection(credentials)).message);
  assert.deepEqual(f.state.calls[0].params, { name: 'drive_list', arguments: { 'allotee-type': 'app', 'page-size': 1 } });
  f.state.toolResponse = { isError: true, content: [{ type: 'text', text: 'forbidden' }] };
  await assert.rejects(f.adapters.wps365.checkConnection(credentials), { code: 'provider_error' });
});

test('guard revocation prevents invocation and already aborted calls never spawn', async () => {
  const f = await fixture(); let guards = 0;
  await assert.rejects(f.adapters.kdocs.callTool('list_my_files', {}, { token: 'fixture-token-guard' }, {
    guard() { if (++guards === 2) throw new Error('Permission revoked'); },
  }));
  assert.equal(f.state.processes.length, 0);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.adapters.kdocs.callTool('list_my_files', {}, { token: 'fixture-token-guard' }, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(f.state.processes.length, 0);
});

test('input and output limits fail with safe actionable messages', async () => {
  const f = await fixture(), credentials = { token: 'fixture-token-limit' };
  await assert.rejects(f.adapters.kdocs.callTool('search_files', { keyword: 'x'.repeat(150_000), page_size: 1 }, credentials), { code: 'output_limit' });
  f.state.cliResponse = { code: 0, data: 'x'.repeat(2 * 1024 * 1024) };
  await assert.rejects(f.adapters.kdocs.callTool('list_my_files', {}, credentials), { code: 'output_limit' });
});
