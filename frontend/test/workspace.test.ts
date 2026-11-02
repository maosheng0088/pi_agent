import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import { api, ApiError } from '../src/lib/api'
import { useWorkspaceStore } from '../src/stores/workspace'
import { deferred, fakeBackend, json, sse } from './fixtures'

describe('Workspace identity, drafts and membership boundaries', () => {
  let store: ReturnType<typeof useWorkspaceStore>
  let backend: ReturnType<typeof fakeBackend>
  let expired: () => void

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    setActivePinia(createPinia())
    backend = fakeBackend()
    store = useWorkspaceStore()
    expired = () => store.expire()
    window.addEventListener('pi:auth-expired', expired)
    await store.authenticate('old', 'fake-password')
  })
  afterEach(() => {
    window.removeEventListener('pi:auth-expired', expired)
    store.$dispose()
    vi.clearAllTimers()
    vi.useRealTimers()
    history.replaceState(null, '', '/')
  })

  it('does not let an old 401 expire a newly authenticated identity', async () => {
    const delayed = deferred<Response>(), event = vi.fn()
    backend.route(path => path === '/api/old-request' ? delayed.promise : undefined)
    window.addEventListener('pi:auth-expired', event)
    try {
      const pending = api('/api/old-request').catch(error => error)
      await store.authenticate('new', 'another-fake-password')
      delayed.resolve(json({ error: 'Old login expired' }, 401))
      expect(await pending).toBeInstanceOf(ApiError)
      expect(event).not.toHaveBeenCalled()
      expect(store.user?.id).toBe('new-id')
      expect(store.current?.id).toBe('alpha')
      expect(store.messages[0]?.content).toBe('Alpha saved response')
    } finally { window.removeEventListener('pi:auth-expired', event) }
  })

  it('still clears sensitive state when the current identity actually expires', async () => {
    store.drafts.alpha = 'private unsent draft'
    backend.route(path => path === '/api/current-request' ? json({ error: 'Current login expired' }, 401) : undefined)
    await expect(api('/api/current-request')).rejects.toBeInstanceOf(ApiError)
    expect(store.user).toBeNull()
    expect(store.current).toBeNull()
    expect(store.messages).toEqual([])
    expect(store.drafts).toEqual({})
    expect(store.authError).toContain('登录已过期')
  })

  it('keeps a newer draft when the submitted request fails before SSE starts', async () => {
    const delayed = deferred<Response>()
    backend.route((path, init) => path.endsWith('/messages') && init?.method === 'POST' ? delayed.promise : undefined)
    store.drafts.alpha = 'original task'
    const pending = store.send('original task')
    store.drafts.alpha = 'newly typed task'
    delayed.resolve(json({ error: 'The model is unavailable' }, 503))
    expect(await pending).toBe(false)
    expect(store.drafts.alpha).toBe('newly typed task')
    expect(store.chatError).toContain('model is unavailable')
    expect(store.running).toBe(false)
  })

  it('restores the original draft when an unaccepted request fails and nothing new was typed', async () => {
    backend.route((path, init) => path.endsWith('/messages') && init?.method === 'POST' ? json({ error: 'Unavailable' }, 503) : undefined)
    store.drafts.alpha = 'retry this task'
    expect(await store.send('retry this task')).toBe(false)
    expect(store.drafts.alpha).toBe('retry this task')
  })

  it('does not overwrite new typing after an accepted SSE task reports failure', async () => {
    const stream = sse()
    backend.route((path, init) => path.endsWith('/messages') && init?.method === 'POST' ? stream.response : undefined)
    store.drafts.alpha = 'submitted task'
    const pending = store.send('submitted task')
    await flushPromises()
    expect(store.drafts.alpha).toBe('')
    store.drafts.alpha = 'my next task'
    stream.event({ type: 'start', sessionId: 'alpha', authorId: 'old-id' })
    stream.event({ type: 'error', message: 'The accepted task failed' })
    stream.event({ type: 'done', session: backend.state.groups[0], aborted: false })
    stream.close()
    await pending
    expect(store.drafts.alpha).toBe('my next task')
    expect(store.chatError).toBe('The accepted task failed')
  })

  it('clears removed-group content and drafts while preserving drafts for authorized groups', async () => {
    store.drafts.alpha = 'removed group secret'
    store.drafts.beta = 'still authorized draft'
    backend.state.groups = backend.state.groups.filter(group => group.id === 'beta')
    await store.synchronize()
    expect(store.current).toBeNull()
    expect(store.messages).toEqual([])
    expect(store.skills).toEqual([])
    expect(store.drafts.alpha).toBeUndefined()
    expect(store.drafts.beta).toBe('still authorized draft')
    expect(store.sessions.map(group => group.id)).toEqual(['beta'])
    expect(location.hash).toBe('')
  })

  it('ignores late SSE output after membership is revoked during a task', async () => {
    const stream = sse()
    backend.route((path, init) => path.endsWith('/messages') && init?.method === 'POST' ? stream.response : undefined)
    store.drafts.alpha = 'private task'
    const pending = store.send('private task')
    await flushPromises()
    store.drafts.alpha = 'another private draft'
    stream.event({ type: 'access_revoked', message: '你已被移出此群聊。' })
    stream.event({ type: 'text_delta', delta: 'must never reappear' })
    stream.event({ type: 'done', session: backend.state.groups[0], aborted: false })
    stream.close()
    await pending
    expect(store.current).toBeNull()
    expect(store.messages).toEqual([])
    expect(store.drafts.alpha).toBeUndefined()
    expect(store.running).toBe(false)
    expect(store.sessions.some(group => group.id === 'alpha')).toBe(false)
  })

  it('does not write a delayed prior selection over the currently selected agent', async () => {
    const delayed = deferred<Response>()
    backend.route(path => path === '/api/sessions/alpha' ? delayed.promise : undefined)
    store.drafts.alpha = 'alpha draft'
    store.drafts.beta = 'beta draft'
    const oldSelection = store.select('alpha')
    await store.select('beta')
    delayed.resolve(json({ session: backend.state.groups[0], messages: [{ role: 'assistant', content: 'Late alpha response' }] }))
    await oldSelection
    expect(store.current?.id).toBe('beta')
    expect(store.messages.map(item => item.content)).toEqual(['Beta saved response'])
    expect(store.drafts).toEqual({ alpha: 'alpha draft', beta: 'beta draft' })
    expect(location.hash).toBe('#agent=beta')
  })

  it('updates available skills without a chat revision change and drops a revoked selection', async () => {
    store.selectedSkill = 'alpha-skill'
    store.drafts.alpha = 'keep this draft'
    backend.state.skills.alpha = []
    await store.synchronize()
    expect(store.skills).toEqual([])
    expect(store.selectedSkill).toBe('')
    expect(store.drafts.alpha).toBe('keep this draft')
    expect(store.messages[0]?.content).toBe('Alpha saved response')
  })

  it('does not clear a new identity when an earlier logout completes late', async () => {
    const delayed = deferred<Response>()
    backend.route(path => path === '/api/auth/logout' ? delayed.promise : undefined)
    const pending = store.logout()
    store.expire()
    await store.authenticate('new', 'another-fake-password')
    delayed.resolve(json({ ok: true }))
    await pending
    expect(store.user?.id).toBe('new-id')
    expect(store.current?.id).toBe('alpha')
    expect(store.messages[0]?.content).toBe('Alpha saved response')
  })
})
