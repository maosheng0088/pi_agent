import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createFixture, session } from './auth-helpers.mjs';

const PASSWORD='Email-api-fixture-only-2026!', IMAP_SECRET='fixture-imap-private-only', SMTP_SECRET='fixture-smtp-private-only';
const base='/admin/email-connections';
function codec(){const key=randomBytes(32);return async(operation,value)=>{if(operation==='protect'){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),bytes=Buffer.concat([cipher.update(value),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),bytes]);}const bytes=Buffer.from(value),decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));decipher.setAuthTag(bytes.subarray(12,28));return Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]);};}
function config(groupIds=[],extra={}){return {name:'Fixture mailbox',email:'team@example.test',fromName:'Fixture team',enabled:false,allowSend:false,scope:groupIds.length?'groups':'all',groupIds,imap:{host:'imap.example.test',port:993,tls:'implicit',username:'imap-fixture',password:IMAP_SECRET},...extra};}
function smtp(){return {host:'smtp.example.test',port:587,tls:'starttls',username:'smtp-fixture',password:SMTP_SECRET};}
function noSecrets(value){const text=JSON.stringify(value);for(const secret of [IMAP_SECRET,SMTP_SECRET])assert.ok(!text.includes(secret),'public response must not contain a mailbox credential');}
function noCredentialFields(value){if(!value||typeof value!=='object')return;for(const [key,item] of Object.entries(value)){assert.ok(!['password','imapPassword','smtpPassword','credentials'].includes(key),`plaintext credential field ${key} must not be persisted in public account configuration`);noCredentialFields(item);}}
async function checked(client,route,options={},status=200){const result=await client.request(route,options);assert.equal(result.response.status,status,`${route}: ${JSON.stringify(result.data)}`);noSecrets(result.data);return result.data;}
function fakeAdapter(){
 const state={calls:[],checkError:null,imapReady:true,smtpReady:true,sendError:null,slowSearch:null};
 const record=(name,configuration,credentials,runtime)=>{runtime.guard();assert.equal(credentials.imapPassword,IMAP_SECRET);if(configuration.smtp)assert.equal(credentials.smtpPassword,SMTP_SECRET);state.calls.push({name,configuration,credentials,runtime});};
 const adapter={
  async check(c,k,r){record('check',c,k,r);if(state.checkError)throw state.checkError;return {imapReady:state.imapReady,smtpReady:c.smtp?state.smtpReady:false};},
  async folders(c,k,r){record('folders',c,k,r);return {folders:[{path:'INBOX',name:'Inbox',uidValidity:'123',messages:1,unseen:1}],truncated:false};},
  async search(c,k,r){record('search',c,k,r);if(state.slowSearch)return state.slowSearch(r);return {folder:r.folder,uidValidity:'123',messages:[{uid:7,subject:'FIXTURE_MAIL_QUERY_RESULT',from:[{address:'client@example.test'}]}],truncated:false};},
  async read(c,k,r){record('read',c,k,r);return {uid:7,folder:r.folder,uidValidity:'123',subject:'Fixture mail',text:'FIXTURE_MAIL_PLAIN_BODY',attachments:[{part:'2',name:'fixture.txt',mimeType:'text/plain',size:23}],warnings:[],truncated:false};},
  async downloadAttachment(c,k,r){record('attachment',c,k,r);return {uid:7,folder:r.folder,uidValidity:'123',part:'2',name:'fixture.txt',mimeType:'text/plain',content:Buffer.from('FIXTURE_ATTACHMENT_DATA')};},
  async send(c,k,r){record('send',c,k,r);if(state.sendError)throw state.sendError;return {accepted:r.draft.to,rejected:[],messageId:'<fixture-out@example.test>'};},
 };
 return {adapter,state};
}
async function setup(t){
 const {adapter,state}=fakeAdapter(),fixture=await createFixture({prefix:'email-api',options:{channels:{autoStart:false},scheduler:{autoStart:false},workTasks:{autoStart:false},email:{adapter,codec:codec(),operationTimeout:3000}}});t.after(()=>fixture.close());
 const admin=fixture.client(),member=fixture.client(),outsider=fixture.client(),guest=fixture.client();
 await checked(admin,'/auth/setup',{method:'POST',body:{username:'email-admin',displayName:'Mail Administrator',password:PASSWORD}},201);
 const users={};for(const [name,client] of [['member',member],['outsider',outsider]]){users[name]=(await checked(admin,'/admin/users',{method:'POST',body:{username:`email-${name}`,displayName:`Mail ${name}`,role:'member',password:PASSWORD}},201)).user;await checked(client,'/auth/login',{method:'POST',body:{username:users[name].username,password:PASSWORD}});}
 const group=await session(admin,'Mail assigned group'),other=await session(admin,'Mail other group');
 await checked(admin,`/sessions/${group.id}/members`,{method:'POST',body:{userIds:[users.member.id]}});await checked(admin,`/sessions/${other.id}/members`,{method:'POST',body:{userIds:[users.member.id]}});
 return {fixture,admin,member,outsider,guest,group,other,users,state};
}
async function install(f,groupIds=[f.group.id]){const skill=(await checked(f.admin,`${base}/install-skills`,{method:'POST',body:{}})).skill;await checked(f.admin,`/admin/skills/${skill.id}`,{method:'PATCH',body:{enabled:true,scope:'groups',groupIds}});return skill;}
async function account(f,extra={}){return (await checked(f.admin,base,{method:'POST',body:config([f.group.id],extra)},201)).account;}
const mail=(group,suffix='')=>`/sessions/${group.id}/email${suffix}`;
const draftBody=(accountId,clientRequestId='fixture-draft')=>({accountId,to:['client@example.test'],subject:'Fixture shipping update',text:'Please check the fixture appointment.',clientRequestId});

