import type { Message } from './types'
import {userAttachmentContent} from './chat-attachments'

export function plainSummary(content: string): string {
  return content
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
    .replace(/^\s*(`{3,}|~{3,})[^\n]*$/gm, '')
    .replace(/^\s*\[[^\]]+\]:\s+\S+.*$/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/<(https?:\/\/[^>]+)>/g, '$1')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/^\s{0,3}(?:[-*_]\s*){3,}$/gm, '')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>+\s*|[-+*]\s+|\d+[.)]\s+)/gm, '')
    .replace(/(`+)([^`]*?)\1/g, '$2')
    .replace(/(\*\*|__|~~)([\s\S]*?)\1/g, '$2')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s),.!?，。！？])/g, '$1$2')
    .replace(/\\([\\`*{}\[\]()#+\-.!_>])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Summarize only messages that the conversation itself can currently show. */
export function conversationPreview(messages: Message[], active = false, sessionId?:string): string {
  const lastUser = messages.findLastIndex(message => message.role === 'user')
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (!message || !['user', 'assistant'].includes(message.role) || message.pending || message.tools?.length) continue
    if (message.role === 'assistant' && active && index > lastUser && !message.taskRunId && !message.workTaskId) continue
    if (typeof message.content !== 'string') continue
    const canonical = message.role === 'user' ? userAttachmentContent(message.content, message.attachments, sessionId || message.sessionId || '') : { content: message.content, attachments: [] }
    const files = canonical.attachments.map(item => `[${item.image ? '图片' : '文件'}] ${item.name}`).join('、')
    const summary = [plainSummary(canonical.content), files].filter(Boolean).join(' ')
    if (!summary) continue
    const characters = Array.from(summary)
    const excerpt = characters.length > 90 ? `${characters.slice(0, 89).join('')}…` : summary
    const author = message.role === 'assistant' ? 'AI' : message.authorName?.replace(/\s+/g, ' ').trim() || '成员'
    return `${author}：${excerpt}`
  }
  return ''
}
