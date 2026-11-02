import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { cloudDocumentPaths, CLOUD_DOCUMENT_VERSIONS, ensureVendorDirectory } from './cloud-document-binaries.mjs';

export const TENCENT_DOCUMENT_ENDPOINTS = Object.freeze({
  general: 'https://docs.qq.com/openapi/mcp', word: 'https://docs.qq.com/api/v6/doc/mcp',
  sheet: 'https://docs.qq.com/api/v6/sheet/mcp', slides: 'https://docs.qq.com/api/v6/slide/mcp',
});
const MAX_OUTPUT = 2 * 1024 * 1024, MAX_INPUT = 128 * 1024, TIMEOUT = 30_000;
const wpsReadOnlyTools = new Set(['drive_list', 'drive_get', 'drive_file_list', 'drive_file_get', 'drive_file_download', 'drive_file_content_get', 'drive_file_path_get', 'drive_file_search',
  'drive_recent_file_list', 'drive_starred_file_list', 'drive_frequent_file_list', 'drive_file_version_list', 'drive_file_version_get', 'drive_doclib_list', 'drive_doclib_get',
  'dbsheet_schema_get', 'dbsheet_record_list', 'dbsheet_record_page_list', 'dbsheet_record_get', 'dbsheet_record_search', 'airpage_get', 'airpage_block_get', 'airpage_export_get',
  'airsheet_worksheet_list', 'airsheet_data_get', 'airsheet_data_find']);
// Exact read operations checked against the retained official Skill references.
const tencentReadOnlyTools = new Set(['manage.folder_list', 'manage.query_folder_meta', 'manage.search_file', 'manage.query_file_info', 'manage.recent_online_file', 'manage.get_privilege', 'get_content',
  'doc.get_images', 'doc.get_last_operable_pos', 'doc.get_outline', 'doc.get_text_property', 'doc.get_paragraph_property', 'doc.get_comments', 'doc.get_table_info', 'doc.resolve_document_structure', 'doc.find',
  'sheet.get_cell_style', 'sheet.get_sheet_info', 'sheet.get_cell_data', 'sheet.find']);
