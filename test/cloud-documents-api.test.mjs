import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createFixture, session } from './auth-helpers.mjs';
import { packageCloudDocumentSkills } from '../scripts/package-cloud-document-skills.mjs';
import { sessionTools } from '../lib/shared-tools.mjs';
import { loadPi } from '../lib/pi.mjs';

const PASSWORD='Cloud-document-fixture-only-2026!', IDS=['tencent','kdocs','wps365'];
const TOKENS={tencent:'fixture-tencent-token-private',kdocs:'fixture-kdocs-token-private',clientId:'fixture-enterprise-client-id',clientSecret:'fixture-enterprise-secret-private'};
function codec(){
 const key=randomBytes(32);
 return async(operation,value)=>{
  if(operation==='protect'){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),encrypted=Buffer.concat([cipher.update(value),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),encrypted]);}
  const input=Buffer.from(value),decipher=createDecipheriv('aes-256-gcm',key,input.subarray(0,12));decipher.setAuthTag(input.subarray(12,28));return Buffer.concat([decipher.update(input.subarray(28)),decipher.final()]);
 };
}
const toolCatalog=[{name:'document_read',description:'Read a document',inputSchema:{type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false},annotations:{readOnlyHint:true}},
 {name:'document_update',description:'Update a document',inputSchema:{type:'object',properties:{id:{type:'string'},text:{type:'string'}},required:['id','text'],additionalProperties:false},annotations:{readOnlyHint:false}}];
function fakeAdapters(){
 const state=Object.fromEntries(IDS.map(id=>[id,{installed:true,probeError:null,probeCalls:0,catalogCalls:0,toolCalls:[],tools:structuredClone(toolCatalog)}]));
 const adapters=Object.fromEntries(IDS.map(id=>[id,{
  async installed(){return {installed:state[id].installed,toolVersion:'fixture-1.0.0'};},
  async checkConnection(credentials,options){state[id].probeCalls++;options.guard();if(state[id].probeError)throw state[id].probeError;assert.ok(id==='wps365'?credentials.clientId&&credentials.clientSecret:credentials.token);return {ok:true};},
  async listTools(_credentials,options){state[id].catalogCalls++;options.guard();return structuredClone(state[id].tools);},
  async callTool(name,args,_credentials,options){options.guard();state[id].toolCalls.push({name,args});return {content:[{type:'text',text:'fixture document content'}]};},
 }]));
 return {state,adapters};
}
async function checked(client,route,options={},status=200){const result=await client.request(route,options);assert.equal(result.response.status,status,`${route}: ${JSON.stringify(result.data)}`);return result.data;}
function noSecrets(value){const text=JSON.stringify(value);for(const secret of Object.values(TOKENS))assert.ok(!text.includes(secret),'public response must not contain a fixture credential');}
async function setup(t){
 const {adapters,state}=fakeAdapters();let fixture;
 fixture=await createFixture({prefix:'cloud-documents-api',options:{channels:{autoStart:false},scheduler:{autoStart:false},workTasks:{autoStart:false},cloudDocuments:{vault:{codec:codec()},adapters,packageSkills:()=>packageCloudDocumentSkills({outputDirectory:path.join(fixture.tempDir,'cloud-packages')}),operationTimeout:3000}}});
 t.after(()=>fixture.close());const admin=fixture.client(),employee=fixture.client(),guest=fixture.client();
 await checked(admin,'/auth/setup',{method:'POST',body:{username:'cloud-admin',displayName:'Cloud Administrator',password:PASSWORD}},201);
 const user=(await checked(admin,'/admin/users',{method:'POST',body:{username:'cloud-employee',displayName:'Cloud Employee',role:'member',password:PASSWORD}},201)).user;
 await checked(employee,'/auth/login',{method:'POST',body:{username:user.username,password:PASSWORD}});
 return {fixture,admin,employee,guest,state,user};
}
const body=provider=>provider==='wps365'?{clientId:TOKENS.clientId,clientSecret:TOKENS.clientSecret}:{token:TOKENS[provider]};

test('cloud connection endpoints require a current administrator for every operation',{timeout:30000},async t=>{
 const f=await setup(t);const routes=[['GET','/admin/cloud-documents'],['PUT','/admin/cloud-documents/tencent'],['POST','/admin/cloud-documents/tencent/check'],['POST','/admin/cloud-documents/tencent/authorize'],['GET','/admin/cloud-documents/tencent/authorization'],['POST','/admin/cloud-documents/tencent/install-skills'],['DELETE','/admin/cloud-documents/tencent/credentials']];
 for(const [method,route] of routes){const options={method,...(method==='GET'?{}:{body:method==='PUT'?body('tencent'): {}})};await checked(f.employee,route,options,403);await checked(f.guest,route,options,401);}
 const result=await checked(f.admin,'/admin/cloud-documents');assert.deepEqual(result.providers.map(item=>item.id),IDS);assert.ok(result.providers.every(item=>item.configured===false&&item.status==='not_configured'));noSecrets(result);
 assert.equal(f.state.tencent.probeCalls,0);assert.equal(f.state.tencent.catalogCalls,0);
});