test('email configuration endpoints require an administrator and do not connect on startup',{timeout:30000},async t=>{
 const f=await setup(t),id='00000000-0000-4000-8000-000000000000';
 for(const [method,route,body] of [['GET',base],['POST',base,config()],['PUT',`${base}/${id}`,{name:'Changed'}],['DELETE',`${base}/${id}`,{}],['POST',`${base}/${id}/check`,{}],['POST',`${base}/install-skills`,{}]]){
  const options={method,...(body===undefined?{}:{body})};await checked(f.member,route,options,403);await checked(f.guest,route,options,401);
 }
 assert.deepEqual((await checked(f.admin,base)).accounts,[]);assert.equal(f.state.calls.length,0);
});

test('email CRUD encrypts credentials, preserves blank updates, and supports receive-only accounts',{timeout:30000},async t=>{
 const f=await setup(t),created=await account(f);assert.equal(created.enabled,false);assert.equal(created.allowSend,false);assert.equal(created.status,'not_checked');assert.equal(created.imap.passwordSet,true);assert.equal(created.smtp,null);assert.equal(f.state.calls.length,0);
 const saved=await checked(f.admin,`${base}/${created.id}`,{method:'PUT',body:{name:'Updated mailbox',imap:{password:''}}});assert.equal(saved.account.name,'Updated mailbox');assert.equal(saved.account.imap.passwordSet,true);
 const row=f.fixture.server.piWeb.email.db.prepare('SELECT config_json,credentials_ciphertext FROM email_accounts WHERE id=?').get(created.id);assert.ok(row.credentials_ciphertext);noSecrets(row);noCredentialFields(JSON.parse(row.config_json));
 const result=await checked(f.admin,`${base}/${created.id}/check`,{method:'POST',body:{}});assert.equal(result.account.status,'ready');assert.equal(result.account.imapReady,true);assert.equal(result.account.smtpReady,false);assert.equal(f.state.calls.filter(call=>call.name==='check').length,1);assert.equal(f.state.calls.filter(call=>call.name==='send').length,0);
 await checked(f.admin,`${base}/${created.id}`,{method:'DELETE',body:{}});assert.deepEqual((await checked(f.admin,base)).accounts,[]);assert.equal(f.fixture.server.piWeb.email.db.prepare('SELECT credentials_ciphertext FROM email_accounts WHERE id=?').get(created.id).credentials_ciphertext,null);
});

