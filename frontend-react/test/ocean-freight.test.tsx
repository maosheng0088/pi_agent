// @vitest-environment jsdom
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react'
import {executeQuery} from '../../business-tools/ocean-freight/engine.mjs'
import OceanFreightPage from '../src/pages/OceanFreightPage'
import {WorkspaceStore} from '../src/lib/workspace'
import {addOceanHistory,loadOceanHistory,oceanHistoryKey,oceanShareUrl,safeOceanUrl,safeTrackingAction} from '../src/lib/ocean-freight'

const{run}=vi.hoisted(()=>({run:vi.fn()}))
vi.mock('../src/lib/ocean-engine',()=>({queryOcean:run}))
vi.mock('lottie-web',()=>({default:{loadAnimation:vi.fn(()=>({destroy(){},play(){},pause(){},addEventListener(){},removeEventListener(){}}))}}))
const employee={id:'member-a',username:'employee',displayName:'员工甲',role:'member'}
const fixture={schemaVersion:2,metadata:{snapshotDate:'2026-10-29'},carriers:[{id:'line',name:'示例船司',en:'Example Line',country:'中国',type:'carrier',prefixes:['CSQU'],bl:['TEST'],page:'https://carrier.example.com/tracking',tracking:{method:'GET',urlTemplate:'https://carrier.example.com/track/{num}'}},{id:'post',name:'表单船司',en:'Form Line',country:'日本',type:'carrier',prefixes:[],bl:[],page:'https://post.example.com/',tracking:{method:'POST',urlTemplate:'https://post.example.com/tracking',fields:{container:'{num}'}}},{id:'lessor',name:'示例租箱公司',en:'Example Leasing',country:'美国',type:'leasing',prefixes:['CSQU'],bl:[],page:'https://lessor.example.com/'}],owners:[{code:'CSQU',name:'登记箱主',website:'https://owner.example.com/'}],ports:[{id:'cnsha',code:'CNSHA',name:'上海',en:'Shanghai',country:'CN',countryName:'中国',continent:'AS',continentName:'亚洲',region:'EA',regionName:'东亚',lat:31.23,lon:121.5,main:true,aliases:['CNSHG'],lanes:['asia']},{id:'uslax',code:'USLAX',codeDuplicateCount:2,name:'洛杉矶',en:'Los Angeles',country:'US',countryName:'美国',continent:'NA',continentName:'北美洲',lat:33.74,lon:-118.27,main:true,aliases:[],lanes:['america']},{id:'uslax~2',code:'USLAX',codeDuplicateCount:2,name:'洛杉矶历史记录',en:'Los Angeles legacy',country:'US',countryName:'美国',continent:'NA',continentName:'北美洲',lat:33.75,lon:-118.2,main:false,aliases:[],lanes:['america']},...Array.from({length:22},(_,index)=>({id:`cn${index}`,code:`CN${String(index).padStart(3,'0')}`,name:`中国港口${index}`,en:`China port ${index}`,country:'CN',countryName:'中国',continent:'AS',continentName:'亚洲',lat:29+index/10,lon:120+index/10,main:false,aliases:[],lanes:['asia']}))],roro:[{id:'roro',name:'示例滚装',en:'Example RoRo',country:'中国',page:'https://roro.example.com/',schedule:'https://roro.example.com/schedules',group:'query',china:true}],types:[{id:'20gp',label:'20GP 普柜',codes:['22G1'],dimensions:'20′ × 8′ × 8′6″',approximateCapacity:'约 33 m³',indicative:true}],vesselSources:[{id:'vessel',name:'船舶公开检索',urlTemplate:'https://vessel.example.com/?q={q}'}],lanes:[{id:'asia',name:'亚洲航区'},{id:'america',name:'美洲航区'}]}
function fill(label:string,value:string){fireEvent.change(screen.getByLabelText(label,{exact:true}),{target:{value}})}
function track(value:string){fill('箱号 / 提单号 / 订舱号',value);fireEvent.click(screen.getByRole('button',{name:'识别与查询'}))}
function tab(name:string){fireEvent.click(screen.getByRole('tab',{name}))}
async function select(label:string,option:string){fireEvent.click(screen.getByLabelText(label,{exact:true}));fireEvent.click(await screen.findByText(option,{selector:'.semi-select-option-text'}))}
beforeEach(()=>{
 localStorage.clear();history.replaceState(null,'','/');run.mockReset().mockImplementation(input=>executeQuery(input,fixture))
 vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}})
 vi.stubGlobal('matchMedia',vi.fn(()=>({matches:false,addEventListener(){},removeEventListener(){},addListener(){},removeListener(){}})))
 vi.stubGlobal('fetch',vi.fn());Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:vi.fn().mockResolvedValue(undefined)}})
})
afterEach(()=>{cleanup();vi.unstubAllGlobals()})

