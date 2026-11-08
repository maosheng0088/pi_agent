import { lazy, Suspense, useCallback, useEffect, useId, useRef, useState } from 'react'
import { Banner, Button, Checkbox, Empty, Input, Modal, Radio, RadioGroup, Spin, TabPane, Tabs, Tag, Toast } from '@douyinfe/semi-ui'
import { IconArrowRight, IconDelete, IconPlus, IconRefresh, IconSearch } from '@douyinfe/semi-icons'
import { api, ApiError, errorMessage, type ApiOptions } from '../lib/api'
import type { MembersResponse, Session, Skill, User } from '../lib/types'
import { channelIdentity, skillArtwork } from '../lib/artwork'
import AgentAvatar from '../components/AgentAvatar'
import UserAvatar from '../components/UserAvatar'
import AvatarPicker from '../components/AvatarPicker'
import MembersDialog from '../components/MembersDialog'
import CreateAgentDialog from '../components/CreateAgentDialog'
import './agent-management.css'

const AgentWorkbench = lazy(() => import('../components/AgentWorkbench'))
const AgentTrashDialog = lazy(() => import('../components/AgentTrashDialog'))
interface Props { user: User; sessions: Session[]; currentSessionId?: string; onChanged(): void | Promise<void>; onOpenSession(id: string): void | Promise<void>; onTrashed?(id: string): void }
interface Channel { id: string; name: string; type: string; enabled?: boolean; sessionId?: string; sessionTitle?: string; connectionMode?: 'websocket' | 'webhook' }

// Every panel owns an abortable lifetime. Denied access clears the rendered panel
// and late requests cannot repopulate data after changing agents or accounts.
function usePanelAccess() {
  const controller = useRef(new AbortController()), alive = useRef(false), denied = useRef(false), working = useRef(false)
  const [error, setError] = useState(''), [locked, setLocked] = useState(false), [busy, setBusy] = useState(false)
  useEffect(() => { alive.current = true; controller.current = new AbortController(); const expire = () => { denied.current = true; setLocked(true); setError('登录或访问权限已失效，请重新进入。'); controller.current.abort() }; window.addEventListener('pi:auth-expired', expire); return () => { alive.current = false; controller.current.abort(); window.removeEventListener('pi:auth-expired', expire) } }, [])
  const valid = useCallback(() => alive.current && !denied.current && !controller.current.signal.aborted, [])
  const request = useCallback(<T,>(path: string, options: ApiOptions = {}) => api<T>(path, { ...options, signal: controller.current.signal }), [])
  const fail = useCallback((reason: unknown) => { if (!alive.current || controller.current.signal.aborted) return; if (reason instanceof ApiError && [401, 403, 404].includes(reason.status)) { denied.current = true; setLocked(true); controller.current.abort() }; setError(errorMessage(reason)) }, [])
  async function mutate(operation: () => Promise<void>) { if (!valid() || working.current) return; working.current = true; setBusy(true); setError(''); try { await operation() } catch (reason) { fail(reason) } finally { if (alive.current) { working.current = false; setBusy(false) } } }
  return { request, valid, fail, mutate, error, locked, busy }
}
function PanelError({ error }: { error: string }) { return error ? <Banner type="warning" description={<span role="alert">{error}</span>} closeIcon={null}/> : null }

