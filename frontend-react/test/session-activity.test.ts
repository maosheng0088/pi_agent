import { describe, expect, it } from 'vitest'
import { conversationRunning, sessionActivity } from '../src/lib/session-activity'
import { conversationPreview } from '../src/lib/conversation-preview'

describe('agent activity and direct conversation status', () => {
  it('distinguishes a queued agent from running work and reports both counts', () => {
    expect(sessionActivity({ id: 'a', title: '报价', running: false, queuedTaskCount: 2 })).toBe('排队中 · 2 项任务')
    expect(sessionActivity({ id: 'a', title: '报价', running: true, runningTaskCount: 3, queuedTaskCount: 2 })).toBe('运行中 · 3 项任务 · 2 项排队')
    expect(sessionActivity({ id: 'a', title: '报价', running: false, runningTaskCount: 0, queuedTaskCount: 0 })).toBe('')
  })

  it('keeps the latest finished reply visible while a separate background task runs', () => {
    const agent = { id: 'a', title: '报价', running: true, runningTaskCount: 1, conversationRunning: false }
    const messages = [{ role: 'user', content: '查报价' }, { role: 'assistant', content: '报价已经整理完毕' }]
    expect(conversationPreview(messages, conversationRunning(agent))).toBe('AI：报价已经整理完毕')
    expect(conversationPreview(messages, conversationRunning(agent, true))).toBe('成员：查报价')
  })

  it('supports the old service response while rejecting malformed queue counts', () => {
    expect(conversationRunning({ id: 'a', title: '报价', running: true })).toBe(true)
    expect(sessionActivity({ id: 'a', title: '报价', running: true })).toBe('运行中 · 1 项任务')
    expect(sessionActivity({ id: 'a', title: '报价', queuedTaskCount: -2 })).toBe('')
    expect(conversationRunning(null)).toBe(false)
  })
})
