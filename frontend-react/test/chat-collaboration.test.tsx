// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import ChatView from '../src/ChatView'
import { workspace } from '../src/lib/workspace'
import {useState} from 'react'

vi.mock('lottie-web', () => ({ default: { loadAnimation: vi.fn(() => ({ destroy: vi.fn(), play: vi.fn(), pause: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() })) } }))
const { state, apiMock, uploadMock, sendMock, collaborateMock, listeners } = vi.hoisted(() => ({ state: { value: {} as any }, apiMock: vi.fn(), uploadMock: vi.fn(), sendMock: vi.fn(), collaborateMock: vi.fn(), listeners: new Set<() => void>() }))
vi.mock('../src/lib/api', async original => ({ ...await original<any>(), api: apiMock, uploadChatAttachment: uploadMock }))
vi.mock('../src/lib/workspace', async () => {
  const { useSyncExternalStore } = await import('react')
  const patch = (value: any) => { state.value = { ...state.value, ...value }; listeners.forEach(listener => listener()) }
  const store = {
    get state() { return state.value }, get isAdmin() { return state.value.user?.role === 'admin' },
    get active() { return !!state.value.running || !!state.value.current?.running }, get canStop() { return false },
    send: sendMock, collaborate: collaborateMock, markRead: vi.fn(async()=>{}), patch,
    setDraft: (id: string, value: string) => patch({ drafts: { ...state.value.drafts, [id]: value } }),
    setSkill: (value: string) => patch({ selectedSkill: value }),
    toast: vi.fn(), refreshSessions: vi.fn(async () => {}), applySession: (current: any) => patch({ current }),
    navigate: vi.fn(), synchronize: vi.fn(), stop: vi.fn(), forget: vi.fn(),
  }
  return { workspace: store, useWorkspace: () => useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => state.value) }
})
const employee = { id: 'employee', displayName: '业务同事', username: '003009', role: 'member' }
const coworker = { id: 'coworker', displayName: '同事小敏', username: '003010', role: 'member' }
const admin = { id: 'admin', displayName: '管理员', username: 'admin', role: 'admin' }
const group = { id: 'alpha', title: '报价助手', ownerId: admin.id, revision: 1, running: false, mode: 'workspace' }
function ChatHarness({initialDetails=true}:{initialDetails?:boolean}){const [details,setDetails]=useState(initialDetails);return <ChatView detailsOpen={details} onToggleDetails={()=>setDetails(value=>!value)} onOpenAgents={vi.fn()} onSettings={vi.fn()}/>}
function renderChat(initialDetails=true) { return render(<ChatHarness initialDetails={initialDetails}/>) }
function input() { return screen.getByRole('textbox', { name: '发送给报价助手的任务' }) }
beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn((query:string) => ({ matches: !query.includes('max-width: 1280px'), addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true } })))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  state.value = { user: employee, current: group, sessions: [group], messages: [], skills: [], selectedSkill: '', view: 'chat', status: { configured: true, capabilities: { collaboration: true } }, online: true, loading: false, running: false, stopping: false, submitting: false, chatError: '', drafts: { alpha: '' } }
  apiMock.mockReset(); uploadMock.mockReset(); sendMock.mockReset().mockResolvedValue(true); collaborateMock.mockReset().mockResolvedValue(true)
  apiMock.mockImplementation((path: string) => Promise.resolve(path.endsWith('/members') ? { members: [admin, employee, coworker], externalMembers: [], ownerId: admin.id, canRemoveMembers: false, canLeave: true }
    : path.endsWith('/channels') ? { channels: [] } : path.endsWith('/profile') ? { profile: { roleName: '业务报价专员', responsibilities: '报价资料处理', rules: '', workflow: '', outputTemplate: '', version: 1 } }
    : path.endsWith('/tasks') ? { tasks: [] } : path.includes('/knowledge?') ? { documents: [], matches: [] } : {}))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('real Semi group collaboration flows', () => {
  it('marks only the visible bottom of the conversation read and preserves arrivals while viewing older messages',async()=>{
    const focus=vi.spyOn(document,'hasFocus').mockReturnValue(true)
    Object.defineProperty(document,'hidden',{configurable:true,value:false})
    const mark=vi.mocked(workspace.markRead);mark.mockClear()
    state.value.current={...group,attentionCursor:10};renderChat(false)
    await waitFor(()=>expect(mark).toHaveBeenCalledWith('alpha',10))
    const scroller=document.querySelector('.conversation-scroll') as HTMLElement
    Object.defineProperty(scroller,'scrollHeight',{configurable:true,value:2000});Object.defineProperty(scroller,'clientHeight',{configurable:true,value:400});scroller.scrollTop=0
    fireEvent.scroll(scroller)
    act(()=>workspace.patch({current:{...state.value.current,attentionCursor:11},messages:[{id:'new',role:'assistant',content:'New result'}]}))
    await new Promise(resolve=>setTimeout(resolve,50));expect(mark).not.toHaveBeenCalledWith('alpha',11)
    scroller.scrollTop=1600;fireEvent.scroll(scroller)
    await waitFor(()=>expect(mark).toHaveBeenCalledWith('alpha',11));focus.mockRestore()
  })
  it('opens one contextual panel at a time and locates a file without losing the draft', async () => {
    const id='11111111-1111-4111-8111-111111111111',url=`/api/sessions/alpha/attachments/${id}`
    state.value.messages=[{role:'user',id:'file-message',authorId:coworker.id,authorName:coworker.displayName,content:'附件',attachments:[{id,url,downloadUrl:`${url}?download=1`,name:'预约清单.csv',size:18,mimeType:'text/csv',kind:'file'}]}]
    renderChat(false)
    expect(screen.queryByRole('complementary')).toBeNull()
    fireEvent.change(input(),{target:{value:'保留待发送任务'}})
    fireEvent.click(screen.getByRole('button',{name:'文件',exact:true}))
    const files=screen.getByRole('complementary',{name:'会话文件'})
    expect(within(files).getByRole('link',{name:'下载文件：预约清单.csv'})).toBeTruthy()
    fireEvent.change(within(files).getByRole('textbox',{name:'搜索会话文件'}),{target:{value:'没有'}})
    expect(within(files).getByText('没有匹配的文件')).toBeTruthy()
    fireEvent.click(screen.getByRole('button',{name:'展开群成员'}))
    expect(screen.queryByRole('complementary',{name:'会话文件'})).toBeNull()
    await screen.findByRole('textbox',{name:'搜索群成员'})
    fireEvent.click(screen.getByRole('button',{name:'文件',exact:true}))
    fireEvent.click(screen.getByRole('button',{name:'定位文件消息：预约清单.csv'}))
    await waitFor(()=>expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled())
    expect(screen.queryByRole('complementary')).toBeNull()
    expect((input() as HTMLTextAreaElement).value).toBe('保留待发送任务')
  })

  it('searches within the current conversation and closes the inline panel after locating a result', async () => {
    apiMock.mockImplementation((path:string)=>Promise.resolve(path.includes('/search?')?{results:[{role:'user',content:'核对预约',messageIndex:0,authorName:'同事小敏'}],total:1}:{members:[admin,employee,coworker],canLeave:true}))
    state.value.messages=[{role:'user',id:'source',content:'核对预约',authorId:coworker.id,authorName:coworker.displayName}]
    renderChat(false)
    fireEvent.click(screen.getByRole('button',{name:'查找聊天记录'}))
    const search=screen.getByRole('complementary',{name:'查找聊天记录'})
    fireEvent.change(within(search).getByRole('searchbox',{name:'聊天记录关键词'}),{target:{value:'预约'}})
    const result=await within(search).findByRole('button',{name:/定位到消息/})
    expect(apiMock.mock.calls.some(([path])=>path==='/api/sessions/alpha/search?q=%E9%A2%84%E7%BA%A6&limit=30&offset=0')).toBe(true)
    fireEvent.click(result)
    expect(screen.queryByRole('complementary')).toBeNull()
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled()
  })

  it('closes the contextual panel with Escape even when the global navigation has menu semantics', async () => {
    render(<nav role="menu" aria-label="工作台分类">导航</nav>)
    renderChat(false)
    fireEvent.click(screen.getByRole('button',{name:'查找聊天记录'}))
    expect(screen.getByRole('complementary',{name:'查找聊天记录'})).toBeTruthy()
    fireEvent.keyDown(window,{key:'Escape'})
    expect(screen.queryByRole('complementary')).toBeNull()
  })

  it('keeps the right sidebar for group members and moves administrator configuration to management', async () => {
    state.value.user = admin
    state.value.skills = [{ id: 'browser', name: 'ego-browser', description: 'Long technical skill instructions' }]
    renderChat()
    const sidebar = screen.getByRole('complementary', { name: '群成员与邀请' })
    await within(sidebar).findByText('同事小敏')
    expect(within(sidebar).getByRole('button', { name: '邀请成员' })).toBeTruthy()
    expect(within(sidebar).queryByText('专业技能')).toBeNull()
    expect(within(sidebar).queryByText('智能体工作台')).toBeNull()
    expect(within(sidebar).queryByText('Long technical skill instructions')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '打开智能体工作台' }))
    const dialog = await screen.findByRole('dialog', { name: '智能体工作台' })
    fireEvent.click(within(dialog).getByRole('tab', { name: '岗位规范' }))
    expect(within(dialog).queryByRole('button', { name: '保存岗位配置' })).toBeNull()
    expect((within(dialog).getByLabelText('岗位职责') as HTMLTextAreaElement).disabled).toBe(true)
  })

  it('sends file-only discussion as IDs, retains it on rejected send, and clears only after acceptance', async () => {
    const file = new File(['fixture csv'], '预约清单.csv', { type: 'text/csv' }), id = '11111111-1111-4111-8111-111111111111', url = `/api/sessions/alpha/attachments/${id}`
    let uploaded!: (value: any) => void
    uploadMock.mockReturnValue(new Promise(resolve => { uploaded = resolve }))
    collaborateMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    renderChat(); fireEvent.click(screen.getByRole('radio', { name: '群内讨论' }))
    fireEvent.change(screen.getByLabelText('选择聊天附件'), { target: { files: [file] } })
    const send = () => screen.getByRole('button', { name: '发送讨论' }) as HTMLButtonElement
    expect(send().disabled).toBe(true)
    fireEvent.keyDown(input(), { key: 'Enter', keyCode: 13 }); expect(collaborateMock).not.toHaveBeenCalled()
    await act(async () => uploaded({ id, name: file.name, size: file.size, mimeType: 'text/csv', kind: 'file', url, downloadUrl: `${url}?download=1` }))
    expect(send().disabled).toBe(false); fireEvent.click(send())
    await waitFor(() => expect(collaborateMock).toHaveBeenCalledWith('', { mode: 'discussion', replyTo: undefined, mentions: [], attachmentIds: [id] }))
    expect(screen.getByRole('region', { name: '待发送附件' })).toBeTruthy()
    fireEvent.click(send()); await waitFor(() => expect(screen.queryByRole('region', { name: '待发送附件' })).toBeNull())
    expect(sendMock).not.toHaveBeenCalled(); expect(uploadMock).toHaveBeenCalledOnce()
  })

  it('keeps attachment IDs alongside the selected quote and AI task mode', async () => {
    const id = '22222222-2222-4222-8222-222222222222', file = new File(['image'], '回执.png', { type: 'image/png' }), url = `/api/sessions/alpha/attachments/${id}`
    uploadMock.mockResolvedValue({ id, name: file.name, size: file.size, mimeType: file.type, kind: 'image', url, downloadUrl: `${url}?download=1` })
    state.value.messages = [{ id: 'source-1', role: 'user', authorId: coworker.id, authorName: coworker.displayName, content: '请核对这份回执' }]
    renderChat(); fireEvent.click(screen.getByRole('button', { name: '引用同事小敏的消息' }))
    fireEvent.change(screen.getByLabelText('选择聊天附件'), { target: { files: [file] } })
    await waitFor(() => expect((screen.getByRole('button', { name: '提交任务' }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: '提交任务' }))
    await waitFor(() => expect(collaborateMock).toHaveBeenCalledWith('', { mode: 'agent', replyTo: 'source-1', mentions: [], attachmentIds: [id] }))
    expect(collaborateMock.mock.calls[0][1]).not.toHaveProperty('attachments')
    await waitFor(() => expect(screen.queryByRole('button', { name: '取消引用回复' })).toBeNull())
  })

  it('switches between discussion and AI task mode through the collaboration endpoint', async () => {
    renderChat()
    fireEvent.click(screen.getByRole('radio', { name: '群内讨论' }))
    fireEvent.change(input(), { target: { value: '同事们核对一下客户地址' } })
    fireEvent.click(screen.getByRole('button', { name: '发送讨论' }))
    await waitFor(() => expect(collaborateMock).toHaveBeenCalledExactlyOnceWith('同事们核对一下客户地址', { mode: 'discussion', replyTo: undefined, mentions: [] }))
    collaborateMock.mockClear()
    fireEvent.click(screen.getByRole('radio', { name: '交给 AI' }))
    fireEvent.change(input(), { target: { value: '请整理报价清单' } })
    fireEvent.keyDown(input(), { key: 'Enter', keyCode: 13 })
    await waitFor(() => expect(collaborateMock).toHaveBeenCalledExactlyOnceWith('请整理报价清单', { mode: 'agent', replyTo: undefined, mentions: [] }))
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('selects coworkers and the agent with the genuine Semi multi-select', async () => {
    renderChat()
    fireEvent.click(screen.getByRole('radio', { name: '群内讨论' }))
    fireEvent.click(screen.getByRole('button', { name: '提及成员' }))
    const mention = await screen.findByRole('combobox', { name: '提及协作成员或智能体' })
    fireEvent.click(mention)
    fireEvent.click(await screen.findByRole('option', { name: /@同事小敏/ }))
    fireEvent.click(await screen.findByRole('option', { name: /@智能体/ }))
    fireEvent.click(screen.getByRole('button', {name:'关闭提及选择'}))
    fireEvent.change(input(), { target: { value: '整理我们讨论的地址变更要求' } })
    fireEvent.click(screen.getByRole('button', { name: '提交任务' }))
    await waitFor(() => expect(collaborateMock).toHaveBeenCalledWith('整理我们讨论的地址变更要求', { mode: 'discussion', replyTo: undefined, mentions: ['coworker', 'agent'] }))
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('references the original server message id and never submits a client quote snapshot', async () => {
    state.value.messages = [{ id: 'server-source-message-7', role: 'user', authorId: coworker.id, authorName: coworker.displayName, content: '柜号 ABCD 的地址需要确认' }]
    renderChat()
    fireEvent.click(screen.getByRole('button', { name: '引用同事小敏的消息' }))
    expect(screen.getByText('回复 同事小敏')).toBeTruthy()
    fireEvent.change(input(), { target: { value: '请按新地址生成费用明细' } })
    fireEvent.click(screen.getByRole('button', { name: '提交任务' }))
    await waitFor(() => expect(collaborateMock).toHaveBeenCalledExactlyOnceWith('请按新地址生成费用明细', { mode: 'agent', replyTo: 'server-source-message-7', mentions: [] }))
    expect(collaborateMock.mock.calls[0][1]).not.toHaveProperty('replySnapshot')
    expect(collaborateMock.mock.calls[0][1]).not.toHaveProperty('messageIndex')
    await waitFor(() => expect(screen.queryByRole('button', { name: '取消引用回复' })).toBeNull())
  })

  it('queues during an existing run while preventing repeated submission in flight', async () => {
    state.value.current = { ...group, running: true, activeUserName: coworker.displayName }
    state.value.drafts.alpha = '把这项工作排队处理'
    let release!: (result: boolean) => void
    collaborateMock.mockImplementation(() => { workspace.patch({ submitting: true }); return new Promise<boolean>(resolve => { release = resolve }) })
    renderChat()
    const submit = screen.getByRole('button', { name: '提交任务' })
    expect((submit as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(submit)
    await waitFor(() => expect((screen.getByRole('button', { name: '提交任务' }) as HTMLButtonElement).disabled).toBe(true))
    fireEvent.keyDown(input(), { key: 'Enter', keyCode: 13 })
    fireEvent.submit(input().closest('form')!)
    expect(collaborateMock).toHaveBeenCalledTimes(1)
    expect(sendMock).not.toHaveBeenCalled()
    await act(async () => { workspace.patch({ submitting: false }); release(true) })
  })

  it('lets employees open the workbench and view role and knowledge without administrator writes', async () => {
    renderChat()
    fireEvent.click(screen.getByRole('button', { name: '打开智能体工作台' }))
    const dialog = await screen.findByRole('dialog', { name: '智能体工作台' })
    fireEvent.click(await within(dialog).findByRole('tab', { name: '岗位规范' }))
    await within(dialog).findByDisplayValue('业务报价专员')
    expect((within(dialog).getByLabelText('岗位职责') as HTMLTextAreaElement).disabled).toBe(true)
    expect(within(dialog).queryByRole('button', { name: '保存岗位配置' })).toBeNull()
    fireEvent.click(within(dialog).getByRole('tab', { name: '知识库（0）' }))
    expect(within(dialog).queryByRole('button', { name: '添加知识资料' })).toBeNull()
    expect(screen.queryByRole('button', { name: '配置岗位职责与规范' })).toBeNull()
  })

  it('keeps completed work-task results visible while a legacy run is still processing', () => {
    state.value.current = { ...group, running: true }
    state.value.messages = [
      { id: 'request-one', role: 'user', content: '查询提柜资料', authorId: employee.id, authorName: employee.displayName },
      { id: 'legacy-working', role: 'assistant', content: '旧流式中间输出应隐藏' },
      { id: 'work-result', workTaskId: 'durable-work-task', role: 'assistant', content: '任务已核对，业务清单已生成' },
    ]
    renderChat()
    expect(screen.getByText('任务已核对，业务清单已生成')).toBeTruthy()
    expect(screen.getByRole('button', { name: '业务任务 · 查看进度与协作' })).toBeTruthy()
    expect(screen.queryByText('旧流式中间输出应隐藏')).toBeNull()
  })

  it('keeps coworker message text and quoted HTML inert', () => {
    const unsafe = '<img src=x onerror=alert(1)> [危险链接](javascript:alert(1))'
    state.value.messages = [{ id: 'safe-server-message', role: 'user', authorId: coworker.id, authorName: coworker.displayName, content: unsafe, replyTo: 'source-old', replySnapshot: { authorName: '<script>恶意姓名</script>', content: '<svg onload=alert(1)>引用原文</svg>' } }]
    renderChat()
    expect(screen.getByText(unsafe)).toBeTruthy()
    expect(screen.getByText('<svg onload=alert(1)>引用原文</svg>')).toBeTruthy()
    expect(document.querySelector('script,[onerror],[onload],a[href^="javascript:"]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '引用同事小敏的消息' }))
    expect(document.querySelector('.composer-reply')?.textContent).toContain(unsafe)
    expect(document.querySelector('script,[onerror],[onload],a[href^="javascript:"]')).toBeNull()
  })

  it('opens the exact task from its card even when that task is outside the current list', async () => {
    state.value.messages = [{ id: 'server-card-message', role: 'assistant', workTaskId: 'outside-list-task', content: '提柜清单已整理。', cards: [{ version: 1, id: 'work-card-one', kind: 'task_result', title: '提柜清单任务', status: 'succeeded', taskId: 'outside-list-task', taskKind: 'work' }] }]
    const normal = apiMock.getMockImplementation()!
    apiMock.mockImplementation((path: string, options: unknown) => path.endsWith('/tasks/outside-list-task') ? Promise.resolve({ task: { id: 'outside-list-task', sessionId: 'alpha', title: '准确打开的历史任务', instruction: '整理提柜清单', status: 'succeeded', createdBy: employee.id, result: '实际历史交付结果', events: [] } }) : normal(path, options))
    renderChat()
    expect(screen.queryByRole('button', { name: '业务任务 · 查看进度与协作' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '查看任务' }))
    const dialog = await screen.findByRole('dialog', { name: '智能体工作台' })
    await within(dialog).findByRole('heading', { name: '准确打开的历史任务' })
    expect(within(dialog).getByText('实际历史交付结果')).toBeTruthy()
    expect(apiMock.mock.calls.some(([path]) => path === '/api/sessions/alpha/tasks/outside-list-task')).toBe(true)
  })

  it('shows the answer without knowledge cards or message-source requests', async () => {
    const oldSource = { documentId: 'old-source', title: '客户要求', sourceName: 'customer.md', version: 1, updatedAt: '2026-10-29T01:00:00Z', excerpt: '回答时提供的旧版客户要求', cited: true }
    state.value.messages = [{ id: 'server-knowledge-message', role: 'assistant', content: '已根据客户要求整理。', cards: [{ version: 1, id: 'source-card-one', kind: 'knowledge', title: '回答参考资料', sources: [oldSource] }] }]
    renderChat()
    expect(screen.getByText('已根据客户要求整理。')).toBeTruthy()
    await waitFor(() => expect(apiMock.mock.calls.some(([path]) => path.endsWith('/members'))).toBe(true))
    expect(screen.queryByRole('region', { name: '回答参考资料' })).toBeNull()
    expect(screen.queryByText('回答时提供的旧版客户要求')).toBeNull()
    expect(screen.queryByRole('button', { name: /查看来源/ })).toBeNull()
    expect(screen.queryByRole('dialog', { name: '智能体工作台' })).toBeNull()
    expect(apiMock.mock.calls.some(([path]) => path.includes('/message-cards/'))).toBe(false)
  })
})
