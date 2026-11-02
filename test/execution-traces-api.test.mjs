import assert from 'node:assert/strict';
import {test} from 'node:test';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {configure,createFixture,session} from './auth-helpers.mjs';

async function checked(client,route,options,status=200){const result=await client.request(route,options);assert.equal(result.response.status,status,JSON.stringify(result.data));return result.data;}
async function until(check){for(let i=0;i<200;i++){const value=await check();if(value)return value;await new Promise(resolve=>setTimeout(resolve,30));}throw new Error('task timeout');}
test('admin execution API captures real Pi tools, scopes work tasks and denies employees', {timeout:60000},async()=>{
 const fixture=await createFixture({prefix:'execution-process',options:{scheduler:{autoStart:false},channels:{autoStart:false},workTasks:{pollIntervalMs:20}}});
 try{
  const admin=fixture.client(),member=fixture.client(),guest=fixture.client(),password='Execution-fixture-2026!';
  await checked(admin,'/auth/setup',{method:'POST',body:{username:'trace-admin',displayName:'执行管理员',password}},201);await configure(admin,fixture);
  const user=(await checked(admin,'/admin/users',{method:'POST',body:{username:'trace-member',displayName:'执行员工',role:'member',password}},201)).user;
  await checked(member,'/auth/login',{method:'POST',body:{username:user.username,password}});
  const group=await session(admin,'工具执行验收');await checked(admin,`/sessions/${group.id}/members`,{method:'POST',body:{userIds:[user.id]}});
  await writeFile(path.join(group.cwd,'fixture.txt'),'trace-safe-output shared-test-model-key-do-not-return');
  await admin.send(group.id,'[read-workspace]');
  let list=await checked(admin,`/admin/executions?sessionId=${group.id}`);assert.equal(list.total,1);
  const trace=await checked(admin,`/admin/executions/${list.runs[0].id}`);assert.equal(trace.run.status,'succeeded');assert.equal(trace.steps[0].toolName,'read');assert.match(trace.steps[0].args,/fixture.txt/);assert.match(trace.steps[0].output,/trace-safe-output/);assert(!JSON.stringify(trace).includes('shared-test-model-key-do-not-return'));assert(trace.steps[0].durationMs>=0);
  for(const client of [member,guest])for(const route of ['/admin/executions',`/admin/executions/${trace.run.id}`,`/admin/executions/history-${group.id}`])assert.equal((await client.request(route)).response.status,client===member?403:401);
  const task=(await checked(member,`/sessions/${group.id}/tasks`,{method:'POST',body:{instruction:'[read-workspace]'}},202)).task;
  await until(async()=>{const value=await checked(member,`/sessions/${group.id}/tasks/${task.id}`);return value.task.status==='succeeded'});
  list=await checked(admin,`/admin/executions?workTaskId=${task.id}`);assert.equal(list.total,1);assert.equal(list.runs[0].workTaskId,task.id);
  assert.equal((await checked(admin,`/admin/executions/${list.runs[0].id}`)).steps[0].toolName,'read');
  for(const query of ['limit=0','offset=-1','sessionId=a&groupId=b','limit=1&limit=2','unknown=x','sessionId='])assert.equal((await admin.request(`/admin/executions?${query}`)).response.status,400);
  await admin.send(group.id,'[read-path:missing-file.txt]');list=await checked(admin,`/admin/executions?sessionId=${group.id}`);const failedTool=await checked(admin,`/admin/executions/${list.runs[0].id}`);assert.equal(failedTool.steps[0].status,'failed');
  const plainGroup=await session(admin,'没有工具的模型回复');await admin.send(plainGroup.id,'你好');const plain=(await checked(admin,`/admin/executions?sessionId=${plainGroup.id}`)).runs[0];assert.equal((await checked(admin,`/admin/executions/${plain.id}`)).total,0);
  await checked(admin,'/auth/logout',{method:'POST',body:{}});assert.equal((await admin.request(`/admin/executions/${trace.run.id}`)).response.status,401);
 }finally{await fixture.close();}
});
