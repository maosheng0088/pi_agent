import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFixture, configure, legacySession } from './auth-helpers.mjs';

test('all employees may add enabled coworkers; membership is persistent, atomic and idempotent', async () => {
  const fixture=await createFixture({prefix:'group-members'});
  try {
    const admin=fixture.client(),alice=fixture.client(),bob=fixture.client(),anonymous=fixture.client();
    const password='Group-fixture-2026!';
    await admin.request('/auth/setup',{method:'POST',body:{username:'group-admin',displayName:'Admin',password}});
    await configure(admin,fixture);
    const a=(await admin.request('/admin/users',{method:'POST',body:{username:'group-alice',displayName:'Alice',password,role:'member'}})).data.user;
    const b=(await admin.request('/admin/users',{method:'POST',body:{username:'group-bob',displayName:'Bob',password,role:'member'}})).data.user;
    const c=(await admin.request('/admin/users',{method:'POST',body:{username:'group-carol',displayName:'Carol',password,role:'member'}})).data.user;
    await alice.request('/auth/login',{method:'POST',body:{username:'group-alice',password}});
    await bob.request('/auth/login',{method:'POST',body:{username:'group-bob',password}});
    const chat=await legacySession(fixture,alice,'Group');const route=`/sessions/${chat.id}/members`;
    await alice.send(chat.id,'Private group history marker.');
    const requestsBefore=fixture.mock.requests.length;
    for(const outsider of [bob,admin]) {
      for(const query of ['', '?q=Group']) {
        const list=(await outsider.request(`/sessions${query}`)).data;
        assert.equal(list.total,0);assert.equal(list.sessions.length,0);
      }
      for(const [path,method,body] of [
        [`/sessions/${chat.id}`,'GET'],[route,'GET'],[route,'POST',{userIds:[b.id]}],
        [`/sessions/${chat.id}/messages`,'POST',{message:'Attempt hidden task'}],
        [`/sessions/${chat.id}/abort`,'POST',{}],
        [`/sessions/${chat.id}`,'PATCH',{mode:'workspace'}],
      ])assert.equal((await outsider.request(path,{method,body})).response.status,404);
    }
    assert.equal(fixture.mock.requests.length,requestsBefore);
    assert.equal((await admin.request(`/admin/sessions/${chat.id}`)).response.status,200);
    assert.equal((await bob.request(`/admin/sessions/${chat.id}`)).response.status,403);
    assert.equal((await anonymous.request('/directory')).response.status,401);
    assert.equal((await anonymous.request(route)).response.status,401);
    const directory=(await alice.request('/directory')).data.users;
    assert.ok(directory.every(user=>Object.keys(user).sort().join(',')==='displayName,id,username'));
    assert.deepEqual((await alice.request(route)).data.members.map(m=>m.id),[a.id]);
    const added=await alice.request(route,{method:'POST',body:{userIds:[b.id,b.id]}});
    assert.equal(added.response.status,200);assert.equal(added.data.addedCount,1);
    assert.equal((await bob.request('/sessions')).data.total,1);
    const invitedHistory=(await bob.request(`/sessions/${chat.id}`)).data;
    assert.equal(invitedHistory.session.visibility,'members');
    assert.match(JSON.stringify(invitedHistory.messages),/Private group history marker/);
    await bob.send(chat.id,'Invited member continues.');
    assert.equal((await bob.request(route,{method:'POST',body:{userIds:[c.id]}})).data.addedCount,1);
    assert.equal((await bob.request(route,{method:'POST',body:{userIds:[c.id]}})).data.addedCount,0);
    await admin.request(`/admin/users/${c.id}`,{method:'PATCH',body:{disabled:true}});
    assert.ok(!(await alice.request('/directory')).data.users.some(u=>u.id===c.id));
    const other=await legacySession(fixture,alice,'Atomic');
    assert.equal((await alice.request(`/sessions/${other.id}/members`,{method:'POST',body:{userIds:[b.id,c.id]}})).response.status,400);
    assert.deepEqual((await alice.request(`/sessions/${other.id}/members`)).data.members.map(m=>m.id),[a.id]);
    assert.equal((await alice.request('/sessions/missing/members')).response.status,404);
    assert.equal((await bob.request('/admin/users')).response.status,403);
    await fixture.stop();await fixture.start();
    assert.deepEqual(new Set((await alice.request(route)).data.members.map(m=>m.id)),new Set([a.id,b.id,c.id]));
  }finally{await fixture.close();}
});
