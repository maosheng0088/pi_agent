// @vitest-environment jsdom
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react'
import AttachmentPreview from '../src/components/AttachmentPreview'
import AttachmentDocumentPreview from '../src/components/AttachmentDocumentPreview'
import {messageAttachment} from '../src/lib/message-links'

vi.mock('lottie-web',()=>({default:{loadAnimation:vi.fn(()=>({destroy:vi.fn(),play:vi.fn(),pause:vi.fn(),addEventListener:vi.fn(),removeEventListener:vi.fn()}))}}))
const {apiMock}=vi.hoisted(()=>({apiMock:vi.fn()}))
vi.mock('../src/lib/api',async original=>({...await original<any>(),api:apiMock}))
vi.mock('../src/components/PdfAttachmentView',()=>({default:({name}:{name:string})=><canvas role="img" aria-label={`${name} 原始页面`}/>}))
const base='/api/sessions/alpha/attachments/11111111-1111-4111-8111-111111111111'
function attachment(name:string){return messageAttachment(`${base}?name=${encodeURIComponent(name)}`)!}
function parsed(overrides:any={}){return {document:{format:'docx',status:'ready',text:'文档正文',sections:[],warnings:[],truncated:false,...overrides}}}
beforeEach(()=>{
 apiMock.mockReset().mockResolvedValue(parsed())
 vi.stubGlobal('matchMedia',vi.fn(()=>({matches:true,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){},dispatchEvent(){return true}})))
 vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}})
})
afterEach(()=>{cleanup();vi.unstubAllGlobals()})
describe('authenticated file preview UI',()=>{
 it('reads documents only on preview and leaves download available',async()=>{
  render(<AttachmentPreview attachment={attachment('操作手册.docx')} label="操作手册"/>);expect(apiMock).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button',{name:'预览文件：操作手册.docx'}))
  const dialog=await screen.findByRole('dialog',{name:'文件预览 · 操作手册.docx'});await within(dialog).findByText('文档正文')
  expect(apiMock).toHaveBeenCalledWith(`${base}/content`,expect.objectContaining({signal:expect.any(AbortSignal)}));expect(within(dialog).getByText('已解析')).toBeTruthy();expect(within(dialog).getByRole('button',{name:'下载原文件'})).toBeTruthy()
 })
 it('renders extracted text as plain text without executing uploaded markup or links',async()=>{
  const unsafe='<img src=x onerror=alert(1)> [链接](javascript:alert(1))';apiMock.mockResolvedValue(parsed({format:'text',text:unsafe}))
  render(<AttachmentDocumentPreview attachment={attachment('note.txt')} onClose={vi.fn()}/>);await screen.findByText(unsafe)
  expect(document.querySelector('iframe,script,[onerror],[onload],a[href^="javascript:"]')).toBeNull()
 })
 it('switches spreadsheet sheets, paginates rows, and shows truncation',async()=>{
  apiMock.mockResolvedValue(parsed({format:'xlsx',text:'',truncated:true,warnings:['预览仅含部分行'],sheets:[{name:'预约清单',rows:Array.from({length:26},(_,i)=>[i+1,`预约-${i+1}`]),truncated:true},{name:'异常',rows:[['=HYPERLINK("https://example.com")',false]],truncated:false}]}))
  render(<AttachmentDocumentPreview attachment={attachment('预约.xlsx')} onClose={vi.fn()}/>);await screen.findByText('预约-1');expect(screen.getByText(/预览内容已截断/)).toBeTruthy();expect(screen.getByText(/当前工作表已截断/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button',{name:'表格下一页'}));await screen.findByText('预约-26');expect(screen.queryByText('预约-1')).toBeNull()
  fireEvent.click(screen.getByRole('combobox',{name:'工作表'}));fireEvent.click(await screen.findByRole('option',{name:/异常/}));await screen.findByText('=HYPERLINK("https://example.com")');expect(screen.getByText('false')).toBeTruthy();expect(document.querySelector('a[href="https://example.com"]')).toBeNull()
 })
 it('keeps the PDF page renderer visible when text needs OCR or parsing failed',async()=>{
  apiMock.mockResolvedValue(parsed({format:'pdf',status:'needs_ocr',text:'',pageCount:3,warnings:['此文件为扫描件']}))
  render(<AttachmentDocumentPreview attachment={attachment('scan.pdf')} onClose={vi.fn()}/>);await screen.findByText('需要文字识别');expect(await screen.findByRole('img',{name:'scan.pdf 原始页面'})).toBeTruthy();expect(screen.getByText(/仍可查看上方原始页面/)).toBeTruthy()
 })
 it('does not block original PDF pages when extraction returns an error',async()=>{
  apiMock.mockResolvedValue(parsed({format:'pdf',status:'error',text:'',warnings:['文字解析未完成']}))
  render(<AttachmentDocumentPreview attachment={attachment('original.pdf')} onClose={vi.fn()}/>);await screen.findByText('文字解析失败');expect(await screen.findByRole('img',{name:'original.pdf 原始页面'})).toBeTruthy();expect(screen.getByText(/原始页面预览和下载仍可使用/)).toBeTruthy()
 })
 it('clearly labels unsupported legacy files as download-only without parsing',()=>{
  render(<AttachmentPreview attachment={attachment('历史.xls')} label="历史表格"/>);expect(screen.queryByRole('button',{name:'预览文件：历史.xls'})).toBeNull();expect(screen.getByText(/仅下载/)).toBeTruthy();expect(screen.getByRole('link',{name:'下载文件：历史.xls'})).toBeTruthy();expect(apiMock).not.toHaveBeenCalled()
 })
 it('shows parsing progress, retries a failed read, and aborts when closed',async()=>{
  let reject!:(error:unknown)=>void;apiMock.mockReturnValueOnce(new Promise((_resolve,no)=>{reject=no})).mockResolvedValueOnce(parsed())
  const view=render(<AttachmentDocumentPreview attachment={attachment('manual.docx')} onClose={vi.fn()}/>);expect(screen.getByText('正在解析文档内容…')).toBeTruthy();const signal=apiMock.mock.calls[0][1].signal as AbortSignal
  await act(async()=>reject(new Error('连接中断')));expect(screen.getByRole('alert').textContent).toContain('连接中断');fireEvent.click(screen.getByRole('button',{name:'重新读取文档'}));await screen.findByText('文档正文');expect(signal.aborted).toBe(true)
  const last=apiMock.mock.calls.at(-1)![1].signal as AbortSignal;view.unmount();expect(last.aborted).toBe(true)
 })
 it('ignores delayed private content after unmounting and never reads invalid URLs',async()=>{
  let resolve!:(value:any)=>void;apiMock.mockReturnValue(new Promise(yes=>{resolve=yes}));const view=render(<AttachmentDocumentPreview attachment={attachment('manual.docx')} onClose={vi.fn()}/>),signal=apiMock.mock.calls[0][1].signal as AbortSignal
  view.unmount();expect(signal.aborted).toBe(true);await act(async()=>resolve(parsed({text:'旧群私有内容'})));expect(screen.queryByText('旧群私有内容')).toBeNull()
  apiMock.mockClear();render(<AttachmentDocumentPreview attachment={{...attachment('manual.docx'),href:'https://example.com/evil.docx'}} onClose={vi.fn()}/>);expect(screen.getByRole('alert').textContent).toContain('附件地址无效');expect(apiMock).not.toHaveBeenCalled()
 })
})
