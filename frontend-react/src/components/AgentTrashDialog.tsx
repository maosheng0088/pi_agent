import { useEffect, useId, useRef, useState } from 'react'
import { Banner, Button, Empty, Input, Modal, Spin, Tag, Toast } from '@douyinfe/semi-ui'
import { IconDelete, IconRefresh, IconSearch } from '@douyinfe/semi-icons'
import { api, ApiError, errorMessage } from '../lib/api'
import AgentAvatar from './AgentAvatar'

interface TrashedAgent { id: string; title: string; avatarId?: string; deletedAt: string; deletedByName?: string; cwd: string; pausedScheduleCount: number; purging: boolean; purgeError?: string }
interface Props { onClose(): void; onRestored(id: string): void | Promise<void> }
const date = (value: string) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' }).format(new Date(value))

export default function AgentTrashDialog({ onClose, onRestored }: Props) {
  const [agents, setAgents] = useState<TrashedAgent[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState(''), [query, setQuery] = useState('')
  const [choice, setChoice] = useState<TrashedAgent | null>(null), [confirmation, setConfirmation] = useState(''), [busy, setBusy] = useState(false), [locked, setLocked] = useState(false)
  const controller = useRef(new AbortController()), alive = useRef(true), working = useRef(false), requestVersion = useRef(0), inputId = useId()
  const valid = () => alive.current && !controller.current.signal.aborted
  function fail(reason: unknown) {
    if (!valid()) return
    if (reason instanceof ApiError && [401, 403].includes(reason.status)) { setLocked(true); setAgents([]); setChoice(null); controller.current.abort() }
    setError(errorMessage(reason))
  }
  async function load() {
    const version = ++requestVersion.current
    const result = await api<{ agents: TrashedAgent[] }>('/api/admin/agent-trash', { signal: controller.current.signal })
    if (valid() && version === requestVersion.current) setAgents(result.agents || [])
  }
  useEffect(() => {
    alive.current = true; controller.current = new AbortController()
    void load().catch(fail).finally(() => { if (valid()) setLoading(false) })
    const expired = () => { setLocked(true); setAgents([]); setChoice(null); setError('登录或管理员权限已失效，请重新进入。'); controller.current.abort() }
    window.addEventListener('pi:auth-expired', expired)
    return () => { alive.current = false; requestVersion.current++; controller.current.abort(); window.removeEventListener('pi:auth-expired', expired) }
  }, [])
  async function change(agent: TrashedAgent, purge: boolean) {
    if (working.current || locked || !valid() || purge && confirmation !== agent.title) return
    working.current = true; setBusy(true); setError('')
    try {
      await api(`/api/admin/agent-trash/${encodeURIComponent(agent.id)}${purge ? '' : '/restore'}`, {
        method: purge ? 'DELETE' : 'POST', body: { deletedAt: agent.deletedAt, ...(purge ? { confirmTitle: confirmation } : {}) }, signal: controller.current.signal,
      })
      if (!valid()) return
      setChoice(null); setConfirmation(''); setAgents(items => items.filter(item => item.id !== agent.id))
      Toast.success(purge ? '智能体及工作文件已永久删除。' : '智能体已恢复，关联定时任务保持暂停。')
      if (!purge) void Promise.resolve(onRestored(agent.id)).catch(() => Toast.warning('智能体已恢复，请刷新管理列表。'))
      await load()
    } catch (reason) {
      fail(reason)
      // A failed physical cleanup remains visible and can be retried, never silently restored.
      if (valid()) await load().catch(fail)
    } finally { working.current = false; if (alive.current) setBusy(false) }
  }
  const filtered = agents.filter(agent => agent.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  function back() { if (working.current) return; if (choice) { setChoice(null); setConfirmation(''); setError('') } else onClose() }
  // Keep a single dialog: Semi's modal title IDs are shared by simultaneous
  // instances. One confirmation step preserves an unambiguous accessible name.
  return <Modal visible title={choice ? '永久删除智能体' : `智能体垃圾箱${agents.length ? ` · ${agents.length}` : ''}`} className="pi-management-modal agent-trash-modal" width={choice ? 560 : 840}
    onCancel={back} closable={!busy} maskClosable={!busy} closeOnEsc={!busy}
    footer={choice ? <><Button disabled={busy} onClick={back}>取消</Button><Button type="danger" theme="solid" loading={busy} disabled={locked || confirmation !== choice.title} onClick={() => void change(choice, true)}>永久删除</Button></> : null}>
    {choice ? <>
      <Banner type="danger" closeIcon={null} description="将永久删除该智能体的聊天记录、附件、配置和整个工作文件夹。删除后无法在垃圾箱恢复。"/>
      <p className="agent-trash-path">工作文件夹：<code>{choice.cwd}</code></p>
      <div className="pi-dialog-field"><label htmlFor={inputId}>输入“{choice.title}”确认删除</label><Input id={inputId} value={confirmation} onChange={setConfirmation} disabled={busy || locked} autoComplete="off" autoFocus/></div>
      {error && <p className="pi-dialog-error" role="alert">{error}</p>}
    </> : <>
      <p className="pi-dialog-description">移入垃圾箱的智能体会保留聊天、成员和文件，可恢复使用。恢复后，请确认并重新启用所需定时任务。</p>
      {error && <Banner type="warning" closeIcon={null} description={<span role="alert">{error}</span>}/>} 
      {!locked && <><div className="agent-trash-toolbar"><Input value={query} onChange={setQuery} aria-label="搜索垃圾箱智能体" placeholder="搜索智能体" prefix={<IconSearch aria-hidden/>} showClear/><Button icon={<IconRefresh aria-hidden/>} disabled={busy || loading} onClick={() => { setError(''); void load().catch(fail) }}>刷新</Button></div>
      {loading ? <div className="agent-trash-loading" role="status"><Spin/>正在读取垃圾箱…</div> : <div className="agent-trash-list">{filtered.map(agent => <article className="agent-trash-row" key={agent.id}>
        <AgentAvatar identity={agent.id} title={agent.title} avatarId={agent.avatarId} size={44}/><div className="agent-trash-identity"><strong>{agent.title}</strong><p>{date(agent.deletedAt)} · {agent.deletedByName || '管理员'}移入</p>
          {!!agent.pausedScheduleCount && <small>{agent.pausedScheduleCount} 个定时任务已暂停</small>}{agent.purging && <Tag color="orange">待完成清理</Tag>}{agent.purgeError && <p className="agent-trash-error">{agent.purgeError}</p>}</div>
        <div className="agent-trash-actions"><Button disabled={busy || agent.purging} aria-label={`恢复：${agent.title}`} onClick={() => void change(agent, false)}>恢复</Button><Button type="danger" theme="borderless" disabled={busy} icon={<IconDelete aria-hidden/>} aria-label={`永久删除：${agent.title}`} onClick={() => { setChoice(agent); setConfirmation(''); setError('') }}>{agent.purging ? '重试清理' : '永久删除'}</Button></div>
      </article>)}{!filtered.length && <Empty title={agents.length ? '未找到匹配的智能体' : '垃圾箱为空'} description={agents.length ? '试试其他名称。' : '移入垃圾箱的智能体会显示在这里。'}/>}</div>}</>}
    </>}
  </Modal>
}
