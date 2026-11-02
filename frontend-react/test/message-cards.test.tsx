// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import MessageContent from '../src/components/MessageContent'
import { messageCards } from '../src/lib/message-cards'

vi.mock('lottie-web', () => ({ default: { loadAnimation: vi.fn(() => ({ destroy: vi.fn(), play: vi.fn(), pause: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() })) } }))
const work = { version: 1 as const, id: 'work-result-one', kind: 'task_result' as const, title: '提柜资料核对完成', status: 'succeeded', taskId: 'task-one', taskKind: 'work' as const, fields: [{ label: '负责人', value: '业务同事' }, { label: '处理范围', value: '已授权群资料' }] }
const source = { documentId: 'document-one', title: '提柜操作规范', sourceName: 'pickup.md', version: 3, updatedAt: '2026-10-29T01:00:00Z', cited: true, excerpt: '需取得客户确认后提柜。', contentHash: 'a'.repeat(64) }
const knowledge = { version: 1 as const, id: 'knowledge-reference-one', kind: 'knowledge' as const, title: '本次参考资料', sources: [source, { ...source, documentId: 'document-two', title: '客户补充要求', cited: false }] }
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() {} })) })
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(cleanup)

describe('versioned message card validation', () => {
  it('accepts bounded data and strips unrecognized actions, URLs and executable renderer fields', () => {
    const cards = messageCards([{ ...work, actions: [{ url: 'javascript:alert(1)' }], html: '<script>danger</script>', callback: '() => fetch("/private")' }, knowledge])
    expect(cards).toHaveLength(2)
    expect(cards[0]).not.toHaveProperty('actions'); expect(cards[0]).not.toHaveProperty('html'); expect(cards[0]).not.toHaveProperty('callback')
    expect(cards[1].sources?.[0]).toMatchObject(source)
  })
  it('rejects unsupported schemas, invalid resource ids and malformed sources without throwing', () => {
    for (const input of [null, {}, 'not-json', [null], [{ ...work, version: 2 }], [{ ...work, taskId: '../../other-group' }], [{ ...work, fields: [{ label: '价格', value: { script: 'no' } }] }], [{ ...knowledge, sources: [{ ...source, version: -1 }] }], [{ ...knowledge, sources: [{ ...source, updatedAt: 'not-a-date' }] }], [{ ...knowledge, sources: [{ ...source, cited: 'true' }] }]]) expect(messageCards(input)).toEqual([])
    expect(messageCards([work, work])).toHaveLength(1)
    expect(messageCards(Array.from({ length: 9 }, (_, index) => ({ ...work, id: `card-${index}` })))).toEqual([])
  })
})

