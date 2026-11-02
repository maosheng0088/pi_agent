// @vitest-environment jsdom
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react'
import CloudDocumentsPanel from '../src/pages/automation/CloudDocumentsPanel'
vi.mock('lottie-web',()=>({default:{loadAnimation:vi.fn(()=>({destroy:vi.fn(),play:vi.fn(),pause:vi.fn(),addEventListener:vi.fn(),removeEventListener:vi.fn()}))}}))
const {apiMock}=vi.hoisted(()=>({apiMock:vi.fn()}))
vi.mock('../src/lib/api',async original=>({...await original<any>(),api:apiMock}))
const admin={id:'admin',username:'admin',displayName:'管理员',role:'admin'},employee={...admin,id:'employee',role:'member'},base='/api/admin/cloud-documents'
let providers:any[],manage:ReturnType<typeof vi.fn>,changed:ReturnType<typeof vi.fn>
const skill={id:'tencent-docs-skill',name:'腾讯文档技能',enabled:false,scope:'groups',groupIds:['alpha']}
function fixture(){return ['tencent','kdocs','wps365'].map(id=>({id,name:id,installed:true,configured:id!=='kdocs',status:id==='kdocs'?'not_configured':'ready',toolVersion:'1.2.3',credentialHint:'never-show-saved-secret',skills:id==='tencent'?[skill]:[]}))}
function card(name:string){return screen.getByRole('heading',{name,level:3}).closest('.semi-card') as HTMLElement}
async function mount(){const view=render(<CloudDocumentsPanel user={admin} onManageSkill={manage} onChanged={changed}/>);fireEvent.click(screen.getByRole('button',{name:/云文档连接/}));await screen.findByRole('heading',{name:'腾讯文档',level:3});return view}
beforeEach(()=>{
 manage=vi.fn();changed=vi.fn();providers=fixture();apiMock.mockReset().mockImplementation(async(path:string,options:any)=>{if(path===base)return {providers};if(options?.method==='PUT'){const id=path.split('/').at(-1);providers=providers.map(provider=>provider.id===id?{...provider,configured:true,status:'ready'}:provider)}return {provider:providers[0]}})
 vi.stubGlobal('matchMedia',vi.fn(()=>({matches:true,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){},dispatchEvent(){return true}})))
 vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}})
 Object.defineProperty(document,'hidden',{configurable:true,value:false})
})
afterEach(()=>{cleanup();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals()})
describe('administrator cloud document connections',()=>{
 it('is invisible to staff and loads private admin state only when expanded',async()=>{
  const view=render(<CloudDocumentsPanel user={employee} onManageSkill={manage} onChanged={changed}/>);expect(screen.queryByText('云文档连接')).toBeNull();expect(apiMock).not.toHaveBeenCalled();view.rerender(<CloudDocumentsPanel user={admin} onManageSkill={manage} onChanged={changed}/>);expect(apiMock).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button',{name:/云文档连接/}));await screen.findByRole('heading',{name:'WPS365',level:3});expect(screen.getByText('个人账号')).toBeTruthy();expect(screen.getByText('企业账号')).toBeTruthy();expect(document.body.textContent).not.toContain('never-show-saved-secret')
 })
 it('saves a new token without ever prefilling saved secrets, clearing input immediately',async()=>{
  await mount();fireEvent.click(within(card('腾讯文档')).getByRole('button',{name:'配置凭据'}));const dialog=screen.getByRole('dialog',{name:'配置腾讯文档凭据'}),input=within(dialog).getByLabelText('访问 Token') as HTMLInputElement
  expect(input.value).toBe('');expect(input.type).toBe('password');expect((within(dialog).getByRole('button',{name:'保存凭据'}) as HTMLButtonElement).disabled).toBe(true)
  let resolve!:(value:any)=>void;apiMock.mockImplementation((path:string,options:any)=>options?.method==='PUT'?new Promise(yes=>{resolve=yes}):Promise.resolve({providers}))
  fireEvent.change(input,{target:{value:'fixture-token-only'}});fireEvent.click(within(dialog).getByRole('button',{name:'保存凭据'}));expect(input.value).toBe('');expect(apiMock).toHaveBeenCalledWith(`${base}/tencent`,expect.objectContaining({method:'PUT',body:{token:'fixture-token-only'}}));await act(async()=>resolve({provider:providers[0]}));await waitFor(()=>expect(screen.queryByRole('dialog',{name:'配置腾讯文档凭据'})).toBeNull());expect(document.body.textContent).not.toContain('fixture-token-only')
 })
 it('keeps existing enterprise secrets when only Client ID changes',async()=>{
  await mount();fireEvent.click(within(card('WPS365')).getByRole('button',{name:'配置凭据'}));const dialog=screen.getByRole('dialog',{name:'配置WPS365凭据'});fireEvent.change(within(dialog).getByLabelText('Client ID'),{target:{value:'new-client-id'}});fireEvent.click(within(dialog).getByRole('button',{name:'保存凭据'}));await waitFor(()=>expect(apiMock).toHaveBeenCalledWith(`${base}/wps365`,expect.objectContaining({method:'PUT',body:{clientId:'new-client-id'}})));expect(apiMock.mock.calls.find(([,options])=>options?.method==='PUT')?.[1].body).not.toHaveProperty('clientSecret')
 })
 it('distinguishes saved credentials awaiting verification from a verified connection',async()=>{
  providers[0].status='not_configured';await mount();expect(within(card('腾讯文档')).getByText('待检测')).toBeTruthy();expect(within(card('腾讯文档')).queryByText('连接就绪')).toBeNull()
 })
 it('checks existing connections, allows skill install without credentials, and reuses skill scope settings',async()=>{
  await mount();expect((within(card('金山文档')).getByRole('button',{name:'检测连接'}) as HTMLButtonElement).disabled).toBe(true);fireEvent.click(within(card('腾讯文档')).getByRole('button',{name:'检测连接'}));await waitFor(()=>expect(apiMock).toHaveBeenCalledWith(`${base}/tencent/check`,expect.objectContaining({method:'POST',body:{}})))
  fireEvent.click(within(card('金山文档')).getByRole('button',{name:'接入技能'}));await waitFor(()=>expect(apiMock).toHaveBeenCalledWith(`${base}/kdocs/install-skills`,expect.objectContaining({method:'POST',body:{}})));expect(changed).toHaveBeenCalled();fireEvent.click(within(card('腾讯文档')).getByRole('button',{name:'授权范围'}));expect(manage).toHaveBeenCalledWith(skill)
 })
 it('confirms local credential removal and never implies deleting remote documents',async()=>{
  await mount();fireEvent.click(within(card('腾讯文档')).getByRole('button',{name:'解除本系统凭据'}));let dialog=screen.getByRole('dialog',{name:'解除腾讯文档凭据？'});expect(within(dialog).getByText(/不会删除远端文档/)).toBeTruthy();fireEvent.click(within(dialog).getByRole('button',{name:'取消'}));expect(apiMock.mock.calls.some(([,options])=>options?.method==='DELETE')).toBe(false)
  fireEvent.click(within(card('腾讯文档')).getByRole('button',{name:'解除本系统凭据'}));dialog=screen.getByRole('dialog',{name:'解除腾讯文档凭据？'});fireEvent.click(within(dialog).getByRole('button',{name:'确认解除'}));await waitFor(()=>expect(apiMock).toHaveBeenCalledWith(`${base}/tencent/credentials`,expect.objectContaining({method:'DELETE',body:{}})))
 })
 it('guides safe official authorization, polls only while pending, then stops on completion',async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-30T10:00:00Z'));const opener=vi.spyOn(window,'open').mockReturnValue(null)
  apiMock.mockImplementation(async(path:string,options:any)=>path===base?{providers}:path.endsWith('/authorize')?{authorization:{id:'auth-one',url:'https://docs.qq.com/oauth?client_id=public',expiresAt:'2026-10-30T10:05:00Z'}}:path.endsWith('/authorization')?{authorization:{id:'auth-one',status:'ready'}}:{})
  render(<CloudDocumentsPanel user={admin} onManageSkill={manage} onChanged={changed}/>);fireEvent.click(screen.getByRole('button',{name:/云文档连接/}));await act(async()=>vi.advanceTimersByTimeAsync(0));fireEvent.click(within(card('腾讯文档')).getByRole('button',{name:'授权指引'}));await act(async()=>vi.advanceTimersByTimeAsync(0));fireEvent.click(screen.getByRole('button',{name:'打开官方授权页'}));expect(opener).toHaveBeenCalledWith('https://docs.qq.com/oauth?client_id=public','_blank','noopener,noreferrer')
  await act(async()=>vi.advanceTimersByTimeAsync(3001));expect(screen.getByText(/授权已完成，可以检测/)).toBeTruthy();const polls=()=>apiMock.mock.calls.filter(([path])=>path.endsWith('/authorization'));expect(polls()).toHaveLength(1);await act(async()=>vi.advanceTimersByTimeAsync(15000));expect(polls()).toHaveLength(1)
 })
 it('shows honest manual credential instructions without pretending to poll OAuth',async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-30T10:00:00Z'))
  apiMock.mockImplementation(async(path:string)=>path===base?{providers}:{authorization:{id:'guide-one',url:'https://open.wps.cn/',status:'instructions',message:'在企业开放平台授予文档接口权限后，填写应用凭据。'}})
  render(<CloudDocumentsPanel user={admin} onManageSkill={manage} onChanged={changed}/>);fireEvent.click(screen.getByRole('button',{name:/云文档连接/}));await act(async()=>vi.advanceTimersByTimeAsync(0));fireEvent.click(within(card('WPS365')).getByRole('button',{name:'授权指引'}));await act(async()=>vi.advanceTimersByTimeAsync(0))
  expect(screen.getByRole('dialog',{name:'WPS365授权指引'})).toBeTruthy();expect(screen.getByRole('button',{name:'打开官方授权指引'})).toBeTruthy();expect(screen.getByText(/填写应用凭据/)).toBeTruthy();expect(screen.queryByText(/最长等待/)).toBeNull();await act(async()=>vi.advanceTimersByTimeAsync(60000));expect(apiMock.mock.calls.some(([path])=>path.endsWith('/authorization'))).toBe(false)
 })
 it('does not open unsafe authorization links and aborts outstanding private state on collapse',async()=>{
  apiMock.mockImplementation(async(path:string)=>path===base?{providers}:{authorization:{id:'unsafe-auth',url:'https://evil.example.com/'}});const opener=vi.spyOn(window,'open').mockReturnValue(null)
  const view=await mount();fireEvent.click(within(card('腾讯文档')).getByRole('button',{name:'授权指引'}));await screen.findByRole('dialog',{name:'腾讯文档官方授权'});expect(screen.queryByRole('button',{name:'打开官方授权页'})).toBeNull();expect(screen.getByText(/未获取到安全的官方授权地址/)).toBeTruthy();expect(opener).not.toHaveBeenCalled();view.unmount();expect((apiMock.mock.calls[0][1].signal as AbortSignal).aborted).toBe(true)
 })
})
