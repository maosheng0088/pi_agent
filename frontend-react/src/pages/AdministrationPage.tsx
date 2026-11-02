import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Banner, Button, Input, Modal, Pagination, Select, Spin, Table, Tag, Toast } from '@douyinfe/semi-ui'
import { api, errorMessage } from '../lib/api'
import type { Session, User } from '../lib/types'
import UserAvatar from '../components/UserAvatar'
import './administration.css'

export interface AdministrationPageProps { view: 'users' | 'audit' | 'events'; user: User }
type AuditFilter = { userId: string; q: string; from: string; to: string }
type DiscussionPage = { total: number; hasMore: boolean; nextBefore: number | null }
const emptyDiscussionPage = (): DiscussionPage => ({ total: 0, hasMore: false, nextBefore: null })
function discussionPage(value: any): DiscussionPage {
  const nextBefore = Number.isSafeInteger(value?.nextBefore) && value.nextBefore > 0 ? value.nextBefore : null
  return { total: Number.isSafeInteger(value?.total) && value.total >= 0 ? value.total : 0, hasMore: !!value?.hasMore && nextBefore !== null, nextBefore }
}
function mergeMessages(...pages: any[][]) {
  const seen = new Set<string>(), messages: any[] = []
  for (const message of pages.flat()) {
    if (!message || typeof message !== 'object') continue
    const id = message.id == null ? null : String(message.id)
    if (id !== null && seen.has(id)) continue
    if (id !== null) seen.add(id)
    messages.push(message)
  }
  return messages.sort((a, b) => { const left = new Date(a.timestamp).getTime(), right = new Date(b.timestamp).getTime(); return (Number.isFinite(left) ? left : 0) - (Number.isFinite(right) ? right : 0) })
}
type UserForm = { username: string; displayName: string; password: string; role: string }
const emptyUserForm = (): UserForm => ({ username: '', displayName: '', password: '', role: 'member' })
const titles = {
  users: ['协作成员', '管理业务空间的登录账户与访问状态。'],
  audit: ['会话审计', '按创建人、关键词与日期查阅智能体协作记录。'],
  events: ['操作记录', '追踪业务空间中的账户、配置与任务操作。'],
} as const
const actionLabels: Record<string, string> = {
  'workspace.setup': '初始化业务空间', 'auth.login': '登录', 'auth.login_failed': '登录失败', 'auth.logout': '退出登录',
  'auth.password_changed': '修改密码', 'user.created': '创建协作成员', 'user.updated': '更新成员账户',
  'config.viewed': '查看空间配置', 'config.updated': '更新空间配置', 'session.created': '创建智能体',
  'session.renamed': '修改群名', 'session.avatar_changed': '修改智能体头像', 'session.mode_changed': '切换执行权限',
  'session.exported': '导出协作记录', 'admin.sessions_listed': '查询会话审计', 'admin.session_viewed': '查看会话详情',
  'skill.created': '创建技能', 'skill.updated': '更新技能', 'skill.deleted': '删除技能',
  'schedule.created': '创建定时任务', 'schedule.updated': '更新定时任务', 'schedule.deleted': '删除定时任务',
  'schedule.run_requested': '请求运行任务', 'schedule.run_started': '开始运行任务', 'schedule.run_finished': '任务运行结束',
  'channel.created': '创建消息渠道', 'channel.updated': '更新消息渠道', 'channel.deleted': '删除消息渠道', 'channel.bound': '更新渠道绑定',
  'group.members_added': '邀请群成员', 'group.member_removed': '移除群成员', 'group.member_left': '退出群聊',
}
function clock(value?: string | number) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false })
}
function textContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(v => v?.text || (v?.type === 'image' ? '[图片]' : v?.type === 'toolCall' ? `[工具调用：${v.name}]` : '')).filter(Boolean).join('\n')
  return value ? JSON.stringify(value, null, 2) : ''
}
const safeDetails = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value, null, 2)
const normalizeUsers = (items: User[] = []) => items.map(item => ({ ...item, disabled: Boolean(item.disabled) }))
const actor = (event: any) => event.actorName || event.displayName || event.username || event.actor?.displayName || event.userName || '系统'

