// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { api } from '../../lib/api'
import AutomationPage from '../AutomationPage'
import type { Skill } from '../../lib/types'
import type { TaskPlan } from './model'

vi.mock('../../lib/api', () => ({ api: vi.fn(), errorMessage: (error: unknown) => error instanceof Error ? error.message : String(error) }))
// Semi exports its optional Lottie player with the component barrel. The task
// forms do not render animations; avoid requiring a canvas implementation here.
vi.mock('lottie-web', () => ({ default: { loadAnimation: vi.fn(() => ({ destroy: vi.fn(), play: vi.fn(), pause: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() })) } }))
const mockedApi = vi.mocked(api)
const groups = [{ id: 'group-a', title: '业务 A' }, { id: 'group-b', title: '业务 B' }]
const skill: Skill = { id: 'skill-a', name: 'fixture-skill', description: '业务技能', enabled: true, scope: 'groups', groupIds: ['group-a', 'historical-hidden-group'], avatarId: 'portrait-02', content: '# Skill\nDo the business task.', files: [{ path: 'scripts/run.py', size: 26 }] }
const agentPlan: TaskPlan = { id: 'agent-plan', name: '现有 AI 计划', taskType: 'agent', enabled: false, targetSessionId: 'group-a', executionMode: 'read-only', skillId: 'skill-a', prompt: '整理资料', scheduleType: 'daily', time: '09:15' }
const businessPlan: TaskPlan = { id: 'business-plan', name: '业务项目计划', taskType: 'business', businessTaskId: 'fixture-business', enabled: true, targetSessionId: 'group-a', executionMode: 'workspace', prompt: '固定执行', scheduleType: 'daily', time: '08:05', startDate: '2026-10-29' }
let plans: TaskPlan[]
function renderPage(view: 'skills' | 'schedules') { return render(<AutomationPage view={view} sessions={groups} currentSessionId="group-a" onChanged={vi.fn()} onOpenSession={vi.fn()} />) }
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => ({ matches: false, media: '', addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() })) })
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  Element.prototype.scrollIntoView = vi.fn()
})
beforeEach(() => {
  plans = [agentPlan]
  mockedApi.mockReset()
  mockedApi.mockImplementation(async (path, options = {}) => {
    if (options.method && options.method !== 'GET') {
      if (path.endsWith('/run')) return { run: { id: 'new-run', status: 'queued' } } as any
      return {} as any
    }
    if (path === '/api/skills') return { skills: [skill] } as any
    if (path === '/api/skills/skill-a') return { skill } as any
    if (path.startsWith('/api/sessions?')) return { sessions: groups, total: groups.length } as any
    if (path === '/api/admin/schedules') return { schedules: plans } as any
    if (path === '/api/admin/business-tasks') return { tasks: [{ id: 'fixture-business', name: '固定业务项目', source: 'RPAC', projectVersion: 2, timeoutSeconds: 7200, ready: true }] } as any
    if (path.endsWith('/runs?limit=100') || path === '/api/admin/task-runs?limit=100') return { runs: [] } as any
    throw new Error(`Unexpected API path: ${path}`)
  })
})
afterEach(() => { cleanup(); vi.clearAllTimers() })

