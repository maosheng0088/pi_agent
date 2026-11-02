// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { api, ApiError } from '../src/lib/api'
import AgentWorkbench from '../src/components/AgentWorkbench'

vi.mock('../src/lib/api', async original => ({ ...await original<typeof import('../src/lib/api')>(), api: vi.fn() }))
vi.mock('lottie-web', () => ({ default: { loadAnimation: vi.fn(() => ({ destroy: vi.fn(), play: vi.fn(), pause: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() })) } }))
const mockedApi = vi.mocked(api)
const admin = { id: 'admin', username: 'qa-admin', displayName: '管理员', role: 'admin' }
const member = { id: 'member', username: 'qa-member', displayName: '员工', role: 'member' }
const task = { id: 'task-deep', sessionId: 'alpha', title: '旧任务精确详情', instruction: '不在最近任务列表中的工作要求', status: 'succeeded', createdBy: member.id, result: '此任务的真实交付结果', events: [] }
const currentDocument = { id: 'doc-deep', groupId: 'alpha', title: '当前业务规范', sourceName: 'current.md', version: 4, updatedAt: '2026-10-29T02:00:00Z', content: '当前版本的实际正文。' }
const source = { documentId: 'doc-deep', title: '引用时的旧业务规范', sourceName: 'old.md', version: 2, updatedAt: '2026-10-28T02:00:00Z', excerpt: '引用时保存的片段 <script>window.privateLeak=true</script>', citation: '知识来源：旧业务规范', cited: true }
type Props = Partial<React.ComponentProps<typeof AgentWorkbench>>
function view(props: Props = {}) { return render(<AgentWorkbench sessionId="alpha" user={member} members={[admin, member]} onClose={vi.fn()} {...props} />) }
function deferred<T = any>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function base(path: string): any {
  if (path.endsWith('/profile')) return { profile: { roleName: '群内岗位' } }
  if (path.endsWith('/tasks')) return { tasks: [] }
  if (path.includes('/knowledge?')) return { documents: [], matches: [] }
  throw new Error(`Unexpected deep-link fixture ${path}`)
}
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true } })) })
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  Element.prototype.scrollIntoView = vi.fn()
})
beforeEach(() => { mockedApi.mockReset(); mockedApi.mockImplementation(async path => base(path)) })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllTimers() })

