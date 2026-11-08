import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createFixture,session} from './auth-helpers.mjs';

const password='Public-mailbox-fixture-2026!';
const externalUrl='https://cdn.example.test/white.png?theme=white&version=1';
const linkedUrl='https://cdn.example.test/link-only.png';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1sAAAAASUVORK5CYII=','base64');
async function checked(client,route,options={},status=200){const result=await client.request(route,options);assert.equal(result.response.status,status,`${route}: ${JSON.stringify(result.data)}`);assert.ok(!JSON.stringify(result.data).includes('public-mailbox-fixture-secret'));return result.data;}
async function setup(t,mailboxOptions={},batched=false){
 const state={offline:false,externalOffline:false,recent:false,reads:0,richReads:0,richBatches:0,imageReads:0,externalReads:0,downloads:0,sends:0};
 const richHtml=`<p style="display:none">Formatted email<img src="cid:logo@example.test" onerror="alert(1)"><img src="${externalUrl.replace('&','&amp;')}"><a href="${linkedUrl}">Link only</a><a href="javascript:alert(1)">Link</a></p><script>bad()</script>`;
 const inlineImages=[{cid:'logo@example.test',mimeType:'image/png',data:png.toString('base64')}];
 const guard=r=>{r.guard();if(state.offline)throw new Error('Fixture provider offline');};
 const adapter={
  async folders(c,k,r){guard(r);return {folders:[{path:'INBOX',name:'Inbox',uidValidity:'501'},{path:'Sent',name:'Sent',specialUse:'\\Sent',uidValidity:'501'}]};},
  async search(c,k,r){guard(r);return {folder:r.folder,uidValidity:'501',messages:[{uid:r.folder==='INBOX'?9:10,subject:`Fixture ${r.folder} ${c.email}`,from:[{address:'sender@example.test'}],to:[{address:c.email}],seen:false,hasAttachments:true}],nextCursor:null};},
  async read(c,k,r){guard(r);state.reads++;const date=state.recent?new Date().toISOString():'2020-01-01T00:00:00.000Z';const uid=Number(r.uid);const rich=r.includeRichBody===true||r.includeRichBody==='reuse'||(typeof r.includeRichBody==='function'&&r.includeRichBody({uid,date}));const images=r.includeInlineImages===true||(typeof r.includeInlineImages==='function'&&r.includeInlineImages({uid,date}));return {uid,date,folder:r.folder,uidValidity:'501',subject:`Fixture ${r.folder} ${c.email}`,from:[{address:'sender@example.test'}],to:[{address:c.email}],text:'LOCAL_ARCHIVE_BUSINESS_BODY',attachments:[{part:'2',name:'确认单.txt',mimeType:'text/plain',size:16}],warnings:[],truncated:false,...(rich?{richBody:{html:richHtml}}:{}),...(images?{inlineImages:{images:inlineImages}}:{})};},
  async readRich(c,k,r){guard(r);state.richReads++;assert.equal(r.folder,'INBOX');assert.equal(String(r.uid),'9');assert.equal(r.uidValidity,'501');return {html:richHtml,images:r.includeImages===false?[]:inlineImages};},
  async readRichBatch(c,k,r){guard(r);state.richBatches++;for(const uid of r.uids){if(r.onStart(uid)!==false)r.onResult(uid,{body:{html:richHtml}});}},
  async readInlineImages(c,k,r){guard(r);state.imageReads++;assert.equal(String(r.uid),'9');assert.equal(r.uidValidity,'501');assert.match(r.html,/cid:logo@example.test/);assert.doesNotMatch(r.html,/onerror|script|style=|javascript:/);return {images:inlineImages};},
  async downloadAttachment(c,k,r){guard(r);state.downloads++;return {folder:r.folder,uid:Number(r.uid),uidValidity:'501',part:'2',name:'确认单.txt',mimeType:'text/plain',content:Buffer.from('archived attachment')};},
  async send(){state.sends++;throw new Error('Never send external mail');},
 };
 if(batched)adapter.readBatch=async(c,k,r)=>{
  guard(r);
  for(const uid of r.uids){
   if(r.onStart(uid)===false)continue;
   await state.beforeBody?.(r.folder,uid);
   const body=await adapter.read(c,k,{...r,uid});
   r.onResult(uid,{body});
  }
 };
 const externalImageFetcher=async (url,{signal})=>{
  if(state.externalOffline)throw new Error('Fixture image source offline');
  signal.throwIfAborted();assert.equal(url,externalUrl);state.externalReads++;
  await state.beforeExternalImage?.();
  return {content:png,mimeType:'image/png'};
 };
 const fixture=await createFixture({prefix:'public-mailbox-api',options:{mailbox:{...mailboxOptions,externalImageFetcher,autoStart:false},scheduler:{autoStart:false},channels:{autoStart:false},workTasks:{autoStart:false},email:{adapter,codec:async(op,value)=>Buffer.from(value).reverse()}}});t.after(()=>fixture.close());
 const admin=fixture.client(),employee=fixture.client(),guest=fixture.client();
 const adminUser=(await checked(admin,'/auth/setup',{method:'POST',body:{username:'public-mail-admin',displayName:'Public Mail Admin',password}},201)).user;
 const user=(await checked(admin,'/admin/users',{method:'POST',body:{username:'public-mail-member',displayName:'Public Mail Member',role:'member',password}},201)).user;
 await checked(employee,'/auth/login',{method:'POST',body:{username:user.username,password}});
 const group=await session(admin,'Restricted AI mail group');
 const create=async(address,extra={})=>(await checked(admin,'/admin/email-connections',{method:'POST',body:{name:address,email:address,enabled:true,scope:'none',groupIds:[],imap:{host:'imap.example.test',port:993,tls:'implicit',username:address,password:'public-mailbox-fixture-secret'},...extra}},201)).account;
 const first=await create('one@example.test'),second=await create('two@example.test',{scope:'groups',groupIds:[group.id]});
 const sync=async(id=first.id)=>{await checked(employee,`/mailbox/${id}/sync`,{method:'POST',body:{}});await fixture.server.piWeb.mailbox.whenIdle();};
 return {fixture,admin,adminUser,employee,guest,user,group,first,second,state,sync};
}

