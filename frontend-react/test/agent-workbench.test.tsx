// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { api, ApiError } from '../src/lib/api'
import AgentWorkbench from '../src/components/AgentWorkbench'

vi.mock('../src/lib/api', async original => ({ ...await original<typeof import('../src/lib/api')>(), api: vi.fn() }))
vi.mock('lottie-web', () => ({ default: { loadAnimation: vi.fn(() => ({ destroy: vi.fn(), play: vi.fn(), pause: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() })) } }))
const mockedApi = vi.mocked(api)
const admin = { id: 'admin', username: 'admin', displayName: '管理员', role: 'admin' }
const member = { id: 'member', username: '009001', displayName: '示例员工001', role: 'member' }
const task = { id: 'task-one', sessionId: 'alpha', title: '核对提柜资料', instruction: '核对提柜时间及客户要求', status: 'waiting_human', createdBy: 'admin', createdByName: '管理员', assigneeId: 'admin', assigneeName: '管理员', createdAt: '2026-10-29T01:00:00Z', events: [{ id: 'e1', type: 'takeover', actorName: '管理员', content: '等待人工复核客户要求', createdAt: '2026-10-29T01:01:00Z' }] }
const document = { id: 'doc-one', title: '提柜操作规范', sourceName: 'pickup.md', updatedAt: '2026-10-29T01:00:00Z', version: 2, content: '客户确认后安排提柜。<script>window.fixtureLeak=true</script>' }
let currentTask: any, writes: Array<{ path: string; body: any }>
function renderWorkbench(props: Partial<React.ComponentProps<typeof AgentWorkbench>> = {}) { return render(<AgentWorkbench sessionId="alpha" user={admin} members={[admin, member]} onClose={vi.fn()} {...props} />) }
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => ({ matches: false, media: '', addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() })) })
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  Element.prototype.scrollIntoView = vi.fn()
})
beforeEach(() => {
  mockedApi.mockReset(); currentTask = { ...task }; writes = []
  mockedApi.mockImplementation(async (path, options = {}) => {
    if (options.method && options.method !== 'GET') {
      writes.push({ path, body: options.body })
      if (path.endsWith('/profile')) return { profile: options.body } as any
      if (path.endsWith('/knowledge') || path.endsWith('/knowledge/doc-one')) return { document: { ...document, ...options.body as any } } as any
      if (path.endsWith('/actions')) { const action = (options.body as any).action; currentTask = { ...currentTask, status: action === 'complete' ? 'succeeded' : action === 'resume' ? 'queued' : action === 'cancel' ? 'cancelled' : 'waiting_human' }; return { task: currentTask } as any }
      if (path.endsWith('/tasks')) return { task: { ...task, id: 'exact-created-task', title: '新提交的任务', status: 'queued' } } as any
    }
    if (path.endsWith('/profile')) return { profile: { groupId: 'alpha', roleName: '提柜专员', responsibilities: '提柜业务处理', rules: '客户确认后执行', workflow: '检查资料再提交', outputTemplate: '客户、柜号、时间', version: 4, updatedAt: '2026-10-29T01:00:00Z', updatedBy: 'admin', updatedByName: '管理员' } } as any
    if (path.endsWith('/tasks')) return { tasks: [currentTask] } as any
    if (path.endsWith('/tasks/task-one')) return { task: currentTask } as any
    if (path.includes('/knowledge?')) return { documents: [document], matches: path.includes('q=&') ? [] : [{ documentId: document.id, title: document.title, excerpt: '客户确认后安排提柜', sourceName: document.sourceName, updatedAt: document.updatedAt }] } as any
    if (path.endsWith('/knowledge/doc-one')) return { document } as any
    throw new Error(`Unexpected API ${path}`)
  })
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllTimers() })

