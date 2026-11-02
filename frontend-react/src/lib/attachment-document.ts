import {messageAttachment} from './message-links'
import type {MessageAttachment} from './message-links'

export type DocumentFormat='pdf'|'docx'|'xlsx'|'csv'|'text'|'unsupported'
export interface AttachmentDocument{
  format:DocumentFormat;status:'ready'|'unsupported'|'error'|'needs_ocr';text:string;
  sections:Array<{title:string;text:string;page?:number}>;
  sheets?:Array<{name:string;rows:Array<Array<string|number|boolean|null>>;truncated:boolean}>;
  pageCount?:number;warnings:string[];truncated:boolean;
}
const textExtensions=new Set(['txt','md','markdown','json'])
export function documentFormat(name:string):DocumentFormat{const extension=name.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase()||'';return ['pdf','docx','xlsx','csv'].includes(extension)?extension as DocumentFormat:textExtensions.has(extension)?'text':'unsupported'}
export function fileReadingHint(name:string){if(/\.(?:png|jpe?g|gif|webp)$/i.test(name))return '图片 · 可放大预览';const format=documentFormat(name);return format==='unsupported'?'仅下载，暂不支持读取':format==='pdf'?'PDF · 可逐页预览':format==='docx'?'Word · 文字预览':format==='xlsx'||format==='csv'?'表格 · 可切换工作表':'文本 · 文字预览'}
export function documentBase(attachment:MessageAttachment){return messageAttachment(attachment.href,attachment.name)?.href.split('?',1)[0]}

/** Only data primitives reach React text nodes; formulas and uploaded markup are inert. */
export function attachmentDocument(value:unknown):AttachmentDocument{
  const item=value as AttachmentDocument
  if(!item||!['pdf','docx','xlsx','csv','text','unsupported'].includes(item.format)||!['ready','unsupported','error','needs_ocr'].includes(item.status)||typeof item.text!=='string'||!Array.isArray(item.sections)||!Array.isArray(item.warnings)||typeof item.truncated!=='boolean')throw new Error('服务未返回有效的文档解析结果，请重试。')
  let truncated=item.truncated||item.text.length>600000||item.sections.length>1000
  const sections=item.sections.slice(0,1000).map(section=>{
    if(!section||typeof section.title!=='string'||typeof section.text!=='string'||section.page!==undefined&&(!Number.isSafeInteger(section.page)||section.page<1))throw new Error('文档段落数据无效，请重试。')
    if(section.text.length>200000)truncated=true
    return {title:section.title.slice(0,500),text:section.text.slice(0,200000),...(section.page?{page:section.page}:{})}
  })
  let sheets:AttachmentDocument['sheets']
  if(item.sheets!==undefined){
    if(!Array.isArray(item.sheets))throw new Error('文档表格数据无效，请重试。')
    if(item.sheets.length>50)truncated=true
    sheets=item.sheets.slice(0,50).map(sheet=>{
      if(!sheet||typeof sheet.name!=='string'||!Array.isArray(sheet.rows)||typeof sheet.truncated!=='boolean')throw new Error('工作表数据无效，请重试。')
      let cut=sheet.truncated||sheet.rows.length>1000
      const rows=sheet.rows.slice(0,1000).map(row=>{
        if(!Array.isArray(row))throw new Error('工作表行数据无效，请重试。')
        if(row.length>50)cut=true
        return row.slice(0,50).map(cell=>{if(cell===null||typeof cell==='boolean'||typeof cell==='number'&&Number.isFinite(cell))return cell;if(typeof cell==='string'){if(cell.length>10000)cut=true;return cell.slice(0,10000)}throw new Error('工作表单元格数据无效，请重试。')})
      })
      if(cut)truncated=true
      return {name:sheet.name.slice(0,200),rows,truncated:cut}
    })
  }
  if(item.pageCount!==undefined&&(!Number.isSafeInteger(item.pageCount)||item.pageCount<0))throw new Error('文档页码数据无效，请重试。')
  return {format:item.format,status:item.status,text:item.text.slice(0,600000),sections,...(sheets?{sheets}:{}),...(item.pageCount!==undefined?{pageCount:item.pageCount}:{}),warnings:item.warnings.filter((value):value is string=>typeof value==='string').slice(0,20).map(value=>value.slice(0,1000)),truncated}
}
