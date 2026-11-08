import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Banner, Button, Checkbox, Input, Modal, Select, Spin, Tag, Toast } from '@douyinfe/semi-ui'
import { api, errorMessage } from '../lib/api'
import { channelIdentity } from '../lib/artwork'
import type { Session } from '../lib/types'
import './channels.css'

interface Target { id: string; chatType: 'group' | 'single'; lastSeen?: string }
interface Channel { id: string; type: string; name: string; enabled: boolean; connected?: boolean; status: string; secretSet?: boolean; botId?: string; accountLabel?: string; sessionId?: string; sessionTitle?: string; lastError?: string; lastDeliveryError?: string | null; canReceive?: boolean; canSend?: boolean; target?: Target | null; connectionMode?: 'websocket' | 'webhook'; replyMode?: 'websocket' | 'webhook'; webhookSet?: boolean }
export interface ChannelsPageProps { sessions: Session[]; currentSessionId?: string; onChanged(): void }
interface QrState { visible: boolean; channel: Channel | null; id: string; status: string; error: string; busy: boolean; verifyCode: string; failed: boolean }
interface WecomState { visible: boolean; channel: Channel | null; botId: string; secret: string; target: string; conversations: Target[]; replyMode: 'websocket' | 'webhook'; webhookUrl: string; error: string; busy: boolean; loading: boolean }
interface BindingState { visible: boolean; sessionId: string; ids: string[]; error: string; busy: boolean; loading: boolean; ready: boolean }
const initialQr = (): QrState => ({ visible: false, channel: null, id: '', status: '', error: '', busy: false, verifyCode: '', failed: false })
const initialWecom = (): WecomState => ({ visible: false, channel: null, botId: '', secret: '', target: '', conversations: [], replyMode: 'websocket', webhookUrl: '', error: '', busy: false, loading: false })
const initialBinding = (): BindingState => ({ visible: false, sessionId: '', ids: [], error: '', busy: false, loading: false, ready: false })
const statusLabels: Record<string, string> = { idle: '未登录', login_required: '需重新登录', disconnected: '未登录', unconfigured: '待配置', connecting: '待扫码', waiting: '待扫码', waiting_scan: '待扫码', wait: '待扫码', scaned: '待确认', scanned: '待确认', scaned_but_redirect: '确认处理中', binded_redirect: '确认处理中', confirmed: '已连接', connected: '已连接', paused: '已暂停', disabled: '已暂停', expired: '二维码已过期', error: '连接异常', need_verify: '待手机验证', need_verifycode: '待手机验证', verify_code_blocked: '请重新扫码', unavailable: '不可用' }
function channelState(channel: Channel) {
  if (!channel.enabled) return '已暂停'
  if (channel.status === 'unavailable') return '不可用'
  if (webhookOnly(channel)) return channel.webhookSet ? '已配置' : '待配置'
  if (channel.connected) return '已连接'
  if (channel.type === 'wecom') return channel.status === 'connecting' ? '连接中' : !channel.secretSet ? '待配置' : channel.status === 'error' ? '连接异常' : '未连接'
  return statusLabels[channel.status] || '未登录'
}
function webhookOnly(channel?: Channel | null) { return channel?.type === 'wecom' && channel.connectionMode === 'webhook' }
function replyLabel(channel: Channel) { return channel.replyMode === 'webhook' || webhookOnly(channel) ? '群机器人 Webhook' : '长连接回复' }
const webhookMediaHelp = '图片可直接展示，PDF、Excel、Word 可作为文件发送。AMR 音频按语音发送，视频和其他音频按文件发送。单个文件上限 20 MiB；过大或无法直接展示的图片改为文件发送。'
function validWebhookUrl(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'qyapi.weixin.qq.com' && !url.port && !url.username && !url.password && !url.hash && url.pathname === '/cgi-bin/webhook/send' && [...url.searchParams.keys()].length === 1 && Boolean(url.searchParams.get('key')?.trim()) && !/[\s\u0000-\u001f\u007f]/.test(url.searchParams.get('key') || '')
  } catch { return false }
}
const targetKey = (target?: Target | null) => target?.id ? JSON.stringify([target.chatType, target.id]) : ''
function targetLabel(target: Target) {
  const date = target.lastSeen ? new Date(target.lastSeen) : null
  const time = date && !Number.isNaN(date.getTime()) ? ` · ${date.toLocaleString('zh-CN', { hour12: false })}` : ''
  return `${target.chatType === 'group' ? '群聊' : '私聊'} · ${target.id}${time}`
}
function ChannelMark({ type, size = 42 }: { type: string; size?: number }) {
  const identity = channelIdentity(type)
  const [failed, setFailed] = useState(false)
  useEffect(() => { setFailed(false) }, [identity.src])
  return <span className={`rc-channel-mark rc-channel-mark-${type === 'wecom' ? 'wecom' : 'weixin'}`} style={{ width: size, height: size }} aria-hidden="true">{identity.src && !failed ? <img src={identity.src} width={size} height={size} alt="" draggable={false} decoding="async" onError={() => setFailed(true)} /> : <span>{type === 'wecom' ? '企' : '微'}</span>}</span>
}

