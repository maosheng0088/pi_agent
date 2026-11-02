// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import MessageContent from '../src/components/MessageContent'

vi.mock('lottie-web', () => ({ default: { loadAnimation: vi.fn(() => ({ destroy: vi.fn(), play: vi.fn(), pause: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() })) } }))

const base = '/api/sessions/alpha/attachments/b54981a6-963c-4c38-92e2-01da3b4af4e4'
const file = `${base}?name=checked.xlsx`
const image = '/api/sessions/alpha/attachments/c64981a6-963c-4c38-92e2-01da3b4af4e4?name=chart.png'
const padding = '逐项业务记录仍应完整保留。\n'.repeat(160)
const work = { version: 1, id: 'work-collapse-one', kind: 'task_result', title: '资料核对完成', status: 'succeeded', taskId: 'task-one', taskKind: 'work', fields: [{ label: '负责人', value: '业务同事' }] }
const knowledge = { version: 1, id: 'knowledge-collapse-one', kind: 'knowledge', title: '本次参考资料', sources: [{ documentId: 'source-one', title: '业务操作要求', sourceName: 'handbook.md', version: 2, updatedAt: '2026-10-29T01:00:00Z', cited: true, excerpt: '业务要求原文。', contentHash: 'a'.repeat(64) }] }

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() {} })) })
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(cleanup)

