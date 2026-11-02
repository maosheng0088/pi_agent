// @vitest-environment jsdom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitFor } from '@testing-library/react'
import { api, ApiError } from './api'
import { WorkspaceStore, workspace } from './workspace'
import type { Message, Session } from './types'

const channels = vi.hoisted(() => {
  const instances: Array<{ onmessage: ((event: any) => void) | null; postMessage: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = []
  class FakeChannel {
    onmessage: ((event: any) => void) | null = null
    postMessage = vi.fn(); close = vi.fn()
    constructor() { instances.push(this) }
  }
  globalThis.BroadcastChannel = FakeChannel as any
  return instances
})
vi.mock('@douyinfe/semi-ui', () => ({ Toast: { info: vi.fn() } }))
vi.mock('./api', async importOriginal => ({ ...await importOriginal<typeof import('./api')>(), api: vi.fn(), advanceApiIdentity: vi.fn() }))
const mockedApi = vi.mocked(api), mockedFetch = vi.fn()
const userA = { id: 'employee-a', username: 'a', displayName: '员工 A', role: 'member' }
const userB = { id: 'employee-b', username: 'b', displayName: '员工 B', role: 'member' }
const groupA: Session = { id: 'a', title: 'A 业务空间', revision: 1 }, groupB: Session = { id: 'b', title: 'B 业务空间', revision: 1 }
const stores: WorkspaceStore[] = []
let serverMessages: Message[] = []
function deferred<T = any>() { let resolve!: (value: T) => void, reject!: (reason?: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function activeStore() {
  const store = new WorkspaceStore(); stores.push(store)
  store.patch({ booting: false, user: userA, workspace: { name: '公司空间' }, sessions: [groupA, groupB], current: groupA, status: { configured: true }, messages: [{ role: 'user', content: 'A 的私有历史' }], skills: [{ id: 'skill-a', name: 'A 专属技能', enabled: true }], selectedSkill: 'skill-a', drafts: { a: '尚未发送的私有草稿' } })
  return store
}
function sse() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value } })
  return { response: new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }), emit: (event: unknown) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)), close: () => controller.close() }
}
beforeEach(() => {
  serverMessages = []; mockedApi.mockReset(); mockedFetch.mockReset(); vi.stubGlobal('fetch', mockedFetch)
  Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  history.replaceState(null, '', '/')
  mockedApi.mockImplementation(async path => {
    if (path.startsWith('/api/sessions?')) return { sessions: [groupA, groupB], total: 2 } as any
    if (path === '/api/status') return { configured: true } as any
    if (path === '/api/auth/logout') return {} as any
    if (path === '/api/sessions/a') return { session: groupA, messages: serverMessages } as any
    if (path === '/api/sessions/b') return { session: groupB, messages: [{ role: 'user', content: 'B 当前历史' }] } as any
    if (path.endsWith('/skills')) return { skills: [] } as any
    throw new Error(`Unexpected API: ${path}`)
  })
})
afterEach(() => { for (const store of stores.splice(0)) store.dispose(); vi.unstubAllGlobals() })
afterAll(() => workspace.dispose())