describe('Semi automation pages preserve business behavior', () => {
  it('imports a ZIP with its avatar and scope through the existing API', async () => {
    renderPage('skills')
    await screen.findByText('fixture-skill')
    fireEvent.click(screen.getByRole('button', { name: '导入技能' }))
    const modal = await screen.findByRole('dialog', { name: '导入技能 ZIP' })
    const file = new File([new Uint8Array([80, 75, 3, 4])], 'fixture-skill.zip', { type: 'application/zip' })
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new Uint8Array([80, 75, 3, 4]).buffer })
    fireEvent.change(within(modal).getByLabelText('技能 ZIP 文件'), { target: { files: [file] } })
    fireEvent.click(within(modal).getByRole('radio', { name: '白狐' }))
    fireEvent.click(within(modal).getByRole('checkbox', { name: '导入后启用，允许获授权智能体使用' }))
    fireEvent.click(within(modal).getByRole('button', { name: '导入 ZIP' }))
    await waitFor(() => expect(mockedApi).toHaveBeenCalledWith('/api/admin/skills/import', expect.objectContaining({ method: 'POST', body: { zipBase64: 'UEsDBA==', enabled: true, scope: 'all', groupIds: [], avatarId: 'portrait-03' } })))
  })

  it('changes authorized groups and avatar without discarding inaccessible historical authorization', async () => {
    renderPage('skills')
    fireEvent.click(await screen.findByRole('button', { name: '配置' }))
    const modal = await screen.findByRole('dialog', { name: '设置技能头像与授权范围' })
    expect((within(modal).getByRole('checkbox', { name: /已授权智能体（目前不可访问）/ }) as HTMLInputElement).checked).toBe(true)
    fireEvent.click(within(modal).getByRole('checkbox', { name: '业务 B' }))
    fireEvent.click(within(modal).getByRole('radio', { name: '清爽蓝' }))
    fireEvent.click(within(modal).getByRole('button', { name: '保存配置' }))
    await waitFor(() => expect(mockedApi).toHaveBeenCalledWith('/api/admin/skills/skill-a', expect.objectContaining({ method: 'PATCH', body: { scope: 'groups', groupIds: ['group-a', 'historical-hidden-group', 'group-b'], avatarId: 'portrait-01' } })))
  })

  it('preserves existing AI task kind and enforces current skill authorization', async () => {
    renderPage('schedules')
    fireEvent.click(await screen.findByRole('button', { name: '编辑' }))
    const modal = await screen.findByRole('dialog', { name: '编辑定时任务' })
    await waitFor(() => expect(within(modal).queryByText('正在加载可用智能体与项目…')).toBeNull())
    const kind = within(modal).getByRole('combobox', { name: '任务类型' })
    expect(kind.getAttribute('aria-disabled')).toBe('true')
    fireEvent.change(within(modal).getByLabelText('执行任务'), { target: { value: '整理更新后的资料' } })
    fireEvent.click(within(modal).getByRole('button', { name: '保存任务' }))
    await waitFor(() => expect(mockedApi).toHaveBeenCalledWith('/api/admin/schedules/agent-plan', expect.objectContaining({ method: 'PATCH', body: expect.objectContaining({ taskType: 'agent', executionMode: 'read-only', skillId: 'skill-a', targetSessionId: 'group-a', prompt: '整理更新后的资料', time: '09:15' }) })))
  })

  it('keeps a business task deterministic and its Beijing start date unchanged', async () => {
    plans = [businessPlan]
    renderPage('schedules')
    fireEvent.click(await screen.findByRole('button', { name: '编辑' }))
    const modal = await screen.findByRole('dialog', { name: '编辑定时任务' })
    await waitFor(() => expect(within(modal).queryByText('正在加载可用智能体与项目…')).toBeNull())
    expect(within(modal).queryByLabelText('执行任务')).toBeNull()
    fireEvent.change(within(modal).getByLabelText('首次计划日期 · 北京时间'), { target: { value: '2026-10-30' } })
    fireEvent.click(within(modal).getByRole('button', { name: '保存任务' }))
    await waitFor(() => expect(mockedApi).toHaveBeenCalledWith('/api/admin/schedules/business-plan', expect.objectContaining({ method: 'PATCH', body: expect.objectContaining({ taskType: 'business', businessTaskId: 'fixture-business', executionMode: 'workspace', skillId: null, scheduleType: 'daily', startDate: '2026-10-30', time: '08:05' }) })))
  })

  it('blocks a previously selected skill after switching to a group outside its scope', async () => {
    renderPage('schedules')
    fireEvent.click(await screen.findByRole('button', { name: '编辑' }))
    const modal = await screen.findByRole('dialog', { name: '编辑定时任务' })
    await waitFor(() => expect(within(modal).queryByText('正在加载可用智能体与项目…')).toBeNull())
    fireEvent.click(within(modal).getByRole('combobox', { name: '绑定智能体' }))
    fireEvent.click(await screen.findByText('业务 B'))
    fireEvent.click(within(modal).getByRole('button', { name: '保存任务' }))
    await within(modal).findByText('此智能体当前不可使用所选技能，请重新选择。')
    expect(mockedApi.mock.calls.some(([path, options]) => path === '/api/admin/schedules/agent-plan' && options?.method === 'PATCH')).toBe(false)
  })

  it('requires explicit confirmation before submitting a real business execution', async () => {
    plans = [businessPlan]
    renderPage('schedules')
    fireEvent.click(await screen.findByRole('button', { name: '立即运行' }))
    const modal = await screen.findByRole('dialog', { name: '立即运行任务？' })
    expect(within(modal).getByText(/会立即执行真实业务操作/)).toBeTruthy()
    expect(mockedApi.mock.calls.some(([path]) => path.endsWith('/run'))).toBe(false)
    fireEvent.click(within(modal).getByRole('button', { name: '确认运行' }))
    await waitFor(() => expect(mockedApi).toHaveBeenCalledWith('/api/admin/schedules/business-plan/run', expect.objectContaining({ method: 'POST', body: {} })))
    expect(mockedApi.mock.calls.filter(([path]) => path.endsWith('/run'))).toHaveLength(1)
  })
})
