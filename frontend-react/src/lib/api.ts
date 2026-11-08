import type { UploadedAttachment } from './types'

export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); this.name = 'ApiError' }
}
export interface ApiOptions { method?: string; body?: unknown; signal?: AbortSignal; headers?: Record<string, string> }
let identityEpoch = 0
export function advanceApiIdentity() { identityEpoch++ }
export const MAX_CHAT_FILES = 10
export const MAX_CHAT_FILE_BYTES = 50 * 1024 * 1024

/** Binary upload uses the same identity epoch as JSON requests. Delayed errors
 * from an aborted/previous account cannot expire the current login. */
export function uploadChatAttachment(sessionId: string, file: File, { signal, onProgress }: { signal?: AbortSignal; onProgress?(percent: number): void } = {}): Promise<UploadedAttachment> {
  const requestEpoch = identityEpoch
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('上传已取消。', 'AbortError')); return }
    if (file.size > MAX_CHAT_FILE_BYTES) { reject(new Error('单个文件不能超过 50 MiB。')); return }
    const xhr = new XMLHttpRequest()
    let settled = false
    const finish = (error?: unknown, value?: UploadedAttachment) => {
      if (settled) return
      settled = true; signal?.removeEventListener('abort', abort)
      xhr.onload = xhr.onerror = xhr.onabort = xhr.ontimeout = null; xhr.upload.onprogress = null
      if (error) reject(error); else resolve(value!)
    }
    const abort = () => { finish(new DOMException('上传已取消。', 'AbortError')); xhr.abort() }
    signal?.addEventListener('abort', abort, { once: true })
    xhr.onload = () => {
      if (settled || signal?.aborted) return
      const data = xhr.response && typeof xhr.response === 'object' ? xhr.response : {}
      if (xhr.status !== 201) {
        if (xhr.status === 401 && requestEpoch === identityEpoch) window.dispatchEvent(new Event('pi:auth-expired'))
        finish(new ApiError(typeof data.error === 'string' ? data.error : `上传失败（${xhr.status}）`, xhr.status, data.code)); return
      }
      const item = data.attachment
      const base = item && `/api/sessions/${encodeURIComponent(sessionId)}/attachments/${item.id}`
      if (!item || typeof item.id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(item.id)
        || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 512 || /[\u0000-\u001f\u007f/\\]/.test(item.name)
        || !Number.isSafeInteger(item.size) || item.size !== file.size || item.size > MAX_CHAT_FILE_BYTES
        || !['image', 'file'].includes(item.kind) || typeof item.mimeType !== 'string' || item.mimeType.length > 180
        || item.url !== base || item.downloadUrl !== `${base}?download=1`) {
        finish(new Error('服务未返回有效的同群附件，请重试上传。')); return
      }
      finish(undefined, { id: item.id, name: item.name, size: item.size, kind: item.kind, mimeType: item.mimeType, url: item.url, downloadUrl: item.downloadUrl })
    }
    xhr.onerror = () => finish(new Error('上传连接中断，请重试或移除文件。'))
    xhr.ontimeout = () => finish(new Error('上传超时，请重试或移除文件。'))
    xhr.onabort = () => finish(new DOMException('上传已取消。', 'AbortError'))
    xhr.upload.onprogress = event => { if (!settled && event.lengthComputable && event.total > 0) onProgress?.(Math.min(99, Math.max(0, Math.round(event.loaded / event.total * 100)))) }
    try {
      if (settled || signal?.aborted) { abort(); return }
      xhr.open('POST', `/api/sessions/${encodeURIComponent(sessionId)}/attachments?name=${encodeURIComponent(file.name)}`)
      xhr.responseType = 'json'; xhr.timeout = 10 * 60 * 1000
      xhr.setRequestHeader('Accept', 'application/json'); xhr.setRequestHeader('Content-Type', 'application/octet-stream')
      xhr.send(file)
    } catch { finish(new Error('无法开始上传，请重试。')) }
  })
}
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
/** Authenticated, bounded binary reads for attachment downloads and previews. */
export async function apiAttachmentBytes(path:string,{signal,maxBytes=MAX_CHAT_FILE_BYTES,accept='application/pdf',body}:{signal:AbortSignal;maxBytes?:number;accept?:string;body?:{url:string}}):Promise<Uint8Array>{
  const requestEpoch=identityEpoch
  const response=await fetch(path,{credentials:'same-origin',mode:'same-origin',redirect:'error',signal,
    headers:{Accept:accept,...(body?{'Content-Type':'application/json'}:{})},
    ...(body?{method:'POST',body:JSON.stringify(body)}:{}),
  })
  if(!response.ok){
    const data=await response.json().catch(()=>({}))
    if(response.status===401&&!signal.aborted&&requestEpoch===identityEpoch)window.dispatchEvent(new Event('pi:auth-expired'))
    throw new ApiError(typeof data.error==='string'?data.error:`文件读取失败（${response.status}）`,response.status,data.code)
  }
  if(signal.aborted)throw new DOMException('预览已关闭。','AbortError')
  const tooLarge=`文件超过 ${maxBytes/(1024*1024)} MiB，无法在线预览。`
  if(Number(response.headers.get('Content-Length'))>maxBytes){await response.body?.cancel();throw new Error(tooLarge)}
  if(!response.body){const bytes=new Uint8Array(await response.arrayBuffer());if(bytes.length>maxBytes)throw new Error(tooLarge);return bytes}
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let length=0
  try{
    while(true){const {done,value}=await reader.read();if(signal.aborted)throw new DOMException('预览已关闭。','AbortError');if(done)break;if(!value)continue;length+=value.length;if(length>maxBytes){await reader.cancel();throw new Error(tooLarge)}chunks.push(value)}
    const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}return bytes
  }finally{reader.releaseLock()}
}
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
