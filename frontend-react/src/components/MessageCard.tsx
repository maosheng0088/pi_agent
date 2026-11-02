import { useId, type ReactNode } from 'react'
import { Button, Tag } from '@douyinfe/semi-ui'
import { IconArrowRight, IconFile, IconInfoCircle, IconLayers } from '@douyinfe/semi-icons'
import type { MessageCard as Card, MessageCardSource } from '../lib/types'
import MessageText from './MessageText'
import './message-cards.css'

export interface CardNavigation {
  onOpenTask?(taskId: string, kind: 'work' | 'schedule'): void;
  onOpenSource?(source: MessageCardSource, cardId: string): void;
}
const statusNames: Record<string, string> = { queued: '排队中', running: '执行中', waiting_human: '待人工处理', succeeded: '已完成', failed: '执行失败', cancelled: '已取消', interrupted: '已中断', skipped: '已跳过' }
function updatedAt(value: string) { return new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) }

export default function MessageCard({ card, children, onOpenTask, onOpenSource }: { card: Card; children?: ReactNode } & CardNavigation) {
  const heading = useId(), knowledge = card.kind === 'knowledge', exception = card.kind === 'task_exception'
  return <section className={`pi-message-card ${knowledge ? 'is-knowledge' : exception ? 'is-exception' : 'is-result'}`} aria-labelledby={heading}>
    <header className="pi-message-card-header"><span className="pi-message-card-symbol" aria-hidden="true">{knowledge ? <IconFile /> : exception ? <IconInfoCircle /> : <IconLayers />}</span><div><span className="pi-message-card-eyebrow">{knowledge ? '资料依据' : exception ? '任务需要关注' : '业务任务结果'}</span><h4 id={heading}>{card.title}</h4></div>{card.status && <Tag color={card.status === 'succeeded' ? 'green' : card.status === 'failed' || card.status === 'interrupted' ? 'red' : card.status === 'waiting_human' ? 'orange' : card.status === 'running' || card.status === 'queued' ? 'blue' : 'grey'} size="small">{statusNames[card.status]}</Tag>}</header>
    {card.summary && <div className="pi-message-card-summary"><MessageText content={card.summary}/></div>}
    {children && <div className="pi-message-card-body">{children}</div>}
    {!!card.sources?.length && <ul className="pi-message-card-sources" aria-label="资料来源">{card.sources.map((source, index) => <li key={`${source.documentId}:${source.version}:${index}`}><div><strong>{source.title}{source.cited !== undefined && <Tag size="small" color={source.cited ? 'blue' : 'grey'}>{source.cited ? '回答已引用' : '本次参考'}</Tag>}</strong><span>{source.sourceName || '知识库资料'} · 版本 {source.version}</span><small>资料更新于 {updatedAt(source.updatedAt)}（北京时间）</small>{source.excerpt && <p className="pi-message-source-excerpt">{source.excerpt}</p>}</div>{onOpenSource && <Button size="small" theme="borderless" onClick={() => onOpenSource(source, card.id)} aria-label={`查看来源：${source.title}，版本 ${source.version}`}>查看来源<IconArrowRight aria-hidden="true" /></Button>}</li>)}</ul>}
    {card.taskId && card.taskKind === 'work' && onOpenTask && <footer className="pi-message-card-footer"><Button size="small" theme="borderless" onClick={() => onOpenTask(card.taskId!, 'work')}>查看任务<IconArrowRight aria-hidden="true" /></Button><span>进度与人工协作</span></footer>}
  </section>
}
