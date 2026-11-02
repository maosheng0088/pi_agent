import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import MessageContent from '../src/components/MessageContent.vue'
import FileIcon from '../src/components/FileIcon.vue'
import { messageAttachment, messageTokens, safeMessageUrl } from '../src/lib/message-links'

vi.mock('../src/lib/workspace-assets', () => ({
  fileIconSource: (name: string) => `/test-icons/${name.split('.').at(-1)}.svg`,
}))

describe('Safe message file links', () => {
  it('renders real HTTP file links as cards without inventing size or download controls', () => {
    const view = mount(MessageContent, { props: { content: '已生成 [业务报表](https://files.example.com/%E6%8A%A5%E8%A1%A8.xlsx?download=1)\n[原始数据](http://files.example.com/data.CSV)' } })
    const links = view.findAll('.message-file-link')
    expect(links).toHaveLength(2)
    expect(links[0]!.text()).toContain('业务报表')
    expect(links[0]!.text()).toContain('报表.xlsx · Excel · files.example.com')
    expect(links[0]!.attributes('href')).toBe('https://files.example.com/%E6%8A%A5%E8%A1%A8.xlsx?download=1')
    expect(links[1]!.text()).toContain('data.CSV · CSV')
    for (const link of links) {
      expect(link.attributes('target')).toBe('_blank')
      expect(link.attributes('rel')).toBe('noreferrer noopener')
      expect(link.attributes('download')).toBeUndefined()
    }
    expect(view.find('button').exists()).toBe(false)
    expect(view.text()).not.toMatch(/KB|MB|已下载/)
  })

  it('leaves dangerous protocols and local file paths as text', () => {
    const content = '[脚本](javascript:alert(1)) [数据](data:text/html,bad) [本地](file:///D:/private.pdf) [路径](D:/private.pdf) [相对路径](/private.pdf) [网络路径](//files.example.com/private.pdf)'
    const view = mount(MessageContent, { props: { content } })
    expect(view.find('a').exists()).toBe(false)
    expect(view.find('.message-file-link').exists()).toBe(false)
    expect(view.text()).toBe(content)
    for (const value of ['javascript:alert(1)', 'data:text/html,bad', 'file:///D:/a.pdf', 'D:/a.pdf', '/a.pdf', '//files.example.com/a.pdf', 'https://user:secret@files.example.com/a.pdf', 'https://files.example.com\\a.pdf', 'https://files.example.com/\ta.pdf']) {
      expect(safeMessageUrl(value)).toBeUndefined()
    }
  })

  it('keeps ordinary web and unknown file links safe and derives type only from URL paths', () => {
    const view = mount(MessageContent, { props: { content: '[帮助](https://example.com/help) [数据包](https://files.example.com/raw.bin) [报表.xlsx](https://example.com/run?file=report.xlsx)' } })
    expect(view.findAll('.message-file-link')).toHaveLength(0)
    expect(view.findAll('.message-web-link')).toHaveLength(3)
    expect(view.findAll('a').every(link => link.attributes('rel') === 'noreferrer noopener')).toBe(true)
  })

  it('supports parentheses in genuine URLs while preserving surrounding text', () => {
    const tokens = messageTokens('结果：[报告](https://files.example.com/report(1).pdf) 已准备。')
    expect(tokens).toEqual([
      { kind: 'text', text: '结果：' },
      { kind: 'link', text: '报告', href: 'https://files.example.com/report(1).pdf', file: { name: 'report(1).pdf', extension: 'pdf', typeLabel: 'PDF', hostname: 'files.example.com' } },
      { kind: 'text', text: ' 已准备。' },
    ])
    expect(messageTokens('[未完成](https://example.com/a.pdf').map(token => token.text).join('')).toBe('[未完成](https://example.com/a.pdf')
  })

  it('escapes HTML in file names and labels and never embeds a remote asset', () => {
    const view = mount(MessageContent, { props: { content: '[<img src=x onerror=alert(1)>](https://files.example.com/%3Cimg%20src=x%20onerror=alert(1)%3E.pdf)' } })
    expect(view.findAll('.message-file-link')).toHaveLength(1)
    expect(view.text()).toContain('<img src=x onerror=alert(1)>')
    expect(view.findAll('img')).toHaveLength(1)
    expect(view.get('img').attributes('src')).toBe('/test-icons/pdf.svg')
    expect(view.find('[onerror]').exists()).toBe(false)
    expect(view.find('script').exists()).toBe(false)
  })

  it('preserves plain user messages, inline code, bold text, headings and fenced code', () => {
    const link = '[报表](https://files.example.com/report.pdf)'
    const plain = mount(MessageContent, { props: { content: link, plain: true } })
    expect(plain.text()).toBe(link)
    expect(plain.find('a').exists()).toBe(false)
    const view = mount(MessageContent, { props: { content: `## 标题\n**粗体** 与 \`${link}\`\n\`\`\`python\n${link}\nprint('<script>')\n\`\`\`` } })
    expect(view.get('h4').text()).toBe('标题')
    expect(view.get('strong').text()).toBe('粗体')
    expect(view.findAll('a')).toHaveLength(0)
    expect(view.get('pre').text()).toContain(link)
    expect(view.get('.code-language').text()).toBe('python')
    expect(view.find('script').exists()).toBe(false)
  })

  it('does not create attachments or buttons from filenames without links', () => {
    const view = mount(MessageContent, { props: { content: '生成了 report.xlsx，保存在 D:\\exports\\report.xlsx。' } })
    expect(view.find('a').exists()).toBe(false)
    expect(view.find('button').exists()).toBe(false)
    expect(view.find('img').exists()).toBe(false)
  })

  it('uses a decorative local file icon with explicit dimensions', () => {
    const view = mount(FileIcon, { props: { name: 'report.pdf' } })
    const image = view.get('img')
    expect(image.attributes()).toMatchObject({ src: '/test-icons/pdf.svg', width: '32', height: '32', alt: '', 'aria-hidden': 'true', draggable: 'false' })
  })
})