test('public mailbox supports multiple accounts without any agent membership and requires login',{timeout:30000},async t=>{
 const f=await setup(t);await checked(f.guest,'/mailbox/accounts',{},401);
 const accounts=(await checked(f.employee,'/mailbox/accounts')).accounts;assert.equal(accounts.length,2);assert.ok(accounts.every(value=>!('imap' in value)&&!('smtp' in value)));
 assert.deepEqual((await checked(f.employee,'/sessions?limit=100')).sessions,[]);
 await f.sync();
 const inbox=await checked(f.employee,`/mailbox/${f.first.id}/messages?folder=inbox`);assert.equal(inbox.messages.length,1);assert.equal(inbox.searchScope,'local_archive');
 const sent=await checked(f.employee,`/mailbox/${f.first.id}/messages?folder=sent`);assert.equal(sent.messages.length,1);
 const found=await checked(f.employee,`/mailbox/${f.first.id}/messages?folder=inbox&q=LOCAL_ARCHIVE_BUSINESS_BODY`);assert.equal(found.messages.length,1);
 assert.equal(f.state.sends,0);
});

test('rich mail is read only on request for a current public mailbox message',{timeout:30000},async t=>{
 const f=await setup(t);
 await f.sync();
 assert.equal(f.state.richReads,0);
 const route=`/mailbox/${f.first.id}/message-rich?folder=inbox&uid=9&uidValidity=501`;
 await checked(f.guest,route,{},401);
 await checked(f.employee,route.replace('uidValidity=501','uidValidity=502'),{},409);
 await checked(f.employee,route.replace('uid=9','uid=8'),{},404);
 assert.equal(f.state.richReads,0);
 const result=await f.employee.request(route);
 assert.equal(result.response.status,200);
 assert.match(result.response.headers.get('content-type'),/^application\/json/);
 assert.equal(result.response.headers.get('cache-control'),'no-store');
 assert.match(result.data.html,/Formatted email/);
 assert.equal(result.data.images[0].cid,'logo@example.test');
 assert.equal(f.state.richReads,1);
 assert.equal(f.state.downloads,0);
 assert.equal(f.fixture.server.piWeb.mailbox.db.prepare('SELECT count(*) AS n FROM mailbox_attachments').get().n,0);
});