const deniedTool = /(?:^|[._-])(?:auth|config|feedback|telemetry|report_unsupported_feature|check_skill_update|login|logout|token|execute|shell)(?:$|[._-])/i;
const unsafeKey = key => !/^(?:next[_-]?)?page[_-]?token$/i.test(key) && /(?:token|secret|password|cookie|authorization|endpoint|base[_-]?url|command|shell|(?:^|[_-])(?:local|path|filepath|filename)(?:$|[_-]))/i.test(key);
const object = (properties, required = [], extra = {}) => ({ type: 'object', properties, additionalProperties: false, ...(required.length ? { required } : {}), ...extra });
const string = (maxLength = 2000) => ({ type: 'string', maxLength });
const integer = (maximum = 1_000_000) => ({ type: 'integer', minimum: 0, maximum });
const locator = { file_id: string(), link_id: string(), url: { type: 'string', maxLength: 2000, pattern: '^https://(?:[A-Za-z0-9-]+\\.)*(?:kdocs\\.cn|wps\\.cn)/' } };
const oneLocator = { oneOf: ['file_id', 'link_id', 'url'].map(key => ({ required: [key], not: { anyOf: ['file_id', 'link_id', 'url'].filter(value => value !== key).map(value => ({ required: [value] })) } })) };
const rectangle = object({ rowFrom: integer(), rowTo: integer(), colFrom: integer(16383), colTo: integer(16383) }, ['rowFrom', 'rowTo', 'colFrom', 'colTo']);
const sheetRectangle = object({ row_from: integer(), row_to: integer(), col_from: integer(16383), col_to: integer(16383) }, ['row_from', 'row_to', 'col_from', 'col_to']);
const page = { page_size: { type: 'integer', minimum: 1, maximum: 100 }, page_token: string(4000) };
const kdocsTool = (name, description, inputSchema, readOnlyHint = true) => ({ name, description, inputSchema, annotations: { readOnlyHint, destructiveHint: !readOnlyHint } });
export const KDOCS_DOCUMENT_TOOLS = Object.freeze([
  kdocsTool('list_my_files', '列出个人云文档根目录，支持分页。', object({ ...page, order: { enum: ['asc', 'desc'] }, order_by: { enum: ['ctime', 'mtime', 'fname'] }, filter_exts: string(200), filter_type: { enum: ['file', 'folder', 'shortcut'] }, with_permission: { type: 'boolean' } })),
  kdocsTool('list_files', '列出指定云文件夹的直接子项。', object({ drive_id: string(), parent_id: string(), ...page }, ['drive_id', 'parent_id'])),
  kdocsTool('search_files', '按文件名或正文搜索个人云文档。', object({ keyword: string(1000), type: { enum: ['file_name', 'content', 'all'] }, ...page, file_type: { enum: ['file', 'folder'] }, file_exts: { type: 'array', items: string(20), maxItems: 20 }, parent_ids: { type: 'array', items: string(), maxItems: 20 } }, ['page_size'])),
  kdocsTool('read_file', '读取云文档正文；pending 时使用本次响应 task_id 继续读取，保留读取范围警告。', object({ ...locator, task_id: string(), format: { enum: ['markdown', 'plain', 'kdc'] }, enable_upload_medias: { type: 'boolean' }, sheet_name: string(200), sheet_id: { type: 'number' }, sheet_range: sheetRectangle }, [], oneLocator)),
  kdocsTool('sheet.get_sheets_info', '获取在线 Excel/智能表格的真实工作表 ID。', object(locator, [], oneLocator)),
  kdocsTool('sheet.get_range_data', '读取工作表矩形范围，行列均为零基。', object({ ...locator, worksheet_id: integer(), range: rectangle }, ['worksheet_id', 'range'], oneLocator)),
  kdocsTool('sheet.range_data_batch_update', '在明确授权后批量写入已核对的工作表单元格内容或公式。', object({ ...locator, worksheet_id: integer(), range_data: { type: 'array', minItems: 1, maxItems: 500,
    items: object({ ...sheetRectangle.properties, op_type: { const: 'cell_operation_type_formula' }, formula: string(50_000) }, [...sheetRectangle.required, 'op_type', 'formula']) } }, ['worksheet_id', 'range_data'], oneLocator), false),
  kdocsTool('create_file_with_content', '新建云文档并写入正文，或创建在线表格并写入二维数据。', object({ name: string(200), file_extension: { enum: ['otl', 'docx', 'md', 'pdf', 'xlsx', 'ksheet'] },
    content: string(100_000), sheet_name: string(100), drive_id: string(), parent_id: string(),
    rangeData: { type: 'array', minItems: 1, maxItems: 500, items: object({ ...sheetRectangle.properties,
      formula: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'array', minItems: 1, maxItems: 100, items: { type: ['string', 'number', 'boolean', 'null'] } } } }, [...sheetRectangle.required, 'formula']) } },
  ['name', 'file_extension'], { allOf: [{ if: { properties: { file_extension: { enum: ['otl', 'docx', 'md', 'pdf'] } } }, then: { required: ['content'] }, else: { required: ['rangeData'] } }] }), false),
  kdocsTool('otl.insert_content', '向已有智能文档追加、前置或替换 Markdown 正文，仅支持 .otl。', object({ ...locator, title: string(200), content: string(100_000),
    format: { const: 'markdown' }, mode: { enum: ['append', 'prepend', 'replace'] } }, ['content', 'format', 'mode'], oneLocator), false),
]);

