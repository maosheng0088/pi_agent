import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import AdministrationView from '../src/components/AdministrationView.vue'
import { deferred, json } from './fixtures'
import type { User } from '../src/lib/types'

describe('Administrator creates a collaboration member', () => {
  let wrapper: VueWrapper | undefined
  let originalShow: PropertyDescriptor | undefined, originalClose: PropertyDescriptor | undefined

  beforeEach(() => {
    // jsdom has no browser top layer. Preserve the real component and form,
    // substituting only native dialog opening/closing so their state is observable.
    originalShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal')
    originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close')
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.open = true } })
    Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; this.dispatchEvent(new Event('close')) } })
  })
  afterEach(() => {
    wrapper?.unmount(); wrapper = undefined
    if (originalShow) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShow)
    else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal')
    if (originalClose) Object.defineProperty(HTMLDialogElement.prototype, 'close', originalClose)
    else Reflect.deleteProperty(HTMLDialogElement.prototype, 'close')
  })

  it('sends the backend member role and clears the password before closing after success', async () => {
    const admin: User = { id: 'administrator', username: 'admin', displayName: '管理员', role: 'admin' }
    const created: User = { id: 'new-member', username: 'sales-001', displayName: '测试商务', role: 'member' }
    let users = [admin]
    let submitted: Record<string, unknown> | undefined
    const response = deferred<Response>()
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/admin/users' && init?.method === 'POST') {
        submitted = JSON.parse(String(init.body))
        // Mirror the real API contract that originally exposed this regression.
        if (submitted?.role !== 'member' && submitted?.role !== 'admin') return Promise.resolve(json({ error: '角色必须为 admin 或 member。' }, 400))
        users = [admin, created]
        return response.promise
      }
      if (String(input) === '/api/admin/users') return Promise.resolve(json({ users }))
      return Promise.reject(new Error(`Unexpected request ${String(input)}`))
    })
    vi.stubGlobal('fetch', fetch)
    wrapper = mount(AdministrationView, { props: { view: 'users', user: admin } })
    await flushPromises()
    await wrapper.get('.page-heading .btn-primary').trigger('click')
    await flushPromises()
    const dialog = wrapper.get('dialog').element as HTMLDialogElement
    expect(dialog.open).toBe(true)
    await wrapper.get('#member-name').setValue('测试商务')
    await wrapper.get('#member-username').setValue('sales-001')
    await wrapper.get('#member-password').setValue('fixture-password-only')
    await wrapper.get('dialog form').trigger('submit')
    expect(submitted).toMatchObject({ username: 'sales-001', displayName: '测试商务', role: 'member', password: 'fixture-password-only' })
    expect((wrapper.get('#member-password').element as HTMLInputElement).value).toBe('')
    expect(dialog.open).toBe(true)
    response.resolve(json({ user: created }, 201))
    await flushPromises()
    expect(dialog.open).toBe(false)
    expect(wrapper.get('.data-table').text()).toContain('测试商务')
    expect(wrapper.emitted('toast')).toEqual([['协作成员已创建。']])
    await wrapper.get('.page-heading .btn-primary').trigger('click')
    await flushPromises()
    expect((wrapper.get('#member-password').element as HTMLInputElement).value).toBe('')
    expect((wrapper.get('#member-role').element as HTMLSelectElement).value).toBe('member')
  })
})
