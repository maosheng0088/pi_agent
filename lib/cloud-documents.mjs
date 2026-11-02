import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { assertCloudProvider, CLOUD_PROVIDERS } from './cloud-document-credentials.mjs';
import { HttpError } from './security.mjs';

const DEFINITIONS = Object.freeze({
  tencent: { name: '腾讯文档', skillName: 'tencent-docs', url: 'https://docs.qq.com/open/document/mcp/get-token/', guidance: '在腾讯文档官方指引中选择已授权空间，获取 MCP Token，再回到本页保存并检测连接。官方目前要求超级会员或超级会员 Plus。' },
  kdocs: { name: '金山文档 · 个人版', skillName: 'kdocs', url: 'https://www.kdocs.cn/latest', guidance: '登录个人 WPS 账号，在金山文档主菜单打开“金山文档 Skill”，获取 Token 后回到本页保存并检测。企业账号请使用 WPS365。' },
  wps365: { name: 'WPS365 · 企业版', skillName: 'wps365', url: 'https://open.wps.cn/', guidance: '在 WPS 开放平台配置企业应用，并由企业管理员授予云文档 API 权限；将应用 ID、应用密钥填入本页后检测。本次接入采用应用身份。' },
});

export function validateCloudArguments(value) {
  const seen=new Set(),queue=[[value,0]];let nodes=0;
  while(queue.length) {
    const [item,depth]=queue.pop();
    if(++nodes>20000||depth>16)throw new HttpError(400,'云文档参数过多或嵌套过深。');
    if(item===null||typeof item==='string'||typeof item==='boolean'||typeof item==='number'&&Number.isFinite(item))continue;
    if(typeof item!=='object'||!Array.isArray(item)&&![Object.prototype,null].includes(Object.getPrototypeOf(item))||seen.has(item))throw new HttpError(400,'云文档参数必须为普通 JSON。');
    seen.add(item);
    for(const [key,child] of Object.entries(item)) {
      if(['__proto__','prototype','constructor'].includes(key))throw new HttpError(400,'云文档参数含有无效字段。');
      queue.push([child,depth+1]);
    }
  }
  if(Buffer.byteLength(JSON.stringify(value))>128*1024)throw new HttpError(413,'云文档参数超过单次处理上限，请缩小查询范围。');
}

