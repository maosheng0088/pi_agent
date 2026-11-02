// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import AgentManagementPage from '../src/pages/AgentManagementPage'
import { api } from '../src/lib/api'
import type { Session, Skill } from '../src/lib/types'
vi.mock('../src/lib/api', async original => ({ ...await original<typeof import('../src/lib/api')>(), api: vi.fn() }))
vi.mock('lottie-web', () => ({ default: { loadAnimation: vi.fn(() => ({ destroy() {}, play() {}, pause() {}, addEventListener() {}, removeEventListener() {} })) } }))
const mockedApi = vi.mocked(api)
const admin = { id: 'admin', username: 'admin', displayName: '管理员', role: 'admin' }
const groups: Session[] = [{ id: 'alpha', title: 'PO 检查助手', mode: 'workspace', avatarId: '' }, { id: 'beta', title: '报价助手', mode: 'read-only' }]
function view(overrides: any = {}) { const props = { user: admin, sessions: groups, currentSessionId: 'alpha', onChanged: vi.fn(), onOpenSession: vi.fn(), ...overrides }; return { ...render(<AgentManagementPage {...props}/>), props } }
beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  Element.prototype.scrollIntoView = vi.fn()
  mockedApi.mockReset(); mockedApi.mockImplementation(async path => path.endsWith('/profile') ? { profile: { responsibilities: '仅处理本群业务', version: 1 } } : path.includes('/knowledge?') ? { documents: [], matches: [] } : path.endsWith('/members') ? { members: [admin], externalMembers: [], canRemoveMembers: true, canLeave: false } : { skills: [], channels: [] })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
describe('central agent management with real Semi components', () => {
  it('does not expose management or request configuration for employees', () => {
    view({ user: { ...admin, id: 'employee', role: 'member' } })
    expect(screen.getByText('仅管理员可管理智能体。')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '创建智能体' })).toBeNull()
    expect(mockedApi).not.toHaveBeenCalled()
  })
  it('saves basic settings only to the selected agent and can enter its chat', async () => {
    const { props } = view()
    fireEvent.click(screen.getByRole('button', { name: /报价助手/ }))
    fireEvent.change(screen.getByLabelText('智能体名称'), { target: { value: '业务报价助手' } })
    mockedApi.mockResolvedValue({ session: { ...groups[1], title: '业务报价助手' } })
    fireEvent.click(screen.getByRole('button', { name: '保存基本设置' }))
    await waitFor(() => expect(mockedApi).toHaveBeenCalledWith('/api/sessions/beta', expect.objectContaining({ method: 'PATCH', body: { title: '业务报价助手', avatarId: '' } })))
    expect(props.onChanged).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: '进入聊天' }))
    expect(props.onOpenSession).toHaveBeenCalledExactlyOnceWith('beta')
  })
  it('edits the existing versioned role inside the management page without a task list', async () => {
    view(); fireEvent.click(screen.getByRole('tab', { name: '岗位与知识' }))
    const panel = await screen.findByRole('region', { name: '岗位规范与知识库' }, { timeout: 10000 })
    await within(panel).findByDisplayValue('仅处理本群业务')
    expect(within(panel).queryByRole('tab', { name: /任务中心/ })).toBeNull()
    fireEvent.change(within(panel).getByLabelText('岗位职责'), { target: { value: '核对 PO 重复预约' } })
    fireEvent.click(within(panel).getByRole('button', { name: '保存岗位配置' }))
    await waitFor(() => expect(mockedApi.mock.calls.some(([path, options]) => path === '/api/sessions/alpha/profile' && options?.method === 'PATCH' && (options.body as any).responsibilities === '核对 PO 重复预约' && (options.body as any).expectedVersion === 1)).toBe(true))
    expect(mockedApi.mock.calls.some(([path]) => path.endsWith('/tasks'))).toBe(false)
  })
  it('merges current sharing assignments and preserves other agents when assigning a skill', async () => {
    const initial: Skill[] = [{ id: 'global', name: '全局工具', scope: 'all', enabled: true }, { id: 'selected', name: '报价工具', scope: 'groups', groupIds: ['beta'], enabled: true }]
    let reads = 0
    mockedApi.mockImplementation(async (path, options) => path === '/api/skills' ? { skills: ++reads === 1 ? initial : [initial[0], { ...initial[1], groupIds: ['beta', 'gamma'] }] } : {})
    view(); fireEvent.click(screen.getByRole('tab', { name: '技能分配' }))
    const checkbox = await screen.findByRole('checkbox', { name: '分配技能：报价工具' })
    expect((screen.getByRole('checkbox', { name: '分配技能：全局工具' }) as HTMLInputElement).disabled).toBe(true)
    fireEvent.click(checkbox); fireEvent.click(screen.getByRole('button', { name: '保存技能分配' }))
    await waitFor(() => expect(mockedApi).toHaveBeenCalledWith('/api/admin/skills/selected', expect.objectContaining({ method: 'PATCH', body: { scope: 'groups', groupIds: ['beta', 'gamma', 'alpha'] } })))
    expect(mockedApi.mock.calls.some(([path, options]) => path.includes('/global') && options?.method === 'PATCH')).toBe(false)
  })
  it('does not steal another agent channel and saves only chosen available bindings', async () => {
    mockedApi.mockImplementation(async path => path === '/api/admin/channels' ? { channels: [{ id: 'free', name: '业务微信', type: 'weixin' }, { id: 'other', name: '财务微信', type: 'weixin', sessionId: 'beta', sessionTitle: '报价助手' }] } : { channels: [], canManage: true })
    view(); fireEvent.click(screen.getByRole('tab', { name: '渠道绑定' }))
    const free = await screen.findByRole('checkbox', { name: '绑定渠道：业务微信' })
    expect((screen.getByRole('checkbox', { name: '绑定渠道：财务微信' }) as HTMLInputElement).disabled).toBe(true)
    fireEvent.click(free); fireEvent.click(screen.getByRole('button', { name: '保存渠道绑定' }))
    await waitFor(() => expect(mockedApi).toHaveBeenCalledWith('/api/sessions/alpha/channels', expect.objectContaining({ method: 'PUT', body: { channelIds: ['free'] } })))
  })
  it('discards private skill data after switching to another agent while loading', async () => {
    let resolve!: (value: any) => void
    mockedApi.mockImplementation(() => new Promise(done => { resolve = done }))
    view(); fireEvent.click(screen.getByRole('tab', { name: '技能分配' }))
    await waitFor(() => expect(mockedApi).toHaveBeenCalledOnce())
    const signal = mockedApi.mock.calls[0][1]?.signal
    fireEvent.click(screen.getByRole('button', { name: /报价助手/ }))
    await act(async () => resolve({ skills: [{ id: 'private', name: '迟到的私有技能', scope: 'groups', groupIds: ['alpha'] }] }))
    expect(signal?.aborted).toBe(true)
    expect(screen.queryByText('迟到的私有技能')).toBeNull()
    expect((screen.getByLabelText('智能体名称') as HTMLInputElement).value).toBe('报价助手')
  })
})
