// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import AdministrationPage from '../src/pages/AdministrationPage'

vi.mock('lottie-web', () => ({ default: { loadAnimation: vi.fn(() => ({ destroy: vi.fn(), play: vi.fn(), pause: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() })) } }))
const admin = { id: 'admin', username: 'admin', displayName: '管理员', role: 'admin' }
const groups = [{ id: 'a', title: 'A 智能体' }, { id: 'b', title: 'B 智能体' }]
const message = (id: string, text: string, day: number) => ({ id, role: 'user', authorName: '同事', content: text, timestamp: `2026-10-${String(day).padStart(2, '0')}T00:00:00Z` })
const recent = message('recent', '最新讨论', 29), historical = message('branch', '已持久化的历史分支消息', 20)
const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })
let fetcher: ReturnType<typeof vi.fn>, loadPage: (path: string, init: RequestInit) => Promise<Response>
beforeAll(() => { Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() {} })) }) })
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  loadPage = async () => json({ messages: [message('old', '较早讨论', 10)], total: 3, hasMore: false, nextBefore: null })
  fetcher = vi.fn((path: string, init: RequestInit) => {
    if (path === '/api/admin/users') return Promise.resolve(json({ users: [admin] }))
    if (path.startsWith('/api/admin/sessions?')) return Promise.resolve(json({ sessions: groups, total: 2 }))
    if (path.includes('/discussion?')) return loadPage(path, init)
    if (path === '/api/admin/sessions/a') return Promise.resolve(json({ session: groups[0], messages: [recent, historical], discussionPage: { total: 3, hasMore: true, nextBefore: 100 } }))
    if (path === '/api/admin/sessions/b') return Promise.resolve(json({ session: groups[1], messages: [message('b-recent', 'B 群记录', 28)], discussionPage: { total: 1, hasMore: false, nextBefore: null } }))
    throw new Error(`Unexpected ${path}`)
  })
  vi.stubGlobal('fetch', fetcher)
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function openA() { const view = render(<AdministrationPage view="audit" user={admin} />); fireEvent.click(await screen.findByRole('button', { name: /A 智能体/ })); await screen.findByText('最新讨论'); return view }

