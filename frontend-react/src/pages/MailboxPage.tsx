import {lazy,Suspense,useEffect,useId,useRef,useState} from 'react'
import {Button,Empty,Input,Modal,Spin,Tag} from '@douyinfe/semi-ui'
import {IconChevronLeft,IconDownload,IconEyeOpened,IconFile,IconMail,IconRefresh,IconSearch,IconSend} from '@douyinfe/semi-icons'
import {api,apiAttachmentBytes,ApiError,errorMessage} from '../lib/api'
import {documentFormat} from '../lib/attachment-document'
import type {Session,User} from '../lib/types'
import MailboxRichBody,{maxImagePreviewBytes,rasterImageType,type RichBody} from './MailboxRichBody'
import './mailbox.css'

const AttachmentDocumentPreview=lazy(()=>import('../components/AttachmentDocumentPreview'))

interface Props {user:User;sessions?:Session[];currentSessionId?:string;onManageConnections?():void}
type FolderKind='inbox'|'sent'
interface ArchiveCounts {total:number;ready:number;pending:number;error:number;partial?:number;preparing?:number}
type ArchiveStatus='pending'|'archiving'|'ready'|'error'
interface Archive {status:ArchiveStatus|'partial';lastArchivedAt?:string|null;error?:string|null;truncated?:boolean;remoteDeleted?:boolean}
interface Sync {status:string;lastSyncAt?:string|null;error?:string|null;historyComplete?:boolean;truncated?:boolean;archive?:ArchiveCounts}
interface Account {id:string;name:string;email:string;enabled?:boolean;sync?:Sync}
interface Folder {kind:FolderKind;path:string;label:string;uidValidity?:string|number;lastSyncAt?:string|null;status?:string;error?:string|null}
interface Address {name?:string;address:string}
interface Summary {uid:number;subject:string;from:Address[];to:Address[];cc?:Address[];date?:string;seen:boolean;hasAttachments:boolean;size?:number;messageId?:string;archive?:Archive}
interface MailAttachment {part:string;name:string;mimeType:string;size:number|null;inline?:boolean;id?:string;downloadUrl?:string}
interface MailMessage extends Summary {text:string;bodyType?:string;richBody?:RichBody|null;attachments:MailAttachment[];truncated?:boolean}
interface MailList {messages:Summary[];total:number;hasMore:boolean;nextOffset?:number|null;folder:FolderKind;uidValidity:string|number;sync?:Sync}
const isBusy=(status?:string)=>['queued','syncing','running','loading','pending'].includes(status||'')
const inaccessible=(reason:unknown)=>reason instanceof ApiError&&[401,403,404].includes(reason.status)
const addresses=(items?:Address[])=>items?.map(item=>item.name?`${item.name} <${item.address}>`:item.address).join('；')||'未提供'
const bodyArchiveLabels={pending:'正文待归档',archiving:'正文归档中',partial:'正文部分归档',error:'正文归档失败'}
function time(value?:string|null){if(!value)return '尚未同步';const date=new Date(value);return Number.isNaN(date.getTime())?'时间未知':date.toLocaleString('zh-CN',{hour12:false})}
function bytes(value:number){return value>=1048576?`${(value/1048576).toFixed(1)} MB`:value>=1024?`${Math.ceil(value/1024)} KB`:`${value} B`}
function Loading({children}:{children:string}){const [slow,setSlow]=useState(false);useEffect(()=>{const timer=setTimeout(()=>setSlow(true),8000);return()=>clearTimeout(timer)},[]);return <div className="mailbox-loading" role="status"><Spin size="small"/><span>{slow?'读取时间较长，请稍候；也可切换邮箱或稍后重试。':children}</span></div>}