export class CloudDocumentAdapterError extends Error {
  constructor(code, message, status = 502) { super(message); this.name = 'CloudDocumentAdapterError'; this.code = code; this.status = status; }
}
const fail = (code, message, status) => new CloudDocumentAdapterError(code, message, status);
const cancelled = () => new DOMException('云文档操作已取消。', 'AbortError');
function safeError(error, signal) {
  if (signal?.aborted) return signal.reason?.name === 'TimeoutError' ? fail('timeout', '云文档服务响应超时，请稍后重试。', 504) : cancelled();
  if (error instanceof CloudDocumentAdapterError) return error;
  if (error?.code === 401 || error?.status === 401) return fail('credentials_required', '云文档授权已失效，请管理员重新配置。', 401);
  if (error?.code === 403 || error?.status === 403) return fail('permission_denied', '云文档账号没有所需权限。', 403);
  return fail('provider_error', '云文档服务调用失败，请检查授权、权限或稍后重试。', 502);
}
function environment() {
  const env = {};
  for (const key of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES']) if (process.env[key]) env[key] = process.env[key];
  return env;
}
function token(credentials) {
  if (typeof credentials?.token !== 'string' || !credentials.token.trim() || credentials.token.length > 16_000 || /[\r\n\0]/.test(credentials.token)) throw fail('credentials_required', '请先由管理员配置云文档授权。', 401);
  return credentials.token;
}
function serialized(value, maximum = MAX_OUTPUT) {
  let encoded;
  try { encoded = JSON.stringify(value); } catch { throw fail('invalid_arguments', '云文档参数必须为普通 JSON。', 400); }
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > maximum) throw fail('output_limit', '云文档数据超过单次处理上限，请缩小查询范围。', 413);
  return encoded;
}
function validateValues(value, depth = 0) {
  if (depth > 16) throw fail('invalid_arguments', '云文档参数嵌套过深。', 400);
  if (typeof value === 'string') {
    if (/^(?:[a-z]:[\\/]|\.{1,2}[\\/]|[\\/]{1,2}|file:|~[\\/])/i.test(value)) throw fail('invalid_arguments', '云文档工具不接受本机文件路径。', 400);
    if (/^https?:\/\//i.test(value)) {
      let url; try { url = new URL(value); } catch { throw fail('invalid_arguments', '云文档链接无效。', 400); }
      if (url.protocol !== 'https:' || url.username || url.password || !/(?:^|\.)(?:docs\.qq\.com|kdocs\.cn|wps\.cn)$/.test(url.hostname)) throw fail('invalid_arguments', '仅允许目标云文档平台的 HTTPS 链接。', 400);
    }
  } else if (Array.isArray(value)) value.forEach(item => validateValues(item, depth + 1));
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (unsafeKey(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) throw fail('invalid_arguments', '云文档参数含有不允许的字段。', 400);
      validateValues(item, depth + 1);
    }
  }
}
function safeTool(tool, provider) {
  if (!tool || typeof tool.name !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(tool.name) || deniedTool.test(tool.name) || tool.inputSchema?.type !== 'object') return null;
  const inputSchema = JSON.parse(JSON.stringify(tool.inputSchema)); delete inputSchema.$id;
  inputSchema.additionalProperties = false;
  for (const key of Object.keys(inputSchema.properties || {})) if (unsafeKey(key)) {
    if (inputSchema.required?.includes(key)) return null;
    delete inputSchema.properties[key];
  }
  const readOnlyHint = tool.annotations?.readOnlyHint === true || provider === 'wps365' && wpsReadOnlyTools.has(tool.name) || provider === 'tencent' && tencentReadOnlyTools.has(tool.name);
  return { name: tool.name, description: String(tool.description || tool.name).slice(0, 4000), inputSchema,
    annotations: { ...tool.annotations, readOnlyHint } };
}
function redact(value, credentials) {
  let text = serialized(value);
  for (const secret of [credentials?.token, credentials?.clientSecret, credentials?.clientId]) if (typeof secret === 'string' && secret) {
    text = text.replaceAll(JSON.stringify(secret).slice(1, -1), '[REDACTED]');
  }
  return JSON.parse(text);
}
function mcpResult(value, credentials) {
  let result = value?.jsonrpc && value.result !== undefined ? value.result : value;
  if (result?.error) return { isError: true, content: [{ type: 'text', text: '云文档服务返回业务错误，请检查文档权限或参数。' }] };
  if (!Array.isArray(result?.content)) result = { content: [{ type: 'text', text: serialized(result) }] };
  let isError = result.isError === true;
  const candidates = [result.structuredContent, ...result.content.filter(value => value.type === 'text').map(value => { try { return JSON.parse(value.text); } catch { return null; } })];
  for (const candidate of [...candidates, ...candidates.filter(value => value && typeof value === 'object').flatMap(value => [value.data, value.detail])]) {
    if (candidate && typeof candidate === 'object' && (candidate.success === false || candidate.isError === true || candidate.error || candidate.code !== undefined && ![0, '0', 'ok', 'OK', 200, '200'].includes(candidate.code)
      || candidate.result !== undefined && typeof candidate.result === 'string' && !['ok', 'success'].includes(candidate.result.toLowerCase())
      || typeof candidate.status === 'string' && ['error', 'failed', 'unauthorized', 'forbidden'].includes(candidate.status.toLowerCase()))) isError = true;
  }
  return redact({ ...result, ...(isError ? { isError: true } : {}) }, credentials);
}
function confirmedRead(result) {
  const values = [result.structuredContent, ...result.content.filter(value => value.type === 'text').map(value => { try { return JSON.parse(value.text); } catch { return null; } })];
  return values.some(value => value && typeof value === 'object' && (value.success === true || value.result === 'ok' || value.result === 'success'
    || value.code !== undefined && [0, '0', 'ok', 'OK', 200, '200'].includes(value.code)
    || ['items', 'files', 'file', 'list', 'drives'].some(key => Array.isArray(value[key]) || Array.isArray(value.data?.[key])) || Array.isArray(value.data)));
}
function runProcess(command, args, { env, input, signal, cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', size = 0, failed;
    const abort = () => { failed ||= cancelled(); child.kill(); };
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { size += Buffer.byteLength(chunk); if (size > MAX_OUTPUT) { failed = fail('output_limit', '云文档结果过大，请缩小查询范围。', 413); child.kill(); } else stdout += chunk; });
    child.stderr.on('data', chunk => { size += chunk.length; if (size > MAX_OUTPUT) { failed = fail('output_limit', '云文档诊断输出超过上限。', 413); child.kill(); } });
    child.stdin.on('error', () => {}); child.stdin.end(input);
    child.once('error', () => { failed ||= fail('not_installed', '云文档本机工具无法启动。', 503); });
    child.once('close', code => {
      signal?.removeEventListener('abort', abort);
      if (failed) reject(failed); else if (code !== 0) reject(fail('provider_error', '云文档工具执行失败，请检查授权及参数。', 502)); else resolve(stdout);
    });
  });
}

