// @vitest-environment jsdom
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react'
import {ChatAttachmentQueue,attachmentPreview,userAttachmentContent} from '../src/lib/chat-attachments'
import {AttachmentButton,AttachmentList,useAttachmentDrop,useChatAttachments} from '../src/components/ChatAttachments'
import UserMessageContent from '../src/components/UserMessageContent'
import type {UploadedAttachment} from '../src/lib/types'

vi.mock('lottie-web',()=>({default:{loadAnimation:vi.fn(()=>({destroy:vi.fn(),play:vi.fn(),pause:vi.fn(),addEventListener:vi.fn(),removeEventListener:vi.fn()}))}}))
const {upload}=vi.hoisted(()=>({upload:vi.fn()}))
vi.mock('../src/lib/api',async original=>({...await original<any>(),uploadChatAttachment:upload}))
const file=new File(['bytes'],'预约表.csv',{type:'text/csv'}),image=new File(['png'],'头像 (1)[新].png',{type:'image/png'})
const id='11111111-1111-4111-8111-111111111111'
function meta(file:File=sessionFile(),suffix='1',session='alpha'):UploadedAttachment{const aid=id.slice(0,-1)+suffix,url=`/api/sessions/${session}/attachments/${aid}`;return {id:aid,name:file.name,size:file.size,mimeType:file.type,kind:file.type.startsWith('image/')?'image':'file',url,downloadUrl:`${url}?download=1`}}
function sessionFile(){return file}
function deferred<T=UploadedAttachment>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}}
function tick(){return new Promise(resolve=>setTimeout(resolve,0))}
beforeEach(()=>{
 upload.mockReset()
 vi.stubGlobal('matchMedia',vi.fn(()=>({matches:true,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){},dispatchEvent(){return true}})))
 vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}})
})
afterEach(()=>{cleanup();vi.unstubAllGlobals()})
describe('conversation-scoped upload queue',()=>{
 it('limits concurrency, tracks real progress, and preserves failure for retry',async()=>{
   const jobs=[deferred(),deferred(),deferred(),deferred()];upload.mockImplementation(()=>jobs[upload.mock.calls.length-1].promise)
   const queue=new ChatAttachmentQueue('alpha');queue.add([file,file,file]);expect(upload).toHaveBeenCalledTimes(2)
   upload.mock.calls[0][2].onProgress(42);expect(queue.getSnapshot().items[0].progress).toBe(42)
   jobs[0].reject(new Error('网络中断'));await tick();expect(upload).toHaveBeenCalledTimes(3);expect(queue.getSnapshot().items[0]).toMatchObject({status:'failed',error:'网络中断'})
   jobs[1].resolve(meta(file,'2'));await tick();queue.retry(queue.getSnapshot().items[0].localId);expect(upload).toHaveBeenCalledTimes(4)
   jobs[3].resolve(meta());jobs[2].resolve(meta(file,'3'));await tick();expect(queue.getSnapshot().items.every(item=>item.status==='ready')).toBe(true)
   queue.clearSent([meta().id]);expect(queue.getSnapshot().items).toHaveLength(2);queue.dispose()
 })
 it('cancels a removed upload and ignores its late result while starting the next file',async()=>{
   const jobs=[deferred(),deferred(),deferred()];upload.mockImplementation(()=>jobs[upload.mock.calls.length-1].promise)
   const queue=new ChatAttachmentQueue('alpha');queue.add([file,file,file]);const first=queue.getSnapshot().items[0].localId,signal=upload.mock.calls[0][2].signal
   queue.remove(first);expect(signal.aborted).toBe(true);expect(upload).toHaveBeenCalledTimes(3)
   jobs[0].resolve(meta());await tick();expect(queue.getSnapshot().items.some(item=>item.localId===first)).toBe(false);queue.dispose()
 })
 it('rejects oversize and excess files without starting them',()=>{
   upload.mockImplementation(()=>new Promise(()=>{}));const queue=new ChatAttachmentQueue('alpha'),large=new File([],'large.zip');Object.defineProperty(large,'size',{value:50*1024*1024+1})
   queue.add([large,...Array.from({length:11},()=>file)]);expect(queue.getSnapshot().items).toHaveLength(10);expect(queue.getSnapshot().error).toContain('50 MiB');expect(queue.getSnapshot().error).toContain('10 个');expect(upload).toHaveBeenCalledTimes(2);queue.dispose()
 })
 it('clears private files on dispose and never lets an old identity enqueue or accept a response',async()=>{
   const job=deferred();upload.mockReturnValue(job.promise);let current=true;const queue=new ChatAttachmentQueue('alpha',()=>current);queue.add([file]);const signal=upload.mock.calls[0][2].signal
   current=false;queue.dispose();expect(signal.aborted).toBe(true);job.resolve(meta());await tick();queue.add([file]);expect(queue.getSnapshot().items).toHaveLength(0);expect(upload).toHaveBeenCalledOnce()
 })
})
function Harness({session='alpha',actor='employee'}:{session?:string;actor?:string}){const attachments=useChatAttachments(session,actor,()=>true),drop=useAttachmentDrop(attachments,false);return <div data-testid="drop" {...drop.handlers} data-dragging={drop.dragging}><AttachmentButton attachments={attachments} disabled={false}/><AttachmentList attachments={attachments} sessionId={session} disabled={false}/><button disabled={!attachments.hasFiles||attachments.blocked}>发送</button></div>}
describe('attachment composer and controlled user message rendering',()=>{
 it('offers selection, progress, failure retry, and readiness without sending early',async()=>{
   const first=deferred(),retry=deferred();upload.mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise);render(<Harness/>);
   fireEvent.change(screen.getByLabelText('选择聊天附件'),{target:{files:[file]}});expect(screen.getByRole('region',{name:'待发送附件'})).toBeTruthy();expect((screen.getByRole('button',{name:'发送'}) as HTMLButtonElement).disabled).toBe(true)
   act(()=>upload.mock.calls[0][2].onProgress(37));expect(screen.getByRole('progressbar',{name:`上传进度：${file.name}`})).toBeTruthy()
   await act(async()=>first.reject(new Error('连接失败')));expect(screen.getByRole('alert').textContent).toBe('连接失败')
   fireEvent.click(screen.getByRole('button',{name:`重试上传：${file.name}`}));await act(async()=>retry.resolve(meta()));expect((screen.getByRole('button',{name:'发送'}) as HTMLButtonElement).disabled).toBe(false)
   fireEvent.click(screen.getByRole('button',{name:`移除附件：${file.name}`}));expect(screen.queryByRole('region',{name:'待发送附件'})).toBeNull()
 })
 it('accepts dropped files and aborts pending upload when the group/account scope changes',async()=>{
   const job=deferred();upload.mockReturnValue(job.promise);const view=render(<Harness key="old"/>),target=screen.getByTestId('drop'),transfer={types:['Files'],files:[file],dropEffect:''}
   fireEvent.dragEnter(target,{dataTransfer:transfer});expect(target.getAttribute('data-dragging')).toBe('true');fireEvent.drop(target,{dataTransfer:transfer});expect(upload).toHaveBeenCalledOnce();const signal=upload.mock.calls[0][2].signal
   view.rerender(<Harness key="new" session="beta" actor="other"/>);expect(signal.aborted).toBe(true);await act(async()=>job.resolve(meta()));expect(screen.queryByRole('region',{name:'待发送附件'})).toBeNull()
 })
 it('renders canonical staff file downloads and image preview, stripping only the generated tail',()=>{
   const document=meta(),picture=meta(image,'2');const links=`[${file.name}](${document.url}?name=${encodeURIComponent(file.name)})\n\n![头像 (1)\\[新\\].png](${picture.url}?name=${encodeURIComponent(image.name).replace(/\(/g,'%28').replace(/\)/g,'%29')})`
   render(<UserMessageContent sessionId="alpha" content={`**普通文字**\n\n${links}`} attachments={[document,picture]}/>);
   expect(screen.getByText('**普通文字**')).toBeTruthy();expect(screen.getByRole('link',{name:`下载文件：${file.name}`})).toBeTruthy();expect(screen.getByRole('button',{name:`放大图片：${image.name}`})).toBeTruthy();expect(screen.queryByText(links)).toBeNull()
 })
 it('keeps forged historical links and other-group metadata plain',()=>{
   const fake=`[附件](${meta().url})`;const value=userAttachmentContent(fake,undefined,'alpha');expect(value).toEqual({content:fake,attachments:[]})
   render(<UserMessageContent sessionId="alpha" content={fake} attachments={[meta(file,'1','beta')]}/>);expect(screen.getByText(fake)).toBeTruthy();expect(screen.queryByRole('link')).toBeNull();expect(attachmentPreview(meta(file,'1','beta'),'alpha')).toBeUndefined()
 })
})
