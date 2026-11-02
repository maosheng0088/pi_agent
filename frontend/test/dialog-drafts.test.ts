import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import MembersDialog from '../src/components/MembersDialog.vue'
import HistorySearch from '../src/components/HistorySearch.vue'
import { json, person, session } from './fixtures'

// These tests exercise each dialog's real state/watch/request code; the modal
// shell is replaced so they do not depend on portal/focus animation timing.
const modal = { props: ['open'], template: '<section v-if="open"><slot /></section>' }
describe('Dialog input survives background updates of the same group', () => {
  let wrapper: VueWrapper | undefined
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }) })
  afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.clearAllTimers(); vi.useRealTimers() })

  it('preserves member search and invite choices when only the session summary changes', async () => {
    const admin = person('admin', '管理员'), coworker = person('coworker', '王小明')
    const fetch = vi.fn((input: RequestInfo | URL) => {
      const path = String(input)
      if (path === '/api/directory') return Promise.resolve(json({ users: [admin, coworker] }))
      if (path.endsWith('/members')) return Promise.resolve(json({ members: [admin], externalMembers: [], ownerId: admin.id, canRemoveMembers: true, canLeave: false }))
      return Promise.reject(new Error(`Unexpected request ${path}`))
    })
    vi.stubGlobal('fetch', fetch)
    wrapper = mount(MembersDialog, { props: { open: true, session: session('alpha'), user: admin }, global: { stubs: { UiModal: modal } } })
    await flushPromises()
    await wrapper.get('#member-invite-search').setValue('王小明')
    await wrapper.get('.candidate-row').trigger('click')
    expect(wrapper.get('.candidate-row').attributes('aria-pressed')).toBe('true')
    const requests = fetch.mock.calls.length
    await wrapper.setProps({ session: { ...session('alpha'), revision: 42, running: true, title: '后台更新后的群名' } })
    await flushPromises()
    expect((wrapper.get('#member-invite-search').element as HTMLInputElement).value).toBe('王小明')
    expect(wrapper.get('.candidate-row').attributes('aria-pressed')).toBe('true')
    expect(fetch).toHaveBeenCalledTimes(requests)
    await wrapper.setProps({ session: session('beta') })
    await flushPromises()
    expect((wrapper.get('#member-invite-search').element as HTMLInputElement).value).toBe('')
    expect(wrapper.findAll('.candidate-row').some(item => item.attributes('aria-pressed') === 'true')).toBe(false)
    expect(fetch.mock.calls.some(([path]) => String(path) === '/api/sessions/beta/members')).toBe(true)
  })

  it('preserves history query and results during same-group summary polling, then resets for a different group', async () => {
    const fetch = vi.fn((input: RequestInfo | URL) => {
      const path = String(input)
      if (path.startsWith('/api/sessions/alpha/search?')) return Promise.resolve(json({ results: [{ role: 'user', content: '报价单 QA-001 已完成', snippet: '报价单 QA-001 已完成', messageIndex: 0, authorName: '商务员工' }], total: 1 }))
      return Promise.reject(new Error(`Unexpected request ${path}`))
    })
    vi.stubGlobal('fetch', fetch)
    wrapper = mount(HistorySearch, { props: { open: true, session: session('alpha') }, global: { stubs: { UiModal: modal } } })
    await wrapper.get('#history-query').setValue('报价单')
    await vi.advanceTimersByTimeAsync(300)
    await flushPromises()
    expect(wrapper.get('.search-result').text()).toContain('QA-001')
    await wrapper.setProps({ session: { ...session('alpha'), revision: 99, updatedAt: new Date().toISOString() } })
    await flushPromises()
    expect((wrapper.get('#history-query').element as HTMLInputElement).value).toBe('报价单')
    expect(wrapper.get('.search-result').text()).toContain('QA-001')
    expect(fetch).toHaveBeenCalledTimes(1)
    await wrapper.setProps({ session: session('beta') })
    expect((wrapper.get('#history-query').element as HTMLInputElement).value).toBe('')
    expect(wrapper.findAll('.search-result')).toHaveLength(0)
  })
})
