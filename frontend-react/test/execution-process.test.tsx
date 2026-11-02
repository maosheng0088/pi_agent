// @vitest-environment jsdom
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react'
import ExecutionProcess from '../src/components/ExecutionProcess'
vi.mock('lottie-web',()=>({default:{loadAnimation:vi.fn(()=>({destroy(){},play(){},pause(){},addEventListener(){},removeEventListener(){}}))}}))

const admin={id:'admin',username:'admin',displayName:'管理员',role:'admin'}
const run={id:'trace-a',title:'预约检查',actorName:'业务员工',status:'succeeded',startedAt:'2026-11-01T01:00:00Z',finishedAt:'2026-11-01T01:00:02Z',legacy:false}
const step={id:'1',toolName:'read',args:'{"path":"report.csv"}',output:'真实检查记录',status:'succeeded',startedAt:run.startedAt,finishedAt:run.finishedAt,durationMs:2000,argsTruncated:false,outputTruncated:false}
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}})
let fetcher:ReturnType<typeof vi.fn>
beforeEach(()=>{vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}});fetcher=vi.fn((url:string)=>Promise.resolve(url.startsWith('/api/admin/executions/trace-a')?json({run,steps:[step],total:1,offset:0,limit:50,hasMore:false}):json({runs:[run],total:1,offset:0,limit:30,hasMore:false})));vi.stubGlobal('fetch',fetcher)})
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals()})
describe('administrator execution process',()=>{
 it('shows real tool arguments and outputs for the selected task',async()=>{
  render(<ExecutionProcess user={admin} workTaskId="task-a"/>);await screen.findByText('真实检查记录');expect(screen.getByText('读取文件',{exact:false})).toBeTruthy();expect(screen.getByText('2.0 秒',{exact:false})).toBeTruthy();
  fireEvent.click(screen.getByText('调用参数'));expect(screen.getByText('{"path":"report.csv"}')).toBeTruthy();expect(fetcher.mock.calls[0][0]).toContain('workTaskId=task-a');expect(fetcher.mock.calls.every(([url])=>url.startsWith('/api/admin/executions'))).toBe(true)
 })
 it('never requests private execution details for an employee',()=>{render(<ExecutionProcess user={{...admin,role:'member'}}/>);expect(screen.getByText('仅管理员可查看执行过程。')).toBeTruthy();expect(fetcher).not.toHaveBeenCalled()})
 it('removes private outputs immediately on expiration and ignores a late response',async()=>{
  render(<ExecutionProcess user={admin}/>);await screen.findByText('真实检查记录');let release!:(value:Response)=>void;fetcher.mockImplementationOnce(()=>new Promise<Response>(resolve=>{release=resolve}));fireEvent.click(screen.getByRole('button',{name:'刷新'}));await waitFor(()=>expect(release).toBeTypeOf('function'));
  act(()=>window.dispatchEvent(new Event('pi:auth-expired')));expect(screen.queryByText('真实检查记录')).toBeNull();await act(async()=>release(json({runs:[{...run,title:'晚到私有记录'}],total:1})));expect(screen.queryByText('晚到私有记录')).toBeNull()
 })
 it('labels historical timing as unrecorded and exposes result errors without pretending success',async()=>{
  fetcher.mockImplementation((url:string)=>Promise.resolve(url.startsWith('/api/admin/executions/trace-a')?json({run:{...run,legacy:true,status:'historical'},steps:[{...step,status:'failed',startedAt:null,finishedAt:null,durationMs:null,output:'文件读取失败'}],total:1,offset:0,limit:50}):json({runs:[run],total:1})));
  render(<ExecutionProcess user={admin}/>);await screen.findByText('文件读取失败');expect(screen.getByText(/当时未记录逐步开始时间和耗时/)).toBeTruthy();expect(screen.getByText('失败',{exact:true})).toBeTruthy();expect(screen.queryByText('2.0 秒',{exact:false})).toBeNull()
 })
 it('aborts the old identity and rejects its delayed detail when the target changes',async()=>{
  let release!:(value:Response)=>void;let oldSignal:AbortSignal|undefined;fetcher.mockImplementation((url:string,options:RequestInit)=>{if(url.startsWith('/api/admin/executions/trace-a')){oldSignal=options.signal as AbortSignal;return new Promise<Response>(resolve=>{release=resolve})}return Promise.resolve(json({runs:[run],total:1}))});
  const view=render(<ExecutionProcess user={admin} workTaskId="task-a"/>);await waitFor(()=>expect(release).toBeTypeOf('function'));fetcher.mockImplementation(()=>Promise.resolve(json({runs:[],total:0})));view.rerender(<ExecutionProcess user={admin} workTaskId="task-b"/>);expect(oldSignal?.aborted).toBe(true);
  await act(async()=>release(json({run,steps:[step],total:1})));expect(screen.queryByText('真实检查记录')).toBeNull();await screen.findByText('暂无智能体执行记录')
 })
})
