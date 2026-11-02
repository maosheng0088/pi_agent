// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import App from '../src/App'
import { workspace } from '../src/lib/workspace'

vi.hoisted(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { configurable: true, value: () => ({ fillStyle: '', fillRect() {}, measureText: () => ({ width: 0 }), getImageData: () => ({ data: new Uint8ClampedArray(4) }) }) })
})
const { state, listeners, request, navigation, toast } = vi.hoisted(() => ({ state: { value: {} as any }, listeners: new Set<() => void>(), request: vi.fn(), navigation: vi.fn(), toast: vi.fn() }))
vi.mock('../src/lib/api', async original => ({ ...await original<any>(), api: request }))
vi.mock('../src/lib/workspace', async () => {
  const { useSyncExternalStore } = await import('react')
  const patch = (value: any) => { state.value = { ...state.value, ...value }; listeners.forEach(listener => listener()) }
  return {
    workspace: {
      get state() { return state.value }, get isAdmin() { return state.value.user?.role === 'admin' }, get active() { return !!state.value.running },
      initialize: vi.fn(async () => {}), synchronize: vi.fn(async () => {}), expire: vi.fn(), logout: vi.fn(async () => {}), toast, patch,
      navigate: (view: string) => { navigation(view); if (view === 'chat' || view === 'tools' || view === 'ocean' || state.value.user?.role === 'admin') patch({ view }) },
      select: vi.fn(async () => {}), refreshContext: vi.fn(async () => {}), refreshSessions: vi.fn(async () => {}), setSkill: vi.fn(),
    },
    useWorkspace: () => useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => state.value),
  }
})
// Keep real Semi Nav, Dropdown, Modal, Input and Button implementations. The
// feature pages are independent scopes and do not participate in this test.
vi.mock('../src/ChatView', () => ({ default: () => <div>Chat fixture page</div> }))
vi.mock('../src/AuthView', () => ({ default: () => <div>Auth fixture page</div> }))
vi.mock('../src/components/SettingsDialog', () => ({ default: () => null }))
vi.mock('../src/components/CreateAgentDialog', () => ({ default: () => null }))
vi.mock('../src/pages/AutomationPage', () => ({ default: ({ view }: any) => <div>Automation fixture: {view}</div> }))
vi.mock('../src/pages/AdministrationPage', () => ({ default: ({ view }: any) => <div>Administration fixture: {view}</div> }))
vi.mock('../src/pages/ChannelsPage', () => ({ default: () => <div>Channels fixture page</div> }))
vi.mock('../src/pages/AdminLogsCenter', () => ({ default: () => <div>Admin logs fixture page</div> }))
vi.mock('../src/pages/OceanFreightPage', () => ({ default: ({user}:any) => <div>Ocean tools fixture: {user.id}</div> }))
vi.mock('../src/pages/ToolsPage', () => ({ default: ({onOpenTool}:any) => <button onClick={()=>onOpenTool('ocean')}>打开海运工具</button> }))

