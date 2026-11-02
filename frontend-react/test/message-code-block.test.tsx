// @vitest-environment jsdom
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest'
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import MessageCodeBlock,{sanitizeMermaidSvg} from '../src/components/MessageCodeBlock'

const {renderer}=vi.hoisted(()=>({renderer:{initialize:vi.fn(),render:vi.fn()}}))
vi.mock('mermaid',()=>({default:renderer}))
vi.mock('lottie-web',()=>({default:{loadAnimation:vi.fn(()=>({destroy(){},play(){},pause(){},addEventListener(){},removeEventListener(){}}))}}))
const goodSvg='<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80" viewBox="0 0 200 80"><rect x="1" y="1" width="198" height="78"/><text x="10" y="40">安全图示</text></svg>'
let stylesheet:HTMLStyleElement
beforeAll(()=>{stylesheet=document.createElement('style');stylesheet.textContent=readFileSync(resolve(process.cwd(),'src/components/message-code.css'),'utf8');document.head.append(stylesheet)})
beforeEach(()=>{
 renderer.render.mockReset().mockResolvedValue({svg:goodSvg,bindFunctions:vi.fn()})
 vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}})
 vi.stubGlobal('matchMedia',vi.fn(()=>({matches:false,addEventListener(){},removeEventListener(){},addListener(){},removeListener(){}})))
 vi.stubGlobal('fetch',vi.fn());Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:vi.fn().mockResolvedValue(undefined)}})
})
afterEach(()=>{cleanup();vi.useRealTimers();vi.unstubAllGlobals()})
afterAll(()=>stylesheet.remove())
function source(container:HTMLElement){return container.querySelector('pre code')?.textContent||''}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes});return {promise,resolve}}

