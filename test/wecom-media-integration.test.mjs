import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createFixture, configure, session } from './auth-helpers.mjs';
import { attachmentMarkdown } from '../lib/attachment-output.mjs';
import { createWecomWebhookSender } from '../lib/wecom-webhook.mjs';

async function until(check) {
  const end=Date.now()+12000;
  while(Date.now()<end){if(await check())return;await new Promise(resolve=>setTimeout(resolve,15));}
  throw new Error('Timed out waiting for isolated enterprise media delivery');
}
async function fixtureFor(t, sender) {
  const sent=[];
  const fixture=await createFixture({prefix:'wecom-media-api',options:{scheduler:{autoStart:false},channels:{wecom:{
    clientFactory:()=>assert.fail('No enterprise network connection is allowed in media integration tests'),
    webhookIntervalMs:0,pollIntervalMs:10,
    webhookSender:async value=>{if(sender)await sender(value);sent.push({messageType:value.messageType||'markdown',text:value.text,clientId:value.clientId,
      ...(value.attachment?{attachment:{name:value.attachment.name,mimeType:value.attachment.mimeType,content:Buffer.from(value.attachment.content)}}:{})});},
  }}}});
  t.after(()=>fixture.close());
  const admin=fixture.client(),password='Media-api-fixture-password-2026!';
  const setup=await admin.request('/auth/setup',{method:'POST',body:{username:'media-admin',displayName:'测试管理员',password}});
  await configure(admin,fixture);
  const made=await admin.request('/admin/channels',{method:'POST',body:{type:'wecom',name:'附件结果群',connectionMode:'webhook',
    webhookUrl:'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=fixture-enterprise-media'}});
  assert.equal(made.response.status,201);
  const created=await admin.request('/sessions',{method:'POST',body:{title:'附件助手',channelIds:[made.data.channel.id]}});
  assert.equal(created.response.status,201);
  const chat=created.data.session;
  await admin.request(`/sessions/${chat.id}`,{method:'PATCH',body:{mode:'workspace'}});
  return {fixture,admin,chat,sent,user:setup.data.user,channelId:made.data.channel.id};
}
function registry(fixture,groupId){return fixture.server.piWeb.channels.store.db.prepare('SELECT id,name,size,mime_type AS mimeType,kind FROM attachments WHERE session_id=? ORDER BY rowid').all(groupId)
  .map(row=>({...row,url:`/api/sessions/${groupId}/attachments/${row.id}`}));}

test('real Pi attach_file results deliver image and PDF bytes through the selected group Webhook', {timeout:120000}, async t=>{
  const {fixture,admin,chat,sent}=await fixtureFor(t);
  const pdf=Buffer.from('%PDF-1.4\nWebhook integration report.\n%%EOF');
  await fs.writeFile(path.join(chat.cwd,'检查报告.pdf'),pdf);
  await admin.send(chat.id,'[attach-file:检查报告.pdf] [omit-attachment-link]');
  await until(()=>sent.some(item=>item.messageType==='file'));
  const file=sent.find(item=>item.messageType==='file');
  assert.equal(file.attachment.name,'检查报告.pdf');assert.deepEqual(file.attachment.content,pdf);
  assert.equal(sent.filter(item=>item.messageType==='file').length,1);
  const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jH1sAAAAASUVORK5CYII=','base64');
  await fs.writeFile(path.join(chat.cwd,'检查截图.png'),image);
  await admin.send(chat.id,'[attach-file:检查截图.png] [omit-attachment-link]');
  await until(()=>sent.some(item=>item.messageType==='image'));
  assert.deepEqual(sent.find(item=>item.messageType==='image').attachment.content,image);
  const assistantText=sent.filter(item=>item.messageType==='markdown'&&item.text?.startsWith('Pi：'));
  assert.ok(assistantText.length>=2);
  assert.ok(assistantText.every(item=>!item.text.includes('/api/sessions/')),'native media replaces broken internal attachment links in enterprise replies');
  const history=(await admin.request(`/sessions/${chat.id}`)).data.messages;
  assert.ok(history.some(item=>item.role==='assistant'&&item.content?.includes('/attachments/')),'Web downloads remain available');
  const outbox=JSON.stringify(fixture.server.piWeb.channels.store.db.prepare('SELECT message_type,attachment_id,text FROM wecom_outbox').all());
  assert.ok(!outbox.includes(image.toString('base64')));assert.ok(!outbox.includes(chat.cwd),'media queues never persist arbitrary file paths or bytes');
});

