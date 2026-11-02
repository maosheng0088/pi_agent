import { useEffect, useRef, useState } from 'react'
import { Banner, Button, Checkbox, Space, Tag } from '@douyinfe/semi-ui'
import { IconArrowDown, IconPause, IconPlay, IconRefresh } from '@douyinfe/semi-icons'
import { api, ApiError, errorMessage } from '../../lib/api'
import type { User } from '../../lib/types'
import { statusNames, type TaskRun } from './model'
import './business-run-log.css'

interface Props { run: TaskRun; user?: User }
interface LogResponse { content?: string; truncated?: boolean; run?: { id: string; status: string } }
const active = (status: string) => status === 'running' || status === 'queued'

function LogViewer({ run }: { run: TaskRun }) {
  const [content, setContent] = useState(''), [truncated, setTruncated] = useState(false), [status, setStatus] = useState(run.status)
  const [loading, setLoading] = useState(true), [paused, setPaused] = useState(false), [error, setError] = useState(''), [locked, setLocked] = useState(false), [following, setFollowing] = useState(true), [updatedAt, setUpdatedAt] = useState(''), [finalizing, setFinalizing] = useState(false)
  const lifetime = useRef(0), sequence = useRef(0), controller = useRef<AbortController>(), timer = useRef<ReturnType<typeof setTimeout>>()
  const pausedRef = useRef(false), lockedRef = useRef(false), statusRef = useRef(run.status), followRef = useRef(true), finalRead = useRef(false), output = useRef<HTMLPreElement>(null), refreshRef = useRef<() => void>(() => {})

  useEffect(() => {
    const epoch = ++lifetime.current
    let alive = true
    const current = (request: number) => alive && epoch === lifetime.current && request === sequence.current && !lockedRef.current
    function stop() { clearTimeout(timer.current); controller.current?.abort(); sequence.current++ }
    function closeAccess(message: string) {
      lockedRef.current = true; stop(); setContent(''); setTruncated(false); setUpdatedAt(''); setError(message); setLocked(true); setLoading(false); setFinalizing(false)
    }
    function schedule(delay = 2000) { clearTimeout(timer.current); if (alive && !pausedRef.current && !lockedRef.current) timer.current = setTimeout(() => void read(), delay) }
    async function read() {
      if (!alive || lockedRef.current) return
      clearTimeout(timer.current); controller.current?.abort()
      const request = ++sequence.current, pending = new AbortController(); controller.current = pending
      setLoading(true); setError('')
      try {
        const data = await api<LogResponse>(`/api/admin/task-runs/${encodeURIComponent(run.id)}/log`, { signal: pending.signal })
        if (!current(request)) return
        if (data.run && data.run.id !== run.id) throw new Error('返回的运行编号不匹配，请刷新后重试。')
        const next = data.run?.status || statusRef.current, wasActive = active(statusRef.current)
        statusRef.current = next; setStatus(next); setContent(typeof data.content === 'string' ? data.content : ''); setTruncated(!!data.truncated)
        setUpdatedAt(new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }))
        if (wasActive && !active(next) && !finalRead.current) { finalRead.current = true; setFinalizing(true); schedule(0) }
        else { finalRead.current = false; setFinalizing(false); if (active(next)) schedule() }
      } catch (cause) {
        if (!current(request) || pending.signal.aborted) return
        if (cause instanceof ApiError && [401, 403].includes(cause.status)) { closeAccess('管理员权限已失效，执行日志已清除。'); return }
        setError(errorMessage(cause)); if (active(statusRef.current) || finalRead.current) schedule()
      } finally { if (current(request)) setLoading(false) }
    }
    refreshRef.current = () => { stop(); if (alive && !lockedRef.current) void read() }
    const expire = () => closeAccess('登录已失效，执行日志已清除。请重新登录。')
    window.addEventListener('pi:auth-expired', expire)
    void read()
    return () => { alive = false; lifetime.current++; stop(); window.removeEventListener('pi:auth-expired', expire) }
  }, [run.id])

  useEffect(() => { if (followRef.current && output.current) output.current.scrollTop = output.current.scrollHeight }, [content])
  function togglePause() {
    const next = !pausedRef.current; pausedRef.current = next; setPaused(next)
    clearTimeout(timer.current)
    if (next) { sequence.current++; controller.current?.abort(); setLoading(false) }
    else refreshRef.current()
  }
  function toggleFollow(next: boolean) { followRef.current = next; setFollowing(next); if (next && output.current) output.current.scrollTop = output.current.scrollHeight }
  if (locked) return <Banner type="warning" description={<span role="alert">{error}</span>} closeIcon={null} />
  return <section className="business-run-log-viewer" aria-label="业务项目程序日志">
    <p className="automation-help">仅管理员可查看程序 stdout / stderr（包含 print 输出），不会发送到业务空间。</p>
    <div className="business-run-log-controls"><Space wrap><Tag color={status === 'failed' ? 'red' : active(status) ? 'blue' : 'grey'}>{statusNames[status] || status}</Tag><span role="status">{paused ? '自动刷新已暂停' : finalizing ? '任务已结束，正在读取最后日志' : active(status) ? '每 2 秒自动刷新' : '任务已结束，自动刷新已停止'}{updatedAt && ` · 更新于 ${updatedAt}`}</span></Space><Space wrap>{(active(status) || paused || finalizing) && <Button icon={paused ? <IconPlay aria-hidden="true" /> : <IconPause aria-hidden="true" />} onClick={togglePause}>{paused ? '继续刷新' : '暂停刷新'}</Button>}<Button icon={<IconRefresh aria-hidden="true" />} loading={loading} disabled={loading} onClick={() => refreshRef.current()}>刷新日志</Button></Space></div>
    {error && <Banner type="danger" description={<span role="alert">{error}</span>} closeIcon={null} />}
    <div className="business-run-log-follow"><Checkbox checked={following} onChange={event => toggleFollow(!!event.target.checked)}>跟随最新日志</Checkbox>{!following && <Button size="small" theme="borderless" icon={<IconArrowDown aria-hidden="true" />} onClick={() => toggleFollow(true)}>回到最新</Button>}</div>
    <pre className="business-run-log-output" ref={output} tabIndex={0} aria-label="程序日志内容" aria-busy={loading} onScroll={() => { const element = output.current; if (element && element.scrollHeight - element.clientHeight - element.scrollTop > 40 && followRef.current) toggleFollow(false) }}>{loading && !content ? '正在加载执行日志…' : content || '尚无程序输出；程序启动并写入日志后会显示在这里。'}</pre>
    {truncated && <p className="business-run-log-notice" role="status">日志较长，当前仅显示受限长度的内容；较早输出可能已截断。</p>}
  </section>
}

export default function BusinessRunLogViewer({ run, user }: Props) {
  if (user && user.role !== 'admin') return <Banner type="warning" description="仅管理员可查看执行日志。" />
  return <LogViewer key={`${user?.id || 'admin-page'}:${user?.role || 'admin'}:${run.id}`} run={run} />
}
