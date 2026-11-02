export type MessageFile = {
  name: string
  extension: string
  typeLabel: string
  hostname: string
}

export type MessageToken =
  | { kind: 'text' | 'code' | 'strong'; text: string }
  | { kind: 'link'; text: string; href: string; file?: MessageFile }
  | { kind: 'attachment'; text: string; attachment: MessageAttachment }

export type MessageAttachment = {
  href: string
  downloadHref: string
  name: string
  extension: string
  typeLabel: string
  image: boolean
}

const fileTypes: Record<string, string> = {
  xls: 'Excel', xlsx: 'Excel', xlsm: 'Excel', ods: '表格', csv: 'CSV', tsv: '表格',
  pdf: 'PDF', doc: 'Word', docx: 'Word', odt: '文档', ppt: 'PowerPoint', pptx: 'PowerPoint', odp: '演示文稿',
  zip: 'ZIP', '7z': '压缩包', rar: '压缩包', tar: '压缩包', gz: '压缩包',
  json: 'JSON', py: 'Python', md: 'Markdown', markdown: 'Markdown',
  png: '图片', jpg: '图片', jpeg: '图片', gif: '图片', webp: '图片', svg: '图片', avif: '图片', bmp: '图片', ico: '图片',
  sql: 'SQL', ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  html: 'HTML', htm: 'HTML',
}

const imageExtensions = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])
const attachmentPath = /^\/api\/sessions\/[A-Za-z0-9_-]{1,128}\/attachments\/[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12}$/
const unwrap = (value: string) => value.startsWith('<') && value.endsWith('>') ? value.slice(1, -1) : value
const currentOrigin = () => typeof window !== 'undefined' && /^https?:$/.test(window.location.protocol) ? window.location.origin : 'http://localhost'

