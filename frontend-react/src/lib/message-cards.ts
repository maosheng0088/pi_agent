import type { MessageCard, MessageCardSource } from './types'

const identifier = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/
const states = new Set(['queued', 'running', 'waiting_human', 'succeeded', 'failed', 'cancelled', 'interrupted', 'skipped'])
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function text(value: unknown, max: number, required = false): value is string { return typeof value === 'string' && value.length <= max && (!required || !!value.trim()) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value) }
function id(value: unknown): value is string { return typeof value === 'string' && identifier.test(value) }
function source(value: unknown): MessageCardSource | null {
  if (!object(value) || !id(value.documentId) || !text(value.title, 240, true) || !Number.isSafeInteger(value.version) || (value.version as number) < 1 || !text(value.updatedAt, 80, true) || Number.isNaN(Date.parse(value.updatedAt))) return null
  if (value.sourceName !== undefined && !text(value.sourceName, 240)) return null
  if (value.contentHash !== undefined && !text(value.contentHash, 128)) return null
  if (value.excerpt !== undefined && !text(value.excerpt, 4000)) return null
  if (value.citation !== undefined && !text(value.citation, 1000)) return null
  if (value.cited !== undefined && typeof value.cited !== 'boolean') return null
  return { documentId: value.documentId, title: value.title, version: value.version as number, updatedAt: value.updatedAt, ...(value.sourceName ? { sourceName: value.sourceName as string } : {}), ...(value.contentHash ? { contentHash: value.contentHash as string } : {}), ...(value.excerpt ? { excerpt: value.excerpt as string } : {}), ...(value.citation ? { citation: value.citation as string } : {}), ...(typeof value.cited === 'boolean' ? { cited: value.cited } : {}) }
}

/** The UI accepts only data from our versioned message protocol. It never runs
 * card callbacks, HTML, URLs, or renderer instructions supplied in a payload. */
export function messageCards(value: unknown): MessageCard[] {
  if (!Array.isArray(value) || value.length > 8) return []
  const result: MessageCard[] = [], seen = new Set<string>()
  for (const candidate of value) {
    if (!object(candidate) || candidate.version !== 1 || !id(candidate.id) || seen.has(candidate.id) || !['task_result', 'task_exception', 'knowledge'].includes(String(candidate.kind)) || !text(candidate.title, 240, true)) continue
    if (candidate.summary !== undefined && !text(candidate.summary, 2000)) continue
    if (candidate.status !== undefined && (!text(candidate.status, 40) || !states.has(candidate.status))) continue
    if (candidate.taskId !== undefined && !id(candidate.taskId)) continue
    if (candidate.taskKind !== undefined && candidate.taskKind !== 'work' && candidate.taskKind !== 'schedule') continue
    if (candidate.taskId !== undefined && candidate.taskKind === undefined) continue
    let fields: Array<{ label: string; value: string }> | undefined, sources: MessageCardSource[] | undefined
    if (candidate.fields !== undefined) {
      if (!Array.isArray(candidate.fields) || candidate.fields.length > 16 || !candidate.fields.every(field => object(field) && text(field.label, 120, true) && text(field.value, 2000))) continue
      fields = candidate.fields.map(field => ({ label: field.label as string, value: field.value as string }))
    }
    if (candidate.sources !== undefined) {
      if (!Array.isArray(candidate.sources) || candidate.sources.length > 12) continue
      const parsed = candidate.sources.map(source)
      if (parsed.some(item => item === null)) continue
      sources = parsed as MessageCardSource[]
    }
    if (candidate.kind === 'knowledge' && !sources?.length) continue
    result.push({ version: 1, id: candidate.id, kind: candidate.kind as MessageCard['kind'], title: candidate.title, ...(candidate.summary ? { summary: candidate.summary as string } : {}), ...(candidate.status ? { status: candidate.status as string } : {}), ...(fields ? { fields } : {}), ...(candidate.taskId ? { taskId: candidate.taskId as string } : {}), ...(candidate.taskKind ? { taskKind: candidate.taskKind as 'work' | 'schedule' } : {}), ...(sources ? { sources } : {}) })
    seen.add(candidate.id)
  }
  return result
}
