import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../lib/store.mjs';
import {ExecutionTraceService} from '../lib/execution-traces.mjs';

async function fixture(run){const directory=await mkdtemp(path.join(os.tmpdir(),'pi-trace-test-'));const cwd=path.join(directory,'cwd');await mkdir(cwd);const store=new Store(path.join(directory,'data'),cwd);try{await run(store)}finally{store.close();assert.equal(path.dirname(directory),os.tmpdir());await rm(directory,{recursive:true,force:true})}}
test('records real tool lifecycle, bounded text and secrets, without duplicate starts',()=>fixture(async store=>{
 let at=new Date('2026-11-01T01:00:00Z');const service=new ExecutionTraceService(store,{now:()=>at,redact:text=>String(text).replaceAll('private-fixture-secret','[redacted]')});
 const id=service.start({sessionId:'session-a',groupId:'group-a',workTaskId:'task-a',actor:{id:'u',displayName:'管理员'}});
 const start={type:'tool_execution_start',toolCallId:'call-1',toolName:'powershell',args:{command:'echo private-fixture-secret',credentials:{password:'unknown-password'}}};
 service.event(id,start);service.event(id,start);service.event(id,{type:'tool_execution_update',toolCallId:'call-1',partialResult:{content:[{type:'text',text:'first output'}]}});
 let result=await service.get(id);assert.equal(result.total,1);assert.equal(result.steps[0].status,'running');assert.match(result.steps[0].output,/first output/);
 at=new Date(at.getTime()+1250);service.event(id,{type:'tool_execution_end',toolCallId:'call-1',toolName:'powershell',isError:true,result:{content:[{type:'text',text:'private-fixture-secret '+ 'x'.repeat(40000)}]}});service.finish(id,'failed','failure private-fixture-secret');
 result=await service.get(id);assert.equal(result.run.status,'failed');assert.equal(result.steps[0].status,'failed');assert.equal(result.steps[0].durationMs,1250);assert.equal(result.steps[0].outputTruncated,true);assert.equal(result.steps[0].output.length,32000);
 assert(!JSON.stringify(result).includes('private-fixture-secret'));assert(!JSON.stringify(result).includes('unknown-password'));
 const raw=JSON.stringify(store.db.prepare('SELECT * FROM execution_steps').all());assert(!raw.includes('private-fixture-secret'));assert(!raw.includes('unknown-password'));
 assert.equal(service.list({workTaskId:'task-a'}).total,1);assert.equal(service.list({workTaskId:'task-b'}).total,0);assert.throws(()=>service.list({sessionId:'a',groupId:'b'}),{status:400});
}));
test('interrupted steps remain distinct from successful steps, and survive service restart',()=>fixture(async store=>{
 let service=new ExecutionTraceService(store);const id=service.start({sessionId:'s',actor:{}});
 service.event(id,{type:'tool_execution_start',toolCallId:'read',toolName:'read',args:{path:'fixture.txt'}});
 service=new ExecutionTraceService(store);const result=await service.get(id);
 assert.equal(result.run.status,'interrupted');assert.equal(result.steps[0].status,'interrupted');
 service.event(id,{type:'tool_execution_end',toolCallId:'read',toolName:'read',result:{content:[{type:'text',text:'late'}]}});
 assert.equal((await service.get(id)).steps[0].status,'interrupted');
}));
test('historical records correlate saved tool calls without inventing timing',()=>fixture(async store=>{
 store.sessions.push({id:'old-worker',title:'历史任务',file:'trusted-session-file',messageCount:3,workTaskId:'old-task',taskTargetSessionId:'business-group'});
 const service=new ExecutionTraceService(store,{readHistory:()=>[{role:'assistant',tools:[{id:'c1',name:'read',args:{path:'fixture.txt'}}]},{role:'toolResult',toolCallId:'c1',toolName:'read',content:'historical output',isError:false},{role:'assistant',tools:[{id:'c2',name:'grep',args:{pattern:'A'}}]}]});
 const list=service.list({workTaskId:'old-task'});assert.equal(list.runs[0].id,'history-old-worker');assert.equal(service.list({workTaskId:'unrelated'}).total,0);
 const result=await service.get(list.runs[0].id,{limit:1});assert.equal(result.total,2);assert.equal(result.hasMore,true);assert.equal(result.steps[0].output,'historical output');assert.equal(result.steps[0].durationMs,null);assert.equal(result.steps[0].startedAt,null);
 const next=await service.get(list.runs[0].id,{offset:1});assert.equal(next.steps[0].status,'unknown');
 await assert.rejects(()=>service.get('history-unknown'),{status:404});await assert.rejects(()=>service.get('../outside'),{status:400});
}));
test('step pagination preserves all tool calls, and stopping closes unfinished steps',()=>fixture(async store=>{
 const service=new ExecutionTraceService(store);const id=service.start({sessionId:'s'});
 for(let i=0;i<55;i++)service.event(id,{type:'tool_execution_start',toolCallId:`c${i}`,toolName:'read',args:{path:`${i}.txt`}});
 service.finish(id,'cancelled');const first=await service.get(id,{limit:50}),last=await service.get(id,{offset:50,limit:50});
 assert.equal(first.total,55);assert.equal(first.steps.length,50);assert.equal(last.steps.length,5);assert.equal(last.hasMore,false);assert(first.steps.every(step=>step.status==='interrupted'));
 assert.equal(service.list().runs[0].status,'cancelled');
}));

test('tool argument Webhook credentials are redacted independently of the configured URL',()=>fixture(async store=>{
 const service=new ExecutionTraceService(store);const id=service.start({sessionId:'webhook-trace'});
 service.event(id,{type:'tool_execution_start',toolCallId:'configure',toolName:'configure',args:{webhookUrl:'private-unconfigured-hook',nested:{webhook_url:'private-other-hook'}}});
 const raw=JSON.stringify(store.db.prepare('SELECT args_text FROM execution_steps').all());
 assert(!raw.includes('private-unconfigured-hook'));assert(!raw.includes('private-other-hook'));assert.match(raw,/redacted/);
}));
