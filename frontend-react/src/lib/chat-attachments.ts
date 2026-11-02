import {MAX_CHAT_FILES,MAX_CHAT_FILE_BYTES,errorMessage,uploadChatAttachment} from './api'
import {messageAttachment} from './message-links'
import type {UploadedAttachment} from './types'

export type PendingAttachment = {localId:string;file:File;status:'queued'|'uploading'|'ready'|'failed';progress:number;attachment?:UploadedAttachment;error?:string}
type Snapshot = {items:PendingAttachment[];error:string}
type Upload = typeof uploadChatAttachment

/** The queue belongs to one mounted conversation and never stores private files globally. */
export class ChatAttachmentQueue {
  private snapshot:Snapshot={items:[],error:''}
  private listeners=new Set<()=>void>()
  private requests=new Map<string,{controller:AbortController;token:symbol}>()
  private disposed=false
  constructor(private sessionId:string,private isCurrent:()=>boolean=()=>true,private upload:Upload=uploadChatAttachment){}
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener)}}
  getSnapshot=()=>this.snapshot
  activate(){this.disposed=false}
  private current(){return !this.disposed&&this.isCurrent()}
  private set(value:Snapshot){this.snapshot=value;this.listeners.forEach(listener=>listener())}
  private update(id:string,patch:Partial<PendingAttachment>){this.set({...this.snapshot,items:this.snapshot.items.map(item=>item.localId===id?{...item,...patch}:item)})}
  add(files:Iterable<File>){
    if(!this.current())return
    const items=[...this.snapshot.items],errors:string[]=[]
    for(const file of files){
      if(file.size>MAX_CHAT_FILE_BYTES){errors.push(`“${file.name}”超过 50 MiB，未添加。`);continue}
      if(items.length>=MAX_CHAT_FILES){if(!errors.some(value=>value.startsWith('每条消息')))errors.push('每条消息最多添加 10 个文件。');continue}
      items.push({localId:crypto.randomUUID(),file,status:'queued',progress:0})
    }
    this.set({items,error:errors.join(' ')});this.pump()
  }
  remove(id:string){
    const request=this.requests.get(id);this.requests.delete(id)
    this.set({...this.snapshot,items:this.snapshot.items.filter(item=>item.localId!==id)})
    request?.controller.abort();this.pump()
  }
  retry(id:string){if(!this.current())return;const item=this.snapshot.items.find(item=>item.localId===id);if(item?.status!=='failed')return;this.update(id,{status:'queued',progress:0,error:undefined});this.pump()}
  clearError=()=>this.set({...this.snapshot,error:''})
  clearSent(ids:string[]){const sent=new Set(ids);this.set({items:this.snapshot.items.filter(item=>!item.attachment||!sent.has(item.attachment.id)),error:''})}
  private pump(){
    if(!this.current())return
    for(const item of this.snapshot.items){
      if(this.requests.size>=2)break
      if(item.status!=='queued')continue
      const controller=new AbortController(),token=Symbol(item.localId)
      this.requests.set(item.localId,{controller,token});this.update(item.localId,{status:'uploading'})
      const valid=()=>this.current()&&this.requests.get(item.localId)?.token===token&&!controller.signal.aborted
      this.upload(this.sessionId,item.file,{signal:controller.signal,onProgress:progress=>{if(valid())this.update(item.localId,{progress})}})
        .then(attachment=>{if(valid())this.update(item.localId,{status:'ready',progress:100,attachment,error:undefined})})
        .catch(error=>{if(valid())this.update(item.localId,{status:'failed',error:errorMessage(error)})})
        .finally(()=>{if(this.requests.get(item.localId)?.token!==token)return;this.requests.delete(item.localId);this.pump()})
    }
  }
  dispose(){this.disposed=true;const requests=[...this.requests.values()];this.requests.clear();requests.forEach(item=>item.controller.abort());this.snapshot={items:[],error:''}}
}

export function attachmentPreview(item:UploadedAttachment,sessionId:string){
  if(!item||typeof item.id!=='string'||typeof item.name!=='string'||!item.name.trim()||item.name.length>512||!Number.isSafeInteger(item.size)||item.size<0||item.size>MAX_CHAT_FILE_BYTES||typeof item.mimeType!=='string'||item.mimeType.length>180)return
  const base=`/api/sessions/${encodeURIComponent(sessionId)}/attachments/${item.id}`
  if(item.url!==base||item.downloadUrl!==`${base}?download=1`||!['image','file'].includes(item.kind))return
  const preview=messageAttachment(`${base}?name=${encodeURIComponent(item.name)}`,item.name,item.kind==='image')
  if(!preview)return
  return {...preview,image:item.kind==='image'&&['image/png','image/jpeg','image/gif','image/webp'].includes(item.mimeType)}
}

/** Match only the canonical suffix emitted by the server. User-authored text is never parsed. */
export function userAttachmentContent(content:string,attachments:UploadedAttachment[]|undefined,sessionId:string){
  if(!Array.isArray(attachments)||!attachments.length||attachments.length>MAX_CHAT_FILES)return {content,attachments:[]}
  const previews=attachments.map(item=>attachmentPreview(item,sessionId))
  if(previews.some(item=>!item)||new Set(attachments.map(item=>item.id)).size!==attachments.length)return {content,attachments:[]}
  const links=attachments.map(item=>{
    const label=item.name.replace(/\r\n|[\r\n\u2028\u2029]/g,' ').replace(/\\/g,'\\\\').replace(/\[/g,'\\[').replace(/\]/g,'\\]')
    const wellFormed=item.name.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,'\uFFFD')
    const name=encodeURIComponent(wellFormed).replace(/\(/g,'%28').replace(/\)/g,'%29')
    return `${item.kind==='image'?'!':''}[${label}](${item.url}?name=${name})`
  }).join('\n\n')
  const body=content===links?'':content.endsWith(`\n\n${links}`)?content.slice(0,-links.length-2):content
  return {content:body,attachments:previews.filter((item):item is NonNullable<typeof item>=>!!item)}
}

export function formatFileSize(bytes:number){return bytes<1024?`${bytes} B`:bytes<1024*1024?`${(bytes/1024).toFixed(1)} KB`:`${(bytes/1024/1024).toFixed(1)} MiB`}
