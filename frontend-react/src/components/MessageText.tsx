import { Children, Component, isValidElement, memo, useMemo, type ReactNode, type ReactElement } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkCjkFriendly from 'remark-cjk-friendly'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { messageAttachment, messageFile, safeMessageUrl } from '../lib/message-links'
import { normalizeMessageTables } from '../lib/message-markdown'
import { fileIconSource } from '../lib/artwork'
import AttachmentPreview from './AttachmentPreview'
import MessageCodeBlock from './MessageCodeBlock'
import 'katex/dist/katex.min.css'
import './markdown-blocks.css'

function textContent(children: ReactNode): string {
  return Children.toArray(children).map(child => typeof child === 'string' || typeof child === 'number' ? String(child) : isValidElement<{ children?: ReactNode }>(child) ? textContent(child.props.children) : '').join('')
}

/** Raw HTML remains text, never compiled as MDX or injected into the page. */
function remarkReadableText() {
  return (tree: any, file: { value: unknown }) => {
    const source = String(file.value)
    function visit(parent: any) {
      if (!parent.children) return
      parent.children = parent.children.flatMap((node: any) => {
        if (node.type === 'html') return { type: 'text', value: node.value, position: node.position }
        if (node.type === 'link' && node.position) {
          const start = node.position.start.offset, end = node.position.end.offset
          const prefix = source.slice(0, start).split('\n').at(-1) || ''
          const escaped = prefix.match(/(\\+)!?\[[^\]\r\n]*\]\($/)
          // GFM must not reactivate the URL inside an escaped link example.
          if (escaped && escaped[1]!.length % 2) return { type: 'text', value: source.slice(start, end), position: node.position }
        }
        // A closing dollar can actually open the next monetary amount. Keep
        // currency prose literal instead of removing meaningful dollar signs.
        if (node.type === 'inlineMath') {
          const start = node.position.start.offset, end = node.position.end.offset
          const literal = source.slice(start, end), prefix = source.slice(0, start)
          const monetary = literal.startsWith('$') && !literal.startsWith('$$') && /^\s*\d/.test(node.value) && (
            /\b(?:USD|EUR|CAD|AUD|CNY|HKD|SGD|NZD|US|CA|AU)\s*$/i.test(prefix) || /^\s*\d/.test(source.slice(end)) ||
            (!/[=^_\\+*/<>]/.test(node.value) && /[;:，；]|[a-zA-Z]{3,}|[\u3400-\u9fff]/.test(node.value))
          )
          if (monetary) return { type: 'text', value: literal, position: node.position }
        }
        if (node.type === 'text' && node.value.includes('\n')) {
          return node.value.split('\n').flatMap((value: string, index: number) => index ? [{ type: 'break' }, { type: 'text', value }] : [{ type: 'text', value }])
        }
        visit(node)
        return node
      })
    }
    visit(tree)
  }
}

const remarkPlugins = [remarkGfm, remarkCjkFriendly, remarkMath, remarkReadableText]
const rehypePlugins: any = [[rehypeKatex, { throwOnError: false, strict: 'ignore', trust: false, maxExpand: 500, maxSize: 20 }]]

function MessageMarkdownBody({ content }: { content: string }) {
  const source = useMemo(() => normalizeMessageTables(content), [content])
  const components = useMemo<Components>(() => {
    const original = (node: any) => typeof node?.position?.start?.offset === 'number' && typeof node?.position?.end?.offset === 'number' ? source.slice(node.position.start.offset, node.position.end.offset) : ''
    return {
      a({ href = '', children, node }) {
        const url = safeMessageUrl(href)
        if (!url) return <>{original(node) || children}</>
        const label = textContent(children), attachment = messageAttachment(href, label)
        if (attachment) return <AttachmentPreview attachment={attachment} label={label} />
        const file = messageFile(url)
        if (file) return <a className="message-file-link" href={url.href} target="_blank" rel="noopener noreferrer"><img src={fileIconSource(file.name)} alt="" /><span><strong>{children}</strong><small>{file.name} · {file.typeLabel} · {file.hostname}</small></span><span aria-hidden="true">↗</span></a>
        return <a href={url.href} target="_blank" rel="noopener noreferrer">{children}</a>
      },
      img({ src = '', alt = '', node }) {
        const attachment = messageAttachment(src, alt, true)
        if (attachment) return <AttachmentPreview attachment={attachment} label={alt} />
        const url = safeMessageUrl(src)
        return url ? <a className="message-remote-image-link" href={url.href} target="_blank" rel="noopener noreferrer">{alt || '查看图片'}<span aria-hidden="true"> ↗</span></a> : <>{original(node) || alt}</>
      },
      table({ children }) { return <div className="message-table-scroll" role="region" aria-label="表格内容，可横向滚动" tabIndex={0}><table className="message-data-table" aria-label="消息数据表">{children}</table></div> },
      th({ children, style }) { return <th scope="col" style={style}>{children}</th> },
      td({ children, style }) { return <td style={style}>{children}</td> },
      pre({ children }) {
        const child = Children.toArray(children).find(isValidElement) as ReactElement<{ className?: string; children?: ReactNode }> | undefined
        return <MessageCodeBlock language={child?.props.className?.match(/(?:^|\s)language-([^\s]+)/)?.[1]} code={textContent(child?.props.children ?? children).replace(/\n$/, '')} />
      },
      code({ children, className }) { return <code className={className}>{children}</code> },
      input({ checked }) { return <input type="checkbox" disabled checked={!!checked} aria-label={checked ? '已完成事项' : '待完成事项'} readOnly /> },
      p({ children }) { return <p>{children}</p> },
    }
  }, [source])
  return <div className="message-prose message-markdown"><ReactMarkdown components={components} remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} urlTransform={value => value}>{source}</ReactMarkdown></div>
}

class MessageRenderBoundary extends Component<{ content: string }, { content: string; failed: boolean }> {
  state = { content: this.props.content, failed: false }
  static getDerivedStateFromProps(props: { content: string }, state: { content: string }) {
    return props.content === state.content ? null : { content: props.content, failed: false }
  }
  static getDerivedStateFromError() { return { failed: true } }
  render() {
    return this.state.failed ? <div className="message-prose message-markdown plain-prose">{this.props.content}</div> : <MessageMarkdownBody content={this.props.content} />
  }
}

export default memo(function MessageText({ content }: { content: string }) { return <MessageRenderBoundary content={content} /> })
