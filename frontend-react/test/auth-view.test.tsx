// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import AuthView from '../src/AuthView'

// Render the installed Semi Input, Button and Banner unchanged. Only the
// account boundary is mocked so no real credentials or server data are used.
vi.hoisted(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { configurable: true, value: () => ({ fillStyle: '', fillRect() {}, measureText: () => ({ width: 0 }), getImageData: () => ({ data: new Uint8ClampedArray(4) }) }) })
})
const { auth, authenticate } = vi.hoisted(() => ({ auth: { value: { setupRequired: false, setupAllowed: true, authError: '' } }, authenticate: vi.fn() }))
vi.mock('../src/lib/workspace', () => ({ workspace: { authenticate }, useWorkspace: () => auth.value }))

function input(label: string) { return screen.getByLabelText(label, { exact: true }) as HTMLInputElement }
function fill(label: string, value: string) { fireEvent.change(input(label), { target: { value } }) }
function form() { return input('账号').closest('form')! }
function deferred() { let resolve!: () => void, reject!: (error: Error) => void; const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function setupForm() {
  auth.value = { setupRequired: true, setupAllowed: true, authError: '' }
  render(<AuthView />)
  fill('账号', 'qa-admin')
  fill('姓名', 'QA 管理员')
  fill('密码', 'a-valid-fixture-password')
  fill('确认密码', 'a-valid-fixture-password')
}

beforeEach(() => {
  auth.value = { setupRequired: false, setupAllowed: true, authError: '' }
  authenticate.mockReset().mockResolvedValue(undefined)
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true } })))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('AuthView with real Semi controls', () => {
  it('allows an existing short password and clears it after successful login', async () => {
    render(<AuthView />)
    fill('账号', '003009'); fill('密码', '1234')
    expect(screen.queryByLabelText('确认密码', { exact: true })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '进入工作台' }))
    expect(authenticate).toHaveBeenCalledWith('003009', '1234', '')
    await waitFor(() => expect(input('密码').value).toBe(''))
    expect(input('账号').value).toBe('003009')
  })

  it('keeps normal login compatible with one-character imported passwords', async () => {
    render(<AuthView />)
    fill('账号', 'qa-legacy'); fill('密码', 'x')
    fireEvent.submit(form())
    expect(authenticate).toHaveBeenCalledWith('qa-legacy', 'x', '')
    await waitFor(() => expect(input('密码').value).toBe(''))
    expect(input('密码').getAttribute('maxlength')).toBe('128')
    expect(input('密码').getAttribute('autocomplete')).toBe('current-password')
  })

  it('rejects missing setup names, short new passwords and mismatching confirmation locally', () => {
    setupForm()
    fill('姓名', '   ')
    fireEvent.submit(form())
    expect(screen.getByText('请输入管理员姓名。')).toBeTruthy()
    fill('姓名', ' QA 管理员 '); fill('密码', 'short'); fill('确认密码', 'short')
    fireEvent.submit(form())
    expect(screen.getByText('新密码须为 8 至 128 个字符。')).toBeTruthy()
    fill('密码', 'a-valid-fixture-password'); fill('确认密码', 'different-fixture-password')
    fireEvent.submit(form())
    expect(screen.getByText('两次输入的密码不一致。')).toBeTruthy()
    expect(authenticate).not.toHaveBeenCalled()
  })

  it('submits validated setup once, disables the real inputs and clears both password fields', async () => {
    const pending = deferred(); authenticate.mockReturnValue(pending.promise)
    setupForm(); fill('姓名', ' QA 管理员 ')
    act(() => { fireEvent.submit(form()); fireEvent.submit(form()) })
    expect(authenticate).toHaveBeenCalledOnce()
    expect(authenticate).toHaveBeenCalledWith('qa-admin', 'a-valid-fixture-password', 'QA 管理员')
    expect(input('账号').disabled).toBe(true)
    expect(input('姓名').disabled).toBe(true)
    expect(input('密码').disabled).toBe(true)
    expect(input('确认密码').disabled).toBe(true)
    await act(async () => pending.resolve())
    await waitFor(() => { expect(input('密码').value).toBe(''); expect(input('确认密码').value).toBe('') })
    expect(input('账号').disabled).toBe(false)
    expect(input('密码').getAttribute('autocomplete')).toBe('new-password')
    expect(input('确认密码').getAttribute('maxlength')).toBe('128')
  })

  it('clears sensitive fields on a failed setup while preserving the account and display name', async () => {
    const pending = deferred(); authenticate.mockReturnValue(pending.promise)
    setupForm(); fireEvent.submit(form())
    await act(async () => pending.reject(new Error('Fixture rejection')))
    await waitFor(() => { expect(input('密码').value).toBe(''); expect(input('确认密码').value).toBe('') })
    expect(input('账号').value).toBe('qa-admin')
    expect(input('姓名').value).toBe('QA 管理员')
    expect(input('密码').disabled).toBe(false)
  })

  it('clears failed login passwords and blocks empty or repeated requests', async () => {
    const pending = deferred(); authenticate.mockReturnValue(pending.promise)
    render(<AuthView />)
    fireEvent.submit(form()); expect(authenticate).not.toHaveBeenCalled()
    fill('账号', 'qa-user'); fill('密码', 'fixture-wrong-password')
    act(() => { fireEvent.submit(form()); fireEvent.submit(form()) })
    expect(authenticate).toHaveBeenCalledOnce()
    await act(async () => pending.reject(new Error('Fixture login rejection')))
    await waitFor(() => expect(input('密码').value).toBe(''))
    expect((screen.getByRole('button', { name: '进入工作台' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('does not expose setup fields when remote setup is prohibited', () => {
    auth.value = { setupRequired: true, setupAllowed: false, authError: '' }
    render(<AuthView />)
    expect(screen.getByText('请由服务所在电脑完成首次管理员设置。')).toBeTruthy()
    expect(screen.queryByLabelText('账号', { exact: true })).toBeNull()
    expect(screen.queryByRole('button', { name: '创建并进入' })).toBeNull()
    expect(authenticate).not.toHaveBeenCalled()
  })
})