export function createCloudDocumentAdapters({ root, dataDir, paths = cloudDocumentPaths(root) } = {}, dependencies = {}) {
  let sdkPromise;
  async function sdk() {
    if (dependencies.loadSdk) return dependencies.loadSdk();
    return sdkPromise ||= (async () => {
      const base = path.join(paths.tencent.sdkRoot, 'node_modules/@modelcontextprotocol/sdk/dist/esm');
      const [client, http, stdio, validator] = await Promise.all(['client/index.js', 'client/streamableHttp.js', 'client/stdio.js', 'validation/ajv-provider.js'].map(file => import(pathToFileURL(path.join(base, file)).href)));
      return { Client: client.Client, HttpTransport: http.StreamableHTTPClientTransport, StdioTransport: stdio.StdioClientTransport, Validator: validator.AjvJsonSchemaValidator };
    })();
  }
  async function installed(provider) {
    try {
      const packageFile = path.join(paths.tencent.sdkRoot, 'node_modules/@modelcontextprotocol/sdk/package.json');
      const metadata = JSON.parse(await fs.readFile(packageFile, 'utf8'));
      if (metadata.version !== CLOUD_DOCUMENT_VERSIONS.mcpSdk) return { installed: false };
      if (provider !== 'tencent') {
        const stat = await fs.lstat(paths[provider].executable); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return { installed: false };
      }
      return { installed: true, toolVersion: provider === 'tencent' ? metadata.version : CLOUD_DOCUMENT_VERSIONS[provider] };
    } catch { return { installed: false }; }
  }
  async function operation(options, action) {
    const signal = AbortSignal.any([...(options?.signal ? [options.signal] : []), AbortSignal.timeout(TIMEOUT)]);
    try { if (signal.aborted) throw signal.reason; options?.guard?.(); const value = await action(signal); options?.guard?.(); return value; }
    catch (error) { throw safeError(error, signal); }
  }
  async function validate(schema, args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw fail('invalid_arguments', '云文档参数必须为对象。', 400);
    serialized(args, MAX_INPUT); validateValues(args);
    const { Validator } = await sdk();
    try { if (!(new Validator().getValidator(schema)(args)).valid) throw new Error(); }
    catch { throw fail('invalid_arguments', '云文档参数不符合工具定义，请检查必填字段、类型和未知字段。', 400); }
  }
  async function connect(provider, credentials, domain, signal, action) {
    if (!(await installed(provider)).installed) throw fail('not_installed', '云文档本机工具尚未安装。', 503);
    const { Client, HttpTransport, StdioTransport } = await sdk();
    const client = new Client({ name: 'pi-web-cloud-documents', version: '1.0.0' }, { capabilities: {} });
    let transport;
    if (provider === 'tencent') {
      const value = token(credentials), endpoint = TENCENT_DOCUMENT_ENDPOINTS[domain];
      if (!endpoint) throw fail('tool_not_allowed', '此云文档工具不可用。', 400);
      const controlledFetch = async (url, init = {}) => {
        if (String(url) !== endpoint) throw fail('tool_not_allowed', '已拒绝云文档服务地址变更。', 403);
        const response = await fetch(url, { ...init, redirect: 'manual', signal, headers: { ...Object.fromEntries(new Headers(init.headers)), Authorization: value } });
        if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw fail('provider_error', '云文档服务发生了未允许的跳转。', 502); }
        if (!response.body) return response;
        let size = 0;
        const bounded = response.body.pipeThrough(new TransformStream({ transform(chunk, controller) {
          size += chunk.byteLength; if (size > MAX_OUTPUT) { controller.error(fail('output_limit', '云文档结果过大，请缩小查询范围。', 413)); return; } controller.enqueue(chunk);
        } }));
        return new Response(bounded, { status: response.status, statusText: response.statusText, headers: response.headers });
      };
      transport = new HttpTransport(new URL(endpoint), { requestInit: { headers: { Authorization: value } }, fetch: controlledFetch, reconnectionOptions: { maxRetries: 0 } });
    } else {
      if (typeof credentials?.clientId !== 'string' || !credentials.clientId.trim() || typeof credentials?.clientSecret !== 'string' || !credentials.clientSecret.trim()
        || credentials.clientId.length > 2000 || credentials.clientSecret.length > 16_000 || /[\r\n\0]/.test(credentials.clientId + credentials.clientSecret)) throw fail('credentials_required', '请先配置 WPS 365 应用 ID 与密钥。', 401);
      if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw fail('provider_error', '云文档私有配置目录无效。', 503);
      const config = await ensureVendorDirectory(dataDir, 'cloud-documents/wps365');
      transport = new StdioTransport({ command: paths.wps365.executable, args: ['mcp', 'serve', '--domains', 'drive,airpage,airsheet,dbsheet'], stderr: 'pipe', maxBufferSize: MAX_OUTPUT,
        env: { ...environment(), WPS365_CONFIG_DIR: config, WPS365_AUTH: 'app', WPS365_CLIENT_ID: credentials.clientId, WPS365_CLIENT_SECRET: credentials.clientSecret } });
      transport.stderr?.resume();
    }
    const abort = () => { client.close().catch(() => {}); }; signal.addEventListener('abort', abort, { once: true });
    try { await client.connect(transport, { signal, timeout: TIMEOUT }); return await action(client); }
    finally { signal.removeEventListener('abort', abort); await client.close().catch(() => {}); }
  }
  async function toolsFrom(client, signal, provider) {
    const tools = []; let cursor;
    for (let page = 0; page < 10; page++) {
      const response = await client.listTools(cursor ? { cursor } : {}, { signal, timeout: TIMEOUT });
      serialized(response); tools.push(...response.tools.map(tool => safeTool(tool, provider)).filter(Boolean));
      if (tools.length > 1200) throw fail('output_limit', '云文档工具目录超过处理上限。', 413);
      cursor = response.nextCursor; if (!cursor) return tools;
    }
    throw fail('output_limit', '云文档工具目录分页超过处理上限。', 413);
  }
  const tencent = {
    installed: () => installed('tencent'),
    listTools: (credentials, options) => operation(options, async signal => {
      token(credentials);
      const groups = await Promise.all(Object.keys(TENCENT_DOCUMENT_ENDPOINTS).map(domain => connect('tencent', credentials, domain, signal, async client =>
        (await toolsFrom(client, signal, 'tencent')).map(tool => ({ ...tool, name: `${domain}.${tool.name}` })))));
      return groups.flat();
    }),
    callTool: (name, args, credentials, options) => operation(options, async signal => {
      if (typeof name !== 'string') throw fail('tool_not_allowed', '此腾讯文档工具不可用。', 400);
      const split = name.indexOf('.'), domain = name.slice(0, split), toolName = name.slice(split + 1);
      if (split < 1 || !TENCENT_DOCUMENT_ENDPOINTS[domain] || deniedTool.test(toolName)) throw fail('tool_not_allowed', '此腾讯文档工具不可用。', 400);
      return connect('tencent', credentials, domain, signal, async client => {
        const tool = (await toolsFrom(client, signal, 'tencent')).find(value => value.name === toolName);
        if (!tool) throw fail('tool_not_allowed', '此腾讯文档工具不可用。', 400);
        await validate(tool.inputSchema, args); options?.guard?.();
        return mcpResult(await client.callTool({ name: toolName, arguments: args }, undefined, { signal, timeout: TIMEOUT }), credentials);
      });
    }),
  };
  const wps365 = {
    installed: () => installed('wps365'),
    listTools: (credentials, options) => operation(options, signal => connect('wps365', credentials, null, signal, async client =>
      (await toolsFrom(client, signal, 'wps365')).filter(tool => /^(drive|airpage|airsheet|dbsheet)_/.test(tool.name)))),
    callTool: (name, args, credentials, options) => operation(options, signal => connect('wps365', credentials, null, signal, async client => {
      if (!/^(drive|airpage|airsheet|dbsheet)_/.test(name) || deniedTool.test(name)) throw fail('tool_not_allowed', '此 WPS 365 工具不可用。', 400);
      const tool = (await toolsFrom(client, signal, 'wps365')).find(value => value.name === name);
      if (!tool) throw fail('tool_not_allowed', '此 WPS 365 工具不可用。', 400);
      await validate(tool.inputSchema, args); options?.guard?.();
      return mcpResult(await client.callTool({ name, arguments: args }, undefined, { signal, timeout: TIMEOUT }), credentials);
    })),
  };
  const kdocs = {
    installed: () => installed('kdocs'),
    listTools: (credentials, options) => operation(options, async () => { token(credentials); if (!(await installed('kdocs')).installed) throw fail('not_installed', '金山文档本机工具尚未安装。', 503); return structuredClone(KDOCS_DOCUMENT_TOOLS); }),
    callTool: (name, args, credentials, options) => operation(options, async signal => {
      const value = token(credentials), tool = KDOCS_DOCUMENT_TOOLS.find(tool => tool.name === name);
      if (!tool) throw fail('tool_not_allowed', '此金山文档工具不可用。', 400);
      if (!(await installed('kdocs')).installed) throw fail('not_installed', '金山文档本机工具尚未安装。', 503);
      await validate(tool.inputSchema, args); options?.guard?.();
      const stdout = await (dependencies.runProcess || runProcess)(paths.kdocs.executable, ['call', name, '--output', 'json', '--timeout', String(TIMEOUT)], {
        env: { ...environment(), KINGSOFT_DOCS_TOKEN: value }, input: JSON.stringify(args), signal,
      });
      let response; try { response = JSON.parse(stdout); } catch { throw fail('provider_error', '金山文档工具未返回有效结果。', 502); }
      return mcpResult(response, credentials);
    }),
  };
  async function checked(adapter, credentials, options, tool, args) {
    const result = await adapter.callTool(tool, args, credentials, options);
    if (result.isError || !confirmedRead(result)) throw fail('provider_error', '云文档授权或业务权限验证未通过，未获得明确成功结果。', 502);
    return { message: '已完成只读授权验证。' };
  }
  tencent.checkConnection = async (credentials, options) => {
    const tools = await tencent.listTools(credentials, options);
    const folders = tools.find(tool => tool.name === 'general.manage.folder_list');
    const recent = tools.find(tool => tool.name === 'general.manage.recent_online_file');
    if (!folders && !recent) return { verification: 'service_only', toolCount: tools.length, message: '工具服务连通，文档访问权限以实际读取为准。' };
    const tool = folders || recent;
    const args = folders ? {} : { num: tool.inputSchema.properties?.num?.type === 'string' ? '1' : 1,
      ...(tool.inputSchema.properties?.count ? { count: tool.inputSchema.properties.count.type === 'string' ? '1' : 1 } : {}) };
    await checked(tencent, credentials, options, tool.name, args);
    return { verification: 'authenticated', toolCount: tools.length, message: '腾讯文档只读访问验证通过。' };
  };
  kdocs.checkConnection = (credentials, options) => checked(kdocs, credentials, options, 'list_my_files', { page_size: 1 });
  wps365.checkConnection = (credentials, options) => checked(wps365, credentials, options, 'drive_list', { 'allotee-type': 'app', 'page-size': 1 });
  return { tencent, kdocs, wps365 };
}