/** An identity change unmounts every request and clears all previous mail. */
export default function MailboxPage(props:Props){return <MailboxIdentity key={`${props.user?.id}:${props.user?.role}:${!!props.user?.disabled}`} {...props}/>}
function MailboxIdentity({user,onManageConnections}:Props){
 const [expired,setExpired]=useState(false)
 useEffect(()=>{const clear=()=>setExpired(true);window.addEventListener('pi:auth-expired',clear);return()=>window.removeEventListener('pi:auth-expired',clear)},[])
 return <section className="mailbox-page" aria-label="邮件">
  {expired||!user||user.disabled?<Empty title="登录已失效" description="重新登录后可查看公共邮件。"/>:<PublicMailbox onManageConnections={user.role==='admin'?onManageConnections:undefined}/>}
 </section>
}
function PublicMailbox({onManageConnections}:{onManageConnections?():void}){
 const base='/api/mailbox',[accounts,setAccounts]=useState<Account[]>([]),[chosen,setChosen]=useState(''),[folder,setFolder]=useState<FolderKind>('inbox'),[loading,setLoading]=useState(true),[error,setError]=useState(''),[retry,setRetry]=useState(0)
 const controller=useRef(new AbortController()),version=useRef(0)
 const account=accounts.find(item=>item.id===chosen)||accounts[0]
 function denied(){controller.current.abort();version.current++;setAccounts([]);setLoading(false);setError('邮箱已停用、移除或访问权限已失效，请重试。')}
 useEffect(()=>{
  const scope=new AbortController();controller.current=scope;let pending=false
  async function load(){if(pending||scope.signal.aborted)return;pending=true;const token=++version.current;try{const result=await api<{accounts:Account[]}>(`${base}/accounts`,{signal:scope.signal});if(scope.signal.aborted||token!==version.current)return;setAccounts(Array.isArray(result.accounts)?result.accounts.filter(item=>item.enabled!==false):[]);setError('')}catch(reason){if(scope.signal.aborted||token!==version.current)return;setAccounts([]);setError(errorMessage(reason))}finally{pending=false;if(!scope.signal.aborted&&token===version.current)setLoading(false)}}
  setLoading(true);void load();const timer=setInterval(()=>{if(!document.hidden)void load()},15000)
  return()=>{scope.abort();version.current++;clearInterval(timer)}
 },[base,retry])
 if(loading&&!accounts.length)return <Loading>正在读取公共邮箱…</Loading>
 if(!accounts.length)return <div className="mailbox-empty">{error?<><p role="alert">{error}</p><Button icon={<IconRefresh aria-hidden/>} onClick={()=>setRetry(value=>value+1)}>重试读取邮箱</Button></>:<Empty title="暂无已启用的公共邮箱" description="请联系管理员连接并启用邮箱，启用后全体员工均可查看已同步邮件。"/>}{onManageConnections&&<Button onClick={onManageConnections}>管理邮箱连接</Button>}</div>
 return <div className="mailbox-shell"><aside className="mailbox-accounts" aria-label="公共邮箱"><div className="mailbox-account-picker"><h2>公共邮箱</h2>{accounts.map(item=><button type="button" key={item.id} className={`mailbox-account ${item.id===account.id?'is-active':''}`} aria-pressed={item.id===account.id} onClick={()=>{setChosen(item.id);setFolder('inbox')}}><IconMail aria-hidden/><span><strong>{item.name||item.email}</strong><small>{item.email}</small></span></button>)}<nav className="mailbox-folders" aria-label="邮件文件夹">{(['inbox','sent'] as FolderKind[]).map(kind=><Button key={kind} theme={folder===kind?'light':'borderless'} icon={kind==='inbox'?<IconMail aria-hidden/>:<IconSend aria-hidden/>} aria-pressed={folder===kind} onClick={()=>setFolder(kind)}>{kind==='inbox'?'收件箱':'已发送'}</Button>)}</nav></div>{onManageConnections&&<div className="mailbox-account-actions"><Button theme="borderless" onClick={onManageConnections}>管理邮箱连接</Button></div>}</aside><MailboxAccount key={account.id} base={`${base}/${encodeURIComponent(account.id)}`} account={account} folder={folder} onDenied={denied}/></div>
}
function MailboxAccount({base,account,folder,onDenied}:{base:string;account:Account;folder:FolderKind;onDenied():void}){
 const id=useId(),[query,setQuery]=useState(''),[folders,setFolders]=useState<Folder[]|null>(null),[error,setError]=useState(''),[reload,setReload]=useState(0)
 const denied=useRef(onDenied);denied.current=onDenied
 useEffect(()=>{
  const scope=new AbortController();let pending=false
  async function load(){if(pending)return;pending=true;try{const result=await api<{folders:Folder[]}>(`${base}/folders`,{signal:scope.signal});if(!scope.signal.aborted){setFolders(result.folders||[]);setError('')}}catch(reason){if(scope.signal.aborted)return;if(inaccessible(reason)){denied.current();return}setError(errorMessage(reason))}finally{pending=false}}
  void load();const timer=setInterval(()=>{if(!document.hidden)void load()},15000);return()=>{scope.abort();clearInterval(timer)}
 },[base,reload])
 const available=folders?.find(item=>item.kind===folder)
 return <div className="mailbox-account-workspace"><header className="mailbox-account-title"><div><strong>{account.name||account.email}</strong><span>{account.email}</span></div><Tag color="blue">全体员工共享</Tag></header>
  <div className="mailbox-search"><label htmlFor={`${id}-search`}>搜索邮件</label><Input id={`${id}-search`} value={query} onChange={setQuery} composition maxLength={200} prefix={<IconSearch aria-hidden/>} placeholder="输入关键词"/></div>
  {error&&<div className="mailbox-inline-error" role="alert">文件夹读取失败：{error}<Button size="small" onClick={()=>setReload(value=>value+1)}>重试</Button></div>}
  {!folders?(error?null:<Loading>正在读取文件夹…</Loading>):!available||available.status==='not_found'?<div className="mailbox-empty"><Empty title={folder==='sent'?'未发现已发送文件夹':'未发现收件箱'} description="服务端尚未识别此文件夹。请稍后刷新，或联系管理员检查邮箱连接。"/><Button onClick={()=>setReload(value=>value+1)}>重新读取文件夹</Button></div>:<MailFolder key={`${folder}:${query}`} base={base} folder={folder} query={query.trim()} accountSync={account.sync} folderStatus={available} onDenied={()=>denied.current()}/>}
 </div>
}
function MailFolder({base,folder,query,accountSync,folderStatus,onDenied}:{base:string;folder:FolderKind;query:string;accountSync?:Sync;folderStatus:Folder;onDenied():void}){
 const [data,setData]=useState<MailList|null>(null),[offset,setOffset]=useState(0),[loading,setLoading]=useState(true),[error,setError]=useState(''),[selected,setSelected]=useState<{uid:number;validity:string|number}|null>(null),[reload,setReload]=useState(0),[action,setAction]=useState<'sync'|'older'|null>(null),[notice,setNotice]=useState('')
 const scope=useRef(new AbortController()),requestVersion=useRef(0),dataRef=useRef<MailList|null>(null),actionBusy=useRef(false),syncRequest=useRef<{started:number;lastSyncAt?:string|null;sawBusy:boolean}|null>(null),denied=useRef(onDenied)
 denied.current=onDenied
 const sync=data?.sync||accountSync,busy=!!action||isBusy(sync?.status)
 const archive=sync?.archive,preparing=archive?.preparing??0
 useEffect(()=>{
  const controller=new AbortController();scope.current=controller;let pending=false
  async function load(){if(pending||controller.signal.aborted)return;pending=true;const token=++requestVersion.current
   try{const params=new URLSearchParams({folder,q:query,limit:'50',offset:String(offset)}),result=await api<MailList>(`${base}/messages?${params}`,{signal:controller.signal});if(controller.signal.aborted||token!==requestVersion.current)return
    if(dataRef.current&&String(result.uidValidity)!==String(dataRef.current.uidValidity))setSelected(null)
    else setSelected(previous=>previous&&result.messages.some(item=>item.uid===previous.uid)?previous:null)
    dataRef.current=result;setData(result);setError('')
    const job=syncRequest.current
    if(job){if(isBusy(result.sync?.status))job.sawBusy=true
     if(result.sync?.status==='error'||result.sync?.error){syncRequest.current=null;setAction(null);setNotice('同步未完成，请查看错误后重试。')}
     else if(!isBusy(result.sync?.status)&&(job.sawBusy||!!result.sync?.lastSyncAt&&result.sync.lastSyncAt!==job.lastSyncAt)){syncRequest.current=null;setAction(null);setNotice('同步已完成，列表已更新。')}
     else if(Date.now()-job.started>120000){syncRequest.current=null;setAction(null);setNotice('同步仍在排队或执行，请稍后刷新查看。')}
    }
   }catch(reason){if(controller.signal.aborted||token!==requestVersion.current)return;if(inaccessible(reason)){denied.current();return}if(reason instanceof ApiError&&reason.status===404){setData(null);setSelected(null)}setError(errorMessage(reason))}finally{pending=false;if(!controller.signal.aborted&&token===requestVersion.current)setLoading(false)}
  }
  setLoading(true);const initial=setTimeout(()=>void load(),query?250:0)
  const timer=setInterval(()=>{if(!document.hidden&&syncRequest.current)void load()},2000)
  // A separate 15-second timer keeps normal refresh independent of sync polling.
  const refresh=setInterval(()=>{if(!document.hidden&&!syncRequest.current)void load()},15000)
  return()=>{controller.abort();requestVersion.current++;clearTimeout(initial);clearInterval(timer);clearInterval(refresh)}
 },[base,folder,query,offset,reload])
 async function synchronize(older=false){
  if(actionBusy.current||scope.current.signal.aborted)return;actionBusy.current=true;setAction(older?'older':'sync');setError('');setNotice('')
  const controller=scope.current,lastSyncAt=dataRef.current?.sync?.lastSyncAt||accountSync?.lastSyncAt||folderStatus.lastSyncAt
  try{await api(`${base}/${older?'load-more':'sync'}`,{method:'POST',body:older?{folder}:{},signal:controller.signal});if(controller.signal.aborted)return;syncRequest.current={started:Date.now(),lastSyncAt,sawBusy:false};setNotice(older?'已提交同步更早邮件，请等待服务端处理。':'已提交同步，正在等待服务端更新。')}
  catch(reason){if(controller.signal.aborted)return;if(inaccessible(reason)){denied.current();return}setError(errorMessage(reason));setAction(null)}finally{actionBusy.current=false}
 }
 function page(next:number){setSelected(null);setData(null);dataRef.current=null;setOffset(next)}
 const currentSelected=selected&&data&&String(selected.validity)===String(data.uidValidity)?selected:null
 return <div className={`mailbox-content ${currentSelected?'has-detail':''}`}>
  <section className="mailbox-list-pane" aria-label={folder==='inbox'?'收件邮件列表':'已发送邮件列表'}><header className="mailbox-list-heading"><div><h2>{folder==='inbox'?'收件箱':'已发送'}</h2><span>{data?`已同步邮件${query?'匹配':''} ${data.total} 封`:'已同步邮件'}</span></div><Button icon={<IconRefresh aria-hidden/>} loading={action==='sync'} disabled={busy||loading} onClick={()=>void synchronize()}>刷新邮件</Button></header>
   <div className="mailbox-sync-info" role="status">{busy?<span>同步排队或进行中…</span>:<span>最近同步：{time(sync?.lastSyncAt||folderStatus.lastSyncAt)}</span>}{!!archive?.partial&&<span>部分归档 {archive.partial} 封</span>}{!!archive?.pending&&<span>待归档 {archive.pending} 封</span>}{!!archive?.error&&<span>归档失败 {archive.error} 封</span>}{preparing>0&&<span>正在准备正文 {preparing} 封</span>}{notice&&<span>{notice}</span>}</div>
   {(sync?.error||sync?.status==='error'||folderStatus.error)&&<p className="mailbox-inline-error" role="alert">同步失败：{sync?.error||folderStatus.error||'请稍后重试，或联系管理员检查连接。'}</p>}
   {error&&<div className="mailbox-inline-error" role="alert">{error}<Button size="small" onClick={()=>setReload(value=>value+1)}>重试读取邮件</Button></div>}
   {loading&&!data?<Loading>正在读取已同步邮件…</Loading>:data?.messages.length?<ul className="mailbox-message-list">{data.messages.map(message=><li key={message.uid}><button type="button" className={`mailbox-message-row ${!message.seen?'is-unread':''} ${currentSelected?.uid===message.uid?'is-selected':''}`} aria-pressed={currentSelected?.uid===message.uid} onClick={()=>setSelected({uid:message.uid,validity:data.uidValidity})}><span className="mailbox-row-top"><strong>{addresses(folder==='sent'?message.to:message.from)}</strong><time dateTime={message.date}>{message.date?time(message.date):'时间未知'}</time></span><span className="mailbox-row-subject"><span>{!message.seen&&<span className="mailbox-unread">未读</span>}{message.subject||'（无主题）'}</span>{message.hasAttachments&&<span className="mailbox-attachment-indicator" aria-label="有附件"><IconFile aria-hidden/></span>}</span></button></li>)}</ul>:!error?<div className="mailbox-empty">{preparing>0?<Empty title="正在准备邮件正文" description={query?'正文归档后，符合搜索条件的邮件会自动显示。':'正文归档后，邮件会自动显示。'}/>:<Empty title={query?'没有匹配的已同步邮件':'暂无已同步邮件'} description={query?'可更换主题、邮箱地址或正文关键词。':'可点击刷新邮件发起同步，首次同步可能需要一些时间。'}/>}</div>:null}
   {data&&<footer className="mailbox-list-footer"><span>{data.messages.length?`当前 ${offset+1}–${offset+data.messages.length} 封`:preparing>0?'邮件准备中':'当前无邮件'}</span><div><Button disabled={offset===0||loading||busy} onClick={()=>page(Math.max(0,offset-50))}>上一页</Button><Button disabled={!data.hasMore||loading||busy} onClick={()=>page(data.nextOffset??offset+50)}>下一页</Button></div>{sync?.truncated?<span>已达到本地同步上限，仅展示已缓存邮件。</span>:sync?.historyComplete!==true&&<Button className="mailbox-load-older" loading={action==='older'} disabled={busy} onClick={()=>void synchronize(true)}>同步更早邮件</Button>}</footer>}
  </section>
  <section className="mailbox-reader" aria-label="邮件阅读区">{currentSelected?<MailDetail key={`${currentSelected.validity}:${currentSelected.uid}`} base={base} folder={folder} uid={currentSelected.uid} validity={currentSelected.validity} onBack={()=>setSelected(null)} onDenied={()=>denied.current()}/>:<div className="mailbox-reader-placeholder"><IconMail aria-hidden/><h2>选择一封邮件</h2><p>在左侧选择已同步邮件，查看正文与附件。</p></div>}</section>
 </div>
}
function MailDetail({base,folder,uid,validity,onBack,onDenied}:{base:string;folder:FolderKind;uid:number;validity:string|number;onBack():void;onDenied():void}){
 const [message,setMessage]=useState<MailMessage|null>(null)
 const [error,setError]=useState('')
 const [downloading,setDownloading]=useState<string|null>(null)
 const [downloadError,setDownloadError]=useState('')
 const [preview,setPreview]=useState<{name:string;url:string;image:boolean}|null>(null)
 const [retry,setRetry]=useState(0)
 const [archiveRetry,setArchiveRetry]=useState(false)
 const [archiveNotice,setArchiveNotice]=useState('')
 const controller=useRef(new AbortController()),downloadBusy=useRef(false)
 const messageRef=useRef<MailMessage|null>(null),denied=useRef(onDenied)
 denied.current=onDenied

 useEffect(()=>{
  const scope=new AbortController()
  controller.current=scope
  let pending=false
  setMessage(null);messageRef.current=null;setError('')
  async function load(){
   if(pending||scope.signal.aborted)return
   pending=true
   try{
    const result=await api<{message:MailMessage}>(`${base}/message?${new URLSearchParams({folder,uid:String(uid),uidValidity:String(validity)})}`,{signal:scope.signal})
    if(!scope.signal.aborted){
     messageRef.current=result.message
     setMessage(result.message);setError('')
    }
   }catch(reason){
    if(scope.signal.aborted)return
    if(inaccessible(reason)){denied.current();return}
    setError(errorMessage(reason))
   }finally{pending=false}
  }
  void load()
  const timer=setInterval(()=>{
   const archive=messageRef.current?.archive
   if(!document.hidden&&archive&&archive.status!=='ready'&&archive.status!=='partial')void load()
  },15000)
  return()=>{scope.abort();clearInterval(timer)}
 },[base,folder,uid,validity,retry])

 async function retryArchive(){
  const scope=controller.current
  if(archiveRetry||scope.signal.aborted)return
  setArchiveRetry(true);setArchiveNotice('')
  try{
   await api(`${base}/sync`,{method:'POST',body:{},signal:scope.signal})
   if(!scope.signal.aborted){
    setArchiveNotice('已提交重试归档，请等待服务端处理。')
    setRetry(value=>value+1)
   }
  }catch(reason){
   if(scope.signal.aborted)return
   if(inaccessible(reason)){denied.current();return}
   setArchiveNotice(errorMessage(reason))
  }finally{if(!scope.signal.aborted)setArchiveRetry(false)}
 }

 function fileUrl(item:MailAttachment){
  if(!/^[1-9]\d{0,9}$/.test(String(uid))||!/^[1-9]\d{0,9}$/.test(String(validity))
    ||item.part.length>100||!/^\d+(?:\.\d+){0,19}$/.test(item.part))throw new Error('附件编号无效，请刷新邮件。')
  return `${base}/attachments/mail-${folder}-${uid}-${validity}-${item.part.replaceAll('.','_')}`
 }

 function downloadUrl(item:MailAttachment){
  if(!item.id||!item.downloadUrl)return fileUrl(item)
  const legacy=new URL(item.downloadUrl,location.origin)
  const expected=`${base}/attachments/${encodeURIComponent(item.id)}`
  if(legacy.origin!==location.origin||legacy.pathname!==expected||legacy.search!=='?download=1'
    ||legacy.hash||legacy.username||legacy.password)throw new Error('附件下载地址无效，请重试。')
  return legacy.pathname+legacy.search
 }

 function openPreview(item:MailAttachment){
  setDownloadError('')
  try{
   const image=isPreviewImage(item)
   setPreview({name:item.name,url:image?downloadUrl(item):fileUrl(item),image})
  }catch(reason){setDownloadError(errorMessage(reason))}
 }

 async function download(item:MailAttachment){
  const scope=controller.current
  if(downloadBusy.current||scope.signal.aborted)return
  downloadBusy.current=true;setDownloading(item.part);setDownloadError('')
  try{
   const contents=await apiAttachmentBytes(downloadUrl(item),{signal:scope.signal,accept:'*/*'})
   if(scope.signal.aborted)return
   const objectUrl=URL.createObjectURL(new Blob([new Uint8Array(contents)],{type:'application/octet-stream'}))
   const link=document.createElement('a')
   link.href=objectUrl;link.download=item.name||'附件'
   document.body.appendChild(link)
   try{link.click()}
   finally{link.remove();setTimeout(()=>URL.revokeObjectURL(objectUrl),1000)}
  }catch(reason){
   if(scope.signal.aborted)return
   if(reason instanceof ApiError&&[401,403].includes(reason.status)){denied.current();return}
   setDownloadError(errorMessage(reason))
  }finally{
   downloadBusy.current=false
   if(!scope.signal.aborted)setDownloading(null)
  }
 }

 const richUrl=`${base}/message-rich?${new URLSearchParams({folder,uid:String(uid),uidValidity:String(validity)})}`
 return <>
  <div className="mailbox-reader-toolbar">
   <Button theme="borderless" icon={<IconChevronLeft aria-hidden/>} onClick={onBack}>返回邮件列表</Button>
   <span>邮件阅读</span>
  </div>
  {error?<div className="mailbox-empty"><p role="alert">{error}</p><Button onClick={()=>setRetry(value=>value+1)}>重试读取正文</Button></div>
   :!message?<Loading>正在读取邮件正文…</Loading>
   :<article className="mailbox-message-detail">
    <h2>{message.subject||'（无主题）'}</h2>
    <dl>
     <div><dt>发件人</dt><dd>{addresses(message.from)}</dd></div>
     <div><dt>收件人</dt><dd>{addresses(message.to)}</dd></div>
     {!!message.cc?.length&&<div><dt>抄送</dt><dd>{addresses(message.cc)}</dd></div>}
     <div><dt>时间</dt><dd>{message.date?time(message.date):'时间未知'}</dd></div>
    </dl>
    {(message.truncated||message.archive?.truncated)&&<p className="mailbox-inline-error" role="status">正文或附件清单超出读取上限，已保存可读取的部分。</p>}
    <section className="mailbox-archive-state" aria-label="邮件归档状态">
     {message.archive&&<>
      {message.archive.status!=='ready'&&<strong>{bodyArchiveLabels[message.archive.status]}</strong>}
      {message.archive.error&&<p role="alert">{message.archive.error}</p>}
      {message.archive.remoteDeleted&&<p>远端邮件已删除，仍可查看已保留的本地归档。</p>}
      {message.archive.status==='error'&&<Button size="small" loading={archiveRetry} disabled={archiveRetry} onClick={()=>void retryArchive()}>重试归档</Button>}
     </>}
     {archiveNotice&&<p role="status">{archiveNotice}</p>}
    </section>
    <MailboxRichBody key={richUrl} url={richUrl} text={message.text} initialBody={message.richBody} onDenied={()=>denied.current()}/>
    {!!message.attachments?.length&&<section className="mailbox-attachments" aria-label="邮件附件">
     <h3>附件 · {message.attachments.length}</h3>
     <ul>{message.attachments.map(item=><li key={item.part}>
      <IconFile aria-hidden/>
      <span><strong>{item.name||'未命名附件'}</strong><small>{item.size===null?'大小未知':bytes(item.size)}{item.inline?' · 内嵌附件':''}</small></span>
      {(isPreviewImage(item)||documentFormat(item.name)!=='unsupported')&&<Button icon={<IconEyeOpened aria-hidden/>} aria-label={`预览附件 ${item.name}`} onClick={()=>openPreview(item)}>预览</Button>}
      <Button icon={<IconDownload aria-hidden/>} aria-label={`下载附件 ${item.name||'未命名附件'}`} loading={downloading===item.part} disabled={!!downloading} onClick={()=>void download(item)}>下载</Button>
     </li>)}</ul>
     {downloadError&&<p role="alert">{downloadError}</p>}
     <p>附件在点击预览或下载后读取。</p>
    </section>}
   </article>}
  {preview?.image&&<MailboxImagePreview key={preview.url} url={preview.url} name={preview.name} onClose={()=>setPreview(null)} onDenied={()=>denied.current()}/>}
  {preview&&!preview.image&&<Suspense fallback={<Modal visible title="正在打开附件预览" footer={null} onCancel={()=>setPreview(null)}><Loading>正在加载预览组件…</Loading></Modal>}>
   <AttachmentDocumentPreview
    mailboxAttachmentUrl={preview.url}
    attachment={{name:preview.name,href:preview.url,downloadHref:preview.url,extension:'',typeLabel:'文件',image:false}}
    onClose={()=>setPreview(null)}
   />
  </Suspense>}
 </>
}

