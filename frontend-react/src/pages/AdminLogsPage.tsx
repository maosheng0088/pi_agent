import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { Banner, Button, Checkbox, Input, Select, Space, Spin, Tag } from '@douyinfe/semi-ui'
import { IconArrowDown, IconDownload, IconPause, IconPlay, IconRefresh, IconSearch } from '@douyinfe/semi-icons'
import { api, ApiError, consumeStream, errorMessage } from '../lib/api'
import type { User } from '../lib/types'
import './admin-logs.css'

type Level = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL'
interface LogEntry { id: number; timestamp: string; level: Level; source: string; message: string; details?: unknown; sessionId?: string; taskId?: string; actorId?: string }
interface History { logs: LogEntry[]; nextBefore: number | null; cursor: number; hasMore: boolean; sources: string[]; retention?: { maxEntries: number; maxAgeDays: number } }
interface Filter { level: string; source: string; q: string; from: string; to: string }
type Connection = 'loading' | 'connecting' | 'live' | 'paused' | 'reconnecting' | 'locked'
const emptyFilter = (): Filter => ({ level: '', source: '', q: '', from: '', to: '' })
const levels: Level[] = ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL']
const connectionNames: Record<Connection, string> = { loading: '正在加载历史日志', connecting: '正在连接实时日志', live: '实时连接正常', paused: '已暂停接收', reconnecting: '连接中断，正在重连', locked: '日志访问已关闭' }
const MAX_LOGS = 2000
const MAX_EXPORT_BYTES = 50 * 1024 * 1024
function clock(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) }
function validLogs(value: unknown): LogEntry[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is LogEntry => item && Number.isSafeInteger(item.id) && item.id > 0 && typeof item.timestamp === 'string' && !Number.isNaN(Date.parse(item.timestamp)) && levels.includes(item.level) && typeof item.source === 'string' && item.source.length <= 120 && typeof item.message === 'string' && item.message.length <= 40000).slice(0, MAX_LOGS)
}
function structured(entry: LogEntry) { try { return JSON.stringify({ ...(entry.sessionId ? { sessionId: entry.sessionId } : {}), ...(entry.taskId ? { taskId: entry.taskId } : {}), ...(entry.actorId ? { actorId: entry.actorId } : {}), ...(entry.details !== undefined ? { details: entry.details } : {}) }, null, 2) } catch { return '详情无法解析。' } }
function query(filter: Filter) { const params = new URLSearchParams(); for (const [name, value] of Object.entries(filter)) if (value.trim()) params.set(name, name === 'from' || name === 'to' ? new Date(`${value}:00+08:00`).toISOString() : value.trim()); return params }