test('credential writes are encrypted, preserve omitted or empty values, and never echo credentials',{timeout:30000},async t=>{
 const f=await setup(t);
 for(const id of IDS){const saved=await checked(f.admin,`/admin/cloud-documents/${id}`,{method:'PUT',body:body(id)});assert.equal(saved.provider.configured,true);assert.equal(saved.provider.status,'not_configured');noSecrets(saved);}
 for(const id of ['tencent','kdocs']){const saved=await checked(f.admin,`/admin/cloud-documents/${id}`,{method:'PUT',body:{token:'  '}});assert.equal(saved.provider.configured,true);assert.equal(f.fixture.server.piWeb.cloudDocuments.vault.get(id).token,TOKENS[id]);noSecrets(saved);}
 await checked(f.admin,'/admin/cloud-documents/wps365',{method:'PUT',body:{clientId:'fixture-updated-client'}});assert.equal(f.fixture.server.piWeb.cloudDocuments.vault.get('wps365').clientSecret,TOKENS.clientSecret);
 await checked(f.admin,'/admin/cloud-documents/wps365',{method:'PUT',body:{clientSecret:''}});assert.equal(f.fixture.server.piWeb.cloudDocuments.vault.get('wps365').clientSecret,TOKENS.clientSecret);
 const stored=JSON.parse(await fs.readFile(path.join(f.fixture.dataDir,'cloud-document-credentials.json'),'utf8'));assert.equal(stored.protection,'windows-current-user');assert.equal(typeof stored.ciphertext,'string');noSecrets(stored);
 for(const id of IDS){const removed=await checked(f.admin,`/admin/cloud-documents/${id}/credentials`,{method:'DELETE',body:{}});assert.equal(removed.provider.configured,false);noSecrets(removed);}
 assert.ok(IDS.every(id=>f.fixture.server.piWeb.cloudDocuments.vault.get(id)===null));assert.ok(IDS.every(id=>f.state[id].toolCalls.length===0));
});

test('official authorization returns manual instructions rather than fabricated OAuth completion',{timeout:30000},async t=>{
 const f=await setup(t);
 for(const id of IDS){const started=await checked(f.admin,`/admin/cloud-documents/${id}/authorize`,{method:'POST',body:{}}),status=await checked(f.admin,`/admin/cloud-documents/${id}/authorization`);assert.equal(started.authorization.status,'instructions');assert.deepEqual(status,started);assert.ok(new URL(started.authorization.url).protocol==='https:');assert.ok(started.authorization.message);assert.equal(f.fixture.server.piWeb.cloudDocuments.vault.get(id),null);noSecrets(started);}
 assert.ok(IDS.every(id=>f.state[id].probeCalls===0&&f.state[id].catalogCalls===0));
});

test('all three real adapted skill packages import disabled and repair preserves identity and group scope',{timeout:30000},async t=>{
 const f=await setup(t),group=await session(f.admin,'Cloud-enabled group'),other=await session(f.admin,'Other group');
 const names={tencent:'tencent-docs',kdocs:'kdocs',wps365:'wps365'};
 for(const id of IDS){
  const result=await checked(f.admin,`/admin/cloud-documents/${id}/install-skills`,{method:'POST',body:{}}),skill=result.provider.skills.find(item=>item.name===names[id]);assert.ok(skill);assert.equal(skill.enabled,false);
  const original=(await checked(f.admin,`/skills/${skill.id}`)).skill;assert.ok(original.content.includes(`<!-- pi-cloud-documents-adapter:v1 provider=${id} -->`));assert.ok(original.content.includes('cloud_documents'));
  await checked(f.admin,`/admin/skills/${skill.id}`,{method:'PATCH',body:{enabled:true,scope:'groups',groupIds:[group.id],avatarId:'portrait-01'}});
  const repaired=await checked(f.admin,`/admin/cloud-documents/${id}/install-skills`,{method:'POST',body:{}}),current=repaired.provider.skills.find(item=>item.name===names[id]);assert.equal(current.id,skill.id);assert.equal(current.enabled,true);assert.equal(current.scope,'groups');assert.deepEqual(current.groupIds,[group.id]);
  const detail=(await checked(f.admin,`/skills/${skill.id}`)).skill;assert.equal(detail.avatarId,'portrait-01');assert.ok(detail.version>original.version);assert.ok(f.fixture.server.piWeb.cloudDocuments.availableProviders(group.id).includes(id));assert.ok(!f.fixture.server.piWeb.cloudDocuments.availableProviders(other.id).includes(id));
 }
 assert.ok(IDS.every(id=>f.state[id].probeCalls===0&&f.state[id].toolCalls.length===0));
});