describe('workspace authorization and response ordering', () => {
  it('keeps direct conversation stop controls separate from background activity', () => {
    const store = activeStore()
    store.patch({ current: { ...groupA, running: true, runningTaskCount: 2, conversationRunning: false } })
    expect(store.active).toBe(false)
    expect(store.canStop).toBe(false)
    store.patch({ current: { ...groupA, running: true, conversationRunning: true, activeUserId: userA.id } })
    expect(store.active).toBe(true)
    expect(store.canStop).toBe(true)
  })

  it('does not restore an account from an auth status response that arrived after logout', async () => {
    const store = activeStore(), auth = deferred()
    mockedApi.mockImplementation(async path => path === '/api/auth/status' ? auth.promise : {})
    const initializing = store.initialize()
    await store.logout()
    auth.resolve({ authenticated: true, user: userA, workspace: { name: '公司空间' } })
    await initializing
    expect(store.state.user).toBeNull(); expect(store.state.current).toBeNull(); expect(store.state.messages).toEqual([]); expect(store.state.skills).toEqual([]); expect(store.state.drafts).toEqual({}); expect(store.state.status).toBeNull()
  })

  it('clears every account-scoped cache before showing a different employee with no groups', async () => {
    const store = activeStore(), states: any[] = []
    store.patch({ view: 'audit' })
    store.subscribe(() => states.push(structuredClone(store.state)))
    mockedApi.mockImplementation(async path => path.startsWith('/api/sessions?') ? { sessions: [], total: 0 } : { configured: true })
    await store.enter({ user: userB, workspace: { name: '公司空间' } })
    expect(store.state.user?.id).toBe(userB.id); expect(store.state.sessions).toEqual([]); expect(store.state.current).toBeNull(); expect(store.state.messages).toEqual([]); expect(store.state.skills).toEqual([]); expect(store.state.selectedSkill).toBe(''); expect(store.state.drafts).toEqual({}); expect(store.state.view).toBe('chat')
    expect(states.filter(state => state.user?.id === userB.id).every(state => !state.messages.length && !Object.keys(state.drafts).length)).toBe(true)
  })

  it('ignores stale initialization when a newer explicit login succeeds', async () => {
    const store = activeStore(), status = deferred()
    mockedApi.mockImplementation(async path => {
      if (path === '/api/auth/status') return status.promise
      if (path === '/api/auth/login') return { user: userB, workspace: { name: '公司空间' } }
      if (path.startsWith('/api/sessions?')) return { sessions: [], total: 0 }
      return { configured: true }
    })
    const initializing = store.initialize()
    await store.authenticate('b', 'fixture-password')
    status.resolve({ authenticated: true, user: userA, setupRequired: true })
    await initializing
    expect(store.state.user?.id).toBe(userB.id); expect(store.state.setupRequired).toBe(false); expect(store.state.current).toBeNull()
  })

  it('does not resurrect a revoked group from an older list response', async () => {
    const store = activeStore(), oldList = deferred()
    mockedApi.mockImplementationOnce(() => oldList.promise).mockResolvedValueOnce({ sessions: [groupB], total: 1 })
    const older = store.refreshSessions(), newer = store.refreshSessions()
    await newer
    oldList.resolve({ sessions: [groupA, groupB], total: 2 }); await older
    expect(store.state.sessions.map(group => group.id)).toEqual(['b']); expect(store.state.current).toBeNull(); expect(store.state.messages).toEqual([]); expect(store.state.skills).toEqual([]); expect(store.state.drafts.a).toBeUndefined()
  })

  it('keeps the latest selected conversation when details resolve out of order', async () => {
    const store = activeStore(), oldDetails = deferred()
    mockedApi.mockImplementation(async path => path === '/api/sessions/a' ? oldDetails.promise : path === '/api/sessions/b' ? { session: groupB, messages: [{ role: 'user', content: 'B 当前历史' }] } : { skills: [] })
    const older = store.select('a'); await store.select('b')
    oldDetails.resolve({ session: groupA, messages: [{ role: 'user', content: '晚到的 A 私有历史' }] }); await older
    expect(store.state.current?.id).toBe('b'); expect(store.state.messages.map(message => message.content)).toEqual(['B 当前历史']); expect(store.state.loading).toBe(false); expect(location.hash).toBe('#agent=b')
  })

  it('filters internal task workers without shortening the source pagination offsets', async () => {
    const store = activeStore()
    mockedApi.mockImplementation(async path => path.endsWith('offset=0') ? { sessions: [{ id: 'worker-1', title: '内部任务', taskWorker: true }], total: 3 } : { sessions: [{ id: 'worker-2', title: '内部任务 2', taskWorker: true }, groupB], total: 3 })
    expect(await store.listSessions()).toEqual([groupB])
    expect(mockedApi.mock.calls.map(([path]) => path)).toEqual(['/api/sessions?limit=100&offset=0', '/api/sessions?limit=100&offset=1'])
  })

  it('clears revoked skill selection during context refresh and blocks member admin navigation', async () => {
    const store = activeStore()
    await store.refreshContext()
    expect(store.state.skills).toEqual([]); expect(store.state.selectedSkill).toBe('')
    store.setSkill('unapproved-skill'); expect(store.state.selectedSkill).toBe('')
    store.navigate('users'); expect(store.state.view).toBe('chat')
    store.patch({ current: { ...groupA, running: true, activeUserId: userB.id } }); expect(store.canStop).toBe(false)
    store.patch({ current: { ...groupA, running: true, activeUserId: userA.id } }); expect(store.canStop).toBe(true)
  })

  it('clears account caches when another tab logs out, and ignores pending details', async () => {
    const store = activeStore(), details = deferred()
    mockedApi.mockImplementation(() => details.promise)
    const pending = store.select('a')
    channels.at(-1)!.onmessage?.({ data: { type: 'identity', userId: null } })
    details.resolve({ session: groupA, messages: [{ role: 'user', content: '晚到私有消息' }] }); await pending
    expect(store.state.user).toBeNull(); expect(store.state.messages).toEqual([]); expect(store.state.sessions).toEqual([]); expect(store.state.drafts).toEqual({}); expect(store.state.authError).toContain('其他标签页')
  })
})

