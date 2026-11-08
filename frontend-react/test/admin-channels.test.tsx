// @vitest-environment jsdom
import * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import AdministrationPage from '../src/pages/AdministrationPage'
import ChannelsPage from '../src/pages/ChannelsPage'

const { apiMock, toastSuccess } = vi.hoisted(() => ({ apiMock: vi.fn(), toastSuccess: vi.fn() }))
vi.mock('../src/lib/api', () => ({ api: apiMock, errorMessage: (error: unknown) => error instanceof Error ? error.message : '操作失败' }))
vi.mock('../src/components/UserAvatar', () => ({ default: ({ name }: { name: string }) => <span aria-hidden="true" data-testid="user-avatar">{name.slice(0, 1)}</span> }))
vi.mock('../src/lib/artwork', () => ({ channelIdentity: (type: string) => ({ label: type === 'wecom' ? '企业微信' : '个人微信', src: `/assets/${type}.svg` }) }))
// The adapters retain input, form, table and dialog semantics. These tests cover
// application requests and async races; the real Semi rendering is browser QA.
vi.mock('@douyinfe/semi-ui', () => ({
  Banner: ({ description }: any) => <div role="alert">{description}</div>,
  Button: ({ children, htmlType = 'button', loading, theme, block, size, type, ...props }: any) => <button {...props} type={htmlType} disabled={props.disabled || loading}>{children}</button>,
  Input: ({ value, onChange, showClear, ...props }: any) => <input {...props} value={value ?? ''} onChange={event => onChange?.(event.target.value, event)} />,
  Select: ({ value, onChange, optionList = [], placeholder, ...props }: any) => <select {...props} value={value ?? ''} onChange={event => onChange?.(event.target.value)}>{placeholder && <option value="">{placeholder}</option>}{optionList.map((option: any) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>,
  Modal: ({ visible, title, children, onCancel }: any) => visible ? <div role="dialog" aria-label={typeof title === 'string' ? title : '配置窗口'}><h2>{title}</h2><button type="button" onClick={onCancel} aria-label="关闭窗口">关闭</button>{children}</div> : null,
  Checkbox: ({ checked, onChange, ...props }: any) => <input {...props} type="checkbox" checked={Boolean(checked)} onChange={onChange} />,
  Tag: ({ children }: any) => <span>{children}</span>,
  Spin: () => <span role="progressbar">加载中</span>,
  Table: ({ columns, dataSource, loading, empty }: any) => <div>{loading && <span role="progressbar">加载中</span>}<table><thead><tr>{columns.map((column: any, index: number) => <th key={index}>{column.title}</th>)}</tr></thead><tbody>{dataSource.map((item: any) => <tr key={item.id}>{columns.map((column: any, index: number) => <td key={index}>{column.render ? column.render(item[column.dataIndex], item) : item[column.dataIndex]}</td>)}</tr>)}</tbody></table>{!dataSource.length && empty}</div>,
  Pagination: ({ currentPage, pageSize, total, onPageChange }: any) => <nav aria-label="分页"><button disabled={currentPage <= 1} onClick={() => onPageChange(currentPage - 1)}>上一页</button><span>{currentPage}</span><button disabled={currentPage * pageSize >= total} onClick={() => onPageChange(currentPage + 1)}>下一页</button></nav>,
  Toast: { success: toastSuccess },
}))

const admin = { id: 'admin', username: 'admin', displayName: '管理员', role: 'admin' }
const employee = { id: 'employee', username: 'employee', displayName: '同事', role: 'member', disabled: false }
const sessions = [{ id: 'group-a', title: '智能体A' }, { id: 'group-b', title: '智能体B' }]
const weixin = { id: 'wechat-a', type: 'weixin', name: '微信渠道', enabled: true, status: 'idle', connected: false }
const wecom = { id: 'wecom-a', type: 'wecom', name: '企微渠道', enabled: true, status: 'connected', connected: true, botId: 'original-bot', secretSet: true, target: { id: 'external-a', chatType: 'group' } }
const webhook = { id: 'webhook-a', type: 'wecom', name: '企微通知', enabled: true, status: 'configured', connected: false, canSend: true, connectionMode: 'webhook', replyMode: 'webhook', webhookSet: true }
const testWebhookUrl = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=fixture-not-a-real-webhook'
const defer = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
async function flush() { await act(async () => { for (let index = 0; index < 12; index++) await Promise.resolve() }) }
async function advance(milliseconds: number) { await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds) }) }
beforeEach(() => { apiMock.mockReset(); toastSuccess.mockReset() })
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('Administration page requests and stale response handling', () => {
  it('discards an old member-directory response after switching to operation records', async () => {
    const old = defer<any>()
    apiMock.mockImplementation((path: string) => path === '/api/admin/users' ? old.promise : Promise.resolve({ events: [{ id: 1, action: 'config.updated', actorName: '真实操作人' }] }))
    const page = render(<AdministrationPage view="users" user={admin} />)
    page.rerender(<AdministrationPage view="events" user={admin} />)
    await flush()
    expect(screen.getByText('真实操作人')).toBeTruthy()
    old.resolve({ users: [employee] }); await flush()
    expect(screen.queryByText('同事')).toBeNull()
    expect(screen.getByText('真实操作人')).toBeTruthy()
  })

  it('keeps audit detail B when the older detail A arrives later', async () => {
    const old = defer<any>()
    apiMock.mockImplementation((path: string) => {
      if (path === '/api/admin/users') return Promise.resolve({ users: [admin] })
      if (path.startsWith('/api/admin/sessions?')) return Promise.resolve({ sessions, total: 2 })
      if (path.endsWith('/group-a')) return old.promise
      return Promise.resolve({ session: sessions[1], messages: [{ role: 'assistant', content: '只显示智能体B的真实记录' }] })
    })
    render(<AdministrationPage view="audit" user={admin} />); await flush()
    fireEvent.click(screen.getByRole('button', { name: /智能体A/ })); fireEvent.click(screen.getByRole('button', { name: /智能体B/ })); await flush()
    expect(screen.getByText('只显示智能体B的真实记录')).toBeTruthy()
    old.resolve({ session: sessions[0], messages: [{ content: '不应出现的旧A记录' }] }); await flush()
    expect(screen.queryByText('不应出现的旧A记录')).toBeNull()
    expect(screen.getByRole('link', { name: '导出记录' }).getAttribute('href')).toBe('/api/admin/sessions/group-b/export')
  })

  it('paginates against the submitted audit filter rather than unsaved text changes', async () => {
    apiMock.mockImplementation((path: string) => path === '/api/admin/users' ? Promise.resolve({ users: [] }) : Promise.resolve({ sessions: path.includes('offset=1') ? [sessions[1]] : [sessions[0]], total: 2 }))
    render(<AdministrationPage view="audit" user={admin} />); await flush()
    fireEvent.change(screen.getByLabelText('审计关键词'), { target: { value: '未提交的筛选词' } })
    fireEvent.click(screen.getByRole('button', { name: /加载更多/ })); await flush()
    const path = apiMock.mock.calls.map(call => call[0]).find(value => value.includes('offset=1'))
    expect(path).toBe('/api/admin/sessions?limit=100&offset=1')
    expect(screen.getByRole('button', { name: /智能体B/ })).toBeTruthy()
  })

  it('resets only the chosen password and toggles the account through the real endpoint contract', async () => {
    let disabled = false
    apiMock.mockImplementation((path: string, options: any = {}) => {
      if (options.method === 'PATCH' && 'disabled' in options.body) disabled = options.body.disabled
      return Promise.resolve(path === '/api/admin/users' ? { users: [admin, { ...employee, disabled }] } : {})
    })
    render(<AdministrationPage view="users" user={admin} />); await flush()
    const row = screen.getByText('同事').closest('tr')!
    fireEvent.click(within(row).getByRole('button', { name: '重置密码' })); fireEvent.change(screen.getByLabelText('新密码'), { target: { value: 'new-password-2026!' } })
    fireEvent.submit(screen.getByRole('dialog').querySelector('form')!); await flush()
    expect(apiMock).toHaveBeenCalledWith('/api/admin/users/employee', expect.objectContaining({ method: 'PATCH', body: { password: 'new-password-2026!' } }))
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(within(screen.getByText('同事').closest('tr')!).getByRole('button', { name: '停用' })); await flush()
    expect(apiMock).toHaveBeenCalledWith('/api/admin/users/employee', expect.objectContaining({ method: 'PATCH', body: { disabled: true } }))
    expect(within(screen.getByText('同事').closest('tr')!).getByRole('button', { name: '启用' })).toBeTruthy()
    expect((within(screen.getByText('admin').closest('tr')!).getByRole('button', { name: '停用' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('searches and paginates members, and sends one validated account creation request', async () => {
    const creation = defer<any>(), users = [admin, ...Array.from({ length: 24 }, (_, index) => ({ id: `employee-${index + 1}`, username: `employee-${index + 1}`, displayName: `员工${index + 1}`, role: 'member' }))]
    apiMock.mockImplementation((_path: string, options: any = {}) => options.method === 'POST' ? creation.promise : Promise.resolve({ users }))
    render(<AdministrationPage view="users" user={admin} />); await flush()
    expect(screen.getAllByRole('row')).toHaveLength(21)
    fireEvent.click(screen.getByRole('button', { name: '下一页' })); expect(screen.getByText('employee-24')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('搜索协作成员'), { target: { value: 'employee-24' } }); await flush()
    expect(screen.getAllByRole('row')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: '添加成员' }))
    fireEvent.change(screen.getByLabelText('姓名'), { target: { value: ' 新同事 ' } }); fireEvent.change(screen.getByLabelText('登录账号'), { target: { value: ' new-member ' } })
    fireEvent.change(screen.getByLabelText('账户角色'), { target: { value: 'member' } }); fireEvent.change(screen.getByLabelText('初始密码'), { target: { value: 'initial-password-2026!' } })
    const form = screen.getByRole('dialog').querySelector('form')!
    fireEvent.submit(form); fireEvent.submit(form)
    expect(apiMock.mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(1)
    expect(apiMock).toHaveBeenCalledWith('/api/admin/users', expect.objectContaining({ method: 'POST', body: { username: 'new-member', displayName: '新同事', password: 'initial-password-2026!', role: 'member' } }))
    creation.resolve({ user: { id: 'new-id' } }); await flush(); expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('does not query administrator data for a non-administrator', async () => {
    render(<AdministrationPage view="users" user={employee} />); await flush()
    expect(apiMock).not.toHaveBeenCalled()
    expect(screen.getByText('此页面仅限管理员访问。')).toBeTruthy()
  })
})

describe('Message channel requests, polling and configuration', () => {
  it('keeps a connected channel online while showing its separate failed file delivery warning', async () => {
    apiMock.mockResolvedValue({ channels: [{ ...wecom, replyMode: 'webhook', webhookSet: true, lastDeliveryError: '附件超过企业微信群文件 20 MiB 上限。' }] })
    render(<ChannelsPage sessions={sessions} onChanged={() => {}} />); await flush()
    expect(screen.getByText('已连接')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBe('消息未送达：附件超过企业微信群文件 20 MiB 上限。')
    expect(screen.queryByText('连接异常')).toBeNull()
  })

  it('creates a send-only Webhook channel without bot credentials or a QR and clears the URL before the request completes', async () => {
    const creation = defer<any>()
    let created = false
    apiMock.mockImplementation((path: string, options: any = {}) => {
      if (options.method === 'POST') return creation.promise
      return Promise.resolve(path === '/api/admin/channels' ? { channels: created ? [webhook] : [] } : {})
    })
    render(<ChannelsPage sessions={sessions} onChanged={() => {}} />); await flush()
    fireEvent.click(screen.getByRole('button', { name: '添加渠道' }))
    fireEvent.change(screen.getByLabelText('渠道类型'), { target: { value: 'wecom-webhook' } })
    expect(screen.queryByLabelText('Bot ID')).toBeNull(); expect(screen.queryByLabelText('Secret')).toBeNull()
    expect(within(screen.getByRole('dialog')).getByText(/图片可直接展示，PDF、Excel、Word/).textContent).toContain('单个文件上限 20 MiB')
    fireEvent.change(screen.getByLabelText('渠道名称'), { target: { value: ' 企微通知 ' } })
    const input = screen.getByLabelText('Webhook 地址') as HTMLInputElement
    expect(input.type).toBe('password')
    fireEvent.change(input, { target: { value: testWebhookUrl } })
    const form = screen.getByRole('dialog').querySelector('form')!
    fireEvent.submit(form); fireEvent.submit(form)
    expect(input.value).toBe('')
    expect(apiMock.mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(1)
    expect(apiMock).toHaveBeenCalledWith('/api/admin/channels', expect.objectContaining({ method: 'POST', body: { type: 'wecom', connectionMode: 'webhook', replyMode: 'webhook', name: '企微通知', webhookUrl: testWebhookUrl } }))
    created = true; creation.resolve({ channel: webhook }); await flush()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText('已配置')).toBeTruthy()
    expect(apiMock.mock.calls.some(call => /\/logins|\/connect|\/conversations/.test(call[0]))).toBe(false)
  })

  it('rejects a missing or non-official Webhook URL without sending configuration', async () => {
    apiMock.mockResolvedValue({ channels: [] })
    render(<ChannelsPage sessions={sessions} onChanged={() => {}} />); await flush()
    fireEvent.click(screen.getByRole('button', { name: '添加渠道' }))
    fireEvent.change(screen.getByLabelText('渠道类型'), { target: { value: 'wecom-webhook' } })
    fireEvent.change(screen.getByLabelText('渠道名称'), { target: { value: '企微通知' } })
    const form = screen.getByRole('dialog').querySelector('form')!
    fireEvent.submit(form); await flush()
    expect(screen.getAllByRole('alert')[0].textContent).toContain('有效的企业微信群机器人 Webhook 地址')
    for (const value of ['https://example.com/hook?key=fixture', 'http://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=fixture', 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=fixture&other=field']) {
      fireEvent.change(screen.getByLabelText('Webhook 地址'), { target: { value } }); fireEvent.submit(form); await flush()
    }
    expect(apiMock.mock.calls.some(call => call[1]?.method === 'POST')).toBe(false)
  })

  it('renders Webhook channels as configured send-only destinations and edits without discovery or credentials', async () => {
    apiMock.mockResolvedValue({ channels: [webhook] })
    render(<ChannelsPage sessions={sessions} onChanged={() => {}} />); await flush()
    expect(screen.getByText('企业微信群机器人 · 仅发送')).toBeTruthy()
    expect(screen.getByText('已配置')).toBeTruthy()
    expect(screen.getByText('0 个已连接 · 1 个 Webhook 已配置 · 每个渠道绑定一个智能体')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '重新连接' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '配置' })); await flush()
    expect(screen.queryByLabelText('企业微信 Bot ID')).toBeNull()
    expect(screen.queryByLabelText('企业微信 Secret')).toBeNull()
    expect(screen.queryByLabelText('消息互通会话')).toBeNull()
    expect(screen.queryByLabelText('企业微信回复方式')).toBeNull()
    expect((screen.getByLabelText('企业微信 Webhook 地址') as HTMLInputElement).value).toBe('')
    expect(screen.getByText(/仅发送通知，不接收员工消息/)).toBeTruthy()
    expect(within(screen.getByRole('dialog')).getByText(/图片可直接展示，PDF、Excel、Word/).textContent).toContain('AMR 音频按语音发送，视频和其他音频按文件发送')
    expect(apiMock.mock.calls.some(call => call[0].endsWith('/conversations'))).toBe(false)
  })

  it('switches an existing long connection to Webhook replies and clears both private drafts during saving', async () => {
    const saving = defer<any>()
    apiMock.mockImplementation((path: string, options: any = {}) => options.method === 'PATCH' ? saving.promise : Promise.resolve(path === '/api/admin/channels' ? { channels: [wecom] } : { conversations: [wecom.target] }))
    render(<ChannelsPage sessions={sessions} onChanged={() => {}} />); await flush()
    fireEvent.click(screen.getByRole('button', { name: '配置' })); await flush()
    fireEvent.change(screen.getByLabelText('企业微信回复方式'), { target: { value: 'webhook' } })
    fireEvent.submit(screen.getByRole('dialog').querySelector('form')!); await flush()
    expect(apiMock.mock.calls.some(call => call[1]?.method === 'PATCH')).toBe(false)
    const input = screen.getByLabelText('企业微信 Webhook 地址') as HTMLInputElement
    expect(input.type).toBe('password')
    fireEvent.change(input, { target: { value: testWebhookUrl } })
    fireEvent.submit(screen.getByRole('dialog').querySelector('form')!)
    expect(input.value).toBe('')
    expect(apiMock).toHaveBeenCalledWith('/api/admin/channels/wecom-a', expect.objectContaining({ method: 'PATCH', body: { botId: 'original-bot', target: wecom.target, replyMode: 'webhook', webhookUrl: testWebhookUrl } }))
    saving.resolve({}); await flush()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(apiMock.mock.calls.some(call => /\/test|\/send/.test(call[0]))).toBe(false)
  })

  it('preserves a saved Webhook URL when left blank and switches back without exposing or resending it', async () => {
    const configured = { ...wecom, replyMode: 'webhook', webhookSet: true }
    apiMock.mockImplementation((path: string) => Promise.resolve(path === '/api/admin/channels' ? { channels: [configured] } : { conversations: [wecom.target] }))
    render(<ChannelsPage sessions={sessions} onChanged={() => {}} />); await flush()
    fireEvent.click(screen.getByRole('button', { name: '配置' })); await flush()
    expect((screen.getByLabelText('企业微信 Webhook 地址') as HTMLInputElement).value).toBe('')
    fireEvent.submit(screen.getByRole('dialog').querySelector('form')!); await flush()
    expect(apiMock).toHaveBeenCalledWith('/api/admin/channels/wecom-a', expect.objectContaining({ method: 'PATCH', body: { botId: 'original-bot', target: wecom.target } }))
    fireEvent.click(screen.getByRole('button', { name: '配置' })); await flush()
    fireEvent.change(screen.getByLabelText('企业微信 Webhook 地址'), { target: { value: testWebhookUrl } })
    fireEvent.change(screen.getByLabelText('企业微信回复方式'), { target: { value: 'websocket' } })
    expect(screen.queryByLabelText('企业微信 Webhook 地址')).toBeNull()
    fireEvent.submit(screen.getByRole('dialog').querySelector('form')!); await flush()
    expect(apiMock).toHaveBeenCalledWith('/api/admin/channels/wecom-a', expect.objectContaining({ method: 'PATCH', body: { botId: 'original-bot', target: wecom.target, replyMode: 'websocket' } }))
  })

  it('replaces a send-only Webhook without changing its connection mode, then clears it on close', async () => {
    apiMock.mockResolvedValue({ channels: [webhook] })
    render(<ChannelsPage sessions={sessions} onChanged={() => {}} />); await flush()
    fireEvent.click(screen.getByRole('button', { name: '配置' })); await flush()
    fireEvent.change(screen.getByLabelText('企业微信 Webhook 地址'), { target: { value: testWebhookUrl } })
    fireEvent.submit(screen.getByRole('dialog').querySelector('form')!); await flush()
    expect(apiMock).toHaveBeenCalledWith('/api/admin/channels/webhook-a', expect.objectContaining({ method: 'PATCH', body: { webhookUrl: testWebhookUrl } }))
    fireEvent.click(screen.getByRole('button', { name: '配置' })); await flush()
    expect((screen.getByLabelText('企业微信 Webhook 地址') as HTMLInputElement).value).toBe('')
    fireEvent.change(screen.getByLabelText('企业微信 Webhook 地址'), { target: { value: testWebhookUrl } })
    fireEvent.click(screen.getByRole('button', { name: '取消' })); await flush()
    fireEvent.click(screen.getByRole('button', { name: '配置' })); await flush()
    expect((screen.getByLabelText('企业微信 Webhook 地址') as HTMLInputElement).value).toBe('')
  })

  it('discards Webhook drafts when changing the new channel type', async () => {
    apiMock.mockResolvedValue({ channels: [] })
    render(<ChannelsPage sessions={sessions} onChanged={() => {}} />); await flush()
    fireEvent.click(screen.getByRole('button', { name: '添加渠道' }))
    fireEvent.change(screen.getByLabelText('渠道类型'), { target: { value: 'wecom-webhook' } })
    fireEvent.change(screen.getByLabelText('Webhook 地址'), { target: { value: testWebhookUrl } })
    fireEvent.change(screen.getByLabelText('渠道类型'), { target: { value: 'wecom' } })
    expect(screen.queryByLabelText('Webhook 地址')).toBeNull()
    fireEvent.change(screen.getByLabelText('渠道类型'), { target: { value: 'wecom-webhook' } })
    expect((screen.getByLabelText('Webhook 地址') as HTMLInputElement).value).toBe('')
  })

  it('ignores a late QR response after closing and does not leave a login poll behind', async () => {
    vi.useFakeTimers(); const start = defer<any>(), changed = vi.fn()
    apiMock.mockImplementation((path: string) => path.endsWith('/logins') ? start.promise : Promise.resolve({ channels: [weixin] }))
    render(<ChannelsPage sessions={sessions} onChanged={changed} />); await flush()
    fireEvent.click(screen.getByRole('button', { name: '扫码登录' })); await flush()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '完成' }))
    start.resolve({ login: { id: 'old-login', status: 'waiting_scan' }, channel: weixin }); await flush(); await advance(6000)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(apiMock.mock.calls.some(call => call[0].includes('/logins/old-login'))).toBe(false)
    expect(changed).not.toHaveBeenCalled()
  })

  it('shows scanned then connected from real polling responses and stops after connection', async () => {
    vi.useFakeTimers(); let polls = 0, connected = false; const changed = vi.fn()
    apiMock.mockImplementation((path: string, options: any = {}) => {
      if (path === '/api/admin/channels') return Promise.resolve({ channels: [{ ...weixin, connected, status: connected ? 'connected' : 'idle' }] })
      if (path.endsWith('/logins') && options.method === 'POST') return Promise.resolve({ login: { id: 'live-login', status: 'waiting_scan' }, channel: weixin })
      polls++; connected = polls >= 2
      return Promise.resolve({ login: { id: 'live-login', status: connected ? 'confirmed' : 'scanned' }, channel: { ...weixin, connected, canReceive: true } })
    })
    render(<ChannelsPage sessions={sessions} onChanged={changed} />); await flush()
    fireEvent.click(screen.getByRole('button', { name: '扫码登录' })); await flush()
    expect(screen.getByAltText('使用本人微信扫描此二维码登录消息渠道').getAttribute('src')).toContain('/logins/live-login/qr.svg')
    await advance(2000); expect(screen.getByText('已扫码，请在手机上确认登录。')).toBeTruthy()
    await advance(2000); expect(screen.getByText('微信已连接，可以关闭此窗口。')).toBeTruthy()
    expect(screen.queryByAltText('使用本人微信扫描此二维码登录消息渠道')).toBeNull()
    await advance(10000); expect(polls).toBe(2); expect(changed).toHaveBeenCalledOnce()
  })

  it('submits a phone verification code to the same login and clears the code', async () => {
    vi.useFakeTimers()
    apiMock.mockImplementation((path: string, options: any = {}) => {
      if (path === '/api/admin/channels') return Promise.resolve({ channels: [weixin] })
      return Promise.resolve({ login: { id: 'verify-login', status: path.endsWith('/logins') ? 'need_verifycode' : 'confirmed' }, channel: { ...weixin, connected: !path.endsWith('/logins') } })
    })
    render(<ChannelsPage sessions={sessions} onChanged={() => {}} />); await flush()
    fireEvent.click(screen.getByRole('button', { name: '扫码登录' })); await flush()
    fireEvent.change(screen.getByLabelText('手机验证码'), { target: { value: '123456' } }); fireEvent.submit(screen.getByLabelText('手机验证码').closest('form')!); await flush()
    expect(apiMock).toHaveBeenCalledWith('/api/admin/channels/wechat-a/logins/verify-login', expect.objectContaining({ method: 'POST', body: { verifyCode: '123456' } }))
    expect(screen.queryByLabelText('手机验证码')).toBeNull()
  })

  it('does not reuse a previous external conversation when WeCom credentials change', async () => {
    apiMock.mockImplementation((path: string) => Promise.resolve(path === '/api/admin/channels' ? { channels: [wecom] } : path.endsWith('/conversations') ? { conversations: [wecom.target] } : {}))
    render(<ChannelsPage sessions={sessions} onChanged={() => {}} />); await flush()
    fireEvent.click(screen.getByRole('button', { name: '配置' })); await flush()
    fireEvent.change(screen.getByLabelText('企业微信 Bot ID'), { target: { value: 'new-bot' } }); fireEvent.change(screen.getByLabelText('企业微信 Secret'), { target: { value: 'new-secret' } })
    fireEvent.submit(screen.getByRole('dialog').querySelector('form')!); await flush()
    expect(apiMock).toHaveBeenCalledWith('/api/admin/channels/wecom-a', expect.objectContaining({ method: 'PATCH', body: { botId: 'new-bot', secret: 'new-secret' } }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps saved WeCom credentials when only selecting a conversation', async () => {
    const next = { id: 'external-b', chatType: 'single' }
    apiMock.mockImplementation((path: string) => Promise.resolve(path === '/api/admin/channels' ? { channels: [wecom] } : path.endsWith('/conversations') ? { conversations: [wecom.target, next] } : {}))
    render(<ChannelsPage sessions={sessions} onChanged={() => {}} />); await flush()
    fireEvent.click(screen.getByRole('button', { name: '配置' })); await flush()
    fireEvent.change(screen.getByLabelText('消息互通会话'), { target: { value: JSON.stringify(['single', 'external-b']) } })
    fireEvent.submit(screen.getByRole('dialog').querySelector('form')!); await flush()
    expect(apiMock).toHaveBeenCalledWith('/api/admin/channels/wecom-a', expect.objectContaining({ method: 'PATCH', body: { botId: 'original-bot', target: next } }))
  })

  it('ignores group A binding state after selecting B, then saves only B bindings', async () => {
    const old = defer<any>(), channelB = { ...weixin, sessionId: 'group-b', sessionTitle: '智能体B' }
    apiMock.mockImplementation((path: string) => {
      if (path === '/api/admin/channels') return Promise.resolve({ channels: [channelB] })
      if (path === '/api/sessions/group-a/channels') return old.promise
      return Promise.resolve({ channels: [channelB], canManage: true })
    })
    render(<ChannelsPage sessions={sessions} currentSessionId="group-a" onChanged={() => {}} />); await flush()
    fireEvent.click(screen.getByRole('button', { name: '配置绑定' })); await flush()
    fireEvent.change(screen.getByLabelText('关联智能体'), { target: { value: 'group-b' } }); await flush()
    old.resolve({ channels: [], canManage: true }); await flush()
    expect((screen.getByLabelText('绑定微信渠道') as HTMLInputElement).checked).toBe(true)
    fireEvent.submit(screen.getByRole('dialog').querySelector('form')!); await flush()
    expect(apiMock).toHaveBeenCalledWith('/api/sessions/group-b/channels', expect.objectContaining({ method: 'PUT', body: { channelIds: ['wechat-a'] } }))
    expect(apiMock.mock.calls.some(call => call[0] === '/api/sessions/group-a/channels' && call[1]?.method === 'PUT')).toBe(false)
  })

  it('renames, pauses, and confirms deletion with the original mutation contracts', async () => {
    let channel: any = { ...weixin }
    apiMock.mockImplementation((path: string, options: any = {}) => {
      if (options.method === 'PATCH') channel = { ...channel, ...options.body }
      if (options.method === 'DELETE') channel = null
      return Promise.resolve(path === '/api/admin/channels' ? { channels: channel ? [channel] : [] } : {})
    })
    render(<ChannelsPage sessions={sessions} onChanged={() => {}} />); await flush()
    fireEvent.change(screen.getByLabelText('渠道名称：微信渠道'), { target: { value: '新的渠道名称' } }); fireEvent.submit(screen.getByLabelText('渠道名称：微信渠道').closest('form')!); await flush()
    expect(apiMock).toHaveBeenCalledWith('/api/admin/channels/wechat-a', expect.objectContaining({ method: 'PATCH', body: { name: '新的渠道名称' } }))
    fireEvent.click(screen.getByRole('button', { name: '暂停' })); await flush()
    expect(apiMock).toHaveBeenCalledWith('/api/admin/channels/wechat-a', expect.objectContaining({ method: 'PATCH', body: { enabled: false } }))
    fireEvent.click(screen.getByRole('button', { name: '删除' })); expect(apiMock.mock.calls.some(call => call[1]?.method === 'DELETE')).toBe(false)
    fireEvent.submit(screen.getByRole('dialog').querySelector('form')!); await flush()
    expect(apiMock).toHaveBeenCalledWith('/api/admin/channels/wechat-a', expect.objectContaining({ method: 'DELETE', body: {} }))
    expect(screen.getByText('添加消息渠道，连接外部协作会话。')).toBeTruthy()
  })
})
