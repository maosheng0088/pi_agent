// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import BusinessRunLogViewer from '../src/pages/automation/BusinessRunLogViewer'

vi.mock('@douyinfe/semi-ui', () => ({
  Button: ({ children, icon, loading, theme, size, ...props }: any) => <button {...props}>{children}</button>,
  Banner: ({ description }: any) => <div>{description}</div>,
  Checkbox: ({ children, onChange, ...props }: any) => <label><input type="checkbox" {...props} onChange={onChange} />{children}</label>,
  Space: ({ children }: any) => <div>{children}</div>, Tag: ({ children }: any) => <span>{children}</span>,
}))
const admin = { id: 'admin', username: 'admin', displayName: '管理员', role: 'admin' }
const run = { id: 'business-run', status: 'running', taskType: 'business' }
const response = (content: string, status = 'running', extra = {}) => new Response(JSON.stringify({ content, run: { id: run.id, status }, ...extra }), { headers: { 'Content-Type': 'application/json' } })
let fetcher: ReturnType<typeof vi.fn>
beforeEach(() => { vi.useFakeTimers(); fetcher = vi.fn().mockResolvedValue(response('print: 开始')); vi.stubGlobal('fetch', fetcher) })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
async function tick(ms = 0) { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
async function mount(status = 'running') { const view = render(<BusinessRunLogViewer run={{ ...run, status }} user={admin} />); await tick(); return view }

describe('business program stdout/stderr viewer', () => {
  it('refreshes active output every two seconds and performs a final read before stopping', async () => {
    fetcher.mockResolvedValueOnce(response('print: 开始')).mockResolvedValueOnce(response('print: 已退出', 'succeeded')).mockResolvedValueOnce(response('print: 完整末行', 'succeeded'))
    await mount()
    expect(screen.getByText('print: 开始')).toBeTruthy()
    await tick(1999); expect(fetcher).toHaveBeenCalledTimes(1)
    await tick(2); await tick(1)
    expect(screen.getByText('print: 完整末行')).toBeTruthy()
    expect(screen.getByText(/任务已结束，自动刷新已停止/)).toBeTruthy()
    await tick(30000); expect(fetcher).toHaveBeenCalledTimes(3)
    expect(fetcher.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true)
  })

  it('aborts a paused request, ignores its late output and catches up when resumed', async () => {
    let finish!: (value: Response) => void
    fetcher.mockResolvedValueOnce(response('旧输出')).mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve })).mockResolvedValueOnce(response('恢复后的最新输出'))
    await mount(); await tick(2000)
    const signal = fetcher.mock.calls[1][1].signal
    fireEvent.click(screen.getByRole('button', { name: '暂停刷新' }))
    expect(signal.aborted).toBe(true)
    await act(async () => finish(response('暂停后晚返回的输出')))
    expect(screen.queryByText('暂停后晚返回的输出')).toBeNull()
    await tick(10000); expect(fetcher).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: '继续刷新' })); await tick()
    expect(screen.getByText('恢复后的最新输出')).toBeTruthy()
  })

  it('keeps upward reading in place while output changes and renders HTML as text', async () => {
    fetcher.mockResolvedValueOnce(response('第一行')).mockResolvedValueOnce(response('<img src=x onerror=alert(1)>\n末行', 'running', { truncated: true }))
    await mount()
    const terminal = screen.getByLabelText('程序日志内容')
    Object.defineProperties(terminal, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 200 } })
    terminal.scrollTop = 200; fireEvent.scroll(terminal)
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
    await tick(2000)
    expect(terminal.scrollTop).toBe(200)
    expect(terminal.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(terminal.querySelector('img')).toBeNull()
    expect(screen.getByText(/较早输出可能已截断/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '回到最新' }))
    expect(terminal.scrollTop).toBe(1000)
  })

  it('aborts and removes private output on identity changes or access loss', async () => {
    let finish!: (value: Response) => void
    fetcher.mockResolvedValueOnce(response('旧管理员输出')).mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve }))
    const view = await mount(); await tick(2000)
    const signal = fetcher.mock.calls[1][1].signal
    view.rerender(<BusinessRunLogViewer run={run} user={{ ...admin, id: 'other' }} />)
    expect(signal.aborted).toBe(true)
    expect(screen.queryByText('旧管理员输出')).toBeNull()
    await act(async () => finish(response('旧身份晚响应')))
    expect(screen.queryByText('旧身份晚响应')).toBeNull()
    view.rerender(<BusinessRunLogViewer run={run} user={{ ...admin, role: 'member' }} />)
    expect(screen.getByText('仅管理员可查看执行日志。')).toBeTruthy()
    const count = fetcher.mock.calls.length; await tick(10000); expect(fetcher).toHaveBeenCalledTimes(count)
  })

  it('clears loaded output on auth expiry and aborts on close/unmount', async () => {
    const view = await mount()
    const signal = fetcher.mock.calls[0][1].signal
    act(() => window.dispatchEvent(new Event('pi:auth-expired')))
    expect(signal.aborted).toBe(true)
    expect(screen.queryByText('print: 开始')).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain('日志已清除')
    view.unmount(); await tick(10000); expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('reads ended runs only once and supports a manual refresh with an empty-log notice', async () => {
    fetcher.mockImplementation(() => Promise.resolve(response('', 'failed')))
    await mount('failed')
    expect(screen.getByText(/尚无程序输出/)).toBeTruthy()
    await tick(10000); expect(fetcher).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: '刷新日志' })); await tick()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('button', { name: '暂停刷新' })).toBeNull()
  })

  it('keeps polling after transient failures but stops and clears on 403', async () => {
    fetcher.mockRejectedValueOnce(new Error('网络中断')).mockResolvedValueOnce(response('stdout 恢复')).mockResolvedValueOnce(new Response(JSON.stringify({ error: '无权限' }), { status: 403 }))
    await mount()
    expect(screen.getByRole('alert').textContent).toBe('网络中断')
    await tick(2000); expect(screen.getByText('stdout 恢复')).toBeTruthy()
    await tick(2000); expect(screen.queryByText('stdout 恢复')).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain('权限已失效')
    await tick(10000); expect(fetcher).toHaveBeenCalledTimes(3)
  })
})
