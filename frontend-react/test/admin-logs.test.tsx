// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import AdminLogsPage from '../src/pages/AdminLogsPage'

vi.mock('lottie-web', () => ({ default: { loadAnimation: vi.fn(() => ({ destroy: vi.fn(), play: vi.fn(), pause: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() })) } }))
const admin = { id: 'admin', role: 'admin', username: 'admin', displayName: '管理员' }, employee = { id: 'member', role: 'member', username: '003009', displayName: '业务同事' }
const entry = (id: number, message = `安全运行事件 ${id}`) => ({ id, timestamp: '2026-10-29T01:00:00Z', level: 'INFO', source: 'tasks', message, details: { taskId: 'task-safe', attempt: 1 } })
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
const history = (logs = [entry(1)], options = {}) => ({ logs, nextBefore: null, hasMore: false, cursor: logs.at(-1)?.id || 0, sources: ['tasks', 'server'], retention: { maxEntries: 20000, maxAgeDays: 14 }, ...options })
let fetcher: ReturnType<typeof vi.fn>, streams: Array<{ path: string; aborted: boolean; push(value: unknown): void }>
function live(path: string, signal?: AbortSignal | null) {
  let controller!: ReadableStreamDefaultController
  const tracker = { path, aborted: false, push: (value: unknown) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`)) }
  const body = new ReadableStream({ start(value) { controller = value } })
  signal?.addEventListener('abort', () => { tracker.aborted = true; try { controller.error(new DOMException('Aborted', 'AbortError')) } catch {} })
  streams.push(tracker)
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
}
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() {} })) })
})
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  streams = []; fetcher = vi.fn((path: string, init: RequestInit = {}) => Promise.resolve(path.startsWith('/api/admin/logs/live?') ? live(path, init.signal) : json(history())))
  vi.stubGlobal('fetch', fetcher)
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:private-log-download') })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('administrator log console with real Semi controls', () => {
  it('loads real history and appends deduplicated live records as safe text', async () => {
    render(<AdminLogsPage user={admin} />)
    await screen.findByText('安全运行事件 1')
    await screen.findByText(/实时连接正常/)
    const unsafe = '<img src=x onerror=alert(1)> 日志内容'
    await act(async () => streams[0].push({ type: 'logs', logs: [entry(2, unsafe), entry(2, unsafe)], cursor: 2 }))
    expect(screen.getAllByText(unsafe)).toHaveLength(1)
    expect(document.querySelector('script,[onerror]')).toBeNull()
    fireEvent.click(screen.getByText(unsafe).closest('summary')!)
    expect(within(screen.getByText(unsafe).closest('details')!).getByText(/"attempt": 1/)).toBeTruthy()
    expect(streams[0].path).toContain('after=1')
  })

  it('stops receiving on pause and resumes from the last consumed cursor to fill the gap', async () => {
    render(<AdminLogsPage user={admin} />)
    await screen.findByText(/实时连接正常/)
    await act(async () => streams[0].push({ type: 'logs', logs: [entry(2)], cursor: 2 }))
    fireEvent.click(screen.getByRole('button', { name: '暂停接收' }))
    expect(streams[0].aborted).toBe(true)
    expect(screen.getByText(/已暂停接收/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '继续接收' }))
    await waitFor(() => expect(streams).toHaveLength(2))
    expect(new URL(streams[1].path, 'http://localhost').searchParams.get('after')).toBe('2')
    await act(async () => streams[1].push({ type: 'logs', logs: [entry(3), entry(4), entry(5)], cursor: 5 }))
    for (const id of [3,4,5]) expect(screen.getByText(`安全运行事件 ${id}`)).toBeTruthy()
    expect(fetcher.mock.calls.filter(([path]) => !path.includes('/live?'))).toHaveLength(1)
  })

  it('ignores a late history response from the previous filter', async () => {
    let release!: (value: Response) => void
    fetcher.mockImplementation((path: string, init: RequestInit = {}) => path.startsWith('/api/admin/logs/live?') ? Promise.resolve(live(path, init.signal)) : path.includes('q=new-filter') ? Promise.resolve(json(history([entry(9, '新筛选范围记录')]))) : new Promise<Response>(resolve => { release = resolve }))
    render(<AdminLogsPage user={admin} />)
    await waitFor(() => expect(release).toBeTypeOf('function'))
    fireEvent.change(screen.getByLabelText('关键词'), { target: { value: 'new-filter' } })
    fireEvent.click(screen.getByRole('button', { name: '应用筛选' }))
    await screen.findByText('新筛选范围记录')
    await act(async () => release(json(history([entry(1, '旧筛选私有记录不可复现')]))))
    expect(screen.queryByText('旧筛选私有记录不可复现')).toBeNull()
    expect(screen.getByText('新筛选范围记录')).toBeTruthy()
    expect(streams[0].path).toContain('q=new-filter')
  })

  it('clears records and aborts live requests when identity or role changes', async () => {
    const view = render(<AdminLogsPage user={admin} />)
    await screen.findByText(/实时连接正常/)
    expect(screen.getByText('安全运行事件 1')).toBeTruthy()
    view.rerender(<AdminLogsPage user={employee} />)
    expect(screen.queryByText('安全运行事件 1')).toBeNull()
    expect(screen.getByText('仅管理员可查看系统日志。')).toBeTruthy()
    expect(streams[0].aborted).toBe(true)
    expect(screen.queryByRole('button', { name: '导出脱敏日志' })).toBeNull()
  })

  it('refuses employee access without making any request', () => {
    render(<AdminLogsPage user={employee} />)
    expect(screen.getByText('仅管理员可查看系统日志。')).toBeTruthy()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('immediately clears private records on an SSE permission-expired frame', async () => {
    render(<AdminLogsPage user={admin} />)
    await screen.findByText(/实时连接正常/)
    await act(async () => streams[0].push({ type: 'auth_expired', message: '管理员权限已变更。' }))
    expect(screen.queryByText('安全运行事件 1')).toBeNull()
    expect(screen.getByText('管理员权限已变更。')).toBeTruthy()
    expect(streams[0].aborted).toBe(true)
  })

  it('applies level/source/keyword and explicit Beijing dates to the same history and stream filters', async () => {
    render(<AdminLogsPage user={admin} />)
    await screen.findByText(/实时连接正常/)
    fireEvent.click(screen.getByRole('combobox', { name: '日志级别' }))
    fireEvent.click(await screen.findByRole('option', { name: /ERROR/ }))
    await waitFor(() => expect(screen.getByRole('combobox', { name: '日志级别' }).textContent).toContain('ERROR'))
    fireEvent.click(screen.getByRole('combobox', { name: '日志来源' }))
    fireEvent.click(await screen.findByRole('option', { name: /tasks/ }))
    await waitFor(() => expect(screen.getByRole('combobox', { name: '日志来源' }).textContent).toContain('tasks'))
    fireEvent.change(screen.getByLabelText('关键词'), { target: { value: 'timeout' } })
    fireEvent.change(screen.getByLabelText('开始时间（北京时间）'), { target: { value: '2026-10-29T09:00' } })
    fireEvent.change(screen.getByLabelText('结束时间（北京时间）'), { target: { value: '2026-10-29T10:00' } })
    fireEvent.click(screen.getByRole('button', { name: '应用筛选' }))
    await waitFor(() => expect(streams).toHaveLength(2))
    const params = new URL(streams[1].path, 'http://localhost').searchParams
    expect(Object.fromEntries(['level','source','q','from','to'].map(name => [name,params.get(name)]))).toEqual({ level: 'ERROR', source: 'tasks', q: 'timeout', from: '2026-10-29T01:00:00.000Z', to: '2026-10-29T02:00:00.000Z' })
    expect(streams[0].aborted).toBe(true)
  })

  it('loads earlier records with the correct before cursor while preserving current results', async () => {
    fetcher.mockImplementation((path: string, init: RequestInit = {}) => Promise.resolve(path.includes('/live?') ? live(path, init.signal) : path.includes('before=201') ? json(history([entry(200, '更早运行记录')])) : json(history([entry(201, '最近运行记录')], { nextBefore: 201, hasMore: true }))))
    render(<AdminLogsPage user={admin} />)
    await screen.findByText('最近运行记录')
    fireEvent.click(screen.getByRole('button', { name: '加载更早日志' }))
    await screen.findByText('更早运行记录')
    expect(screen.getByText('最近运行记录')).toBeTruthy()
    expect(screen.getByRole('button', { name: '已加载当前范围历史' })).toBeTruthy()
    expect(fetcher.mock.calls.some(([path]) => path.includes('before=201'))).toBe(true)
  })

  it('exports only through the protected filtered endpoint and reports a truncated export', async () => {
    const initial = fetcher.getMockImplementation()!
    fetcher.mockImplementation((path: string, init: RequestInit) => path.startsWith('/api/admin/logs/export?') ? Promise.resolve(new Response('脱敏系统日志', { headers: { 'Content-Type': 'text/plain', 'X-Log-Export-Truncated': 'true', 'X-Log-Export-Count': '5000' } })) : initial(path, init))
    render(<AdminLogsPage user={admin} />)
    await screen.findByText(/实时连接正常/)
    fireEvent.click(screen.getByRole('button', { name: '导出脱敏日志' }))
    await screen.findByText(/已导出脱敏日志 5000 条.*文件已截断/)
    expect(fetcher.mock.calls.some(([path]) => path.startsWith('/api/admin/logs/export?') && path.includes('format=txt'))).toBe(true)
    expect(URL.createObjectURL).toHaveBeenCalledOnce()
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce()
  })

  it('treats a protected export 403 as lost access and never creates a download', async () => {
    const initial = fetcher.getMockImplementation()!
    fetcher.mockImplementation((path: string, init: RequestInit) => path.includes('/export?') ? Promise.resolve(json({ error: '管理员权限已撤销' }, 403)) : initial(path, init))
    render(<AdminLogsPage user={admin} />)
    await screen.findByText(/实时连接正常/)
    fireEvent.click(screen.getByRole('button', { name: '导出脱敏日志' }))
    await screen.findByText('管理员权限已失效，日志内容已清除。')
    expect(screen.queryByText('安全运行事件 1')).toBeNull()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(streams[0].aborted).toBe(true)
  })

  it('bounds the visible window to 2000 records while retaining the latest live result', async () => {
    fetcher.mockImplementation((path: string, init: RequestInit = {}) => Promise.resolve(path.includes('/live?') ? live(path, init.signal) : json(history(Array.from({ length: 2000 }, (_, index) => entry(index + 1))))))
    render(<AdminLogsPage user={admin} />)
    await screen.findByText(/实时连接正常/)
    await act(async () => streams[0].push({ type: 'logs', logs: [entry(2001, '最后一条实时事件')], cursor: 2001 }))
    const region = screen.getByRole('region', { name: '脱敏日志内容' })
    expect(within(region).getAllByRole('listitem')).toHaveLength(2000)
    expect(screen.queryByText('安全运行事件 1')).toBeNull()
    expect(screen.getByText('最后一条实时事件')).toBeTruthy()
  }, 20000)

  it('stops automatic following when an administrator scrolls upward and resumes on explicit latest', async () => {
    render(<AdminLogsPage user={admin} />)
    await screen.findByText(/实时连接正常/)
    const region = screen.getByRole('region', { name: '脱敏日志内容' })
    Object.defineProperties(region, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 200 }, scrollTop: { configurable: true, writable: true, value: 100 } })
    fireEvent.scroll(region)
    expect((screen.getByRole('checkbox', { name: '自动滚动' }) as HTMLInputElement).checked).toBe(false)
    await act(async () => streams[0].push({ type: 'logs', logs: [entry(2)], cursor: 2 }))
    expect(region.scrollTop).toBe(100)
    fireEvent.click(screen.getByRole('button', { name: '回到最新' }))
    expect(region.scrollTop).toBe(1000)
    expect((screen.getByRole('checkbox', { name: '自动滚动' }) as HTMLInputElement).checked).toBe(true)
  })

  it('announces a retention gap and continues with retained logs without claiming a complete replay', async () => {
    render(<AdminLogsPage user={admin} />)
    await screen.findByText(/实时连接正常/)
    await act(async () => { streams[0].push({ type: 'gap', oldestId: 20, message: '部分旧日志已超过保留期，无法完整补回。' }); streams[0].push({ type: 'logs', logs: [entry(20, '保留期内的后续事件')], cursor: 20 }) })
    expect(screen.getByText('部分旧日志已超过保留期，无法完整补回。')).toBeTruthy()
    expect(screen.getByText('保留期内的后续事件')).toBeTruthy()
  })

  it('automatically retries an initial history failure with a fresh guarded request', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const normal = fetcher.getMockImplementation()!
    fetcher.mockRejectedValueOnce(new Error('首次日志网络暂时不可用')).mockImplementation(normal)
    await act(async () => { render(<AdminLogsPage user={admin} />) })
    expect(screen.getByText('首次日志网络暂时不可用')).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(screen.getByText('安全运行事件 1')).toBeTruthy()
    expect(streams).toHaveLength(1)
  })

  it('rejects an unexpected export content type and an oversized declared body before downloading', async () => {
    let large = false
    const normal = fetcher.getMockImplementation()!
    fetcher.mockImplementation((path: string, init: RequestInit) => path.includes('/export?') ? Promise.resolve(new Response('{}', { headers: large ? { 'Content-Type': 'text/plain', 'Content-Length': String(51 * 1024 * 1024) } : { 'Content-Type': 'application/json' } })) : normal(path, init))
    render(<AdminLogsPage user={admin} />)
    await screen.findByText(/实时连接正常/)
    fireEvent.click(screen.getByRole('button', { name: '导出脱敏日志' }))
    await screen.findByText('日志导出格式异常，请稍后重试。')
    large = true
    fireEvent.click(screen.getByRole('button', { name: '导出脱敏日志' }))
    await screen.findByText('日志导出超过 50 MB，请缩小筛选范围后重试。')
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })
})
