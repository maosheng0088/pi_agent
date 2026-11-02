import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGroupMembers } from '../public/group-members.js';

// A small dialog/element adapter exercises controller state transitions without
// a browser profile or a production account.
class Element {
  constructor(tag = 'div', className = '', text = '') { Object.assign(this,{tag,className,textContent:text,children:[],dataset:{},attributes:{},listeners:{},open:false,value:''}); }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children=items; }
  setAttribute(key,value) { this.attributes[key]=value; }
  addEventListener(type,handler) { (this.listeners[type] ||= []).push(handler); }
  async trigger(type) { for(const handler of this.listeners[type] || []) await handler({preventDefault(){}}); }
  showModal() { this.open=true; }
  close() { if(!this.open)return;this.open=false;void this.trigger('close'); }
  focus() {}
}
const descendants = element => element.children.flatMap(child=>[child,...descendants(child)]);

test('self-leave needs confirmation, clears stale group dialogs and reports voluntary exit during revocation',async()=>{
  const elements=new Map(),$=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  const user={id:'employee',displayName:'员工',role:'member'},creator={id:'creator',displayName:'创建人'};
  const state={user,identityEpoch:1,historyRequest:0,session:{id:'a',title:'A群',ownerId:creator.id},loading:false};
  const requests=[];let controller,resolveLeave,leavingAtCompletion=false;
  const api=async(path,options={})=>{
    if(options.method==='POST'){requests.push(path);await new Promise(resolve=>{resolveLeave=resolve;});return {ok:true,left:true,sessionId:'b'};}
    return {members:[creator,user],ownerId:creator.id,canRemoveMembers:false,canLeave:true};
  };
  controller=createGroupMembers({$,api,state,node:(...args)=>new Element(...args),toast(){},ensureSession:async()=>state.session,onLeft:id=>{
    leavingAtCompletion=controller.isLeaving(id);state.session=null;controller.resetPanel();
  }});
  await controller.syncPanel();assert.equal($('leave-group').disabled,false);
  await $('leave-group').trigger('click');assert.equal($('leave-group-dialog').open,true);
  await $('cancel-leave-group').trigger('click');assert.equal(requests.length,0);
  await $('leave-group').trigger('click');state.session={id:'b',title:'B群',ownerId:creator.id};state.historyRequest++;await controller.syncPanel();
  assert.equal($('leave-group-dialog').open,false);await $('leave-group-form').trigger('submit');assert.equal(requests.length,0);
  await $('leave-group').trigger('click');const submitting=$('leave-group-form').trigger('submit');
  assert.equal(controller.isLeaving('b'),true);assert.equal(controller.isLeaving('a'),false);
  resolveLeave();await submitting;
  assert.deepEqual(requests,['/api/sessions/b/leave']);assert.equal(leavingAtCompletion,true);
  assert.equal(state.session,null);assert.equal($('leave-group-dialog').open,false);assert.equal(controller.isLeaving('b'),false);
});

test('member dialog handles initial group creation and discards old-group controls; removal requires confirmation',async()=>{
  const elements=new Map(),$=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  const owner={id:'owner',displayName:'群创建人',username:'owner'},employee={id:'employee',displayName:'同事',username:'employee'};
  const state={user:{...owner,role:'member'},identityEpoch:1,historyRequest:0,session:null,loading:false};
  const groups=new Map([['a',[owner,employee]],['b',[owner,employee]]]);const requests=[];
  const response=id=>({members:groups.get(id),canRemoveMembers:true,ownerId:owner.id});
  const api=async(path,options={})=>{
    requests.push({path,method:options.method || 'GET'});
    if(path==='/api/directory')return {users:[owner,employee]};
    const match=/^\/api\/sessions\/([^/]+)\/members(?:\/([^/]+))?$/.exec(path);assert.ok(match);
    if(options.method==='DELETE')groups.set(match[1],groups.get(match[1]).filter(user=>user.id!==match[2]));
    return response(match[1]);
  };
  let controller;
  controller=createGroupMembers({$,api,state,node:(...args)=>new Element(...args),toast(){},ensureSession:async()=>{
    state.session ||= {id:'a',title:'A群',ownerId:owner.id};await controller.syncPanel();return state.session;
  }});
  await $('open-group-members').trigger('click');
  assert.equal($('group-members-dialog').open,true,'initial group creation must still open the member dialog');
  const staleRemove=descendants($('group-member-roster')).find(element=>element.attributes?.['aria-label']==='移除群成员 同事');assert.ok(staleRemove);
  state.session={id:'b',title:'B群',ownerId:owner.id};state.historyRequest++;await controller.syncPanel();
  assert.equal($('group-members-dialog').open,false);assert.equal($('group-member-roster').children.length,0);
  await staleRemove.trigger('click');assert.equal($('remove-group-member-dialog').open,false,'detached A-group control cannot remove a B-group member');
  const currentRemove=descendants($('group-panel-members')).find(element=>element.attributes?.['aria-label']==='移除群成员 同事');assert.ok(currentRemove);
  await currentRemove.trigger('click');assert.equal($('remove-group-member-dialog').open,true);
  await $('cancel-remove-member').trigger('click');assert.equal(requests.some(request=>request.method==='DELETE'),false);
  await currentRemove.trigger('click');await $('remove-group-member-form').trigger('submit');
  assert.equal($('remove-group-member-dialog').open,false);assert.equal($('group-panel-count').textContent,'1');
  assert.deepEqual(requests.filter(request=>request.method==='DELETE'),[{path:'/api/sessions/b/members/employee',method:'DELETE'}]);
  assert.equal(groups.get('a').length,2);assert.equal(groups.get('b').length,1);
});
