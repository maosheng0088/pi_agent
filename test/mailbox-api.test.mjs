import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createFixture,session} from './auth-helpers.mjs';

const password='Mailbox-fixture-password-2026!';
async function checked(client,route,options={},status=200){
  const result=await client.request(route,options);
  assert.equal(result.response.status,status,`${route}: ${JSON.stringify(result.data)}`);
  assert.ok(!JSON.stringify(result.data).includes('fixture-mailbox-secret'));
  return result.data;
}
async function setup(t){
  const state={validity:'123',sendCalls:0};
  const adapter={
    async folders(c,k,r){r.guard();return {folders:[{path:'INBOX',name:'Inbox',uidValidity:state.validity},{path:'Sent Items',name:'Sent Items',specialUse:'\\Sent',uidValidity:state.validity}]};},
    async search(c,k,r){r.guard();return {folder:r.folder,uidValidity:state.validity,messages:[{uid:r.folder==='INBOX'?7:8,subject:r.folder==='INBOX'?'Incoming test mail':'Sent test mail',from:[{address:'sender@example.test'}],to:[{address:'team@example.test'}],date:'2026-11-05T01:30:00.000Z',seen:false,hasAttachments:true}],nextCursor:null};},
    async read(c,k,r){r.guard();assert.equal(r.uidValidity,state.validity);return {uid:Number(r.uid),subject:'Test body',text:'Plain text <img src="https://tracking.example.test/spy">',attachments:[{part:'2',name:'test.txt',mimeType:'text/plain',size:12}]};},
    async downloadAttachment(c,k,r){r.guard();return {name:'test.txt',mimeType:'text/plain',content:Buffer.from('fixture-file')};},
    async send(){state.sendCalls++;throw new Error('Mailbox viewer must never send');},
  };
  const fixture=await createFixture({prefix:'mailbox-api',options:{channels:{autoStart:false},scheduler:{autoStart:false},workTasks:{autoStart:false},mailbox:{autoStart:false},email:{adapter,codec:async(op,value)=>Buffer.from(value).reverse()}}});
  t.after(()=>fixture.close());
  const admin=fixture.client(),member=fixture.client(),outsider=fixture.client(),guest=fixture.client();
  await checked(admin,'/auth/setup',{method:'POST',body:{username:'mailbox-admin',displayName:'Mailbox Admin',password}},201);
  const user=(await checked(admin,'/admin/users',{method:'POST',body:{username:'mailbox-member',displayName:'Mailbox Member',role:'member',password}},201)).user;
  const user2=(await checked(admin,'/admin/users',{method:'POST',body:{username:'mailbox-outsider',displayName:'Mailbox Outsider',role:'member',password}},201)).user;
  await checked(member,'/auth/login',{method:'POST',body:{username:user.username,password}});
  await checked(outsider,'/auth/login',{method:'POST',body:{username:user2.username,password}});
  const group=await session(admin,'Mailbox group'),other=await session(admin,'Other mailbox group');
  await checked(admin,`/sessions/${group.id}/members`,{method:'POST',body:{userIds:[user.id]}});
  await checked(admin,`/sessions/${other.id}/members`,{method:'POST',body:{userIds:[user.id]}});
  const account=(await checked(admin,'/admin/email-connections',{method:'POST',body:{name:'Team mailbox',email:'team@example.test',enabled:true,scope:'groups',groupIds:[group.id],imap:{host:'imap.example.test',port:993,tls:'implicit',username:'team@example.test',password:'fixture-mailbox-secret'}}},201)).account;
  const route=(suffix='',target=group)=>`/sessions/${target.id}/mailbox${suffix}`;
  const sync=async()=>{await checked(member,route(`/${account.id}/sync`),{method:'POST',body:{}});await fixture.server.piWeb.mailbox.whenIdle();};
  return {fixture,admin,member,outsider,guest,group,other,user,account,route,state,sync};
}

test('mailbox shows real Inbox and Sent metadata without requiring the AI mail skill',{timeout:30000},async t=>{
  const f=await setup(t);
  assert.equal((await checked(f.member,f.route('/accounts'))).accounts.length,1);
  await f.sync();
  const folders=(await checked(f.member,f.route(`/${f.account.id}/folders`))).folders;
  assert.equal(folders.find(x=>x.kind==='sent').path,'Sent Items');
  const inbox=await checked(f.member,f.route(`/${f.account.id}/messages?folder=inbox`));
  const sent=await checked(f.member,f.route(`/${f.account.id}/messages?folder=sent`));
  assert.equal(inbox.messages[0].subject,'Incoming test mail');assert.equal(sent.messages[0].subject,'Sent test mail');
  assert.equal((await checked(f.member,f.route(`/${f.account.id}/messages?folder=inbox&q=absent`))).total,0);
  const read=await checked(f.member,f.route(`/${f.account.id}/message?folder=sent&uid=8&uidValidity=123`));
  assert.match(read.message.text,/Plain text/);
  const downloaded=await checked(f.member,f.route(`/${f.account.id}/attachment`),{method:'POST',body:{folder:'inbox',uid:7,uidValidity:'123',part:'2'}});
  assert.ok(downloaded.attachment.downloadUrl.startsWith(`/api/sessions/${f.group.id}/attachments/`));
  const file=await f.member.fetch(downloaded.attachment.downloadUrl.replace(/^\/api/,''));assert.equal(await file.text(),'fixture-file');
  assert.equal(f.state.sendCalls,0);
});

test('mailbox enforces current group membership, account scope, enabled state and UIDVALIDITY',{timeout:30000},async t=>{
  const f=await setup(t);await f.sync();
  await checked(f.guest,f.route('/accounts'),{},401);
  await checked(f.outsider,f.route('/accounts'),{},404);
  assert.deepEqual((await checked(f.member,f.route('/accounts',f.other))).accounts,[]);
  await checked(f.member,f.route(`/${f.account.id}/messages`,f.other),{},403);
  await checked(f.member,f.route(`/${f.account.id}/message?folder=inbox&uid=7`),{},400);
  await checked(f.member,f.route(`/${f.account.id}/message?folder=inbox&uid=7&uidValidity=122`),{},409);
  f.state.validity='124';await f.sync();
  await checked(f.member,f.route(`/${f.account.id}/message?folder=inbox&uid=7&uidValidity=123`),{},409);
  await checked(f.admin,`/admin/email-connections/${f.account.id}`,{method:'PUT',body:{enabled:false}});
  assert.deepEqual((await checked(f.member,f.route('/accounts'))).accounts,[]);
  await checked(f.member,f.route(`/${f.account.id}/messages`),{},403);
  assert.ok(f.fixture.server.piWeb.mailbox.db.prepare('SELECT COUNT(*) AS n FROM mailbox_messages WHERE account_id=?').get(f.account.id).n>0,'disabled mailboxes keep their local archive while access is denied');
});

test('mailbox API rejects arbitrary folders and clears access after membership removal',{timeout:30000},async t=>{
  const f=await setup(t);await f.sync();
  await checked(f.member,f.route(`/${f.account.id}/messages?folder=INBOX`),{},400);
  await checked(f.member,f.route(`/${f.account.id}/attachment`),{method:'POST',body:{folder:'inbox',uid:7,uidValidity:'123',part:'../../secret'}},400);
  await checked(f.admin,`/sessions/${f.group.id}/members/${f.user.id}`,{method:'DELETE',body:{}});
  await checked(f.member,f.route(`/${f.account.id}/messages`),{},404);
  await checked(f.member,f.route(`/${f.account.id}/sync`),{method:'POST',body:{}},404);
});
