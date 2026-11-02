// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import AgentManagementPage from '../src/pages/AgentManagementPage'
import AgentTrashDialog from '../src/components/AgentTrashDialog'
import { api, ApiError } from '../src/lib/api'
import type { Session } from '../src/lib/types'

vi.mock('../src/lib/api', async original => ({ ...await original<typeof import('../src/lib/api')>(), api: vi.fn() }))
vi.mock('lottie-web', () => ({ default: { loadAnimation: vi.fn(() => ({ destroy() {}, play() {}, pause() {}, addEventListener() {}, removeEventListener() {} })) } }))
const mockedApi = vi.mocked(api)
const admin = { id: 'admin', username: 'admin', displayName: '管理员', role: 'admin' }
const agent: Session = { id: 'alpha', title: '业务检查助手', mode: 'workspace' }
const trashed = { id: agent.id, title: agent.title, avatarId: '', deletedAt: '2026-11-02T02:15:00.000Z', deletedByName: '管理员', cwd: 'D:\\code\\pi-web\\workspaces\\alpha', pausedScheduleCount: 2, purging: false }

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  Element.prototype.scrollIntoView = vi.fn()
  mockedApi.mockReset(); mockedApi.mockImplementation(async () => ({ agents: [trashed], skills: [], channels: [] }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('agent trash with real Semi dialogs', () => {
  it('hides management deletion and trash from employees', () => {
    render(<AgentManagementPage user={{ ...admin, role: 'member' }} sessions={[agent]} onChanged={vi.fn()} onOpenSession={vi.fn()}/>)
    expect(screen.queryByRole('button', { name: '垃圾箱' })).toBeNull()
    expect(screen.queryByRole('button', { name: '移入垃圾箱' })).toBeNull()
    expect(mockedApi).not.toHaveBeenCalled()
  })
  it('confirms moving into trash, coalesces clicks and notifies the parent to clear the selected chat', async () => {
    const onChanged = vi.fn(), onTrashed = vi.fn()
    let finish: (value: unknown) => void = () => {}
    mockedApi.mockImplementation(async (_path, options) => options?.method === 'DELETE' ? new Promise(resolve => { finish = resolve }) : {})
    render(<AgentManagementPage user={admin} sessions={[agent]} onChanged={onChanged} onOpenSession={vi.fn()} onTrashed={onTrashed}/>)
    fireEvent.click(screen.getByRole('button', { name: '移入垃圾箱' }))
    const dialog = await screen.findByRole('dialog', { name: /移入垃圾箱：业务检查助手/ })
    expect(within(dialog).getByText(/关联定时任务会暂停/)).toBeTruthy()
    const confirm = within(dialog).getByRole('button', { name: '移入垃圾箱' })
    fireEvent.click(confirm); fireEvent.click(confirm)
    await waitFor(() => expect(mockedApi.mock.calls.filter(([, options]) => options?.method === 'DELETE')).toHaveLength(1))
    expect(mockedApi).toHaveBeenCalledWith('/api/sessions/alpha', expect.objectContaining({ method: 'DELETE', body: {} }))
    await act(async () => { finish({ agent: trashed }) })
    await waitFor(() => expect(onTrashed).toHaveBeenCalledWith('alpha'))
    expect(onChanged).toHaveBeenCalled()
  })
  it('opens the garbage bin from management and restores without resuming schedules', async () => {
    const onChanged = vi.fn(); let restored = false
    mockedApi.mockImplementation(async (route, options) => {
      if (options?.method === 'POST') { restored = true; return { schedulesRemainPaused: true } }
      return { agents: restored ? [] : [trashed] }
    })
    render(<AgentManagementPage user={admin} sessions={[]} onChanged={onChanged} onOpenSession={vi.fn()}/>)
    fireEvent.click(screen.getByRole('button', { name: '垃圾箱' }))
    const restore = await screen.findByRole('button', { name: '恢复：业务检查助手' })
    expect(screen.getByText('2 个定时任务已暂停')).toBeTruthy()
    fireEvent.click(restore)
    await waitFor(() => expect(mockedApi).toHaveBeenCalledWith('/api/admin/agent-trash/alpha/restore', expect.objectContaining({ method: 'POST', body: { deletedAt: trashed.deletedAt } })))
    await screen.findByText('垃圾箱为空')
    expect(onChanged).toHaveBeenCalled()
  })
  it('requires the exact name before permanent deletion and submits the current trash revision', async () => {
    let removed = false
    mockedApi.mockImplementation(async (_route, options) => { if (options?.method === 'DELETE') removed = true; return { agents: removed ? [] : [trashed] } })
    render(<AgentTrashDialog onClose={vi.fn()} onRestored={vi.fn()}/>)
    fireEvent.click(await screen.findByRole('button', { name: '永久删除：业务检查助手' }))
    const dialog = await screen.findByRole('dialog', { name: '永久删除智能体' })
    const confirm = within(dialog).getByRole('button', { name: '永久删除' })
    expect((confirm as HTMLButtonElement).disabled).toBe(true)
    expect(within(dialog).getByText(trashed.cwd)).toBeTruthy()
    fireEvent.change(within(dialog).getByLabelText('输入“业务检查助手”确认删除'), { target: { value: '其他智能体' } })
    expect((confirm as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(within(dialog).getByLabelText('输入“业务检查助手”确认删除'), { target: { value: agent.title } })
    fireEvent.click(confirm)
    await waitFor(() => expect(mockedApi).toHaveBeenCalledWith('/api/admin/agent-trash/alpha', expect.objectContaining({ method: 'DELETE', body: { confirmTitle: agent.title, deletedAt: trashed.deletedAt } })))
    await screen.findByText('垃圾箱为空')
  })
  it('keeps a failed cleanup visible and disables restoring a partially deleted agent', async () => {
    mockedApi.mockResolvedValue({ agents: [{ ...trashed, purging: true, purgeError: '文件清理未完成，请重试永久删除。' }] })
    render(<AgentTrashDialog onClose={vi.fn()} onRestored={vi.fn()}/>)
    const restore = await screen.findByRole('button', { name: '恢复：业务检查助手' })
    expect((restore as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('待完成清理')).toBeTruthy()
    expect(screen.getByRole('button', { name: '永久删除：业务检查助手' }).textContent).toContain('重试清理')
  })
  it('clears trash data after authorization expires and ignores late results', async () => {
    let finish: (value: unknown) => void = () => {}
    mockedApi.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    render(<AgentTrashDialog onClose={vi.fn()} onRestored={vi.fn()}/>)
    await waitFor(() => expect(mockedApi).toHaveBeenCalled())
    act(() => window.dispatchEvent(new Event('pi:auth-expired')))
    await act(async () => { finish({ agents: [trashed] }) })
    expect(screen.queryByText(agent.title)).toBeNull()
    expect(screen.getByText('登录或管理员权限已失效，请重新进入。')).toBeTruthy()
  })
  it('shows a server refusal without hiding the trash entry', async () => {
    mockedApi.mockImplementation(async (_route, options) => { if (options?.method === 'POST') throw new ApiError('工作目录已被替换，请联系管理员。', 409); return { agents: [trashed] } })
    render(<AgentTrashDialog onClose={vi.fn()} onRestored={vi.fn()}/>)
    fireEvent.click(await screen.findByRole('button', { name: '恢复：业务检查助手' }))
    await screen.findByText('工作目录已被替换，请联系管理员。')
    expect(screen.getByRole('button', { name: '恢复：业务检查助手' })).toBeTruthy()
  })
})
