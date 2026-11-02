import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {CloudCredentialVault} from '../lib/cloud-document-credentials.mjs';
import {CloudDocumentService,safeCloudAuthorizationUrl} from '../lib/cloud-documents.mjs';
import {sessionTools} from '../lib/shared-tools.mjs';

const readTool={name:'general.read',description:'Read cloud file',inputSchema:{type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false},annotations:{readOnlyHint:true}};
const writeTool={...readTool,name:'general.edit',annotations:{readOnlyHint:false}};
async function fixture(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'pi-cloud-docs-'));
  t.after(async()=>{assert.equal(path.dirname(directory),os.tmpdir());assert.ok(path.basename(directory).startsWith('pi-cloud-docs-'));await fs.rm(directory,{recursive:true,force:true});});
  const dataDir=path.join(directory,'data'),cwd=path.join(directory,'workspace');await fs.mkdir(dataDir);await fs.mkdir(cwd);
  // Test-only reversible codec, not used by server defaults.
  const vault=await CloudCredentialVault.open(dataDir,{codec:async(_,bytes)=>Buffer.from(bytes).map(byte=>byte^0x5a)});
  const skill={id:'skill1',name:'tencent-docs',enabled:true,scope:'groups',groupIds:['group1']};
  const skills={list:()=>[skill],isAvailable:(id,group)=>id===skill.id&&skill.enabled&&skill.groupIds.includes(group),assertAvailable(id,group){if(!this.isAvailable(id,group))throw new Error('scope denied');}};
  let calls=0,checkCalls=0;
  const adapter={installed:async()=>({installed:true,toolVersion:'fixture'}),listTools:async()=>[readTool,writeTool],checkConnection:async()=>{checkCalls++;},callTool:async(name,args)=>{calls++;return {content:[{type:'text',text:`${name}:${args.id}`}],token:'fixture-secret-cloud-8291'};}};
  const service=new CloudDocumentService({vault,skills,adapters:{tencent:adapter,kdocs:adapter,wps365:adapter}});t.after(()=>service.close());
  await service.save('tencent',{token:'fixture-secret-cloud-8291'},()=>{});
  const context={sessionId:'group1',mode:'workspace',authorize:()=>{}};
  return {service,vault,skill,adapter,context,cwd,dataDir,calls:()=>calls,checks:()=>checkCalls};
}
test('provider checks authenticate remotely; metadata and errors never expose credentials',async t=>{
  const f=await fixture(t);assert.deepEqual(f.service.availableProviders('group1'),['tencent']);assert.deepEqual(f.service.availableProviders('group2'),[]);
  assert.equal((await f.service.provider('tencent')).configured,true);assert.equal((await f.service.check('tencent',()=>{})).status,'ready');assert.equal(f.checks(),1);
  f.adapter.checkConnection=async()=>({verification:'service_only'});
  const serviceOnly=await f.service.check('tencent',()=>{});assert.equal(serviceOnly.status,'error');assert.match(serviceOnly.message,/尚未验证/);
  f.adapter.checkConnection=async()=>{throw new Error('401 fixture-secret-cloud-8291 invalid');};
  const failed=await f.service.check('tencent',()=>{});assert.equal(failed.status,'error');assert.doesNotMatch(JSON.stringify(failed),/fixture-secret/);
  const result=await f.service.execute({provider:'tencent',action:'call',params:{tool:'general.read',arguments:{id:'file1'}}},f.context);
  assert.equal(result.token,'[REDACTED]');
  await f.service.clear('tencent',()=>{});await assert.rejects(f.service.execute({provider:'tencent',action:'list_tools'},f.context),/管理员先/);
});
test('cloud operations recheck group skill scope, actor and read-only policy even on cached catalogs',async t=>{
  const f=await fixture(t);
  const listed=await f.service.execute({provider:'tencent',action:'list_tools',params:{query:'general.read'}},f.context);assert.equal(listed.tools.length,1);
  await assert.rejects(f.service.execute({provider:'tencent',action:'call',params:{tool:'general.edit',arguments:{id:'f'}}},{...f.context,mode:'read-only'}),/只读模式/);assert.equal(f.calls(),0);
  await assert.rejects(f.service.execute({provider:'tencent',action:'call',params:{tool:'auth.login',arguments:{}}},f.context),/先查询工具/);
  await assert.rejects(f.service.execute({provider:'tencent',action:'list_tools',params:{endpoint:'https://evil.example'}},f.context),/参数无效/);
  f.skill.enabled=false;await assert.rejects(f.service.execute({provider:'tencent',action:'list_tools'},f.context),/scope denied/);
  f.skill.enabled=true;await assert.rejects(f.service.execute({provider:'tencent',action:'list_tools'},{...f.context,authorize:()=>{throw new Error('actor disabled');}}),/actor disabled/);
});
test('revocation and credential rotation cancel active requests before returning cloud contents',async t=>{
  const f=await fixture(t);let started;const ready=new Promise(resolve=>started=resolve);
  f.adapter.callTool=async(_name,_args,_credentials,{signal})=>{started();await delay(10000,null,{signal});return {private:'must not return'};};
  const pending=f.service.execute({provider:'tencent',action:'call',params:{tool:'general.read',arguments:{id:'f'}}},f.context);
  const rejected=assert.rejects(pending,/取消或超时/);await ready;await f.service.save('tencent',{token:'rotated-fixture-credential-3931'},()=>{});await rejected;
});
test('cloud tool appears only for assigned providers and does not accept credential/endpoint injection',async t=>{
  const f=await fixture(t),sdk=Object.fromEntries(['Read','Ls','Find','Grep'].map(name=>[`create${name}ToolDefinition`,()=>({name:name.toLowerCase(),description:'fixture',execute:async()=>({})})]));
  const common={cwd:f.cwd,dataDir:f.dataDir,mode:'read-only',cloudDocuments:(args,signal)=>f.service.execute(args,{...f.context,mode:'read-only',signal})};
  assert.ok(!(await sessionTools(sdk,common)).tools.includes('cloud_documents'));
  const tools=await sessionTools(sdk,{...common,cloudDocumentProviders:['tencent']});const cloud=tools.customTools.find(tool=>tool.name==='cloud_documents');
  assert.ok(cloud);await assert.rejects(cloud.execute('id',{provider:'kdocs',action:'list_tools'}),/未配置/);
  await assert.rejects(cloud.execute('id',{provider:'tencent',action:'list_tools',token:'secret'}),/未配置/);
  const result=await cloud.execute('id',{provider:'tencent',action:'list_tools'});assert.match(result.content[0].text,/general.read/);
});
test('authorization links allow only fixed official HTTPS hosts without credentials',()=>{
  for(const value of ['https://docs.qq.com/open/document/mcp/get-token/','https://open.wps.cn/','https://www.kdocs.cn/latest'])assert.equal(safeCloudAuthorizationUrl(value),value);
  for(const value of ['http://docs.qq.com/','https://evil.example','https://open.wps.cn.evil.example','https://user:pass@docs.qq.com','https://docs.qq.com/?token=abc','javascript:alert(1)'])assert.equal(safeCloudAuthorizationUrl(value),null);
});
