import {useEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react'
import type {DragEvent} from 'react'
import {Banner,Button,Progress} from '@douyinfe/semi-ui'
import {IconClose,IconCloudUploadStroked,IconFile,IconRefresh,IconTickCircle,IconUpload} from '@douyinfe/semi-icons'
import {ChatAttachmentQueue,attachmentPreview,formatFileSize} from '../lib/chat-attachments'
import {fileReadingHint} from '../lib/attachment-document'
import AttachmentPreview from './AttachmentPreview'
import '../chat-attachments.css'

export function useChatAttachments(sessionId:string,actorId:string,isCurrent:()=>boolean){
  const current=useRef(isCurrent);current.current=isCurrent
  const queue=useMemo(()=>new ChatAttachmentQueue(sessionId,()=>current.current()),[sessionId,actorId])
  const snapshot=useSyncExternalStore(queue.subscribe,queue.getSnapshot,queue.getSnapshot)
  useEffect(()=>{queue.activate();return()=>queue.dispose()},[queue])
  const readyIds=snapshot.items.flatMap(item=>item.status==='ready'&&item.attachment?[item.attachment.id]:[])
  return {queue,...snapshot,readyIds,hasFiles:snapshot.items.length>0,blocked:snapshot.items.some(item=>item.status!=='ready')}
}
export type AttachmentComposer = ReturnType<typeof useChatAttachments>

/** Drag handlers only claim actual files, preserving text selection and ordinary input drags. */
export function useAttachmentDrop(attachments:AttachmentComposer,disabled:boolean){
  const depth=useRef(0),[dragging,setDragging]=useState(false)
  useEffect(()=>{if(disabled){depth.current=0;setDragging(false)}},[disabled])
  const hasFiles=(event:DragEvent)=>Array.from(event.dataTransfer.types||[]).includes('Files')
  return {dragging,handlers:{
    onDragEnter:(event:DragEvent)=>{if(!hasFiles(event))return;event.preventDefault();if(disabled)return;depth.current++;setDragging(true)},
    onDragOver:(event:DragEvent)=>{if(!hasFiles(event))return;event.preventDefault();event.dataTransfer.dropEffect=disabled?'none':'copy'},
    onDragLeave:(event:DragEvent)=>{if(!hasFiles(event))return;event.preventDefault();depth.current=Math.max(0,depth.current-1);if(!depth.current)setDragging(false)},
    onDrop:(event:DragEvent)=>{if(!hasFiles(event))return;event.preventDefault();depth.current=0;setDragging(false);if(!disabled)attachments.queue.add(Array.from(event.dataTransfer.files||[]))},
  }}
}

export function AttachmentButton({attachments,disabled}:{attachments:AttachmentComposer;disabled:boolean}){
  const input=useRef<HTMLInputElement>(null)
  return <><input ref={input} className="pi-visually-hidden" type="file" multiple tabIndex={-1} aria-label="选择聊天附件" disabled={disabled} onChange={event=>{if(event.target.files)attachments.queue.add(Array.from(event.target.files));event.target.value=''}}/><Button className="chat-attach-button composer-tool" aria-label="添加附件" theme="borderless" htmlType="button" icon={<IconUpload aria-hidden="true"/>} disabled={disabled||attachments.items.length>=10} onClick={()=>input.current?.click()}><span className="composer-tool-label">附件</span></Button></>
}

export function AttachmentList({attachments,sessionId,disabled}:{attachments:AttachmentComposer;sessionId:string;disabled:boolean}){
  const [expanded,setExpanded]=useState<string|null>(null)
  return <>{attachments.error&&<Banner className="attachment-selection-error" type="warning" description={attachments.error} onClose={attachments.queue.clearError}/>} {attachments.hasFiles&&<section className="pending-attachments" aria-label="待发送附件"><div className="pending-attachments-heading"><strong>待发送附件 <span>{attachments.items.length}/10</span></strong><span>{attachments.blocked?'上传完成后可发送':'已上传，发送后加入当前对话'}</span></div><ul>{attachments.items.map(item=>{const preview=item.attachment&&attachmentPreview(item.attachment,sessionId),ready=item.status==='ready',failed=item.status==='failed';return <li key={item.localId}><div className={`pending-attachment-row ${failed?'upload-failed':''}`}><span className="pending-file-icon"><IconFile aria-hidden="true"/></span><div className="pending-file-info"><strong title={item.file.name}>{item.file.name}</strong><span>{formatFileSize(item.file.size)} · {ready?`上传完成 · ${fileReadingHint(item.file.name)}`:failed?'上传失败':item.status==='queued'?'等待上传':`正在上传 ${item.progress}%`}</span>{item.status==='uploading'&&<Progress percent={item.progress} showInfo={false} motion={false} aria-label={`上传进度：${item.file.name}`} aria-valuetext={`${item.progress}%`}/>} {failed&&<p role="alert">{item.error}</p>}</div><div className="pending-file-actions">{ready&&<IconTickCircle className="pending-upload-ok" aria-label="上传完成"/>}{ready&&preview?.image&&<Button theme="borderless" size="small" htmlType="button" aria-expanded={expanded===item.localId} onClick={()=>setExpanded(expanded===item.localId?null:item.localId)}>预览</Button>}{failed&&<Button theme="borderless" size="small" htmlType="button" icon={<IconRefresh aria-hidden="true"/>} disabled={disabled} aria-label={`重试上传：${item.file.name}`} onClick={()=>attachments.queue.retry(item.localId)}>重试</Button>}<Button theme="borderless" htmlType="button" icon={<IconClose aria-hidden="true"/>} disabled={disabled} aria-label={`${item.status==='uploading'||item.status==='queued'?'取消上传并移除':'移除附件'}：${item.file.name}`} onClick={()=>attachments.queue.remove(item.localId)}/></div></div>{expanded===item.localId&&preview&&<div className="pending-image-preview"><AttachmentPreview attachment={preview} label={item.attachment!.name}/></div>}</li>})}</ul><p className="attachment-format-hint">支持图片、PDF、Word（.docx）、Excel（.xlsx）、CSV 和文本；DOC、XLS、压缩包等仅下载。</p></section>}</>
}
export function AttachmentDropHint(){return <div className="chat-attachment-drop-hint" aria-hidden="true"><IconCloudUploadStroked/><strong>松开以添加文件</strong><span>最多 10 个，每个不超过 50 MiB</span></div>}
