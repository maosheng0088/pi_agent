// @vitest-environment jsdom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import App from '../src/App'
import WorkspaceNavigation from '../src/components/WorkspaceNavigation'
import { workspace } from '../src/lib/workspace'
import { adminPrimaryViews, managementViews, navigationSection, toolViewFromHash, viewLabels } from '../src/lib/navigation'
import type { User, View } from '../src/lib/types'

vi.hoisted(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { configurable: true, value: () => ({ fillStyle: '', fillRect() {}, measureText: () => ({ width: 0 }), getImageData: () => ({ data: new Uint8ClampedArray(4) }) }) })
})
vi.mock('../src/lib/api', async original => ({ ...await original<typeof import('../src/lib/api')>(), api: vi.fn(), advanceApiIdentity: vi.fn() }))
vi.mock('../src/ChatView', () => ({ default: () => <div>当前智能体聊天</div> }))
vi.mock('../src/AuthView', () => ({ default: () => <div>登录界面</div> }))
vi.mock('../src/components/SettingsDialog', () => ({ default: () => null }))
vi.mock('../src/components/CreateAgentDialog', () => ({ default: () => null }))
vi.mock('../src/pages/ToolsPage', () => ({ default: ({ onOpenTool }: { onOpenTool(view: View): void }) => <section aria-label="工具目录"><h1>业务工具目录</h1><button onClick={() => onOpenTool('ocean')}>打开海运工具</button></section> }))
vi.mock('../src/pages/OceanFreightPage', () => ({ default: () => <section aria-label="海运业务工具">海运查询工作区</section> }))
vi.mock('../src/pages/AutomationPage', () => ({ default: ({ view }: { view: View }) => <div>自动化页面：{view}</div> }))
vi.mock('../src/pages/AdministrationPage', () => ({ default: ({ view }: { view: View }) => <div>管理页面：{view}</div> }))
vi.mock('../src/pages/ChannelsPage', () => ({ default: () => <div>消息渠道配置页面</div> }))
vi.mock('../src/pages/AdminLogsCenter', () => ({ default: () => <div>管理员日志页面</div> }))
vi.mock('../src/pages/AgentManagementPage', () => ({ default: () => <div>管理页面：agents</div> }))

const employee: User = { id: 'employee-nav', username: 'employee-nav', displayName: '导航员工', role: 'member' }
const admin: User = { id: 'admin-nav', username: 'admin-nav', displayName: '导航管理员', role: 'admin' }
const group = { id: 'agent-current', title: '当前业务智能体' }

function desktop() { return screen.getByRole('navigation', { name: '工作台分类' }) }
function topItem(label: string) { return within(desktop()).getByText(label, { exact: true }) }
function selected(label: string) { return topItem(label).closest('.semi-navigation-item-selected') !== null }
async function mobileMenu() {
  fireEvent.click(screen.getByRole('button', { name: '切换工作台页面' }))
  const first = await screen.findByText('智能体', { selector: '.semi-dropdown-item' })
  return first.closest('.semi-dropdown-menu') as HTMLElement
}
function patch(view: View, user: User = employee) { act(() => workspace.patch({ user, view })) }

beforeEach(() => {
  history.replaceState(null, '', '/#agent=agent-current')
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true } })))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  workspace.clear()
  workspace.patch({ user: employee, workspace: { name: '导航测试公司' }, sessions: [group], current: group, view: 'chat', booting: false, loading: false, online: true, running: false })
  history.replaceState(null, '', '/#agent=agent-current')
  vi.spyOn(workspace, 'initialize').mockResolvedValue(undefined)
  vi.spyOn(workspace, 'synchronize').mockResolvedValue(undefined)
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
afterAll(() => workspace.dispose())

