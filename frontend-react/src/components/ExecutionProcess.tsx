import {useEffect,useRef,useState} from 'react'
import {Banner,Button,Empty,SideSheet,Spin,Tag} from '@douyinfe/semi-ui'
import {IconRefresh} from '@douyinfe/semi-icons'
import {api,ApiError,errorMessage} from '../lib/api'
import type {User} from '../lib/types'
import './execution-process.css'

interface Target{workTaskId?:string;taskRunId?:string;sessionId?:string;groupId?:string}
interface Props extends Target{user:User}
interface Run{id:string;title:string;actorName:string;status:string;startedAt?:string|null;finishedAt?:string|null;recordedAt?:string;legacy:boolean;error?:string}
interface Step{id:string;toolName:string;args:string|null;output:string;status:string;startedAt:string|null;finishedAt:string|null;durationMs:number|null;argsTruncated:boolean;outputTruncated:boolean}
interface Detail{run:Run;steps:Step[];total:number;offset:number;limit:number;hasMore:boolean}
interface Listing{runs:Run[];total:number;offset:number;limit:number;hasMore:boolean}
const statuses:Record<string,string>={running:'执行中',succeeded:'已完成',failed:'失败',cancelled:'已停止',interrupted:'已中断',unknown:'结果未记录',historical:'历史记录'}
const toolNames:Record<string,string>={read:'读取文件',write:'写入文件',edit:'修改文件',ls:'列出目录',find:'查找文件',grep:'搜索内容',powershell:'运行命令',bash:'运行命令',attach_file:'返回文件',open_attachment:'打开附件',read_document:'解析文档',cloud_documents:'操作云文档',email_workspace:'处理邮件',run_unit_count_check:'提交预约件数检查',run_po_duplicate_check:'提交 PO 重复检查'}
const time=(value?:string|null)=>value?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'未记录'
const duration=(value:number|null)=>value===null?'未记录':value<1000?`${value} 毫秒`:`${(value/1000).toFixed(1)} 秒`
function Status({value}:{value:string}){return <Tag color={value==='failed'?'red':value==='running'?'blue':value==='succeeded'?'green':'grey'}>{statuses[value]||value}</Tag>}
function preview(step:Step){try{const args=JSON.parse(step.args||'{}');return String(args.command||args.path||args.action||args.params?.tool||'').slice(0,220)}catch{return ''}}