describe('workspace stream visibility and revocation', () => {
  it('buffers intermediate prose and tool output and publishes only the complete final answer', async () => {
    const store = activeStore(), stream = sse(), observed: string[] = []
    mockedFetch.mockResolvedValue(stream.response)
    store.subscribe(() => observed.push(JSON.stringify(store.state.messages)))
    const sending = store.send('执行业务查询')
    await waitFor(() => expect(store.state.messages.at(-1)?.content).toBe('执行业务查询'))
    stream.emit({ type: 'start', authorId: userA.id }); stream.emit({ type: 'text_delta', delta: '正在准备执行命令' }); stream.emit({ type: 'tool_start', name: 'powershell', args: 'SECRET COMMAND' }); stream.emit({ type: 'tool_end', result: 'RAW TOOL OUTPUT' }); stream.emit({ type: 'text_delta', delta: '业务查询完成：3 条结果。' })
    await Promise.resolve(); expect(store.state.messages.some(message => message.role === 'assistant')).toBe(false)
    serverMessages = [{ role: 'user', content: '执行业务查询' }, { role: 'assistant', content: '业务查询完成：3 条结果。' }]
    stream.emit({ type: 'done', session: groupA }); stream.close()
    expect(await sending).toBe(true)
    expect(store.state.messages.at(-1)?.content).toBe('业务查询完成：3 条结果。')
    expect(observed.some(text => /正在准备执行命令|SECRET COMMAND|RAW TOOL OUTPUT/.test(text))).toBe(false)
  })

  it('purges messages, skills and drafts immediately on access_revoked and ignores trailing events', async () => {
    const store = activeStore(), stream = sse()
    mockedFetch.mockResolvedValue(stream.response)
    const sending = store.send('执行任务')
    await waitFor(() => expect(store.state.messages.at(-1)?.content).toBe('执行任务'))
    stream.emit({ type: 'access_revoked' }); stream.emit({ type: 'text_delta', delta: '不应再显示的回复' }); stream.emit({ type: 'done', session: groupA }); stream.close()
    expect(await sending).toBe(false)
    expect(store.state.current).toBeNull(); expect(store.state.messages).toEqual([]); expect(store.state.skills).toEqual([]); expect(store.state.selectedSkill).toBe(''); expect(store.state.drafts.a).toBeUndefined(); expect(store.state.sessions.map(group => group.id)).toEqual(['b'])
    expect((mockedFetch.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true)
    expect(mockedApi.mock.calls.some(([path]) => path === '/api/sessions/a')).toBe(false)
  })

  it.each(['error', 'aborted'])('does not publish an incomplete %s stream answer', async kind => {
    const store = activeStore(), stream = sse(), observed: string[] = []
    mockedFetch.mockResolvedValue(stream.response); store.subscribe(() => observed.push(JSON.stringify(store.state.messages)))
    const sending = store.send('执行任务')
    await waitFor(() => expect(store.state.messages.at(-1)?.content).toBe('执行任务'))
    stream.emit({ type: 'text_delta', delta: '未完成的中间结果' })
    if (kind === 'error') stream.emit({ type: 'error', message: '业务执行失败' })
    stream.emit({ type: 'done', aborted: kind === 'aborted', session: groupA }); stream.close(); await sending
    expect(observed.some(text => text.includes('未完成的中间结果'))).toBe(false)
  })

  it('does not let the previous turn history reload overwrite a newer running turn', async () => {
    const store = activeStore(), firstStream = sse(), nextStream = sse(), oldReload = deferred()
    mockedFetch.mockResolvedValueOnce(firstStream.response).mockResolvedValueOnce(nextStream.response)
    mockedApi.mockImplementationOnce(() => oldReload.promise).mockImplementation(async path => path.startsWith('/api/sessions?') ? { sessions: [groupA, groupB], total: 2 } : { session: groupA, messages: serverMessages })
    const first = store.send('第一轮')
    await waitFor(() => expect(store.state.messages.at(-1)?.content).toBe('第一轮'))
    firstStream.emit({ type: 'text_delta', delta: '第一轮完成' }); firstStream.emit({ type: 'done', session: groupA }); firstStream.close()
    await waitFor(() => expect(mockedApi).toHaveBeenCalledWith('/api/sessions/a'))
    const second = store.send('第二轮')
    await waitFor(() => expect(store.state.messages.at(-1)?.content).toBe('第二轮'))
    oldReload.resolve({ session: groupA, messages: [{ role: 'user', content: '过时的第一轮快照' }] }); await first
    expect(store.state.running).toBe(true); expect(store.state.messages.at(-1)?.content).toBe('第二轮')
    serverMessages = [{ role: 'user', content: '第二轮' }, { role: 'assistant', content: '第二轮完成' }]
    nextStream.emit({ type: 'text_delta', delta: '第二轮完成' }); nextStream.emit({ type: 'done', session: groupA }); nextStream.close(); await second
    expect(store.state.messages.at(-1)?.content).toBe('第二轮完成')
  })
})