describe('progressive disclosure for every AI message', () => {
  it('keeps short AI replies and plain employee messages unchanged', () => {
    const view = render(<MessageContent content="金额 **2450 EUR**，有效期至 2026-11-15。" />)
    expect(screen.getByText('2450 EUR', { selector: 'strong' })).toBeTruthy()
    expect(screen.queryByText(/展开完整结果/)).toBeNull()
    const plain = `${padding}\n[不能自动变链接](${file})`
    view.rerender(<MessageContent content={plain} plain cards={[work]} />)
    expect(view.container.textContent).toBe(plain)
    expect(view.container.querySelector('details,a,section')).toBeNull()
  })

  it('collapses an ordinary long reply and only mounts full text after an explicit expansion', () => {
    const ending = '最终金额 2450 EUR；截止日期 2026-11-15；原箱号 000012345678。'
    render(<MessageContent content={`结论：业务资料已核对，异常保留原样。\n\n${padding}\n${ending}`} />)
    const toggle = screen.getByText(/展开完整结果/), details = toggle.closest('details')!
    expect(details.open).toBe(false)
    expect(screen.getByLabelText('回复内容预览').textContent).toContain('结论：业务资料已核对')
    expect(details.querySelector('.message-prose')).toBeNull()
    expect(details.textContent).not.toContain(ending)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(details.open).toBe(true)
    expect(screen.getByText(ending)).toBeTruthy()
    expect(screen.getByText('收起完整结果').getAttribute('aria-expanded')).toBe('true')
    expect(screen.queryByLabelText('回复内容预览')).toBeNull()
  })

  it('unmounts full contents again when collapsed and restores the unchanged preview', () => {
    const ending = '这段结尾只能出现在展开的全文里。'
    render(<MessageContent content={`本次结论：已完成。\n\n${padding}\n${ending}`} />)
    fireEvent.click(screen.getByText(/展开完整结果/))
    expect(screen.getByText(ending)).toBeTruthy()
    const close = screen.getByText('收起完整结果')
    expect(document.getElementById(close.getAttribute('aria-controls')!)).not.toBeNull()
    fireEvent.click(close)
    expect(screen.queryByText(ending)).toBeNull()
    expect(document.querySelector('details .message-prose')).toBeNull()
    expect(screen.getByLabelText('回复内容预览').textContent).toContain('本次结论：已完成')
  })

  it('keeps inline-code business identifiers in the preview without treating them as links', () => {
    render(<MessageContent content={`箱号 \`CSQU3054383\` 已核对，金额 \`2450 EUR\` 保持原值。\n\n${padding}`} />)
    const preview = screen.getByLabelText('回复内容预览')
    expect(preview.textContent).toContain('CSQU3054383')
    expect(preview.textContent).toContain('2450 EUR')
    expect(preview.querySelector('a')).toBeNull()
  })

  it('uses a useful prose conclusion after headings and fenced code, instead of a code excerpt', () => {
    render(<MessageContent content={`# 内部实现\n\n\`\`\`js\nconst hiddenOnly = "代码不应作为预览";\n\`\`\`\n\n业务结论：请补充提柜日期后继续。\n\n${padding}`} />)
    expect(screen.getByLabelText('回复内容预览').textContent).toContain('业务结论：请补充提柜日期后继续')
    expect(screen.getByLabelText('回复内容预览').textContent).not.toContain('hiddenOnly')
    expect(document.querySelector('pre')).toBeNull()
    fireEvent.click(screen.getByText(/展开完整结果/))
    expect(document.querySelector('pre')?.textContent).toContain('hiddenOnly')
  })

  it('delays table DOM creation and provides an honest table-only preview', () => {
    const rows = Array.from({ length: 100 }, (_, index) => `| 业务 ${index} | ${index}.50 EUR |`)
    render(<MessageContent content={`| 项目 | 金额 |\n| --- | --- |\n${rows.join('\n')}`} />)
    expect(screen.getByLabelText('回复内容预览').textContent).toBe('表格内容较长，展开后查看完整数据。')
    expect(screen.queryByRole('table')).toBeNull()
    fireEvent.click(screen.getByText(/展开完整结果/))
    expect(screen.getByRole('table')).toBeTruthy()
    expect(screen.getByText('99.50 EUR')).toBeTruthy()
  })

  it('exposes authenticated attachments independently while collapsed, deduplicated by resource', () => {
    render(<MessageContent content={`结论：核对清单已生成。\n\n${padding}\n[下载清单](${file})\n[同一份清单](${file})\n![图表](${image})`} />)
    const attachments = screen.getByRole('region', { name: '消息附件' })
    expect(attachments.closest('details')).toBeNull()
    expect(within(attachments).getAllByRole('link', { name: '下载文件：checked.xlsx' })).toHaveLength(1)
    expect(within(attachments).getByRole('link', { name: '打开文件：checked.xlsx' }).getAttribute('href')).toContain(base)
    expect(within(attachments).getByRole('link', { name: '下载图片：chart.png' })).toBeTruthy()
    expect(screen.queryByText('同一份清单')).toBeNull()
    fireEvent.click(screen.getByText(/展开完整结果/))
    expect(screen.queryByRole('region', { name: '消息附件' })).toBeNull()
    expect(screen.getAllByRole('link', { name: '下载文件：checked.xlsx' })).toHaveLength(2)
    fireEvent.click(screen.getByText('收起完整结果'))
    expect(screen.getByRole('region', { name: '消息附件' })).toBeTruthy()
    expect(screen.getAllByRole('link', { name: '下载文件：checked.xlsx' })).toHaveLength(1)
  })

  it('does not promote apparent attachments in fenced code, inline code or rejected URLs', () => {
    const fake = `[示例链接](${file})`
    render(<MessageContent content={`\`\`\`md\n${fake}\n\`\`\`\n\n\`${fake}\`\n\n\`\`外层代码 \` 字符 ${fake}\`\`\n\n[拒绝的附件](${base}?download=2)\n[javascript](javascript:alert(1))\n\n${padding}`} />)
    expect(screen.queryByRole('region', { name: '消息附件' })).toBeNull()
    expect(screen.queryByRole('link', { name: /下载文件/ })).toBeNull()
    expect(document.querySelector('a[href^="javascript:"],script')).toBeNull()
  })

  it('retains safe external file links but grants no new attachment trust to foreign routes', () => {
    render(<MessageContent content={`${padding}\n[外部报表](https://files.example.com/report.pdf)\n[假附件](https://evil.example/api/sessions/alpha/attachments/b54981a6-963c-4c38-92e2-01da3b4af4e4?name=report.xlsx)`} />)
    const attachments = screen.getByRole('region', { name: '消息附件' })
    const link = within(attachments).getByRole('link', { name: /外部报表/ })
    expect(link.getAttribute('href')).toBe('https://files.example.com/report.pdf')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    expect(within(attachments).queryByRole('link', { name: /假附件/ })).toBeNull()
  })

  it('preserves task-summary deduplication and full text while hiding knowledge cards', () => {
    const content = `本轮任务已检查，以下明细原样保留。\n\n${padding}\n最后的真实业务结论。`
    const onOpenSource = vi.fn()
    render(<MessageContent content={content} cards={[{ ...work, summary: content.slice(0, 360) }, knowledge]} onOpenSource={onOpenSource} />)
    const card = screen.getByRole('region', { name: '资料核对完成' })
    expect(card.querySelector('.pi-message-card-summary')).toBeNull()
    expect(card.querySelector('.pi-message-long-preview')).not.toBeNull()
    expect(screen.queryByRole('region', { name: '本次参考资料' })).toBeNull()
    expect(screen.queryByText('业务要求原文。')).toBeNull()
    expect(screen.queryByRole('button', { name: /查看来源/ })).toBeNull()
    expect(onOpenSource).not.toHaveBeenCalled()
    expect(screen.queryByText('最后的真实业务结论。')).toBeNull()
    fireEvent.click(within(card).getByText(/展开完整结果/))
    expect(within(card).getByText('最后的真实业务结论。')).toBeTruthy()
    expect(onOpenSource).not.toHaveBeenCalled()
  })

  it('keeps a distinct task summary and file controls while avoiding another generated preview', () => {
    render(<MessageContent content={`${padding}\n[清单](${file})`} cards={[{ ...work, summary: '核对已完成，其中 2 条需要人工确认。' }]} />)
    expect(screen.getByText('核对已完成，其中 2 条需要人工确认。')).toBeTruthy()
    expect(screen.queryByLabelText('回复内容预览')).toBeNull()
    expect(screen.getByRole('link', { name: '下载文件：checked.xlsx' })).toBeTruthy()
  })

  it('refreshes preview and independently visible attachments when the source message changes', () => {
    const view = render(<MessageContent content={`第一次核对结论。\n\n${padding}\n[旧清单](${file})`} />)
    expect(screen.getByRole('link', { name: '下载文件：checked.xlsx' })).toBeTruthy()
    view.rerender(<MessageContent content={`第二次核对结论。\n\n${padding}\n![新图](${image})`} />)
    expect(screen.getByLabelText('回复内容预览').textContent).toContain('第二次核对结论')
    expect(screen.queryByRole('link', { name: '下载文件：checked.xlsx' })).toBeNull()
    expect(screen.getByRole('link', { name: '下载图片：chart.png' })).toBeTruthy()
  })
})