export default function AdminLogsPage({ user }: { user: User }) {
  const labelId = useId(), identity = `${user.id}:${user.role}`, identityRef = useRef(identity); identityRef.current = identity
  const [dataIdentity, setDataIdentity] = useState(identity), [logs, setLogs] = useState<LogEntry[]>([]), [draft, setDraft] = useState<Filter>(emptyFilter), [applied, setApplied] = useState<Filter>(emptyFilter), [reload, setReload] = useState(0)
  const [sources, setSources] = useState<string[]>([]), [retention, setRetention] = useState<History['retention']>(), [phase, setPhase] = useState<Connection>('loading'), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [paused, setPaused] = useState(false), [autoScroll, setAutoScroll] = useState(true), [loadingOlder, setLoadingOlder] = useState(false), [exporting, setExporting] = useState(false), [hasMore, setHasMore] = useState(false)
  const generation = useRef(0), streamVersion = useRef(0), locked = useRef(false), pausedRef = useRef(false), historyReady = useRef(false), cursor = useRef(0), before = useRef<number | null>(null), logsRef = useRef<LogEntry[]>([])
  const historyController = useRef<AbortController>(), streamController = useRef<AbortController>(), exportController = useRef<AbortController>(), retryTimer = useRef<ReturnType<typeof setTimeout>>(), attempts = useRef(0), olderPending = useRef(false), exportPending = useRef(false)
  const terminal = useRef<HTMLDivElement>(null), following = useRef(true), scrollAnchor = useRef<{ top: number; height: number } | null>(null), connectRef = useRef<() => void>(() => {}), downloadUrl = useRef<string>()
  const allowed = user.role === 'admin', visible = allowed && dataIdentity === identity && phase !== 'locked'
  function current(token: number) { return generation.current === token && identityRef.current === identity && !locked.current }
  function stopStream() { streamVersion.current++; streamController.current?.abort(); clearTimeout(retryTimer.current) }
  function closeAccess(message = '管理员权限已失效，日志内容已清除。') {
    locked.current = true; stopStream(); historyController.current?.abort(); exportController.current?.abort(); logsRef.current = []; setLogs([]); setSources([]); setRetention(undefined); setHasMore(false); setNotice(''); setError(message); setPhase('locked'); setLoadingOlder(false); setExporting(false)
    if (downloadUrl.current) { URL.revokeObjectURL(downloadUrl.current); downloadUrl.current = undefined }
  }
  function failed(reason: unknown, token: number) {
    if (!current(token)) return true
    if (reason instanceof ApiError && [401, 403].includes(reason.status)) { closeAccess(reason.status === 401 ? '登录已失效，日志内容已清除。请重新登录。' : undefined); if (reason.status === 401) window.dispatchEvent(new Event('pi:auth-expired')); return true }
    setError(errorMessage(reason)); return false
  }
  function merge(values: unknown) { const incoming = validLogs(values); if (!incoming.length) return; const merged = [...new Map([...logsRef.current, ...incoming].map(entry => [entry.id, entry])).values()].sort((a, b) => a.id - b.id); logsRef.current = merged.slice(-MAX_LOGS); setLogs(logsRef.current); setSources(previous => [...new Set([...previous, ...incoming.map(entry => entry.source)])].sort()) }
  async function responseError(response: Response) { const data = await response.json().catch(() => ({})); throw new ApiError(data.error || `日志请求失败（${response.status}）`, response.status) }
  async function connect() {
    if (pausedRef.current || locked.current || !allowed) return
    stopStream(); const token = generation.current, stream = ++streamVersion.current, controller = new AbortController(); streamController.current = controller
    const valid = () => current(token) && streamVersion.current === stream && !controller.signal.aborted && !pausedRef.current
    setPhase(attempts.current ? 'reconnecting' : 'connecting')
    try {
      const params = query(applied); params.set('after', String(cursor.current))
      const response = await fetch(`/api/admin/logs/live?${params}`, { credentials: 'same-origin', headers: { Accept: 'text/event-stream' }, signal: controller.signal })
      if (!valid()) return
      if (!response.ok) await responseError(response)
      setPhase('live'); setError(''); attempts.current = 0
      await consumeStream(response, event => {
        if (!valid()) return
        if (event.type === 'auth_expired') { closeAccess(event.message || '登录或管理员权限已失效，日志内容已清除。'); return }
        if (event.type === 'gap') { setNotice(typeof event.message === 'string' ? event.message.slice(0,1000) : '部分旧日志已超过保留期，无法完整补回。当前继续接收仍保留的日志。'); return }
        if (event.type === 'logs') { merge(event.logs); if (Number.isSafeInteger(event.cursor) && event.cursor >= cursor.current) cursor.current = event.cursor }
      })
      if (valid()) throw new Error('实时日志连接已结束，正在重新连接。')
    } catch (reason) {
      if (!valid() || failed(reason, token)) return
      setPhase('reconnecting'); const delay = Math.min(30000, 2000 * 2 ** Math.min(attempts.current++, 4)); retryTimer.current = setTimeout(() => { if (current(token) && !pausedRef.current) connectRef.current() }, delay)
    }
  }
  connectRef.current = () => { void connect() }
  useEffect(() => {
    const token = ++generation.current; locked.current = !allowed; setDataIdentity(identity); stopStream(); historyController.current?.abort(); exportController.current?.abort(); const controller = new AbortController(); historyController.current = controller
    cursor.current = 0; before.current = null; historyReady.current = false; logsRef.current = []; setLogs([]); setSources([]); setRetention(undefined); setHasMore(false); setError(''); setNotice(''); setPhase(allowed ? 'loading' : 'locked'); setLoadingOlder(false); setExporting(false); olderPending.current = false; exportPending.current = false; attempts.current = 0
    if (allowed) void (async () => {
      try { const params = query(applied); params.set('limit', '200'); const data = await api<History>(`/api/admin/logs?${params}`, { signal: controller.signal }); if (!current(token) || controller.signal.aborted) return; merge(data.logs); setSources((data.sources || []).filter(source => typeof source === 'string')); setRetention(data.retention); before.current = data.nextBefore; setHasMore(!!data.hasMore); cursor.current = Number.isSafeInteger(data.cursor) ? data.cursor : 0; historyReady.current = true; if (pausedRef.current) setPhase('paused'); else connectRef.current() }
      catch (reason) { if (!controller.signal.aborted && current(token) && !failed(reason, token)) { setPhase(pausedRef.current ? 'paused' : 'reconnecting'); if (!pausedRef.current) retryTimer.current = setTimeout(() => { if (current(token) && !pausedRef.current) setReload(value => value + 1) },3000) } }
    })()
    return () => { generation.current++; stopStream(); controller.abort(); exportController.current?.abort(); if (downloadUrl.current) { URL.revokeObjectURL(downloadUrl.current); downloadUrl.current = undefined } }
  }, [identity, JSON.stringify(applied), reload])
  useEffect(() => { const expired = () => closeAccess('登录已失效，日志内容已清除。请重新登录。'); window.addEventListener('pi:auth-expired', expired); return () => window.removeEventListener('pi:auth-expired', expired) }, [])
  useEffect(() => { const node = terminal.current; if (!node) return; if (scrollAnchor.current) { node.scrollTop = scrollAnchor.current.top + node.scrollHeight - scrollAnchor.current.height; scrollAnchor.current = null } else if (autoScroll && following.current) node.scrollTop = node.scrollHeight }, [logs, autoScroll])
  function apply(event?: FormEvent) { event?.preventDefault(); if (draft.from && Number.isNaN(Date.parse(`${draft.from}:00+08:00`)) || draft.to && Number.isNaN(Date.parse(`${draft.to}:00+08:00`))) { setError('请选择有效的开始和结束时间。'); return }; if (draft.from && draft.to && draft.from > draft.to) { setError('开始时间不能晚于结束时间。'); return }; setApplied({ ...draft, q: draft.q.trim() }); if (JSON.stringify(applied) === JSON.stringify({ ...draft, q: draft.q.trim() })) setReload(value => value + 1) }
  function togglePause() { const next = !pausedRef.current; pausedRef.current = next; setPaused(next); if (next) { stopStream(); setPhase('paused') } else { attempts.current = 0; setError(''); if (historyReady.current) connectRef.current(); else setReload(value => value + 1) } }
  async function older() {
    if (!hasMore || !before.current || olderPending.current || logsRef.current.length >= MAX_LOGS) return
    const token = generation.current, controller = historyController.current; olderPending.current = true; following.current = false; setAutoScroll(false); setLoadingOlder(true); setError('')
    try { const params = query(applied); params.set('before', String(before.current)); params.set('limit', String(Math.min(200, MAX_LOGS - logsRef.current.length))); const data = await api<History>(`/api/admin/logs?${params}`, { signal: controller?.signal }); if (!current(token) || controller?.signal.aborted) return; const node = terminal.current; if (node) scrollAnchor.current = { top: node.scrollTop, height: node.scrollHeight }; merge(data.logs); before.current = data.nextBefore; setHasMore(!!data.hasMore) }
    catch (reason) { if (!controller?.signal.aborted) failed(reason, token) } finally { if (current(token)) { olderPending.current = false; setLoadingOlder(false) } }
  }
  async function exportLogs() {
    if (exportPending.current || locked.current || !allowed) return
    const token = generation.current, controller = new AbortController(); exportController.current?.abort(); exportController.current = controller; exportPending.current = true; setExporting(true); setNotice(''); setError('')
    try {
      const params = query(applied); params.set('format', 'txt'); const response = await fetch(`/api/admin/logs/export?${params}`, { credentials: 'same-origin', headers: { Accept: 'text/plain' }, signal: controller.signal })
      if (!current(token) || controller.signal.aborted) return
      if (!response.ok) await responseError(response)
      if (!/^text\/plain(?:;|$)/i.test(response.headers.get('Content-Type') || '')) throw new Error('日志导出格式异常，请稍后重试。')
      if (Number(response.headers.get('Content-Length') || '0') > MAX_EXPORT_BYTES) throw new Error('日志导出超过 50 MB，请缩小筛选范围后重试。')
      if (!response.body) throw new Error('日志导出内容为空，请稍后重试。')
      const reader = response.body.getReader(), chunks: BlobPart[] = []; let bytes = 0
      try { while (true) { const part = await reader.read(); if (part.done) break; if (!current(token) || controller.signal.aborted) { await reader.cancel(); return }; bytes += part.value.byteLength; if (bytes > MAX_EXPORT_BYTES) { await reader.cancel(); throw new Error('日志导出超过 50 MB，请缩小筛选范围后重试。') }; chunks.push(new Uint8Array(part.value).buffer) } } finally { reader.releaseLock() }
      if (!current(token) || controller.signal.aborted) return
      const blob = new Blob(chunks, { type: 'text/plain;charset=utf-8' }), count = response.headers.get('X-Log-Export-Count'), truncated = response.headers.get('X-Log-Export-Truncated') === 'true'
      if (downloadUrl.current) URL.revokeObjectURL(downloadUrl.current)
      const url = URL.createObjectURL(blob); downloadUrl.current = url; const link = document.createElement('a'); link.href = url; link.download = `pi-system-logs-${new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'})}.txt`; link.click(); setNotice(`已导出脱敏日志${count ? ` ${count} 条` : ''}。${truncated ? '结果超过导出上限，文件已截断；请缩小筛选范围后再次导出。' : ''}`)
    }
    catch (reason) { if (!controller.signal.aborted) failed(reason, token) } finally { if (current(token)) { exportPending.current = false; setExporting(false) } }
  }
  if (!visible) return <section className="admin-logs-page"><h1>系统日志</h1><Banner type="danger" closeIcon={null} description={<span role="alert">{error || '仅管理员可查看系统日志。'}</span>} /></section>
  return <section className="admin-logs-page" aria-label="管理员系统日志">
    <header className="admin-logs-heading"><div><span className="admin-logs-kicker">SYSTEM LOGS</span><h1>系统日志</h1><p>查看服务、任务与渠道的运行情况。运行日志已脱敏，对话记录请切换“所有对话”。</p></div><Space><Button icon={<IconRefresh aria-hidden="true" />} onClick={() => setReload(value => value + 1)} disabled={phase === 'loading'}>刷新日志</Button><Button icon={<IconDownload aria-hidden="true" />} loading={exporting} onClick={() => void exportLogs()}>导出脱敏日志</Button></Space></header>
    <form className="admin-logs-filters" onSubmit={apply}>
      <div><label id={`${labelId}-level`}>日志级别</label><Select aria-labelledby={`${labelId}-level`} value={draft.level} optionList={[{ value: '', label: '全部级别' }, ...levels.map(level => ({ value: level, label: level }))]} onChange={value => setDraft(previous => ({ ...previous, level: String(value || '') }))} style={{ width: '100%' }} /></div>
      <div><label id={`${labelId}-source`}>日志来源</label><Select aria-labelledby={`${labelId}-source`} value={draft.source} optionList={[{ value: '', label: '全部来源' }, ...[...new Set([...sources, ...(draft.source ? [draft.source] : [])])].map(source => ({ value: source, label: source }))]} onChange={value => setDraft(previous => ({ ...previous, source: String(value || '') }))} style={{ width: '100%' }} filter /></div>
      <div className="admin-logs-query"><label htmlFor={`${labelId}-query`}>关键词</label><Input id={`${labelId}-query`} prefix={<IconSearch aria-hidden="true" />} value={draft.q} maxLength={200} showClear onChange={q => setDraft(previous => ({ ...previous, q }))} placeholder="检索事件、任务编号或错误" /></div>
      <div><label htmlFor={`${labelId}-from`}>开始时间（北京时间）</label><input id={`${labelId}-from`} type="datetime-local" value={draft.from} onChange={event => setDraft(previous => ({ ...previous, from: event.target.value }))} /></div>
      <div><label htmlFor={`${labelId}-to`}>结束时间（北京时间）</label><input id={`${labelId}-to`} type="datetime-local" value={draft.to} onChange={event => setDraft(previous => ({ ...previous, to: event.target.value }))} /></div>
      <div className="admin-logs-filter-actions"><Button htmlType="submit" theme="solid">应用筛选</Button><Button onClick={() => { setDraft(emptyFilter()); setApplied(emptyFilter()); setReload(value => value + 1) }}>重置</Button></div>
    </form>
    {error && <Banner type="warning" closeIcon={null} description={<Space><span role="alert">{error}</span><Button size="small" theme="borderless" onClick={() => { attempts.current = 0; setError(''); if (!logsRef.current.length) setReload(value => value + 1); else connectRef.current() }}>立即重试</Button></Space>} />}
    {notice && <Banner type="info" closeIcon={null} description={<span role="status">{notice}</span>} />}
    <div className="admin-logs-controls"><span className={`admin-logs-connection ${phase}`} role="status" aria-live="polite" aria-atomic="true"><i aria-hidden="true" />{connectionNames[phase]} · 已显示 {logs.length} 条</span><Space><Checkbox checked={autoScroll} onChange={event => { following.current = !!event.target.checked; setAutoScroll(!!event.target.checked) }}>自动滚动</Checkbox><Button size="small" icon={paused ? <IconPlay aria-hidden="true" /> : <IconPause aria-hidden="true" />} onClick={togglePause} disabled={phase === 'loading'}>{paused ? '继续接收' : '暂停接收'}</Button><Button size="small" icon={<IconArrowDown aria-hidden="true" />} onClick={() => { following.current = true; setAutoScroll(true); if (terminal.current) terminal.current.scrollTop = terminal.current.scrollHeight }}>回到最新</Button></Space></div>
    <div className="admin-logs-terminal" ref={terminal} role="region" aria-label="脱敏日志内容" tabIndex={0} onScroll={event => { const node = event.currentTarget; if (node.scrollHeight - node.scrollTop - node.clientHeight > 100) { following.current = false; setAutoScroll(false) } }}>
      <div className="admin-logs-history"><Button size="small" theme="borderless" loading={loadingOlder} disabled={!hasMore || logs.length >= MAX_LOGS || phase === 'loading'} onClick={() => void older()}>{hasMore ? '加载更早日志' : '已加载当前范围历史'}</Button></div>
      {phase === 'loading' ? <div className="admin-logs-empty"><Spin />正在加载日志…</div> : logs.length ? <ol className="admin-logs-entries">{logs.map(entry => <li className={`admin-log-entry level-${entry.level.toLowerCase()}`} key={entry.id}><details><summary><span className="admin-log-time">{clock(entry.timestamp)}</span><span className="admin-log-level">{entry.level}</span><span className="admin-log-source">{entry.source}</span><span className="admin-log-message">{entry.message}</span></summary><div className="admin-log-details"><span>日志编号 {entry.id}</span><pre>{structured(entry)}</pre></div></details></li>)}</ol> : <div className="admin-logs-empty">当前筛选范围暂无日志。</div>}
    </div>
    <footer className="admin-logs-footer"><span>仅管理员可见 · 时间按北京时间显示 · 当前窗口最多保留 {MAX_LOGS} 条{logs.length >= MAX_LOGS ? '，请缩小筛选范围或导出查看。' : ''}</span>{retention && <span>服务保留上限 {retention.maxEntries.toLocaleString('zh-CN')} 条 / {retention.maxAgeDays} 天</span>}</footer>
  </section>
}

