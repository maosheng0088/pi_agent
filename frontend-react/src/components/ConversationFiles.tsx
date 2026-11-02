import {useMemo,useState} from 'react'
import {Input} from '@douyinfe/semi-ui'
import {IconFile,IconSearch} from '@douyinfe/semi-icons'
import type {Message} from '../lib/types'
import {conversationFiles,conversationDate} from '../lib/conversation-files'
import {formatFileSize} from '../lib/chat-attachments'
import AttachmentPreview from './AttachmentPreview'

export default function ConversationFiles({messages,sessionId,agentName,onLocate}:{messages:Message[];sessionId:string;agentName:string;onLocate(index:number):void}){
  const [query,setQuery]=useState(''),[category,setCategory]=useState<'all'|'file'|'image'>('all')
  const files=useMemo(()=>conversationFiles(messages,sessionId,agentName),[messages,sessionId,agentName])
  const shown=files.filter(item=>(category==='all'||(category==='image')===item.attachment.image)&&item.attachment.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  return <div className="conversation-files">
    <Input aria-label="搜索会话文件" prefix={<IconSearch aria-hidden/>} placeholder="搜索文件名称" value={query} onChange={setQuery} composition showClear autoFocus/>
    <div className="context-filter-tabs" aria-label="文件类型">{([['all','全部'],['file','文档与文件'],['image','图片']] as const).map(([value,label])=><button type="button" key={value} aria-pressed={category===value} onClick={()=>setCategory(value)}>{label}</button>)}</div>
    <p className="context-result-count" role="status">{query.trim()||category!=='all'?`找到 ${shown.length} 个文件`:`本会话共 ${files.length} 个文件`}</p>
    <div className="conversation-file-results">{shown.map(item=><section className="conversation-file-entry" key={item.attachment.href.split('?')[0]}>
      <AttachmentPreview attachment={item.attachment} label={item.attachment.name}/>
      <div className="conversation-file-origin"><button type="button" onClick={()=>onLocate(item.messageIndex)} aria-label={`定位文件消息：${item.attachment.name}`}>来自 {item.authorName}</button><span>{item.size!=null&&`${formatFileSize(item.size)} · `}{conversationDate(item.timestamp)}</span></div>
    </section>)}{!shown.length&&<div className="context-empty"><IconFile aria-hidden/><strong>{files.length?'没有匹配的文件':'文件都收在这里'}</strong><p>{files.length?'试试其他名称或文件类型。':'群里上传的文件和智能体生成的附件会集中显示。'}</p></div>}</div>
  </div>
}