describe('safe message code blocks with real Semi highlighting',()=>{
 it.each([
  ['py','Python','def greet():\n    return "hello"','python'],
  ['JS','JavaScript','const result = true;','javascript'],
  ['ts','TypeScript','const count: number = 1;','typescript'],
  ['json','JSON','{"count": 1, "ok": true}','json'],
  ['sh','Shell','echo "$HOME"','bash'],
  ['pwsh','PowerShell','Get-Process | Select-Object Name','powershell'],
  ['postgresql','SQL','SELECT id FROM tasks WHERE active = TRUE;','sql'],
  ['html','HTML','<section class="result">业务结果</section>','markup'],
  ['xml','XML','<result status="ok">通过</result>','markup'],
  ['svg','SVG','<svg viewBox="0 0 20 20"><circle r="5"/></svg>','markup'],
  ['css','CSS','.result { color: blue; display: flex; }','css'],
  ['clike','C-like','int count = 1; // static source','clike'],
  ['jsx','JSX','const Result = () => <section>{value}</section>;','jsx'],
  ['tsx','TSX','const Result = ({value}: {value: string}) => <section>{value}</section>;','tsx'],
 ])('normalizes %s to %s without guessing unrelated grammars',(language,label,code,canonical)=>{
  const{container}=render(<MessageCodeBlock code={code} language={language}/>)
  expect(screen.getByRole('region',{name:`${label}代码块`})).toBeTruthy();expect(container.querySelector(`code.language-${canonical}`)).toBeTruthy()
  expect(container.querySelector('.token')).toBeTruthy();expect(source(container)).toBe(code)
 })
 it('falls back to literal code for unknown languages and never executes raw markup',()=>{
  const code='<script>window.unsafeCode=true</script>\n<img src="https://evil.example/x" onerror="alert(1)">'
  const{container}=render(<MessageCodeBlock code={code} language="made-up"/>)
  expect(source(container)).toBe(code);expect(container.querySelector('script,img,[onerror],.token')).toBeNull();expect(fetch).not.toHaveBeenCalled()
 })
 it.each(['html','svg','jsx','tsx'])('highlights %s source without creating active DOM or loading remote resources',language=>{
  const code='<script>window.unsafeCode=true</script>\n<img src="https://evil.example/x" onerror="alert(1)"/>',view=render(<MessageCodeBlock code={code} language={language}/>)
  expect(source(view.container)).toBe(code);expect(view.container.querySelector('pre script,pre img,pre svg,[onerror],[onload]')).toBeNull()
  expect(fetch).not.toHaveBeenCalled();expect(renderer.render).not.toHaveBeenCalled()
 })
 it('copies complete original code with explicit success and honest clipboard failure feedback',async()=>{
  const code='line one\r\nline two\n',view=render(<MessageCodeBlock code={code} language="text"/>)
  fireEvent.click(screen.getByRole('button',{name:'复制此代码块'}));await waitFor(()=>expect(navigator.clipboard.writeText).toHaveBeenCalledWith(code));expect(await screen.findByText('已复制')).toBeTruthy()
  vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error('blocked'));fireEvent.click(screen.getByRole('button',{name:'复制此代码块'}));expect(await screen.findByText('复制失败，请手动选择代码。')).toBeTruthy()
  view.unmount()
 })
 it('collapses long code, expands the complete text and still copies the full source while collapsed',async()=>{
  const code=Array.from({length:45},(_,index)=>`line_${index}`).join('\n'),{container}=render(<MessageCodeBlock code={code}/>)
  expect(source(container)).not.toContain('line_44');fireEvent.click(screen.getByRole('button',{name:'复制此代码块'}));await waitFor(()=>expect(navigator.clipboard.writeText).toHaveBeenCalledWith(code))
  fireEvent.click(screen.getByRole('button',{name:'展开全部代码（45 行）'}));expect(source(container)).toBe(code)
  fireEvent.click(screen.getByRole('button',{name:'收起代码'}));expect(source(container)).not.toContain('line_44')
 })
 it('bounds a single extremely long line and avoids expensive highlighting for large expanded code',()=>{
  const code='x'.repeat(65000),{container}=render(<MessageCodeBlock code={code} language="javascript"/>)
  expect(source(container).length).toBe(2400);fireEvent.click(screen.getByRole('button',{name:'展开全部代码（1 行）'}));expect(source(container)).toBe(code)
  expect(container.querySelector('.message-code-highlight')).toBeNull();expect(getComputedStyle(container.querySelector('.message-code-plain')!).overflowX).toBe('auto')
 })
 it('keeps literal JSON numeric facts and invalid JSON unchanged rather than parsing and stringifying',()=>{
  const code='{"id":900719925474099312345,"value":1.000e+20}',view=render(<MessageCodeBlock code={code} language="json"/>)
  expect(source(view.container)).toBe(code);view.rerender(<MessageCodeBlock code={'{"broken":,}'} language="json"/>);expect(source(view.container)).toBe('{"broken":,}')
 })
 it('re-highlights a changed language and discards obsolete copy feedback after code changes',async()=>{
  const pending=deferred<void>();vi.mocked(navigator.clipboard.writeText).mockReturnValueOnce(pending.promise)
  const view=render(<MessageCodeBlock code="const first = 1" language="js"/>);fireEvent.click(screen.getByRole('button',{name:'复制此代码块'}))
  view.rerender(<MessageCodeBlock code="def second(): pass" language="py"/>);await act(async()=>pending.resolve())
  expect(view.container.querySelector('code.language-python')).toBeTruthy();expect(screen.queryByText('已复制')).toBeNull()
 })
})