describe('workspace navigation categories with real Semi controls and real route guards', () => {
  it('shows only a red dot for unread messages and clears it when the group becomes read',()=>{
    workspace.patch({sessions:[
      {...group,attention:{unreadCount:2,resultCount:1,mentionCount:1,pendingCount:0}},
      {id:'human-work',title:'待确认报价助手',attention:{unreadCount:0,resultCount:0,mentionCount:0,pendingCount:1}},
      {id:'quiet',title:'无待办助手',revision:900,messageCount:800},
    ]})
    render(<App/>)
    expect(screen.queryByRole('button',{name:/待关注/})).toBeNull()
    for(const label of ['新结果 1','@我 1','待我处理 1'])expect(screen.queryByText(label)).toBeNull()
    const dot=screen.getByRole('img',{name:'有未读新消息'})
    expect(dot.textContent).toBe('');expect(dot.closest('.agent-avatar-wrap')).toBeTruthy()
    expect(screen.getAllByRole('img',{name:'有未读新消息'})).toHaveLength(1)
    expect(screen.getByText('待确认报价助手')).toBeTruthy();expect(screen.getByText('无待办助手')).toBeTruthy()
    act(()=>workspace.patch({sessions:workspace.state.sessions.map(session=>({...session,attention:{unreadCount:0,resultCount:0,mentionCount:0,pendingCount:1}}))}))
    expect(screen.queryByRole('img',{name:'有未读新消息'})).toBeNull()
  })
  it('gives employees only agent and tool entries on desktop and mobile', async () => {
    render(<App />)
    expect(topItem('智能体')).toBeTruthy(); expect(topItem('工具')).toBeTruthy(); expect(selected('智能体')).toBe(true)
    expect(within(desktop()).queryByText('管理', { exact: true })).toBeNull()
    expect(within(desktop()).queryByText('海运工具', { exact: true })).toBeNull()
    const menu = await mobileMenu()
    expect(within(menu).getAllByRole('menuitem').map(item => item.textContent)).toEqual(['智能体', '工具'])
    expect(within(menu).queryByText('管理', { exact: true })).toBeNull()
    for (const view of [...adminPrimaryViews, ...managementViews]) expect(screen.queryByText(viewLabels[view], { exact: true })).toBeNull()
  })

  it('exposes administrator primary pages directly and keeps the remaining pages in management', async () => {
    patch('chat', admin); render(<App />)
    expect(topItem('管理')).toBeTruthy()
    for (const view of adminPrimaryViews) expect(topItem(viewLabels[view])).toBeTruthy()
    for (const view of managementViews) expect(within(desktop()).queryByText(viewLabels[view], { exact: true })).toBeNull()
    fireEvent.click(topItem('管理'))
    for (const view of managementViews) expect(await screen.findByText(viewLabels[view], { exact: true })).toBeTruthy()
    const dropdown = (await screen.findByText('员工管理', { exact: true })).closest('.management-navigation') as HTMLElement
    for (const view of adminPrimaryViews) expect(within(dropdown).queryByText(viewLabels[view], { exact: true })).toBeNull()
    expect(within(desktop()).queryByText('海运工具', { exact: true })).toBeNull()
  })

  it('opens Ocean through the tool directory, highlights Tools and returns through either route', async () => {
    render(<App />); fireEvent.click(topItem('工具'))
    expect(await screen.findByRole('heading', { name: '业务工具目录' })).toBeTruthy(); expect(location.hash).toBe('#view=tools')
    fireEvent.click(screen.getByRole('button', { name: '打开海运工具' }))
    expect(await screen.findByRole('region', { name: '海运业务工具' })).toBeTruthy(); expect(selected('工具')).toBe(true)
    expect(location.hash).toBe('#view=ocean&tool=track')
    fireEvent.click(screen.getByRole('button', { name: '返回工具目录' }))
    expect(await screen.findByRole('heading', { name: '业务工具目录' })).toBeTruthy(); expect(location.hash).toBe('#view=tools')
    fireEvent.click(screen.getByRole('button', { name: '打开海运工具' })); await screen.findByRole('region', { name: '海运业务工具' })
    // Clicking the already highlighted Tools category must still leave Ocean.
    fireEvent.click(topItem('工具'))
    expect(await screen.findByRole('heading', { name: '业务工具目录' })).toBeTruthy(); expect(workspace.state.view).toBe('tools')
    fireEvent.click(topItem('智能体')); expect(await screen.findByText('当前智能体聊天')).toBeTruthy(); expect(location.hash).toBe('#agent=agent-current')
  })

  it('restores the full legacy Ocean share hash after initialization and switches on hash changes', async () => {
    const hash = '#view=ocean&tool=track&q=CSQU3054383&carrier=MSC'
    history.replaceState(null, '', `/${hash}`); workspace.patch({ booting: true, loading: true })
    render(<App />); history.replaceState(null, '', '/')
    act(() => workspace.patch({ booting: false, loading: false }))
    expect(await screen.findByRole('region', { name: '海运业务工具' })).toBeTruthy(); expect(location.hash).toBe(hash); expect(selected('工具')).toBe(true)
    act(() => { history.replaceState(null, '', '/#view=tools'); window.dispatchEvent(new HashChangeEvent('hashchange')) })
    expect(await screen.findByRole('heading', { name: '业务工具目录' })).toBeTruthy()
    act(() => { history.replaceState(null, '', '/#view=ocean&tool=ports&q=CNSHA'); window.dispatchEvent(new HashChangeEvent('hashchange')) })
    expect(await screen.findByRole('region', { name: '海运业务工具' })).toBeTruthy(); expect(location.hash).toBe('#view=ocean&tool=ports&q=CNSHA')
  })

  it('groups the mobile menu without mixing admin options into public Tools', async () => {
    patch('ocean', admin); render(<App />)
    const menu = await mobileMenu(), items = within(menu).getAllByRole('menuitem')
    expect(items.map(item => item.textContent)).toEqual(['智能体', '工具', ...adminPrimaryViews.map(view => viewLabels[view]), ...managementViews.map(view => viewLabels[view])])
    expect(within(menu).getByText('管理', { selector: '.semi-dropdown-title' })).toBeTruthy()
    expect(menu.querySelectorAll('.semi-dropdown-divider')).toHaveLength(1)
    expect(within(menu).queryByText('海运工具', { exact: true })).toBeNull()
    fireEvent.click(within(menu).getByText('工具', { exact: true })); expect(await screen.findByRole('heading', { name: '业务工具目录' })).toBeTruthy()
  })

  it.each(adminPrimaryViews)('routes top-level administrator page %s with its own active label', async view => {
    patch('chat', admin); render(<App />); fireEvent.click(topItem(viewLabels[view]))
    const page = view === 'channels' ? '消息渠道配置页面' : `自动化页面：${view}`
    expect(await screen.findByText(page)).toBeTruthy(); expect(workspace.state.view).toBe(view)
    expect(selected(viewLabels[view])).toBe(true); expect(selected('工具')).toBe(false)
    expect(screen.getByRole('button', { name: '切换工作台页面' }).textContent).toContain(viewLabels[view])
    expect(screen.getByRole('button', { name: '切换工作台页面' }).textContent).not.toContain('管理')
    const menu = await mobileMenu()
    fireEvent.click(within(menu).getByText(viewLabels[view], { exact: true }))
    expect(workspace.state.view).toBe(view); expect(screen.getByText(page)).toBeTruthy()
  })

  it.each(managementViews)('still routes admin page %s from its management group', async view => {
    patch('chat', admin); render(<App />); fireEvent.click(topItem('管理'))
    fireEvent.click(await screen.findByText(viewLabels[view], { exact: true }))
    const page = view === 'skills' || view === 'schedules' ? `自动化页面：${view}` : view === 'channels' ? '消息渠道配置页面' : view === 'logs' ? '管理员日志页面' : `管理页面：${view}`
    expect(await screen.findByText(page)).toBeTruthy(); expect(workspace.state.view).toBe(view)
    expect(screen.getByRole('button', { name: '切换工作台页面' }).textContent).toContain('管理')
    expect(selected('工具')).toBe(false)
  })

  it('does not allow employee route calls or a forged management hash to cross the admin boundary', () => {
    render(<App />)
    for (const view of [...adminPrimaryViews, ...managementViews]) { act(() => workspace.navigate(view)); expect(workspace.state.view).toBe('chat') }
    act(() => { history.replaceState(null, '', '/#view=users'); window.dispatchEvent(new HashChangeEvent('hashchange')) })
    expect(workspace.state.view).toBe('chat'); expect(screen.getByText('当前智能体聊天')).toBeTruthy(); expect(screen.queryByText('管理页面：users')).toBeNull()
    act(() => { history.replaceState(null, '', '/#view=agents'); window.dispatchEvent(new HashChangeEvent('hashchange')) })
    expect(workspace.state.view).toBe('chat'); expect(screen.queryByText('管理页面：agents')).toBeNull()
  })

  it('restores the administrator agent management page from its own URL', async () => {
    patch('chat', admin); history.replaceState(null, '', '/#view=agents'); render(<App/>)
    expect(await screen.findByText('管理页面：agents')).toBeTruthy()
    expect(workspace.state.view).toBe('agents'); expect(location.hash).toBe('#view=agents')
  })

  it('keeps the current group hash when using the original agent deep link', () => {
    render(<App />)
    expect(location.hash).toBe('#agent=agent-current'); expect(workspace.state.current?.id).toBe(group.id); expect(workspace.state.view).toBe('chat')
    expect(screen.getByText('当前智能体聊天')).toBeTruthy()
  })

  it('maps only public tool hashes and routes Ocean to the Tools category', () => {
    expect(navigationSection('ocean')).toBe('tools'); expect(navigationSection('tools')).toBe('tools'); expect(navigationSection('chat')).toBe('chat')
    for (const view of adminPrimaryViews) expect(navigationSection(view)).toBe(view)
    for (const view of managementViews) expect(navigationSection(view)).toBe('manage')
    expect(toolViewFromHash('#view=ocean&tool=track&q=CSQU3054383')).toBe('ocean'); expect(toolViewFromHash('#view=tools')).toBe('tools')
    for (const hash of ['#agent=agent-current', '#view=users', '#view=logs', '#view=unknown', '#view=ocean-tools']) expect(toolViewFromHash(hash)).toBeNull()
  })
})

describe('standalone navigation remains controlled by the active view', () => {
  it('treats repeated Tools clicks as navigation rather than only selection changes', () => {
    const onNavigate = vi.fn(); render(<WorkspaceNavigation view="ocean" isAdmin={false} onNavigate={onNavigate} />)
    expect(selected('工具')).toBe(true); fireEvent.click(topItem('工具')); fireEvent.click(topItem('工具'))
    expect(onNavigate.mock.calls).toEqual([['tools'], ['tools']])
  })
  it('opens administrator management from its focusable title with Enter', async () => {
    const onNavigate = vi.fn(); render(<WorkspaceNavigation view="chat" isAdmin={true} onNavigate={onNavigate} />)
    const trigger = screen.getByRole('button', { name: '管理', exact: true })
    trigger.focus(); expect(document.activeElement).toBe(trigger)
    // Native buttons activate with Enter in browsers; jsdom requires click.
    fireEvent.click(trigger)
    fireEvent.click(await screen.findByText('系统日志', { exact: true }))
    expect(onNavigate).toHaveBeenLastCalledWith('logs')
  })
})
