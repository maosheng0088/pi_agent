import { useId, useMemo, useState } from 'react'
import MessageCard, { type CardNavigation } from './MessageCard'
import MessageText from './MessageText'
import AttachmentPreview from './AttachmentPreview'
import { messageCards } from '../lib/message-cards'
import { plainSummary } from '../lib/conversation-preview'
import { inlineCodeSpans, messageBlocks } from '../lib/message-markdown'
import { messageTokens, type MessageToken } from '../lib/message-links'
import { fileIconSource } from '../lib/artwork'
import './message-content-collapse.css'

const COLLAPSE_THRESHOLD = 1400
const PREVIEW_CHARACTERS = 240
type FileToken = Extract<MessageToken, { kind: 'attachment' | 'link' }>

function comparisonText(value: string) {
 return value.replace(/\\([\\`*_[\]{}()#+.!>|-])/g, '$1').replace(/\s+/g, ' ').trim().replace(/(?:…|\.{3})$/, '').trim()
}
function repeatsBody(summary: string | undefined, content: string, scheduleTitle?: string) {
 if (!summary?.trim() || !content.trim()) return false
 const candidates = [content]
 // TaskDelivery adds this exact heading to scheduled results, while the card's
 // summary is made from the unwrapped result. Keep the stored/copyable message
 // intact and compare past the known heading only for its matching schedule.
 const heading = content.match(/^([^\r\n]*)\r?\n(?:\r?\n)*/)
 if (scheduleTitle && heading && comparisonText(heading[1]!) === comparisonText(`定时任务：${scheduleTitle}`)) candidates.push(content.slice(heading[0].length))
 const raw = comparisonText(summary), plain = comparisonText(plainSummary(summary))
 return candidates.some(value => (!!raw && comparisonText(value).startsWith(raw)) || (!!plain && comparisonText(plainSummary(value)).startsWith(plain)))
}
/** Match the existing safe renderer's code/link precedence. In particular, an
 * apparent attachment inside a fenced/inline code example is never promoted. */
function inlineTokens(text: string): MessageToken[] {
 const spans = inlineCodeSpans(text), result: MessageToken[] = []
 const containers = /\*\*[^*\n]+\*\*|!?\[(?:\\[^\r\n]|[^\]\\\r\n]){0,512}\]\(/g
 let previous = 0, index = 0
 while (index < spans.length) {
  const span = spans[index]!
  if (span.start < previous) { index++; continue }
  containers.lastIndex = previous
  const container = containers.exec(text)
  if (container && container.index < span.start) {
   let end = containers.lastIndex
   if (!container[0].startsWith('**')) {
    let depth = 1, close = end
    const limit = Math.min(text.length, end + 8192)
    for (; close < limit; close++) { if (text[close] === '\n') break; if (text[close] === '(') depth++; if (text[close] === ')' && --depth === 0) break }
    if (depth === 0 && close < limit) end = close + 1
   }
   result.push(...messageTokens(text.slice(previous, end))); previous = end; continue
  }
  if (span.start > previous) result.push(...messageTokens(text.slice(previous, span.start)))
  // A code span is literal data, not an attachment-bearing text segment.
  result.push({ kind: 'code', text: span.content })
  previous = span.end; index++
 }
 if (previous < text.length) result.push(...messageTokens(text.slice(previous)))
 return result
}

function longContentData(content: string) {
 const blocks = messageBlocks(content), files: FileToken[] = [], seen = new Set<string>(), lines: string[] = [], headings: string[] = []
 const readInline = (text: string) => {
  const parsed = inlineTokens(text)
  for (const token of parsed) {
   if (token.kind !== 'attachment' && !(token.kind === 'link' && token.file)) continue
   const key = token.kind === 'attachment' ? token.attachment.href.split('?')[0]! : token.href
   if (!seen.has(key)) { seen.add(key); files.push(token) }
  }
  return parsed.filter(token => token.kind !== 'attachment' && !(token.kind === 'link' && token.file)).map(token => token.text).join('')
 }
 for (const block of blocks) {
  if (block.kind === 'line') { const value = plainSummary(readInline(block.text)); if (value && !/^(?:附件|文件|下载(?:结果|清单)?)[：:。\s]*$/.test(value)) lines.push(value) }
  else if (block.kind === 'heading') { const value = plainSummary(readInline(block.text)); if (value) headings.push(value) }
  else if (block.kind === 'list') for (const item of block.items) { const value = plainSummary(readInline(item)); if (value) lines.push(value) }
  else if (block.kind === 'table') for (const row of [block.header, ...block.rows]) for (const cell of row) readInline(cell)
 }
 const original = lines.slice(0, 3).join('\n') || headings[0] || (blocks.some(block => block.kind === 'table') ? '表格内容较长，展开后查看完整数据。' : '回复内容较长，可展开查看完整内容。')
 const characters = Array.from(original)
 let preview = original
 if (characters.length > PREVIEW_CHARACTERS) {
  let excerpt = characters.slice(0, PREVIEW_CHARACTERS).join('')
  const sentence = [...excerpt.matchAll(/[。！？；\n]/gu)].at(-1)?.index
  if (sentence !== undefined && sentence > 50) excerpt = excerpt.slice(0, sentence + 1)
  // Do not make a truncated identifier, date or amount look like a full value.
  else excerpt = excerpt.replace(/[A-Za-z0-9_./:@+\-]+$/u, '')
  preview = `${excerpt.trim() || '回复内容较长，可展开查看完整内容。'}…`
 }
 return { preview, files }
}

function FoldedAttachments({ files }: { files: FileToken[] }) {
 if (!files.length) return null
 return <section className="pi-message-folded-attachments" aria-label="消息附件"><span className="pi-message-folded-attachment-label">附件 · 无需展开即可查看</span><div className="pi-message-folded-attachment-list">{files.map((token, index) => token.kind === 'attachment'
  ? <AttachmentPreview key={token.attachment.href} attachment={token.attachment} label={token.text} />
  : token.file ? <a key={`${token.href}:${index}`} className="message-file-link" href={token.href} target="_blank" rel="noopener noreferrer"><img src={fileIconSource(token.file.name)} alt=""/><span><strong>{token.text || token.file.name}</strong><small>{token.file.name} · {token.file.typeLabel} · {token.file.hostname}</small></span><span aria-hidden="true">↗</span></a> : null)}</div></section>
}

function ExpandableResult({ content, hasSummary }: { content: string; hasSummary: boolean }) {
 const [expanded, setExpanded] = useState(false), bodyId = useId()
 const { preview, files } = useMemo(() => longContentData(content), [content])
 return <div className="message-long-reply">
  {!hasSummary && !expanded && <div className="pi-message-long-preview" aria-label="回复内容预览">{preview}</div>}
  <details className="pi-message-long-details" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
   <summary aria-expanded={expanded} aria-controls={bodyId} onClick={event => { event.preventDefault(); setExpanded(value => !value) }}>{expanded ? '收起完整结果' : `展开完整结果（${content.length.toLocaleString('zh-CN')} 字符）`}</summary>
   {expanded && <div id={bodyId}><MessageText content={content} /></div>}
  </details>
  {!expanded && <FoldedAttachments files={files} />}
 </div>
}

export default function MessageContent({ content, plain = false, cards, onOpenTask, onOpenSource }: { content: string; plain?: boolean; cards?: unknown } & CardNavigation) {
 if (plain) return <div className="message-prose plain-prose">{content}</div>
 const taskCards = messageCards(cards).filter(card => card.kind !== 'knowledge').map(card => repeatsBody(card.summary, content, card.taskKind === 'schedule' ? card.title : undefined) ? { ...card, summary: undefined } : card)
 const body = content.length > COLLAPSE_THRESHOLD ? <ExpandableResult content={content} hasSummary={!!taskCards[0]?.summary?.trim()} /> : <MessageText content={content} />
 if (!taskCards.length) return body
 return <>
  {taskCards.map((card, index) => <MessageCard key={card.id} card={card} onOpenTask={onOpenTask} onOpenSource={onOpenSource}>{index === 0 ? body : null}</MessageCard>)}
 </>
}
