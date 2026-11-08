import {useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react'
import DOMPurify from 'dompurify'
import {api,apiAttachmentBytes,ApiError} from '../lib/api'

const bodyTags=[
 'a','b','blockquote','br','caption','code','col','colgroup','dd','del','div','dl','dt','em',
 'h1','h2','h3','h4','h5','h6','hr','i','img','li','ol','p','pre','s','small','span',
 'strong','sub','sup','table','tbody','td','tfoot','th','thead','tr','u','ul',
]
const maxInlineImageBytes=4*1024*1024
const maxInlineImageCount=16
const richCachePollMs=6000
const richCachePollLimitMs=60000
const inlineCachePollMs=4000
export const maxImagePreviewBytes=8*1024*1024

export function rasterImageType(bytes:Uint8Array){
 const match=(signature:number[],offset=0)=>signature.every((value,index)=>bytes[index+offset]===value)
 if(match([137,80,78,71,13,10,26,10]))return 'image/png'
 if(match([255,216,255]))return 'image/jpeg'
 if(match([71,73,70,56,55,97])||match([71,73,70,56,57,97]))return 'image/gif'
 if(match([82,73,70,70])&&match([87,69,66,80],8))return 'image/webp'
 return null
}

function normalizeCid(value:string,decode=false){
 if(value.length>1024)return ''
 try{return (decode?decodeURIComponent(value):value).trim().replace(/^<|>$/g,'').toLowerCase()}
 catch{return ''}
}

function absoluteLink(value:string,allowMailto=true){
 if(!/^(?:https?:\/\/|mailto:)/i.test(value))return null
 try{
  const url=new URL(value)
  if(url.username||url.password)return null
  if(url.protocol==='http:'||url.protocol==='https:'||allowMailto&&url.protocol==='mailto:')return url.href
 }catch{}
 return null
}

export interface RichBody {html:string;hasInlineImages:boolean;truncated?:boolean}
interface LocalRichBody extends RichBody {pending?:boolean}
interface RichImages {images?:unknown;truncated?:boolean;pending?:boolean}
interface BodyView {fragment:DocumentFragment;externalImages:number;loadInlineImages:boolean}

function inlineImages(data:unknown){
 const images=new Map<string,string>()
 let encodedBytes=0
 if(Array.isArray(data))for(const item of data.slice(0,maxInlineImageCount)){
  if(typeof item?.cid!=='string'||typeof item.data!=='string'||item.data.length%4!==0
    ||item.data.length>Math.ceil(maxInlineImageBytes/3)*4||encodedBytes+item.data.length>16*1024*1024
    ||!/^[A-Za-z0-9+/]+={0,2}$/.test(item.data))continue
  const key=normalizeCid(item.cid)
  try{
   const type=rasterImageType(Uint8Array.from(atob(item.data.slice(0,24)),char=>char.charCodeAt(0)))
   if(key&&type===item.mimeType){images.set(key,`data:${type};base64,${item.data}`);encodedBytes+=item.data.length}
  }catch{}
 }
 return images
}

function imageUnavailable(alt:string){return alt?`图片不可用（${alt}）`:'图片不可用'}

function newTabLink(href:string){
 const link=document.createElement('a')
 link.href=href
 link.target='_blank'
 link.rel='noopener noreferrer'
 return link
}

function renderMessage(html:string|undefined,hasInlineImages:boolean):BodyView|null{
 if(typeof html!=='string'||!html.trim())return null
 // The template keeps the original resource attributes inert during HTML parsing.
 const template=document.createElement('template')
 template.innerHTML=html
 const fragment=DOMPurify.sanitize(template.content,{
  ALLOWED_TAGS:bodyTags,
  ALLOWED_ATTR:['alt','href','src','title','colspan','rowspan','start'],
  ALLOWED_URI_REGEXP:/^(?:https?:\/\/|mailto:|cid:)/i,
  ALLOW_DATA_ATTR:false,
  ALLOW_ARIA_ATTR:false,
  RETURN_DOM_FRAGMENT:true,
 })
 for(const link of fragment.querySelectorAll('a')){
  const href=absoluteLink(link.getAttribute('href')||'')
  if(!href){link.removeAttribute('href');continue}
  link.href=href
  link.target='_blank'
  link.rel='noopener noreferrer'
 }
 let externalImages=0,loadInlineImages=false
 const linkedPlaceholders=new Map<HTMLAnchorElement,HTMLElement[]>()
 for(const img of fragment.querySelectorAll('img')){
  const src=img.getAttribute('src')||''
  img.removeAttribute('src')
  const cid=/^cid:/i.test(src)?normalizeCid(src.slice(4),true):''
  const placeholder=document.createElement('span')
  placeholder.className='mailbox-image-placeholder'
  const href=absoluteLink(src,false)
  if(cid&&hasInlineImages){
   loadInlineImages=true
   placeholder.dataset.mailboxInlineCid=cid
   placeholder.dataset.mailboxInlineAlt=img.alt
   placeholder.textContent=img.alt
  }else if(href){
   externalImages++
   placeholder.dataset.mailboxExternalUrl=href
   placeholder.dataset.mailboxExternalAlt=img.alt
   const automatic=href.startsWith('https://')
   if(!automatic)placeholder.append(imageUnavailable(img.alt))
   if(automatic){
    const show=document.createElement('button')
    show.type='button'
    show.className='mailbox-external-image-button'
    show.textContent='重新加载'
    show.hidden=true
    show.setAttribute('aria-label',`重新加载 ${img.alt||`外部图片 ${externalImages}`}`)
    placeholder.append(show)
   }
   const open=newTabLink(href)
   open.textContent='在新标签页查看'
   open.className='mailbox-external-image-open'
   open.hidden=automatic
   const status=document.createElement('span')
   status.className='mailbox-external-image-status'
   status.setAttribute('role','status')
   placeholder.append(open,status)
   const parentLink=img.closest<HTMLAnchorElement>('a[href]')
   if(parentLink){
    // Place the controls alongside a linked image to avoid nesting them in its link.
    const siblings=linkedPlaceholders.get(parentLink)||[]
    siblings.push(placeholder)
    linkedPlaceholders.set(parentLink,siblings)
    placeholder.dataset.mailboxExternalLink=parentLink.href
    img.remove()
    continue
   }
  }else placeholder.textContent=imageUnavailable(img.alt)
  img.replaceWith(placeholder)
 }
 for(const [link,placeholders] of linkedPlaceholders){
  link.after(...placeholders)
  if(!link.textContent?.trim())link.remove()
 }
 for(const cell of fragment.querySelectorAll('td,th')){
  for(const name of ['colspan','rowspan']){
   const span=cell.getAttribute(name)
   if(span&&(!/^\d{1,2}$/.test(span)||Number(span)<1))cell.removeAttribute(name)
  }
 }
 for(const table of fragment.querySelectorAll('table')){
  const scroll=document.createElement('div')
  scroll.className='mailbox-rich-table'
  scroll.tabIndex=0
  scroll.setAttribute('role','region')
  scroll.setAttribute('aria-label','邮件表格')
  table.before(scroll)
  scroll.append(table)
 }
 if(!fragment.textContent?.trim()&&!loadInlineImages&&!externalImages)return null
 return {fragment,externalImages,loadInlineImages}
}

function fillInlineImages(container:HTMLElement,images:Map<string,string>,pending=false){
 for(const placeholder of container.querySelectorAll<HTMLElement>('[data-mailbox-inline-cid]')){
  const src=images.get(placeholder.dataset.mailboxInlineCid||'')
  const alt=placeholder.dataset.mailboxInlineAlt||''
  if(!src){if(!pending)placeholder.textContent=imageUnavailable(alt);continue}
  const image=document.createElement('img')
  image.className='mailbox-inline-image'
  image.alt=alt||'邮件内嵌图片'
  image.loading='lazy'
  image.decoding='async'
  image.addEventListener('error',()=>{
   placeholder.textContent=imageUnavailable(alt)
   image.replaceWith(placeholder)
  },{once:true})
  image.src=src
  placeholder.replaceWith(image)
 }
}

async function showExternalImage(button:HTMLButtonElement,signal:AbortSignal,loadBytes:(href:string)=>Promise<Uint8Array>,onDenied:()=>void){
 const placeholder=button.closest<HTMLElement>('[data-mailbox-external-url]')
 const href=placeholder?.dataset.mailboxExternalUrl
 const status=placeholder?.querySelector('.mailbox-external-image-status')
 const open=placeholder?.querySelector<HTMLAnchorElement>('.mailbox-external-image-open')
 if(!placeholder||!href||!status||button.getAttribute('aria-disabled')==='true'||signal.aborted)return
 const showError=()=>{
  button.removeAttribute('aria-disabled')
  button.hidden=false
  if(open)open.hidden=false
  status.textContent='图片加载失败，可重试或在新标签页查看。'
 }
 button.setAttribute('aria-disabled','true')
 button.hidden=true
 if(open)open.hidden=true
 status.textContent='正在加载图片…'
 try{
  const bytes=await loadBytes(href)
  if(signal.aborted)return
  const mime=rasterImageType(bytes)
  if(!mime){showError();return}
  const reader=new FileReader()
  const abort=()=>reader.abort()
  reader.addEventListener('loadend',()=>{
   signal.removeEventListener('abort',abort)
   if(signal.aborted)return
   if(typeof reader.result!=='string'){showError();return}
   const image=document.createElement('img')
   image.className='mailbox-inline-image'
   image.alt=placeholder.dataset.mailboxExternalAlt||'邮件外部图片'
   image.loading='lazy'
   image.decoding='async'
   const linkUrl=placeholder.dataset.mailboxExternalLink
   const displayed=linkUrl?newTabLink(linkUrl):image
   if(displayed!==image)displayed.append(image)
   image.addEventListener('error',()=>{
    const focused=document.activeElement===displayed
    displayed.replaceWith(placeholder)
    showError()
    if(focused)button.focus({preventScroll:true})
   },{once:true})
   image.src=reader.result
   const focused=document.activeElement===button
   placeholder.replaceWith(displayed)
   if(focused){if(displayed===image)displayed.tabIndex=-1;displayed.focus({preventScroll:true})}
  },{once:true})
  reader.readAsDataURL(new Blob([new Uint8Array(bytes)],{type:mime}))
  signal.addEventListener('abort',abort,{once:true})
 }catch(reason){
  if(signal.aborted)return
  if(accessLost(reason)){onDenied();return}
  showError()
 }
}

const accessLost=(reason:unknown)=>reason instanceof ApiError&&(reason.status===401||reason.status===403)

export default function MailboxRichBody({url,text,initialBody,onDenied}:{url:string;text:string;initialBody?:RichBody|null;onDenied():void}){
 const [cachedBody,setCachedBody]=useState<RichBody|null>(null)
 const [imageTruncated,setImageTruncated]=useState(false)
 const content=useRef<HTMLDivElement>(null)
 const denied=useRef(onDenied)
 denied.current=onDenied
 const body=typeof initialBody?.html==='string'?initialBody:cachedBody
 const hasBody=Boolean(body)
 const html=body?.html,hasInlineImages=body?.hasInlineImages===true
 const view=useMemo(()=>renderMessage(html,hasInlineImages),[html,hasInlineImages])
 useEffect(()=>{
  if(hasBody)return
  const controller=new AbortController()
  let pending=false
  const stop=()=>{clearInterval(interval);clearTimeout(limit);controller.abort()}
  const interval=setInterval(async()=>{
   if(pending||document.hidden||controller.signal.aborted)return
   pending=true
   try{
    const result=await api<LocalRichBody>(`${url}&view=body&local=1`,{signal:controller.signal})
    if(controller.signal.aborted||result?.pending===true||typeof result?.html!=='string')return
    setCachedBody(result)
    stop()
   }catch(reason){
    if(!controller.signal.aborted&&accessLost(reason)){stop();denied.current()}
   }finally{pending=false}
  },richCachePollMs)
  const limit=setTimeout(stop,richCachePollLimitMs)
  return stop
 },[url,hasBody])
 useLayoutEffect(()=>{
  const container=content.current
  setImageTruncated(false)
  if(!view||!container)return
  container.replaceChildren(view.fragment.cloneNode(true))
  if(!view.externalImages)return
  const controller=new AbortController()
  const queue:HTMLButtonElement[]=[],queued=new Set<HTMLButtonElement>()
  const requests=new Map<string,Promise<Uint8Array>>()
  let active=0
  const loadBytes=(href:string)=>{
   let request=requests.get(href)
   if(!request){
    request=apiAttachmentBytes(`${url}&view=external-image`,{
     signal:controller.signal,maxBytes:maxInlineImageBytes,accept:'image/png,image/jpeg,image/gif,image/webp',body:{url:href},
    })
    requests.set(href,request)
    void request.catch(()=>requests.delete(href))
   }
   return request
  }
  const pump=()=>{
   while(!controller.signal.aborted&&active<2&&queue.length){
    const button=queue.shift()!
    active++
    void showExternalImage(button,controller.signal,loadBytes,()=>denied.current()).finally(()=>{
     active--;queued.delete(button);pump()
    })
   }
  }
  const enqueue=(button:HTMLButtonElement,retry=false)=>{
   if(queued.has(button)||controller.signal.aborted)return
   if(retry){
    const href=button.closest<HTMLElement>('[data-mailbox-external-url]')?.dataset.mailboxExternalUrl
    if(href)requests.delete(href)
   }
   queued.add(button);queue.push(button);pump()
  }
  const click=(event:MouseEvent)=>{
   const button=event.target instanceof Element?event.target.closest<HTMLButtonElement>('button.mailbox-external-image-button'):null
   if(button)enqueue(button,true)
  }
  container.addEventListener('click',click)
  for(const button of container.querySelectorAll<HTMLButtonElement>('button.mailbox-external-image-button'))enqueue(button)
  return()=>{controller.abort();container.removeEventListener('click',click)}
 },[url,view])
 useEffect(()=>{
  const container=content.current
  if(!view?.loadInlineImages||!container)return
  const controller=new AbortController()
  let retry:ReturnType<typeof setTimeout>|undefined
  const stop=()=>{clearTimeout(retry);clearTimeout(limit);controller.abort()}
  const limit=setTimeout(()=>{fillInlineImages(container,new Map());stop()},richCachePollLimitMs)
  const read=async()=>{
   try{
    const result=await api<RichImages>(`${url}&view=images`,{signal:controller.signal})
    if(controller.signal.aborted)return
    fillInlineImages(container,inlineImages(result.images),result.pending===true)
    setImageTruncated(result.truncated===true&&result.pending!==true)
    if(result.pending!==true||!container.querySelector('[data-mailbox-inline-cid]')){stop();return}
    retry=setTimeout(read,inlineCachePollMs)
   }catch(reason){
    if(controller.signal.aborted)return
    stop()
    if(accessLost(reason)){denied.current();return}
    fillInlineImages(container,new Map())
   }
  }
  void read()
  return stop
 },[url,view])
 return <section className="mailbox-body" aria-label="邮件正文">
  {view? <>
   {body?.truncated===true&&<p className="mailbox-reader-note" role="status">富文本内容已截断</p>}
   <div className="mailbox-rich-body" ref={content}/>
   {imageTruncated&&<p className="mailbox-reader-note" role="status">部分内嵌图片暂不可用。</p>}
  </>:<div className="mailbox-text-body">{text||'（此邮件没有可显示的纯文本正文）'}</div>}
 </section>
}
