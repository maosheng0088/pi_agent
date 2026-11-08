// @vitest-environment jsdom
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react'
import MailboxPage from '../src/pages/MailboxPage'
import {api,apiAttachmentBytes,ApiError} from '../src/lib/api'

// Keep Semi's value/callback and disabled contracts; the app browser verifies
// real popovers and responsive styling without connecting to a real mailbox.
vi.mock('@douyinfe/semi-ui',()=>({
 Button:({children,htmlType,loading,theme,type,icon,size,...props}:any)=><button type={htmlType||'button'} {...props}>{children}</button>,
 Input:({onChange,prefix,composition,...props}:any)=><input {...props} onChange={event=>onChange(event.target.value)}/>,
 Select:({onChange,optionList,...props}:any)=><select {...props} onChange={event=>onChange(event.target.value)}>{optionList.map((option:any)=><option key={option.value} value={option.value}>{option.label}</option>)}</select>,
 Empty:({title,description}:any)=><div><h2>{title}</h2><p>{description}</p></div>,
 Modal:({title,children,footer}:any)=><div role="dialog" aria-label={title}>{children}{footer}</div>,
 Spin:()=> <span aria-hidden>加载中</span>,Tag:({children}:any)=><span>{children}</span>,
}))
vi.mock('../src/lib/api',async original=>({...await original<typeof import('../src/lib/api')>(),api:vi.fn(),apiAttachmentBytes:vi.fn()}))
const mockedApi=vi.mocked(api),mockedBytes=vi.mocked(apiAttachmentBytes),user={id:'member',username:'employee',displayName:'员工',role:'member'},admin={...user,id:'admin',role:'admin'},sessions=[{id:'alpha',title:'客服智能体'},{id:'beta',title:'报价智能体'}]
const summary={uid:12,subject:'出库确认',from:[{name:'客户',address:'client@example.test'}],to:[{address:'team@example.test'}],cc:[{address:'cc@example.test'}],date:'2026-11-05T01:00:00Z',seen:false,hasAttachments:true}
let accounts:any[],folders:any[],list:any,detail:any,attachment:any,override:((path:string,options:any)=>any)|undefined
function endpoint(path:string){return path.split('?')[0].split('/').at(-1)}
function richView(path:string){return endpoint(path)==='message-rich'?new URLSearchParams(path.split('?')[1]).get('view'):null}
function localRichBody(path:string){return richView(path)==='body'&&new URLSearchParams(path.split('?')[1]).get('local')==='1'}
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5+54wAAAAASUVORK5CYII='
function defaults(path:string,options:any){
 if(endpoint(path)==='accounts')return {accounts}
 if(endpoint(path)==='folders')return {folders}
 if(endpoint(path)==='messages'){const folder=new URL(path,'http://localhost').searchParams.get('folder');return {...list,folder,messages:list.messages.map((item:any)=>({...item,subject:folder==='sent'?'已发出确认':item.subject}))}}
 if(endpoint(path)==='message')return {message:detail}
 if(localRichBody(path))return {html:'',hasInlineImages:false,pending:true}
 if(richView(path)==='images')return {images:[]}
 if(endpoint(path)==='content')return {document:{format:'text',status:'ready',text:'附件预览文字',sections:[],warnings:[],truncated:false}}
 if(options?.method==='POST')return {queued:true}
 throw new Error(`Unexpected mailbox API: ${path}`)
}
async function mount(props:any={}){const view=render(<MailboxPage user={user} {...props}/>);await screen.findByRole('button',{name:/出库确认/});return view}
function openMessage(){fireEvent.click(screen.getByRole('button',{name:/出库确认/}))}
async function tick(ms:number){await act(async()=>{await vi.advanceTimersByTimeAsync(ms)})}
async function timedMount(){let view!:ReturnType<typeof render>;await act(async()=>{view=render(<MailboxPage user={user}/>)});await tick(1);return view}
beforeEach(()=>{
 accounts=[{id:'mail-one',name:'团队邮箱',email:'team@example.test',enabled:true,sync:{status:'ready',lastSyncAt:'2026-11-05T01:00:00Z'}}]
 folders=[{kind:'inbox',path:'INBOX',label:'收件箱',status:'ready',uidValidity:'9'},{kind:'sent',path:'Sent',label:'已发送',status:'ready',uidValidity:'9'}]
 list={messages:[summary],total:1,hasMore:false,nextOffset:null,folder:'inbox',uidValidity:'9',searchScope:'local_archive',sync:{status:'ready',lastSyncAt:'2026-11-05T01:00:00Z',historyComplete:false}}
 detail={...summary,text:'第一行正文\n第二行正文',bodyType:'plain',attachments:[{part:'2',name:'出库单.pdf',size:1200,mimeType:'application/pdf'}]}
 attachment={id:'attachment-one',name:'出库单.pdf',size:1200,mimeType:'application/pdf',kind:'file',url:'/api/mailbox/mail-one/attachments/attachment-one',downloadUrl:'/api/mailbox/mail-one/attachments/attachment-one?download=1'}
 override=undefined;mockedApi.mockReset().mockImplementation(async(path,options)=>override?.(path,options)??defaults(path,options));Object.defineProperty(document,'hidden',{configurable:true,value:false})
 mockedBytes.mockReset().mockResolvedValue(new Uint8Array([1,2,3]))
 vi.stubGlobal('URL',class extends URL {static createObjectURL=vi.fn(()=> 'blob:mailbox-fixture');static revokeObjectURL=vi.fn()})
})
afterEach(()=>{cleanup();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals()})