describe('AgentWorkbench exact resource deep links with real Semi', () => {
  it('loads the exact task even when it is absent from the first task page', async () => {
    mockedApi.mockImplementation(async path => path === '/api/sessions/alpha/tasks/task-deep' ? { task } : base(path))
    view({ initialTaskId: task.id })
    const detail = await screen.findByRole('region', { name: '业务任务详情' })
    expect(await within(detail).findByRole('heading', { name: task.title })).toBeTruthy()
    expect(within(detail).getByText(task.result)).toBeTruthy()
    expect(mockedApi).toHaveBeenCalledWith('/api/sessions/alpha/tasks/task-deep', expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(screen.getByText('暂无业务任务，可创建任务或在群内请 AI 处理工作。')).toBeTruthy()
    expect(mockedApi.mock.calls.some(([, options]) => options?.method && options.method !== 'GET')).toBe(false)
  })

  it('switches exact task targets in the same group without accepting an older response', async () => {
    const old = deferred()
    mockedApi.mockImplementation(async path => path.endsWith('/tasks/task-old') ? old.promise : path.endsWith('/tasks/task-new') ? { task: { ...task, id: 'task-new', title: '新选中的任务', result: '当前任务结果' } } : base(path))
    const page = view({ initialTaskId: 'task-old' })
    await waitFor(() => expect(mockedApi.mock.calls.some(([path]) => path.endsWith('/tasks/task-old'))).toBe(true))
    page.rerender(<AgentWorkbench sessionId="alpha" user={member} members={[member]} initialTaskId="task-new" onClose={vi.fn()} />)
    await screen.findByText('当前任务结果')
    await act(async () => old.resolve({ task: { ...task, id: 'task-old', result: '迟到旧任务的私有结果' } }))
    expect(screen.queryByText('迟到旧任务的私有结果')).toBeNull()
    expect(screen.getByText('当前任务结果')).toBeTruthy()
  })

  it('ignores a slow task denial after changing groups and does not lock the new group', async () => {
    const old = deferred()
    mockedApi.mockImplementation(async path => path === '/api/sessions/alpha/tasks/task-old' ? old.promise : path === '/api/sessions/beta/tasks/task-new' ? { task: { ...task, sessionId: 'beta', id: 'task-new', result: 'B 群结果' } } : base(path))
    const page = view({ initialTaskId: 'task-old' })
    await waitFor(() => expect(mockedApi.mock.calls.some(([path]) => path.endsWith('/tasks/task-old'))).toBe(true))
    page.rerender(<AgentWorkbench sessionId="beta" user={member} members={[member]} initialTaskId="task-new" onClose={vi.fn()} />)
    await screen.findByText('B 群结果')
    await act(async () => old.reject(new ApiError('A 群已失去权限', 403)))
    expect(screen.getByText('B 群结果')).toBeTruthy()
    expect(screen.queryByText(/工作台内容已清除/)).toBeNull()
  })

  it.each([401, 403, 404])('clears private task state when the requested task returns %s', async status => {
    mockedApi.mockImplementation(async path => path.endsWith('/tasks/task-deep') ? Promise.reject(new ApiError('Denied', status)) : path.endsWith('/tasks') ? { tasks: [{ ...task, title: '不可继续显示的群任务' }] } : base(path))
    view({ initialTaskId: task.id })
    await screen.findByText(/工作台内容已清除/, { selector: 'span[role="alert"]' })
    expect(screen.queryByText('不可继续显示的群任务')).toBeNull()
    expect(screen.queryByText(task.result)).toBeNull()
    expect(screen.queryByRole('tab')).toBeNull()
  })

  it('rejects a detail payload belonging to another group before rendering its content', async () => {
    mockedApi.mockImplementation(async path => path.endsWith('/tasks/task-deep') ? { task: { ...task, sessionId: 'private-group', result: '别群私有任务结果' } } : base(path))
    view({ initialTaskId: task.id })
    await screen.findByText('此任务已被删除或你已无权访问，工作台内容已清除。请关闭后重新进入。')
    expect(screen.queryByText('别群私有任务结果')).toBeNull()
  })

  it('shows direct legacy knowledge links as current content with explicit version mismatch', async () => {
    mockedApi.mockImplementation(async path => path.endsWith('/knowledge/doc-deep') ? { document: currentDocument } : base(path))
    view({ initialDocumentId: 'doc-deep', initialSourceVersion: 2, initialSourceUpdatedAt: source.updatedAt })
    expect(await screen.findByText(currentDocument.content)).toBeTruthy()
    expect(screen.getByText(/引用与当前资料版本不同/)).toBeTruthy()
    expect(screen.getByText(/当前正文不是引用时的历史正文/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '编辑资料' })).toBeNull()
    expect(screen.queryByRole('button', { name: '删除资料' })).toBeNull()
  })

  it('explains a missing direct-link document instead of showing stale or fabricated knowledge', async () => {
    mockedApi.mockImplementation(async path => path.endsWith('/knowledge/doc-deep') ? Promise.reject(new ApiError('Deleted', 404)) : base(path))
    view({ initialDocumentId: 'doc-deep', initialSourceVersion: 2 })
    await screen.findByText('引用的资料已被删除或你已无权访问，工作台内容已清除。请关闭后重新进入。')
    expect(screen.queryByText(currentDocument.content)).toBeNull()
  })

  it('uses the card source endpoint and distinguishes historical excerpt from updated current content', async () => {
    mockedApi.mockImplementation(async path => path === '/api/sessions/alpha/message-cards/card-a/sources/doc-deep' ? { source, current: currentDocument, state: 'updated' } : base(path))
    view({ initialTab: 'knowledge', initialDocumentId: 'doc-deep', initialSourceCardId: 'card-a', initialSourceVersion: 2 })
    expect(await screen.findByText(source.excerpt)).toBeTruthy()
    expect(screen.getByText(currentDocument.content)).toBeTruthy()
    expect(screen.getByText('引用片段（非完整正文）')).toBeTruthy()
    expect(screen.getByText('当前资料正文')).toBeTruthy()
    expect(screen.getByText(/当前版本不是当时的历史正文/)).toBeTruthy()
    expect(document.querySelector('script')).toBeNull()
    expect(mockedApi.mock.calls.some(([path]) => path === '/api/sessions/alpha/knowledge/doc-deep')).toBe(false)
  })

  it('retains a saved citation excerpt when the underlying document was deleted', async () => {
    mockedApi.mockImplementation(async path => path.includes('/message-cards/card-a/sources/doc-deep') ? { source, current: null, state: 'deleted' } : base(path))
    view({ user: admin, initialDocumentId: 'doc-deep', initialSourceCardId: 'card-a' })
    expect(await screen.findByText(source.excerpt)).toBeTruthy()
    expect(screen.getByText(/此资料当前已被删除/)).toBeTruthy()
    expect(screen.getByText(/不是历史版本的完整正文/)).toBeTruthy()
    expect(screen.queryByText(currentDocument.content)).toBeNull()
    expect(screen.queryByRole('button', { name: '编辑资料' })).toBeNull()
    expect(screen.queryByRole('button', { name: '删除资料' })).toBeNull()
  })

  it('clears a previously visible source when the next card reference is forbidden', async () => {
    mockedApi.mockImplementation(async path => path.includes('/message-cards/card-a/sources/') ? { source, current: currentDocument, state: 'updated' } : path.includes('/message-cards/card-denied/sources/') ? Promise.reject(new ApiError('Not a member', 403)) : base(path))
    const page = view({ initialDocumentId: 'doc-deep', initialSourceCardId: 'card-a' })
    await screen.findByText(source.excerpt)
    page.rerender(<AgentWorkbench sessionId="alpha" user={member} members={[member]} initialDocumentId="doc-deep" initialSourceCardId="card-denied" onClose={vi.fn()} />)
    await screen.findByText(/工作台内容已清除/, { selector: 'span[role="alert"]' })
    expect(screen.queryByText(source.excerpt)).toBeNull()
    expect(screen.queryByText(currentDocument.content)).toBeNull()
  })

  it('ignores an old source review after switching to another document reference', async () => {
    const old = deferred()
    mockedApi.mockImplementation(async path => path.includes('/sources/doc-old') ? old.promise : path.includes('/sources/doc-new') ? { source: { ...source, documentId: 'doc-new', excerpt: '当前引用片段' }, current: { ...currentDocument, id: 'doc-new', content: '当前文档正文' }, state: 'updated' } : base(path))
    const page = view({ initialDocumentId: 'doc-old', initialSourceCardId: 'card-old' })
    await waitFor(() => expect(mockedApi.mock.calls.some(([path]) => path.includes('/sources/doc-old'))).toBe(true))
    page.rerender(<AgentWorkbench sessionId="alpha" user={member} members={[member]} initialDocumentId="doc-new" initialSourceCardId="card-new" onClose={vi.fn()} />)
    await screen.findByText('当前文档正文')
    await act(async () => old.resolve({ source: { ...source, documentId: 'doc-old', excerpt: '迟到旧引用片段' }, current: { ...currentDocument, id: 'doc-old', content: '迟到旧文档正文' }, state: 'updated' }))
    expect(screen.queryByText('迟到旧引用片段')).toBeNull(); expect(screen.queryByText('迟到旧文档正文')).toBeNull()
  })

  it('does not restore a closed workbench from a late source response', async () => {
    const old = deferred()
    mockedApi.mockImplementation(async path => path.includes('/sources/doc-deep') ? old.promise : base(path))
    const page = view({ initialDocumentId: 'doc-deep', initialSourceCardId: 'card-a' })
    await waitFor(() => expect(mockedApi.mock.calls.some(([path]) => path.includes('/sources/doc-deep'))).toBe(true))
    page.unmount()
    await act(async () => old.resolve({ source, current: currentDocument, state: 'updated' }))
    expect(screen.queryByText(source.excerpt)).toBeNull(); expect(screen.queryByText(currentDocument.content)).toBeNull()
  })

  it('can retry a transient exact-task failure without selecting an unrelated list item', async () => {
    let attempts = 0
    mockedApi.mockImplementation(async path => {
      if (path.endsWith('/tasks/task-deep')) { if (++attempts === 1) throw new Error('Fixture connection interrupted'); return { task } }
      return base(path)
    })
    view({ initialTaskId: task.id })
    await screen.findByText('Fixture connection interrupted')
    fireEvent.click(screen.getByRole('button', { name: '刷新任务' }))
    expect(await screen.findByText(task.result)).toBeTruthy()
    expect(attempts).toBe(2)
  })
})
