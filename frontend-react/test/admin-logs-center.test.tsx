// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import AdminLogsCenter from '../src/pages/AdminLogsCenter'

vi.mock('lottie-web', () => ({ default: { loadAnimation: vi.fn(() => ({ destroy: vi.fn(), play: vi.fn(), pause: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() })) } }))
const admin = { id: 'admin', username: 'admin', displayName: '管理员', role: 'admin' }
const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })
let fetcher: ReturnType<typeof vi.fn>, runtimeSignals: AbortSignal[]
beforeAll(() => { Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() {} })) }) })
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  runtimeSignals = []
  fetcher = vi.fn((path: string, init: RequestInit) => {
    if (path.startsWith('/api/admin/logs/live?')) {
      runtimeSignals.push(init.signal!)
      return Promise.resolve(new Response(new ReadableStream({ start(controller) { init.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError'))) } }), { headers: { 'Content-Type': 'text/event-stream' } }))
    }
    if (path.startsWith('/api/admin/logs?')) return Promise.resolve(json({ logs: [], cursor: 0, nextBefore: null, hasMore: false, sources: [] }))
    if (path === '/api/admin/users') return Promise.resolve(json({ users: [admin] }))
    if (path.startsWith('/api/admin/sessions?')) return Promise.resolve(json({ sessions: [{ id: 'unjoined-group', title: '管理员未加入的智能体', messageCount: 2 }], total: 1 }))
    if (path === '/api/admin/sessions/unjoined-group') return Promise.resolve(json({ session: { id: 'unjoined-group', title: '管理员未加入的智能体' }, messages: [{ id: 'msg', role: 'user', content: '所有对话验收记录', authorName: '另一群员工' }] }))
    throw new Error(`Unexpected ${path}`)
  })
  vi.stubGlobal('fetch', fetcher)
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('administrator log center with real Semi tabs', () => {
  it('switches from runtime logs to all conversations without membership filtering and aborts inactive views', async () => {
    render(<AdminLogsCenter user={admin} />)
    await screen.findByText(/实时连接正常/)
    fireEvent.click(screen.getByRole('tab', { name: '所有对话' }))
    expect(runtimeSignals[0].aborted).toBe(true)
    fireEvent.click(await screen.findByRole('button', { name: /管理员未加入的智能体/ }))
    expect(await screen.findByText('所有对话验收记录')).toBeTruthy()
    expect(screen.getByText(/群内讨论可分页加载更早记录/)).toBeTruthy()
    const detail = fetcher.mock.calls.find(([path]) => path === '/api/admin/sessions/unjoined-group')!
    fireEvent.click(screen.getByRole('tab', { name: '运行日志' }))
    expect(detail[1].signal.aborted).toBe(true)
    expect(screen.queryByText('所有对话验收记录')).toBeNull()
    expect(fetcher.mock.calls.some(([path]) => path.startsWith('/api/sessions/'))).toBe(false)
  })

  it('unmounts private conversations on identity change, role loss and auth expiry', async () => {
    const view = render(<AdminLogsCenter user={admin} />)
    fireEvent.click(screen.getByRole('tab', { name: '所有对话' }))
    let release!: (value: Response) => void
    fetcher.mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve }))
    fireEvent.click(await screen.findByRole('button', { name: /管理员未加入的智能体/ }))
    await waitFor(() => expect(release).toBeTypeOf('function'))
    const previousSignal = fetcher.mock.calls.at(-1)![1].signal
    view.rerender(<AdminLogsCenter user={{ ...admin, id: 'new-admin' }} />)
    expect(previousSignal.aborted).toBe(true)
    await act(async () => release(json({ session: { id: 'unjoined-group', title: '旧记录' }, messages: [{ content: '晚响应旧管理员私有内容' }] })))
    expect(screen.queryByText('晚响应旧管理员私有内容')).toBeNull()
    act(() => window.dispatchEvent(new Event('pi:auth-expired')))
    expect(screen.getByText(/登录已失效，日志内容已清除/)).toBeTruthy()
    view.rerender(<AdminLogsCenter user={{ ...admin, role: 'member' }} />)
    expect(screen.getByText('仅管理员可查看日志与所有对话。')).toBeTruthy()
    const count = fetcher.mock.calls.length
    view.rerender(<AdminLogsCenter user={{ ...admin, role: 'member' }} />)
    expect(fetcher).toHaveBeenCalledTimes(count)
  })
})
