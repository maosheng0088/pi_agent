// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import MessageText from '../src/components/MessageText'
import { messageBlocks, splitPipeRow } from '../src/lib/message-markdown'

vi.mock('lottie-web', () => ({ default: { loadAnimation: vi.fn(() => ({ destroy: vi.fn(), play: vi.fn(), pause: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() })) } }))
const route='/api/sessions/alpha/attachments/b54981a6-963c-4c38-92e2-01da3b4af4e4'
let stylesheet:HTMLStyleElement
beforeAll(()=>{stylesheet=document.createElement('style');stylesheet.textContent=readFileSync(resolve(process.cwd(),'src/components/markdown-blocks.css'),'utf8');document.head.append(stylesheet)})
beforeEach(()=>{vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}})})
afterEach(()=>{cleanup();vi.unstubAllGlobals()})
afterAll(()=>stylesheet.remove())

describe('safe Markdown block rendering',()=>{
  it('renders actual header/body rows with column alignment and existing inline bold',()=>{
    render(<MessageText content={'| 项目 | 状态 | 数量 |\n| :--- | :---: | ---: |\n| 提柜资料 | **已核对** | 12 |\n| 客户要求 | 待补充 | 2 |'}/>)
    const table=screen.getByRole('table',{name:'消息数据表'})
    expect(within(table).getAllByRole('columnheader').map(cell=>cell.textContent)).toEqual(['项目','状态','数量'])
    expect(within(table).getAllByRole('row')).toHaveLength(3)
    expect(within(table).getByText('已核对').tagName).toBe('STRONG')
    expect(within(table).getByRole('columnheader',{name:'状态'}).style.textAlign).toBe('center')
    expect(within(table).getByRole('columnheader',{name:'数量'}).style.textAlign).toBe('right')
    expect(within(table).getByRole('cell',{name:'12'}).style.textAlign).toBe('right')
  })
  it('tolerates blank lines between valid table rows without leaving raw pipe fragments',()=>{
    render(<MessageText content={'| 字段 | 值 |\n\n| - | - |\n\n| 箱号 | CSQU3054383 |\n\n\n| 校验 | 通过 |\n\n结束说明。'}/>)
    const table=screen.getByRole('table')
    expect(within(table).getAllByRole('row')).toHaveLength(3)
    expect(within(table).getByRole('cell',{name:'CSQU3054383'})).toBeTruthy()
    expect(table.textContent).not.toContain('|')
    expect(screen.getByText('结束说明。')).toBeTruthy()
  })
  it('requires a valid same-width divider before interpreting pipe-containing lines as a table',()=>{
    const content='普通文本 | 继续文本\n\n| 不是 | 有效表头 |\n| ------ |\n| 这一行 | 必须保留 |'
    render(<MessageText content={content}/>)
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.getByText('普通文本 | 继续文本')).toBeTruthy()
    const paragraph=screen.getByText((text,element)=>element?.tagName==='P'&&text.includes('| 不是 | 有效表头 |'))
    expect(paragraph.textContent).toContain('| 这一行 | 必须保留 |')
  })
  it('keeps escaped pipes and pipes inside single/double-backtick code in their intended cells',()=>{
    const content='| 字段\\|别名 | 样例 |\n| --- | --- |\n| A \\| B | `x|y` |\n| 多反引号 | ``tick`|value`` |\n| 转义代码管道 | `a\\|b` |'
    render(<MessageText content={content}/>)
    expect(screen.getByRole('columnheader',{name:'字段|别名'})).toBeTruthy()
    expect(screen.getByRole('cell',{name:'A | B'})).toBeTruthy()
    for(const value of ['x|y','tick`|value','a|b'])expect(screen.getByText(value).tagName).toBe('CODE')
    expect(screen.getAllByRole('row')).toHaveLength(4)
    expect(screen.getAllByRole('cell')).toHaveLength(6)
  })
  it('distinguishes escaped delimiters, real delimiters after paired backslashes, and trailing literal pipes',()=>{
    expect(splitPipeRow('| A\\|B |').cells).toEqual(['A|B'])
    expect(splitPipeRow('| A\\\\| B |').cells).toEqual(['A\\\\','B'])
    expect(splitPipeRow('| `a|` | end\\|').cells).toEqual(['`a|`','end|'])
    expect(splitPipeRow('| `unclosed | next |').cells).toEqual(['`unclosed','next'])
  })
  it('pads a missing body cell but preserves an extra-cell row as unmodified ordinary text',()=>{
    render(<MessageText content={'| 字段 | 值 |\n| --- | --- |\n| 单列 |\n| 太多 | 单元 | 不可丢弃 |'}/>)
    expect(screen.getAllByRole('cell')).toHaveLength(2)
    expect(screen.getByText('| 太多 | 单元 | 不可丢弃 |')).toBeTruthy()
  })
  it('renders raw HTML and dangerous URLs inert inside real table cells',()=>{
    render(<MessageText content={'| <img src=x onerror=alert(1)> | 内容 |\n| --- | --- |\n| <svg onload=alert(1)> | [危险](javascript:alert(1)) |\n| 远程图片 | ![外链图片](https://files.example.com/chart.png) |\n| 帮助 | [官网](https://example.com/help) |'}/>)
    expect(screen.getByRole('columnheader',{name:'<img src=x onerror=alert(1)>'})).toBeTruthy()
    expect(screen.getByText('<svg onload=alert(1)>')).toBeTruthy()
    expect(document.querySelector('script,[onerror],[onload],a[href^="javascript:"]')).toBeNull()
    expect(document.querySelector('img[src="https://files.example.com/chart.png"]')).toBeNull()
    const link=screen.getByRole('link',{name:'官网'})
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toContain('noopener')
  })
  it('keeps protected file download and image preview semantics inside table cells',()=>{
    const file=`${route}?name=report.xlsx`,image=`${route}?name=chart.png`
    render(<MessageText content={`| 产物 | 文件 |\n| --- | --- |\n| 报表 | [业务结果](${file}) |\n| 图片 | ![业务图](${image}) |`}/>)
    expect(screen.getByRole('link',{name:'下载文件：report.xlsx'}).getAttribute('href')).toContain('download=1')
    expect(screen.getByRole('link',{name:'打开文件：report.xlsx'})).toBeTruthy()
    expect(screen.getByRole('button',{name:'放大图片：业务图'})).toBeTruthy()
    expect(screen.getByRole('img',{name:'业务图'}).getAttribute('src')).toContain(route)
  })
  it('keeps fenced examples literal and does not turn contained table/link examples into live controls',()=>{
    const body=`| 字段 | 文件 |\n\n| --- | --- |\n| 行 | ![图](${route}?name=example.png) |\n[说明](https://example.com/help)`
    render(<MessageText content={`\`\`\`markdown\n${body}\n\`\`\``}/>)
    expect(document.querySelector('pre code')?.textContent).toBe(body)
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.queryByRole('button',{name:/放大图片/})).toBeNull()
    expect(screen.queryByRole('img')).toBeNull()
  })
  it('matches longer fences correctly and preserves unclosed code through end of input',()=>{
    const blocks=messageBlocks('````text\n```\n| a | b |\n| - | - |\n````\n末尾')
    expect(blocks[0]).toEqual({kind:'code',language:'text',content:'```\n| a | b |\n| - | - |'})
    expect(blocks[1]).toEqual({kind:'line',text:'末尾'})
    expect(messageBlocks('~~~text\n<svg onload=alert(1)>\n')).toEqual([{kind:'code',language:'text',content:'<svg onload=alert(1)>\n'}])
  })
  it('decodes Markdown entities once as inert text and preserves escaped links',()=>{
    render(<MessageText content={'&lt;script&gt;保持原文&lt;/script&gt;\n\n&amp;lt;script&amp;gt;不能二次解码&amp;lt;/script&amp;gt;\n\n\\[示例](https://example.com/help)'}/>)
    expect(screen.getByText('<script>保持原文</script>')).toBeTruthy()
    expect(screen.getByText('&lt;script&gt;不能二次解码&lt;/script&gt;')).toBeTruthy()
    expect(screen.queryByRole('link')).toBeNull()
    expect(document.querySelector('script')).toBeNull()
  })
  it('keeps simple lists and existing bold, code and headings readable',()=>{
    render(<MessageText content={'## 处理结果\n- **通过**\n- 读取 `柜号`\n\n3. 复核客户\n4. 交付文件'}/>)
    expect(screen.getByRole('heading',{name:'处理结果'})).toBeTruthy()
    expect(screen.getAllByRole('list')).toHaveLength(2)
    expect(screen.getAllByRole('listitem')).toHaveLength(4)
    expect(screen.getByText('通过').tagName).toBe('STRONG')
    expect(screen.getByText('柜号').tagName).toBe('CODE')
    expect(screen.getAllByRole('list')[1].getAttribute('start')).toBe('3')
  })
  it('renders code semantics inside links and bold while outer code stays inert',()=>{
    const {container}=render(<MessageText content={'[读取 `说明`](https://example.com/help)\n[保留 ``原文``](https://example.com/guide)\n**粗体含 `柜号`**\n``[示例](https://example.com/inert)``'}/>)
    const help=screen.getByRole('link',{name:'读取 说明'}),guide=screen.getByRole('link',{name:'保留 原文'})
    expect(help.getAttribute('href')).toBe('https://example.com/help')
    expect(guide.getAttribute('href')).toBe('https://example.com/guide')
    expect(within(help).getByText('说明').tagName).toBe('CODE')
    expect(within(guide).getByText('原文').tagName).toBe('CODE')
    expect(container.querySelector('strong')?.textContent).toBe('粗体含 柜号')
    expect(screen.getByText('柜号').tagName).toBe('CODE')
    expect(screen.getByText('[示例](https://example.com/inert)').tagName).toBe('CODE')
    expect(screen.getAllByRole('link')).toHaveLength(2)
  })
  it('contains a wide table in a bounded keyboard-focusable horizontal scroll region',()=>{
    render(<div style={{width:260}}><MessageText content={'| A | B | C | D |\n| - | - | - | - |\n| 长字段 | 多列信息 | 业务编号 | 交付说明 |'}/></div>)
    const region=screen.getByRole('region',{name:'表格内容，可横向滚动'})
    expect(region.tabIndex).toBe(0)
    expect(within(region).getByRole('table')).toBeTruthy()
    const style=getComputedStyle(region)
    expect(style.maxWidth).toBe('100%')
    expect(style.overflowX).toBe('auto')
    expect(style.minWidth).toBe('0px')
  })
})
