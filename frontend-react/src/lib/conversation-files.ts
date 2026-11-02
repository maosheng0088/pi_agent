import {attachmentPreview} from './chat-attachments'
import {messageTokens,type MessageAttachment} from './message-links'
import type {Message} from './types'

export interface ConversationFile {
  attachment:MessageAttachment
  messageIndex:number
  authorName:string
  timestamp?:string|number
  size?:number
}

function outsideCodeBlocks(content:string):string{
  let fence:{character:string;length:number}|undefined
  return content.split('\n').filter(line=>{
    const marker=/^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if(marker){
      if(!fence){fence={character:marker[1]![0]!,length:marker[1]!.length};return false}
      if(marker[1]![0]===fence.character&&marker[1]!.length>=fence.length&&!marker[2]!.trim()){fence=undefined;return false}
    }
    return !fence
  }).join('\n')
}

/** Index only published, current-space attachments; never infer local or external files. */
export function conversationFiles(messages:Message[],sessionId:string,agentName:string):ConversationFile[]{
  const files=new Map<string,ConversationFile>()
  const prefix=`/api/sessions/${encodeURIComponent(sessionId)}/attachments/`
  messages.forEach((message,index)=>{
    if(!['user','assistant'].includes(message.role)||message.tools?.length)return
    const messageIndex=Number.isInteger(message.messageIndex)&&message.messageIndex!>=0?message.messageIndex!:index
    const add=(attachment:MessageAttachment,size?:number)=>{
      if(!attachment.href.startsWith(prefix))return
      const key=attachment.href.split('?')[0]!
      files.set(key,{attachment,messageIndex,authorName:message.role==='assistant'?agentName:message.authorName||'历史成员',timestamp:message.timestamp,size})
    }
    for(const item of message.attachments||[]){const preview=attachmentPreview(item,sessionId);if(preview)add(preview,item.size)}
    if(message.role==='assistant'){
      // Code samples describe files; they are not delivered attachments.
      const content=outsideCodeBlocks(message.content||'')
      for(const token of messageTokens(content))if(token.kind==='attachment')add(token.attachment)
    }
  })
  return [...files.values()].reverse()
}

export function conversationDate(value?:string|number,now=new Date()):string{
  if(value==null||value==='')return ''
  const date=new Date(value)
  if(Number.isNaN(date.getTime()))return ''
  const day=new Date(now.getFullYear(),now.getMonth(),now.getDate())
  const yesterday=new Date(day);yesterday.setDate(yesterday.getDate()-1)
  if(date>=day)return date.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false})
  if(date>=yesterday)return '昨天'
  return date.toLocaleDateString('zh-CN',date.getFullYear()===now.getFullYear()?{month:'numeric',day:'numeric'}:{year:'numeric',month:'numeric',day:'numeric'})
}
