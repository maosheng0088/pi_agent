// @vitest-environment jsdom
import {afterAll,afterEach,beforeEach,expect,it,vi} from 'vitest'
import {api} from '../src/lib/api'
import {WorkspaceStore,workspace} from '../src/lib/workspace'
import {managementViews,navigationSection,toolViewFromHash} from '../src/lib/navigation'
import {readOceanRoute} from '../src/lib/ocean-freight'

vi.mock('@douyinfe/semi-ui',()=>({Toast:{info:vi.fn()}}))
vi.mock('../src/lib/api',async importOriginal=>({...await importOriginal<typeof import('../src/lib/api')>(),api:vi.fn(),advanceApiIdentity:vi.fn()}))
const mockedApi=vi.mocked(api),stores:WorkspaceStore[]=[]
const user={id:'route-member',username:'member',displayName:'员工',role:'member'}
const groups=[{id:'a',title:'A助手'},{id:'b',title:'B助手'}]
function store(){const value=new WorkspaceStore();stores.push(value);value.patch({user,booting:false,loading:false,sessions:groups,current:groups[0],view:'chat'});return value}
beforeEach(()=>{
 history.replaceState(null,'','/');mockedApi.mockReset()
 mockedApi.mockImplementation(async route=>{
  if(route==='/api/auth/status')return {authenticated:true,user,workspace:{name:'路由测试'}} as any
  if(route==='/api/status')return {configured:true} as any
  if(route.startsWith('/api/sessions?'))return {sessions:groups,total:groups.length} as any
  if(route.endsWith('/skills'))return {skills:[]} as any
  const selected=groups.find(group=>route===`/api/sessions/${group.id}`)
  if(selected)return {session:selected,messages:[{role:'user',content:selected.title}]} as any
  throw new Error(`Unexpected fixture API ${route}`)
 })
})
afterEach(()=>{for(const value of stores.splice(0))value.dispose()})
afterAll(()=>workspace.dispose())

it('tool detail keeps the Tools parent while preserving the complete old ocean share route',()=>{
 const value=store(),hash='#view=ocean&tool=ports&q=Shanghai&country=CN&continent=AS&lane=asia'
 history.replaceState(null,'',`/${hash}`);value.navigate('ocean')
 expect(value.state.view).toBe('ocean');expect(location.hash).toBe(hash);expect(navigationSection(value.state.view)).toBe('tools')
 expect(readOceanRoute()).toMatchObject({tool:'ports',query:'Shanghai',country:'CN',continent:'AS',lane:'asia'})
 value.navigate('tools');expect(location.hash).toBe('#view=tools');expect(toolViewFromHash(location.hash)).toBe('tools')
 value.navigate('chat');expect(location.hash).toBe('#agent=a');expect(value.state.current?.id).toBe('a')
})

it('both public tool views require login and do not expand employee management permissions',()=>{
 const value=store();value.patch({user:null});value.navigate('tools');expect(value.state.view).toBe('chat')
 value.patch({user});value.navigate('tools');expect(value.state.view).toBe('tools')
 for(const view of managementViews){value.navigate(view);expect(value.state.view).toBe('tools')}
 value.navigate('unknown-page' as any);expect(value.state.view).toBe('tools')
 value.navigate('ocean');for(const view of managementViews){value.navigate(view);expect(value.state.view).toBe('ocean')}
})

it.each(['agent','session'])('refresh preserves the existing #%s deep link and uses the authorized selected agent',async key=>{
 const value=store();history.replaceState(null,'',`/#${key}=b`);await value.initialize()
 expect(value.state.current?.id).toBe('b');expect(value.state.view).toBe('chat');expect(location.hash).toBe('#agent=b')
})

it.each(['tools','ocean'] as const)('late conversation details cannot overwrite the %s page hash after leaving the agent view',async tool=>{
 const value=store();let finish!:(value:unknown)=>void
 const pendingDetails=new Promise(resolve=>{finish=resolve})
 mockedApi.mockImplementation(async route=>route==='/api/sessions/b'?pendingDetails as any:{skills:[]} as any)
 const selecting=value.select('b');value.navigate(tool)
 const expectedHash=location.hash
 finish({session:groups[1],messages:[{role:'user',content:'晚到的聊天详情'}]});await selecting
 expect(value.state.view).toBe(tool);expect(location.hash).toBe(expectedHash);expect(value.state.loading).toBe(false)
 expect(value.state.current?.id).toBe('b');value.navigate('chat');expect(location.hash).toBe('#agent=b')
})

it('revocation of the current agent clears its data without changing the open tool route',()=>{
 const value=store();history.replaceState(null,'','/#view=ocean&tool=track&q=CSQU3054383');value.navigate('ocean')
 const hash=location.hash;value.forget('a')
 expect(value.state.current).toBeNull();expect(value.state.messages).toEqual([]);expect(value.state.view).toBe('ocean');expect(location.hash).toBe(hash)
 value.navigate('tools');expect(location.hash).toBe('#view=tools');value.navigate('chat');expect(location.hash).toBe('')
})

it('an active direct run blocks changing both the current page and URL',()=>{
 const value=store();history.replaceState(null,'','/#agent=a');value.patch({running:true})
 value.navigate('tools');expect(value.state.view).toBe('chat');expect(location.hash).toBe('#agent=a')
 value.navigate('ocean');expect(value.state.view).toBe('chat');expect(location.hash).toBe('#agent=a')
})


it('mailbox has an authenticated employee route and returns to the selected agent',()=>{
 const value=store();value.navigate('mailbox');expect(value.state.view).toBe('mailbox');expect(location.hash).toBe('#view=mailbox');expect(navigationSection('mailbox')).toBe('mailbox');value.navigate('chat');expect(location.hash).toBe('#agent=a')
})
