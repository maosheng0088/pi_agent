import type {UploadedAttachment} from '../lib/types'
import {userAttachmentContent} from '../lib/chat-attachments'
import AttachmentPreview from './AttachmentPreview'
import MessageContent from './MessageContent'

export default function UserMessageContent({content,attachments,sessionId}:{content:string;attachments?:UploadedAttachment[];sessionId:string}){
  const value=userAttachmentContent(content,attachments,sessionId)
  return <>{value.content&&<MessageContent content={value.content} plain/>}{!!value.attachments.length&&<div className="message-uploaded-attachments" aria-label="消息附件">{value.attachments.map(item=><AttachmentPreview key={item.href} attachment={item} label={item.name}/>)}</div>}</>
}
