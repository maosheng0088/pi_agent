import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {createFixture,configure,session} from './auth-helpers.mjs';

test('per-member receipts track public results and mentions, persist across restart and keep actionable work after reading', async()=>{
 const f=await createFixture({prefix:'attention',options:{scheduler:{autoStart:false},channels:{autoStart:false},workTasks:{autoStart:false}}});
 try{
  const admin=f.client(),alice=f.client(),bob=f.client();const password='Attention-fixture-2026!';
  const checked=async(c,p,o,status=200)=>{const r=await c.request(p,o);assert.equal(r.response.status,status,JSON.stringify(r.data));return r.data};
  await checked(admin,'/auth/setup',{method:'POST',body:{username:'admin',displayName:'Admin',password}},201);await configure(admin,f);
  const users=[];
  for(const name of ['alice','bob'])users.push((await checked(admin,'/admin/users',{method:'POST',body:{username:name,displayName:name,password,role:'member'}},201)).user);
  await checked(alice,'/auth/login',{method:'POST',body:{username:'alice',password}});await checked(bob,'/auth/login',{method:'POST',body:{username:'bob',password}});
  const group=await session(admin,'Attention group'),id=group.id;
  const summary=async c=>(await checked(c,'/sessions')).sessions.find(s=>s.id===id).attention;
  const message=async(c,content,mentions=[])=>checked(c,`/sessions/${id}/discussion`,{method:'POST',body:{content,mentions}},201);
  assert.equal((await bob.request(`/sessions/${id}/read`,{method:'POST',body:{cursor:0}})).response.status,404);
  await message(admin,'Before invitation');
  await checked(admin,`/sessions/${id}/members`,{method:'POST',body:{userIds:users.map(u=>u.id)}});
  assert.equal((await summary(alice)).unreadCount,0,'history before joining is read');
  await message(admin,'Please review',[users[0].id]);
  assert.deepEqual(await summary(alice),{unreadCount:1,resultCount:0,mentionCount:1,pendingCount:0});
  await message(alice,'My own response');
  assert.equal((await summary(alice)).unreadCount,1,'own messages do not inflate unread');
  const old=(await checked(alice,`/sessions/${id}`)).session.attentionCursor;
  await admin.send(id,'Return a verified local fixture answer.');
  const after=await summary(alice);assert.equal(after.resultCount,1);assert.equal(after.unreadCount,3);
  await checked(alice,`/sessions/${id}/read`,{method:'POST',body:{cursor:old}});
  assert.equal((await summary(alice)).resultCount,1,'reading an old snapshot cannot clear a later result');
  const task=(await checked(admin,`/sessions/${id}/tasks`,{method:'POST',body:{instruction:'Check this fixture work',assigneeId:users[0].id}},202)).task;
  await checked(alice,`/sessions/${id}/tasks/${task.id}/actions`,{method:'POST',body:{action:'takeover'}});
  assert.equal((await summary(alice)).pendingCount,1);assert.equal((await summary(bob)).pendingCount,0);
  const cursor=(await checked(alice,`/sessions/${id}`)).session.attentionCursor;
  await checked(alice,`/sessions/${id}/read`,{method:'POST',body:{cursor}});
  await checked(alice,`/sessions/${id}/read`,{method:'POST',body:{cursor:old}});
  assert.deepEqual(await summary(alice),{unreadCount:0,resultCount:0,mentionCount:0,pendingCount:1});
  assert.ok((await summary(bob)).unreadCount>0,'another member has an independent receipt');
  assert.equal((await alice.request(`/sessions/${id}/read`,{method:'POST',body:{cursor:cursor+1000}})).response.status,400);
  await f.stop();await f.start();
  assert.deepEqual(await summary(alice),{unreadCount:0,resultCount:0,mentionCount:0,pendingCount:1});
  // Simulate a committed scheduled result with no callback (crash recovery).
  const db=new DatabaseSync(path.join(f.dataDir,'workspace.sqlite'));
  try{db.prepare('INSERT INTO task_group_messages(run_id,session_id,content,created_at) VALUES (?,?,?,?)').run('fixture-scheduled',id,'Scheduled result',new Date().toISOString())}finally{db.close()}
  assert.equal((await summary(alice)).resultCount,1);
  assert.equal((await summary(alice)).resultCount,1,'reconciliation is idempotent');
  await checked(alice,`/sessions/${id}/tasks/${task.id}/actions`,{method:'POST',body:{action:'complete',content:'Checked by human'}});
  assert.equal((await summary(alice)).pendingCount,0);
  await checked(admin,`/sessions/${id}/members/${users[0].id}`,{method:'DELETE',body:{}});
  assert.equal((await alice.request(`/sessions/${id}/read`,{method:'POST',body:{cursor:0}})).response.status,404);
  assert.equal((await checked(alice,'/sessions')).sessions.length,0);
 }finally{await f.close()}
});
