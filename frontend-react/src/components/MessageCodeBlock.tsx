import {useEffect,useId,useRef,useState} from 'react'
import {Button,CodeHighlight} from '@douyinfe/semi-ui'
import {IconCopy,IconChevronDown,IconChevronUp,IconCode} from '@douyinfe/semi-icons'
import DOMPurify from 'dompurify'
import MessageHtmlPreview from './MessageHtmlPreview'
import 'prismjs/components/prism-javascript'
import 'prismjs/components/prism-typescript'
import 'prismjs/components/prism-jsx'
import 'prismjs/components/prism-tsx'
import 'prismjs/components/prism-python'
import 'prismjs/components/prism-json'
import 'prismjs/components/prism-bash'
import 'prismjs/components/prism-powershell'
import 'prismjs/components/prism-sql'
import './message-code.css'

export interface MessageCodeBlockProps {code:string;language?:string}
const aliases:Record<string,string>={py:'python',python:'python',python3:'python',py3:'python',js:'javascript',javascript:'javascript',node:'javascript',nodejs:'javascript',ts:'typescript',typescript:'typescript',jsx:'jsx',tsx:'tsx',html:'markup',markup:'markup',xml:'markup',svg:'markup',css:'css',clike:'clike',json:'json',sh:'bash',shell:'bash',bash:'bash',zsh:'bash',shellscript:'bash',ps:'powershell',ps1:'powershell',pwsh:'powershell',powershell:'powershell',sql:'sql',mysql:'sql',postgres:'sql',postgresql:'sql',sqlite:'sql',mermaid:'mermaid',mmd:'mermaid'}
const names:Record<string,string>={python:'Python',javascript:'JavaScript',typescript:'TypeScript',jsx:'JSX',tsx:'TSX',html:'HTML',markup:'Markup',xml:'XML',svg:'SVG',css:'CSS',clike:'C-like',json:'JSON',bash:'Shell',powershell:'PowerShell',sql:'SQL',mermaid:'Mermaid'}
const COLLAPSED_LINES=16,COLLAPSED_CHARS=2400,MAX_HIGHLIGHT_CHARS=60000,MAX_DIAGRAM_CHARS=8000,MAX_DIAGRAM_LINES=160
let mermaidPromise:Promise<typeof import('mermaid')['default']>|undefined,renderSequence=0
function languageName(value?:string){return (value||'').trim().replace(/^language-/i,'').split(/\s+/,1)[0]!.toLowerCase().slice(0,40)}
function loadMermaid(){
 if(!mermaidPromise)mermaidPromise=import('mermaid').then(module=>{
  const renderer=module.default
  renderer.initialize({startOnLoad:false,securityLevel:'strict',htmlLabels:false,flowchart:{htmlLabels:false},theme:'neutral',suppressErrorRendering:true,maxTextSize:MAX_DIAGRAM_CHARS,maxEdges:150,secure:['secure','securityLevel','startOnLoad','htmlLabels','flowchart','theme','themeCSS','maxTextSize','maxEdges','suppressErrorRendering']})
  return renderer
 }).catch(error=>{mermaidPromise=undefined;throw error})
 return mermaidPromise
}
function diagramProblem(code:string){
 if(code.length>MAX_DIAGRAM_CHARS||code.split(/\r\n?|\n/).length>MAX_DIAGRAM_LINES)return '图示较长，已保留源码，可复制后查看。'
 // No per-message configuration, callbacks, raw markup, images, CSS resource
 // declarations or navigation. Rejected diagrams remain readable source.
 if(/^\s*---(?:\r?\n|$)/.test(code)||/%%\s*\{|^\s*(?:click|style|classDef|linkStyle)\b|<\s*\/?[a-z!]|(?:https?|javascript|vbscript|data|file|blob):|\/\/|@\{|\b(?:href|src)\s*=|url\s*\(|@import|\\/im.test(code))return '图示含不支持的配置、链接或交互，已显示源码。'
 return ''
}
function unsafeCss(value:string){
 const withoutLocalReferences=value.replace(/url\(\s*(['"]?)#[A-Za-z0-9_:.-]+\1\s*\)/gi,'')
 return /url\s*\(|(?:image-set|cross-fade|image)\s*\(|@(?:import|font-face|namespace)|expression\s*\(|behavior\s*:|-moz-binding|(?:https?|javascript|vbscript|data|file|blob):|\/\/|\\/i.test(withoutLocalReferences)
}
/** The result is displayed as a static SVG image, never installed as clickable
 * markup. DOMPurify is followed by a resource/CSS check because SVG sanitizing
 * alone is not a no-network policy. */
export function sanitizeMermaidSvg(raw:string):string {
 if(typeof raw!=='string'||raw.length>500000)throw new Error('图示输出超出限制。')
 const fragment=DOMPurify.sanitize(raw,{USE_PROFILES:{svg:true,svgFilters:true},FORBID_TAGS:['script','foreignObject','iframe','object','embed','image','use','a','animate','animateMotion','animateTransform','set'],FORBID_ATTR:['href','xlink:href','src','srcset','target'],RETURN_DOM_FRAGMENT:true})
 const svg=fragment.querySelector('svg')
 if(!svg||svg.namespaceURI!=='http://www.w3.org/2000/svg')throw new Error('图示输出无效。')
 for(const element of [svg,...svg.querySelectorAll('*')]){
  if(element.localName.toLowerCase()==='style'&&unsafeCss(element.textContent||'')){element.remove();continue}
  for(const attribute of [...element.attributes]){
   const key=attribute.name.toLowerCase(),value=attribute.value
   if(/^on/.test(key)||['href','xlink:href','src','srcset','target'].includes(key)||(key!=='xmlns'&&key!=='xmlns:xlink'&&unsafeCss(value)))element.removeAttribute(attribute.name)
  }
 }
 svg.setAttribute('xmlns','http://www.w3.org/2000/svg')
 return new XMLSerializer().serializeToString(svg)
}

function CodeSource({code,language}:{code:string;language?:string}){
 // Literal JSON is preserved; parsing/stringifying can change large numbers.
 return language&&code.length<=MAX_HIGHLIGHT_CHARS?<CodeHighlight key={language} className="message-code-highlight" code={code} language={language} lineNumber={false}/>:<pre className="message-code-plain"><code>{code}</code></pre>
}

export default function MessageCodeBlock({code,language}:MessageCodeBlockProps){
 const rawLanguage=languageName(language),canonical=aliases[rawLanguage],displayName=names[rawLanguage]||names[canonical]||rawLanguage||'文本',diagram=canonical==='mermaid',id=useId().replace(/[^A-Za-z0-9_-]/g,'_')
 const [expanded,setExpanded]=useState(false),[sourceOpen,setSourceOpen]=useState(false),[copyState,setCopyState]=useState<'idle'|'copied'|'failed'>('idle')
 const [result,setResult]=useState<{code:string;phase:'loading'|'ready'|'failed';svg?:string;message?:string}>({code,phase:'loading'})
 const staging=useRef<HTMLDivElement>(null),active=useRef(true),copyTimer=useRef<ReturnType<typeof setTimeout>>(),latest=useRef(code);latest.current=code
 const lines=code.split(/\r\n?|\n/),long=lines.length>COLLAPSED_LINES||code.length>COLLAPSED_CHARS
 const preview=expanded||!long?code:lines.slice(0,COLLAPSED_LINES).join('\n').slice(0,COLLAPSED_CHARS)
 const current=result.code===code?result:undefined,hasDiagram=diagram&&current?.phase==='ready'&&!!current.svg
 useEffect(()=>{active.current=true;return()=>{active.current=false;clearTimeout(copyTimer.current)}},[])
 useEffect(()=>{setExpanded(false);setSourceOpen(false);setCopyState('idle');clearTimeout(copyTimer.current)},[code,canonical])
 useEffect(()=>{
  if(!diagram)return
  let disposed=false,timeout:ReturnType<typeof setTimeout>|undefined
  setResult({code,phase:'loading'})
  const problem=diagramProblem(code)
  if(problem){setResult({code,phase:'failed',message:problem});return}
  const stage=document.createElement('div');staging.current?.append(stage)
  void(async()=>{
   try{
    const renderer=await loadMermaid();if(disposed)return
    const rendered=await Promise.race([renderer.render(`pi-mermaid-${id}-${++renderSequence}`,code,stage),new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new Error('图示生成超时。')),8000)})])
    if(disposed)return
    const svg=sanitizeMermaidSvg(rendered.svg)
    // bindFunctions is intentionally never called: diagrams are static.
    if(!disposed)setResult({code,phase:'ready',svg})
   }catch{if(!disposed)setResult({code,phase:'failed',message:'图示暂时无法生成，已保留原始源码。'})}
   finally{clearTimeout(timeout);stage.remove()}
  })()
  return()=>{disposed=true;clearTimeout(timeout);stage.remove()}
 },[code,diagram,id])
 async function copy(){const value=code;try{await navigator.clipboard.writeText(value);if(!active.current||latest.current!==value)return;setCopyState('copied');clearTimeout(copyTimer.current);copyTimer.current=setTimeout(()=>{if(active.current)setCopyState('idle')},2000)}catch{if(active.current&&latest.current===value)setCopyState('failed')}}
 return <section className={`message-code-block ${diagram?'is-mermaid':''}`} aria-label={`${displayName}代码块`}>
  <header className="message-code-toolbar"><span><IconCode aria-hidden/>{displayName}<small>{lines.length} 行</small></span><div>{hasDiagram&&<Button size="small" theme="borderless" onClick={()=>setSourceOpen(value=>!value)} aria-expanded={sourceOpen}>{sourceOpen?'返回图示':'查看源码'}</Button>}<Button size="small" theme="borderless" icon={<IconCopy aria-hidden/>} onClick={()=>void copy()} aria-label="复制此代码块">{copyState==='copied'?'已复制':'复制代码'}</Button></div></header>
  {copyState==='failed'&&<p className="message-code-feedback" role="status">复制失败，请手动选择代码。</p>}
  {diagram&&current?.phase==='loading'&&<p className="message-code-feedback" role="status">正在生成图示，源码仍可查看。</p>}
  {diagram&&current?.phase==='failed'&&<p className="message-code-feedback" role="status">{current.message}</p>}
  {hasDiagram&&!sourceOpen?<div className="message-mermaid-image"><img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(current!.svg!)}`} alt="Mermaid 图示"/></div>:<><CodeSource code={preview} language={!diagram?canonical:undefined}/>{long&&<div className="message-code-expand"><Button size="small" theme="borderless" icon={expanded?<IconChevronUp aria-hidden/>:<IconChevronDown aria-hidden/>} onClick={()=>setExpanded(value=>!value)} aria-expanded={expanded}>{expanded?'收起代码':`展开全部代码（${lines.length} 行）`}</Button>{!expanded&&<span>已折叠较长内容，复制仍包含完整源码</span>}</div>}</>}
  {['html','htm'].includes(rawLanguage)&&<MessageHtmlPreview code={code}/>}
  <div className="message-mermaid-staging" ref={staging} aria-hidden="true"/>
 </section>
}