describe('administrator discussion pagination', () => {
  it('uses decreasing cursors, deduplicates by id, orders timestamps and retains raw branch messages', async () => {
    loadPage = async path => path.includes('before=100') ? json({ messages: [recent, message('middle', '更早一页', 15)], total: 3, hasMore: true, nextBefore: 50 }) : json({ messages: [message('oldest', '最早一页', 1)], total: 3, hasMore: false, nextBefore: null })
    await openA()
    const transcript = screen.getByLabelText('对话审计记录')
    Object.defineProperty(transcript, 'scrollHeight', { configurable: true, get() { return transcript.querySelectorAll('article').length * 100 } })
    transcript.scrollTop = 40
    fireEvent.click(screen.getByRole('button', { name: '加载更早讨论' }))
    await screen.findByText('更早一页')
    expect(transcript.scrollTop).toBe(140)
    expect(screen.getAllByText('最新讨论')).toHaveLength(1)
    expect([...transcript.querySelectorAll('.ra-message-content')].map(node => node.textContent)).toEqual(['更早一页', '已持久化的历史分支消息', '最新讨论'])
    fireEvent.click(screen.getByRole('button', { name: '加载更早讨论' }))
    await screen.findByText('最早一页')
    expect(screen.queryByRole('button', { name: '加载更早讨论' })).toBeNull()
    expect(fetcher.mock.calls.filter(([path]) => path.includes('/discussion?')).map(([path]) => path)).toEqual(['/api/admin/sessions/a/discussion?before=100&limit=200', '/api/admin/sessions/a/discussion?before=50&limit=200'])
    expect(screen.getByText('已持久化的历史分支消息')).toBeTruthy()
  })

  it('aborts older-page requests on group switch and ignores late previous-group content', async () => {
    let release!: (value: Response) => void
    loadPage = () => new Promise<Response>(resolve => { release = resolve })
    await openA(); fireEvent.click(screen.getByRole('button', { name: '加载更早讨论' }))
    await waitFor(() => expect(release).toBeTypeOf('function'))
    const signal = fetcher.mock.calls.at(-1)![1].signal
    fireEvent.click(screen.getByRole('button', { name: /B 智能体/ }))
    expect(signal.aborted).toBe(true)
    await screen.findByText('B 群记录')
    await act(async () => release(json({ messages: [message('stale', '旧群晚返回内容', 1)], total: 3, hasMore: true, nextBefore: 50 })))
    expect(screen.queryByText('旧群晚返回内容')).toBeNull()
    expect(screen.queryByText('最新讨论')).toBeNull()
    expect(screen.queryByRole('button', { name: '加载更早讨论' })).toBeNull()
  })

  it('clears the selection and cursor as soon as a filter changes, before submitting it', async () => {
    let release!: (value: Response) => void
    loadPage = () => new Promise<Response>(resolve => { release = resolve })
    await openA(); fireEvent.click(screen.getByRole('button', { name: '加载更早讨论' }))
    await waitFor(() => expect(release).toBeTypeOf('function'))
    const signal = fetcher.mock.calls.at(-1)![1].signal
    fireEvent.change(screen.getByLabelText('审计关键词'), { target: { value: '新条件' } })
    expect(signal.aborted).toBe(true)
    expect(screen.queryByText('最新讨论')).toBeNull()
    expect(screen.queryByRole('button', { name: '加载更早讨论' })).toBeNull()
    await act(async () => release(json({ messages: [message('stale', '旧筛选晚返回内容', 1)], total: 3, hasMore: true, nextBefore: 50 })))
    expect(screen.queryByText('旧筛选晚返回内容')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '查询' }))
    await waitFor(() => expect(fetcher.mock.calls.some(([path]) => path.includes('q=%E6%96%B0%E6%9D%A1%E4%BB%B6'))).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: /A 智能体/ })); await screen.findByText('最新讨论')
    expect(fetcher.mock.calls.filter(([path]) => path === '/api/admin/sessions/a')).toHaveLength(2)
  })

  it('aborts pagination when the administrator identity changes and refuses employee access', async () => {
    let release!: (value: Response) => void
    loadPage = () => new Promise<Response>(resolve => { release = resolve })
    const view = await openA(); fireEvent.click(screen.getByRole('button', { name: '加载更早讨论' }))
    await waitFor(() => expect(release).toBeTypeOf('function'))
    const signal = fetcher.mock.calls.at(-1)![1].signal
    view.rerender(<AdministrationPage view="audit" user={{ ...admin, id: 'other-admin' }} />)
    expect(signal.aborted).toBe(true)
    expect(screen.queryByText('最新讨论')).toBeNull()
    await act(async () => release(json({ messages: [message('stale', '旧管理员晚响应', 1)], total: 3, hasMore: false, nextBefore: null })))
    expect(screen.queryByText('旧管理员晚响应')).toBeNull()
    view.rerender(<AdministrationPage view="audit" user={{ ...admin, role: 'member' }} />)
    expect(screen.getByText('此页面仅限管理员访问。')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '加载更早讨论' })).toBeNull()
  })

  it('retains the current page after a failed or non-advancing cursor response so it can be retried', async () => {
    let count = 0
    loadPage = async () => ++count === 1 ? json({ messages: [message('bad', '错误分页不可显示', 1)], total: 3, hasMore: true, nextBefore: 100 }) : json({ messages: [message('valid', '重试成功的较早记录', 1)], total: 3, hasMore: false, nextBefore: null })
    await openA(); fireEvent.click(screen.getByRole('button', { name: '加载更早讨论' }))
    await screen.findByText('讨论分页游标未前进，请刷新会话后重试。')
    expect(screen.queryByText('错误分页不可显示')).toBeNull()
    expect(screen.getByText('最新讨论')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '加载更早讨论' }))
    await screen.findByText('重试成功的较早记录')
    expect(count).toBe(2)
  })
})