function Process({user,...target}:Props){
 const key=JSON.stringify([user.id,user.role,target]),params=new URLSearchParams(Object.entries(target).filter((entry):entry is [string,string]=>!!entry[1]))
 const [runs,setRuns]=useState<Run[]>([]),[listTotal,setListTotal]=useState(0),[listOffset,setListOffset]=useState(0),[selected,setSelected]=useState(''),[detail,setDetail]=useState<Detail|null>(null),[offset,setOffset]=useState(0)
 const [loading,setLoading]=useState(true),[detailLoading,setDetailLoading]=useState(false),[error,setError]=useState(''),[locked,setLocked]=useState(false),[paused,setPaused]=useState(false)
 const alive=useRef(false),lockedRef=useRef(false),requests=useRef({list:0,detail:0}),controller=useRef(new AbortController()),detailController=useRef(new AbortController()),selectedRef=useRef(''),polling=useRef(false),refreshRef=useRef<(automatic?:boolean)=>Promise<void>>(async()=>{})
 function fail(reason:unknown){if(!alive.current)return;if(reason instanceof ApiError&&[401,403,404].includes(reason.status)){lockedRef.current=true;setLocked(true);setRuns([]);setDetail(null);selectedRef.current='';setSelected('');controller.current.abort();detailController.current.abort()}setError(errorMessage(reason))}
 async function list(silent=false){const token=++requests.current.list;if(!silent)setLoading(true);try{
  const query=new URLSearchParams(params);query.set('offset',String(listOffset));query.set('limit','30')
  const result=await api<Listing>(`/api/admin/executions?${query}`,{signal:controller.current.signal})
  if(!alive.current||lockedRef.current||token!==requests.current.list)return
  setRuns(result.runs);setListTotal(result.total);if(!selectedRef.current&&result.runs.length){selectedRef.current=result.runs[0].id;setSelected(result.runs[0].id)}
 }catch(reason){if(!controller.current.signal.aborted)fail(reason)}finally{if(alive.current&&token===requests.current.list)setLoading(false)}}
 async function loadDetail(silent=false){const id=selectedRef.current;if(!id)return;const token=++requests.current.detail;detailController.current.abort();const request=new AbortController();detailController.current=request;if(!silent)setDetailLoading(true)
  try{const result=await api<Detail>(`/api/admin/executions/${encodeURIComponent(id)}?offset=${offset}&limit=50`,{signal:request.signal});if(alive.current&&!lockedRef.current&&token===requests.current.detail&&selectedRef.current===id)setDetail(result)}
  catch(reason){if(!request.signal.aborted)fail(reason)}finally{if(alive.current&&token===requests.current.detail)setDetailLoading(false)}
 }
 async function refresh(automatic=false){if(polling.current||lockedRef.current||automatic&&detailLoading)return;polling.current=true;setError('');try{await Promise.all([list(true),...(!automatic||!detail||detail.run.status==='running'?[loadDetail(true)]:[])])}finally{polling.current=false}}
 refreshRef.current=refresh
 useEffect(()=>{alive.current=true;controller.current=new AbortController();const expire=()=>{lockedRef.current=true;setLocked(true);setRuns([]);setDetail(null);controller.current.abort();detailController.current.abort();setError('登录已失效，执行记录已清除。')};window.addEventListener('pi:auth-expired',expire);return()=>{alive.current=false;controller.current.abort();detailController.current.abort();window.removeEventListener('pi:auth-expired',expire)}},[key])
 useEffect(()=>{if(!lockedRef.current)void list()},[listOffset])
 useEffect(()=>{if(!lockedRef.current&&selected){setDetail(null);void loadDetail()}},[selected,offset])
 useEffect(()=>{if(paused||locked)return;const timer=setInterval(()=>{if(!document.hidden)void refreshRef.current(true)},2500);return()=>clearInterval(timer)},[paused,locked])
 function choose(id:string){requests.current.detail++;detailController.current.abort();selectedRef.current=id;setSelected(id);setOffset(0);setDetail(null);setError('')}
 if(locked)return <Banner type="warning" description={error||'当前无权查看执行过程，内容已清除。'} closeIcon={null}/>
 return <section className="execution-process" aria-label="管理员执行过程">
  <header className="execution-toolbar"><p>查看工具实际调用、参数与结果。时间均为北京时间，参数及输出已脱敏。</p><div><Button onClick={()=>setPaused(value=>!value)}>{paused?'继续自动刷新':'暂停自动刷新'}</Button><Button icon={<IconRefresh aria-hidden/>} onClick={()=>void refresh()} disabled={loading||detailLoading}>刷新</Button></div></header>
  {error&&<Banner type="danger" description={<span role="alert">{error}</span>} closeIcon={null}/>}
  <div className="execution-layout"><nav className="execution-runs" aria-label="执行记录列表">
   {loading&&!runs.length?<Spin tip="正在读取执行记录…"/>:runs.length?runs.map(run=><button key={run.id} onClick={()=>choose(run.id)} className={`execution-run ${selected===run.id?'selected':''}`} aria-current={selected===run.id?'true':undefined}><strong>{run.title}</strong><Status value={run.status}/><small>{run.actorName} · {time(run.startedAt||run.recordedAt)}</small></button>):<Empty title="暂无智能体执行记录" description={target.taskRunId?'此任务可能直接执行业务程序，请在运行记录中查看执行日志。':'任务开始后将在这里记录实际工具调用。'}/>}
   {listTotal>30&&<div className="execution-pagination"><Button disabled={!listOffset||loading} onClick={()=>setListOffset(value=>Math.max(0,value-30))}>较新执行</Button><Button disabled={listOffset+30>=listTotal||loading} onClick={()=>setListOffset(value=>value+30)}>更早执行</Button></div>}
  </nav><section className="execution-detail" aria-label="工具执行步骤">
   {detailLoading?<Spin tip="正在读取执行步骤…"/>:detail?<>
    <header className="execution-heading"><h3>{detail.run.title}</h3><Status value={detail.run.status}/></header>
    {detail.run.legacy?<Banner type="info" closeIcon={null} description="历史记录来自已保存的会话工具调用；当时未记录逐步开始时间和耗时，不代表一轮独立执行。"/>:<p className="execution-meta">发起人：{detail.run.actorName} · 开始：{time(detail.run.startedAt)} · 结束：{detail.run.status==='running'?'进行中':time(detail.run.finishedAt)}</p>}
    {detail.run.error&&<Banner type="warning" closeIcon={null} description={detail.run.error}/>}
    <p className="execution-meta" role="status">共 {detail.total} 个工具步骤{detail.total?`，当前显示 ${detail.offset+1}–${Math.min(detail.offset+detail.limit,detail.total)}`:''}。脚本内部步骤以程序实际日志为准。</p>
    {detail.steps.length?<ol className="execution-steps" start={detail.offset+1}>{detail.steps.map((step,index)=><li key={step.id} className={`execution-step ${step.status==='failed'?'failed':''}`}><div className="execution-step-title"><strong>{detail.offset+index+1}. {toolNames[step.toolName]||step.toolName}</strong><code>{step.toolName}</code><Status value={step.status}/></div>{preview(step)&&<pre className="execution-preview">{preview(step)}</pre>}<p className="execution-meta">开始：{time(step.startedAt)} · 耗时：{duration(step.durationMs)}</p><details><summary>调用参数{step.argsTruncated?'（已截取）':''}</summary><pre>{step.args??'历史记录中未保存调用参数。'}</pre></details><details><summary>返回结果{step.outputTruncated?'（已截取）':''}</summary><pre>{step.output||(step.status==='running'?'工具仍在执行，尚无输出。':'没有文本结果。')}</pre></details></li>)}</ol>:<Empty title="本次没有工具调用记录" description="可能仅进行了模型回复，或历史会话未保留工具记录。"/>}
    {detail.total>50&&<div className="execution-pagination"><Button disabled={!offset} onClick={()=>setOffset(value=>Math.max(0,value-50))}>上一页步骤</Button><Button disabled={!detail.hasMore} onClick={()=>setOffset(value=>value+50)}>下一页步骤</Button><Button disabled={offset===Math.floor((detail.total-1)/50)*50} onClick={()=>setOffset(Math.floor((detail.total-1)/50)*50)}>最新步骤</Button></div>}
   </>:<Empty title="选择一次执行" description="查看智能体具体使用了哪些工具。"/>}
  </section></div>
 </section>
}
export default function ExecutionProcess(props:Props){return props.user.role==='admin'?<Process key={JSON.stringify(props)} {...props}/>:<Banner type="warning" description="仅管理员可查看执行过程。"/>}
export function ExecutionProcessDialog({onClose,...props}:Props&{onClose():void}){return props.user.role==='admin'?<SideSheet visible title="智能体执行过程" width="min(1100px, 96vw)" onCancel={onClose} bodyStyle={{padding:16}}><ExecutionProcess {...props}/></SideSheet>:null}