function explicitWebUrl(candidate: string): URL | undefined {
  if (!/^https?:\/\/[^/?#\\]/i.test(candidate) || /[\u0000-\u0020\u007f<>\\]/.test(candidate)) return
  try {
    const url = new URL(candidate)
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return
    return url
  } catch { return }
}

/** This route grants no permission: the server still authorizes each attachment. */
function attachmentUrl(value: string): URL | undefined {
  const candidate = unwrap(value)
  if (candidate.length > 8192 || /[\u0000-\u0020\u007f<>\\]/.test(candidate) || /%(?![A-Fa-f0-9]{2})/.test(candidate)) return
  const origin = currentOrigin()
  const relative = candidate.startsWith('/') && !candidate.startsWith('//')
  const url = relative ? new URL(candidate, origin) : explicitWebUrl(candidate)
  if (!url || url.origin !== origin || url.hash) return
  // Check the supplied path before URL normalization can remove dot segments.
  const rawPath = relative ? candidate.split(/[?#]/, 1)[0] : candidate.match(/^https?:\/\/[^/?#]+([^?#]*)/i)?.[1]
  if (!rawPath || !attachmentPath.test(rawPath)) return
  for (const key of url.searchParams.keys()) {
    if (!['name', 'download'].includes(key) || url.searchParams.getAll(key).length !== 1) return
  }
  if (url.searchParams.has('download') && url.searchParams.get('download') !== '1') return
  if (url.searchParams.has('name')) {
    const name = url.searchParams.get('name') || ''
    if (!name.trim() || name.length > 512 || /[\u0000-\u001f\u007f/\\\u2028\u2029\u202a-\u202e\u2066-\u2069\ufffd]/.test(name)) return
  }
  return url
}

/** Explicit HTTP(S), or a strictly validated relative attachment; never disk paths. */
export function safeMessageUrl(value: string): URL | undefined {
  const candidate = unwrap(value)
  const attachment = attachmentUrl(candidate)
  if (attachment) return attachment
  const url = explicitWebUrl(candidate)
  if (!url) return
  if (url.origin === currentOrigin()) {
    let path = url.pathname
    try { path = decodeURIComponent(path) } catch { /* A malformed path is never an attachment. */ }
    // A rejected attachment must not regain interactivity as a generic web link.
    if (/^\/api\/sessions\//.test(path) && /\/attachments(?:\/|$)/.test(path)) return
  }
  return url
}

/** The optional name is a display hint. Image MIME/bytes are validated server-side. */
export function messageAttachment(value: string, label = '', imageSyntax = false): MessageAttachment | undefined {
  const url = attachmentUrl(value)
  if (!url) return
  const hintedName = url.searchParams.get('name')
  const plainLabel = label.trim()
  const usableLabel = plainLabel && plainLabel.length <= 512 && !/[\u0000-\u001f\u007f/\\\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(plainLabel) ? plainLabel : ''
  const name = hintedName || usableLabel || (imageSyntax ? '图片附件' : '附件')
  const extension = name.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() || ''
  const image = imageExtensions.has(extension) || (imageSyntax && !extension)
  const typeLabel = Object.hasOwn(fileTypes, extension) ? fileTypes[extension]! : image ? '图片' : '附件'
  const query = new URLSearchParams(url.search)
  query.delete('download')
  const href = url.pathname + (query.size ? `?${query}` : '')
  query.set('download', '1')
  return { href, downloadHref: `${url.pathname}?${query}`, name, extension, typeLabel, image }
}

function messageFile(url: URL): MessageFile | undefined {
  let name: string
  try { name = decodeURIComponent(url.pathname.split('/').at(-1) || '') } catch { return }
  if (!name || /[\u0000-\u001f\u007f/\\]/.test(name)) return
  const extension = name.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase()
  if (!extension || !Object.hasOwn(fileTypes, extension)) return
  return { name, extension, typeLabel: fileTypes[extension]!, hostname: url.hostname }
}

/** Small safe renderer: tokens are always rendered by Vue text nodes, never HTML. */
export function messageTokens(text: string): MessageToken[] {
  const tokens: MessageToken[] = []
  const markers = /`[^`\n]+`|\*\*[^*\n]+\*\*|!?\[(?:\\[^\r\n]|[^\]\\\r\n]){0,512}\]\(/g
  let previous = 0
  let match: RegExpExecArray | null
  while ((match = markers.exec(text))) {
    const start = match.index
    if (start > previous) tokens.push({ kind: 'text', text: text.slice(previous, start) })
    const marker = match[0]
    if (marker.startsWith('`')) {
      tokens.push({ kind: 'code', text: marker.slice(1, -1) })
      previous = markers.lastIndex
    } else if (marker.startsWith('**')) {
      tokens.push({ kind: 'strong', text: marker.slice(2, -2) })
      previous = markers.lastIndex
    } else {
      const urlStart = markers.lastIndex
      let end = urlStart
      let depth = 1
      const limit = Math.min(text.length, urlStart + 8192)
      for (; end < limit; end++) {
        if (text[end] === '\n') break
        if (text[end] === '(') depth++
        if (text[end] === ')' && --depth === 0) break
      }
      if (depth !== 0 || end === limit) {
        tokens.push({ kind: 'text', text: marker })
        previous = urlStart
        continue
      }
      const original = text.slice(start, end + 1)
      const imageSyntax = marker.startsWith('![')
      const label = marker.slice(imageSyntax ? 2 : 1, -2).replace(/\\([\\\[\]])/g, '$1')
      const value = text.slice(urlStart, end)
      const escaped = (text.slice(0, start).match(/\\+$/)?.[0].length || 0) % 2 === 1
      const attachment = escaped ? undefined : messageAttachment(value, label, imageSyntax)
      const url = escaped ? undefined : safeMessageUrl(value)
      if (attachment) tokens.push({ kind: 'attachment', text: label, attachment })
      else if (url) {
        const file = messageFile(url) || (imageSyntax ? { name: label, extension: '', typeLabel: '图片链接', hostname: url.hostname } : undefined)
        tokens.push({ kind: 'link', text: label, href: url.href, file })
      } else tokens.push({ kind: 'text', text: original })
      previous = end + 1
      markers.lastIndex = previous
    }
  }
  if (previous < text.length) tokens.push({ kind: 'text', text: text.slice(previous) })
  return tokens
}
