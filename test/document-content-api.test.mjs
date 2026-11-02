import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {createFixture,configure,session} from './auth-helpers.mjs';
import {makePdf,makeDocx,makeXlsx} from './document-fixtures.mjs';

async function upload(f,client,group,name,bytes){
 const response=await fetch(`${f.baseUrl}/api/sessions/${group.id}/attachments?name=${encodeURIComponent(name)}`,{method:'POST',headers:{cookie:client.cookie,'content-type':'application/octet-stream'},body:bytes});
 const data=await response.json();assert.equal(response.status,201,JSON.stringify(data));return data.attachment;
}
async function finished(client,group,id){for(let i=0;i<300;i++){const data=(await client.request(`/sessions/${group.id}/tasks/${id}`)).data.task;if(!['queued','running'].includes(data.status))return data;await delay(30);}throw new Error('Document fixture task did not finish');}

test('member document previews and real SDK document tools share bounded parsed contents without exposing paths', {timeout:120000},async()=>{
 const fixture=await createFixture({prefix:'document-preview',options:{scheduler:{autoStart:false},channels:{autoStart:false}}});
 const admin=fixture.client(),member=fixture.client(),outsider=fixture.client(),password='document-fixture-password';
 try{
  await admin.request('/auth/setup',{method:'POST',body:{username:'doc-admin',displayName:'Admin',password}});
  const employee=(await admin.request('/admin/users',{method:'POST',body:{username:'doc-member',displayName:'Member',password,role:'member'}})).data.user;
  await admin.request('/admin/users',{method:'POST',body:{username:'doc-outsider',displayName:'Outsider',password,role:'member'}});
  await member.request('/auth/login',{method:'POST',body:{username:'doc-member',password}});await outsider.request('/auth/login',{method:'POST',body:{username:'doc-outsider',password}});
  await configure(admin,fixture);const group=await session(admin,'Document group'),other=await session(admin,'Other group');
  await admin.request(`/sessions/${group.id}/members`,{method:'POST',body:{userIds:[employee.id]}});
  const pdf=await upload(fixture,member,group,'shipment-report.pdf',makePdf(['PDF_SHIPMENT_8391 UnitCount 57','PAGE_TWO_VERIFIED_4829']));
  const docx=await upload(fixture,member,group,'操作手册.docx',makeDocx(['业务资料正文','DOCX_CONTENT_VERIFIED_3829']));
  const xlsx=await upload(fixture,member,group,'预约报表.xlsx',await makeXlsx([{name:'预约明细',rows:[['Shipment','UnitCount'],['XLSX_SHIPMENT_1928',57]]}]));
  for(const [item,marker,format] of [[pdf,'PDF_SHIPMENT_8391','pdf'],[docx,'DOCX_CONTENT_VERIFIED_3829','docx'],[xlsx,'XLSX_SHIPMENT_1928','xlsx']]){
   const reply=await member.request(`${item.url.slice(4)}/content`);assert.equal(reply.response.status,200,JSON.stringify(reply.data));
   assert.equal(reply.data.document.format,format);assert.equal(reply.data.document.status,'ready');assert.match(reply.data.document.text,new RegExp(marker));
   assert.doesNotMatch(JSON.stringify(reply.data),/attachment-inbox|filePath|[A-Z]:\\/);
   assert.equal((await outsider.request(`${item.url.slice(4)}/content`)).response.status,404);
   assert.equal((await admin.request(`/sessions/${other.id}/attachments/${item.id}/content`)).response.status,404);
  }
  const preview=(await member.request(`${pdf.url.slice(4)}/content`)).data.document;
  assert.equal(preview.pageCount,2);assert.equal(preview.sections[1].page,2);assert.match(preview.sections[1].text,/PAGE_TWO_VERIFIED/);
  const malicious=await upload(fixture,member,group,'fake-report.pdf',Buffer.from('<script>UNSAFE_DOCUMENT_JS</script>'));
  const bad=(await member.request(`${malicious.url.slice(4)}/content`)).data.document;assert.equal(bad.status,'error');assert.equal(bad.text,'');assert.doesNotMatch(JSON.stringify(bad),/UNSAFE_DOCUMENT_JS/);
  const unsupported=await upload(fixture,member,group,'legacy.doc',Buffer.from('not a document'));
  assert.equal((await member.request(`${unsupported.url.slice(4)}/content`)).data.document.status,'unsupported');
  // Read-only groups can use the fixed document parser without shell execution.
  const submit=await member.request(`/sessions/${group.id}/tasks`,{method:'POST',body:{instruction:`[read-document:${pdf.id}] Read this PDF.`,attachmentIds:[pdf.id],clientRequestId:'read-real-pdf'}});
  assert.equal(submit.response.status,202,JSON.stringify(submit.data));const task=await finished(member,group,submit.data.task.id);
  assert.equal(task.status,'succeeded',task.error);assert.match(task.result,/PDF_SHIPMENT_8391/);
  assert.ok(fixture.mock.requests.some(request=>JSON.stringify(request.messages).includes('call_read_document')));
  // A generic read on a registered document is transparently parsed, never binary UTF-8.
  const read=await member.request(`/sessions/${group.id}/tasks`,{method:'POST',body:{instruction:'[read-incoming-attachment] Read the DOCX.',attachmentIds:[docx.id],clientRequestId:'read-docx-path'}});
  const docTask=await finished(member,group,read.data.task.id);assert.equal(docTask.status,'succeeded',docTask.error);assert.match(docTask.result,/DOCX_CONTENT_VERIFIED_3829/);
  assert.doesNotMatch(docTask.result,/word\/document\.xml|PK\\u0003/);
  const inbox=await fs.readdir(`${fixture.dataDir}/attachment-inbox`,{recursive:true,withFileTypes:true});assert.ok(inbox.every(entry=>!entry.isFile()),'parser and task temporary copies must be reclaimed');
  await admin.request(`/sessions/${group.id}/members/${employee.id}`,{method:'DELETE',body:{}});
  assert.equal((await member.request(`${pdf.url.slice(4)}/content`)).response.status,404,'cached documents must recheck membership');
 }finally{await fixture.close();}
});