function isPreviewImage(item:MailAttachment){
 return /\.(?:png|jpe?g|gif|webp)$/i.test(item.name)||/^image\/(?:png|jpeg|gif|webp)$/i.test(item.mimeType)
}

function MailboxImagePreview({url,name,onClose,onDenied}:{url:string;name:string;onClose():void;onDenied():void}){
 const [src,setSrc]=useState(''),[error,setError]=useState('')
 const denied=useRef(onDenied)
 denied.current=onDenied
 useEffect(()=>{
  const controller=new AbortController()
  const reader=new FileReader()
  reader.onload=()=>{if(!controller.signal.aborted&&typeof reader.result==='string')setSrc(reader.result)}
  reader.onerror=()=>{if(!controller.signal.aborted)setError('图片读取失败，请下载原文件查看。')}
  void apiAttachmentBytes(url,{signal:controller.signal,maxBytes:maxImagePreviewBytes,accept:'image/png,image/jpeg,image/gif,image/webp'}).then(contents=>{
   if(controller.signal.aborted)return
   const mime=rasterImageType(contents)
   if(!mime)throw new Error('此附件无法预览为图片，请下载原文件查看。')
   reader.readAsDataURL(new Blob([new Uint8Array(contents)],{type:mime}))
  }).catch(reason=>{
   if(controller.signal.aborted)return
   if(reason instanceof ApiError&&(reason.status===401||reason.status===403)){denied.current();return}
   setError(errorMessage(reason))
  })
  return()=>{controller.abort();if(reader.readyState===FileReader.LOADING)reader.abort()}
 },[url])
 return <Modal visible title={`图片预览 · ${name}`} onCancel={onClose} width="min(900px, 96vw)" footer={<Button onClick={onClose}>关闭</Button>}>
  {error?<p role="alert">{error}</p>:src?<img className="mailbox-image-preview" src={src} alt={name} onError={()=>setError('图片无法显示，请下载原文件查看。')}/>:<Loading>正在读取图片…</Loading>}
 </Modal>
}
