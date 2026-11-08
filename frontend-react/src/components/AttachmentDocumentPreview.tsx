import {lazy,Suspense,useEffect,useId,useMemo,useRef,useState} from 'react'
import {Banner,Button,Modal,Select,Spin,Table,Tag} from '@douyinfe/semi-ui'
import {IconChevronLeft,IconChevronRight,IconDownload,IconRefresh} from '@douyinfe/semi-icons'
import {api,errorMessage} from '../lib/api'
import {attachmentDocument,documentBase,documentFormat} from '../lib/attachment-document'
import type {AttachmentDocument} from '../lib/attachment-document'
import type {MessageAttachment} from '../lib/message-links'
import './attachment-document.css'

const PdfAttachmentView=lazy(()=>import('./PdfAttachmentView'))
const supported='支持 PDF、Word（.docx）、Excel（.xlsx）、CSV 和文本。DOC、XLS、压缩包等文件请下载后查看。'
const labels={ready:'已解析',unsupported:'仅下载',error:'文字解析失败',needs_ocr:'需要文字识别'} as const
export default function AttachmentDocumentPreview({attachment,mailboxAttachmentUrl,onClose}:{attachment:MessageAttachment;mailboxAttachmentUrl?:string;onClose():void}){
 const base=mailboxAttachmentUrl===undefined?documentBase(attachment):/^\/api\/mailbox\/[A-Za-z0-9_-]+\/attachments\/mail-(?:inbox|sent)-\d{1,10}-\d{1,10}-\d+(?:_\d+){0,19}$/.test(mailboxAttachmentUrl)?mailboxAttachmentUrl:undefined
 const format=documentFormat(attachment.name),[result,setResult]=useState<AttachmentDocument|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState(''),[retry,setRetry]=useState(0),[textOpen,setTextOpen]=useState(false)
 // Render mailbox PDFs from a single on-demand request rather than fetching the same bytes for text extraction.
 const parseContent=format!=='unsupported'&&!(mailboxAttachmentUrl&&format==='pdf')
 useEffect(()=>{
  setResult(null);setError('');setTextOpen(false)
  if(!base){setError('附件地址无效，请重新打开消息。');setLoading(false);return}
  if(!parseContent){setLoading(false);return}
  const controller=new AbortController();let current=true;setLoading(true)
  void api<{document:unknown}>(`${base}/content`,{signal:controller.signal}).then(value=>{if(current&&!controller.signal.aborted)setResult(attachmentDocument(value.document))}).catch(reason=>{if(current&&!controller.signal.aborted)setError(errorMessage(reason))}).finally(()=>{if(current)setLoading(false)})
  return()=>{current=false;controller.abort()}
 },[base,parseContent,retry])
 const download=()=>{const link=document.createElement('a');link.href=attachment.downloadHref;link.download=attachment.name;link.click()}
 const state=result?.status
 return <Modal visible title={`文件预览 · ${attachment.name}`} onCancel={onClose} closeOnEsc centered width="min(1000px, 96vw)" className="attachment-document-modal" bodyStyle={{padding:0,overflow:'hidden'}} footer={<div className="attachment-document-footer"><span>原文件可随时下载</span><Button icon={<IconDownload aria-hidden/>} onClick={download}>下载原文件</Button><Button onClick={onClose}>关闭</Button></div>}><div className="attachment-document-body"><div className="attachment-document-status"><Tag>{format==='text'?'文本':format==='unsupported'?attachment.typeLabel:format.toUpperCase()}</Tag>{loading?<span role="status" className="attachment-inline-loading"><Spin size="small"/>正在解析文档内容…</span>:state&&<Tag color={state==='ready'?'green':state==='error'?'red':'orange'}>{labels[state]}</Tag>}{result?.pageCount!==undefined&&<span>共 {result.pageCount} 页</span>}</div>{!base?<p role="alert">{error}</p>:format==='unsupported'?<div className="attachment-document-empty"><h3>此格式暂不支持在线预览</h3><p>{supported}</p></div>:<>
  {error&&<div className="attachment-document-error" role="alert"><p>{error}</p><Button icon={<IconRefresh aria-hidden/>} onClick={()=>setRetry(value=>value+1)}>重新读取文档</Button></div>}
  {result?.warnings.length? <div className="attachment-document-warnings"><Banner type="warning" closeIcon={null} description={<ul>{result.warnings.map((warning,index)=><li key={index}>{warning}</li>)}</ul>}/></div>:null}
  {result?.truncated&&<Banner type="warning" closeIcon={null} description="预览内容已截断，仅显示部分内容；完整数据请下载原文件。"/>}
  {format==='pdf'?<><Suspense fallback={<div className="attachment-preview-loading" role="status"><Spin size="small"/><span>正在加载 PDF 预览组件…</span></div>}><PdfAttachmentView key={base} url={base} name={attachment.name}/></Suspense>{result?.status==='needs_ocr'&&<p className="attachment-extraction-note" role="status">此 PDF 未提取到可用文字，可能是扫描件；你仍可查看上方原始页面。</p>}{result?.status==='error'&&<p className="attachment-extraction-note" role="status">文字解析失败，原始页面预览和下载仍可使用。</p>}{!!result&&(result.text.trim()||result.sections.length>0)&&<><Button className="attachment-text-toggle" theme="borderless" aria-expanded={textOpen} onClick={()=>setTextOpen(value=>!value)}>{textOpen?'收起解析文字':'查看解析文字'}</Button>{textOpen&&<DocumentText document={result}/>}</>}</>:loading?<div className="attachment-preview-loading attachment-document-initial" role="status"><Spin/><span>正在读取文件，请稍候…</span></div>:result?.status==='ready'?result.format==='xlsx'||result.format==='csv'?<DocumentSheets document={result}/>:<DocumentText document={result}/>:result&&<div className="attachment-document-empty"><h3>{result.status==='needs_ocr'?'未提取到可用文字':result.status==='unsupported'?'此格式暂不支持在线预览':'暂时无法解析文档'}</h3><p>{result.status==='needs_ocr'?'文件可能需要文字识别，可下载原文件查看。':result.status==='unsupported'?supported:'请下载原文件查看，或重新上传后重试。'}</p></div>}
 </>}</div></Modal>
}
function DocumentText({document}:{document:AttachmentDocument}){
 const sections=document.sections.filter(section=>section.text.trim())
 return <section className="attachment-document-text" aria-label="文档解析文字">{sections.length?sections.map((section,index)=><section key={index}><h3>{section.title|| (section.page?`第 ${section.page} 页`:`段落 ${index+1}`)}</h3><div>{section.text}</div></section>):document.text.trim()?<div>{document.text}</div>:<p role="status">未提取到可显示的文字内容。</p>}</section>
}
function columnName(index:number){let text='',value=index+1;while(value>0){value--;text=String.fromCharCode(65+value%26)+text;value=Math.floor(value/26)}return text}
function DocumentSheets({document}:{document:AttachmentDocument}){
 const labelId=useId(),selectId=useId(),toolbar=useRef<HTMLDivElement>(null)
 const [selected,setSelected]=useState(0),[page,setPage]=useState(0),sheets=document.sheets||[],sheet=sheets[selected],rows=sheet?.rows||[],pageSize=25,maxPage=Math.max(0,Math.ceil(rows.length/pageSize)-1)
 const width=rows.reduce((max,row)=>Math.max(max,row.length),0)
 const data=useMemo(()=>rows.slice(page*pageSize,(page+1)*pageSize).map((cells,index)=>({key:`${selected}-${page*pageSize+index}`,row:page*pageSize+index+1,cells})),[rows,page,selected])
 const columns=useMemo(()=>[{title:'#',dataIndex:'row',width:56},...Array.from({length:width},(_,index)=>({title:columnName(index),width:150,render:(_value:unknown,record:{cells:Array<string|number|boolean|null>})=><span>{record.cells[index]===null||record.cells[index]===undefined?'':String(record.cells[index])}</span>}))],[width])
 return <section className="attachment-document-sheets" aria-label="文档工作表"><div ref={toolbar} className="attachment-sheet-toolbar"><label id={labelId} htmlFor={selectId}>工作表</label><Select id={selectId} aria-labelledby={labelId} getPopupContainer={()=>toolbar.current||window.document.body} value={String(selected)} optionList={sheets.map((sheet,index)=>({value:String(index),label:sheet.name||`工作表 ${index+1}`}))} onChange={value=>{const index=Number(value);if(Number.isInteger(index)&&index>=0&&index<sheets.length){setSelected(index);setPage(0)}}}/><span>{rows.length} 行 · {width} 列</span></div>{sheet?.truncated&&<p className="attachment-extraction-note" role="status">当前工作表已截断，完整数据请下载原文件。</p>}<div className="attachment-sheet-table" tabIndex={0} role="region" aria-label={sheet?.name||'工作表数据'}><Table columns={columns} dataSource={data} pagination={false} size="small" bordered scroll={{x:Math.max(500,width*150+56),y:380}} empty="此工作表没有可显示的数据"/></div><div className="attachment-sheet-pagination"><Button icon={<IconChevronLeft aria-hidden/>} disabled={page<=0} aria-label="表格上一页" onClick={()=>setPage(value=>value-1)}>上一页</Button><span role="status">{rows.length?`${page*pageSize+1}–${Math.min(rows.length,(page+1)*pageSize)} / ${rows.length} 行`:'0 行'}</span><Button icon={<IconChevronRight aria-hidden/>} disabled={page>=maxPage} aria-label="表格下一页" onClick={()=>setPage(value=>value+1)}>下一页</Button></div></section>
}