describe('public multi-account mailbox reading',()=>{
 it('uses only public mailbox APIs and offers search without composing',async()=>{
  await mount();expect(screen.getByText('未读')).toBeTruthy();expect(screen.getByLabelText('有附件')).toBeTruthy();expect(screen.getByText('已同步邮件 1 封')).toBeTruthy();expect(screen.getByLabelText('搜索邮件')).toBeTruthy();expect(screen.queryByText(/未同步邮件及尚未归档的正文不在搜索范围内/)).toBeNull();expect(screen.getByText('公共邮箱 · 全体员工共享')).toBeTruthy();expect(screen.queryByRole('combobox')).toBeNull()
  expect(screen.queryByRole('button',{name:'管理邮箱连接'})).toBeNull();expect(screen.queryByRole('button',{name:/写信|发送邮件|自动回复/})).toBeNull()
  expect(mockedApi.mock.calls.every(([path])=>path.startsWith('/api/mailbox/'))).toBe(true)
  expect(mockedApi.mock.calls.some(([path,options])=>endpoint(path)==='attachment'||options?.method==='POST')).toBe(false)
  expect(mockedApi.mock.calls.find(([path])=>endpoint(path)==='messages')?.[0]).toContain('limit=50&offset=0')
 })
 it('shows honest setup instructions and connects the existing admin settings callback',async()=>{
  accounts=[];const manage=vi.fn(),view=render(<MailboxPage user={admin} sessions={sessions} currentSessionId="alpha" onManageConnections={manage}/>);await screen.findByText('暂无已启用的公共邮箱');expect(screen.getByText(/请联系管理员连接并启用邮箱/)).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'管理邮箱连接'}));expect(manage).toHaveBeenCalledOnce()
  view.rerender(<MailboxPage user={user} sessions={sessions} currentSessionId="alpha" onManageConnections={manage}/>);await screen.findByText('暂无已启用的公共邮箱');expect(screen.queryByRole('button',{name:'管理邮箱连接'})).toBeNull()
 })
 it('reads public accounts without agent membership, sessions, or a current session',async()=>{
  const view=await mount({sessions:[],currentSessionId:undefined});expect(mockedApi).toHaveBeenCalledWith('/api/mailbox/accounts',expect.objectContaining({signal:expect.any(AbortSignal)}));expect(screen.queryByRole('combobox')).toBeNull();const count=mockedApi.mock.calls.length;view.rerender(<MailboxPage user={user} sessions={sessions} currentSessionId="unrelated-agent"/>);expect(screen.getByRole('button',{name:/出库确认/})).toBeTruthy();expect(mockedApi.mock.calls.length).toBe(count)
 })
 it('makes no request for a disabled login and never offers admin management to it',()=>{
  render(<MailboxPage user={{...admin,disabled:true}} onManageConnections={vi.fn()}/>);expect(screen.getByText('登录已失效')).toBeTruthy();expect(screen.queryByRole('button',{name:'管理邮箱连接'})).toBeNull();expect(mockedApi).not.toHaveBeenCalled()
 })
 it('renders text literally, never loads remote images, and downloads only after an explicit click',async()=>{
  detail.text='<img src="https://remote.example.test/pixel">\n<script>alert(1)</script>';const click=vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{});await mount();openMessage();await screen.findByText(/remote\.example\.test\/pixel/);expect(document.querySelector('.mailbox-text-body')?.textContent).toBe(detail.text);expect(document.querySelector('.mailbox-text-body img,.mailbox-text-body script')).toBeNull();expect(screen.getByText('cc@example.test')).toBeTruthy();expect(screen.getByRole('button',{name:'返回邮件列表'})).toBeTruthy()
  expect(mockedBytes).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'下载附件 出库单.pdf'}));await waitFor(()=>expect(click).toHaveBeenCalledOnce());expect(mockedBytes).toHaveBeenCalledWith('/api/mailbox/mail-one/attachments/mail-inbox-12-9-2',expect.objectContaining({signal:expect.any(AbortSignal)}));expect((click.mock.instances[0] as HTMLAnchorElement).download).toBe('出库单.pdf')
  fireEvent.click(screen.getByRole('button',{name:'返回邮件列表'}));expect(document.querySelector('.mailbox-text-body')).toBeNull()
 })
 it.each(['https://external.example.test/file','/api/mailbox/mail-two/attachments/attachment-one?download=1','/api/admin/danger?download=1'])('rejects an attachment URL outside this public account: %s',async url=>{
  detail.attachments=[{...detail.attachments[0],...attachment,downloadUrl:url}];await mount();openMessage();await screen.findByText('第一行正文',{exact:false});fireEvent.click(screen.getByRole('button',{name:'下载附件 出库单.pdf'}));await screen.findByText('附件下载地址无效，请重试。');expect(mockedBytes).not.toHaveBeenCalled()
 })
 it('downloads an already archived attachment locally after remote deletion without another IMAP attachment request',async()=>{
  detail.archive={status:'ready',remoteDeleted:true,attachments:{total:1,ready:1,pending:0,error:0}};detail.attachments=[{...detail.attachments[0],...attachment,archive:{status:'ready'}}];const click=vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{});await mount();openMessage();await screen.findByText('远端邮件已删除，仍可查看已保留的本地归档。');expect(screen.queryByText('正文已归档')).toBeNull();expect(screen.queryByText(/附件已归档/)).toBeNull();fireEvent.click(screen.getByRole('button',{name:'下载附件 出库单.pdf'}));await waitFor(()=>expect(click).toHaveBeenCalledOnce());expect(mockedBytes).toHaveBeenCalledWith(attachment.downloadUrl,expect.objectContaining({signal:expect.any(AbortSignal)}))
 })
 it('requests document parsing only when opening a preview and encodes nested MIME parts',async()=>{
  detail.attachments=[{part:'2.3',name:'出库单.txt',size:1200,mimeType:'text/plain'}]
  await mount();openMessage();await screen.findByText('第一行正文',{exact:false})
  expect(mockedApi.mock.calls.some(([path])=>endpoint(path)==='content')).toBe(false)
  expect(mockedBytes).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button',{name:'预览附件 出库单.txt'}))
  await screen.findByText('附件预览文字')
  expect(mockedApi).toHaveBeenCalledWith('/api/mailbox/mail-one/attachments/mail-inbox-12-9-2_3/content',expect.objectContaining({signal:expect.any(AbortSignal)}))
 })
 it('renders rich body and valid CID images without inserting active markup or remote image sources',async()=>{
  detail.richBody={
   html:'<h2>富文本邮件</h2><style>p{background:url(https://remote.test/a)}</style><script>evil()</script><iframe src="https://remote.test/frame"></iframe><table><tr><th>港口</th><td>上海</td></tr></table><img src="cid:real" srcset="https://remote.test/variant 2x" onerror="evil()" alt="内嵌图片"><img src="https://remote.test/pixel"><img src="cid:unsafe"><a href="https://external.test/details" ping="https://remote.test/ping" style="color:red">详情</a><a href="javascript:evil()">坏链接</a>',
   hasInlineImages:true,
  }
  override=path=>richView(path)==='images'?{
   images:[{cid:'<REAL>',mimeType:'image/png',data:png},{cid:'unsafe',mimeType:'image/svg+xml',data:png}],
  }:undefined
  await mount()
  expect(mockedApi.mock.calls.some(([path])=>endpoint(path)==='message-rich')).toBe(false)
  openMessage()
  await screen.findByRole('heading',{name:'富文本邮件'})
  expect(screen.getByRole('table')).toBeTruthy()
  expect((await screen.findByRole('img',{name:'内嵌图片'})).getAttribute('src')).toBe('data:image/png;base64,'+png)
  const body=document.querySelector('.mailbox-rich-body')!
  expect(body.querySelectorAll('img')).toHaveLength(1)
  expect(body.querySelector('style,script,iframe,[style],[onerror],[srcset],[ping]')).toBeNull()
  expect(screen.getByText('坏链接').getAttribute('href')).toBeNull()
  expect(screen.getByRole('link',{name:'详情'}).getAttribute('rel')).toBe('noopener noreferrer')
  expect(screen.queryByText(/外部图片.*隐藏/)).toBeNull()
  expect(screen.getByRole('link',{name:'在新标签页查看'}).getAttribute('href')).toBe('https://remote.test/pixel')
  expect(mockedBytes).toHaveBeenCalledOnce()
 })
 it('automatically loads external images with two concurrent requests and one fetch per URL',async()=>{
  const href='https://remote.test/schedule.png?file=one&ref=mail'
  detail.richBody={html:`<h2>邮件正文</h2><a href="https://external.test/details"><img src="${href.replace('&','&amp;')}" alt="船期图"></a><img src="https://remote.test/other.png" alt="其他图片"><img src="${href.replace('&','&amp;')}" alt="重复船期图"><img src="https://remote.test/last.png" alt="末张图片">`,hasInlineImages:false}
  const pending=new Map<string,(value:Uint8Array)=>void>()
  let active=0,peak=0
  mockedBytes.mockImplementation((_path,options)=>{
   active++;peak=Math.max(active,peak)
   return new Promise(resolve=>pending.set(options.body!.url,value=>{active--;resolve(value)}))
  })
  await mount()
  expect(mockedBytes).not.toHaveBeenCalled()
  openMessage()
  const heading=await screen.findByRole('heading',{name:'邮件正文'})
  await waitFor(()=>expect(mockedBytes).toHaveBeenCalledTimes(2))
  expect([...pending.keys()]).toEqual([href,'https://remote.test/other.png'])
  const bytes=Uint8Array.from(atob(png),char=>char.charCodeAt(0))
  await act(async()=>pending.get(href)!(bytes))
  const image=await screen.findByRole('img',{name:'船期图'})
  expect(image.getAttribute('src')).toBe(`data:image/png;base64,${png}`)
  expect(image.closest('a')?.href).toBe('https://external.test/details')
  await screen.findByRole('img',{name:'重复船期图'})
  await waitFor(()=>expect(pending.has('https://remote.test/last.png')).toBe(true))
  expect(mockedBytes).toHaveBeenCalledTimes(3)
  await act(async()=>{pending.get('https://remote.test/other.png')!(bytes);pending.get('https://remote.test/last.png')!(bytes)})
  await screen.findByRole('img',{name:'末张图片'})
  expect(screen.getByRole('heading',{name:'邮件正文'})).toBe(heading)
  expect(peak).toBe(2)
  expect(mockedBytes.mock.calls.filter(([_path,options])=>options.body?.url===href)).toHaveLength(1)
  expect(screen.queryByText(/外部图片.*隐藏/)).toBeNull()
  expect(mockedBytes).toHaveBeenCalledWith('/api/mailbox/mail-one/message-rich?folder=inbox&uid=12&uidValidity=9&view=external-image',expect.objectContaining({signal:expect.any(AbortSignal),maxBytes:4*1024*1024,body:{url:href}}))
 })
 it('keeps external image fallback and allows retry after a blocked response or non-image bytes',async()=>{
  detail.richBody={html:'<p>正文仍可阅读</p><img src="https://remote.test/image" alt="外部照片">',hasInlineImages:false}
  mockedBytes.mockRejectedValueOnce(new ApiError('图片来源被拦截',422)).mockResolvedValueOnce(new Uint8Array([1,2,3]))
  await mount();openMessage()
  await screen.findByText('图片加载失败，可重试或在新标签页查看。')
  const button=screen.getByRole('button',{name:'重新加载 外部照片'})
  expect(button.getAttribute('aria-disabled')).toBeNull()
  expect(screen.getByText('正文仍可阅读')).toBeTruthy()
  expect(screen.getByRole('link',{name:'在新标签页查看'}).getAttribute('href')).toBe('https://remote.test/image')
  fireEvent.click(button)
  await waitFor(()=>expect(mockedBytes).toHaveBeenCalledTimes(2))
  await screen.findByText('图片加载失败，可重试或在新标签页查看。')
  expect(screen.queryByRole('img',{name:'外部照片'})).toBeNull()
 })
 it('keeps HTTP images as explicit new-tab links and revokes the reader if image access expires',async()=>{
  detail.richBody={html:'<p>邮件内容</p><img src="http://remote.test/http.png" alt="普通链接图片"><img src="https://remote.test/https.png" alt="安全链接图片">',hasInlineImages:false}
  let reject!:(reason:Error)=>void
  mockedBytes.mockImplementation(()=>new Promise((_resolve,no)=>{reject=no}))
  await mount();openMessage();await screen.findByText('邮件内容')
  expect(screen.queryByRole('button',{name:'重新加载 普通链接图片'})).toBeNull()
  expect(screen.getAllByRole('link',{name:'在新标签页查看'})[0].getAttribute('href')).toBe('http://remote.test/http.png')
  expect(mockedBytes).toHaveBeenCalledOnce()
  expect(mockedBytes.mock.calls[0][1].body?.url).toBe('https://remote.test/https.png')
  await act(async()=>reject(new ApiError('邮箱访问权限已失效',403)))
  await screen.findByText('邮箱已停用、移除或访问权限已失效，请重试。')
  expect(screen.queryByText('邮件内容')).toBeNull()
 })
 it('aborts the automatic external image request when the message closes',async()=>{
  detail.richBody={html:'<p>邮箱内容</p><img src="https://remote.test/image" alt="外部照片">',hasInlineImages:false}
  let signal!:AbortSignal,finish!:(value:Uint8Array)=>void
  mockedBytes.mockImplementation((_path,options)=>new Promise(resolve=>{signal=options.signal;finish=resolve}))
  await mount();openMessage();await waitFor(()=>expect(mockedBytes).toHaveBeenCalledOnce())
  fireEvent.click(screen.getByRole('button',{name:'返回邮件列表'}))
  expect(signal.aborted).toBe(true)
  await act(async()=>finish(Uint8Array.from(atob(png),char=>char.charCodeAt(0))))
  expect(screen.queryByRole('img',{name:'外部照片'})).toBeNull()
 })
 it('shows formatted body before images resolve and updates just the image slots',async()=>{
  let finish!:(value:any)=>void
  detail.richBody={
   html:'<h2>可先阅读的邮件</h2><p>这里是货件资料</p><img src="cid:real" alt="货件照片">',hasInlineImages:true,
  }
  override=path=>richView(path)==='images'?new Promise(resolve=>{finish=resolve}):undefined
  await mount();openMessage()
  const heading=await screen.findByRole('heading',{name:'可先阅读的邮件'})
  const reader=heading.closest('.mailbox-message-detail')!
  expect(screen.getByText('这里是货件资料')).toBeTruthy()
  expect(screen.getByText('货件照片')).toBeTruthy()
  expect(screen.queryByText(/正在加载内嵌图片/)).toBeNull()
  expect(screen.queryByRole('img',{name:'货件照片'})).toBeNull()
  reader.scrollTop=123
  await act(async()=>finish({images:[{cid:'real',mimeType:'image/png',data:png}]}))
  expect(screen.getByRole('img',{name:'货件照片'}).getAttribute('src')).toBe('data:image/png;base64,'+png)
  expect(screen.getByRole('heading',{name:'可先阅读的邮件'})).toBe(heading)
  expect(reader.scrollTop).toBe(123)
 })
 it('shows locally archived CID images immediately and polls only missing slots without rebuilding the mail',async()=>{
  vi.useFakeTimers()
  detail.richBody={html:'<h2>本地图片归档</h2><p>正文保持可阅读</p><img src="cid:first" alt="已归档图片"><img src="cid:later" alt="后续图片">',hasInlineImages:true}
  let ready=false
  override=path=>richView(path)==='images'?(ready
   ?{images:[{cid:'later',mimeType:'image/png',data:png}]}
   :{images:[{cid:'first',mimeType:'image/png',data:png}],truncated:true,pending:true}):undefined
  await timedMount();openMessage();await act(async()=>{})
  const heading=screen.getByRole('heading',{name:'本地图片归档'})
  const image=screen.getByRole('img',{name:'已归档图片'})
  const reader=heading.closest('.mailbox-message-detail')!
  reader.scrollTop=123
  expect(screen.queryByRole('img',{name:'后续图片'})).toBeNull()
  expect(screen.queryByText(/正在加载内嵌图片|图片不可用/)).toBeNull()
  expect(screen.queryByText('部分内嵌图片暂不可用。')).toBeNull()
  expect(mockedApi.mock.calls.filter(([path])=>richView(path)==='images')).toHaveLength(1)
  await tick(3999)
  expect(mockedApi.mock.calls.filter(([path])=>richView(path)==='images')).toHaveLength(1)
  ready=true;await tick(1)
  expect(screen.getByRole('img',{name:'后续图片'}).getAttribute('src')).toBe('data:image/png;base64,'+png)
  expect(screen.getByRole('img',{name:'已归档图片'})).toBe(image)
  expect(screen.getByRole('heading',{name:'本地图片归档'})).toBe(heading)
  expect(reader.scrollTop).toBe(123)
  await tick(18000)
  expect(mockedApi.mock.calls.filter(([path])=>richView(path)==='images')).toHaveLength(2)
  expect(mockedApi.mock.calls.filter(([path])=>endpoint(path)==='message-rich').every(([path])=>richView(path)==='images')).toBe(true)
  expect(mockedBytes).not.toHaveBeenCalled()
 })
 it('ends local image polling after one minute and leaves readable placeholders for unavailable originals',async()=>{
  vi.useFakeTimers()
  detail.richBody={html:'<p>邮件正文</p><img src="cid:missing" alt="尚未归档图片">',hasInlineImages:true}
  override=path=>richView(path)==='images'?{images:[],pending:true}:undefined
  await timedMount();openMessage();await act(async()=>{})
  expect(screen.queryByText(/正在加载内嵌图片|图片不可用/)).toBeNull()
  await tick(60000)
  expect(screen.getByText('图片不可用（尚未归档图片）')).toBeTruthy()
  expect(screen.getByText('邮件正文')).toBeTruthy()
  const reads=mockedApi.mock.calls.filter(([path])=>richView(path)==='images').length
  await tick(18000)
  expect(mockedApi.mock.calls.filter(([path])=>richView(path)==='images')).toHaveLength(reads)
 })
 it('reads the local image cache for image-only HTML without a text placeholder',async()=>{
  detail.richBody={html:'<img src="cid:real">',hasInlineImages:true}
  override=path=>richView(path)==='images'?{images:[{cid:'real',mimeType:'image/png',data:png}]}:undefined
  await mount();openMessage()
  expect((await screen.findByRole('img',{name:'邮件内嵌图片'})).getAttribute('src')).toBe('data:image/png;base64,'+png)
  expect(document.querySelector('.mailbox-text-body')).toBeNull()
  expect(screen.queryByText(/正在加载内嵌图片/)).toBeNull()
 })
 it('renders cached rich HTML from the detail response and preserves it across equivalent archive polls',async()=>{
  vi.useFakeTimers()
  detail={...detail,archive:{status:'pending'},richBody:{html:'<h2>已归档邮件正文</h2><img src="cid:real" alt="已归档照片">',hasInlineImages:true}}
  override=path=>richView(path)==='images'?{images:[{cid:'real',mimeType:'image/png',data:png}]}:undefined
  await timedMount();openMessage();await act(async()=>{})
  const heading=screen.getByRole('heading',{name:'已归档邮件正文'})
  const image=screen.getByRole('img',{name:'已归档照片'})
  const detailLoads=mockedApi.mock.calls.filter(([path])=>endpoint(path)==='message').length
  detail={...detail,richBody:{...detail.richBody}}
  await tick(15000)
  expect(mockedApi.mock.calls.filter(([path])=>endpoint(path)==='message')).toHaveLength(detailLoads+1)
  expect(mockedApi.mock.calls.filter(([path])=>richView(path)==='body')).toHaveLength(0)
  expect(mockedApi.mock.calls.filter(([path])=>richView(path)==='images')).toHaveLength(1)
  expect(screen.getByRole('heading',{name:'已归档邮件正文'})).toBe(heading)
  expect(screen.getByRole('img',{name:'已归档照片'})).toBe(image)
 })
 it('skips rich requests for a cached plain-text message',async()=>{
  detail.richBody={html:'',hasInlineImages:false}
  await mount();openMessage();await screen.findByText('第一行正文',{exact:false})
  expect(mockedApi.mock.calls.some(([path])=>endpoint(path)==='message-rich')).toBe(false)
  expect(screen.queryByText('正在读取富文本…')).toBeNull()
 })
 it('keeps rich text when images fail and aborts an old image request when the detail closes',async()=>{
  let imageSignal!:AbortSignal,finish!:(value:any)=>void
  let fail=true
  detail.richBody={
   html:'<p>邮件的富文本正文</p><img src="cid:real" alt="货件照片">',hasInlineImages:true,
  }
  override=(path,options)=>richView(path)==='images'?(fail?Promise.reject(new ApiError('远端邮箱不可用',502)):new Promise(resolve=>{imageSignal=options.signal;finish=resolve})):undefined
  await mount();openMessage()
  await screen.findByText('图片不可用（货件照片）')
  expect(screen.getByText('邮件的富文本正文')).toBeTruthy()
  expect(screen.queryByText('富文本暂时不可用，当前显示纯文本。')).toBeNull()
  fireEvent.click(screen.getByRole('button',{name:'返回邮件列表'}));fail=false
  openMessage();await screen.findByText('货件照片')
  fireEvent.click(screen.getByRole('button',{name:'返回邮件列表'}));expect(imageSignal.aborted).toBe(true)
  await act(async()=>finish({images:[{cid:'real',mimeType:'image/png',data:png}]}))
  expect(screen.queryByRole('img',{name:'货件照片'})).toBeNull()
 })
 it('shows plain text immediately, then uses only the local rich-body cache while waiting for archive',async()=>{
  vi.useFakeTimers()
  let ready=false
  override=path=>localRichBody(path)&&ready?{
   html:'<h2>后台已归档正文</h2><img src="cid:real" alt="归档图片">',hasInlineImages:true,
  }:richView(path)==='images'?{images:[{cid:'real',mimeType:'image/png',data:png}]}:undefined
  await timedMount();openMessage();await act(async()=>{})
  expect(document.querySelector('.mailbox-text-body')?.textContent).toBe(detail.text)
  expect(screen.queryByText(/正在读取富文本|富文本暂时不可用/)).toBeNull()
  expect(mockedApi.mock.calls.some(([path])=>endpoint(path)==='message-rich')).toBe(false)
  await tick(6000)
  expect(document.querySelector('.mailbox-text-body')?.textContent).toBe(detail.text)
  expect(mockedApi.mock.calls.filter(([path])=>localRichBody(path))).toHaveLength(1)
  expect(mockedApi.mock.calls.some(([path])=>richView(path)==='images')).toBe(false)
  ready=true;await tick(6000)
  expect(screen.getByRole('heading',{name:'后台已归档正文'})).toBeTruthy()
  expect(screen.getByRole('img',{name:'归档图片'})).toBeTruthy()
  await tick(18000)
  expect(mockedApi.mock.calls.filter(([path])=>richView(path)==='body')).toHaveLength(2)
  expect(mockedApi.mock.calls.filter(([path])=>localRichBody(path))).toHaveLength(2)
 })
 it('keeps plain text after cache errors and stops local polling after a minute',async()=>{
  vi.useFakeTimers()
  override=path=>localRichBody(path)?Promise.reject(new ApiError('缓存读取失败',502)):undefined
  await timedMount();openMessage();await act(async()=>{})
  await tick(60000)
  const polls=mockedApi.mock.calls.filter(([path])=>localRichBody(path)).length
  expect(polls).toBeGreaterThan(0)
  await tick(18000)
  expect(mockedApi.mock.calls.filter(([path])=>richView(path)==='body')).toHaveLength(polls)
  expect(document.querySelector('.mailbox-text-body')?.textContent).toBe(detail.text)
  expect(screen.queryByText(/正在读取富文本|富文本暂时不可用/)).toBeNull()
 })
 it('aborts the local rich cache request when selection is closed',async()=>{
  vi.useFakeTimers()
  let signal!:AbortSignal,finish!:(value:any)=>void
  override=(path,options)=>localRichBody(path)?new Promise(resolve=>{signal=options.signal;finish=resolve}):undefined
  await timedMount();openMessage();await act(async()=>{});await tick(6000)
  fireEvent.click(screen.getByRole('button',{name:'返回邮件列表'}));expect(signal.aborted).toBe(true)
  await act(async()=>finish({html:'<p>过期的富文本</p>',images:[]}))
  expect(screen.queryByText('过期的富文本')).toBeNull()
 })
 it.each([401,403])('clears the reader when the local rich cache reports lost access (%s)',async status=>{
  vi.useFakeTimers()
  override=path=>localRichBody(path)?Promise.reject(new ApiError('无访问权限',status)):undefined
  await timedMount();openMessage();await act(async()=>{});await tick(6000)
  expect(screen.getByText('邮箱已停用、移除或访问权限已失效，请重试。')).toBeTruthy()
  expect(document.querySelector('.mailbox-text-body')).toBeNull()
 })
 it('opens a raster attachment only after a click and rejects non-image bytes',async()=>{
  detail.attachments=[{part:'4',name:'照片.png',size:1200,mimeType:'image/png'}]
  await mount();openMessage();await screen.findByText('照片.png')
  expect(mockedBytes).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button',{name:'预览附件 照片.png'}))
  await screen.findByText('此附件无法预览为图片，请下载原文件查看。')
  expect(mockedBytes).toHaveBeenCalledWith('/api/mailbox/mail-one/attachments/mail-inbox-12-9-4',expect.objectContaining({signal:expect.any(AbortSignal),maxBytes:8*1024*1024}))
 })
 it('aborts an old body and ignores its late response after changing folders',async()=>{
  let release!:(value:any)=>void,bodySignal!:AbortSignal;override=(path,options)=>endpoint(path)==='message'?new Promise(resolve=>{release=resolve;bodySignal=options.signal}):undefined
  await mount();openMessage();await screen.findByText('正在读取邮件正文…');fireEvent.click(screen.getByRole('button',{name:'已发送',exact:true}));expect(bodySignal.aborted).toBe(true);await screen.findByRole('button',{name:/已发出确认/});await act(async()=>release({message:{...detail,text:'不应显示的旧正文'}}));expect(screen.queryByText('不应显示的旧正文')).toBeNull()
 })
 it('clears a read message immediately on search and sends only the new local archive keyword',async()=>{
  await mount();openMessage();await screen.findByText('第一行正文',{exact:false});const signal=mockedApi.mock.calls.find(([path])=>endpoint(path)==='message')?.[1]?.signal;fireEvent.change(screen.getByLabelText('搜索邮件'),{target:{value:'客户'}});expect(signal?.aborted).toBe(true);expect(document.querySelector('.mailbox-text-body')).toBeNull();await waitFor(()=>expect(mockedApi.mock.calls.some(([path])=>path.includes('q=%E5%AE%A2%E6%88%B7'))).toBe(true));expect((screen.getByLabelText('搜索邮件') as HTMLInputElement).value).toBe('客户')
 })
 it('changes public account scopes immediately and ignores a previous account body response',async()=>{
  accounts.push({...accounts[0],id:'mail-two',name:'第二邮箱',email:'other@example.test'});const view=await mount();openMessage();await screen.findByText('第一行正文',{exact:false});fireEvent.click(screen.getByRole('button',{name:/第二邮箱/}));expect(document.querySelector('.mailbox-text-body')).toBeNull();await waitFor(()=>expect(mockedApi.mock.calls.some(([path])=>path.includes('/api/mailbox/mail-two/messages'))).toBe(true))
  let release!:(value:any)=>void,signal!:AbortSignal;override=(path,options)=>endpoint(path)==='message'&&path.includes('/mail-two/')?new Promise(resolve=>{release=resolve;signal=options.signal}):undefined;openMessage();await screen.findByText('正在读取邮件正文…');fireEvent.click(screen.getByRole('button',{name:/团队邮箱/}));expect(signal.aborted).toBe(true);await act(async()=>release({message:{...detail,text:'第二邮箱的延迟正文'}}));expect(screen.queryByText('第二邮箱的延迟正文')).toBeNull();view.unmount()
 })
 it('clears all old messages on identity changes and auth expiration',async()=>{
  const view=await mount();openMessage();await screen.findByText('第一行正文',{exact:false});let release!:(value:any)=>void;override=path=>endpoint(path)==='accounts'?new Promise(resolve=>{release=resolve}):undefined
  view.rerender(<MailboxPage user={{...user,id:'other-user'}} sessions={sessions} currentSessionId="alpha"/>);expect(document.querySelector('.mailbox-text-body')).toBeNull();expect(screen.queryByText('出库确认')).toBeNull();await act(async()=>release({accounts}));await screen.findByRole('button',{name:/出库确认/});act(()=>window.dispatchEvent(new Event('pi:auth-expired')));expect(screen.getByText('登录已失效')).toBeTruthy();expect(screen.queryByText('出库确认')).toBeNull()
 })
 it.each([403,404])('clears cached rows and body when access is revoked or the account is concealed (%s)',async status=>{
  await mount();override=path=>endpoint(path)==='message'?Promise.reject(new ApiError('无访问权限',status)):undefined;openMessage();await screen.findByText('邮箱已停用、移除或访问权限已失效，请重试。');expect(screen.queryByText('出库确认')).toBeNull();expect(screen.queryByText('第一行正文',{exact:false})).toBeNull()
 })
 it('explains missing Sent folders and failed synchronization without claiming a complete mailbox',async()=>{
  folders[1].status='not_found';list.sync={...list.sync,status:'error',error:'邮箱服务暂时不可用'};await mount();expect(screen.getByRole('alert').textContent).toContain('邮箱服务暂时不可用');fireEvent.click(screen.getByRole('button',{name:'已发送',exact:true}));expect(screen.getByText('未发现已发送文件夹')).toBeTruthy();expect(mockedApi.mock.calls.some(([path])=>path.includes('folder=sent'))).toBe(false)
 })
 it('polls current local archive every 15 seconds without resetting the search or open body, and invalidates replaced UID generations',async()=>{
  vi.useFakeTimers();await timedMount();fireEvent.change(screen.getByLabelText('搜索邮件'),{target:{value:'确认'}});await tick(251);openMessage();await act(async()=>{});expect(document.querySelector('.mailbox-text-body')?.textContent).toBe(detail.text);const first=mockedApi.mock.calls.filter(([path])=>endpoint(path)==='messages').length,bodyCount=mockedApi.mock.calls.filter(([path])=>endpoint(path)==='message').length
  await tick(15000);expect(mockedApi.mock.calls.filter(([path])=>endpoint(path)==='messages').length).toBe(first+1);expect((screen.getByLabelText('搜索邮件') as HTMLInputElement).value).toBe('确认');expect(document.querySelector('.mailbox-text-body')?.textContent).toBe(detail.text);expect(mockedApi.mock.calls.filter(([path])=>endpoint(path)==='message').length).toBe(bodyCount)
  list.uidValidity='10';await tick(15000);expect(document.querySelector('.mailbox-text-body')).toBeNull()
 })
 it('shows preparation progress while new messages are held and reveals mail when its body is ready',async()=>{
  vi.useFakeTimers()
  const ready=list
  list={...list,messages:[],total:0,sync:{...list.sync,archive:{total:2,ready:0,pending:2,error:0,preparing:2}}}
  await timedMount()
  expect(screen.getByText('正在准备正文 2 封')).toBeTruthy()
  expect(screen.getByRole('heading',{name:'正在准备邮件正文'})).toBeTruthy()
  expect(screen.queryByText('暂无已同步邮件')).toBeNull()
  expect(screen.queryByText('当前无邮件')).toBeNull()
  list=ready;await tick(15000)
  expect(screen.getByRole('button',{name:/出库确认/})).toBeTruthy()
  expect(screen.queryByText('正在准备正文 2 封')).toBeNull()
 })
 it('keeps the mail search label concise and hides search scope notices',async()=>{
  list.searchScope='cached_metadata';await mount();expect(screen.getByLabelText('搜索邮件')).toBeTruthy();expect(screen.queryByText(/当前仅搜索已同步|搜索仅覆盖已同步/)).toBeNull()
 })
 it('keeps retrying failed body archives and ignores obsolete attachment archive errors',async()=>{
  vi.useFakeTimers();detail.archive={status:'error',error:'正文保存失败',attachments:{total:3,ready:1,pending:1,error:1}};detail.attachments[0].archive={status:'error',error:'附件保存失败'};list.sync.archive={total:8,ready:5,pending:2,error:1};await timedMount();expect(screen.getByText('待归档 2 封')).toBeTruthy();expect(screen.getByText('归档失败 1 封')).toBeTruthy();expect(screen.queryByText(/正文已归档/)).toBeNull();openMessage();await act(async()=>{});expect(screen.getByText('正文归档失败')).toBeTruthy();expect(screen.queryByText(/附件已归档|附件保存失败/)).toBeNull();fireEvent.click(screen.getByRole('button',{name:'重试归档'}));await act(async()=>{});expect(mockedApi).toHaveBeenCalledWith('/api/mailbox/mail-one/sync',expect.objectContaining({method:'POST',body:{}}));expect(screen.getByText('已提交重试归档，请等待服务端处理。')).toBeTruthy()
  detail={...detail,archive:{status:'ready',attachments:{total:3,ready:1,pending:1,error:1}}};await tick(15000);expect(screen.queryByText('正文已归档')).toBeNull();expect(screen.queryByRole('button',{name:'重试归档'})).toBeNull();expect(document.querySelector('.mailbox-text-body')?.textContent).toBe(detail.text)
 })
 it('shows partial body archives without polling pending attachment archives',async()=>{
  vi.useFakeTimers()
  list.sync.archive={total:4,ready:1,partial:1,pending:1,error:1}
  detail.archive={status:'partial',truncated:true,attachments:{total:1,ready:0,pending:1,error:0}}
  detail.attachments[0].archive={status:'pending'}
  await timedMount()
  expect(screen.getByText('部分归档 1 封')).toBeTruthy()
  expect(screen.getByText('待归档 1 封')).toBeTruthy()
  expect(screen.getByText('归档失败 1 封')).toBeTruthy()
  openMessage()
  await act(async()=>{})
  expect(screen.getByText('正文部分归档')).toBeTruthy()
  expect(screen.getByText('正文或附件清单超出读取上限，已保存可读取的部分。')).toBeTruthy()
  expect(screen.queryByText('正文已归档')).toBeNull()
  const bodyReads=()=>mockedApi.mock.calls.filter(([path])=>endpoint(path)==='message').length
  const initialReads=bodyReads()
  await tick(15000)
  expect(bodyReads()).toBe(initialReads)
  expect(screen.queryByText(/附件已归档/)).toBeNull()
  expect(mockedBytes).not.toHaveBeenCalled()
  expect(screen.getByText('正文部分归档')).toBeTruthy()
 })
 it('posts explicit sync and old-history requests, polls real completion, and paginates synchronized messages',async()=>{
  vi.useFakeTimers();list.hasMore=true;list.nextOffset=50;await timedMount();fireEvent.click(screen.getByRole('button',{name:'下一页'}));await tick(1);expect(mockedApi.mock.calls.some(([path])=>path.includes('offset=50'))).toBe(true);fireEvent.click(screen.getByRole('button',{name:'上一页'}));await tick(1)
  fireEvent.click(screen.getByRole('button',{name:'刷新邮件'}));await act(async()=>{});expect(mockedApi).toHaveBeenCalledWith('/api/mailbox/mail-one/sync',expect.objectContaining({method:'POST',body:{}}));expect(screen.getByText('已提交同步，正在等待服务端更新。')).toBeTruthy();list.sync.status='syncing';await tick(2000);list.sync={...list.sync,status:'ready',lastSyncAt:'2026-11-05T01:01:00Z'};await tick(2000);expect(screen.getByText('同步已完成，列表已更新。')).toBeTruthy()
  fireEvent.click(screen.getByRole('button',{name:'同步更早邮件'}));await act(async()=>{});expect(mockedApi).toHaveBeenCalledWith('/api/mailbox/mail-one/load-more',expect.objectContaining({method:'POST',body:{folder:'inbox'}}));list.sync={...list.sync,status:'ready',lastSyncAt:'2026-11-05T01:02:00Z',historyComplete:true};await tick(2000);expect(screen.queryByRole('button',{name:'同步更早邮件'})).toBeNull()
 })
 it('clears an open message if it disappears from the refreshed page',async()=>{
  vi.useFakeTimers();await timedMount();openMessage();await act(async()=>{});expect(document.querySelector('.mailbox-text-body')).toBeTruthy();list.messages=[];list.total=0;await tick(15000);expect(document.querySelector('.mailbox-text-body')).toBeNull();expect(screen.getByText('暂无已同步邮件')).toBeTruthy()
 })
 it('shows slow reads and folder errors without an endless initial loading spinner',async()=>{
  vi.useFakeTimers();let release!:(value:any)=>void;override=path=>endpoint(path)==='folders'?new Promise(resolve=>{release=resolve}):undefined;await timedMount();await tick(8000);expect(screen.getByText(/读取时间较长/)).toBeTruthy();await act(async()=>release({folders}));await tick(1);expect(screen.getByRole('button',{name:/出库确认/})).toBeTruthy()
 })
 it('shows a local cache cap and a real synchronization failure without a false success notice',async()=>{
  vi.useFakeTimers();await timedMount();fireEvent.click(screen.getByRole('button',{name:'刷新邮件'}));await act(async()=>{});list.sync={...list.sync,status:'error',error:'连接超时',truncated:true};await tick(2000);expect(screen.getByText('同步失败：连接超时')).toBeTruthy();expect(screen.getByText('同步未完成，请查看错误后重试。')).toBeTruthy();expect(screen.queryByText('同步已完成，列表已更新。')).toBeNull();expect(screen.getByText('已达到本地同步上限，仅展示已缓存邮件。')).toBeTruthy();expect(screen.queryByRole('button',{name:'同步更早邮件'})).toBeNull()
 })
 it('removes revoked accounts on the next authorization refresh and aborts a pending download on unmount',async()=>{
  vi.useFakeTimers();const view=await timedMount();openMessage();await act(async()=>{});let release!:(value:Uint8Array)=>void;mockedBytes.mockImplementation(()=>new Promise(resolve=>{release=resolve}));const click=vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{});fireEvent.click(screen.getByRole('button',{name:'下载附件 出库单.pdf'}));const signal=mockedBytes.mock.calls[0]?.[1]?.signal
  accounts=[];await tick(15000);expect(screen.getByText('暂无已启用的公共邮箱')).toBeTruthy();expect(signal?.aborted).toBe(true);await act(async()=>release(new Uint8Array([1])));expect(click).not.toHaveBeenCalled();view.unmount()
 })
 it('keeps the mailbox available when an individual attachment is missing or exceeds the limit',async()=>{
  mockedBytes.mockRejectedValueOnce(new ApiError('附件已从原邮箱移除',404)).mockRejectedValueOnce(new ApiError('附件超过 50 MiB',413))
  await mount();openMessage();await screen.findByText('第一行正文',{exact:false})
  const button=screen.getByRole('button',{name:'下载附件 出库单.pdf'})
  fireEvent.click(button);await screen.findByRole('alert',{name:''});expect(screen.getByText('附件已从原邮箱移除')).toBeTruthy()
  fireEvent.click(button);await screen.findByText('附件超过 50 MiB')
  expect(screen.getByRole('button',{name:/出库确认/})).toBeTruthy()
 })
})