export function AdministrationPage({ view, user }: AdministrationPageProps) {
  const identity = `${user.id}:${user.role}`, identityRef = useRef(identity); identityRef.current = identity
  const [dataIdentity, setDataIdentity] = useState(identity)
  const [users, setUsers] = useState<User[]>([]), [events, setEvents] = useState<any[]>([]), [sessions, setSessions] = useState<Session[]>([])
  const [loading, setLoading] = useState(false), [error, setError] = useState('')
  const [userQuery, setUserQuery] = useState(''), [eventQuery, setEventQuery] = useState('')
  const [userPage, setUserPage] = useState(1), [eventPage, setEventPage] = useState(1)
  const [filter, setFilter] = useState<AuditFilter>({ userId: '', q: '', from: '', to: '' })
  const [total, setTotal] = useState(0), [selected, setSelected] = useState<Session | null>(null), [messages, setMessages] = useState<any[]>([]), [detailLoading, setDetailLoading] = useState(false)
  const [discussion, setDiscussion] = useState<DiscussionPage>(emptyDiscussionPage), [olderLoading, setOlderLoading] = useState(false)
  const [userOpen, setUserOpen] = useState(false), [editUser, setEditUser] = useState<User | null>(null), [userSaving, setUserSaving] = useState(false), [userError, setUserError] = useState('')
  const [userForm, setUserForm] = useState<UserForm>(emptyUserForm), [busyUser, setBusyUser] = useState('')
  const alive = useRef(false), generation = useRef(0), request = useRef(0), detailRequest = useRef(0)
  const controller = useRef<AbortController | null>(null), auditQuery = useRef(''), savingRef = useRef(false), busyRef = useRef(false)
  const detailController = useRef<AbortController>(), olderPending = useRef(false), selectedRef = useRef<Session | null>(null), messagesRef = useRef<any[]>([]), discussionRef = useRef<DiscussionPage>(emptyDiscussionPage())
  const transcript = useRef<HTMLDivElement>(null), scrollAnchor = useRef<{ height: number; top: number } | null>(null)
  const viewRef = useRef(view), filterRef = useRef(filter), sessionsRef = useRef(sessions)
  viewRef.current = view; filterRef.current = filter; sessionsRef.current = sessions
  const current = (token: number) => alive.current && generation.current === token && identityRef.current === identity
  const filteredUsers = useMemo(() => users.filter(item => `${item.displayName} ${item.username}`.toLowerCase().includes(userQuery.toLowerCase())), [users, userQuery])
  const filteredEvents = useMemo(() => events.filter(event => JSON.stringify(event).toLowerCase().includes(eventQuery.toLowerCase())), [events, eventQuery])

  function clearAudit() {
    detailRequest.current++; detailController.current?.abort(); olderPending.current = false; selectedRef.current = null; messagesRef.current = []; discussionRef.current = emptyDiscussionPage(); scrollAnchor.current = null
    setSelected(null); setMessages([]); setDiscussion(emptyDiscussionPage()); setDetailLoading(false); setOlderLoading(false)
  }
  function changeFilter(patch: Partial<AuditFilter>) { clearAudit(); setFilter(previous => ({ ...previous, ...patch })) }

  async function load(append = false) {
    const token = ++request.current, context = generation.current, activeView = viewRef.current
    const signal = controller.current?.signal
    if (!alive.current || user.role !== 'admin') return
    if (activeView === 'audit' && !append) clearAudit()
    setLoading(true); setError('')
    try {
      if (activeView === 'users') {
        const result = await api<{ users: User[] }>('/api/admin/users', { signal })
        if (current(context) && token === request.current) setUsers(normalizeUsers(result.users))
      } else if (activeView === 'events') {
        const result = await api('/api/admin/audit?limit=200', { signal })
        if (current(context) && token === request.current) setEvents(result.events || [])
      } else {
        const values = filterRef.current
        if (values.from && values.to && values.from > values.to) throw new Error('开始日期不能晚于结束日期。')
        if (!append) {
          const query = new URLSearchParams()
          Object.entries(values).forEach(([key, value]) => { if (value.trim()) query.set(key, value.trim()) })
          auditQuery.current = query.toString()
        }
        const params = new URLSearchParams(auditQuery.current)
        params.set('limit', '100'); params.set('offset', String(append ? sessionsRef.current.length : 0))
        const result = await api(`/api/admin/sessions?${params}`, { signal })
        if (!current(context) || token !== request.current) return
        const next = append ? [...sessionsRef.current, ...(result.sessions || [])] : result.sessions || []
        sessionsRef.current = next; setSessions(next); setTotal(result.total ?? next.length)
      }
    } catch (cause) { if (current(context) && token === request.current) setError(errorMessage(cause)) }
    finally { if (current(context) && token === request.current) setLoading(false) }
  }

  useEffect(() => {
    alive.current = true; const context = ++generation.current
    const lifetime = new AbortController(); controller.current = lifetime
    request.current++; auditQuery.current = ''; setDataIdentity(identity); clearAudit()
    setSessions([]); sessionsRef.current = []; setTotal(0); setError('')
    setUserOpen(false); setUserForm(emptyUserForm()); savingRef.current = false; setUserSaving(false); setBusyUser(''); busyRef.current = false
    setUsers([]); setEvents([]); setUserPage(1); setEventPage(1)
    if (user.role === 'admin') {
      if (view === 'audit') void api<{ users: User[] }>('/api/admin/users', { signal: lifetime.signal })
        .then(result => { if (current(context)) setUsers(normalizeUsers(result.users)) })
        .catch(cause => { if (current(context)) setError(errorMessage(cause)) })
      void load()
    }
    return () => { alive.current = false; generation.current++; request.current++; detailRequest.current++; lifetime.abort(); detailController.current?.abort() }
  }, [view, user.id, user.role])

  useEffect(() => { setUserPage(1) }, [userQuery])
  useEffect(() => { setEventPage(1) }, [eventQuery])
  useEffect(() => { const element = transcript.current, anchor = scrollAnchor.current; if (element && anchor) element.scrollTop = anchor.top + element.scrollHeight - anchor.height; scrollAnchor.current = null }, [messages])

  async function openAudit(item: Session) {
    clearAudit()
    const token = ++detailRequest.current, context = generation.current
    const pending = new AbortController(); detailController.current = pending
    selectedRef.current = item; setSelected(item); setDetailLoading(true); setError('')
    try {
      const result = await api(`/api/admin/sessions/${encodeURIComponent(item.id)}`, { signal: pending.signal })
      if (!current(context) || token !== detailRequest.current) return
      selectedRef.current = result.session; setSelected(result.session); messagesRef.current = mergeMessages(result.messages || []); setMessages(messagesRef.current)
      discussionRef.current = discussionPage(result.discussionPage); setDiscussion(discussionRef.current)
    } catch (cause) { if (current(context) && token === detailRequest.current) setError(errorMessage(cause)) }
    finally { if (current(context) && token === detailRequest.current) setDetailLoading(false) }
  }
  async function loadOlderDiscussion() {
    const item = selectedRef.current, before = discussionRef.current.nextBefore
    if (!item || !before || !discussionRef.current.hasMore || olderPending.current || detailLoading) return
    const context = generation.current, token = ++detailRequest.current, pending = new AbortController()
    detailController.current?.abort(); detailController.current = pending; olderPending.current = true; setOlderLoading(true); setError('')
    try {
      const result = await api(`/api/admin/sessions/${encodeURIComponent(item.id)}/discussion?before=${before}&limit=200`, { signal: pending.signal })
      if (!current(context) || token !== detailRequest.current || selectedRef.current?.id !== item.id) return
      const nextPage = discussionPage(result)
      if (nextPage.hasMore && nextPage.nextBefore! >= before) throw new Error('讨论分页游标未前进，请刷新会话后重试。')
      const element = transcript.current
      if (element) scrollAnchor.current = { height: element.scrollHeight, top: element.scrollTop }
      messagesRef.current = mergeMessages(result.messages || [], messagesRef.current); setMessages(messagesRef.current)
      discussionRef.current = nextPage; setDiscussion(nextPage)
    } catch (cause) { if (current(context) && token === detailRequest.current) setError(errorMessage(cause)) }
    finally { if (current(context) && token === detailRequest.current) { olderPending.current = false; setOlderLoading(false) } }
  }
  function openUser(item: User | null = null) {
    if (savingRef.current) return
    setEditUser(item); setUserError(''); setUserForm(emptyUserForm()); setUserOpen(true)
  }
  function closeUser() {
    if (savingRef.current) return
    setUserOpen(false); setUserForm(emptyUserForm()); setUserError('')
  }
  async function saveUser(event?: FormEvent) {
    event?.preventDefault()
    if (savingRef.current) return
    const editing = editUser, values = userForm, context = generation.current
    if (values.password.length < 8 || values.password.length > 128) { setUserError('密码须为 8–128 个字符。'); return }
    if (!editing && (!values.displayName.trim() || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,47}$/.test(values.username.trim()))) { setUserError('请输入姓名及有效账号：3–48 位字母、数字、点、下划线或短横线。'); return }
    savingRef.current = true; setUserSaving(true); setUserError('')
    const body = editing ? { password: values.password } : { ...values, username: values.username.trim(), displayName: values.displayName.trim() }
    setUserForm(previous => ({ ...previous, password: '' }))
    try {
      await api(editing ? `/api/admin/users/${encodeURIComponent(editing.id)}` : '/api/admin/users', { method: editing ? 'PATCH' : 'POST', body, signal: controller.current?.signal })
      if (!current(context)) return
      setUserOpen(false); Toast.success(editing ? '密码已重置，请告知账户本人。' : '协作成员已创建。'); await load()
    } catch (cause) { if (current(context)) setUserError(errorMessage(cause)) }
    finally { if (current(context)) { savingRef.current = false; setUserSaving(false) } }
  }
  async function toggleUser(item: User) {
    if (busyRef.current || item.id === user.id) return
    const context = generation.current; busyRef.current = true; setBusyUser(item.id); setError('')
    try {
      await api(`/api/admin/users/${encodeURIComponent(item.id)}`, { method: 'PATCH', body: { disabled: !item.disabled }, signal: controller.current?.signal })
      if (!current(context)) return
      Toast.success(item.disabled ? '账户已启用。' : '账户已停用。'); await load()
    } catch (cause) { if (current(context)) setError(errorMessage(cause)) }
    finally { if (current(context)) { busyRef.current = false; setBusyUser('') } }
  }

  if (user.role !== 'admin') return <Banner type="warning" description="此页面仅限管理员访问。" />
  if (dataIdentity !== identity) return <Spin tip="正在切换管理员身份…" />
  const [title, subtitle] = titles[view]
  const userColumns = [
    { title: '姓名 / 账号', dataIndex: 'displayName', width: 240, render: (_: unknown, item: User) => <div className="ra-member-name"><UserAvatar name={item.displayName || item.username} identity={item.id} className="ra-user-avatar" /><div><strong>{item.displayName || item.username} {item.id === user.id && <Tag color="blue" size="small">你</Tag>}</strong><small>{item.username}</small></div></div> },
    { title: '角色', dataIndex: 'role', width: 120, render: (role: string) => <Tag color={role === 'admin' ? 'blue' : 'grey'}>{role === 'admin' ? '管理员' : '协作成员'}</Tag> },
    { title: '账户状态', dataIndex: 'disabled', width: 120, render: (disabled: boolean) => <Tag color={disabled ? 'grey' : 'green'}>{disabled ? '已停用' : '可登录'}</Tag> },
    { title: '创建时间', dataIndex: 'createdAt', width: 185, render: (value: string) => <span className="ra-muted">{clock(value)}</span> },
    { title: '操作', key: 'actions', width: 190, render: (_: unknown, item: User) => <div className="ra-row-actions"><Button size="small" theme="borderless" onClick={() => openUser(item)}>重置密码</Button><Button size="small" theme="borderless" type={item.disabled ? 'primary' : 'danger'} loading={busyUser === item.id} disabled={item.id === user.id || Boolean(busyUser)} title={item.id === user.id ? '不能停用当前登录账户' : undefined} onClick={() => void toggleUser(item)}>{item.disabled ? '启用' : '停用'}</Button></div> },
  ]

  return <section className="react-administration">
    <header className="ra-page-heading"><div><span className="ra-eyebrow">WORKSPACE MANAGEMENT</span><h1>{title}</h1><p>{subtitle}</p></div>{view === 'users' ? <Button theme="solid" onClick={() => openUser()}>添加成员</Button> : <Button loading={loading} onClick={() => void load()}>刷新</Button>}</header>
    {error && <div className="ra-alert" role="alert"><Banner type="danger" description={error} /></div>}
    {view === 'users' && <>
      <div className="ra-summary-grid"><article><span>全部协作成员</span><strong>{users.length}</strong></article><article><span>可登录账户</span><strong>{users.filter(item => !item.disabled).length}</strong></article><article><span>业务空间管理员</span><strong>{users.filter(item => item.role === 'admin').length}</strong></article></div>
      <section className="ra-panel"><header className="ra-panel-toolbar"><h2>成员目录 <span>{filteredUsers.length}</span></h2><Input value={userQuery} onChange={setUserQuery} showClear placeholder="搜索姓名或账号" aria-label="搜索协作成员" className="ra-search" /></header>
        <Table rowKey="id" size="small" columns={userColumns} dataSource={filteredUsers.slice((userPage - 1) * 20, userPage * 20)} pagination={false} loading={loading} scroll={{ x: 850 }} empty="没有找到符合条件的成员。" />
        <footer className="ra-pagination"><Pagination currentPage={userPage} pageSize={20} total={filteredUsers.length} onPageChange={setUserPage} showTotal /></footer>
      </section>
    </>}
    {view === 'audit' && <>
      <form className="ra-panel ra-filter-form" onSubmit={event => { event.preventDefault(); void load() }}>
        <label><span>创建人</span><Select value={filter.userId} onChange={value => changeFilter({ userId: String(value || '') })} optionList={[{ value: '', label: '所有创建人' }, ...users.map(item => ({ value: item.id, label: `${item.displayName || item.username}${item.disabled ? '（已停用）' : ''}` }))]} aria-label="审计创建人" /></label>
        <label className="ra-filter-query"><span>关键词</span><Input value={filter.q} onChange={q => changeFilter({ q })} placeholder="搜索智能体、创建人或参与人" aria-label="审计关键词" /></label>
        <label><span>开始日期</span><input className="ra-date-input" type="date" value={filter.from} onChange={event => changeFilter({ from: event.target.value })} aria-label="开始日期" /></label>
        <label><span>结束日期</span><input className="ra-date-input" type="date" value={filter.to} onChange={event => changeFilter({ to: event.target.value })} aria-label="结束日期" /></label>
        <Button theme="solid" htmlType="submit" loading={loading}>查询</Button>
      </form>
      <section className="ra-panel ra-audit-layout"><aside className="ra-audit-sidebar"><div className="ra-audit-list-title">智能体协作记录 <span>{total}</span></div>
        {sessions.map(item => <button key={item.id} type="button" className={`ra-audit-item${selected?.id === item.id ? ' selected' : ''}`} aria-pressed={selected?.id === item.id} onClick={() => void openAudit(item)}><strong>{item.title || '智能体'}</strong><span>{item.legacyUnknownOwner ? '历史创建人未记录' : item.createdByName || item.ownerName || '创建人未记录'}</span><small>{clock(item.updatedAt || item.createdAt)} · {item.messageCount || 0} 条消息</small></button>)}
        {!sessions.length && <div className="ra-empty" role="status">{loading ? '正在查询…' : '没有符合条件的记录'}</div>}
        {sessions.length < total && <div className="ra-load-more"><Button block loading={loading} onClick={() => void load(true)}>加载更多（{sessions.length} / {total}）</Button></div>}
      </aside><div className="ra-audit-detail">{selected && <header className="ra-audit-detail-heading"><div><strong>{selected.title}</strong><small>仅供管理员查阅</small></div><a className="ra-export-link" href={`/api/admin/sessions/${encodeURIComponent(selected.id)}/export`} download={`pi-session-${selected.id}.json`}>导出记录</a></header>}
        <div className="ra-audit-transcript" ref={transcript} aria-label="对话审计记录">{selected && !detailLoading && <div className="ra-discussion-pagination"><p>包含原始持久消息与历史分支；群内讨论可继续加载更早记录。{discussion.total > 0 && ` 群内讨论共 ${discussion.total} 条。`}</p>{discussion.hasMore && <Button block loading={olderLoading} disabled={olderLoading} onClick={() => void loadOlderDiscussion()}>加载更早讨论</Button>}</div>}{detailLoading ? <div className="ra-empty" role="status"><Spin />正在加载会话记录…</div> : selected ? messages.length ? messages.map((message, index) => <article className="ra-audit-message" key={message.id || index}><header><strong>{message.authorName || (message.role === 'assistant' ? 'Pi 智能体' : message.role === 'toolResult' ? '工具结果' : '历史发言人未记录')}</strong><time>{clock(message.timestamp)}</time></header><div className="ra-message-content">{textContent(message.content)}</div>{(message.tools?.length || message.role === 'toolResult') && <details><summary>执行详情</summary><pre>{safeDetails(message.tools || message)}</pre></details>}</article>) : <div className="ra-empty">此智能体尚无协作消息。</div> : <div className="ra-empty">选择左侧记录，查看协作会话与历史分支。</div>}</div>
      </div></section>
    </>}
    {view === 'events' && <section className="ra-panel"><header className="ra-panel-toolbar"><h2>最近操作 <span>{events.length}</span></h2><Input value={eventQuery} onChange={setEventQuery} showClear placeholder="搜索操作、人员" aria-label="搜索操作记录" className="ra-search" /></header>
      {loading ? <div className="ra-empty" role="status"><Spin />正在加载操作记录…</div> : !filteredEvents.length ? <div className="ra-empty">暂无符合条件的操作记录。</div> : filteredEvents.slice((eventPage - 1) * 30, eventPage * 30).map((event, index) => <article className="ra-event-row" key={event.id || index}><span className="ra-event-marker" aria-hidden="true" /><div><strong>{actionLabels[event.action] || event.action}</strong><p>{actor(event)}</p>{(event.details || event.detail || event.targetId) && <details><summary>查看详情</summary><pre>{safeDetails(event.details || event.detail || { targetId: event.targetId })}</pre></details>}</div><time>{clock(event.at || event.timestamp || event.createdAt)}</time></article>)}
      <footer className="ra-pagination"><span>显示最近最多 200 条操作记录。</span><Pagination currentPage={eventPage} pageSize={30} total={filteredEvents.length} onPageChange={setEventPage} /></footer>
    </section>}
    <Modal visible={userOpen} title={editUser ? '重置成员密码' : '添加协作成员'} onCancel={closeUser} footer={null} closable={!userSaving} maskClosable={!userSaving} closeOnEsc={!userSaving} width={480} className="react-admin-modal">
      <form onSubmit={event => void saveUser(event)}><p className="ra-form-description">{editUser ? `为 ${editUser.displayName || editUser.username} 设置新的登录密码。` : '创建账户后，可将成员邀请至相应智能体。'}</p>
        {userError && <div className="ra-alert" role="alert"><Banner type="danger" description={userError} /></div>}
        {!editUser && <><label className="ra-field"><span>姓名</span><Input value={userForm.displayName} onChange={displayName => setUserForm(previous => ({ ...previous, displayName }))} maxLength={80} disabled={userSaving} autoComplete="off" aria-label="姓名" /></label><label className="ra-field"><span>登录账号</span><Input value={userForm.username} onChange={username => setUserForm(previous => ({ ...previous, username }))} maxLength={48} disabled={userSaving} autoComplete="off" aria-label="登录账号" /></label><label className="ra-field"><span>账户角色</span><Select value={userForm.role} onChange={role => setUserForm(previous => ({ ...previous, role: String(role) }))} disabled={userSaving} optionList={[{ value: 'member', label: '协作成员' }, { value: 'admin', label: '管理员' }]} aria-label="账户角色" /></label></>}
        <label className="ra-field"><span>{editUser ? '新密码' : '初始密码'}</span><Input type="password" value={userForm.password} onChange={password => setUserForm(previous => ({ ...previous, password }))} maxLength={128} disabled={userSaving} autoComplete="new-password" aria-label={editUser ? '新密码' : '初始密码'} /><small>8–128 个字符，保存后请通过可信渠道告知本人。</small></label>
        <footer className="ra-modal-footer"><Button disabled={userSaving} onClick={closeUser}>取消</Button><Button theme="solid" htmlType="submit" loading={userSaving}>{editUser ? '重置密码' : '创建账户'}</Button></footer>
      </form>
    </Modal>
  </section>
}

export default AdministrationPage