test('HTML is sanitized and cached across restart, with CID bytes fetched separately on demand',{timeout:30000},async t=>{
 const f=await setup(t);await f.sync();
 const db=f.fixture.server.piWeb.mailbox.db;
 const route=`/mailbox/${f.first.id}/message-rich?folder=inbox&uid=9&uidValidity=501`;
 assert.equal(db.prepare('SELECT count(*) AS n FROM mailbox_rich_bodies').get().n,0);
 await checked(f.guest,`${route}&view=body`,{},401);
 await checked(f.employee,`${route.replace('501','502')}&view=body`,{},409);
 assert.deepEqual(await checked(f.employee,`${route}&view=images`),{images:[]});
 f.state.offline=true;
 await checked(f.employee,`${route}&view=body&local=0`,{},502);
 assert.equal(db.prepare('SELECT count(*) AS n FROM mailbox_rich_bodies').get().n,0);
 f.state.offline=false;
 const body=await checked(f.employee,`${route}&view=body&local=0`);
 assert.match(body.html,/Formatted email.*cid:logo@example.test/);
 assert.doesNotMatch(body.html,/onerror|script|style=|javascript:/);
 assert.equal(body.hasInlineImages,true);
 assert.ok(!('images' in body));
 assert.equal(db.prepare('SELECT html FROM mailbox_rich_bodies').get().html,body.html);
 assert.equal(f.state.richReads,1);assert.equal(f.state.imageReads,0);
 const waiting=await checked(f.employee,`${route}&view=images`);
 assert.equal(waiting.pending,true);assert.equal(f.state.imageReads,0);
 await f.sync();
 const pictures=await checked(f.employee,`${route}&view=images`);
 assert.equal(pictures.images[0].cid,'logo@example.test');assert.equal(f.state.imageReads,1);
 assert.equal(f.state.downloads,0);
 await f.fixture.stop();await f.fixture.start();
 f.state.offline=true;
 assert.deepEqual(await checked(f.employee,`${route}&view=body`),body);
 assert.deepEqual(await checked(f.employee,`${route}&view=images`),pictures);
 assert.equal(f.state.imageReads,1);
 assert.deepEqual(await checked(f.employee,`${route}&view=body`),body);
 assert.equal(f.state.richReads,1);
});

test('a normal rich body miss responds locally and prioritizes HTML for a later archive round',{timeout:30000},async t=>{
 const f=await setup(t);await f.sync();
 const route=`/mailbox/${f.first.id}/message-rich?folder=inbox&uid=9&uidValidity=501&view=body`;
 assert.equal((await checked(f.employee,`${route}&local=1`)).pending,true);
 assert.equal((await checked(f.employee,route)).pending,true);
 assert.equal(f.state.richReads,0);assert.equal(f.state.richBatches,0);assert.equal(f.state.imageReads,0);
 await f.sync();
 f.state.offline=true;
 const body=await checked(f.employee,`${route}&local=1`);
 assert.match(body.html,/Formatted email/);
 assert.ok(!body.pending);
 assert.equal(f.state.richReads,0);assert.equal(f.state.richBatches,1);assert.equal(f.state.imageReads,0);
});

test('recent mail archives local HTML and inline images together without ordinary attachment downloads',{timeout:30000},async t=>{
 const f=await setup(t);f.state.recent=true;await f.sync();f.state.offline=true;
 const route=`/mailbox/${f.first.id}/message-rich?folder=inbox&uid=9&uidValidity=501&view=body`;
 const body=await checked(f.employee,route);
 assert.match(body.html,/Formatted email/);
 assert.equal(body.hasInlineImages,true);
 assert.equal(f.state.richReads,0);assert.equal(f.state.imageReads,0);assert.equal(f.state.downloads,0);
});

test('opening a legacy summary can reuse HTML fetched for plaintext and returns the cache on the next open',{timeout:30000},async t=>{
 const f=await setup(t,{bodyBatchSize:0});f.state.recent=true;await f.sync();
 assert.equal(f.state.reads,0);
 const route=`/mailbox/${f.first.id}/message?folder=inbox&uid=9&uidValidity=501`;
 const message=(await checked(f.employee,route)).message;
 assert.equal(message.text,'LOCAL_ARCHIVE_BUSINESS_BODY');
 assert.match(message.richBody.html,/Formatted email/);
 assert.doesNotMatch(message.richBody.html,/onerror|script|style=|javascript:/);
 assert.equal(message.richBody.hasInlineImages,true);
 assert.equal(f.state.reads,1);assert.equal(f.state.richReads,0);assert.equal(f.state.imageReads,0);
 f.state.offline=true;
 assert.deepEqual((await checked(f.employee,route)).message.richBody,message.richBody);
 assert.equal(f.state.reads,1);assert.equal(f.state.richReads,0);
});

