// @vitest-environment jsdom
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react'
import PdfAttachmentView from '../src/components/PdfAttachmentView'

vi.mock('lottie-web',()=>({default:{loadAnimation:vi.fn(()=>({destroy:vi.fn(),play:vi.fn(),pause:vi.fn(),addEventListener:vi.fn(),removeEventListener:vi.fn()}))}}))
const {bytesMock,getDocumentMock,workerOptions}=vi.hoisted(()=>({bytesMock:vi.fn(),getDocumentMock:vi.fn(),workerOptions:{workerSrc:''}}))
vi.mock('../src/lib/api',async original=>({...await original<any>(),apiAttachmentBytes:bytesMock}))
vi.mock('pdfjs-dist',()=>({getDocument:getDocumentMock,GlobalWorkerOptions:workerOptions}))
const url='/api/sessions/alpha/attachments/11111111-1111-4111-8111-111111111111'
const getPage=vi.fn(),destroy=vi.fn(),draw=vi.fn(),cancel=vi.fn()
beforeEach(()=>{
 vi.stubGlobal('matchMedia',vi.fn(()=>({matches:true,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){},dispatchEvent(){return true}})))
 vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}})
 vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue({} as any)
 bytesMock.mockReset().mockResolvedValue(new Uint8Array([37,80,68,70]));getDocumentMock.mockReset();getPage.mockReset();destroy.mockReset().mockResolvedValue(undefined);draw.mockReset().mockReturnValue({promise:Promise.resolve(),cancel});cancel.mockReset()
 getPage.mockImplementation(async()=>({getViewport:({scale}:{scale:number})=>({width:600*scale,height:800*scale}),render:draw}))
 getDocumentMock.mockReturnValue({promise:Promise.resolve({numPages:2,getPage}),destroy})
})
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals()})
describe('PDF canvas preview lifecycle',()=>{
 it('renders real document pages using authenticated bytes and the local worker, then navigates',async()=>{
  render(<PdfAttachmentView url={url} name="回执.pdf"/>);await screen.findByText('第 1 / 2 页');await waitFor(()=>expect(draw).toHaveBeenCalledOnce())
  expect(bytesMock).toHaveBeenCalledWith(url,{signal:expect.any(AbortSignal)});expect(getDocumentMock).toHaveBeenCalledWith(expect.objectContaining({data:expect.any(Uint8Array),useWasm:false,isEvalSupported:false,enableXfa:false,cMapUrl:'/assets/pdfjs/cmaps/'}));expect(workerOptions.workerSrc).toContain('pdf.worker.min.mjs')
  expect((screen.getByRole('img',{name:'回执.pdf，第 1 页'}) as HTMLCanvasElement).width).toBeGreaterThan(0);expect(document.querySelector('iframe')).toBeNull()
  fireEvent.click(screen.getByRole('button',{name:'PDF 下一页'}));await screen.findByText('第 2 / 2 页');await waitFor(()=>expect(getPage).toHaveBeenLastCalledWith(2));expect((screen.getByRole('button',{name:'PDF 下一页'}) as HTMLButtonElement).disabled).toBe(true)
 })
 it('cancels fetch, drawing and the worker loading task on close',async()=>{
  draw.mockReturnValue({promise:new Promise(()=>{}),cancel});const view=render(<PdfAttachmentView url={url} name="回执.pdf"/>);await waitFor(()=>expect(draw).toHaveBeenCalled())
  const signal=bytesMock.mock.calls[0][1].signal as AbortSignal;view.unmount();expect(signal.aborted).toBe(true);expect(cancel).toHaveBeenCalled();expect(destroy).toHaveBeenCalled()
 })
 it('shows a safe render error and supports retry without exposing PDF engine details',async()=>{
  getDocumentMock.mockReturnValueOnce({promise:Promise.reject(new Error('sensitive PDF internal details')),destroy}).mockReturnValueOnce({promise:Promise.resolve({numPages:2,getPage}),destroy})
  render(<PdfAttachmentView url={url} name="回执.pdf"/>);await screen.findByRole('alert');expect(screen.queryByText(/sensitive/)).toBeNull();fireEvent.click(screen.getByRole('button',{name:'重试 PDF 预览'}));await screen.findByText('第 1 / 2 页')
 })
 it('bounds pixels for unusually large PDF page dimensions',async()=>{
  getPage.mockResolvedValue({getViewport:({scale}:{scale:number})=>({width:60000*scale,height:80000*scale}),render:draw})
  render(<PdfAttachmentView url={url} name="大图.pdf"/>);await waitFor(()=>expect(draw).toHaveBeenCalled());const canvas=screen.getByRole('img',{name:'大图.pdf，第 1 页'}) as HTMLCanvasElement;expect(canvas.width*canvas.height).toBeLessThanOrEqual(12_000_000)
 })
})
