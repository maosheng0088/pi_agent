import {useEffect,useRef,useState} from 'react'
import {Button,Spin} from '@douyinfe/semi-ui'
import {IconChevronLeft,IconChevronRight,IconRefresh} from '@douyinfe/semi-icons'
import {getDocument,GlobalWorkerOptions} from 'pdfjs-dist'
import type {PDFDocumentLoadingTask,PDFDocumentProxy,RenderTask} from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import {apiAttachmentBytes,ApiError,errorMessage} from '../lib/api'

GlobalWorkerOptions.workerSrc=workerUrl
const MAX_CANVAS_PIXELS=12_000_000
export default function PdfAttachmentView({url,name}:{url:string;name:string}){
 const [pdf,setPdf]=useState<PDFDocumentProxy|null>(null),[page,setPage]=useState(1),[loading,setLoading]=useState(true),[drawing,setDrawing]=useState(false),[error,setError]=useState(''),[retry,setRetry]=useState(0),[width,setWidth]=useState(740)
 const canvas=useRef<HTMLCanvasElement>(null),area=useRef<HTMLDivElement>(null),drawingTask=useRef<RenderTask|null>(null)
 useEffect(()=>{
  const controller=new AbortController();let current=true,task:PDFDocumentLoadingTask|undefined
  setPdf(null);setPage(1);setError('');setLoading(true)
  void apiAttachmentBytes(url,{signal:controller.signal}).then(bytes=>{
   if(!current)return
   const options={data:bytes,cMapUrl:'/assets/pdfjs/cmaps/',cMapPacked:true,standardFontDataUrl:'/assets/pdfjs/standard_fonts/',iccUrl:'/assets/pdfjs/iccs/',wasmUrl:'/assets/pdfjs/wasm/',useWasm:false,isEvalSupported:false,enableXfa:false,maxImageSize:16_000_000,canvasMaxAreaInBytes:48_000_000,verbosity:0}
   task=getDocument(options)
   return task.promise.then(document=>{if(current)setPdf(document);else void task?.destroy()})
  }).catch(reason=>{if(!current||controller.signal.aborted)return;setError(reason instanceof ApiError?errorMessage(reason):reason?.name==='PasswordException'?'此 PDF 已加密，暂无法在线预览。请下载后打开。':'PDF 画面加载失败，可重试或下载查看。')}).finally(()=>{if(current)setLoading(false)})
  return()=>{current=false;controller.abort();drawingTask.current?.cancel();void task?.destroy()}
 },[url,retry])
 useEffect(()=>{const element=area.current;if(!element)return;const measure=()=>{if(element.clientWidth>0)setWidth(Math.max(80,Math.min(1000,element.clientWidth-24)))};measure();if(typeof ResizeObserver==='undefined')return;const observer=new ResizeObserver(measure);observer.observe(element);return()=>observer.disconnect()},[])
 useEffect(()=>{
  if(!pdf||!canvas.current)return
  let current=true,render:RenderTask|undefined;const target=canvas.current
  setDrawing(true);setError('')
  void pdf.getPage(page).then(async documentPage=>{
   if(!current)return
   const base=documentPage.getViewport({scale:1})
   if(!Number.isFinite(base.width)||!Number.isFinite(base.height)||base.width<=0||base.height<=0)throw new Error('invalid viewport')
   const ratio=Math.max(1,Math.min(window.devicePixelRatio||1,2)),scale=Math.min(width/base.width,Math.sqrt(MAX_CANVAS_PIXELS/(base.width*base.height))/ratio),viewport=documentPage.getViewport({scale})
   const context=target.getContext('2d');if(!context)throw new Error('canvas unavailable')
   target.width=Math.max(1,Math.floor(viewport.width*ratio));target.height=Math.max(1,Math.floor(viewport.height*ratio));target.style.width=`${viewport.width}px`;target.style.height='auto'
   render=documentPage.render({canvas:target,canvasContext:context,viewport,transform:ratio!==1?[ratio,0,0,ratio,0,0]:undefined});drawingTask.current=render;await render.promise
  }).catch(reason=>{if(current&&reason?.name!=='RenderingCancelledException')setError('这一页暂时无法显示，可重试或下载查看。')}).finally(()=>{if(current)setDrawing(false)})
  return()=>{current=false;render?.cancel();if(drawingTask.current===render)drawingTask.current=null}
 },[pdf,page,width])
 return <section className="attachment-pdf-view" aria-label="PDF 逐页预览"><div className="attachment-pdf-toolbar"><Button icon={<IconChevronLeft aria-hidden/>} disabled={!pdf||page<=1||drawing} onClick={()=>setPage(value=>value-1)} aria-label="PDF 上一页">上一页</Button><span role="status" aria-live="polite">{pdf?`第 ${page} / ${pdf.numPages} 页`:'PDF 原始页面'}</span><Button icon={<IconChevronRight aria-hidden/>} disabled={!pdf||page>=pdf.numPages||drawing} onClick={()=>setPage(value=>value+1)} aria-label="PDF 下一页">下一页</Button></div><div ref={area} className="attachment-pdf-canvas-area" aria-busy={loading||drawing}>{(loading||drawing)&&<div className="attachment-preview-loading" role="status"><Spin size="small"/><span>{loading?'正在加载 PDF 原始页面…':'正在绘制这一页…'}</span></div>}{error&&<div className="attachment-preview-error" role="alert"><p>{error}</p><Button icon={<IconRefresh aria-hidden/>} onClick={()=>setRetry(value=>value+1)}>重试 PDF 预览</Button></div>}<canvas ref={canvas} className={!pdf||error?'attachment-hidden-canvas':undefined} role="img" aria-label={`${name}，第 ${page} 页`}/></div></section>
}