test('an existing same-name manual skill is not overwritten by automatic installation',{timeout:30000},async t=>{
 const f=await setup(t),manual=(await checked(f.admin,'/admin/skills',{method:'POST',body:{name:'tencent-docs',description:'Manually managed fixture skill.',content:'PRIVATE-MANUAL-CONTENT',enabled:true}},201)).skill;
 await checked(f.admin,'/admin/cloud-documents/tencent/install-skills',{method:'POST',body:{}},409);
 const current=(await checked(f.admin,`/skills/${manual.id}`)).skill;assert.equal(current.content,'PRIVATE-MANUAL-CONTENT');assert.equal(current.id,manual.id);assert.equal(current.enabled,true);
});

test('connection readiness requires a successful remote probe, not a nonempty tool list',{timeout:30000},async t=>{
 const f=await setup(t);await checked(f.admin,'/admin/cloud-documents/tencent',{method:'PUT',body:body('tencent')});f.state.tencent.probeError=Object.assign(new Error(`Unauthorized Bearer ${TOKENS.tencent}`),{status:401});
 let result=await checked(f.admin,'/admin/cloud-documents/tencent/check',{method:'POST',body:{}});assert.equal(result.provider.status,'error');assert.equal(f.state.tencent.probeCalls,1);assert.equal(f.state.tencent.catalogCalls,0);noSecrets(result);
 f.state.tencent.probeError=null;result=await checked(f.admin,'/admin/cloud-documents/tencent/check',{method:'POST',body:{}});assert.equal(result.provider.status,'ready');assert.equal(f.state.tencent.probeCalls,2);assert.equal(f.state.tencent.catalogCalls,1);assert.ok(result.provider.checkedAt);noSecrets(result);
 f.state.tencent.tools=[];result=await checked(f.admin,'/admin/cloud-documents/tencent/check',{method:'POST',body:{}});assert.equal(result.provider.status,'error');assert.ok(!result.provider.message.includes('检测通过'));
});

test('cloud agent tools are exposed only for assigned providers and enforce read-only mutation limits',{timeout:30000},async t=>{
 const f=await setup(t),group=await session(f.admin,'Cloud tool group'),other=await session(f.admin,'Unassigned group');await checked(f.admin,'/admin/cloud-documents/tencent',{method:'PUT',body:body('tencent')});
 const installed=(await checked(f.admin,'/admin/cloud-documents/tencent/install-skills',{method:'POST',body:{}})).provider.skills[0];await checked(f.admin,`/admin/skills/${installed.id}`,{method:'PATCH',body:{enabled:true,scope:'groups',groupIds:[group.id]}});
 const cloud=f.fixture.server.piWeb.cloudDocuments,sdk=await loadPi('D:/code/pi/packages/coding-agent/dist/index.js');let valid=true;const authorize=()=>{if(!valid)throw new Error('Fixture group membership revoked');};
 const make=async(id,mode)=>sessionTools(sdk,{cwd:f.fixture.workspace,dataDir:f.fixture.dataDir,mode,authorize,cloudDocumentProviders:cloud.availableProviders(id),cloudDocuments:(args,signal)=>cloud.execute(args,{sessionId:id,mode,authorize,signal})});
 const allowed=await make(group.id,'read-only'),tool=allowed.customTools.find(tool=>tool.name==='cloud_documents');assert.ok(tool);assert.deepEqual(tool.parameters.properties.provider.enum,['tencent']);assert.ok(!(await make(other.id,'read-only')).customTools.some(tool=>tool.name==='cloud_documents'));
 const listed=await tool.execute('list',{provider:'tencent',action:'list_tools'});assert.ok(listed.content[0].text.includes('document_read'));
 await assert.rejects(tool.execute('wrong',{provider:'kdocs',action:'list_tools'}),/未配置/);
 await assert.rejects(tool.execute('write',{provider:'tencent',action:'call',params:{tool:'document_update',arguments:{id:'document-one',text:'fixture'}}}),/只读/);assert.equal(f.state.tencent.toolCalls.length,0);
 const read=await tool.execute('read',{provider:'tencent',action:'call',params:{tool:'document_read',arguments:{id:'document-one'}}});assert.ok(read.content[0].text.includes('fixture document content'));assert.equal(f.state.tencent.toolCalls.length,1);
 valid=false;await assert.rejects(tool.execute('revoked',{provider:'tencent',action:'list_tools'}),/membership revoked/);assert.equal(f.state.tencent.toolCalls.length,1);
});
