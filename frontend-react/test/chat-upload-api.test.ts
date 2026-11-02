// @vitest-environment jsdom
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {advanceApiIdentity,apiAttachmentBytes,MAX_CHAT_FILE_BYTES,uploadChatAttachment} from '../src/lib/api'

const file=new File(['1234'],'清单 (1).csv',{type:'text/csv'})
const id='11111111-1111-4111-8111-111111111111'
function metadata(){const url=`/api/sessions/alpha/attachments/${id}`;return {id,name:file.name,size:file.size,mimeType:'text/csv',kind:'file',url,downloadUrl:`${url}?download=1`}}
class FakeXHR{
  static instances:FakeXHR[]=[]
  status=0;response:any;responseType='';timeout=0;headers:Record<string,string>={};body:any;method='';url=''
  onload:(()=>void)|null=null;onerror:(()=>void)|null=null;onabort:(()=>void)|null=null;ontimeout:(()=>void)|null=null
  upload:{onprogress:((event:any)=>void)|null}={onprogress:null}
  constructor(){FakeXHR.instances.push(this)}
  open(method:string,url:string){this.method=method;this.url=url}
  setRequestHeader(name:string,value:string){this.headers[name]=value}
  send(body:any){this.body=body}
  abort=vi.fn(()=>this.onabort?.())
  respond(status:number,response:any){this.status=status;this.response=response;this.onload?.()}
}
beforeEach(()=>{FakeXHR.instances=[];vi.stubGlobal('XMLHttpRequest',FakeXHR)})
afterEach(()=>vi.unstubAllGlobals())
describe('binary attachment transport',()=>{
  it('sends the original bytes and encoded filename, reports progress then accepts canonical metadata',async()=>{
    const progress=vi.fn(),promise=uploadChatAttachment('alpha',file,{onProgress:progress}),xhr=FakeXHR.instances[0]
    expect(xhr.method).toBe('POST');expect(xhr.url).toBe(`/api/sessions/alpha/attachments?name=${encodeURIComponent(file.name)}`)
    expect(xhr.body).toBe(file);expect(xhr.headers['Content-Type']).toBe('application/octet-stream')
    xhr.upload.onprogress?.({lengthComputable:true,loaded:4,total:4});expect(progress).toHaveBeenLastCalledWith(99)
    xhr.respond(201,{attachment:metadata()});expect(await promise).toEqual(metadata())
  })
  it('rejects a response for another group or an external URL',async()=>{
    const promise=uploadChatAttachment('alpha',file),reject=expect(promise).rejects.toThrow('同群附件')
    FakeXHR.instances[0].respond(201,{attachment:{...metadata(),url:'https://example.com/file'}});await reject
  })
  it('rejects oversize before opening a request',async()=>{
    const large=new File([],'large.zip');Object.defineProperty(large,'size',{value:MAX_CHAT_FILE_BYTES+1})
    await expect(uploadChatAttachment('alpha',large)).rejects.toThrow('50 MiB');expect(FakeXHR.instances).toHaveLength(0)
  })
  it('cancels and ignores a delayed old 401 after the account changes',async()=>{
    const expired=vi.fn();window.addEventListener('pi:auth-expired',expired)
    try{
      const controller=new AbortController(),promise=uploadChatAttachment('alpha',file,{signal:controller.signal}),reject=expect(promise).rejects.toMatchObject({name:'AbortError'}),xhr=FakeXHR.instances[0],late=xhr.onload
      controller.abort();advanceApiIdentity();xhr.status=401;xhr.response={error:'旧账号'};late?.();await reject
      expect(xhr.abort).toHaveBeenCalledOnce();expect(expired).not.toHaveBeenCalled()
    }finally{window.removeEventListener('pi:auth-expired',expired)}
  })
  it('expires the current identity on 401 but never a new identity',async()=>{
    const expired=vi.fn();window.addEventListener('pi:auth-expired',expired)
    try{
      const old=uploadChatAttachment('alpha',file),oldError=expect(old).rejects.toMatchObject({status:401});advanceApiIdentity();FakeXHR.instances[0].respond(401,{error:'expired'});await oldError;expect(expired).not.toHaveBeenCalled()
      const current=uploadChatAttachment('alpha',file),currentError=expect(current).rejects.toMatchObject({status:401});FakeXHR.instances[1].respond(401,{error:'expired'});await currentError;expect(expired).toHaveBeenCalledOnce()
    }finally{window.removeEventListener('pi:auth-expired',expired)}
  })
})

describe('authenticated PDF byte transport',()=>{
  it('reads same-origin bytes with the caller cancellation signal',async()=>{
    const fetcher=vi.fn().mockResolvedValue(new Response(new Uint8Array([37,80,68,70]),{headers:{'Content-Type':'application/pdf'}}));vi.stubGlobal('fetch',fetcher)
    const controller=new AbortController(),result=await apiAttachmentBytes('/api/sessions/alpha/attachments/'+id,{signal:controller.signal})
    expect(Array.from(result)).toEqual([37,80,68,70]);expect(fetcher).toHaveBeenCalledWith(expect.any(String),expect.objectContaining({signal:controller.signal,credentials:'same-origin',mode:'same-origin',redirect:'error'}))
  })
  it('bounds bytes even when the response omits its size',async()=>{
    const cancel=vi.fn(),releaseLock=vi.fn(),read=vi.fn().mockResolvedValue({done:false,value:{length:MAX_CHAT_FILE_BYTES+1}})
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,headers:new Headers(),body:{getReader:()=>({read,cancel,releaseLock})}}))
    await expect(apiAttachmentBytes('/attachment',{signal:new AbortController().signal})).rejects.toThrow('50 MiB');expect(cancel).toHaveBeenCalledOnce();expect(releaseLock).toHaveBeenCalledOnce()
  })
  it('keeps a delayed 401 from an older login from expiring the new login',async()=>{
    let resolve!:(value:Response)=>void;const fetcher=vi.fn().mockReturnValue(new Promise<Response>(yes=>{resolve=yes})),expired=vi.fn();vi.stubGlobal('fetch',fetcher);window.addEventListener('pi:auth-expired',expired)
    try{const pending=apiAttachmentBytes('/attachment',{signal:new AbortController().signal}),reject=expect(pending).rejects.toMatchObject({status:401});advanceApiIdentity();resolve(new Response(JSON.stringify({error:'expired'}),{status:401}));await reject;expect(expired).not.toHaveBeenCalled()}
    finally{window.removeEventListener('pi:auth-expired',expired)}
  })
})