test('mail skill installs disabled, preserves scope on repair, and readiness requires a successful probe',{timeout:30000},async t=>{
 const f=await setup(t),installed=(await checked(f.admin,`${base}/install-skills`,{method:'POST',body:{}})).skill;assert.equal(installed.name,'email-workspace');assert.equal(installed.enabled,false);assert.equal(f.state.calls.length,0);
 await checked(f.admin,`/admin/skills/${installed.id}`,{method:'PATCH',body:{enabled:true,scope:'groups',groupIds:[f.group.id]}});
 const repaired=(await checked(f.admin,`${base}/install-skills`,{method:'POST',body:{}})).skill;assert.equal(repaired.id,installed.id);assert.equal(repaired.enabled,true);assert.equal(repaired.scope,'groups');assert.deepEqual(repaired.groupIds,[f.group.id]);assert.equal((await checked(f.admin,base)).skill.id,installed.id);
 const value=await account(f,{smtp:smtp(),allowSend:true});f.state.checkError=new Error(`Unauthorized ${IMAP_SECRET} ${SMTP_SECRET}`);let result=await checked(f.admin,`${base}/${value.id}/check`,{method:'POST',body:{}});assert.equal(result.account.status,'error');assert.ok(result.account.checkedAt);
 f.state.checkError=null;f.state.smtpReady=false;result=await checked(f.admin,`${base}/${value.id}/check`,{method:'POST',body:{}});assert.equal(result.account.status,'error');f.state.smtpReady=true;result=await checked(f.admin,`${base}/${value.id}/check`,{method:'POST',body:{}});assert.equal(result.account.status,'ready');assert.equal(f.state.calls.filter(call=>call.name==='send').length,0);
});

test('mail reads require group membership plus both skill and account scopes',{timeout:30000},async t=>{
 const f=await setup(t),value=await account(f,{enabled:true}),route=mail(f.group,`/accounts/${value.id}`);
 await checked(f.member,`${route}/messages`,{method:'POST',body:{query:{subject:'fixture'},limit:10}},403);
 const skill=await install(f,[f.group.id,f.other.id]);const available=(await checked(f.member,mail(f.group,'/accounts'))).accounts;assert.equal(available.length,1);assert.equal(available[0].id,value.id);assert.ok(!JSON.stringify(available).includes('imap.example.test'));
 const folders=await checked(f.member,`${route}/folders`);assert.equal(folders.folders[0].path,'INBOX');const found=await checked(f.member,`${route}/messages`,{method:'POST',body:{folder:'INBOX',query:{subject:'fixture'},limit:10}});assert.equal(found.messages[0].subject,'FIXTURE_MAIL_QUERY_RESULT');const read=await checked(f.member,`${route}/read`,{method:'POST',body:{folder:'INBOX',uid:7,uidValidity:'123'}});assert.equal(read.message.text,'FIXTURE_MAIL_PLAIN_BODY');
 await checked(f.outsider,`${route}/folders`,{},404);await checked(f.guest,`${route}/folders`,{},401);await checked(f.member,mail(f.other,`/accounts/${value.id}/folders`),{},403);assert.deepEqual((await checked(f.member,mail(f.other,'/accounts'))).accounts,[]);
 const calls=f.state.calls.length;await checked(f.admin,`/admin/skills/${skill.id}`,{method:'PATCH',body:{enabled:false}});await checked(f.member,`${route}/folders`,{},403);assert.equal(f.state.calls.length,calls);
 await checked(f.admin,`/admin/skills/${skill.id}`,{method:'PATCH',body:{enabled:true}});await checked(f.admin,`${base}/${value.id}`,{method:'PUT',body:{enabled:false}});await checked(f.member,`${route}/folders`,{},403);assert.equal(f.state.calls.length,calls);
});

test('readonly agents can prepare and inspect drafts but cannot send, and allowSend is enforced',{timeout:30000},async t=>{
 const f=await setup(t);await install(f,[f.group.id,f.other.id]);const value=await account(f,{enabled:true}),draft=(await checked(f.member,mail(f.group,'/drafts'),{method:'POST',body:draftBody(value.id)},201)).draft;assert.equal(draft.status,'draft');assert.equal(f.state.calls.length,0);
 assert.equal((await checked(f.member,mail(f.group,`/drafts/${draft.id}`))).draft.id,draft.id);assert.equal((await checked(f.member,mail(f.group,'/drafts'))).drafts.length,1);
 await checked(f.member,mail(f.group,`/drafts/${draft.id}`),{method:'PUT',body:{to:['client@example.test'],subject:'Revised',text:'Revised fixture'} });
 await checked(f.member,mail(f.group,`/drafts/${draft.id}/send`),{method:'POST',body:{idempotencyKey:'readonly-cannot-send'}},403);
 await checked(f.admin,`/sessions/${f.group.id}`,{method:'PATCH',body:{mode:'workspace'}});await checked(f.member,mail(f.group,`/drafts/${draft.id}/send`),{method:'POST',body:{idempotencyKey:'disabled-cannot-send'}},403);assert.equal(f.state.calls.filter(call=>call.name==='send').length,0);
 await checked(f.member,mail(f.other,`/drafts/${draft.id}`),{},404);
});