describe('real Semi data cards', () => {
  it('keeps the answer preview when knowledge cards are hidden from a long answer', () => {
    const content = '业务结论：请先取得客户确认。\n' + '详细业务条件。'.repeat(250)
    render(<MessageContent content={content} cards={[{ ...knowledge, summary: '本轮参考资料。' }]} />)
    expect(screen.getByText(/业务结论：请先取得客户确认/, { selector: '.pi-message-long-preview' })).toBeTruthy()
    expect(screen.queryByText('本轮参考资料。')).toBeNull()
    expect(screen.queryByRole('region', { name: '本次参考资料' })).toBeNull()
    expect(screen.getByText(/展开完整结果/).closest('details')?.open).toBe(false)
  })
  it('wraps the unchanged result, shows status in words and only opens the exact work task', () => {
    const onOpenTask = vi.fn()
    render(<MessageContent content="已完成核对，最终原文完整保留。" cards={[work]} onOpenTask={onOpenTask} />)
    const card = screen.getByRole('region', { name: '提柜资料核对完成' })
    expect(within(card).getByText('已完成')).toBeTruthy()
    expect(within(card).queryByText('负责人')).toBeNull()
    expect(within(card).getByText('已完成核对，最终原文完整保留。')).toBeTruthy()
    fireEvent.click(within(card).getByRole('button', { name: '查看任务' }))
    expect(onOpenTask).toHaveBeenCalledExactlyOnceWith('task-one', 'work')
    expect(within(card).queryByRole('button', { name: /人工接手|恢复|立即运行/ })).toBeNull()
  })
  it('keeps the answer while omitting source cards and their navigation controls', () => {
    const onOpenSource = vi.fn()
    render(<MessageContent content="按客户确认的地址执行。" cards={[knowledge]} onOpenSource={onOpenSource} />)
    expect(screen.getByText('按客户确认的地址执行。')).toBeTruthy()
    expect(screen.queryByRole('region', { name: '本次参考资料' })).toBeNull()
    expect(screen.queryByText('需取得客户确认后提柜。')).toBeNull()
    expect(screen.queryByText(/pickup.md · 版本 3/)).toBeNull()
    expect(screen.queryByRole('button', { name: /查看来源/ })).toBeNull()
    expect(onOpenSource).not.toHaveBeenCalled()
  })
  it('keeps unsupported cards as full plain fallback and does not execute labels or HTML', () => {
    const fallback = '完整结果 <img src=x onerror=alert(1)> [脚本](javascript:alert(1))'
    const view = render(<MessageContent content={fallback} cards={[{ ...work, version: 99 }]} />)
    expect(screen.getByText(fallback)).toBeTruthy()
    expect(screen.queryByRole('region')).toBeNull()
    view.rerender(<MessageContent content="正常结果" cards={[{ ...work, title: '<script>伪装标题</script>', fields: [{ label: '<svg onload=alert(1)>', value: 'javascript:alert(1)' }] }]} />)
    expect(screen.getByRole('heading', { name: '<script>伪装标题</script>' })).toBeTruthy()
    expect(document.querySelector('script,[onload],[onerror],a[href^="javascript:"]')).toBeNull()
    expect(screen.queryByRole('button', { name: '查看任务' })).toBeNull()
  })
  it('keeps employee/user messages plain even if a payload contains card-like metadata', () => {
    render(<MessageContent content="我发出的资料内容" plain cards={[work, knowledge]} onOpenTask={vi.fn()} onOpenSource={vi.fn()} />)
    expect(screen.getByText('我发出的资料内容')).toBeTruthy()
    expect(screen.queryByRole('region')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })
  it('keeps authorized attachment controls and shows no invented schedule detail action', () => {
    const url = '/api/sessions/alpha/attachments/b54981a6-963c-4c38-92e2-01da3b4af4e4?name=report.xlsx'
    render(<MessageContent content={`最终报表：[下载结果](${url})`} cards={[{ ...work, taskKind: 'schedule' }]} onOpenTask={vi.fn()} />)
    expect(screen.getByRole('link', { name: '下载文件：report.xlsx' }).getAttribute('href')).toContain('download=1')
    expect(screen.getByRole('link', { name: '打开文件：report.xlsx' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '查看任务' })).toBeNull()
  })
  it('progressively expands a long card result without discarding any text', () => {
    const content = '完整业务记录\n' + '这是一条需要保留的明细。\n'.repeat(180) + '最后的核对结论'
    render(<MessageContent content={content} cards={[work]} />)
    const summary = screen.getByText(/展开完整结果/)
    const details = summary.closest('details')!
    expect(details.open).toBe(false)
    expect(details.textContent).not.toContain('最后的核对结论')
    fireEvent.click(summary)
    expect(details.open).toBe(true)
    expect(details.querySelector('.message-prose')).not.toBeNull()
    expect(details.querySelector('.message-prose')?.textContent?.replace(/\s+/g, '')).toBe(content.replace(/\s+/g, ''))
  })
  it('shows a short result only once when its summary differs solely in whitespace', () => {
    render(<MessageContent content={'已完成核对，\n结果可交付。'} cards={[{ ...work, summary: '  已完成核对，   结果可交付。  ' }]} />)
    const card = screen.getByRole('region', { name: '提柜资料核对完成' })
    expect(card.textContent?.match(/已完成核对/g)).toHaveLength(1)
    expect(card.textContent?.replace(/\s+/g, '')).toContain('已完成核对，结果可交付。')
  })
  it('preserves a distinct short summary and the original downloadable result', () => {
    const url = '/api/sessions/alpha/attachments/b54981a6-963c-4c38-92e2-01da3b4af4e4?name=checked.xlsx'
    render(<MessageContent content={`核对明细：[清单](${url})`} cards={[{ ...work, summary: '已核对 12 项，其中 2 项需补充。' }]} />)
    expect(screen.getByText('已核对 12 项，其中 2 项需补充。')).toBeTruthy()
    expect(screen.getByText('核对明细：')).toBeTruthy()
    expect(screen.getByRole('link', { name: '下载文件：checked.xlsx' }).getAttribute('href')).toContain('download=1')
  })
  it('removes a copied long-result summary and hides the preview when its full body is expanded', async () => {
    const content = '本轮任务已检查。\n' + '逐项明细需要完整保留。\n'.repeat(180) + '最终附件仍可在全文查看'
    render(<MessageContent content={content} cards={[{ ...work, summary: content.slice(0,360) }]} />)
    const card = screen.getByRole('region', { name: '提柜资料核对完成' })
    expect(card.querySelector('.pi-message-long-preview')).not.toBeNull()
    expect(card.querySelector('.pi-message-card-summary')).toBeNull()
    const details = card.querySelector('.pi-message-long-details') as HTMLDetailsElement
    expect(details.open).toBe(false)
    fireEvent.click(within(card).getByText(/展开完整结果/))
    expect(details.open).toBe(true)
    await waitFor(() => expect(card.querySelector('.pi-message-long-preview')).toBeNull())
    expect(details.querySelector('.message-prose')).not.toBeNull()
    expect(details.querySelector('.message-prose')?.textContent?.replace(/\s+/g, '')).toBe(content.replace(/\s+/g, ''))
  })
  it('deduplicates a truncated short Markdown introduction even when the summary has escaped formatting', () => {
    const content = '我是**海运业务查询助手**。\n\n可以批量校验箱号，并查找船司、箱型和港口参考。'
    render(<MessageContent content={content} cards={[{ ...work, summary: '我是\\*\\*海运业务查询助手\\*\\*。' }]} />)
    const card = screen.getByRole('region', { name: '提柜资料核对完成' })
    expect(card.querySelector('.pi-message-card-summary')).toBeNull()
    expect(card.textContent?.match(/海运业务查询助手/g)).toHaveLength(1)
    expect(within(card).getByText('海运业务查询助手', { selector: 'strong' })).toBeTruthy()
  })
  it('omits runtime metadata while keeping the business result and task entry', () => {
    render(<MessageContent content="已核验，校验位正确。" cards={[work]} />)
    const card = screen.getByRole('region', { name: '提柜资料核对完成' })
    expect(card.querySelector('.pi-message-card-metadata')).toBeNull()
    expect(within(card).queryByText('运行详情')).toBeNull()
    expect(within(card).queryByText('业务同事')).toBeNull()
    expect(within(card).getByText('已核验，校验位正确。')).toBeTruthy()
  })

  it('shows a scheduled report once when its stored preview ends inside a Markdown table', () => {
    const title = 'UnitCount 检查 · 04:00'
    const lead = ['业务任务：Amazon 预约 UnitCount 检查', '检查完成，发现 UnitCount 为 0 的预约。',
      '承运人 1 个，完整检查 1 个，失败 0 个，缺登录状态跳过 0 个。',
      '预约 183 条，完整检查 163 条，正常 150 条，零件数异常 13 条，检查失败 0 条，非目标状态跳过 20 条。',
      '零件数 shipment 70 条，件数缺失或无效 0 条。', '检查时间（北京时间）：2026-10-29 15:46:10+08:00',
      '查询范围：2026-08-01 00:00:00+08:00 至 2026-10-30 00:00:00+08:00', '', '零件数异常明细：',
      '| 承运人 | FC | 预约号 | 异常 shipment 数 | shipment 参考号 |'].join('\n')
    const result = `${lead}\n| --- | --- | --- | ---: | --- |\n| KAPE | ABE4 | 328121772 | 2 | FBA19PCWGCDH |\n\n另有 3 条异常，请在智能体中查看完整报告。`
    const summary = `${lead}\n| --- | --- | ---`
    const content = `定时任务：${title}\n\n${result}`
    render(<MessageContent content={content} cards={[{ ...work, title, taskKind: 'schedule', summary }]} />)
    const card = screen.getByRole('region', { name: title })
    expect(card.querySelector('.pi-message-card-summary')).toBeNull()
    expect(card.textContent?.match(/检查完成，发现 UnitCount 为 0 的预约。/g)).toHaveLength(1)
    expect(within(card).getAllByRole('table')).toHaveLength(1)
    expect(within(card).getByRole('cell', { name: '328121772' })).toBeTruthy()
    expect(within(card).getByText('另有 3 条异常，请在智能体中查看完整报告。')).toBeTruthy()
    expect(card.querySelector('.pi-message-card-metadata')).toBeNull()
  })

  it('deduplicates a wrapped failed schedule while preserving its failure status', () => {
    const title = '预约检查', error = 'Amazon 登录或访问校验未通过。'
    render(<MessageContent content={`定时任务：${title}\r\n\r\n${error}\n检查未完成，不能认定正常。`} cards={[{ ...work, title, taskKind: 'schedule', kind: 'task_exception', status: 'failed', summary: error }]} />)
    const card = screen.getByRole('region', { name: title })
    expect(card.querySelector('.pi-message-card-summary')).toBeNull()
    expect(within(card).getByText('执行失败')).toBeTruthy()
    expect(card.textContent?.split(error)).toHaveLength(2)
  })

  it('keeps a distinct schedule summary and does not strip arbitrary headings for comparison', () => {
    const title = '预约检查', summary = '需要管理员处理。'
    const view = render(<MessageContent content={`定时任务：${title}\n\n已完成检查，详细数据如下。`} cards={[{ ...work, title, taskKind: 'schedule', summary }]} />)
    expect(screen.getByText(summary)).toBeTruthy()
    view.rerender(<MessageContent content={`其他说明\n\n${summary}`} cards={[{ ...work, title, taskKind: 'schedule', summary }]} />)
    expect(document.querySelector('.pi-message-card-summary')).not.toBeNull()
  })

  it('does not leave a duplicate preview above an expanded long scheduled result', () => {
    const title = '预约检查', result = '检查完成，已保留全部结果。\n' + '逐项明细需要完整保留。\n'.repeat(180)
    render(<MessageContent content={`定时任务：${title}\n\n${result}`} cards={[{ ...work, title, taskKind: 'schedule', summary: result.slice(0, 360) }]} />)
    const card = screen.getByRole('region', { name: title })
    expect(card.querySelector('.pi-message-card-summary')).toBeNull()
    expect(card.querySelector('.pi-message-long-preview')).not.toBeNull()
    fireEvent.click(within(card).getByText(/展开完整结果/))
    expect(card.querySelector('.pi-message-long-preview')).toBeNull()
    expect(card.textContent?.match(/检查完成，已保留全部结果。/g)).toHaveLength(1)
  })
})
