import { randomUUID } from 'node:crypto';
import { HttpError } from './security.mjs';

const identifier=/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/;
const sensitive=/password|passwd|token|secret|api[-_]?key|authorization|cookie|credential|webhook/i;
const statusNames=new Set(['succeeded','failed','cancelled','interrupted']);
const textParts=value=>typeof value==='string'?value:Array.isArray(value)?value.map(part=>part?.type==='text'?part.text:part?.type==='image'?'[图片结果]':'').filter(Boolean).join('\n'):'';

/** Observable tool actions only; never records the model's private reasoning. */
export class ExecutionTraceService{
 constructor(store,{redact=String,readHistory=()=>[],now=()=>new Date()}={}){
  this.store=store;this.db=store.db;this.redact=redact;this.readHistory=readHistory;this.now=now;this.partialAt=new Map();
  this.db.exec(`CREATE TABLE IF NOT EXISTS execution_traces(
   seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,session_id TEXT NOT NULL,group_id TEXT NOT NULL,
   work_task_id TEXT,task_run_id TEXT,title TEXT NOT NULL,actor_id TEXT,actor_name TEXT NOT NULL,
   status TEXT NOT NULL,started_at TEXT NOT NULL,finished_at TEXT,error TEXT);
   CREATE INDEX IF NOT EXISTS execution_traces_group ON execution_traces(group_id,seq DESC);
   CREATE INDEX IF NOT EXISTS execution_traces_work ON execution_traces(work_task_id,seq DESC);
   CREATE INDEX IF NOT EXISTS execution_traces_schedule ON execution_traces(task_run_id,seq DESC);
   CREATE TABLE IF NOT EXISTS execution_steps(
   seq INTEGER PRIMARY KEY AUTOINCREMENT,trace_id TEXT NOT NULL REFERENCES execution_traces(id) ON DELETE CASCADE,
   call_id TEXT NOT NULL,tool_name TEXT NOT NULL,args_text TEXT,output_text TEXT,status TEXT NOT NULL,
   started_at TEXT,finished_at TEXT,args_truncated INTEGER NOT NULL DEFAULT 0,output_truncated INTEGER NOT NULL DEFAULT 0,
   UNIQUE(trace_id,call_id));
   CREATE INDEX IF NOT EXISTS execution_steps_trace ON execution_steps(trace_id,seq);`);
  const at=this.at();
  store.transaction(()=>{
   this.db.prepare("UPDATE execution_steps SET status='interrupted',finished_at=? WHERE status='running'").run(at);
   this.db.prepare("UPDATE execution_traces SET status='interrupted',finished_at=?,error=? WHERE status='running'").run(at,'服务重启，执行已中断；请核对已发生的操作。');
  });
 }
 at(){return new Date(this.now()).toISOString();}
 safe(value,limit=32000){
  const clean=(item,depth=0)=>{if(depth>12)return '[内容层级过深]';if(typeof item==='string')return this.redact(item);if(Array.isArray(item))return item.slice(0,500).map(v=>clean(v,depth+1));if(item&&typeof item==='object')return Object.fromEntries(Object.entries(item).slice(0,500).map(([k,v])=>[k,sensitive.test(k)?'[redacted]':clean(v,depth+1)]));return item;};
  const result=this.redact(typeof value==='string'?value:JSON.stringify(clean(value??null),null,2));
  return {text:result.slice(0,limit),truncated:result.length>limit||typeof value==='string'&&value.length>limit};
 }
 start({id=randomUUID(),sessionId,groupId=sessionId,workTaskId=null,taskRunId=null,title,actor}){
  if(!identifier.test(id)||!identifier.test(sessionId)||!identifier.test(groupId))throw new Error('执行记录编号无效。');
  this.db.prepare(`INSERT INTO execution_traces(id,session_id,group_id,work_task_id,task_run_id,title,actor_id,actor_name,status,started_at)
   VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id,sessionId,groupId,workTaskId,taskRunId,this.safe(title||'智能体执行',160).text,actor?.id||null,this.safe(actor?.displayName||'成员',100).text,'running',this.at());
  return id;
 }
 event(traceId,event){
  if(!['tool_execution_start','tool_execution_update','tool_execution_end'].includes(event.type)||!event.toolCallId)return;
  if(!this.db.prepare("SELECT id FROM execution_traces WHERE id=? AND status='running'").get(traceId))return;
  const callId=String(event.toolCallId).slice(0,200),key=`${traceId}:${callId}`,at=this.at();
  if(event.type==='tool_execution_start'){
   const args=this.safe(event.args,12000);
   this.db.prepare(`INSERT OR IGNORE INTO execution_steps(trace_id,call_id,tool_name,args_text,status,started_at,args_truncated) VALUES(?,?,?,?,'running',?,?)`)
    .run(traceId,callId,this.safe(event.toolName||'未知工具',100).text,args.text,at,Number(args.truncated));
  }else{
   if(event.type==='tool_execution_update'&&Date.now()-(this.partialAt.get(key)||0)<500)return;
   const result=event.type==='tool_execution_end'?event.result:event.partialResult;
   const output=this.safe(textParts(result?.content),32000);
   if(event.type==='tool_execution_update'){
    this.partialAt.set(key,Date.now());
    this.db.prepare("UPDATE execution_steps SET output_text=?,output_truncated=? WHERE trace_id=? AND call_id=? AND status='running'").run(output.text,Number(output.truncated),traceId,callId);
   }else{
    this.partialAt.delete(key);
    this.db.prepare(`INSERT INTO execution_steps(trace_id,call_id,tool_name,output_text,status,finished_at,output_truncated) VALUES(?,?,?,?,?,?,?)
     ON CONFLICT(trace_id,call_id) DO UPDATE SET output_text=excluded.output_text,status=excluded.status,finished_at=excluded.finished_at,output_truncated=excluded.output_truncated`)
     .run(traceId,callId,this.safe(event.toolName||'未知工具',100).text,output.text,event.isError?'failed':'succeeded',at,Number(output.truncated));
   }
  }
 }
 finish(id,status,error=''){
  if(!statusNames.has(status))throw new Error('执行状态无效。');
  const at=this.at();this.store.transaction(()=>{
   this.db.prepare("UPDATE execution_steps SET status='interrupted',finished_at=? WHERE trace_id=? AND status='running'").run(at,id);
   this.db.prepare("UPDATE execution_traces SET status=?,finished_at=?,error=? WHERE id=? AND status='running'").run(status,at,error?this.safe(error,2000).text:null,id);
  });
  for(const key of this.partialAt.keys())if(key.startsWith(`${id}:`))this.partialAt.delete(key);
 }
 summary(row){return {id:row.id,sessionId:row.session_id,groupId:row.group_id,workTaskId:row.work_task_id,taskRunId:row.task_run_id,title:this.safe(row.title,160).text,actorName:this.safe(row.actor_name,100).text,status:row.status,startedAt:row.started_at,finishedAt:row.finished_at,error:row.error?this.safe(row.error,2000).text:null,legacy:false};}
 legacy(meta){return {id:`history-${meta.id}`,sessionId:meta.id,groupId:meta.taskTargetSessionId||meta.id,workTaskId:meta.workTaskId||null,taskRunId:meta.taskRunId||null,title:this.safe(meta.title||'历史工具记录',160).text,actorName:'历史记录',status:'historical',startedAt:null,finishedAt:null,recordedAt:meta.updatedAt||meta.createdAt,legacy:true};}
 list({sessionId,groupId,workTaskId,taskRunId,offset=0,limit=30}={}){
  const filters={sessionId,groupId,workTaskId,taskRunId};
  if(Object.values(filters).filter(Boolean).length>1)throw new HttpError(400,'一次只能指定一种执行范围。');
  for(const value of Object.values(filters))if(value&&!identifier.test(value))throw new HttpError(400,'执行范围编号无效。');
  const match=row=>(!sessionId||row.sessionId===sessionId)&&(!groupId||row.groupId===groupId)&&(!workTaskId||row.workTaskId===workTaskId)&&(!taskRunId||row.taskRunId===taskRunId);
  const columns={sessionId:'session_id',groupId:'group_id',workTaskId:'work_task_id',taskRunId:'task_run_id'};
  const filter=Object.entries(filters).find(([,v])=>v);
  const rows=this.db.prepare(`SELECT * FROM execution_traces${filter?` WHERE ${columns[filter[0]]}=?`:''} ORDER BY seq DESC`).all(...(filter?[filter[1]]:[]));
  const recorded=new Set(this.db.prepare('SELECT DISTINCT session_id FROM execution_traces').all().map(row=>row.session_id));
  const history=this.store.sessions.filter(meta=>!recorded.has(meta.id)&&meta.file&&meta.messageCount>0).map(meta=>this.legacy(meta)).filter(match);
  const all=[...rows.map(row=>this.summary(row)),...history].sort((a,b)=>String(b.startedAt||b.recordedAt||'').localeCompare(String(a.startedAt||a.recordedAt||''))||b.id.localeCompare(a.id));
  return {runs:all.slice(offset,offset+limit),total:all.length,offset,limit,hasMore:offset+limit<all.length};
 }
 async get(id,{offset=0,limit=50}={}){
  if(!identifier.test(id))throw new HttpError(400,'执行编号无效。');
  if(id.startsWith('history-')){
   const meta=this.store.sessions.find(meta=>meta.id===id.slice(8));if(!meta?.file)throw new HttpError(404,'历史执行记录不存在。');
   const messages=await this.readHistory(meta),steps=[],calls=new Map();
   for(const message of messages){
    for(const tool of message.tools||[]){const args=this.safe(tool.args,12000),step={id:`history-step-${steps.length}`,toolName:this.safe(tool.name,100).text,args:args.text,argsTruncated:args.truncated,output:'',outputTruncated:false,status:'unknown',startedAt:null,finishedAt:null,durationMs:null};steps.push(step);if(tool.id)calls.set(tool.id,step);}
    if(message.role==='toolResult'){
     let step=calls.get(message.toolCallId);if(!step){step={id:`history-step-${steps.length}`,toolName:this.safe(message.toolName||'未知工具',100).text,args:null,argsTruncated:false,startedAt:null,finishedAt:null,durationMs:null};steps.push(step);}
     const output=this.safe(message.content,32000);Object.assign(step,{output:output.text,outputTruncated:output.truncated,status:message.isError?'failed':'succeeded'});
    }
   }
   return {run:this.legacy(meta),steps:steps.slice(offset,offset+limit),total:steps.length,offset,limit,hasMore:offset+limit<steps.length};
  }
  const row=this.db.prepare('SELECT * FROM execution_traces WHERE id=?').get(id);if(!row)throw new HttpError(404,'执行记录不存在。');
  const total=this.db.prepare('SELECT COUNT(*) AS total FROM execution_steps WHERE trace_id=?').get(id).total;
  const steps=this.db.prepare('SELECT * FROM execution_steps WHERE trace_id=? ORDER BY seq LIMIT ? OFFSET ?').all(id,limit,offset).map(step=>{
   const args=step.args_text==null?null:this.safe(step.args_text,12000),output=this.safe(step.output_text||'',32000);
   const duration=step.started_at&&step.finished_at?Date.parse(step.finished_at)-Date.parse(step.started_at):null;
   return {id:String(step.seq),toolName:this.safe(step.tool_name,100).text,args:args?.text??null,output:output.text,status:step.status,startedAt:step.started_at,finishedAt:step.finished_at,durationMs:duration,argsTruncated:Boolean(step.args_truncated)||!!args?.truncated,outputTruncated:Boolean(step.output_truncated)||output.truncated};
  });
  return {run:this.summary(row),steps,total,offset,limit,hasMore:offset+limit<total};
 }
}
