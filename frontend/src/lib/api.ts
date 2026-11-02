export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); this.name = 'ApiError' }
}
export interface ApiOptions { method?: string; body?: unknown; signal?: AbortSignal; headers?: Record<string, string> }
let identityEpoch = 0
export function advanceApiIdentity() { identityEpoch++ }
export async function api<T = any>(path: string, { method = 'GET', body, signal, headers = {} }: ApiOptions = {}): Promise<T> {
  const requestEpoch = identityEpoch
  const response = await fetch(path, {
    method, credentials: 'same-origin', signal,
    headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    if (response.status === 401 && requestEpoch === identityEpoch && !['/api/auth/login', '/api/auth/setup', '/api/auth/status'].includes(path)) window.dispatchEvent(new Event('pi:auth-expired'))
    throw new ApiError(data.error || `请求失败（${response.status}）`, response.status, data.code)
  }
  return data as T
}
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : '操作失败，请重试。' }
export async function consumeStream(response: Response, onEvent: (event: any) => void) {
  if (!response.body) throw new Error('当前浏览器无法接收回复，请使用新版浏览器。')
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let buffer = ''
  function dispatch(block: string) {
    const text = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
    if (text && text !== '[DONE]') onEvent(JSON.parse(text))
  }
  try {
    while (true) {
      const { value, done } = await reader.read()
      buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n')
      let boundary: number
      while ((boundary = buffer.indexOf('\n\n')) >= 0) { dispatch(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 2) }
      if (done) { if (buffer.trim()) dispatch(buffer); break }
    }
  } finally { reader.releaseLock() }
}
