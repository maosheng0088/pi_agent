import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { configure, createFixture, session } from './auth-helpers.mjs';
import { packageCloudDocumentSkills } from '../scripts/package-cloud-document-skills.mjs';

const TOKEN='sdk-fixture-token-private-only',RESULT='CLOUD_REMOTE_DOCUMENT_RESULT_8391',password='Cloud-sdk-fixture-only-2026!';
function testCodec(){const key=randomBytes(32);return async(operation,value)=>{if(operation==='protect'){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),bytes=Buffer.concat([cipher.update(value),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),bytes]);}const bytes=Buffer.from(value),decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));decipher.setAuthTag(bytes.subarray(12,28));return Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]);};}
async function checked(client,route,options={},status=200){const result=await client.request(route,options);assert.equal(result.response.status,status,`${route}: ${JSON.stringify(result.data)}`);return result.data;}
async function finished(client,group,id){for(let i=0;i<300;i++){const task=(await checked(client,`/sessions/${group.id}/tasks/${id}`)).task;if(!['queued','running'].includes(task.status))return task;await delay(30);}throw new Error('Cloud SDK fixture task did not finish');}

test('real Pi SDK receives group-scoped cloud tool schema and delivers mocked remote read results',{timeout:45000},async t=>{
 const calls=[],catalog=[];let fixture;
 const adapters=Object.fromEntries(['tencent','kdocs','wps365'].map(provider=>[provider,{
  async installed(){return {installed:true,toolVersion:'fixture-sdk-1.0.0'};},
  async checkConnection(credentials,{guard}){guard();assert.equal(provider,'tencent');assert.equal(credentials.token,TOKEN);return {ok:true};},
  async listTools(credentials,{guard}){guard();assert.equal(provider,'tencent');assert.equal(credentials.token,TOKEN);catalog.push(provider);return [{name:'general.read',description:'Read a fixture document',inputSchema:{type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false},annotations:{readOnlyHint:true}}];},
  async callTool(name,args,credentials,{guard}){guard();assert.equal(provider,'tencent');assert.equal(credentials.token,TOKEN);assert.equal(name,'general.read');assert.deepEqual(args,{id:'fixture-doc'});calls.push({provider,name,args});return {content:[{type:'text',text:RESULT}]};},
 }]));
 fixture=await createFixture({prefix:'cloud-documents-sdk',options:{channels:{autoStart:false},scheduler:{autoStart:false},workTasks:{pollIntervalMs:20},cloudDocuments:{adapters,vault:{codec:testCodec()},packageSkills:()=>packageCloudDocumentSkills({outputDirectory:path.join(fixture.tempDir,'cloud-packages')})}}});t.after(()=>fixture.close());
 const admin=fixture.client(),member=fixture.client();await checked(admin,'/auth/setup',{method:'POST',body:{username:'cloud-sdk-admin',displayName:'SDK Admin',password}},201);const user=(await checked(admin,'/admin/users',{method:'POST',body:{username:'cloud-sdk-member',displayName:'SDK Member',role:'member',password}},201)).user;await checked(member,'/auth/login',{method:'POST',body:{username:user.username,password}});await configure(admin,fixture);
 const group=await session(admin,'Assigned readonly cloud group'),other=await session(admin,'Unassigned readonly cloud group');assert.equal(group.mode,'read-only');
 for(const item of [group,other])await checked(admin,`/sessions/${item.id}/members`,{method:'POST',body:{userIds:[user.id]}});
 await checked(admin,'/admin/cloud-documents/tencent',{method:'PUT',body:{token:TOKEN}});const skill=(await checked(admin,'/admin/cloud-documents/tencent/install-skills',{method:'POST',body:{}})).provider.skills[0];await checked(admin,`/admin/skills/${skill.id}`,{method:'PATCH',body:{enabled:true,scope:'groups',groupIds:[group.id]}});
 const submitted=(await checked(member,`/sessions/${group.id}/tasks`,{method:'POST',body:{instruction:'[cloud-documents-read] Read the configured fixture document.',clientRequestId:'cloud-sdk-read-1'}},202)).task,task=await finished(member,group,submitted.id);assert.equal(task.status,'succeeded',task.error);assert.ok(task.result.includes(RESULT));assert.equal(calls.length,1);assert.equal(catalog.length,1);
 const request=fixture.mock.requests.find(request=>request.tools?.some(tool=>tool.function?.name==='cloud_documents'));assert.ok(request);const tool=request.tools.find(tool=>tool.function?.name==='cloud_documents');assert.deepEqual(tool.function.parameters.properties.provider.enum,['tencent']);assert.deepEqual(tool.function.parameters.properties.action.enum,['list_tools','call']);assert.equal(tool.function.parameters.additionalProperties,false);assert.ok(fixture.mock.requests.some(request=>JSON.stringify(request.messages).includes('call_cloud_documents_read')));assert.ok(!JSON.stringify(fixture.mock.requests).includes(TOKEN));
 const start=fixture.mock.requests.length,blocked=(await checked(member,`/sessions/${other.id}/tasks`,{method:'POST',body:{instruction:'[cloud-documents-read] Read this unassigned group.',clientRequestId:'cloud-sdk-no-skill'}},202)).task,without=await finished(member,other,blocked.id);assert.equal(without.status,'succeeded',without.error);assert.equal(calls.length,1);assert.ok(fixture.mock.requests.slice(start).length>0);assert.ok(fixture.mock.requests.slice(start).every(request=>!request.tools?.some(tool=>tool.function?.name==='cloud_documents')));
});
