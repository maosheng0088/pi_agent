import { describe, expect, it } from 'vitest'
import { conversationPreview } from '../src/lib/conversation-preview'
import type { Message } from '../src/lib/types'

describe('conversationPreview', () => {
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