test('scheduled reports snapshot registered attachments and never resend acknowledged file chunks', {timeout:120000},async t=>{
  const {fixture,admin,chat,sent,user}=await fixtureFor(t);
  const bytes=Buffer.from('FC,预约数量\nLGB8,3\n');
  await fs.writeFile(path.join(chat.cwd,'日报.csv'),bytes);
  await admin.send(chat.id,'[attach-file:日报.csv] [omit-attachment-link]');
  await until(()=>sent.some(item=>item.messageType==='file'));
  const report=registry(fixture,chat.id)[0];
  const payload={schedule:{name:'附件日报',targetSessionId:chat.id,createdBy:user.id},run:{id:'media-scheduled-report'},result:`检查完成。\n\n${attachmentMarkdown(report)}`};
  const delivered=await fixture.server.piWeb.taskDelivery.deliver(payload);
  assert.equal(delivered.status,'delivered');
  await until(()=>fixture.server.piWeb.channels.deliveryStatus('task:media-scheduled-report')?.pending===0);
  assert.equal(sent.filter(item=>item.messageType==='file').length,2,'the scheduled result includes its file once');
  assert.deepEqual(fixture.server.piWeb.channels.deliveryStatus('task:media-scheduled-report'),{queued:2,sent:2,failed:0,pending:0});
  const saved=JSON.parse(fixture.server.piWeb.channels.store.db.prepare('SELECT payload FROM task_channel_batches WHERE message_id=?').get('task:media-scheduled-report').payload);
  assert.deepEqual(saved.attachments,[{id:report.id}]);
  fixture.server.piWeb.channels.retryDelivery('task:media-scheduled-report');
  await new Promise(resolve=>setTimeout(resolve,35));
  assert.equal(sent.filter(item=>item.messageType==='file').length,2);
});

test('file-only discussions send their snapshot and cross-group Markdown never reads another group attachment',async t=>{
  const {fixture,admin,chat,sent}=await fixtureFor(t);
  const bytes=Buffer.from('file-only-discussion-snapshot');
  const response=await fetch(`${fixture.baseUrl}/api/sessions/${chat.id}/attachments?name=message.txt`,{
    method:'POST',headers:{cookie:admin.cookie,'content-type':'application/octet-stream'},body:bytes});
  assert.equal(response.status,201);const uploaded=(await response.json()).attachment;
  const posted=await admin.request(`/sessions/${chat.id}/discussion`,{method:'POST',body:{content:'',attachmentIds:[uploaded.id]}});
  assert.equal(posted.response.status,201,JSON.stringify(posted.data));
  await until(()=>sent.some(item=>item.messageType==='file'));
  assert.deepEqual(sent.find(item=>item.messageType==='file').attachment.content,bytes);
  const other=await session(admin,'另外的资料群');
  const fake=`[伪造](/api/sessions/${other.id}/attachments/${uploaded.id})`;
  const before=sent.filter(item=>item.attachment).length;
  fixture.server.piWeb.channels.publish(chat.id,{text:fake,messageId:'forged-cross-group'});
  await until(()=>sent.some(item=>item.text?.includes('伪造')));
  assert.equal(sent.filter(item=>item.attachment).length,before);
});

test('Pi-produced PDF reaches the actual multipart uploader and the provider-confirmed file envelope', {timeout:120000},async t=>{
  const wire=[];
  const sender=createWecomWebhookSender({fetchImpl:async(url,options)=>{
    const parsed=new URL(url);assert.equal(parsed.hostname,'qyapi.weixin.qq.com');
    if(parsed.pathname.endsWith('/upload_media')){
      assert.equal(parsed.searchParams.get('type'),'file');
      const media=options.body.get('media');
      wire.push({kind:'upload',name:media.name,bytes:Buffer.from(await media.arrayBuffer())});
      return new Response(JSON.stringify({errcode:0,type:'file',media_id:'fixture-confirmed-media'}));
    }
    const body=JSON.parse(options.body);wire.push(body);
    return new Response(JSON.stringify({errcode:0}));
  }});
  const {admin,chat,sent}=await fixtureFor(t,sender);
  const bytes=Buffer.from('%PDF-1.4\nFinal native enterprise file report.\n%%EOF');
  await fs.writeFile(path.join(chat.cwd,'企微最终报告.pdf'),bytes);
  await admin.send(chat.id,'[attach-file:企微最终报告.pdf] [omit-attachment-link]');
  await until(()=>sent.some(item=>item.messageType==='file'));
  const upload=wire.find(item=>item.kind==='upload');
  assert.equal(upload.name,'企微最终报告.pdf');assert.deepEqual(upload.bytes,bytes);
  assert.deepEqual(wire.find(item=>item.msgtype==='file'),{msgtype:'file',file:{media_id:'fixture-confirmed-media'}});
});
