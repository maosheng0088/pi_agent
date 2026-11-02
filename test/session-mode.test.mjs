import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createFixture, configure, collaborativeSession as session, deltaText, collectSSE } from './auth-helpers.mjs';

test('administrator can enable an existing read-only conversation and run a real skill script, employees can execute approved skills and respect administrator mode changes',async()=>{
  const fixture=await createFixture({prefix:'mode-switch'});
  try {
    const admin=fixture.client(),member=fixture.client(),password='Mode-fixture-2026!';
    await admin.request('/auth/setup',{method:'POST',body:{username:'mode-admin',displayName:'Admin',password}});await configure(admin,fixture);
    await admin.request('/admin/users',{method:'POST',body:{username:'mode-member',displayName:'Member',password,role:'member'}});await member.request('/auth/login',{method:'POST',body:{username:'mode-member',password}});
    const chat=await session(admin,'Existing readonly chat');assert.equal(chat.mode,'read-only');
    await admin.send(chat.id,'Explain the current read-only permissions.');
    assert.equal((await member.request(`/sessions/${chat.id}`,{method:'PATCH',body:{mode:'workspace'}})).response.status,403);
    assert.equal((await admin.request(`/sessions/${chat.id}`,{method:'PATCH',body:{mode:'invalid'}})).response.status,400);
    const change=await admin.request(`/sessions/${chat.id}`,{method:'PATCH',body:{mode:'workspace'}});assert.equal(change.response.status,200);assert.equal(change.data.session.mode,'workspace');
    const skill=await admin.request('/admin/skills',{method:'POST',body:{name:'execution-fixture',description:'Run the provided fixture script.',content:'Execute the fixture script using the system command tool.',enabled:true}});
    const script=path.join(fixture.dataDir,'skills',skill.data.skill.id,'v1','script.mjs');
    await fs.writeFile(script,"import fs from 'node:fs';fs.writeFileSync('skill-result.txt','ACTUAL-SKILL-EXECUTION');console.log('SCRIPT-EXECUTED');");
    const response=await admin.send(chat.id,`/skill:execution-fixture [run-skill-script:${script}]`);
    assert.match(deltaText(response),/SCRIPT-EXECUTED/);assert.equal(await fs.readFile(path.join(chat.cwd,'skill-result.txt'),'utf8'),'ACTUAL-SKILL-EXECUTION');
    const request=fixture.mock.requests.at(-1);assert.ok(request.tools.some(tool=>['powershell','bash'].includes(tool.function.name)));
    const currentPrompt=request.messages.filter(message=>message.role==='system').map(message=>JSON.stringify(message.content)).join('\n');
    assert.match(currentPrompt,/当前模式：执行模式/);assert.doesNotMatch(currentPrompt,/当前模式：只读模式/);
    assert.match(JSON.stringify(request.messages.findLast(message=>message.role==='user').content),/当前已是执行模式/);
    const history=(await admin.request(`/sessions/${chat.id}`)).data;
    assert.doesNotMatch(JSON.stringify(history.messages),/server_runtime_notice/);
    const memberResult=await member.send(chat.id,`/skill:execution-fixture [run-skill-script:${script}]`);assert.match(deltaText(memberResult),/SCRIPT-EXECUTED/);assert.ok(fixture.mock.requests.at(-1).tools.some(tool=>['powershell','bash','write','edit'].includes(tool.function.name)));
    const memberPrompt=fixture.mock.requests.at(-1).messages.filter(message=>message.role==='system').map(message=>JSON.stringify(message.content)).join('\n');
    assert.match(memberPrompt,/当前模式：执行模式/);assert.doesNotMatch(memberPrompt,/当前模式：只读模式/);
    assert.match(JSON.stringify(fixture.mock.requests.at(-1).messages.findLast(message=>message.role==='user').content),/当前已是执行模式/);
    const stream = await admin.fetch(`/sessions/${chat.id}/messages`,{method:'POST',body:{message:'[slow-response]'}});
    assert.equal((await admin.request(`/sessions/${chat.id}`,{method:'PATCH',body:{mode:'read-only'}})).response.status,409);
    await admin.request(`/sessions/${chat.id}/abort`,{method:'POST',body:{}});await collectSSE(stream);
    assert.equal((await admin.request(`/sessions/${chat.id}`,{method:'PATCH',body:{mode:'read-only'}})).response.status,200);
    await member.send(chat.id,'Check permissions after administrator disabled execution.');assert.ok(!fixture.mock.requests.at(-1).tools.some(tool=>['powershell','bash','write','edit'].includes(tool.function.name)));
    await fixture.stop();await fixture.start();assert.equal((await admin.request(`/sessions/${chat.id}`)).data.session.mode,'read-only');
  } finally {await fixture.close();}
});