test('sending is persisted once and an unknown SMTP outcome never retries the same draft',{timeout:30000},async t=>{
 const f=await setup(t);await install(f);await checked(f.admin,`/sessions/${f.group.id}`,{method:'PATCH',body:{mode:'workspace'}});const value=await account(f,{enabled:true,allowSend:true,smtp:smtp()});
 const draft=(await checked(f.member,mail(f.group,'/drafts'),{method:'POST',body:draftBody(value.id,'once-only')},201)).draft;assert.equal((await checked(f.member,mail(f.group,'/drafts'),{method:'POST',body:draftBody(value.id,'once-only')},201)).draft.id,draft.id);
 const sent=(await checked(f.member,mail(f.group,`/drafts/${draft.id}/send`),{method:'POST',body:{idempotencyKey:'send-fixture-once'}})).draft;assert.equal(sent.status,'sent');assert.match(sent.result.message,/SMTP/);await checked(f.member,mail(f.group,`/drafts/${draft.id}/send`),{method:'POST',body:{idempotencyKey:'another-key-still-no-retry'}});assert.equal(f.state.calls.filter(call=>call.name==='send').length,1);
 const uncertain=(await checked(f.member,mail(f.group,'/drafts'),{method:'POST',body:draftBody(value.id,'unknown-once')},201)).draft;f.state.sendError=new Error(`Connection interrupted ${SMTP_SECRET}`);const unknown=(await checked(f.member,mail(f.group,`/drafts/${uncertain.id}/send`),{method:'POST',body:{idempotencyKey:'send-fixture-unknown'}})).draft;assert.equal(unknown.status,'unknown');assert.match(unknown.result.message,/切勿直接重发/);await checked(f.member,mail(f.group,`/drafts/${uncertain.id}/send`),{method:'POST',body:{idempotencyKey:'unknown-never-retry'}});assert.equal(f.state.calls.filter(call=>call.name==='send').length,2);
});

test('email attachments become member-only group files and revocation stops in-flight reads',{timeout:30000},async t=>{
 const f=await setup(t);await install(f);const value=await account(f,{enabled:true}),route=mail(f.group,`/accounts/${value.id}`);
 const downloaded=await checked(f.member,`${route}/attachment`,{method:'POST',body:{folder:'INBOX',uid:7,uidValidity:'123',part:'2'}});const attachment=downloaded.attachment;assert.ok(attachment?.url.startsWith(`/api/sessions/${f.group.id}/attachments/`));const fileRoute=attachment.url.slice('/api'.length);const response=await f.member.fetch(fileRoute);assert.equal(response.status,200);assert.equal(await response.text(),'FIXTURE_ATTACHMENT_DATA');assert.equal((await f.outsider.fetch(fileRoute)).status,404);assert.equal((await f.guest.fetch(fileRoute)).status,401);
 let started;const began=new Promise(resolve=>{started=resolve;});f.state.slowSearch=runtime=>new Promise((resolve,reject)=>{started();runtime.signal.addEventListener('abort',()=>reject(new Error('Fixture operation stopped')),{once:true});});const pending=f.member.request(`${route}/messages`,{method:'POST',body:{query:{subject:'fixture'}}});await began;
 await checked(f.admin,`/sessions/${f.group.id}/members/${f.users.member.id}`,{method:'DELETE',body:{}});const result=await pending;assert.ok([403,404,409].includes(result.response.status),JSON.stringify(result.data));noSecrets(result.data);assert.ok(!JSON.stringify(result.data).includes('FIXTURE_MAIL_QUERY_RESULT'));
});
