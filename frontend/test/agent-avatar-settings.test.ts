import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import CreateAgentDialog from '../src/components/CreateAgentDialog.vue'
import ChatView from '../src/components/ChatView.vue'
import { useWorkspaceStore } from '../src/stores/workspace'
import { avatarSource } from '../src/lib/avatar-catalog'
import { fakeBackend, json, person, session } from './fixtures'

const modal = { props:['open'], template:'<section v-if="open"><slot /></section>' }
describe('Saved agent avatar configuration',()=>{
  let wrapper:VueWrapper|undefined,store:ReturnType<typeof useWorkspaceStore>,backend:ReturnType<typeof fakeBackend>
  beforeEach(()=>{
    vi.stubGlobal('BroadcastChannel',undefined);setActivePinia(createPinia());backend=fakeBackend();store=useWorkspaceStore()
    store.user={...person('admin','管理员'),role:'admin'};store.current={...session('alpha'),avatarId:'portrait-04'};store.sessions=[store.current]
    backend.route((path,init)=>{
      if(path==='/api/skills')return json({skills:[]})
      if(path==='/api/directory')return json({users:[store.user]})
      if(path==='/api/admin/channels'||path.endsWith('/channels'))return json({channels:[]})
      if(path.endsWith('/members'))return json({members:[store.user],externalMembers:[],canLeave:false})
      if(path==='/api/sessions'&&init?.method==='POST')return json({session:{...session('created'),...JSON.parse(String(init.body))}})
      if(path==='/api/sessions/alpha'&&init?.method==='PATCH')return json({session:{...store.current,...JSON.parse(String(init.body))}})
    })
  })
  afterEach(()=>{wrapper?.unmount();wrapper=undefined;store.$dispose();vi.restoreAllMocks()})
  async function create(){wrapper=mount(CreateAgentDialog,{props:{open:false,user:store.user!},global:{stubs:{UiModal:modal}}});await wrapper.setProps({open:true});await flushPromises();return wrapper}
  async function edit(){wrapper=mount(ChatView,{props:{detailsOpen:true},global:{stubs:{UiModal:modal,MembersDialog:true,HistorySearch:true,DropdownMenu:true}}});await flushPromises();await wrapper.get('.profile-edit').trigger('click');return wrapper}
  function patchBodies(){return backend.fetch.mock.calls.filter(([,init])=>init?.method==='PATCH').map(([,init])=>JSON.parse(String(init!.body)))}
  async function submitEdit(){wrapper!.get('#rename-agent-name').element.closest('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await flushPromises()}
  it('previews and submits the selected portrait when creating an agent',async()=>{
    const view=await create();await view.get('#create-agent-name').setValue('客服助手');await view.get('input[value="portrait-13"]').setValue(true)
    expect(view.get('.create-agent-identity img').attributes('src')).toBe(avatarSource('portrait-13'))
    await view.get('form').trigger('submit');await flushPromises()
    const request=backend.fetch.mock.calls.find(([path,init])=>path==='/api/sessions'&&init?.method==='POST')
    expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({title:'客服助手',avatarId:'portrait-13'})
    expect(view.emitted('created')?.[0]).toEqual(['created'])
  })
  it('does not create anything on cancel and resets an unsaved choice on reopen',async()=>{
    const view=await create();await view.get('input[value="portrait-02"]').setValue(true)
    await view.findAll('button').find(button=>button.text()==='取消')!.trigger('click')
    expect(backend.fetch.mock.calls.some(([,init])=>init?.method==='POST')).toBe(false)
    await view.setProps({open:false});await view.setProps({open:true});await flushPromises()
    expect((view.get('input[value=""]').element as HTMLInputElement).checked).toBe(true)
  })
  it('loads the saved choice, persists a new one, and clears it to automatic',async()=>{
    const view=await edit();expect((view.get('input[value="portrait-04"]').element as HTMLInputElement).checked).toBe(true)
    await view.get('input[value="portrait-09"]').setValue(true);await submitEdit()
    expect(patchBodies().at(-1)).toMatchObject({avatarId:'portrait-09'});expect(store.current?.avatarId).toBe('portrait-09')
    expect(view.get('.header-agent-avatar img').attributes('src')).toBe(avatarSource('portrait-09'))
    await view.get('.profile-edit').trigger('click');await view.get('input[value=""]').setValue(true);await submitEdit()
    expect(patchBodies().at(-1)).toMatchObject({avatarId:''});expect(store.current?.avatarId).toBe('')
  })
  it('keeps employee rename requests free of administrator avatar changes',async()=>{
    store.user=person('employee','员工');const view=await edit()
    expect(view.find('.avatar-picker').exists()).toBe(false)
    await view.get('#rename-agent-name').setValue('新的群名');await submitEdit()
    expect(patchBodies().at(-1)).toEqual({title:'新的群名'})
  })
})