describe('bounded static Mermaid rendering',()=>{
 it('loads Mermaid on demand using strict settings and exposes only a sanitized static image with source controls',async()=>{
  const bindFunctions=vi.fn();renderer.render.mockResolvedValueOnce({svg:goodSvg,bindFunctions})
  const code='flowchart LR\n A[业务请求] --> B[处理完成]',{container}=render(<MessageCodeBlock code={code} language="mermaid"/>)
  const image=await screen.findByRole('img',{name:'Mermaid 图示'});expect(image.getAttribute('src')).toMatch(/^data:image\/svg\+xml;charset=utf-8,/)
  expect(renderer.initialize).toHaveBeenCalledWith(expect.objectContaining({startOnLoad:false,securityLevel:'strict',htmlLabels:false,flowchart:{htmlLabels:false},maxTextSize:8000,maxEdges:150}))
  expect(bindFunctions).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();expect(container.querySelector('.message-mermaid-staging')?.children.length).toBe(0)
  fireEvent.click(screen.getByRole('button',{name:'查看源码'}));expect(source(container)).toBe(code);fireEvent.click(screen.getByRole('button',{name:'复制此代码块'}));await waitFor(()=>expect(navigator.clipboard.writeText).toHaveBeenCalledWith(code))
  fireEvent.click(screen.getByRole('button',{name:'返回图示'}));expect(screen.getByRole('img',{name:'Mermaid 图示'})).toBeTruthy()
 })
 it.each([
  'flowchart LR\n A-->B\n click A callback',
  '%%{init: {"securityLevel":"loose"}}%%\nflowchart LR\n A-->B',
  '---\nconfig:\n  securityLevel: loose\n---\nflowchart LR\n A-->B',
  'flowchart LR\n A[<img src="https://evil.example/x">]',
  'flowchart LR\n A@{img: "https://evil.example/x"}',
  'flowchart LR\n A-->B\n style A fill:url(https://evil.example/x)',
 ])('keeps interactive/configured/external-resource diagrams inert without invoking Mermaid: %s',async code=>{
  const{container}=render(<MessageCodeBlock code={code} language="mmd"/>)
  expect(await screen.findByText('图示含不支持的配置、链接或交互，已显示源码。')).toBeTruthy();expect(renderer.render).not.toHaveBeenCalled()
  expect(source(container)).toBe(code);expect(container.querySelector('img,a,script,[onload]')).toBeNull();expect(fetch).not.toHaveBeenCalled()
 })
 it('keeps oversized diagrams as foldable source without loading the renderer',async()=>{
  const code=`flowchart LR\n${'A-->B\n'.repeat(180)}`,{container}=render(<MessageCodeBlock code={code} language="mermaid"/>)
  expect(await screen.findByText('图示较长，已保留源码，可复制后查看。')).toBeTruthy();expect(renderer.render).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button',{name:/展开全部代码/}));expect(source(container)).toBe(code)
 })
 it('falls back to source when syntax rendering fails without exposing raw error stacks',async()=>{
  renderer.render.mockRejectedValueOnce(new Error('private renderer stack /sensitive/path'))
  const code='flowchart LR\n broken[',view=render(<MessageCodeBlock code={code} language="mermaid"/>)
  expect(await screen.findByText('图示暂时无法生成，已保留原始源码。')).toBeTruthy();expect(source(view.container)).toBe(code);expect(screen.queryByText(/private renderer/)).toBeNull()
 })
 it('removes scripts, links, foreignObject, resource URLs, CSS imports and event attributes from renderer SVG output',()=>{
  const raw='<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><style>@import url(https://evil.example/x);</style><script>alert(1)</script><foreignObject><img src="https://evil.example/x"/></foreignObject><a href="javascript:alert(1)"><text>safe</text></a><image href="https://evil.example/x"/><rect style="fill:url(https://evil.example/x)" onclick="alert(1)" fill="url(https://evil.example/x)"/><path marker-end="url(#local)"/></svg>'
  const clean=sanitizeMermaidSvg(raw),parsed=new DOMParser().parseFromString(clean,'image/svg+xml')
  expect(parsed.querySelector('script,foreignObject,a,image,style,img,[onload],[onclick],[href],[style],[fill]')).toBeNull()
  expect(parsed.querySelector('text')?.textContent).toBe('safe');expect(parsed.querySelector('path')?.getAttribute('marker-end')).toBe('url(#local)')
 })
 it('ignores an obsolete render result after switching to another code block and cleans staging elements',async()=>{
  const pending=deferred<{svg:string}>();renderer.render.mockReturnValueOnce(pending.promise)
  const view=render(<MessageCodeBlock code={'flowchart LR\n A-->B'} language="mermaid"/>);await waitFor(()=>expect(renderer.render).toHaveBeenCalledTimes(1))
  view.rerender(<MessageCodeBlock code="plain replacement" language="unknown"/>);await act(async()=>pending.resolve({svg:goodSvg}))
  expect(screen.queryByRole('img',{name:'Mermaid 图示'})).toBeNull();expect(source(view.container)).toBe('plain replacement');expect(view.container.querySelector('.message-mermaid-staging')?.children.length).toBe(0)
 })
 it('falls back to readable source when diagram generation times out',async()=>{
  vi.useFakeTimers();renderer.render.mockImplementationOnce(()=>new Promise(()=>{}));const code='flowchart LR\n A-->B'
  const view=render(<MessageCodeBlock code={code} language="mermaid"/>);await act(async()=>{await Promise.resolve();await Promise.resolve()})
  await act(async()=>{vi.advanceTimersByTime(8001)})
  expect(screen.getByText('图示暂时无法生成，已保留原始源码。')).toBeTruthy();expect(source(view.container)).toBe(code);expect(view.container.querySelector('.message-mermaid-staging')?.children.length).toBe(0)
 })
})