const employee = { id: 'employee-a', username: 'qa-employee', displayName: 'QA 员工', role: 'member' }
const administrator = { id: 'admin-a', username: 'qa-admin', displayName: 'QA 管理员', role: 'admin' }
function input(label: string) { return screen.getByLabelText(label, { exact: true }) as HTMLInputElement }
function fill(label: string, value: string) { fireEvent.change(input(label), { target: { value } }) }
function deferred() { let resolve!: (value?: any) => void, reject!: (error: Error) => void; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function finishModalAnimation() {
  document.querySelectorAll('.semi-modal-content-animate-hide,.semi-modal-mask-animate-hide').forEach(element => {
    fireEvent.animationEnd(element); fireEvent(element, new Event('webkitAnimationEnd', { bubbles: true }))
  })
}
async function openPassword() {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${state.value.user.displayName}`) }))
  fireEvent.click(await screen.findByText('修改密码', { selector: '.semi-dropdown-item' }))
  await screen.findByLabelText('当前密码', { exact: true })
}
function passwords() { fill('当前密码', 'old-fixture-password'); fill('新密码', 'new-fixture-password'); fill('确认新密码', 'new-fixture-password') }

beforeEach(() => {
  history.replaceState(null,'','/')
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true } })))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  state.value = { booting: false, user: employee, workspace: { name: 'QA 公司' }, sessions: [{ id: 'group-a', title: 'QA 业务助手' }], current: null, messages: [], view: 'chat', online: true, running: false }
  request.mockReset().mockResolvedValue({ ok: true }); navigation.mockReset(); toast.mockReset()
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('App with real Semi navigation and password dialog', () => {
  it('opens ocean tools through the public tools category on desktop and mobile',async()=>{
    render(<App/>);fireEvent.click(screen.getByText('工具',{selector:'.semi-navigation-item-text'}));fireEvent.click(await screen.findByRole('button',{name:'打开海运工具'}))
    expect(navigation).toHaveBeenLastCalledWith('ocean');expect(await screen.findByText('Ocean tools fixture: employee-a')).toBeTruthy()
    fireEvent.click(screen.getByRole('button',{name:'切换工作台页面'}));fireEvent.click(await screen.findByText('工具',{selector:'.semi-dropdown-item'}))
    expect(navigation).toHaveBeenLastCalledWith('tools');expect(await screen.findByRole('button',{name:'打开海运工具'})).toBeTruthy();expect(screen.queryByText('员工管理')).toBeNull()
  })
  it('restores an incoming ocean share route after authentication initialization clears the hash',async()=>{
    history.replaceState(null,'','/#view=ocean&tool=track&q=CSQU3054383');state.value={...state.value,booting:true,loading:true}
    render(<App/>);history.replaceState(null,'','/')
    act(()=>workspace.patch({booting:false,loading:false}));expect(await screen.findByText('Ocean tools fixture: employee-a')).toBeTruthy()
    expect(location.hash).toContain('q=CSQU3054383');expect(navigation).toHaveBeenLastCalledWith('ocean')
  })
  it('filters running agents while keeping queue-only agents separately marked', async () => {
    state.value = { ...state.value, sessions: [
      { id: 'running-agent', title: '执行报价助手', running: true, runningTaskCount: 1, queuedTaskCount: 2 },
      { id: 'queued-agent', title: '等待提柜助手', running: false, runningTaskCount: 0, queuedTaskCount: 1 },
      { id: 'idle-agent', title: '空闲客服助手', running: false, queuedTaskCount: 0 },
    ] }
    render(<App />)
    expect(screen.getByText('运行中 · 1 项任务 · 2 项排队')).toBeTruthy()
    expect(screen.getByText('排队中 · 1 项任务')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^运行中/ }))
    expect(screen.getByText('执行报价助手')).toBeTruthy()
    expect(screen.queryByText('等待提柜助手')).toBeNull()
    expect(screen.queryByText('空闲客服助手')).toBeNull()
    act(() => workspace.patch({ sessions: [{ id: 'running-agent', title: '执行报价助手', running: false, runningTaskCount: 0, queuedTaskCount: 0 }] }))
    expect(await screen.findByText('当前没有运行中的任务')).toBeTruthy()
  })

  it('shows only member navigation and keeps account actions available', async () => {
    render(<App />)
    expect(screen.getByText('Chat fixture page')).toBeTruthy()
    for (const label of ['技能中心', '定时任务', '消息渠道', '员工管理', '聊天审计', '操作记录', '系统日志']) expect(screen.queryByText(label)).toBeNull()
    expect(screen.queryByRole('button', { name: '创建智能体' })).toBeNull()
    await openPassword()
    expect(input('当前密码').getAttribute('maxlength')).toBe('128')
    expect(input('确认新密码').getAttribute('autocomplete')).toBe('new-password')
    expect(screen.queryByText('系统设置')).toBeNull()
  })

  it('opens administrator skills and channels directly from their top-level navigation', async () => {
    state.value = { ...state.value, user: administrator }
    render(<App />)
    fireEvent.click(screen.getByText('技能中心',{selector:'.semi-navigation-item-text'}))
    expect(navigation).toHaveBeenLastCalledWith('skills')
    expect(await screen.findByText('Automation fixture: skills')).toBeTruthy()
    expect(screen.getByRole('button',{name:'切换工作台页面'}).textContent).toContain('技能中心')
    fireEvent.click(screen.getByText('消息渠道',{selector:'.semi-navigation-item-text'}))
    expect(await screen.findByText('Channels fixture page')).toBeTruthy()
    expect(screen.getByRole('button',{name:'切换工作台页面'}).textContent).toContain('消息渠道')
  })

  it('opens administrator system logs from the management navigation and the mobile menu', async () => {
    state.value = { ...state.value, user: administrator }
    render(<App />)
    fireEvent.click(screen.getByRole('button',{name:'管理',exact:true}))
    fireEvent.click(await screen.findByText('系统日志'))
    expect(navigation).toHaveBeenLastCalledWith('logs')
    expect(await screen.findByText('Admin logs fixture page')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '切换工作台页面' }))
    const entries = await screen.findAllByText('系统日志', { selector: '.semi-dropdown-item' })
    fireEvent.click(entries.at(-1)!)
    expect(navigation).toHaveBeenLastCalledWith('logs')
  })

  it('blocks mismatched password confirmation without making a request', async () => {
    render(<App />); await openPassword(); passwords(); fill('确认新密码', 'different-fixture-password')
    expect((screen.getByRole('button', { name: '保存密码' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.submit(input('当前密码').closest('form')!)
    expect(screen.getByText('两次输入的新密码不一致。')).toBeTruthy()
    expect(request).not.toHaveBeenCalled()
  })

  it('sends the correct password API fields once and clears fields after failure', async () => {
    const pending = deferred(); request.mockReturnValue(pending.promise)
    render(<App />); await openPassword(); passwords()
    const passwordForm = input('当前密码').closest('form')!
    act(() => { fireEvent.submit(passwordForm); fireEvent.submit(passwordForm) })
    expect(request).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledWith('/api/auth/password', { method: 'POST', body: { currentPassword: 'old-fixture-password', newPassword: 'new-fixture-password' } })
    expect(input('当前密码').disabled).toBe(true)
    await act(async () => pending.reject(new Error('Fixture password rejected')))
    expect(await screen.findByText('Fixture password rejected')).toBeTruthy()
    for (const label of ['当前密码', '新密码', '确认新密码']) expect(input(label).value).toBe('')
    expect(input('当前密码').disabled).toBe(false)
  })

  it('clears a cancelled draft and reopens empty without a request', async () => {
    render(<App />); await openPassword(); passwords()
    fireEvent.click(screen.getByRole('button', { name: 'close' }))
    finishModalAnimation()
    await openPassword()
    for (const label of ['当前密码', '新密码', '确认新密码']) expect(input(label).value).toBe('')
    expect(request).not.toHaveBeenCalled()
  })

  it('does not let an old account password response clear a new account draft', async () => {
    const oldRequest = deferred(), newRequest = deferred()
    request.mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(newRequest.promise)
    render(<App />); await openPassword(); passwords(); fireEvent.submit(input('当前密码').closest('form')!)
    act(() => workspace.patch({ user: { ...employee, id: 'employee-b', displayName: 'QA 新员工' } }))
    finishModalAnimation(); await openPassword()
    fill('当前密码', 'new-account-current'); fill('新密码', 'new-account-password'); fill('确认新密码', 'new-account-password')
    fireEvent.submit(input('当前密码').closest('form')!)
    expect(request).toHaveBeenCalledTimes(2)
    await act(async () => oldRequest.resolve({ ok: true }))
    expect(input('当前密码').value).toBe('new-account-current')
    expect(input('当前密码').disabled).toBe(true)
    expect(toast).not.toHaveBeenCalled()
    await act(async () => newRequest.reject(new Error('New fixture password rejected')))
    await waitFor(() => expect(input('当前密码').value).toBe(''))
    expect(input('当前密码').disabled).toBe(false)
  })
})
