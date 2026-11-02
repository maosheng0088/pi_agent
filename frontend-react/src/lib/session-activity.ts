import type { Session } from './types'

function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0
}

export function sessionActivity(session: Session): string {
  const running = session.running ? Math.max(1, count(session.runningTaskCount)) : 0
  const queued = count(session.queuedTaskCount)
  if (running) return `运行中 · ${running} 项任务${queued ? ` · ${queued} 项排队` : ''}`
  return queued ? `排队中 · ${queued} 项任务` : ''
}

// Related background tasks must not hide a completed conversation reply.
export function conversationRunning(session: Session | null, localRunning = false): boolean {
  return localRunning || !!(session?.conversationRunning ?? session?.running)
}
