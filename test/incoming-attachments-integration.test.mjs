import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createFixture, configure, session, deltaText} from './auth-helpers.mjs';

async function upload(fixture, client, groupId, name, bytes) {
  const response=await fetch(`${fixture.baseUrl}/api/sessions/${groupId}/attachments?name=${encodeURIComponent(name)}`,{
    method:'POST',headers:{cookie:client.cookie,'content-type':'application/octet-stream'},body:bytes,
  });
  const data=await response.json();assert.equal(response.status,201,JSON.stringify(data));return data.attachment;
}
async function waitTask(client,groupId,taskId){
  for(let attempt=0;attempt<200;attempt++){
    const {data}=await client.request(`/sessions/${groupId}/tasks/${taskId}`);
    if(!['queued','running'].includes(data.task.status))return data.task;
    await delay(25);
  }
  throw new Error('Isolated uploaded-file task did not finish');
}

test('uploaded discussion files, queued tasks and historical tool reads use real member-only snapshots', {timeout:120000}, async()=>{
  const fixture=await createFixture({prefix:'incoming-files',options:{scheduler:{autoStart:false},channels:{autoStart:false}}});
  const admin=fixture.client(),member=fixture.client(),outsider=fixture.client(),password='incoming-fixture-password';
  try{
    await admin.request('/auth/setup',{method:'POST',body:{username:'files-admin',displayName:'Admin',password}});
    const employee=(await admin.request('/admin/users',{method:'POST',body:{username:'files-member',displayName:'Member',password,role:'member'}})).data.user;
    await admin.request('/admin/users',{method:'POST',body:{username:'files-outsider',displayName:'Outsider',password,role:'member'}});
    await member.request('/auth/login',{method:'POST',body:{username:'files-member',password}});
    await outsider.request('/auth/login',{method:'POST',body:{username:'files-outsider',password}});
    await configure(admin,fixture);
    const group=await session(admin,'File collaboration');
    await admin.request(`/sessions/${group.id}/members`,{method:'POST',body:{userIds:[employee.id]}});
    await admin.request(`/sessions/${group.id}`,{method:'PATCH',body:{mode:'workspace'}});
    const bytes=Buffer.from('FBA,UnitCount\nFBA-FIXTURE,57\nUPLOAD_CONTENT_VERIFIED_9271');
    const attachment=await upload(fixture,member,group.id,'报价表[最终].csv',bytes);
    const discussion=await member.request(`/sessions/${group.id}/discussion`,{method:'POST',body:{content:'',attachmentIds:[attachment.id],clientRequestId:'file-discussion'}});
    assert.equal(discussion.response.status,201,JSON.stringify(discussion.data));
    assert.equal(discussion.data.message.attachments[0].id,attachment.id);
    assert.match(discussion.data.message.content,/报价表/);
    assert.equal(fixture.mock.requests.length,0,'ordinary file sharing must not invoke a model');
    const body={instruction:'[read-incoming-attachment] Read the attached CSV.',attachmentIds:[attachment.id],clientRequestId:'file-task'};
    const submitted=await member.request(`/sessions/${group.id}/tasks`,{method:'POST',body});
    assert.equal(submitted.response.status,202,JSON.stringify(submitted.data));
    const task=await waitTask(member,group.id,submitted.data.task.id);
    assert.equal(task.status,'succeeded',task.error);assert.match(task.result,/UPLOAD_CONTENT_VERIFIED_9271/);
    assert.equal(task.attachments[0].id,attachment.id);
    const replay=await member.request(`/sessions/${group.id}/tasks`,{method:'POST',body});
    assert.equal(replay.data.task.id,task.id);
    const prompted=fixture.mock.requests.find(request=>JSON.stringify(request.messages).includes('本任务的附件已由服务器'));
    assert.ok(prompted,'the real SDK must receive the registered workspace attachment context');
    const wire=JSON.stringify(prompted.messages);assert.ok(wire.includes('attachment-inbox'));
    const userText=prompted.messages.filter(message=>message.role==='user').map(message=>typeof message.content==='string'?message.content:message.content.map(part=>part.text||'').join('')).join('\n');
    const files=JSON.parse(userText.slice(userText.indexOf('本任务的附件已由服务器')).split('\n')[1]);
    assert.equal(files.length,1);assert.equal(files[0].id,attachment.id);
    const relative=path.relative(path.join(fixture.dataDir,'attachment-inbox'),files[0].path);
    assert.ok(!relative.startsWith('..')&&!path.isAbsolute(relative));
    assert.ok(path.relative(fixture.workspace,files[0].path).startsWith('..'),'task copies must stay outside the shared workspace');
    await assert.rejects(fs.stat(files[0].path),{code:'ENOENT'},'the finished execution must clean its temporary copy');
    assert.ok(!('path' in task.attachments[0]),'private paths must not enter public task metadata');
    const quoted=await member.request(`/sessions/${group.id}/tasks`,{method:'POST',body:{instruction:'[read-incoming-attachment] Read the quoted file.',replyTo:discussion.data.message.id,clientRequestId:'quoted-file-task'}});
    assert.equal(quoted.response.status,202,JSON.stringify(quoted.data));
    const quotedTask=await waitTask(member,group.id,quoted.data.task.id);
    assert.equal(quotedTask.status,'succeeded',quotedTask.error);assert.match(quotedTask.result,/UPLOAD_CONTENT_VERIFIED_9271/);
    const historyRead=await member.send(group.id,`[open-group-attachment:${attachment.id}] Read the earlier file.`);
    assert.match(deltaText(historyRead),/UPLOAD_CONTENT_VERIFIED_9271/);
    const other=await session(admin,'Another private group');
    await admin.request(`/sessions/${other.id}`,{method:'PATCH',body:{mode:'workspace'}});
    const before=fixture.mock.requests.length;
    const denied=await admin.request(`/sessions/${other.id}/tasks`,{method:'POST',body:{instruction:'Read this file.',attachmentIds:[attachment.id]}});
    assert.equal(denied.response.status,404);assert.equal(fixture.mock.requests.length,before);
    const wrongGroup=await admin.send(other.id,`[open-group-attachment:${attachment.id}] Read it.`);
    assert.doesNotMatch(deltaText(wrongGroup),/UPLOAD_CONTENT_VERIFIED_9271/);
    assert.equal((await outsider.fetch(attachment.url.slice(4))).status,404);
    const downloads=await member.fetch(attachment.url.slice(4));assert.deepEqual(Buffer.from(await downloads.arrayBuffer()),bytes);
    await fixture.stop();await fixture.start();
    const persisted=(await member.request(`/sessions/${group.id}`)).data.messages;
    assert.equal(persisted.filter(message=>message.id===discussion.data.message.id).length,1);
    assert.equal(persisted.find(message=>message.id===discussion.data.message.id).attachments[0].id,attachment.id);
    assert.deepEqual(Buffer.from(await (await member.fetch(attachment.url.slice(4))).arrayBuffer()),bytes);
    await admin.request(`/sessions/${group.id}/members/${employee.id}`,{method:'DELETE',body:{}});
    assert.equal((await member.fetch(attachment.url.slice(4))).status,404);
  }finally{await fixture.close();}
});