test('new mail appears after plaintext and HTML are stored and its first click works offline',{timeout:30000},async t=>{
 const f=await setup(t,{syncSince:'2019-08-01'},true);
 const started=Promise.withResolvers(),release=Promise.withResolvers();
 f.state.beforeBody=async folder=>{
  if(folder==='INBOX'){started.resolve();await release.promise;}
 };
 const folder=`/mailbox/${f.first.id}`;
 await checked(f.employee,`${folder}/sync`,{method:'POST',body:{}});
 try{
  await started.promise;
  const preparing=await checked(f.employee,`${folder}/messages?folder=inbox`);
  assert.equal(preparing.total,0);
  assert.equal(preparing.sync.archive.preparing,1);
  assert.equal(f.state.richReads,0);
 }finally{release.resolve();}
 await f.fixture.server.piWeb.mailbox.whenIdle();
 const listed=await checked(f.employee,`${folder}/messages?folder=inbox`);
 assert.equal(listed.total,1);
 assert.equal(listed.sync.archive.preparing,undefined);
 assert.equal(f.fixture.server.piWeb.mailbox.db.prepare('SELECT publish_after_archive FROM mailbox_messages WHERE uid=9').get().publish_after_archive,0);
 const reads=f.state.reads;
 f.state.offline=true;
 const message=(await checked(f.employee,`${folder}/message?folder=inbox&uid=9&uidValidity=501`)).message;
 assert.equal(message.text,'LOCAL_ARCHIVE_BUSINESS_BODY');
 assert.match(message.richBody.html,/Formatted email/);
 assert.equal(message.richBody.hasInlineImages,true);
 assert.equal(f.state.reads,reads);assert.equal(f.state.richReads,0);assert.equal(f.state.imageReads,0);
 const images=await checked(f.employee,`${folder}/message-rich?folder=inbox&uid=9&uidValidity=501&view=images`);
 assert.equal(images.images[0].data,png.toString('base64'));
 assert.ok(!images.pending);assert.equal(f.state.imageReads,0);
});

test('external pictures are fetched only by authorized POST for a referenced img URL',{timeout:30000},async t=>{
 const f=await setup(t);f.state.recent=true;await f.sync();
 const route=`/mailbox/${f.first.id}/message-rich?folder=inbox&uid=9&uidValidity=501&view=external-image`;
 const request={method:'POST',body:{url:externalUrl}};
 assert.equal(f.state.externalReads,0);
 await checked(f.guest,route,request,401);
 await checked(f.employee,route,{},405);
 await checked(f.employee,route.replace('501','502'),request,409);
 await checked(f.employee,route,{method:'POST',body:{url:linkedUrl}},404);
 await checked(f.employee,route,{method:'POST',body:{url:externalUrl.replace('version=1','version=2')}},404);
 assert.equal(f.state.externalReads,0);
 const picture=await f.employee.fetch(route,request);
 assert.equal(picture.status,200);
 assert.equal(picture.headers.get('content-type'),'image/png');
 assert.equal(picture.headers.get('cache-control'),'private, no-store');
 assert.equal(picture.headers.get('cross-origin-resource-policy'),'same-origin');
 assert.deepEqual(Buffer.from(await picture.arrayBuffer()),png);
 assert.equal(f.state.externalReads,1);

 await f.fixture.stop();await f.fixture.start();f.state.externalOffline=true;
 const repeated=await f.employee.fetch(route,request);
 assert.deepEqual(Buffer.from(await repeated.arrayBuffer()),png);assert.equal(f.state.externalReads,1);
 f.state.externalOffline=false;
 f.fixture.server.piWeb.mailbox.db.exec('DELETE FROM mailbox_external_image_cache');
 const started=Promise.withResolvers(),release=Promise.withResolvers();
 f.state.beforeExternalImage=()=>{started.resolve();return release.promise;};
 const held=f.employee.fetch(route,request);
 try{
  await started.promise;
  await checked(f.admin,`/admin/email-connections/${f.first.id}`,{method:'PUT',body:{enabled:false}});
 }finally{release.resolve();}
 assert.equal((await held).status,403);
});