export default function AgentManagementPage(props: Props) {
  return props.user.role === 'admin' ? <Management key={`${props.user.id}:${props.user.role}`} {...props}/> : <Banner type="warning" description="仅管理员可管理智能体。"/>
}
function Management({ user, sessions, currentSessionId, onChanged, onOpenSession, onTrashed }: Props) {
  const [selected, setSelected] = useState(currentSessionId || sessions[0]?.id || ''), [query, setQuery] = useState(''), [creating, setCreating] = useState(false)
  const [trashOpen, setTrashOpen] = useState(false)
  const current = sessions.find(item => item.id === selected) || sessions[0]
  const filtered = sessions.filter(item => item.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  useEffect(() => { const url = new URL(location.href), params = new URLSearchParams(url.hash.slice(1)); if (params.get('view') !== 'agents' || !current || params.get('agent') === current.id) return; params.set('agent', current.id); url.hash = params.toString(); history.replaceState(null, '', url) }, [current?.id])
  return <section className="agent-management-page" aria-label="智能体管理">
    <header className="agent-management-heading"><div><span className="eyebrow">AGENT MANAGEMENT</span><h1>智能体管理 <small>{sessions.length}</small></h1><p>在这里统一维护智能体，聊天页面专注团队协作。</p></div><div><Button icon={<IconDelete aria-hidden/>} onClick={() => setTrashOpen(true)}>垃圾箱</Button><Button icon={<IconRefresh aria-hidden/>} onClick={() => void onChanged()}>刷新</Button><Button theme="solid" icon={<IconPlus aria-hidden/>} onClick={() => setCreating(true)}>创建智能体</Button></div></header>
    <div className="agent-management-layout"><nav className="agent-management-list" aria-label="选择要管理的智能体"><Input value={query} onChange={setQuery} aria-label="搜索要管理的智能体" placeholder="搜索智能体" prefix={<IconSearch aria-hidden/>} showClear/><div>{filtered.map(item => <button type="button" className={current?.id === item.id ? 'selected' : ''} key={item.id} aria-current={current?.id === item.id ? 'true' : undefined} onClick={() => setSelected(item.id)}><AgentAvatar identity={item.id} title={item.title} avatarId={item.avatarId} size={38}/><span className="agent-management-item-text"><strong>{item.title}</strong><small>{typeof item.memberCount === 'number' ? `${item.memberCount} 位成员` : '成员协作空间'}{item.running ? ' · 运行中' : ''}</small></span><IconArrowRight aria-hidden/></button>)}{!filtered.length && <p>没有找到智能体。</p>}</div></nav>
      <div className="agent-management-detail">{current ? <AgentConfiguration key={`${user.id}:${current.id}`} session={current} user={user} onChanged={onChanged} onOpenSession={onOpenSession} onTrashed={onTrashed}/> : <Empty title="还没有可管理的智能体" description="创建一个专业智能体，为它配置岗位、知识与技能。"/>}</div>
    </div>
    <CreateAgentDialog open={creating} user={user} onClose={() => setCreating(false)} onCreated={id => { setSelected(id); setCreating(false); void onChanged() }}/>
    {trashOpen && <Suspense fallback={<Spin tip="正在打开垃圾箱…"/>}><AgentTrashDialog onClose={() => setTrashOpen(false)} onRestored={id => { setSelected(id); return onChanged() }}/></Suspense>}
  </section>
}
function AgentConfiguration({ session, user, onChanged, onOpenSession, onTrashed }: { session: Session; user: User; onChanged: Props['onChanged']; onOpenSession: Props['onOpenSession']; onTrashed: Props['onTrashed'] }) {
  const [tab, setTab] = useState('basic')
  const [deleting, setDeleting] = useState(false)
  return <><header className="agent-configuration-heading"><AgentAvatar title={session.title} identity={session.id} avatarId={session.avatarId} size={46}/><div><h2>{session.title}</h2><p>配置仅作用于当前智能体</p></div><Button type="danger" theme="borderless" icon={<IconDelete aria-hidden/>} disabled={session.running} title={session.running ? '请先停止正在执行的任务' : '移入垃圾箱后可恢复'} onClick={() => setDeleting(true)}>移入垃圾箱</Button><Button onClick={() => void onOpenSession(session.id)}>进入聊天<IconArrowRight aria-hidden/></Button></header>
    <Tabs activeKey={tab} onChange={setTab} lazyRender keepDOM className="agent-configuration-tabs">
      <TabPane tab="基本设置" itemKey="basic"><BasicSettings session={session} onChanged={onChanged}/></TabPane>
      <TabPane tab="岗位与知识" itemKey="profile"><Suspense fallback={<Spin tip="正在打开岗位与知识…"/>}><AgentWorkbench sessionId={session.id} user={user} members={[]} embedded configurationOnly initialTab="profile" onClose={() => {}} onChanged={() => void onChanged()}/></Suspense></TabPane>
      <TabPane tab="技能分配" itemKey="skills"><SkillAssignment sessionId={session.id} onChanged={onChanged}/></TabPane>
      <TabPane tab="协作成员" itemKey="members"><AgentMembers session={session} user={user} onChanged={onChanged}/></TabPane>
      <TabPane tab="渠道绑定" itemKey="channels"><ChannelBinding sessionId={session.id} onChanged={onChanged}/></TabPane>
    </Tabs>
    {deleting && <DeleteAgentDialog session={session} onClose={() => setDeleting(false)} onChanged={onChanged} onTrashed={onTrashed}/>}
  </>
}
function DeleteAgentDialog({ session, onClose, onChanged, onTrashed }: { session: Session; onClose(): void; onChanged: Props['onChanged']; onTrashed: Props['onTrashed'] }) {
  const access = usePanelAccess()
  async function remove() { await access.mutate(async () => {
    await access.request(`/api/sessions/${encodeURIComponent(session.id)}`, { method: 'DELETE', body: {} })
    if (!access.valid()) return
    onTrashed?.(session.id); Toast.success('智能体已移入垃圾箱，可在管理页恢复。'); onClose()
    void Promise.resolve(onChanged()).catch(() => Toast.warning('智能体已移入垃圾箱，请刷新管理列表。'))
  }) }
  return <Modal visible title={`移入垃圾箱：${session.title}`} className="pi-management-modal" width={520} maskClosable={!access.busy} closeOnEsc={!access.busy} closable={!access.busy} onCancel={onClose}
    footer={<><Button disabled={access.busy} onClick={onClose}>取消</Button><Button type="danger" theme="solid" loading={access.busy} disabled={access.locked} onClick={() => void remove()}>移入垃圾箱</Button></>}>
    <p>该智能体将从工作台隐藏，成员不能继续访问。聊天记录、成员配置和工作文件会保留，可从垃圾箱恢复。</p><p>关联定时任务会暂停，恢复后需确认并重新启用。</p><PanelError error={access.error}/>
  </Modal>
}
function BasicSettings({ session, onChanged }: { session: Session; onChanged: Props['onChanged'] }) {
  const access = usePanelAccess(), id = useId(), [title, setTitle] = useState(session.title), [avatarId, setAvatar] = useState(session.avatarId || ''), [mode, setMode] = useState(session.mode || 'read-only'), [savedMode, setSavedMode] = useState(session.mode || 'read-only')
  async function save() { await access.mutate(async () => { const result = await access.request<{ session: Session }>(`/api/sessions/${encodeURIComponent(session.id)}`, { method: 'PATCH', body: { title: title.trim(), avatarId, ...(mode !== savedMode ? { mode } : {}) } }); if (!access.valid()) return; setTitle(result.session.title); setMode(result.session.mode || mode); setSavedMode(result.session.mode || mode); void onChanged(); Toast.success('智能体基本设置已保存。') }) }
  return <section className="agent-settings-panel" aria-label="基本设置"><PanelError error={access.error}/>{!access.locked && <form onSubmit={event => { event.preventDefault(); void save() }}><label className="field-label" htmlFor={`${id}-title`}>智能体名称</label><Input id={`${id}-title`} value={title} maxLength={120} onChange={setTitle} disabled={access.busy}/><AvatarPicker businessTitle={title} value={avatarId} onChange={setAvatar} disabled={access.busy}/><fieldset className="agent-execution-mode"><legend>技能执行权限</legend><RadioGroup direction="vertical" value={mode} onChange={event => setMode(event.target.value)} disabled={access.busy || session.running}><Radio value="read-only">只读模式：读取与分析资料</Radio><Radio value="workspace">工作区模式：执行技能与业务任务</Radio></RadioGroup><p>{session.running ? '智能体正在运行，结束后可调整执行权限。' : '工作区模式可在本机运行命令，请为可信业务技能开启。'}</p></fieldset><Button theme="solid" htmlType="submit" loading={access.busy} disabled={!title.trim()}>保存基本设置</Button></form>}</section>
}
function SkillAssignment({ sessionId, onChanged }: { sessionId: string; onChanged: Props['onChanged'] }) {
  const access = usePanelAccess(), [skills, setSkills] = useState<Skill[]>([]), [selected, setSelected] = useState<string[]>([]), [loading, setLoading] = useState(true)
  async function load(preserveDraft = false) { const data = await access.request<{ skills: Skill[] }>('/api/skills'); if (access.valid()) { setSkills(data.skills || []); if (!preserveDraft) setSelected((data.skills || []).filter(item => item.scope === 'groups' && item.groupIds?.includes(sessionId)).map(item => item.id)) } }
  useEffect(() => { void load().catch(access.fail).finally(() => { if (access.valid()) setLoading(false) }) }, [])
  async function save() { await access.mutate(async () => {
    // Merge current group IDs so another agent's assignments are not overwritten
    // by the snapshot loaded when this page was opened. Successful partial saves
    // are idempotent on retry; no failed request broadens a skill to global scope.
    const latest = await access.request<{ skills: Skill[] }>('/api/skills')
    for (const item of skills.filter(item => item.scope === 'groups')) {
      if (!access.valid()) return
      const skill = latest.skills.find(value => value.id === item.id)
      if (!skill || skill.scope !== 'groups') throw new Error('技能目录或共享范围已有变化，请刷新后重新配置。')
      const chosen = selected.includes(item.id), assigned = !!skill.groupIds?.includes(sessionId)
      if (chosen === assigned) continue
      const groupIds = chosen ? [...new Set([...(skill.groupIds || []), sessionId])] : (skill.groupIds || []).filter(id => id !== sessionId)
      if (!groupIds.length) throw new Error(`“${skill.name}”仅分配给本智能体，可直接停用该技能。`)
      await access.request(`/api/admin/skills/${encodeURIComponent(skill.id)}`, { method: 'PATCH', body: { scope: 'groups', groupIds } })
    }
    if (!access.valid()) return; await load(); void onChanged(); Toast.success('技能分配已保存。')
  }) }
  async function toggleExclusive(skill: Skill) { await access.mutate(async () => { const latest = await access.request<{ skills: Skill[] }>('/api/skills'), current = latest.skills.find(item => item.id === skill.id); if (!current || current.scope !== 'groups' || current.groupIds?.length !== 1 || current.groupIds[0] !== sessionId) throw new Error('技能共享范围已变化，请刷新后重试。'); await access.request(`/api/admin/skills/${encodeURIComponent(skill.id)}`, { method: 'PATCH', body: { enabled: current.enabled === false } }); if (!access.valid()) return; await load(true); void onChanged(); Toast.success(current.enabled === false ? '技能已启用。' : '技能已停用。') }) }
  return <section className="agent-settings-panel" aria-label="技能分配"><PanelError error={access.error}/>{!access.locked && (loading ? <Spin tip="正在读取技能…"/> : <><p className="agent-settings-help">选择本智能体可使用的技能。全局共享技能自动可用；仅分配本群的技能可直接停用。账号授权与技能安装仍由技能中心维护。</p><div className="agent-assignment-list">{skills.map(skill => { const global = skill.scope !== 'groups', exclusive = !global && skill.groupIds?.length === 1 && skill.groupIds[0] === sessionId, checked = global || selected.includes(skill.id); return <article key={skill.id}><Checkbox aria-label={`分配技能：${skill.name}`} checked={checked} disabled={access.busy || global || exclusive} onChange={event => setSelected(previous => event.target.checked ? [...new Set([...previous, skill.id])] : previous.filter(id => id !== skill.id))}/><img src={skillArtwork(skill.name, skill.avatarId)} alt=""/><div><strong>{skill.name}</strong><p>{skill.description || '专业业务技能'}</p><span>{global ? '全局共享' : exclusive ? '仅此智能体' : '按智能体分配'} · {skill.enabled === false ? '已停用' : '已启用'}</span></div>{exclusive && <Button disabled={access.busy} onClick={() => void toggleExclusive(skill)}>{skill.enabled === false ? '启用' : '停用'}</Button>}</article> })}{!skills.length && <Empty title="尚未安装技能" description="在技能中心导入技能后，可在此分配。"/>}</div><Button theme="solid" loading={access.busy} onClick={() => void save()}>保存技能分配</Button></>)}</section>
}
function AgentMembers({ session, user, onChanged }: { session: Session; user: User; onChanged: Props['onChanged'] }) {
  const access = usePanelAccess(), [roster, setRoster] = useState<MembersResponse | null>(null), [open, setOpen] = useState(false)
  async function load() { const data = await access.request<MembersResponse>(`/api/sessions/${encodeURIComponent(session.id)}/members`); if (access.valid()) setRoster(data) }
  useEffect(() => { void load().catch(access.fail) }, [])
  return <section className="agent-settings-panel" aria-label="协作成员配置"><PanelError error={access.error}/>{!access.locked && <><div className="agent-panel-heading"><p>群成员可查看聊天与任务结果，也可邀请同事加入。</p><Button onClick={() => setOpen(true)}>管理与邀请成员</Button></div>{roster ? <div className="agent-roster">{[...roster.members, ...(roster.externalMembers || [])].map(member => <div key={member.id}><UserAvatar name={member.displayName} identity={member.id} external={'source' in member} size={38}/><span>{member.displayName}</span><small>{'source' in member ? '渠道成员' : member.id === roster.ownerId ? '创建人' : member.role === 'admin' ? '管理员' : '成员'}</small></div>)}</div> : <Spin tip="正在读取成员…"/>}<MembersDialog open={open} session={session} user={user} onClose={() => setOpen(false)} onChanged={() => { void load().catch(access.fail); void onChanged() }}/></>}</section>
}
function ChannelBinding({ sessionId, onChanged }: { sessionId: string; onChanged: Props['onChanged'] }) {
  const access = usePanelAccess(), [channels, setChannels] = useState<Channel[]>([]), [chosen, setChosen] = useState<string[]>([]), [ready, setReady] = useState(false)
  useEffect(() => { void Promise.all([access.request<{ channels: Channel[] }>('/api/admin/channels'), access.request<{ channels: Channel[]; canManage?: boolean }>(`/api/sessions/${encodeURIComponent(sessionId)}/channels`)]).then(([all, bound]) => { if (!access.valid()) return; if (bound.canManage === false) throw new ApiError('当前无权管理此智能体渠道。', 403); setChannels(all.channels || []); setChosen((bound.channels || []).map(item => item.id)); setReady(true) }).catch(access.fail) }, [])
  async function save() { await access.mutate(async () => { await access.request(`/api/sessions/${encodeURIComponent(sessionId)}/channels`, { method: 'PUT', body: { channelIds: [...chosen] } }); if (access.valid()) { void onChanged(); Toast.success('消息渠道绑定已保存。') } }) }
  return <section className="agent-settings-panel" aria-label="渠道绑定配置"><PanelError error={access.error}/>{!access.locked && (!ready ? <Spin tip="正在读取渠道绑定…"/> : <><p className="agent-settings-help">选择消息互通或结果推送渠道。新回复和任务结果会发送到渠道配置的接收方；Webhook 仅发送通知。已绑定其他智能体的渠道需先解绑。</p><div className="agent-channel-options">{channels.map(channel => { const conflict = !!channel.sessionId && channel.sessionId !== sessionId; return <div key={channel.id}><Checkbox aria-label={`绑定渠道：${channel.name}`} checked={chosen.includes(channel.id)} disabled={access.busy || conflict} onChange={event => setChosen(previous => event.target.checked ? [...new Set([...previous, channel.id])] : previous.filter(id => id !== channel.id))}/><div><strong>{channel.name}</strong><small>{channel.type === 'wecom' && channel.connectionMode === 'webhook' ? '企业微信群 · 仅发送通知' : channelIdentity(channel.type).label} · {conflict ? `已绑定${channel.sessionTitle || '其他智能体'}` : channel.enabled === false ? '已停用' : '已启用'}</small></div></div> })}{!channels.length && <Empty title="尚未配置消息渠道" description="在消息渠道页面配置微信、企业微信长连接或 Webhook 后，可在此绑定。"/>}</div><Button theme="solid" loading={access.busy} onClick={() => void save()}>保存渠道绑定</Button></>)}</section>
}
