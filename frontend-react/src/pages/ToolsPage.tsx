import {useId,useState} from 'react'
import {Button,Card,Empty,Input,Tag} from '@douyinfe/semi-ui'
import {IconArrowRight,IconGlobeStroke,IconSearch} from '@douyinfe/semi-icons'
import './tools-page.css'

interface Props{onOpenTool(tool:'ocean'):void}
const oceanFeatures=['号码追踪','港口码头','船司目录','滚装船期','箱型']
const oceanKeywords=['海运工具','物流查询','集装箱','箱号','校验','ISO 6346','ISO6346','提单','订舱','港口','码头','船司','船公司','租箱公司','滚装','船期','箱型','追踪','container','tracking','port','carrier','roro']

export default function ToolsPage({onOpenTool}:Props){
 const [query,setQuery]=useState(''),id=useId(),keyword=query.trim().toLocaleLowerCase()
 const visible=!keyword||oceanKeywords.some(value=>value.toLocaleLowerCase().includes(keyword))
 return <section className="tools-page" aria-labelledby={`${id}-title`}>
  <header className="tools-page-heading"><span className="tools-page-eyebrow">TOOLS</span><h1 id={`${id}-title`}>工具</h1><p>直接打开业务工具，按需发起智能体协作。</p></header>
  <div className="tools-search"><label htmlFor={`${id}-search`}>搜索工具</label><div className="tools-search-controls"><Input id={`${id}-search`} value={query} onChange={setQuery} prefix={<IconSearch aria-hidden/>} placeholder="按名称或业务关键词查找，如箱号、港口" maxLength={100} composition/><Button disabled={!query} onClick={()=>setQuery('')}>重置</Button></div></div>
  <div className="tools-directory" aria-label="业务工具目录">
   {visible?<Card className="tools-directory-card" aria-labelledby={`${id}-ocean-title`} bodyStyle={{padding:24}}>
    <div className="tools-card-heading"><span className="tools-card-icon" aria-hidden><IconGlobeStroke/></span><div><h2 id={`${id}-ocean-title`}>海运工具</h2><Tag color="blue">物流查询</Tag></div></div>
    <p className="tools-card-description">识别箱号、提单号和订舱号，检索港口、船司及箱型资料，并打开官方追踪与船期入口。</p>
    <ul className="tools-card-features" aria-label="海运工具功能">{oceanFeatures.map(feature=><li key={feature}><Tag>{feature}</Tag></li>)}</ul>
    <div className="tools-card-footer"><Button theme="solid" icon={<IconArrowRight aria-hidden/>} iconPosition="right" onClick={()=>onOpenTool('ocean')}>打开海运工具</Button></div>
   </Card>:<div className="tools-directory-empty" role="status"><Empty title="未找到匹配的工具" description="换个业务关键词，或重置搜索查看现有工具。"/></div>}
  </div>
 </section>
}