test('mailbox fetches and parses attachments only on demand and keeps old local copies readable',{timeout:30000},async t=>{
 const f=await setup(t);
 await f.sync();
 assert.ok(f.state.reads>=2);
 assert.equal(f.state.downloads,0);
 const context={actor:f.adminUser,mailboxPublic:true};
 const key=f.fixture.server.piWeb.mailbox.archiveKey(f.first.id,context);
 const reference={folder:'inbox',uid:9,uidValidity:'501',part:'2'};
 const {attachment}=await checked(f.employee,`/mailbox/${f.first.id}/attachment`,{method:'POST',body:reference});
 const attachmentRoute=attachment.downloadUrl.replace(/^\/api/,'');
 assert.equal(f.state.downloads,0);
 assert.equal(attachment.name,'确认单.txt');
 await checked(f.guest,attachmentRoute,{},401);
 await checked(f.employee,attachmentRoute.replace(f.first.id,f.second.id),{},409);
 await checked(f.employee,attachmentRoute.replace('-501-2','-502-2'),{},409);
 await checked(f.employee,attachmentRoute.replace('-501-2','-501-3'),{},404);
 assert.equal(f.state.downloads,0);

 const file=await f.employee.fetch(attachmentRoute);
 assert.equal(file.status,200);
 assert.match(file.headers.get('content-disposition'),/^attachment;.*filename\*=UTF-8''/);
 assert.match(file.headers.get('cache-control'),/no-store/);
 assert.equal(await file.text(),'archived attachment');
 const preview=await checked(f.employee,`${attachmentRoute.split('?')[0]}/content`);
 assert.equal(preview.document.status,'ready');
 assert.match(preview.document.text,/archived attachment/);
 assert.equal(f.state.downloads,2);
 assert.equal(f.fixture.server.piWeb.mailbox.db.prepare('SELECT count(*) AS n FROM mailbox_attachments').get().n,0);

 const legacy=await f.fixture.server.piWeb.mailboxFiles.acquire({
  accountId:f.first.id,archiveId:key.archiveId,reference:{...reference,folder:'INBOX'},
  read:async()=>({name:'确认单.txt',mimeType:'text/plain',content:Buffer.from('previous local copy')})
 });
 await f.fixture.stop();
 await f.fixture.start();
 f.state.offline=true;
 const reads=f.state.reads,downloads=f.state.downloads;
 const message=(await checked(f.employee,`/mailbox/${f.first.id}/message?folder=inbox&uid=9&uidValidity=501`)).message;
 assert.equal(message.text,'LOCAL_ARCHIVE_BUSINESS_BODY');
 const local=await f.employee.fetch(legacy.downloadUrl.replace(/^\/api/,''));
 assert.equal(local.status,200);
 assert.equal(await local.text(),'previous local copy');
 assert.equal(f.state.reads,reads);
 assert.equal(f.state.downloads,downloads);
 await checked(f.admin,`/admin/email-connections/${f.first.id}`,{method:'PUT',body:{name:'Renamed public account',scope:'groups',groupIds:[f.group.id]}});
 assert.equal(f.fixture.server.piWeb.mailbox.archiveKey(f.first.id,context).archiveId,key.archiveId);
 const after=(await checked(f.employee,`/mailbox/${f.first.id}/message?folder=inbox&uid=9&uidValidity=501`)).message;
 assert.equal(after.text,message.text);
 assert.equal((await f.employee.fetch(legacy.downloadUrl.replace(/^\/api/,''))).status,200);
});

test('public visibility does not grant AI access or sends and disabled users/accounts lose local archives immediately',{timeout:30000},async t=>{
 const f=await setup(t);await f.sync();
 await checked(f.admin,`/sessions/${f.group.id}/members`,{method:'POST',body:{userIds:[f.user.id]}});
 const skill=(await checked(f.admin,'/admin/email-connections/install-skills',{method:'POST',body:{}},200)).skill;
 await checked(f.admin,`/admin/skills/${skill.id}`,{method:'PATCH',body:{enabled:true,scope:'groups',groupIds:[f.group.id]}});
 const aiAccounts=(await checked(f.employee,`/sessions/${f.group.id}/email/accounts`)).accounts;assert.deepEqual(aiAccounts.map(value=>value.id),[f.second.id]);
 await checked(f.employee,`/sessions/${f.group.id}/email/accounts/${f.first.id}/read`,{method:'POST',body:{folder:'INBOX',uid:9,uidValidity:'501'}},403);
 await checked(f.employee,`/mailbox/${f.first.id}/send`,{method:'POST',body:{}},404);
 await checked(f.employee,'/admin/email-connections',{method:'POST',body:{}},403);
 await checked(f.admin,`/admin/email-connections/${f.first.id}`,{method:'PUT',body:{enabled:false}});
 await checked(f.employee,`/mailbox/${f.first.id}/messages`,{},403);
 assert.ok(f.fixture.server.piWeb.mailbox.db.prepare('SELECT COUNT(*) AS n FROM mailbox_messages WHERE account_id=?').get(f.first.id).n>0);
 await checked(f.admin,`/admin/users/${f.user.id}`,{method:'PATCH',body:{disabled:true}});
 await checked(f.employee,'/mailbox/accounts',{},401);assert.equal(f.state.sends,0);
});
