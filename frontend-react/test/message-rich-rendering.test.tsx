// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import MessageText from '../src/components/MessageText'

vi.mock('lottie-web', () => ({ default: { loadAnimation: vi.fn(() => ({ destroy: vi.fn(), play: vi.fn(), pause: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() })) } }))
// This suite checks Markdown composition. Highlighting, copy controls, code
// folding, and Mermaid rendering have their own MessageCodeBlock tests.
vi.mock('../src/components/MessageCodeBlock', () => ({
  default: ({ code, language }: { code: string; language?: string }) => <pre><code data-language={language}>{code}</code></pre>,
}))

const attachmentRoute = '/api/sessions/alpha/attachments/b54981a6-963c-4c38-92e2-01da3b4af4e4'
const attachment = (name: string) => `${attachmentRoute}?name=${encodeURIComponent(name)}`

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('business message rich rendering', () => {
  it('renders Chinese emphasis next to punctuation without leaking asterisk markers', () => {
    const { container } = render(<MessageText content={'**下一步：**请上传装箱单。\n\n请先**确认日期。**然后提交。\n\n示例仍原样：`**下一步：**请上传`'} />)
    expect(screen.getByText('下一步：').tagName).toBe('STRONG')
    expect(screen.getByText('确认日期。').tagName).toBe('STRONG')
    expect(screen.getByText('**下一步：**请上传').tagName).toBe('CODE')
    expect(container.querySelectorAll('strong')).toHaveLength(2)
  })
  it('uses paragraphs rather than one visual block per source line and preserves paragraph breaks', () => {
    const { container } = render(<MessageText content={'8 条已完成。\n另外 2 条等待补资料。\n\n请补充提柜日期后重新提交。'} />)
    const paragraphs = [...container.querySelectorAll('p')]
    expect(paragraphs).toHaveLength(2)
    expect(paragraphs[0]?.textContent).toContain('8 条已完成。')
    expect(paragraphs[0]?.textContent).toContain('另外 2 条等待补资料。')
    expect(paragraphs[1]?.textContent).toBe('请补充提柜日期后重新提交。')
  })

  it('retains h1 through h6 semantic levels instead of flattening every heading', () => {
    const names = ['工作结果', '报价', '费用范围', '注意事项', '资料来源', '版本说明']
    render(<MessageText content={names.map((name, index) => `${'#'.repeat(index + 1)} ${name}`).join('\n\n')} />)
    names.forEach((name, index) => expect(screen.getByRole('heading', { level: index + 1, name })).toBeTruthy())
  })

  it('keeps nested lists and ordered start numbers, and renders task state as disabled checkboxes', () => {
    render(<MessageText content={'3. 复核本票\n   - 核对箱号\n   - 核对日期\n4. 交付结果\n\n- [x] 报表已生成\n- [ ] 附件尚未发送'} />)
    const parent = screen.getByText('复核本票').closest('li')!
    const nested = within(parent).getByRole('list')
    expect(within(nested).getAllByRole('listitem').map(item => item.textContent)).toEqual(['核对箱号', '核对日期'])
    expect(parent.closest('ol')?.getAttribute('start')).toBe('3')
    const checks = screen.getAllByRole('checkbox') as HTMLInputElement[]
    expect(checks).toHaveLength(2)
    expect(checks.map(input => input.checked)).toEqual([true, false])
    expect(checks.every(input => input.disabled)).toBe(true)
  })

  it('renders emphasis, deletion and quotations without losing the business text', () => {
    const { container } = render(<MessageText content={'**本次结论**：*部分完成*，~~全部成功~~。\n\n> 客户要求：目的港费用另计。'} />)
    expect(screen.getByText('本次结论').tagName).toBe('STRONG')
    expect(screen.getByText('部分完成').tagName).toBe('EM')
    expect(screen.getByText('全部成功').tagName).toBe('DEL')
    expect(container.querySelector('blockquote')?.textContent).toContain('客户要求：目的港费用另计。')
  })

  it('renders standard GFM tables with real header cells and numeric column alignment', () => {
    render(<MessageText content={'| 项目 | 数量 |\n| :--- | ---: |\n| **完成** | 8 |\n| 待补资料 | 2 |'} />)
    const table = screen.getByRole('table')
    expect(within(table).getAllByRole('columnheader').map(cell => cell.textContent)).toEqual(['项目', '数量'])
    expect(within(table).getAllByRole('row')).toHaveLength(3)
    expect(within(table).getByRole('cell', { name: '8' }).style.textAlign).toBe('right')
    expect(within(table).getByText('完成').tagName).toBe('STRONG')
  })

  it('keeps legacy blank-row tables, one-dash dividers, and escaped cell pipes readable', () => {
    render(<MessageText content={'| 字段\\|别名 | 样例 |\n\n| - | - |\n\n| A \\| B | `x\\|y` |\n\n| 箱号 | MSKU1234560 |\n\n请核对原单。'} />)
    const table = screen.getByRole('table')
    expect(within(table).getByRole('columnheader', { name: '字段|别名' })).toBeTruthy()
    expect(within(table).getByRole('cell', { name: 'A | B' })).toBeTruthy()
    expect(within(table).getByText('x|y').tagName).toBe('CODE')
    expect(within(table).getAllByRole('row')).toHaveLength(3)
    expect(screen.getByText('请核对原单。').closest('table')).toBeNull()
  })

  it('does not silently discard business values from an extra-width legacy row', () => {
    const { container } = render(<MessageText content={'| 编号 | 状态 |\n| --- | --- |\n| A001 | 已处理 |\n| A002 | 待复核 | USD 1280 不可丢弃 |'} />)
    expect(container.textContent).toContain('USD 1280 不可丢弃')
    expect(container.textContent).toContain('A002')
  })

  it('does not absorb a following fenced example whose language metadata contains a pipe', () => {
    const code = '| 示例编号 | 示例金额 |\n| A002 | USD 1280 |'
    const content = ['| 编号 | 状态 |', '| --- | --- |', '| A001 | 已完成 |', '', '```text title="A|B"', code, '```'].join('\n')
    const { container } = render(<MessageText content={content} />)
    const table = screen.getByRole('table')
    expect(within(table).getAllByRole('row')).toHaveLength(2)
    expect(container.querySelector('pre code')?.textContent).toBe(code)
    expect(within(table).queryByText('A002')).toBeNull()
  })

  it('renders inline and display formulas through KaTeX while keeping surrounding text', () => {
    const { container } = render(<MessageText content={'质量关系为 $E=mc^2$。\n\n$$\n\\frac{a}{b}=2\n$$\n\n以上为公式示例。'} />)
    expect(container.querySelectorAll('.katex')).toHaveLength(2)
    expect(container.querySelectorAll('.katex-display')).toHaveLength(1)
    const annotations = [...container.querySelectorAll('annotation[encoding="application/x-tex"]')].map(node => node.textContent?.trim())
    expect(annotations).toEqual(['E=mc^2', '\\frac{a}{b}=2'])
    expect(container.textContent).toContain('质量关系为')
    expect(container.textContent).toContain('以上为公式示例。')
    expect(container.querySelector('.katex-error')).toBeNull()
  })

  it('shows HTML and MDX-looking content as inert text instead of executing it or hiding it', () => {
    const payload = '普通说明 <script>window.richMessageExecuted = 1</script>\n\n<Notice onClick="richMessageExecuted()">业务内容必须保留 {runDangerously()}</Notice>\n\n<img src="https://files.example.com/beacon.png" onerror="richMessageExecuted()">\n\n<style>body { display:none }</style>'
    const { container } = render(<MessageText content={payload} />)
    expect(container.querySelector('script,style,iframe,object,embed,[onerror],[onload],[onclick]')).toBeNull()
    expect(container.querySelector('notice')).toBeNull()
    expect(container.querySelector('img[src="https://files.example.com/beacon.png"]')).toBeNull()
    expect(container.textContent).toContain('<script>window.richMessageExecuted = 1</script>')
    expect(container.textContent).toContain('业务内容必须保留 {runDangerously()}')
    expect(container.textContent).toContain('<style>body { display:none }</style>')
  })

  it('keeps approved HTTP links usable while unsafe protocols stay inert and visible', () => {
    const { container } = render(<MessageText content={'[船司官网](https://example.com/tracking?id=A001)\n\n[脚本](javascript:alert(1)) [本机文件](file:///D:/private.pdf) [内联数据](data:text/html,hello) [相对站点](//other.example.com/private)'} />)
    const link = screen.getByRole('link', { name: '船司官网' })
    expect(link.getAttribute('href')).toBe('https://example.com/tracking?id=A001')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toContain('noopener')
    expect(link.getAttribute('rel')).toContain('noreferrer')
    expect(screen.getAllByRole('link')).toHaveLength(1)
    for (const label of ['脚本', '本机文件', '内联数据', '相对站点']) expect(container.textContent).toContain(label)
    expect(container.querySelector('a[href^="javascript:"],a[href^="file:"],a[href^="data:"],a[href^="//"]')).toBeNull()
  })

  it('does not turn credential-bearing URLs or invalid protected routes into attachment controls', () => {
    const origin = window.location.origin
    const content = [
      '[含凭据](https://user:password@example.com/report.pdf)',
      `[变造附件](${origin}${attachmentRoute}?name=report.xlsx&unexpected=1)`,
      `![变造图片](${attachmentRoute}?name=chart.png&download=0)`,
      `[外域伪附件](https://files.example.com${attachmentRoute}?name=chart.png)`,
    ].join('\n\n')
    const { container } = render(<MessageText content={content} />)
    expect(screen.queryByRole('link', { name: '含凭据' })).toBeNull()
    expect(screen.queryByRole('link', { name: /打开文件|下载文件|下载图片/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /放大图片/ })).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('变造附件')
    expect(container.textContent).toContain('变造图片')
    expect(screen.getByRole('link', { name: '外域伪附件' }).getAttribute('href')).toBe(`https://files.example.com${attachmentRoute}?name=chart.png`)
  })

  it('keeps dollar amounts and their line-item scope as business text rather than accidental formulas', () => {
    const content = 'Ocean USD $1,280; docs USD $35; total USD $1,315.'
    const { container } = render(<MessageText content={content} />)
    expect(container.querySelector('.katex')).toBeNull()
    expect(container.textContent).toBe(content)
  })

  it('preserves authorized-route attachment controls inside normal text, lists and tables', () => {
    render(<MessageText content={`已生成 [核验清单](${attachment('箱号核验.csv')})。\n\n- ![本群业务图](${attachment('港口图.png')})\n\n| 产物 | 说明 |\n| --- | --- |\n| [报价报表](${attachment('报价.xlsx')}) | 可下载 |`} />)
    expect(screen.getByRole('link', { name: '打开文件：箱号核验.csv' }).getAttribute('href')).toContain(attachmentRoute)
    const download = screen.getByRole('link', { name: '下载文件：报价.xlsx' })
    expect(download.getAttribute('href')).toContain('download=1')
    expect(download.getAttribute('download')).toBe('报价.xlsx')
    expect(screen.getByRole('button', { name: '放大图片：本群业务图' })).toBeTruthy()
    expect(screen.getByRole('img', { name: '本群业务图' }).getAttribute('src')).toContain(attachmentRoute)
  })

  it('renders remote Markdown images as safe links without creating remote image requests', () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const { container } = render(<MessageText content={'![外部图表](https://files.example.com/chart.png)\n\n![内联像素](data:image/png;base64,AAAA)'} />)
    const remote = screen.getByRole('link', { name: /外部图表/ })
    expect(remote.getAttribute('href')).toBe('https://files.example.com/chart.png')
    expect(container.querySelector('img[src^="https://files.example.com"],img[src^="data:"]')).toBeNull()
    expect(container.textContent).toContain('内联像素')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('keeps link, attachment, HTML and math examples literal inside inline and fenced code', () => {
    const code = `[说明](https://example.com/help)\n![图](${attachment('sample.png')})\n<script>runDangerously()</script>\n$x^2$`
    const content = ['行内示例：`[官网](https://example.com/inline)`。', '', '```markdown', code, '```'].join('\n')
    const { container } = render(<MessageText content={content} />)
    expect(container.querySelector('pre code')?.textContent).toContain(code)
    expect(screen.getByText('[官网](https://example.com/inline)').tagName).toBe('CODE')
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    expect(container.querySelector('script,.katex')).toBeNull()
  })
})