export function safeCloudAuthorizationUrl(value) {
  try {
    if(typeof value!=='string'||value.length>4096||/[\x00-\x20\x7f\\]/.test(value))return null;
    const url = new URL(value);
    return url.protocol === 'https:' && !url.port && !url.username && !url.password && (['docs.qq.com', 'www.kdocs.cn', '365.kdocs.cn', 'account.wps.com'].includes(url.hostname) || url.hostname === 'wps.cn' || url.hostname.endsWith('.wps.cn'))
      && ![...url.searchParams.keys()].some(key => /token|secret|cookie|authorization|password/i.test(key)) && !/[?&#](?:access_?token|refresh_?token|token|client_?secret|cookie|password)=/i.test(decodeURIComponent(url.hash)) ? url.href : null;
  } catch { return null; }
}

export class CloudDocumentService {
  constructor({ vault, adapters, skills, packageSkills, operationTimeout = 45000 }) {
    this.vault = vault; this.adapters = adapters; this.skills = skills; this.packageSkills = packageSkills;
    this.operationTimeout = operationTimeout; this.states = new Map(); this.catalogs = new Map(); this.operations = new Map(); this.installQueue = Promise.resolve(); this.closed = false;
  }
  knownSecrets() { return this.vault.knownSecrets(); }
  scrub(value) {
    if (typeof value === 'string') { let result = value; for (const secret of this.knownSecrets().sort((a,b) => b.length - a.length)) result = result.split(secret).join('[REDACTED]'); return result.replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, '$1[REDACTED]'); }
    if (Array.isArray(value)) return value.map(item => this.scrub(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /^(token|accesstoken|refreshtoken|clientsecret|authorization|cookie|password)$/i.test(key.replace(/[_-]/g,'')) ? '[REDACTED]' : this.scrub(item)]));
    return value;
  }
  skill(provider) { return this.skills.list().find(skill => skill.name === DEFINITIONS[assertCloudProvider(provider)].skillName); }
  availableProviders(sessionId) { return CLOUD_PROVIDERS.filter(provider => { const skill = this.skill(provider); return skill && this.skills.isAvailable(skill.id, sessionId); }); }
  assertAvailable(provider, sessionId) {
    const skill = this.skill(provider); if (!skill) throw new HttpError(403, '当前智能体未分配此云文档技能。');
    this.skills.assertAvailable(skill.id, sessionId); return skill;
  }
  async provider(provider) {
    const definition = DEFINITIONS[assertCloudProvider(provider)], local = await this.adapters[provider].installed();
    const configured = Boolean(this.vault.get(provider)), state = this.states.get(provider);
    const current = state?.version === this.vault.version(provider) ? state : null;
    return { id: provider, name: definition.name, installed: local.installed, ...(local.toolVersion ? { toolVersion: local.toolVersion } : {}), configured,
      status: !local.installed ? 'not_installed' : !configured ? 'not_configured' : current?.status || 'not_configured',
      message: !local.installed ? '组件尚未安装，请联系系统管理员。' : !configured ? definition.guidance : current?.message || '凭据已保存，请检测连接。',
      ...(current?.checkedAt ? { checkedAt: current.checkedAt } : {}),
      skills: this.skills.list().filter(skill => skill.name === definition.skillName).map(({id,name,enabled,scope,groupIds}) => ({id,name,enabled,scope,groupIds})) };
  }
  async list() { return { providers: await Promise.all(CLOUD_PROVIDERS.map(provider => this.provider(provider))) }; }
  invalidate(provider) {
    this.states.delete(provider); this.catalogs.delete(provider);
    for (const operation of this.operations.values()) if (operation.provider === provider) operation.controller.abort(new DOMException('云文档授权已更新，请重试。', 'AbortError'));
  }
  async save(provider, body, authorize) { assertCloudProvider(provider); await this.vault.update(provider, body, { authorize }); this.invalidate(provider); return this.provider(provider); }
  async clear(provider, authorize) { assertCloudProvider(provider); await this.vault.clear(provider, { authorize }); this.invalidate(provider); return this.provider(provider); }
  authorization(provider) {
    const definition = DEFINITIONS[assertCloudProvider(provider)];
    return { authorization: { id: provider, status: 'instructions', url: safeCloudAuthorizationUrl(definition.url), message: definition.guidance } };
  }
  async operation(provider, { signal, authorize = () => {} } = {}, action) {
    assertCloudProvider(provider); authorize(); signal?.throwIfAborted();
    if (this.closed) throw new HttpError(503, '云文档服务正在关闭。');
    if ([...this.operations.values()].filter(item => item.provider === provider).length >= 3) throw new HttpError(429, '此云文档连接正在处理其他请求，请稍后重试。');
    const credentials = this.vault.get(provider); if (!credentials) throw new HttpError(409, '请管理员先在技能中心配置此云文档连接。');
    const generation = this.vault.version(provider), controller = new AbortController(), key = randomUUID();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const guard = () => { combined.throwIfAborted(); authorize(); if (this.vault.version(provider) !== generation) throw new HttpError(409, '云文档授权已变更，请重试。'); };
    const deadline = setTimeout(() => controller.abort(new DOMException('云文档请求超时，请稍后重试。', 'TimeoutError')), this.operationTimeout);
    const monitor = setInterval(() => { try { guard(); } catch { controller.abort(new DOMException('云文档访问权限已失效。', 'AbortError')); } }, 1000);
    this.operations.set(key, { provider, controller });
    try { const result = await action(credentials, { signal: combined, guard }); guard(); return this.scrub(result); }
    catch (error) { if (combined.aborted) throw new HttpError(409, '云文档请求已取消或超时，请检查连接后重试。'); throw new HttpError(error.status && error.status >= 400 && error.status < 500 ? error.status : 502, this.scrub(String(error.message || '云文档服务暂不可用。')).slice(0, 500)); }
    finally { clearTimeout(deadline); clearInterval(monitor); this.operations.delete(key); }
  }
  async catalog(provider, credentials, options) {
    const version = this.vault.version(provider), cached = this.catalogs.get(provider);
    if (cached?.version === version && Date.now() - cached.time < 180000) return cached.tools;
    const tools = await this.adapters[provider].listTools(credentials, options);
    options.guard?.();
    if (!Array.isArray(tools) || tools.length > 2000) throw new Error('云文档工具目录无效。');
    const names = new Set();
    for (const tool of tools) {
      if (!tool || typeof tool.name !== 'string' || !/^[\w.:-]{1,160}$/.test(tool.name) || names.has(tool.name) || !tool.inputSchema || tool.inputSchema.type !== 'object') throw new Error('云文档工具目录无效。');
      names.add(tool.name);
    }
    this.catalogs.set(provider, { version, time: Date.now(), tools }); return tools;
  }
  async check(provider, authorize) {
    const version = this.vault.version(assertCloudProvider(provider));
    try {
      const count = await this.operation(provider, { authorize }, async (credentials, options) => {
        this.catalogs.delete(provider);
        if (typeof this.adapters[provider].checkConnection !== 'function') throw new Error('此连接暂不能验证授权，请联系管理员。');
        const verification=await this.adapters[provider].checkConnection(credentials,options); options.guard();
        if(verification?.verification==='service_only')throw new HttpError(409,'工具服务已连通，但文档访问权限尚未验证。请检查账号授权后重新检测。');
        return (await this.catalog(provider, credentials, options)).length;
      });
      authorize();
      if (!count) throw new HttpError(502, '未发现已授权的文档工具，请检查应用权限。');
      this.states.set(provider, { version, status: 'ready', message: `授权检测通过，可用文档工具 ${count} 个；未修改业务文档。`, checkedAt: new Date().toISOString() });
    } catch (error) {
      authorize(); if (version !== this.vault.version(provider)) throw error;
      this.states.set(provider, { version, status: 'error', message: this.scrub(error.message).slice(0,500), checkedAt: new Date().toISOString() });
    }
    return this.provider(provider);
  }
  async execute({ provider, action, params = {} }, { sessionId, mode, authorize, signal } = {}) {
    assertCloudProvider(provider);
    const guard = () => { authorize(); this.assertAvailable(provider, sessionId); };
    guard();
    if (!['list_tools', 'call'].includes(action) || !params || typeof params !== 'object' || Array.isArray(params)) throw new HttpError(400, '云文档操作参数无效。');
    validateCloudArguments(params);
    if (action === 'list_tools' && Object.keys(params).some(key => !['query', 'offset'].includes(key)) || action === 'call' && Object.keys(params).some(key => !['tool', 'arguments'].includes(key))) throw new HttpError(400, '云文档操作参数无效。');
    return this.operation(provider, { signal, authorize: guard }, async (credentials, options) => {
      const catalog = await this.catalog(provider, credentials, options);
      if (action === 'list_tools') {
        if (params.query !== undefined && (typeof params.query !== 'string' || params.query.length > 100) || params.offset !== undefined && (!Number.isSafeInteger(params.offset) || params.offset < 0)) throw new HttpError(400, '工具目录筛选参数无效。');
        const query = (params.query || '').toLowerCase(), offset = params.offset || 0;
        const matches = catalog.filter(tool => !query || `${tool.name} ${tool.description || ''}`.toLowerCase().includes(query));
        return { tools: matches.slice(offset,offset+25), total: matches.length, ...(offset+25 < matches.length ? { nextOffset: offset+25 } : {}) };
      }
      const tool = catalog.find(item => item.name === params.tool);
      if (!tool || !params.arguments || typeof params.arguments !== 'object' || Array.isArray(params.arguments)) throw new HttpError(400, '请先查询工具目录，并按对应 schema 提交参数。');
      if (mode !== 'workspace' && tool.annotations?.readOnlyHint !== true) throw new HttpError(403, '当前智能体为只读模式，不能修改云文档。');
      options.guard(); return this.adapters[provider].callTool(tool.name, params.arguments, credentials, options);
    });
  }
  installSkills(provider, authorize = () => {}) {
    assertCloudProvider(provider);
    const install = this.installQueue.then(async () => {
      authorize(); const manifest = await this.packageSkills(); authorize();
      const bundle = manifest.packages.find(item => item.provider === provider);
      if (!bundle || bundle.name !== DEFINITIONS[provider].skillName) throw new Error('云文档技能包缺失。');
      const existing = this.skill(provider);
      if (existing && !this.skills.get(existing.id).content.includes(`<!-- pi-cloud-documents-adapter:v1 provider=${provider} -->`)) throw new HttpError(409, '已有同名手动技能，请先备份并更名，再导入此适配包。');
      // Preserve existing permissions and identity on repair. Initial import is
      // disabled until an administrator chooses the relevant business groups.
      const zipBase64 = (await fs.readFile(bundle.zipPath)).toString('base64'); authorize();
      const authorizeInstall = () => {
        authorize();
        const current = this.skill(provider);
        if (existing ? !current || current.id !== existing.id || ['version','updatedAt','enabled','scope','avatarId'].some(key=>current[key]!==existing[key]) || JSON.stringify(current.groupIds)!==JSON.stringify(existing.groupIds) : current) throw new HttpError(409, '技能配置已被其他操作更新，请刷新后重新修复。');
      };
      await this.skills.importZip({ zipBase64, enabled: existing?.enabled ?? false, scope: existing?.scope || 'all', groupIds: existing?.groupIds || [], ...(existing?.avatarId ? { avatarId: existing.avatarId } : {}) }, existing?.id || null, { authorize:authorizeInstall });
      authorize(); return this.provider(provider);
    });
    this.installQueue = install.catch(() => {}); return install;
  }
  close() { this.closed = true; for (const {controller} of this.operations.values()) controller.abort(); }
}
