// @vitest-environment jsdom
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {WorkspaceStore,workspace} from '../src/lib/workspace'
import {api} from '../src/lib/api'
import {needsAttention,sessionAttention} from '../src/lib/session-attention'
vi.mock('lottie-web',()=>({default:{loadAnimation:vi.fn()}}))
vi.mock('../src/lib/api',async original=>({...await original<any>(),api:vi.fn(),advanceApiIdentity:vi.fn()}))
const mocked=vi.mocked(api)
const user={id:'employee',username:'employee',displayName:'Employee',role:'member'}
const empty={unreadCount:0,resultCount:0,mentionCount:0,pendingCount:1}
let store:WorkspaceStore
beforeEach(()=>{mocked.mockReset();store=new WorkspaceStore();store.patch({user,loading:false,booting:false,view:'chat',sessions:[{id:'a',title:'A'},{id:'b',title:'B'}],current:{id:'a',title:'A',attentionCursor:5}});Object.defineProperty(document,'hidden',{configurable:true,value:false})})
afterEach(()=>{store.dispose();workspace.clear();vi.restoreAllMocks()})
describe('per-member attention in the client',()=>{
 it('keeps actionable work when read, and never posts backwards or for a background group',async()=>{
  mocked.mockResolvedValue({attention:empty} as any)
  await store.markRead('a',5);await store.markRead('a',3);await store.markRead('b',8)
  expect(mocked).toHaveBeenCalledTimes(1);expect(mocked).toHaveBeenCalledWith('/api/sessions/a/read',expect.objectContaining({method:'POST',body:{cursor:5}}))
  expect(store.state.sessions[0].attention?.pendingCount).toBe(1)
 })
 it('does not mark a loading, hidden, or management view as read',async()=>{
  store.patch({loading:true});await store.markRead('a',5);store.patch({loading:false,view:'tools'});await store.markRead('a',5)
  store.patch({view:'chat'});Object.defineProperty(document,'hidden',{configurable:true,value:true});await store.markRead('a',5)
  expect(mocked).not.toHaveBeenCalled()
 })
 it('cannot apply the old account receipt after switching accounts',async()=>{
  let resolve!:(value:any)=>void;mocked.mockReturnValue(new Promise(yes=>{resolve=yes}))
  const pending=store.markRead('a',5);store.clear();store.patch({user:{...user,id:'other'},sessions:[{id:'a',title:'Other account'}]});resolve({attention:empty});await pending
  expect(store.state.sessions[0].attention).toBeUndefined()
 })
 it('does not restore a revoked group from a late receipt',async()=>{
  let resolve!:(value:any)=>void;mocked.mockReturnValue(new Promise(yes=>{resolve=yes}));vi.spyOn(store,'toast').mockImplementation(()=>{})
  const pending=store.markRead('a',5);store.forget('a');resolve({attention:empty});await pending
  expect(store.state.sessions.some(s=>s.id==='a')).toBe(false);expect(store.state.current).toBeNull()
 })
 it('refreshes the transcript when an indexed message arrived after an earlier history snapshot',async()=>{
  store.patch({current:{id:'a',title:'A',revision:4,attentionCursor:5},messages:[{id:'old',role:'user',content:'Read'}]})
  mocked.mockImplementation(async(path:string)=>path==='/api/status'?{}:path.startsWith('/api/sessions?')?{sessions:[{id:'a',title:'A',revision:4,attentionLatest:6}],total:1}:path.endsWith('/skills')?{skills:[]}: {session:{id:'a',title:'A',revision:4,attentionCursor:6},messages:[{id:'new',role:'assistant',content:'New result'}]} as any)
  await store.synchronize()
  expect(mocked).toHaveBeenCalledWith('/api/sessions/a',expect.anything());expect(store.state.current?.attentionCursor).toBe(6)
 })
 it('uses authoritative counts and ignores malformed or missing data',()=>{
  expect(sessionAttention({id:'a',title:'A',revision:800,messageCount:100})).toEqual({unread:0,results:0,mentions:0,pending:0})
  expect(needsAttention({id:'a',title:'A',attention:empty})).toBe(true)
  expect(needsAttention({id:'a',title:'A',attention:{...empty,pendingCount:-2,unreadCount:NaN}})).toBe(false)
 })
})