describe('Authorized same-origin message attachments', () => {
  const route = '/api/sessions/team_alpha-01/attachments/b54981a6-963c-4c38-92e2-01da3b4af4e4'
  const urlFor = (name: string) => `${route}?name=${encodeURIComponent(name)}`
  let view: VueWrapper | undefined
  afterEach(() => { view?.unmount(); view = undefined })

  it('creates separate open/download links for a real internal file and invents no size', () => {
    view = mount(MessageContent, { props: { content: `已完成 [业务报表](${urlFor('提柜报表.xlsx')})` } })
    const card = view.get('.message-attachment-card')
    expect(card.text()).toContain('业务报表')
    expect(card.text()).toContain('提柜报表.xlsx · Excel')
    expect(card.text()).not.toMatch(/KB|MB|已下载/)
    expect(card.get('.attachment-open').attributes()).toMatchObject({ target: '_blank', rel: 'noreferrer noopener' })
    const download = card.get('.attachment-download')
    expect(download.attributes('download')).toBe('提柜报表.xlsx')
    const href = new URL(download.attributes('href'), window.location.origin)
    expect(href.pathname).toBe(route)
    expect(href.searchParams.get('name')).toBe('提柜报表.xlsx')
    expect(href.searchParams.get('download')).toBe('1')
    expect(view.find('.message-attachment-image').exists()).toBe(false)
  })

  it('previews Markdown images and ordinary safe image attachment links', () => {
    for (const syntax of [`![港口示意图](${urlFor('港口.png')})`, `[查看图片](${urlFor('港口.webp')})`]) {
      const rendered = mount(MessageContent, { props: { content: syntax } })
      const image = rendered.get('.message-attachment-image')
      expect(image.attributes('src')).toContain(route)
      expect(image.attributes('alt')).toBe(syntax.startsWith('!') ? '港口示意图' : '查看图片')
      expect(image.attributes('loading')).toBe('lazy')
      expect(rendered.get('button[aria-haspopup="dialog"]').attributes('aria-label')).toContain('放大图片')
      expect(rendered.get('.attachment-download').attributes('href')).toContain('download=1')
      rendered.unmount()
    }
  })

  it('accepts an absolute attachment URL only from the current origin and strips the download flag for preview', () => {
    const attachment = messageAttachment(`${window.location.origin}${urlFor('a.jpg')}&download=1`, '示意图', true)
    expect(attachment).toMatchObject({ name: 'a.jpg', extension: 'jpg', typeLabel: '图片', image: true })
    expect(attachment?.href).toBe(`${route}?name=a.jpg`)
    expect(attachment?.downloadHref).toBe(`${route}?name=a.jpg&download=1`)
    expect(safeMessageUrl(`${route}?name=a.jpg`)?.pathname).toBe(route)
    expect(messageAttachment(`https://external.example${route}?name=a.jpg`, '外部图片', true)).toBeUndefined()
  })

  it('preserves explicit same-origin web/file links without embedding ordinary page images', () => {
    view = mount(MessageContent, { props: { content: `[帮助](${window.location.origin}/help) [报表](${window.location.origin}/exports/report.pdf) ![页面图片](${window.location.origin}/assets/chart.png)` } })
    expect(view.get('.message-web-link').attributes('href')).toBe(`${window.location.origin}/help`)
    expect(view.findAll('.message-file-link')).toHaveLength(2)
    expect(view.find('.message-attachment-image').exists()).toBe(false)
    expect(view.findAll('img').every(image => image.attributes('src')?.startsWith('/test-icons/'))).toBe(true)
    expect(messageTokens(`[附件](${window.location.origin}${route}?unexpected=1)`).every(token => token.kind === 'text')).toBe(true)
  })

  it('supports an empty image alt label using the attached filename as its accessible fallback', () => {
    view = mount(MessageContent, { props: { content: `![](${urlFor('chart.png')})` } })
    expect(view.get('.message-attachment-image').attributes('alt')).toBe('chart.png')
  })

  it('decodes escaped Markdown brackets in image and file labels and keeps encoded parentheses intact', () => {
    const name = '报表[终稿](1).png'
    view = mount(MessageContent, { props: { content: `![报表\\[终稿\\](1).png](${urlFor(name)})` } })
    expect(view.get('.message-attachment-image').attributes('alt')).toBe(name)
    expect(view.get('.image-card-caption').text()).toContain(name)
    const tokens = messageTokens(`[报表\\[终稿\\].xlsx](${urlFor('报表[终稿].xlsx')})`)
    expect(tokens[0]).toMatchObject({ kind: 'attachment', text: '报表[终稿].xlsx' })
    expect(messageTokens('[反斜杠\\\\标签](https://example.com/help)')[0]).toMatchObject({ kind: 'link', text: '反斜杠\\标签' })
  })

  it('shows external image Markdown as a safe link card without loading any remote image', () => {
    view = mount(MessageContent, { props: { content: '![外部港口图](https://files.example.com/port.jpg) ![外部预览](https://files.example.com/view?id=1)' } })
    expect(view.findAll('.message-file-link')).toHaveLength(2)
    expect(view.find('.message-attachment-image').exists()).toBe(false)
    expect(view.find('button').exists()).toBe(false)
    expect(view.findAll('img').every(image => image.attributes('src')?.startsWith('/test-icons/'))).toBe(true)
    expect(view.findAll('a').every(link => link.attributes('rel') === 'noreferrer noopener')).toBe(true)
  })

  it('rejects unsafe routes, query keys, ambiguous names and dangerous image protocols', () => {
    const invalid = [
      route.replace('/team_alpha-01/', '/team.alpha/'), route.replace('b54981a6-963c-4c38-92e2-01da3b4af4e4', 'private.png'),
      `${route}/extra`, `${route}#fragment`, `${route}?unexpected=1`, `${route}?download=0`, `${route}?download=1&download=1`,
      `${route}?name=a.png&name=b.png`, `${route}?name=..%2Fprivate.png`, `${route}?name=..%5Cprivate.png`,
      `${route}?name=bad%0A.png`, `${route}?name=bad%.png`, `${route}?name=%FF.png`,
      route.replace('/attachments/', '/folder/../attachments/'), route.replace('/attachments/', '/%61ttachments/'),
      `//external.example${route}`, `${window.location.origin}${route}?unexpected=1`,
      'data:image/svg+xml,<svg/onload=alert(1)>', 'javascript:alert(1)', 'file:///D:/private.png', 'D:/private.png',
    ]
    for (const href of invalid) {
      expect(messageAttachment(href, '图片.png', true), href).toBeUndefined()
      const syntax = `![图片](${href})`
      const tokens = messageTokens(syntax)
      expect(tokens.every(token => token.kind === 'text'), href).toBe(true)
      expect(tokens.map(token => token.text).join(''), href).toBe(syntax)
    }
  })

  it('never previews SVG, HTML, or other non-raster attachment names as images', () => {
    for (const name of ['image.svg', 'page.html', 'raw.bmp', 'vector.avif', 'file.exe']) {
      const attachment = messageAttachment(urlFor(name), name, true)
      expect(attachment?.image, name).toBe(false)
    }
    view = mount(MessageContent, { props: { content: `![SVG](${urlFor('drawing.svg')})` } })
    expect(view.find('.message-attachment-image').exists()).toBe(false)
    expect(view.get('.message-attachment-card').text()).toContain('drawing.svg')
  })

  it('falls back to a downloadable file card when the thumbnail cannot load', async () => {
    view = mount(MessageContent, { props: { content: `![示意图](${urlFor('plot.png')})` } })
    await view.get('.message-attachment-image').trigger('error')
    expect(view.find('.message-image-preview').exists()).toBe(false)
    expect(view.get('.message-attachment-card').text()).toContain('plot.png')
    expect(view.get('.attachment-unavailable').attributes('role')).toBe('status')
    expect(view.get('.attachment-download').attributes('href')).toContain('download=1')
  })

  it('opens an accessible image dialog and closes it with Escape', async () => {
    view = mount(MessageContent, { attachTo: document.body, props: { content: `![业务图](${urlFor('chart.png')})` } })
    const button = view.get('button[aria-haspopup="dialog"]')
    ;(button.element as HTMLButtonElement).focus()
    await button.trigger('click')
    await flushPromises()
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.querySelector('.attachment-preview-image')?.getAttribute('alt')).toBe('业务图')
    expect(dialog?.querySelector('a[download]')?.getAttribute('href')).toContain('download=1')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('keeps raw user text, fenced code, inline code, escaped image syntax and HTML inert', () => {
    const image = `![<img src=x onerror=alert(1)>](${urlFor('chart.png')})`
    view = mount(MessageContent, { props: { content: image, plain: true } })
    expect(view.find('img').exists()).toBe(false)
    expect(view.text()).toBe(image)
    const escaped = `\\${image}`
    expect(messageTokens(escaped).map(token => token.text).join('')).toBe(escaped)
    expect(messageTokens(escaped).every(token => token.kind === 'text')).toBe(true)
    const code = mount(MessageContent, { props: { content: `\`${image}\`\n\`\`\`markdown\n${image}\n\`\`\`` } })
    expect(code.find('img').exists()).toBe(false)
    expect(code.find('a').exists()).toBe(false)
    code.unmount()
  })

  it('escapes attachment alt text and display names without adding HTML attributes', () => {
    view = mount(MessageContent, { props: { content: `![<img src=x onerror=alert(1)>](${urlFor('<script>.png')})` } })
    expect(view.get('.message-attachment-image').attributes('alt')).toBe('<img src=x onerror=alert(1)>')
    expect(view.text()).toContain('<script>.png')
    expect(view.find('script').exists()).toBe(false)
    expect(view.find('[onerror]').exists()).toBe(false)
  })
})
