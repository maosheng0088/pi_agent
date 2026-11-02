import { describe, expect, it } from 'vitest'
import { conversationPreview } from '../src/lib/conversation-preview'
import type { Message } from '../src/lib/types'

describe('conversationPreview', () => {
  const id = '11111111-1111-4111-8111-111111111111', url = `/api/sessions/alpha/attachments/${id}`
  const attachment = { id, name: '业务数据[最终].csv', size: 24, mimeType: 'text/csv', kind: 'file' as const, url, downloadUrl: `${url}?download=1` }
  const link = `[业务数据\\[最终\\].csv](${url}?name=${encodeURIComponent(attachment.name)})`

  it('summarizes canonical attachment-only staff messages without leaking Markdown or API paths', () => {
    const result = conversationPreview([{ role: 'user', content: link, authorName: '附件验收员工', sessionId: 'alpha', attachments: [attachment] }], false, 'alpha')
    expect(result).toBe('附件验收员工：[文件] 业务数据[最终].csv')
    expect(result).not.toContain('/api/'); expect(result).not.toContain('\\[')
  })

  it('preserves a short mixed body and distinguishes confirmed image attachments', () => {
    const picture = { ...attachment, name: '回执.png', mimeType: 'image/png', kind: 'image' as const }
    const text = `请核对这份回执\n\n![回执.png](${url}?name=${encodeURIComponent(picture.name)})`
    expect(conversationPreview([{ role: 'user', content: text, authorName: '示例员工001', attachments: [picture] }], false, 'alpha')).toBe('示例员工001：请核对这份回执 [图片] 回执.png')
  })

  it('never classifies arbitrary links or other-group metadata as uploaded attachments', () => {
    const external = conversationPreview([{ role: 'user', content: '[资料.csv](https://example.com/资料.csv)' }], false, 'alpha')
    expect(external).toBe('成员：资料.csv'); expect(external).not.toContain('[文件]')
    const foreign = conversationPreview([{ role: 'user', content: link, attachments: [attachment] }], false, 'beta')
    expect(foreign).not.toContain('[文件]')
  })

  it('uses the latest real message and normalizes its author and Markdown', () => {
    expect(conversationPreview([
      { role: 'assistant', content: '之前的回复' },
      { role: 'user', authorName: ' 示例员工001\n ', content: '# 今日任务\n\n- 请查看 [业务清单](https://example.com/tasks)\n- **优先**处理 `待确认` 项目' },
    ])).toBe('示例员工001：今日任务 请查看 业务清单 优先处理 待确认 项目')
  })

  it('uses AI for a completed assistant reply and preserves business identifiers', () => {
    expect(conversationPreview([
      { role: 'user', content: '查询进度' },
      { role: 'assistant', content: '**完成**\n参见 [处理结果](https://example.com/result)。业务标识：FEISHU_APP_ID' },
    ])).toBe('AI：完成 参见 处理结果。业务标识：FEISHU_APP_ID')
  })

  it('never exposes tool messages, tool calls, pending messages, or empty content', () => {
    const messages: Message[] = [
      { role: 'user', content: '请查询订单' },
      { role: 'assistant', content: '执行命令内容', tools: [{ name: 'powershell' }] },
      { role: 'toolResult', content: '内部工具输出' },
      { role: 'assistant', content: '尚未完成的回复', pending: true },
      { role: 'assistant', content: '   ' },
    ]
    expect(conversationPreview(messages)).toBe('成员：请查询订单')
  })

  it('hides unfinished assistant text during an active turn', () => {
    const messages: Message[] = [
      { role: 'assistant', content: '上一轮完成的回复' },
      { role: 'user', authorName: '示例员工006', content: '继续查询' },
      { role: 'assistant', content: '正在读取数据，尚未完成' },
    ]
    expect(conversationPreview(messages, true)).toBe('示例员工006：继续查询')
    expect(conversationPreview(messages, false)).toBe('AI：正在读取数据，尚未完成')
    expect(conversationPreview([{ role: 'assistant', content: '未结束' }], true)).toBe('')
  })

  it('allows a delivered task result while another conversation turn is active', () => {
    expect(conversationPreview([
      { role: 'user', content: '查询今天情况' },
      { role: 'assistant', content: '定时任务已完成', taskRunId: 'run-1' },
      { role: 'assistant', content: '当前轮中间过程' },
    ], true)).toBe('AI：定时任务已完成')
  })

  it('treats HTML as plain data and never evaluates it', () => {
    expect(conversationPreview([
      { role: 'assistant', content: '<b>完成</b><script>throw new Error("must not run")</script>\n下一步：复核' },
    ])).toBe('AI：完成 下一步：复核')
  })

  it('bounds long excerpts without splitting Unicode characters', () => {
    const result = conversationPreview([{ role: 'user', content: '📦'.repeat(95) }])
    expect(result).toBe(`成员：${'📦'.repeat(89)}…`)
    expect(conversationPreview([])).toBe('')
  })
})