describe('agent workbench business flows with real Semi components', () => {
  it('saves independent role fields and keeps ordinary members read only', async () => {
    const view = renderWorkbench({ initialTab: 'profile' })
    await screen.findByDisplayValue('提柜专员')
    fireEvent.change(screen.getByLabelText('业务规则'), { target: { value: '缺少客户授权时转交人工' } })
    fireEvent.click(screen.getByRole('button', { name: '保存岗位配置' }))
    await waitFor(() => expect(writes[0]).toMatchObject({ path: '/api/sessions/alpha/profile', body: { roleName: '提柜专员', rules: '缺少客户授权时转交人工', responsibilities: '提柜业务处理', workflow: '检查资料再提交', outputTemplate: '客户、柜号、时间', expectedVersion: 4 } }))
    view.rerender(<AgentWorkbench sessionId="alpha" user={member} members={[admin, member]} initialTab="profile" onClose={vi.fn()} />)
    await waitFor(() => expect((screen.getByLabelText('业务规则') as HTMLTextAreaElement).disabled).toBe(true))
    expect(screen.queryByRole('button', { name: '保存岗位配置' })).toBeNull()
  })

  it('treats new response-quality fields as optional guidance without overwriting old profile content', async () => {
    renderWorkbench({ initialTab: 'profile' }); await screen.findByDisplayValue('提柜专员')
    for (const label of ['服务对象', '常见任务', '完成标准', '合格回复示例']) expect((screen.getByLabelText(label) as HTMLTextAreaElement).value).toBe('')
    const examples = screen.getByLabelText('合格回复示例') as HTMLTextAreaElement
    expect(examples.placeholder).toContain('成功：'); expect(examples.placeholder).toContain('失败：'); expect(examples.placeholder).toContain('缺资料：')
    expect(examples.hasAttribute('required')).toBe(false); expect(examples.getAttribute('aria-describedby')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '保存岗位配置' }))
    await waitFor(() => expect(writes[0].body).toMatchObject({ roleName: '提柜专员', responsibilities: '提柜业务处理', audience: '', commonTasks: '', completionCriteria: '', responseExamples: '', expectedVersion: 4 }))
  })

  it('loads, edits and saves all response-quality fields with the loaded optimistic version', async () => {
    const original = mockedApi.getMockImplementation()!
    mockedApi.mockImplementation(async (path, options = {}) => path.endsWith('/profile') && !options.method ? { profile: { groupId: 'alpha', roleName: '提柜专员', rules: '不编造状态', audience: '客服与调度', commonTasks: '查询进度', completionCriteria: '核对真实业务结果', responseExamples: '已核对并交付清单。', version: 9 } } as any : original(path, options))
    renderWorkbench({ initialTab: 'profile' }); await screen.findByDisplayValue('客服与调度')
    const values = { '服务对象': '商务与客服员工', '常见任务': '核对柜号；生成异常清单', '完成标准': '真实结果可复查，附件已生成', '合格回复示例': '成功：已核对。\n失败：尚未完成。\n缺资料：请补日期。' }
    for (const [label, value] of Object.entries(values)) fireEvent.change(screen.getByLabelText(label), { target: { value } })
    fireEvent.click(screen.getByRole('button', { name: '保存岗位配置' }))
    await waitFor(() => expect(writes[0].body).toMatchObject({ roleName: '提柜专员', rules: '不编造状态', audience: values['服务对象'], commonTasks: values['常见任务'], completionCriteria: values['完成标准'], responseExamples: values['合格回复示例'], expectedVersion: 9 }))
  })

  it('preserves a new-field draft on a version conflict and keeps every new field read only for employees', async () => {
    const original = mockedApi.getMockImplementation()!
    mockedApi.mockImplementation((path, options = {}) => path.endsWith('/profile') && options.method === 'PATCH' ? Promise.reject(new ApiError('配置已被其他管理员更新，请刷新后再保存。', 409)) : original(path, options))
    const view = renderWorkbench({ initialTab: 'profile' }); await screen.findByDisplayValue('提柜专员')
    fireEvent.change(screen.getByLabelText('完成标准'), { target: { value: '保留尚未保存的完成标准' } });fireEvent.click(screen.getByRole('button', { name: '保存岗位配置' }))
    await screen.findByText('配置已被其他管理员更新，请刷新后再保存。');expect((screen.getByLabelText('完成标准') as HTMLTextAreaElement).value).toBe('保留尚未保存的完成标准')
    view.rerender(<AgentWorkbench sessionId="alpha" user={member} members={[admin, member]} initialTab="profile" onClose={vi.fn()}/>)
    await screen.findByDisplayValue('提柜专员');for (const label of ['服务对象', '常见任务', '完成标准', '合格回复示例']) expect((screen.getByLabelText(label) as HTMLTextAreaElement).disabled).toBe(true)
    expect(screen.queryByRole('button', { name: '保存岗位配置' })).toBeNull()
  })

  it('submits one queued task with a stable request id and opens the exact returned task', async () => {
    renderWorkbench()
    fireEvent.click(await screen.findByRole('button', { name: '创建业务任务' }))
    fireEvent.change(screen.getByLabelText('工作要求'), { target: { value: '检查明天提柜安排并生成清单' } })
    fireEvent.click(screen.getByRole('button', { name: '提交任务' }))
    fireEvent.click(screen.getByRole('button', { name: '提交任务' }))
    await waitFor(() => expect(writes.filter(write => write.path.endsWith('/tasks'))).toHaveLength(1))
    expect(writes[0].body).toMatchObject({ instruction: '检查明天提柜安排并生成清单', clientRequestId: expect.any(String) })
    const detail = screen.getByRole('region', { name: '业务任务详情' })
    expect(within(detail).getByRole('heading', { name: '新提交的任务' })).toBeTruthy()
    expect(within(detail).getByText('排队中')).toBeTruthy()
  })

  it('shows task history and requires an actual result before manual completion', async () => {
    renderWorkbench()
    fireEvent.click(await screen.findByRole('button', { name: /核对提柜资料/ }))
    await screen.findByText('等待人工复核客户要求')
    fireEvent.click(screen.getByRole('button', { name: '人工完成' }))
    fireEvent.click(screen.getByRole('button', { name: '确认人工完成' }))
    await screen.findByText('请填写处理结果，再标记人工完成。')
    expect(writes).toHaveLength(0)
    fireEvent.change(screen.getByLabelText('人工处理结果'), { target: { value: '已联系客户，确认明早 9 点提柜。' } })
    fireEvent.click(screen.getByRole('button', { name: '确认人工完成' }))
    await waitFor(() => expect(writes[0]).toEqual({ path: '/api/sessions/alpha/tasks/task-one/actions', body: { action: 'complete', content: '已联系客户，确认明早 9 点提柜。' } }))
    await within(screen.getByRole('region', { name: '业务任务详情' })).findByText('已完成')
  })

  it('requires checking interrupted side effects and does not offer automatic rerun for failure', async () => {
    currentTask = { ...task, status: 'interrupted' }
    const view = renderWorkbench()
    fireEvent.click(await screen.findByRole('button', { name: /核对提柜资料/ }))
    fireEvent.click(await screen.findByRole('button', { name: '恢复 AI 处理' }))
    expect((screen.getByRole('button', { name: '确认恢复 AI 处理' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: /我已核对已有操作/ }))
    fireEvent.click(screen.getByRole('button', { name: '确认恢复 AI 处理' }))
    await waitFor(() => expect(writes[0].body).toEqual({ action: 'resume' }))
    currentTask = { ...task, status: 'failed' }
    view.unmount(); renderWorkbench()
    fireEvent.click(await screen.findByRole('button', { name: /核对提柜资料/ }))
    expect(screen.queryByRole('button', { name: '恢复 AI 处理' })).toBeNull()
  })

  it('searches knowledge, previews provenance safely and hides writes from employees', async () => {
    renderWorkbench({ user: member, initialTab: 'knowledge' })
    await screen.findByRole('tab', { name: '知识库（1）' })
    expect(screen.queryByRole('button', { name: '添加知识资料' })).toBeNull()
    fireEvent.change(screen.getByLabelText('检索知识库'), { target: { value: '提柜' } })
    fireEvent.click(screen.getByRole('button', { name: '检索' }))
    await screen.findByText(/找到 1 个相关片段/)
    fireEvent.click(screen.getByRole('button', { name: /提柜操作规范/ }))
    await screen.findByText(document.content)
    expect(screen.getByText(/版本 2/)).toBeTruthy()
    expect(globalThis.document.querySelector('script')).toBeNull()
    expect(screen.queryByRole('button', { name: '编辑资料' })).toBeNull()
  })

  it('clears all loaded private content on loss of membership', async () => {
    renderWorkbench()
    fireEvent.click(await screen.findByRole('button', { name: /核对提柜资料/ }))
    await screen.findByText('等待人工复核客户要求')
    mockedApi.mockRejectedValue(new ApiError('已被移出群聊', 403))
    fireEvent.click(screen.getByRole('button', { name: '刷新任务' }))
    await screen.findByText('登录已失效或已不在此群，工作台内容已清除。请关闭后重新进入。')
    expect(screen.queryByText('等待人工复核客户要求')).toBeNull()
    expect(screen.queryByRole('button', { name: /核对提柜资料/ })).toBeNull()
    expect(screen.queryByRole('tab')).toBeNull()
  })

  it('imports only UTF-8 text knowledge and submits the provenance with its contents', async () => {
    renderWorkbench({ initialTab: 'knowledge' })
    fireEvent.click(await screen.findByRole('button', { name: '添加知识资料' }))
    fireEvent.change(screen.getByLabelText('上传文本文件'), { target: { files: [new File(['invalid'], 'prices.xlsx')] } })
    await screen.findByText('请上传 TXT、Markdown、CSV 或 JSON 文件。')
    expect(writes).toHaveLength(0)
    const file = new File(['柜号,时间\nABCD,09:00'], 'pickup.csv', { type: 'text/csv' })
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode('柜号,时间\nABCD,09:00').buffer })
    fireEvent.change(screen.getByLabelText('上传文本文件'), { target: { files: [file] } })
    await screen.findByDisplayValue('pickup.csv')
    fireEvent.click(screen.getByRole('button', { name: '保存知识资料' }))
    await waitFor(() => expect(writes[0]).toEqual({ path: '/api/sessions/alpha/knowledge', body: { title: 'pickup', sourceName: 'pickup.csv', content: '柜号,时间\nABCD,09:00', purpose: 'business', expectedVersion: 0 } }))
  })

  it('lets only administrators choose a versioned document purpose while preserving text and provenance', async () => {
    renderWorkbench({ initialTab: 'knowledge' });fireEvent.click(await screen.findByRole('button', { name: /提柜操作规范/ }));fireEvent.click(await screen.findByRole('button', { name: '编辑资料' }))
    fireEvent.click(screen.getByLabelText('资料用途'));fireEvent.click(await screen.findByText('开发说明', { selector: '.semi-select-option-text' }));fireEvent.click(screen.getByRole('button', { name: '保存知识资料' }))
    await waitFor(() => expect(writes[0]).toEqual({ path: '/api/sessions/alpha/knowledge/doc-one', body: { title: document.title, sourceName: document.sourceName, content: document.content, purpose: 'development', expectedVersion: 2 } }))
    expect(await screen.findByText('用途：开发说明', { exact: false })).toBeTruthy()
  })

  it('keeps development documentation visible to members without exposing the purpose editor', async () => {
    const original = mockedApi.getMockImplementation()!
    mockedApi.mockImplementation(async (path, options = {}) => path.endsWith('/knowledge/doc-one') && !options.method ? { document: { ...document, purpose: 'development' } } as any : original(path, options))
    renderWorkbench({ user: member, initialTab: 'knowledge' });fireEvent.click(await screen.findByRole('button', { name: /提柜操作规范/ }))
    await screen.findByText(document.content);expect(screen.getByText('用途：开发说明', { exact: false })).toBeTruthy()
    expect(screen.queryByLabelText('资料用途')).toBeNull();expect(screen.queryByRole('button', { name: '编辑资料' })).toBeNull()
  })

  it('keeps a knowledge draft on concurrent update conflict and sends the loaded version', async () => {
    renderWorkbench({ initialTab: 'knowledge' })
    fireEvent.click(await screen.findByRole('button', { name: /提柜操作规范/ }))
    fireEvent.click(await screen.findByRole('button', { name: '编辑资料' }))
    fireEvent.change(screen.getByLabelText('知识正文'), { target: { value: '正在整理的新版要求' } })
    const original = mockedApi.getMockImplementation()!
    mockedApi.mockImplementation((path, options = {}) => options.method === 'PATCH' ? Promise.reject(new ApiError('配置已被其他管理员更新，请刷新后再保存。', 409)) : original(path, options))
    fireEvent.click(screen.getByRole('button', { name: '保存知识资料' }))
    await screen.findByText('配置已被其他管理员更新，请刷新后再保存。')
    expect((screen.getByLabelText('知识正文') as HTMLTextAreaElement).value).toBe('正在整理的新版要求')
    expect(mockedApi).toHaveBeenCalledWith('/api/sessions/alpha/knowledge/doc-one', expect.objectContaining({ body: expect.objectContaining({ expectedVersion: 2 }) }))
  })

  it('ignores a slow detail response after switching to another group', async () => {
    let release!: (data: any) => void
    const defaultApi = mockedApi.getMockImplementation()!
    mockedApi.mockImplementation((path, options) => path.endsWith('/tasks/task-one') ? new Promise(resolve => { release = resolve }) : defaultApi(path, options))
    const view = renderWorkbench()
    fireEvent.click(await screen.findByRole('button', { name: /核对提柜资料/ }))
    await waitFor(() => expect(release).toBeTypeOf('function'))
    mockedApi.mockImplementation(async path => path.endsWith('/profile') ? { profile: {} } as any : path.includes('/knowledge?') ? { documents: [], matches: [] } as any : { tasks: [] } as any)
    view.rerender(<AgentWorkbench sessionId="beta" user={admin} members={[admin]} onClose={vi.fn()} />)
    await screen.findByText('暂无业务任务，可创建任务或在群内请 AI 处理工作。')
    await act(async () => release({ task: { ...task, result: '旧群私有结果不可泄露' } }))
    expect(screen.queryByText('旧群私有结果不可泄露')).toBeNull()
  })
})
