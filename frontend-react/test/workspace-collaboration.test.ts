// @vitest-environment jsdom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError } from '../src/lib/api'
import { WorkspaceStore, workspace } from '../src/lib/workspace'

vi.hoisted(() => {
  globalThis.BroadcastChannel = class { onmessage: unknown = null; postMessage() {} close() {} } as any
})
vi.mock('@douyinfe/semi-ui', () => ({ Toast: { info: vi.fn() } }))
vi.mock('../src/lib/api', async original => ({ ...await original<typeof import('../src/lib/api')>(), api: vi.fn(), advanceApiIdentity: vi.fn() }))
const mockedApi = vi.mocked(api), rawFetch = vi.fn()
const alice = { id: 'alice', username: 'qa-alice', displayName: 'Alice', role: 'member' }
const bob = { id: 'bob', username: 'qa-bob', displayName: 'Bob', role: 'member' }
const groupA = { id: 'group-a', title: '业务 A', revision: 1 }, groupB = { id: 'group-b', title: '业务 B', revision: 1 }
const stores: WorkspaceStore[] = []
let serverMessages: any[]
function deferred<T = any>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function activeStore() {
  const store = new WorkspaceStore(); stores.push(store)
  store.patch({ user: alice, booting: false, online: true, sessions: [groupA, groupB], current: groupA, status: { configured: true },
    messages: [], skills: [{ id: 'skill-a', name: 'Business skill', enabled: true }], selectedSkill: 'skill-a', drafts: { 'group-a': 'Fixture task' } })
  return store
}
function defaultApi(path: string) {
  if (path.startsWith('/api/sessions?')) return { sessions: [groupA, groupB], total: 2 }
  if (path === '/api/status') return { configured: true }
  if (path === '/api/sessions/group-a') return { session: groupA, messages: serverMessages }
  if (path === '/api/sessions/group-b') return { session: groupB, messages: [{ id: 'b-message', role: 'user', content: 'B history' }] }
  if (path.endsWith('/skills')) return { skills: [] }
  throw new Error(`Unexpected fixture API ${path}`)
}
function posted() { return mockedApi.mock.calls.filter(([, options]) => options?.method === 'POST') }
beforeEach(() => {
  mockedApi.mockReset(); rawFetch.mockReset(); vi.stubGlobal('fetch', rawFetch)
  serverMessages = []
  mockedApi.mockImplementation(async (path, options) => options?.method === 'POST' ? { task: { id: 'task-new' } } as any : defaultApi(path) as any)
  Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  history.replaceState(null, '', '/')
})
afterEach(() => { stores.splice(0).forEach(store => store.dispose()); vi.unstubAllGlobals() })
afterAll(() => workspace.dispose())

