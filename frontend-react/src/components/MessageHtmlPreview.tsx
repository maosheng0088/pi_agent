import {useMemo,useState} from 'react'
import {Button} from '@douyinfe/semi-ui'
import DOMPurify from 'dompurify'

const reportPolicy="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"
export function reportPreviewDocument(html:string):string {
 const clean=DOMPurify.sanitize(html,{WHOLE_DOCUMENT:true,FORBID_TAGS:['script','iframe','object','embed','base','link','meta','form','input','textarea','select','video','audio','source','svg','math'],FORBID_ATTR:['srcset','action','formaction','target','download','autofocus','contenteditable']})
 const doc=new DOMParser().parseFromString(clean,'text/html')
 for(const element of doc.querySelectorAll('*')){
  for(const attribute of [...element.attributes]){
   if(/^on/i.test(attribute.name)||['href','xlink:href','src','poster','background'].includes(attribute.name.toLowerCase()))element.removeAttribute(attribute.name)
  }
 }
 doc.head.prepend(Object.assign(doc.createElement('meta'),{httpEquiv:'Content-Security-Policy',content:reportPolicy}))
 doc.head.append(Object.assign(doc.createElement('meta'),{name:'viewport',content:'width=device-width, initial-scale=1'}))
 return '<!doctype html>'+doc.documentElement.outerHTML
}

export default function MessageHtmlPreview({code}:{code:string}){
 const [open,setOpen]=useState(false)
 const document=useMemo(()=>open&&code.length<=100000?reportPreviewDocument(code):'', [open,code])
 return <div className="message-html-preview"><div className="message-html-preview-actions"><Button size="small" theme="borderless" onClick={()=>setOpen(value=>!value)} aria-expanded={open}>{open?'收起页面预览':'预览页面'}</Button></div>{open&&(document?<iframe title="HTML 内容预览" sandbox="" referrerPolicy="no-referrer" srcDoc={document}/>:<p role="status">内容较长，请查看原始内容。</p>)}</div>
}