describe('independent ocean freight tools with real Semi UI and local engine',()=>{
 it('makes all five tools available to an employee without a private group or network request',()=>{
  render(<OceanFreightPage user={employee}/>);expect(screen.getAllByRole('tab')).toHaveLength(5)
  expect(screen.getByRole('heading',{name:'海运工具'})).toBeTruthy();expect(fetch).not.toHaveBeenCalled()
  expect(screen.getByText(/目录整理 2026-10-29/)).toBeTruthy()
 })
 it('renders real ISO segments and separates box owners from carrier candidates without claiming existence',()=>{
  render(<OceanFreightPage user={employee}/>);track('CSQU3054383')
  expect(screen.getByLabelText('箱号 CSQU3054383')).toBeTruthy();expect(screen.getByText('校验位')).toBeTruthy()
  expect(screen.getByText('ISO 6346 校验通过')).toBeTruthy();expect(screen.getByRole('heading',{name:'箱主 / 所有人候选'})).toBeTruthy()
  expect(screen.getByRole('heading',{name:'承运船司候选'})).toBeTruthy();expect(screen.getByText(/箱体存在、运输状态及实际承运关系尚未实时核实/)).toBeTruthy()
  expect(screen.getByRole('link',{name:/示例船司 · 打开官方追踪/}).getAttribute('href')).toBe('https://carrier.example.com/track/CSQU3054383')
  expect(fetch).not.toHaveBeenCalled()
 })
 it('shows the expected check digit for a wrong number without silently correcting user input',()=>{
  render(<OceanFreightPage user={employee}/>);track('CSQU3054384')
  expect(screen.getByRole('alert').textContent).toContain('正确校验位应为 3')
  expect(screen.getByLabelText('箱号 CSQU3054384')).toBeTruthy();expect(screen.queryByText('ISO 6346 校验通过')).toBeNull()
 })
 it('supports explicit BOL selection without misrepresenting its unrelated ISO validation as a container',async()=>{
  render(<OceanFreightPage user={employee}/>);await select('号码类型','提单号');track('TEST0000012345')
  expect(run.mock.calls.at(-1)?.[0]).toMatchObject({command:'track',kind:'bill_of_lading'})
  expect(screen.queryByText('箱号未通过校验。')).toBeNull();expect(screen.getByText('本地识别结果')).toBeTruthy();expect(screen.queryByText('箱主前缀')).toBeNull()
 })
 it('creates an official POST form only after explicit query and manual carrier selection',async()=>{
  render(<OceanFreightPage user={employee}/>);expect(document.querySelector('form[action]')).toBeNull()
  await select('指定船司（可选）','表单船司 · Form Line');track('CSQU3054383')
  const form=document.querySelector('form[action="https://post.example.com/tracking"]') as HTMLFormElement
  expect(form).toBeTruthy();expect(form.method).toBe('post');expect(form.target).toBe('_blank')
  expect((form.querySelector('input[name=container]') as HTMLInputElement).value).toBe('CSQU3054383')
  expect(within(form).getByRole('button',{name:/打开官方追踪/})).toBeTruthy();expect(fetch).not.toHaveBeenCalled()
 })
 it('caps recent history at eight, supports individual deletion and clearing, and isolates account switches',async()=>{
  for(let index=0;index<10;index++)addOceanHistory(employee.id,{query:`TEST${index}`,kind:'auto',carrierId:'',timestamp:new Date().toISOString()})
  const view=render(<OceanFreightPage user={employee}/>);expect(within(screen.getByLabelText('本账号最近查询')).getAllByRole('listitem')).toHaveLength(8)
  fireEvent.click(screen.getByRole('button',{name:'删除记录 TEST9'}));expect(loadOceanHistory(employee.id)).toHaveLength(7)
  view.rerender(<OceanFreightPage user={{...employee,id:'member-b'}}/>);expect(screen.queryByText('TEST8')).toBeNull();expect(screen.getByText('暂无最近查询。')).toBeTruthy()
  track('CSQU3054383');expect(loadOceanHistory('member-b')).toHaveLength(1);expect(loadOceanHistory(employee.id)).toHaveLength(7)
  fireEvent.click(screen.getByRole('button',{name:'清空'}));expect(localStorage.getItem(oceanHistoryKey('member-b'))).toBe('[]');expect(loadOceanHistory(employee.id)).toHaveLength(7)
 })
 it('restores and shares only our own hash route without auto-opening an external tracking page',async()=>{
  history.replaceState(null,'','/#view=ocean&tool=track&q=CSQU3054383');render(<OceanFreightPage user={employee}/>)
  expect(await screen.findByText('ISO 6346 校验通过')).toBeTruthy();expect(loadOceanHistory(employee.id)).toHaveLength(0)
  fireEvent.click(screen.getByRole('button',{name:'分享查询'}));await waitFor(()=>expect(navigator.clipboard.writeText).toHaveBeenCalled())
  const shared=vi.mocked(navigator.clipboard.writeText).mock.calls[0]?.[0]||'';expect(new URL(shared).origin).toBe(location.origin);expect(shared).toContain('#view=ocean&tool=track&q=CSQU3054383');expect(fetch).not.toHaveBeenCalled()
 })
 it('clears old tracking results when returning to an empty tab or empty shared route',()=>{
  render(<OceanFreightPage user={employee}/>);track('CSQU3054383');tab('港口码头');tab('号码追踪')
  expect(screen.queryByText('ISO 6346 校验通过')).toBeNull();expect(screen.getByRole('heading',{name:'从一个号码开始'})).toBeTruthy()
  track('CSQU3054383');history.replaceState(null,'','/#view=ocean&tool=track');fireEvent(window,new HashChangeEvent('hashchange'))
  expect(screen.queryByText('ISO 6346 校验通过')).toBeNull()
 })
 it('restores port filters from our shared route and preserves them when sharing',async()=>{
  history.replaceState(null,'','/#view=ocean&tool=ports&country=US&continent=NA&lane=america');render(<OceanFreightPage user={employee}/>)
  expect(screen.getByText('共 2 条 · 1–2')).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'分享查询'}))
  await waitFor(()=>expect(navigator.clipboard.writeText).toHaveBeenCalled());const shared=new URL(vi.mocked(navigator.clipboard.writeText).mock.calls[0][0]);const params=new URLSearchParams(shared.hash.slice(1))
  expect(params.get('country')).toBe('US');expect(params.get('continent')).toBe('NA');expect(params.get('lane')).toBe('america')
  await select('筛选国家 / 地区','全部国家 / 地区');expect(new URLSearchParams(location.hash.slice(1)).has('country')).toBe(false)
 })
 it('copies each tracking number for manual entry and offers an honest fallback when clipboard is blocked',async()=>{
  render(<OceanFreightPage user={employee}/>);track('CSQU3054383');fireEvent.click(screen.getByRole('button',{name:'复制号码 CSQU3054383'}))
  await waitFor(()=>expect(navigator.clipboard.writeText).toHaveBeenCalledWith('CSQU3054383'));expect(await screen.findByText('号码已复制。')).toBeTruthy()
  vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error('denied'));fireEvent.click(screen.getByRole('button',{name:'复制号码 CSQU3054383'}))
  expect(await screen.findByText('自动复制不可用，可从下方文本框手动复制。')).toBeTruthy();expect((screen.getByLabelText('手动复制查询内容') as HTMLInputElement).value).toBe('CSQU3054383')
 })
 it('paginates local ports and filters by alias, country and continent before opening unique-record details',async()=>{
  render(<OceanFreightPage user={employee}/>);tab('港口码头')
  expect(screen.getByText('共 25 条 · 1–20')).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'下一页'}));expect(screen.getByText('共 25 条 · 21–25')).toBeTruthy()
  fill('搜索港口','CNSHG');fireEvent.click(screen.getByRole('button',{name:'搜索'}));fireEvent.click(screen.getByRole('button',{name:/CNSHA 上海 Shanghai/}))
  expect(run.mock.calls.some(([input])=>input.command==='port'&&input.portId==='cnsha')).toBe(true)
  expect(screen.getByRole('img',{name:'上海参考坐标定位图'})).toBeTruthy();expect(screen.getByRole('link',{name:/OpenStreetMap/}).getAttribute('href')).toContain('openstreetmap.org')
  fireEvent.click(screen.getByRole('button',{name:'放大坐标视图'}));expect(screen.getByText('2×')).toBeTruthy()
  fill('搜索港口','');fireEvent.click(screen.getByRole('button',{name:'搜索'}));await select('筛选国家 / 地区','美国')
  expect(screen.getByText('共 2 条 · 1–2')).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:/USLAX 洛杉矶历史记录/}))
  expect(run.mock.calls.some(([input])=>input.command==='port'&&input.portId==='uslax~2')).toBe(true);expect(screen.getByText('同代码参考记录，请核对')).toBeTruthy();expect(screen.getByText('uslax~2')).toBeTruthy()
 })
 it('shows carrier details, roro official schedule links, vessel query sources and indicative type data',()=>{
  render(<OceanFreightPage user={employee}/>);tab('船司目录');fireEvent.click(screen.getByRole('button',{name:/示例租箱公司 Example Leasing/}))
  expect(screen.getByLabelText('船司详情')).toBeTruthy();expect(screen.queryByRole('button',{name:'使用此船司追踪'})).toBeNull()
  tab('滚装船期');expect(screen.getByRole('link',{name:/查看官方船期/}).getAttribute('href')).toBe('https://roro.example.com/schedules')
  fill('船名 / IMO / MMSI','IMO1234567');fireEvent.click(screen.getByRole('button',{name:'生成查询入口'}));expect(screen.getByRole('link',{name:/船舶公开检索/}).getAttribute('href')).toContain('q=IMO1234567')
  expect(screen.getByText(/本工具未获取实时船位/)).toBeTruthy();tab('箱型');expect(screen.getByRole('heading',{name:'20GP 普柜'})).toBeTruthy();expect(screen.getByText('约 33 m³')).toBeTruthy()
 })
 it('renders unsafe catalog labels as plain text and refuses dangerous navigation or original-site URLs',()=>{
  const ordinary=run.getMockImplementation()!;run.mockImplementation(input=>input.command==='roro'?{results:[{id:'bad',name:'<img src=x onerror=alert(1)>',page:'javascript:alert(1)',schedule:'https://sea.huodaiagent.com/roro'}],total:1,offset:0,limit:20}:ordinary(input))
  render(<OceanFreightPage user={employee}/>);tab('滚装船期');expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy()
  expect(document.querySelector('img[src=x],[onerror],a[href^="javascript:"],a[href*="huodaiagent.com"]')).toBeNull();expect(fetch).not.toHaveBeenCalled()
 })
 it('labels an owner website as equipment reference rather than shipment tracking',()=>{
  const ordinary=run.getMockImplementation()!;run.mockImplementation(input=>input.command==='track'?{results:[{kind:'container',normalized:'CSQU3054383',containerValidation:{iso6346Valid:true},trackingActions:[{method:'GET',url:'https://owner.example.com/',carrierName:'登记箱主',ownerWebsiteOnly:true,requiresManualEntry:true}]}],total:1,offset:0,limit:1}:ordinary(input))
  render(<OceanFreightPage user={employee}/>);track('CSQU3054383')
  expect(screen.getByRole('link',{name:/箱主网站 \/ 设备查询（非承运轨迹）/})).toBeTruthy();expect(screen.queryByRole('link',{name:/打开官方追踪/})).toBeNull()
 })
 it('filters geographic continent and lane categories and rejects a wildcard vessel lookup gracefully',async()=>{
  render(<OceanFreightPage user={employee}/>);tab('港口码头');await select('筛选大洲','北美洲')
  expect(screen.getByText('共 2 条 · 1–2')).toBeTruthy();await select('筛选航区 / 分类','亚洲航区');expect(screen.getByText('没有匹配的记录，请调整关键词或筛选。')).toBeTruthy()
  tab('滚装船期');fill('船名 / IMO / MMSI','*');fireEvent.click(screen.getByRole('button',{name:'生成查询入口'}))
  expect(screen.getByText('请输入具体船名、IMO 或 MMSI。')).toBeTruthy();expect(screen.getByRole('heading',{name:'船舶资料查询'})).toBeTruthy()
 })
 it('rejects access and clears the feature content immediately when the account is removed or disabled',()=>{
  const view=render(<OceanFreightPage user={employee}/>);track('CSQU3054383');view.rerender(<OceanFreightPage user={null}/>);expect(screen.queryByText('ISO 6346 校验通过')).toBeNull();expect(screen.getByText('请先登录后使用海运工具。')).toBeTruthy()
  view.rerender(<OceanFreightPage user={{...employee,disabled:true}}/>);expect(screen.queryByRole('tab')).toBeNull()
 })
})
describe('freight navigation and local persistence boundaries',()=>{
 it('allows members to navigate to the public tool while keeping every administrator page blocked',()=>{
  const store=new WorkspaceStore();store.patch({user:employee,view:'chat'});store.navigate('ocean');expect(store.state.view).toBe('ocean')
  for(const view of ['skills','schedules','channels','users','audit','events','logs'] as const){store.navigate(view);expect(store.state.view).toBe('ocean')}
  store.navigate('chat');expect(store.state.view).toBe('chat');store.dispose()
 })
 it('validates both GET and POST targets without allowing arbitrary schemes, source host or unsafe fields',()=>{
  for(const url of ['javascript:alert(1)','data:text/html,test','https://sea.huodaiagent.com/','https://sea.huodaiagent.com./','http://127.0.0.1/','https://user:pass@carrier.example.com/'])expect(safeOceanUrl(url)).toBeUndefined()
  expect(safeTrackingAction({method:'POST',url:'https://carrier.example.com/',fields:{container:'CSQU3054383'}})?.fields).toEqual({container:'CSQU3054383'})
  expect(safeTrackingAction({method:'POST',url:'https://carrier.example.com/',fields:{container:{html:'bad'}}})).toBeUndefined()
  expect(safeTrackingAction({method:'DELETE',url:'https://carrier.example.com/'})).toBeUndefined()
  expect(new URL(oceanShareUrl('ports','上海')).origin).toBe(location.origin)
 })
 it('ignores malformed or overlong history rather than importing untrusted local data into another account',()=>{
  localStorage.setItem(oceanHistoryKey(employee.id),'[{"query":"bad","timestamp":"not-a-date"}]');expect(loadOceanHistory(employee.id)).toEqual([])
  localStorage.setItem(oceanHistoryKey('another-user'),JSON.stringify([{query:'TEST-PRIVATE',kind:'auto',carrierId:'',timestamp:new Date().toISOString()}]));expect(loadOceanHistory(employee.id)).toEqual([])
 })
})