describe('WorkspaceStore durable collaboration submissions', () => {
  it('accepts attachment-only discussion without a model and submits IDs without trusting client metadata', async () => {
    const store = activeStore(), attachmentId = '11111111-1111-4111-8111-111111111111'; store.patch({ status: { configured: false } })
    expect(await store.collaborate('', { mode: 'discussion', attachmentIds: [attachmentId] })).toBe(true)
    expect(posted()[0]).toEqual(['/api/sessions/group-a/discussion', expect.objectContaining({ method: 'POST', body: { content: '', mentions: [], attachmentIds: [attachmentId], clientRequestId: expect.any(String) } })])
  })

  it('retries ambiguous file submissions with the same request id, while a different selection is a new request', async () => {
    const store = activeStore(), first = '11111111-1111-4111-8111-111111111111', second = '22222222-2222-4222-8222-222222222222'
    mockedApi.mockRejectedValue(new TypeError('Network response lost'))
    expect(await store.collaborate('', { mode: 'agent', attachmentIds: [first] })).toBe(false)
    expect(await store.collaborate('', { mode: 'agent', attachmentIds: [first] })).toBe(false)
    expect(await store.collaborate('', { mode: 'agent', attachmentIds: [second] })).toBe(false)
    const ids = posted().map(([, options]) => (options?.body as any).clientRequestId)
    expect(ids[0]).toBe(ids[1]); expect(ids[2]).not.toBe(ids[0])
  })

  it('rejects duplicate, malformed, or excessive attachment IDs locally', async () => {
    const store = activeStore(), id = '11111111-1111-4111-8111-111111111111'
    for (const attachmentIds of [[id, id], ['../foreign'], Array.from({ length: 11 }, (_, i) => `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`)]) {
      expect(await store.collaborate('Check', { mode: 'agent', attachmentIds })).toBe(false)
    }
    expect(posted()).toHaveLength(0); expect(store.state.chatError).toContain('附件编号无效')
  })

  it('creates an AI work task as JSON with current skill and no legacy SSE request', async () => {
    const store = activeStore()
    expect(await store.collaborate('Fixture task', { mode: 'agent', replyTo: 'reply-a', mentions: ['bob'] })).toBe(true)
    expect(posted()).toHaveLength(1)
    expect(posted()[0]).toEqual(['/api/sessions/group-a/tasks', expect.objectContaining({ method: 'POST', signal: expect.any(AbortSignal), body: {
      instruction: 'Fixture task', skillId: 'skill-a', replyTo: 'reply-a', mentions: ['bob'], clientRequestId: expect.any(String),
    } })])
    expect(rawFetch).not.toHaveBeenCalled()
    expect(store.state.running).toBe(false)
    expect(store.state.drafts['group-a']).toBe('')
    expect(store.state.submitting).toBe(false)
  })

  it('allows discussion without a configured model and omits the selected execution skill', async () => {
    const store = activeStore(); store.patch({ status: { configured: false } })
    expect(await store.collaborate('Ordinary discussion', { mode: 'discussion' })).toBe(true)
    expect(posted()[0]).toEqual(['/api/sessions/group-a/discussion', expect.objectContaining({ method: 'POST', signal: expect.any(AbortSignal), body: {
      content: 'Ordinary discussion', mentions: [], clientRequestId: expect.any(String),
    } })])
  })

  it('uses task creation for an explicit agent mention in discussion and requires a configured model', async () => {
    const store = activeStore()
    expect(await store.collaborate('Please check', { mode: 'discussion', mentions: ['agent', 'bob'] })).toBe(true)
    expect(posted()[0][0]).toBe('/api/sessions/group-a/tasks')
    store.patch({ status: { configured: false } })
    expect(await store.collaborate('@智能体 请检查', { mode: 'discussion' })).toBe(false)
    expect(posted()).toHaveLength(1)
  })

  it('accepts queued work while another member or the legacy session is running', async () => {
    const store = activeStore(); store.patch({ running: true, current: { ...groupA, running: true, activeUserId: bob.id } })
    expect(await store.collaborate('Queue another task', { mode: 'agent' })).toBe(true)
    expect(posted()).toHaveLength(1)
    expect(posted()[0][0]).toBe('/api/sessions/group-a/tasks')
  })

  it('locks repeated clicks until the original request settles', async () => {
    const store = activeStore(), response = deferred()
    mockedApi.mockImplementation(async (path, options) => options?.method === 'POST' ? response.promise : defaultApi(path))
    const first = store.collaborate('Fixture task', { mode: 'agent' })
    expect(store.state.submitting).toBe(true)
    expect(await store.collaborate('Fixture task', { mode: 'agent' })).toBe(false)
    expect(posted()).toHaveLength(1)
    response.resolve({ task: { id: 'task-new' } }); expect(await first).toBe(true)
    expect(store.state.submitting).toBe(false)
  })

  it('reuses clientRequestId after an ambiguous lost response instead of duplicating work', async () => {
    const store = activeStore(); let attempts = 0
    mockedApi.mockImplementation(async (path, options) => {
      if (options?.method === 'POST') { if (++attempts === 1) throw new TypeError('Network response lost'); return { task: { id: 'task-already-created' } } }
      return defaultApi(path)
    })
    expect(await store.collaborate('Fixture task', { mode: 'agent' })).toBe(false)
    expect(store.state.drafts['group-a']).toBe('Fixture task')
    const firstId = (posted()[0][1]?.body as any).clientRequestId
    expect(await store.collaborate('Fixture task', { mode: 'agent' })).toBe(true)
    expect((posted()[1][1]?.body as any).clientRequestId).toBe(firstId)
    await store.collaborate('Different task', { mode: 'agent' })
    expect((posted()[2][1]?.body as any).clientRequestId).not.toBe(firstId)
  })

  it('preserves a draft edited while its earlier text was being accepted', async () => {
    const store = activeStore(), response = deferred()
    mockedApi.mockImplementation(async (path, options) => options?.method === 'POST' ? response.promise : defaultApi(path))
    const submitting = store.collaborate('Fixture task', { mode: 'agent' })
    store.setDraft('group-a', 'New unsent task')
    response.resolve({ task: { id: 'task-new' } }); await submitting
    expect(store.state.drafts['group-a']).toBe('New unsent task')
  })

  it('does not publish a previous account response or clear its new draft', async () => {
    const store = activeStore(), response = deferred()
    mockedApi.mockImplementation(async (path, options) => options?.method === 'POST' ? response.promise : defaultApi(path))
    const submitting = store.collaborate('Fixture task', { mode: 'agent' })
    store.clear(); store.patch({ user: bob, sessions: [groupA], current: groupA, messages: [{ role: 'user', content: 'New account history' }], drafts: { 'group-a': 'Bob draft' } })
    response.resolve({ message: { id: 'old-message', role: 'user', content: 'Alice private response' } }); await submitting
    expect(store.state.user?.id).toBe(bob.id)
    expect(store.state.messages.map(message => message.content)).toEqual(['New account history'])
    expect(store.state.drafts['group-a']).toBe('Bob draft')
    expect(store.state.submitting).toBe(false)
  })

  it('keeps a new group usable and does not apply a prior group response after switching', async () => {
    const store = activeStore(), response = deferred()
    mockedApi.mockImplementation(async (path, options) => options?.method === 'POST' ? response.promise : defaultApi(path))
    const submitting = store.collaborate('Fixture task', { mode: 'agent' })
    await store.select('group-b')
    store.setDraft('group-b', 'B unsent draft')
    expect(store.state.submitting).toBe(false)
    response.resolve({ message: { id: 'old-message', role: 'user', content: 'A response' } }); await submitting
    expect(store.state.current?.id).toBe('group-b')
    expect(store.state.messages.map(message => message.content)).toEqual(['B history'])
    expect(store.state.drafts['group-b']).toBe('B unsent draft')
    expect(store.state.submitting).toBe(false)
  })

  it('treats accepted work as submitted even if authoritative history refresh fails', async () => {
    const store = activeStore()
    mockedApi.mockImplementation(async (path, options) => {
      if (options?.method === 'POST') return { task: { id: 'accepted-task' } }
      if (path === '/api/sessions/group-a') throw new TypeError('History unavailable')
      return defaultApi(path)
    })
    expect(await store.collaborate('Fixture task', { mode: 'agent' })).toBe(true)
    expect(store.state.drafts['group-a']).toBe('')
    expect(store.state.chatError).toContain('消息已提交')
    expect(store.state.chatError).toContain('避免重复提交')
    expect(posted()).toHaveLength(1)
    expect(store.state.submitting).toBe(false)
  })

  it('does not clear a newer selected group when an old group request returns 404', async () => {
    const store = activeStore(), response = deferred()
    mockedApi.mockImplementation(async (path, options) => options?.method === 'POST' ? response.promise : defaultApi(path))
    const submitting = store.collaborate('Fixture task', { mode: 'discussion' })
    await store.select('group-b')
    response.reject(new ApiError('Old group access revoked', 404))
    expect(await submitting).toBe(false)
    expect(store.state.current?.id).toBe('group-b')
    expect(store.state.messages[0].content).toBe('B history')
    expect(store.state.chatError).toBe('')
  })

  it('an accepted discussion does not duplicate its optimistic message after refresh', async () => {
    const store = activeStore(), message = { id: 'discussion-a', role: 'user', content: 'Discuss' }
    serverMessages = [message]
    mockedApi.mockImplementation(async (path, options) => options?.method === 'POST' ? { message } : defaultApi(path))
    await store.collaborate('Discuss', { mode: 'discussion' })
    expect(store.state.messages).toEqual([message])
  })

  it('rejects an unconfirmed success payload and keeps the same retry identity and draft', async () => {
    const store = activeStore(); let attempt = 0
    mockedApi.mockImplementation(async (path, options) => {
      if (options?.method === 'POST') return ++attempt === 1 ? { ok: true } : { task: { id: 'confirmed-task' } }
      return defaultApi(path)
    })
    expect(await store.collaborate('Fixture task', { mode: 'agent' })).toBe(false)
    expect(store.state.drafts['group-a']).toBe('Fixture task')
    expect(store.state.chatError).toContain('服务未确认提交结果')
    expect(store.state.submitting).toBe(false)
    const requestId = (posted()[0][1]?.body as any).clientRequestId
    expect(await store.collaborate('Fixture task', { mode: 'agent' })).toBe(true)
    expect((posted()[1][1]?.body as any).clientRequestId).toBe(requestId)
  })

  it('does not restore an account or private messages when a pre-logout submission finishes', async () => {
    const store = activeStore(), response = deferred()
    mockedApi.mockImplementation(async (path, options) => {
      if (path === '/api/auth/logout') return {}
      if (options?.method === 'POST') return response.promise
      return defaultApi(path)
    })
    const submitting = store.collaborate('Fixture task', { mode: 'discussion' })
    await store.logout()
    expect(store.state.user).toBeNull(); expect(store.state.messages).toEqual([]); expect(store.state.drafts).toEqual({})
    response.resolve({ message: { id: 'old-private-message', role: 'user', content: 'Pre-logout private content' } })
    await submitting
    expect(store.state.user).toBeNull(); expect(store.state.current).toBeNull()
    expect(store.state.messages).toEqual([]); expect(store.state.drafts).toEqual({}); expect(store.state.submitting).toBe(false)
    expect(mockedApi.mock.calls.some(([path]) => path === '/api/sessions/group-a')).toBe(false)
  })
})
