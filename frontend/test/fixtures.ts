import { vi } from 'vitest'
import type { Message, Session, Skill, User } from '../src/lib/types'

export function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}
export function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
export function session(id: string): Session {
  return { id, title: `智能体 ${id}`, running: false, revision: 1, ownerId: 'admin', messageCount: 1 }
}
export function person(id: string, displayName = id): User {
  return { id, username: id, displayName, role: 'member' }
}
export function sse() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value } })
  return {
    response: new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }),
    event(event: unknown) { controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)) },
    close() { controller.close() },
  }
}
export function fakeBackend() {
  const state = {
    groups: [session('alpha'), session('beta')],
    messages: { alpha: [{ role: 'assistant', content: 'Alpha saved response' }], beta: [{ role: 'assistant', content: 'Beta saved response' }] } as Record<string, Message[]>,
    skills: { alpha: [{ id: 'alpha-skill', name: '群内可用技能' }], beta: [] } as Record<string, Skill[]>,
  }
  let handler: ((path: string, init?: RequestInit) => Response | Promise<Response> | undefined) | undefined
  const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input), custom = handler?.(path, init)
    if (custom !== undefined) return Promise.resolve(custom)
    const url = new URL(path, location.origin)
    if (url.pathname === '/api/auth/login') {
      const body = JSON.parse(String(init?.body))
      return Promise.resolve(json({ user: person(`${body.username}-id`, `用户 ${body.username}`), workspace: { id: 'company', name: '隔离 QA 空间' } }))
    }
    if (url.pathname === '/api/auth/logout') return Promise.resolve(json({ ok: true }))
    if (url.pathname === '/api/status') return Promise.resolve(json({ configured: true }))
    if (url.pathname === '/api/sessions') return Promise.resolve(json({ sessions: state.groups, total: state.groups.length }))
    const skill = url.pathname.match(/^\/api\/sessions\/([^/]+)\/skills$/)
    if (skill) return Promise.resolve(json({ skills: state.skills[skill[1]!] || [] }))
    const history = url.pathname.match(/^\/api\/sessions\/([^/]+)$/)
    if (history) {
      const group = state.groups.find(item => item.id === history[1])
      return Promise.resolve(group ? json({ session: group, messages: state.messages[group.id] || [] }) : json({ error: '群聊不存在或你尚未加入。', code: 'GROUP_ACCESS_DENIED' }, 404))
    }
    return Promise.reject(new Error(`Unexpected isolated fetch: ${init?.method || 'GET'} ${path}`))
  })
  vi.stubGlobal('fetch', fetch)
  return { state, fetch, route(value: typeof handler) { handler = value } }
}