export function ChannelsPage({ sessions, currentSessionId, onChanged }: ChannelsPageProps) {
  const [channels, setChannels] = useState<Channel[]>([]), [loading, setLoading] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState('')
  const [renameValues, setRenameValues] = useState<Record<string, string>>({})
  const [createOpen, setCreateOpen] = useState(false), [createBusy, setCreateBusy] = useState(false), [createError, setCreateError] = useState('')
  const [createForm, setCreateForm] = useState({ type: 'weixin', name: '', botId: '', secret: '', webhookUrl: '' })
  const [qr, setQr] = useState<QrState>(initialQr), [wecom, setWecom] = useState<WecomState>(initialWecom), [binding, setBinding] = useState<BindingState>(initialBinding)
  const [deleteTarget, setDeleteTarget] = useState<Channel | null>(null), [deleteBusy, setDeleteBusy] = useState(false), [deleteError, setDeleteError] = useState('')
  const alive = useRef(false), generation = useRef(0), lifetime = useRef<AbortController | null>(null)
  const managerRequest = useRef(0), loginRequest = useRef(0), wecomRequest = useRef(0), bindingRequest = useRef(0), failures = useRef(0)
  const managerTimer = useRef<ReturnType<typeof setTimeout>>(), loginTimer = useRef<ReturnType<typeof setTimeout>>()
  const loginController = useRef<AbortController | null>(null), conversationController = useRef<AbortController | null>(null)
  const busyRef = useRef(false), createBusyRef = useRef(false), deleteBusyRef = useRef(false)
  const qrRef = useRef(qr), wecomRef = useRef(wecom), bindingRef = useRef(binding)
  const refreshRef = useRef<(quiet?: boolean) => Promise<void>>(async () => {}), onChangedRef = useRef(onChanged)
  onChangedRef.current = onChanged
  const current = (context: number) => alive.current && generation.current === context
  function patchQr(next: Partial<QrState>) { qrRef.current = { ...qrRef.current, ...next }; if (alive.current) setQr(qrRef.current) }
  function patchWecom(next: Partial<WecomState>) { wecomRef.current = { ...wecomRef.current, ...next }; if (alive.current) setWecom(wecomRef.current) }
  function patchBinding(next: Partial<BindingState>) { bindingRef.current = { ...bindingRef.current, ...next }; if (alive.current) setBinding(bindingRef.current) }

  async function refresh(quiet = false) {
    clearTimeout(managerTimer.current)
    const token = ++managerRequest.current, context = generation.current
    if (!alive.current) return
    if (!quiet) { setLoading(true); setError('') }
    try {
      const result = await api<{ channels: Channel[] }>('/api/admin/channels', { signal: lifetime.current?.signal })
      if (!current(context) || token !== managerRequest.current) return
      setChannels(result.channels || []); setNotice('')
      setRenameValues(previous => {
        const next = { ...previous }
        for (const channel of result.channels || []) if (!(channel.id in next)) next[channel.id] = channel.name
        return next
      })
    } catch (cause) {
      if (current(context) && token === managerRequest.current) quiet ? setNotice('渠道状态暂未更新，正在自动重试…') : setError(errorMessage(cause))
    } finally {
      if (current(context) && token === managerRequest.current) { setLoading(false); managerTimer.current = setTimeout(() => void refreshRef.current(true), 3000) }
    }
  }
  refreshRef.current = refresh
  useEffect(() => {
    alive.current = true; generation.current++; const controller = new AbortController(); lifetime.current = controller
    void refreshRef.current()
    return () => {
      alive.current = false; generation.current++; managerRequest.current++; loginRequest.current++; wecomRequest.current++; bindingRequest.current++
      controller.abort(); loginController.current?.abort(); conversationController.current?.abort()
      clearTimeout(managerTimer.current); clearTimeout(loginTimer.current)
    }
  }, [])

  function openCreate() {
    if (createBusyRef.current) return
    setCreateError(''); setCreateForm({ type: 'weixin', name: '', botId: '', secret: '', webhookUrl: '' }); setCreateOpen(true)
  }
  function closeCreate() { if (!createBusyRef.current) { setCreateOpen(false); setCreateForm(previous => ({ ...previous, secret: '', webhookUrl: '' })) } }
  async function create(event: FormEvent) {
    event.preventDefault()
    if (createBusyRef.current) return
    const values = createForm, context = generation.current
    if (!values.name.trim()) { setCreateError('请输入渠道名称。'); return }
    if (values.type === 'wecom' && (!values.botId.trim() || !values.secret.trim())) { setCreateError('请输入 Bot ID 与 Secret。'); return }
    if (values.type === 'wecom-webhook' && !validWebhookUrl(values.webhookUrl.trim())) { setCreateError('请输入有效的企业微信群机器人 Webhook 地址。'); return }
    createBusyRef.current = true; setCreateBusy(true); setCreateError('')
    const body = { type: values.type === 'wecom-webhook' ? 'wecom' : values.type, name: values.name.trim(), ...(values.type === 'wecom' ? { botId: values.botId.trim(), secret: values.secret.trim() } : {}), ...(values.type === 'wecom-webhook' ? { connectionMode: 'webhook', replyMode: 'webhook', webhookUrl: values.webhookUrl.trim() } : {}) }
    setCreateForm(previous => ({ ...previous, secret: '', webhookUrl: '' }))
    try {
      const result = await api<{ channel: Channel }>('/api/admin/channels', { method: 'POST', body, signal: lifetime.current?.signal })
      if (!current(context)) return
      setCreateOpen(false); Toast.success('消息渠道已添加。'); onChangedRef.current(); await refreshRef.current(true)
      if (!current(context)) return
      if (result.channel.type === 'wecom' && !webhookOnly(result.channel)) void openWecom(result.channel); else if (result.channel.type !== 'wecom') void startLogin(result.channel)
    } catch (cause) { if (current(context)) setCreateError(errorMessage(cause)) }
    finally { if (current(context)) { createBusyRef.current = false; setCreateBusy(false) } }
  }
  async function mutate(channel: Channel, body: Record<string, unknown>, message: string) {
    if (busyRef.current) return
    if ('name' in body && !String(body.name || '').trim()) { setError('渠道名称不能为空。'); return }
    const context = generation.current; busyRef.current = true; setBusy(channel.id); setError('')
    try {
      await api(`/api/admin/channels/${encodeURIComponent(channel.id)}`, { method: 'PATCH', body, signal: lifetime.current?.signal })
      if (!current(context)) return
      Toast.success(message); onChangedRef.current(); await refreshRef.current(true)
    } catch (cause) { if (current(context)) setError(errorMessage(cause)) }
    finally { if (current(context)) { busyRef.current = false; setBusy('') } }
  }
  async function reconnect(channel: Channel) {
    if (busyRef.current) return
    const context = generation.current; busyRef.current = true; setBusy(channel.id); setError('')
    try {
      await api(`/api/admin/channels/${encodeURIComponent(channel.id)}/connect`, { method: 'POST', body: {}, signal: lifetime.current?.signal })
      if (!current(context)) return
      Toast.success('企业微信连接已发起。'); onChangedRef.current(); await refreshRef.current(true)
    } catch (cause) { if (current(context)) setError(errorMessage(cause)) }
    finally { if (current(context)) { busyRef.current = false; setBusy('') } }
  }

  function stopLogin() { loginRequest.current++; clearTimeout(loginTimer.current); loginController.current?.abort(); loginController.current = null }
  function closeQr() { stopLogin(); patchQr(initialQr()) }
  function applyLogin(result: any) {
    const state = qrRef.current
    const status = result.channel?.connected ? 'connected' : result.login?.status || result.channel?.status || 'waiting'
    patchQr({ id: result.login?.id || state.id, channel: result.channel || state.channel, status })
    return !['connected', 'confirmed', 'expired', 'error', 'verify_code_blocked'].includes(status)
  }
  function schedulePoll(token: number, context: number, delay = 2000) {
    clearTimeout(loginTimer.current)
    loginTimer.current = setTimeout(async () => {
      const state = qrRef.current
      if (!current(context) || token !== loginRequest.current || !state.visible || !state.channel || !state.id) return
      const controller = new AbortController(); loginController.current = controller
      try {
        const result = await api(`/api/admin/channels/${encodeURIComponent(state.channel.id)}/logins/${encodeURIComponent(state.id)}`, { signal: controller.signal })
        if (!current(context) || token !== loginRequest.current) return
        failures.current = 0; patchQr({ error: '' })
        if (applyLogin(result)) schedulePoll(token, context)
        else { await refreshRef.current(true); if (current(context)) onChangedRef.current() }
      } catch (cause: unknown) {
        if (!current(context) || token !== loginRequest.current || (cause instanceof Error && cause.name === 'AbortError')) return
        failures.current++
        const status = typeof (cause as { status?: unknown })?.status === 'number' ? (cause as { status: number }).status : 0
        if ((!status || status >= 500 || [408, 429].includes(status)) && failures.current < 5) {
          patchQr({ error: '连接暂时中断，正在自动重试…' }); schedulePoll(token, context, Math.min(10000, 2000 * 2 ** (failures.current - 1)))
        } else patchQr({ error: errorMessage(cause) })
      }
    }, delay)
  }
  async function startLogin(channel: Channel) {
    if (!alive.current) return
    stopLogin(); const token = loginRequest.current, context = generation.current
    patchQr({ ...initialQr(), visible: true, channel, status: 'waiting', busy: true }); failures.current = 0
    const controller = new AbortController(); loginController.current = controller
    try {
      const result = await api(`/api/admin/channels/${encodeURIComponent(channel.id)}/logins`, { method: 'POST', body: {}, signal: controller.signal })
      if (!current(context) || token !== loginRequest.current) return
      if (applyLogin(result)) schedulePoll(token, context)
      else { await refreshRef.current(true); if (current(context)) onChangedRef.current() }
    } catch (cause) { if (current(context) && token === loginRequest.current) patchQr({ error: errorMessage(cause) }) }
    finally { if (current(context) && token === loginRequest.current) patchQr({ busy: false }) }
  }
  async function verify(event: FormEvent) {
    event.preventDefault()
    const state = qrRef.current
    if (!state.channel || !state.id || state.busy || !state.verifyCode.trim()) return
    const code = state.verifyCode.trim(); stopLogin(); const token = loginRequest.current, context = generation.current
    patchQr({ busy: true, error: '', verifyCode: '' }); const controller = new AbortController(); loginController.current = controller
    try {
      const result = await api(`/api/admin/channels/${encodeURIComponent(state.channel.id)}/logins/${encodeURIComponent(state.id)}`, { method: 'POST', body: { verifyCode: code }, signal: controller.signal })
      if (!current(context) || token !== loginRequest.current) return
      if (applyLogin(result)) schedulePoll(token, context)
      else { await refreshRef.current(true); if (current(context)) onChangedRef.current() }
    } catch (cause) { if (current(context) && token === loginRequest.current) patchQr({ error: errorMessage(cause) }) }
    finally { if (current(context) && token === loginRequest.current) patchQr({ busy: false }) }
  }

  function closeWecom(force = false) {
    if (wecomRef.current.busy && !force) return
    wecomRequest.current++; conversationController.current?.abort(); patchWecom(initialWecom())
  }
  async function openWecom(channel: Channel) {
    wecomRequest.current++; conversationController.current?.abort()
    patchWecom({ ...initialWecom(), visible: true, channel, botId: channel.botId || '', target: targetKey(channel.target), conversations: channel.target ? [channel.target] : [], replyMode: webhookOnly(channel) ? 'webhook' : channel.replyMode || 'websocket' })
    if (!webhookOnly(channel)) await refreshConversations()
  }
  async function refreshConversations() {
    const state = wecomRef.current
    if (!state.visible || !state.channel || state.busy || webhookOnly(state.channel)) return
    const token = ++wecomRequest.current, context = generation.current
    conversationController.current?.abort(); const controller = new AbortController(); conversationController.current = controller
    patchWecom({ loading: true, error: '' })
    try {
      const result = await api<{ conversations: Target[] }>(`/api/admin/channels/${encodeURIComponent(state.channel.id)}/conversations`, { signal: controller.signal })
      if (!current(context) || token !== wecomRequest.current) return
      const latest = wecomRef.current, previous = latest.conversations.find(item => targetKey(item) === latest.target)
      const next = [...(result.conversations || [])]
      if (previous && !next.some(item => targetKey(item) === latest.target)) next.unshift(previous)
      patchWecom({ conversations: next })
    } catch (cause) { if (current(context) && token === wecomRequest.current) patchWecom({ error: errorMessage(cause) }) }
    finally { if (current(context) && token === wecomRequest.current) patchWecom({ loading: false }) }
  }
  async function saveWecom(event: FormEvent) {
    event.preventDefault(); const state = wecomRef.current
    if (!state.channel || state.busy) return
    const onlyWebhook = webhookOnly(state.channel)
    if (!onlyWebhook && (!state.botId.trim() || (!state.channel.secretSet && !state.secret.trim()))) { patchWecom({ error: '请输入 Bot ID 与 Secret。' }); return }
    const webhookUrl = state.webhookUrl.trim()
    if (state.replyMode === 'webhook' && (!webhookUrl && !state.channel.webhookSet || webhookUrl && !validWebhookUrl(webhookUrl))) { patchWecom({ error: '请输入有效的企业微信群机器人 Webhook 地址。' }); return }
    const token = ++wecomRequest.current, context = generation.current
    conversationController.current?.abort(); patchWecom({ busy: true, loading: false, error: '', secret: '', webhookUrl: '' })
    const credentialsChanged = !onlyWebhook && (Boolean(state.secret.trim()) || state.botId.trim() !== (state.channel.botId || ''))
    const target = state.conversations.find(item => targetKey(item) === state.target)
    const body = { ...(!onlyWebhook ? { botId: state.botId.trim(), ...(state.secret.trim() ? { secret: state.secret.trim() } : {}), ...(!credentialsChanged ? { target: target ? { id: target.id, chatType: target.chatType } : null } : {}) } : {}), ...(state.replyMode !== (state.channel.replyMode || 'websocket') ? { replyMode: state.replyMode } : {}), ...(state.replyMode === 'webhook' && webhookUrl ? { webhookUrl } : {}) }
    try {
      await api(`/api/admin/channels/${encodeURIComponent(state.channel.id)}`, { method: 'PATCH', body, signal: lifetime.current?.signal })
      if (!current(context) || token !== wecomRequest.current) return
      closeWecom(true); Toast.success(credentialsChanged ? '凭据已更新，请重新发现并选择外部会话。' : '企业微信配置已保存。'); onChangedRef.current(); await refreshRef.current(true)
    } catch (cause) { if (current(context) && token === wecomRequest.current) patchWecom({ error: errorMessage(cause) }) }
    finally { if (current(context) && token === wecomRequest.current) patchWecom({ busy: false }) }
  }

  function closeBinding(force = false) { if (bindingRef.current.busy && !force) return; bindingRequest.current++; patchBinding(initialBinding()) }
  async function loadBinding(sessionId: string) {
    const token = ++bindingRequest.current, context = generation.current
    patchBinding({ sessionId, ready: false, error: '', ids: [], loading: Boolean(sessionId) })
    if (!sessionId) return
    try {
      const result = await api(`/api/sessions/${encodeURIComponent(sessionId)}/channels`, { signal: lifetime.current?.signal })
      if (!current(context) || token !== bindingRequest.current || !bindingRef.current.visible) return
      if (result.canManage === false) throw new Error('仅此智能体内的管理员可以配置消息渠道。')
      patchBinding({ ids: (result.channels || []).map((channel: Channel) => channel.id), ready: true })
    } catch (cause) { if (current(context) && token === bindingRequest.current) patchBinding({ error: errorMessage(cause) }) }
    finally { if (current(context) && token === bindingRequest.current) patchBinding({ loading: false }) }
  }
  function openBinding(channel?: Channel) {
    const sessionId = channel?.sessionId || currentSessionId || sessions[0]?.id || ''
    patchBinding({ ...initialBinding(), visible: true, sessionId }); void loadBinding(sessionId)
  }
  async function saveBinding(event: FormEvent) {
    event.preventDefault(); const state = bindingRef.current
    if (state.busy || !state.ready || !state.sessionId || state.loading) return
    const token = bindingRequest.current, context = generation.current; patchBinding({ busy: true, error: '' })
    try {
      await api(`/api/sessions/${encodeURIComponent(state.sessionId)}/channels`, { method: 'PUT', body: { channelIds: [...state.ids] }, signal: lifetime.current?.signal })
      if (!current(context) || token !== bindingRequest.current) return
      closeBinding(true); Toast.success('消息渠道绑定已保存。'); onChangedRef.current(); await refreshRef.current(true)
    } catch (cause) { if (current(context) && token === bindingRequest.current) patchBinding({ error: errorMessage(cause) }) }
    finally { if (current(context) && token === bindingRequest.current) patchBinding({ busy: false }) }
  }
  async function remove(event: FormEvent) {
    event.preventDefault(); const channel = deleteTarget
    if (!channel || deleteBusyRef.current) return
    const context = generation.current; deleteBusyRef.current = true; setDeleteBusy(true); setDeleteError('')
    try {
      await api(`/api/admin/channels/${encodeURIComponent(channel.id)}`, { method: 'DELETE', body: {}, signal: lifetime.current?.signal })
      if (!current(context)) return
      setDeleteTarget(null); Toast.success('消息渠道已删除。'); onChangedRef.current(); await refreshRef.current(true)
    } catch (cause) { if (current(context)) setDeleteError(errorMessage(cause)) }
    finally { if (current(context)) { deleteBusyRef.current = false; setDeleteBusy(false) } }
  }

  const connectedCount = channels.filter(channel => channel.connected && channel.enabled).length
  const webhookCount = channels.filter(channel => webhookOnly(channel) && channel.webhookSet && channel.enabled).length
  const loginConnected = ['confirmed', 'connected'].includes(qr.status), needsVerify = ['need_verify', 'need_verifycode'].includes(qr.status)
  const qrUrl = qr.channel && qr.id && !loginConnected && !['expired', 'error', 'verify_code_blocked'].includes(qr.status) && !qr.failed ? `/api/admin/channels/${encodeURIComponent(qr.channel.id)}/logins/${encodeURIComponent(qr.id)}/qr.svg` : ''
  const loginHint = loginConnected ? qr.channel?.canReceive === false ? '已连接。请先在微信给机器人发送一条消息，再接收智能体新消息。' : '微信已连接，可以关闭此窗口。' : needsVerify ? '请在手机完成验证提示，并填写验证码。' : ['scaned', 'scanned'].includes(qr.status) ? '已扫码，请在手机上确认登录。' : ['scaned_but_redirect', 'binded_redirect'].includes(qr.status) ? '已扫码，确认处理中，请稍候。' : qr.status === 'expired' ? '二维码已过期，请刷新后重新扫描。' : qr.status === 'verify_code_blocked' ? '手机验证已被限制，请刷新二维码重新扫码。' : '请使用本人微信扫码，并在手机上确认登录。'

  return <section className="react-channels">
    <header className="rc-page-heading"><div><span className="rc-eyebrow">MESSAGE CHANNELS</span><h1>消息渠道</h1><p>连接微信会话，或将智能体回复和任务结果推送到企业微信群。</p></div><div className="rc-heading-actions"><Button disabled={!sessions.length} onClick={() => openBinding()}>配置绑定</Button><Button theme="solid" onClick={openCreate}>添加渠道</Button></div></header>
    {error && <div className="rc-alert" role="alert"><Banner type="danger" description={error} /></div>}
    <section className="rc-overview"><div><strong>{channels.length} 个渠道</strong><p>{connectedCount} 个已连接{webhookCount > 0 ? ` · ${webhookCount} 个 Webhook 已配置` : ''} · 每个渠道绑定一个智能体</p></div><Button loading={loading} onClick={() => void refresh()}>刷新状态</Button></section>
    <p className="rc-notice">长连接渠道互通新消息，不同步历史记录。Webhook 仅推送到配置的企业微信群，不接收员工消息。</p>
    {notice && <p className="rc-notice" role="status">{notice}</p>}
    {loading && !channels.length ? <div className="rc-empty" role="status"><Spin />正在加载消息渠道…</div> : !channels.length && <div className="rc-empty">添加消息渠道，连接外部协作会话。</div>}
    <div className="rc-channel-grid">{channels.map(channel => <article className="rc-channel-card" key={channel.id}>
      <header><ChannelMark type={channel.type} /><div><h2>{channel.name}</h2><span>{webhookOnly(channel) ? '企业微信群机器人 · 仅发送' : channel.type === 'wecom' ? '企业微信智能机器人' : channelIdentity(channel.type).label}</span></div><Tag color={channel.connected && channel.enabled ? 'green' : channel.enabled ? 'blue' : 'grey'}>{channelState(channel)}</Tag></header>
      <div className="rc-channel-information"><p><span>{webhookOnly(channel) ? '接收范围' : '外部会话'}</span><strong>{webhookOnly(channel) ? 'Webhook 所在企业微信群' : channel.type === 'wecom' ? channel.target ? targetLabel(channel.target) : '待选择外部会话' : channel.accountLabel || '扫码本人参与'}</strong></p>{channel.type === 'wecom' && <p><span>回复方式</span><strong>{replyLabel(channel)}</strong></p>}<p><span>关联智能体</span><strong>{channel.sessionTitle || '尚未绑定'}</strong></p></div>
      {channel.lastError && <p className="rc-card-error" role="alert">{channel.lastError}</p>}
      {channel.lastDeliveryError && <div className="rc-alert"><Banner type="warning" description={`消息未送达：${channel.lastDeliveryError}`} /></div>}
      {channel.connected && channel.canReceive === false && channel.type !== 'wecom' && <p className="rc-notice">请先在微信给机器人发一条消息，再接收智能体新消息。</p>}
      <form className="rc-rename-form" onSubmit={event => { event.preventDefault(); void mutate(channel, { name: renameValues[channel.id]?.trim() }, '渠道名称已更新。') }}><Input value={renameValues[channel.id] ?? channel.name} onChange={name => setRenameValues(previous => ({ ...previous, [channel.id]: name }))} maxLength={80} aria-label={`渠道名称：${channel.name}`} disabled={Boolean(busy)} /><Button htmlType="submit" disabled={Boolean(busy) || !renameValues[channel.id]?.trim() || renameValues[channel.id]?.trim() === channel.name}>保存名称</Button></form>
      <footer><div>{channel.type === 'wecom' && <Button size="small" disabled={Boolean(busy)} onClick={() => void openWecom(channel)}>配置</Button>}{!webhookOnly(channel) && <Button size="small" disabled={Boolean(busy) || !channel.enabled} onClick={() => void (channel.type === 'wecom' ? reconnect(channel) : startLogin(channel))}>{channel.type === 'wecom' ? '重新连接' : channel.connected ? '重新扫码' : '扫码登录'}</Button>}<Button size="small" theme="borderless" disabled={Boolean(busy) || !sessions.length} onClick={() => openBinding(channel)}>绑定</Button></div><div><Button size="small" theme="borderless" disabled={Boolean(busy)} loading={busy === channel.id} onClick={() => void mutate(channel, { enabled: !channel.enabled }, channel.enabled ? '渠道已暂停。' : '渠道已启用。')}>{channel.enabled ? '暂停' : '启用'}</Button><Button size="small" type="danger" theme="borderless" disabled={Boolean(busy)} onClick={() => { setDeleteTarget(channel); setDeleteError('') }}>删除</Button></div></footer>
    </article>)}</div>

    <Modal visible={createOpen} title="添加消息渠道" onCancel={closeCreate} footer={null} closable={!createBusy} maskClosable={!createBusy} closeOnEsc={!createBusy} width={520} className="react-channel-modal"><form onSubmit={event => void create(event)}><p className="rc-form-description">选择接入方式，完成连接后绑定智能体。</p>{createError && <div className="rc-alert" role="alert"><Banner type="danger" description={createError} /></div>}
      <label className="rc-field"><span>渠道类型</span><Select value={createForm.type} onChange={type => { setCreateForm(previous => ({ ...previous, type: String(type), secret: '', webhookUrl: '' })); setCreateError('') }} disabled={createBusy} optionList={[{ value: 'weixin', label: '个人微信 · 扫码登录' }, { value: 'wecom', label: '企业微信智能机器人 · 长连接' }, { value: 'wecom-webhook', label: '企业微信群机器人 · Webhook' }]} aria-label="渠道类型" /></label>
      <label className="rc-field"><span>渠道名称</span><Input value={createForm.name} onChange={name => setCreateForm(previous => ({ ...previous, name }))} maxLength={80} placeholder="例如：报价业务机器人" disabled={createBusy} aria-label="渠道名称" /></label>
      {createForm.type === 'wecom' ? <><label className="rc-field"><span>Bot ID</span><Input value={createForm.botId} onChange={botId => setCreateForm(previous => ({ ...previous, botId }))} maxLength={256} autoComplete="off" disabled={createBusy} aria-label="Bot ID" /></label><label className="rc-field"><span>Secret</span><Input type="password" value={createForm.secret} onChange={secret => setCreateForm(previous => ({ ...previous, secret }))} maxLength={1024} autoComplete="new-password" disabled={createBusy} aria-label="Secret" /></label><p className="rc-notice">在企业微信后台创建 API 模式、长连接方式的智能机器人，获取 Bot ID 和 Secret。无需 Webhook 回调地址。</p></> : createForm.type === 'wecom-webhook' ? <>
        <label className="rc-field"><span>Webhook 地址</span><Input type="password" value={createForm.webhookUrl} onChange={webhookUrl => setCreateForm(previous => ({ ...previous, webhookUrl }))} maxLength={2048} autoComplete="new-password" placeholder="粘贴企业微信群机器人的完整 Webhook 地址" disabled={createBusy} aria-label="Webhook 地址" /><small>从接收结果的企业微信群中添加群机器人，复制 Webhook 地址。地址包含密钥，仅保存在服务端。</small></label>
        <p className="rc-transport-notice">仅发送通知：绑定后推送智能体回复和定时任务结果。接收员工消息需要另配长连接机器人。</p>
        <p className="rc-notice">{webhookMediaHelp}</p>
      </> : <p className="rc-notice">添加后使用本人微信扫码，并在手机上确认登录。</p>}
      <footer className="rc-modal-footer"><Button disabled={createBusy} onClick={closeCreate}>取消</Button><Button theme="solid" htmlType="submit" loading={createBusy}>添加渠道</Button></footer></form></Modal>

    <Modal visible={qr.visible} title={<div className="rc-modal-brand"><ChannelMark type="weixin" size={34} /><div>微信扫码登录<small>{qr.channel?.name}</small></div></div>} onCancel={closeQr} footer={null} width={440} className="react-channel-modal"><div className="rc-qr-frame">{qrUrl ? <img src={qrUrl} width={224} height={224} alt="使用本人微信扫描此二维码登录消息渠道" onError={() => patchQr({ failed: true })} /> : <span>{qr.busy ? '正在申请二维码…' : loginConnected ? '微信已连接' : qr.failed ? '二维码加载失败，请刷新' : statusLabels[qr.status] || '请刷新二维码'}</span>}</div>
      {qr.error && <div className="rc-alert" role="alert"><Banner type="danger" description={qr.error} /></div>}<p className="rc-login-hint" role="status" aria-live="polite">{loginHint}</p>
      {needsVerify && <form onSubmit={event => void verify(event)}><label className="rc-field"><span>手机验证码</span><Input value={qr.verifyCode} onChange={verifyCode => patchQr({ verifyCode })} maxLength={12} autoComplete="one-time-code" disabled={qr.busy} aria-label="手机验证码" /></label><Button theme="solid" htmlType="submit" loading={qr.busy} disabled={!qr.verifyCode.trim()}>提交验证码</Button></form>}
      <p className="rc-notice">需要微信支持 ClawBot 插件。当前支持文字与语音转写。</p><footer className="rc-modal-footer"><Button disabled={qr.busy} onClick={() => { if (qr.channel) void startLogin(qr.channel) }}>刷新二维码</Button><Button theme="solid" onClick={closeQr}>完成</Button></footer>
    </Modal>

    <Modal visible={wecom.visible} title={<div className="rc-modal-brand"><ChannelMark type="wecom" size={34} /><div>企业微信配置<small>{wecom.channel?.name}</small></div></div>} onCancel={() => closeWecom()} footer={null} closable={!wecom.busy} maskClosable={!wecom.busy} closeOnEsc={!wecom.busy} width={560} className="react-channel-modal"><form onSubmit={event => void saveWecom(event)}>{wecom.error && <div className="rc-alert" role="alert"><Banner type="danger" description={wecom.error} /></div>}
      {!webhookOnly(wecom.channel) && <section className="rc-configuration-section" aria-label="接收消息配置">
      <h3>接收消息</h3>
      <label className="rc-field"><span>Bot ID</span><Input value={wecom.botId} onChange={botId => patchWecom({ botId })} maxLength={256} autoComplete="off" disabled={wecom.busy} aria-label="企业微信 Bot ID" /></label><label className="rc-field"><span>Secret</span><Input type="password" value={wecom.secret} onChange={secret => patchWecom({ secret })} maxLength={1024} placeholder={wecom.channel?.secretSet ? '留空保留现有 Secret' : '请输入 Secret'} autoComplete="new-password" disabled={wecom.busy} aria-label="企业微信 Secret" /><small>凭据仅保存在服务端。更新凭据会清空外部会话，请重新发现并选择。</small></label>
      <div className="rc-field"><div className="rc-field-heading"><label htmlFor="react-wecom-target">消息互通会话</label><Button size="small" theme="borderless" disabled={wecom.busy} loading={wecom.loading} onClick={() => void refreshConversations()}>刷新会话</Button></div><Select id="react-wecom-target" value={wecom.target} onChange={target => patchWecom({ target: String(target || '') })} disabled={wecom.busy} optionList={[{ value: '', label: '暂不选择' }, ...wecom.conversations.map(target => ({ value: targetKey(target), label: targetLabel(target) }))]} aria-label="消息互通会话" /><small>先将机器人加入目标企微群并 @ 机器人发文字，或私聊机器人，再刷新选择。请按会话 ID 与最近收到时间核对。</small></div>
      </section>}
      <section className="rc-configuration-section" aria-label="回复与结果投递配置">
        <h3>回复与结果投递</h3>
        {!webhookOnly(wecom.channel) && <label className="rc-field"><span>回复方式</span><Select value={wecom.replyMode} onChange={value => patchWecom({ replyMode: value === 'webhook' ? 'webhook' : 'websocket', webhookUrl: '', error: '' })} disabled={wecom.busy} optionList={[{ value: 'websocket', label: '长连接回复' }, { value: 'webhook', label: '群机器人 Webhook 回复' }]} aria-label="企业微信回复方式" /></label>}
        {wecom.replyMode === 'webhook' ? <>
          <label className="rc-field"><span>Webhook 地址</span><Input type="password" value={wecom.webhookUrl} onChange={webhookUrl => patchWecom({ webhookUrl })} maxLength={2048} placeholder={wecom.channel?.webhookSet ? '留空保留已保存的 Webhook 地址' : '粘贴企业微信群机器人的完整 Webhook 地址'} autoComplete="new-password" disabled={wecom.busy} aria-label="企业微信 Webhook 地址" /><small>{wecom.channel?.webhookSet ? '已保存地址，出于安全考虑不回显。填写新地址可替换。' : '地址包含机器人密钥，仅保存在服务端，不会展示给员工。'}</small></label>
          <p className="rc-transport-notice">{webhookOnly(wecom.channel) ? '仅发送通知，不接收员工消息。' : '员工消息仍由长连接接收，回复只通过 Webhook 发送。'}智能体回复和定时任务结果将投递到此 Webhook 所在群，请确认目标群无误。</p>
          <p className="rc-notice">{webhookMediaHelp}</p>
        </> : <p className="rc-notice">智能体回复和任务结果发送到上方选定的企微会话。历史记录不转发。</p>}
        <p className="rc-notice">切换回复方式或替换 Webhook 地址会停止旧配置的待发送消息及执行中的渠道任务。</p>
      </section>
      <footer className="rc-modal-footer"><Button disabled={wecom.busy} onClick={() => closeWecom()}>取消</Button><Button theme="solid" htmlType="submit" loading={wecom.busy}>保存配置</Button></footer>
    </form></Modal>

    <Modal visible={binding.visible} title="智能体渠道绑定" onCancel={() => closeBinding()} footer={null} closable={!binding.busy} maskClosable={!binding.busy} closeOnEsc={!binding.busy} width={560} className="react-channel-modal"><form onSubmit={event => void saveBinding(event)}><p className="rc-form-description">选择智能体，配置消息互通或结果推送渠道。</p>{binding.error && <div className="rc-alert" role="alert"><Banner type="danger" description={binding.error} /></div>}
      <label className="rc-field"><span>关联智能体</span><Select value={binding.sessionId || undefined} placeholder="请选择智能体" onChange={value => void loadBinding(String(value || ''))} disabled={binding.busy} optionList={sessions.map(item => ({ value: item.id, label: item.title }))} aria-label="关联智能体" /></label>
      {binding.loading ? <div className="rc-binding-loading" role="status"><Spin />正在读取绑定配置…</div> : binding.ready && <div className="rc-binding-options">{channels.map(channel => {
        const conflict = Boolean(channel.sessionId && channel.sessionId !== binding.sessionId)
        return <div className={`rc-binding-option${conflict ? ' unavailable' : ''}`} key={channel.id}><Checkbox checked={binding.ids.includes(channel.id)} disabled={binding.busy || conflict} onChange={event => patchBinding({ ids: event.target.checked ? [...new Set([...bindingRef.current.ids, channel.id])] : bindingRef.current.ids.filter(id => id !== channel.id) })} aria-label={`绑定${channel.name}`} /><ChannelMark type={channel.type} size={32} /><div><strong>{channel.name}</strong><small>{conflict ? `已绑定「${channel.sessionTitle || '其他智能体'}」，请先在原智能体解绑` : `${webhookOnly(channel) ? '企业微信群 · 仅发送通知' : channelIdentity(channel.type).label} · ${channelState(channel)}`}</small></div></div>
      })}{!channels.length && <p className="rc-notice">请先添加消息渠道。</p>}</div>}
      <p className="rc-notice">可选择多个渠道。绑定后，智能体的新回复和任务结果会发送到各渠道配置的接收方；Webhook 不接收消息。</p><footer className="rc-modal-footer"><Button disabled={binding.busy} onClick={() => closeBinding()}>取消</Button><Button theme="solid" htmlType="submit" loading={binding.busy} disabled={!binding.ready || binding.loading || !binding.sessionId}>保存绑定</Button></footer>
    </form></Modal>

    <Modal visible={Boolean(deleteTarget)} title="删除消息渠道" onCancel={() => { if (!deleteBusyRef.current) setDeleteTarget(null) }} footer={null} closable={!deleteBusy} maskClosable={!deleteBusy} closeOnEsc={!deleteBusy} width={460} className="react-channel-modal"><form onSubmit={event => void remove(event)}>{deleteError && <div className="rc-alert" role="alert"><Banner type="danger" description={deleteError} /></div>}<p className="rc-form-description">确定删除「{deleteTarget?.name}」？外部参与人将退出关联智能体，已保存的协作记录保留。</p><footer className="rc-modal-footer"><Button disabled={deleteBusy} onClick={() => setDeleteTarget(null)}>取消</Button><Button type="danger" theme="solid" htmlType="submit" loading={deleteBusy}>确认删除</Button></footer></form></Modal>
  </section>
}

export default ChannelsPage
