// @vitest-environment jsdom
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react'
import ToolsPage from '../src/pages/ToolsPage'

vi.mock('lottie-web',()=>({default:{loadAnimation:vi.fn(()=>({destroy:vi.fn(),play:vi.fn(),pause:vi.fn(),addEventListener:vi.fn(),removeEventListener:vi.fn()}))}}))
beforeEach(()=>{
 vi.stubGlobal('matchMedia',vi.fn(()=>({matches:true,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){},dispatchEvent(){return true}})))
 vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}})
})
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals()})

describe('business tools directory',()=>{
 it('shows the existing ocean tool and its five real functions without creating an agent task',()=>{
  const open=vi.fn();render(<ToolsPage onOpenTool={open}/>)
  expect(screen.getByRole('heading',{level:1,name:'工具'})).toBeTruthy()
  expect(screen.getByRole('heading',{level:2,name:'海运工具'})).toBeTruthy()
  const capabilities=within(screen.getByRole('list',{name:'海运工具功能'}))
  expect(capabilities.getAllByRole('listitem')).toHaveLength(5)
  for(const name of ['号码追踪','港口码头','船司目录','滚装船期','箱型'])expect(capabilities.getByText(name)).toBeTruthy()
  expect(screen.getByText(/打开官方追踪与船期入口/)).toBeTruthy()
  expect(screen.getAllByRole('button',{name:'打开海运工具'})).toHaveLength(1)
  expect(open).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'打开海运工具'}));expect(open).toHaveBeenCalledExactlyOnceWith('ocean')
 })

 it('finds the tool using business terms and case-insensitive aliases without opening it automatically',()=>{
  const open=vi.fn();render(<ToolsPage onOpenTool={open}/>);const search=screen.getByRole('textbox',{name:'搜索工具'})
  for(const keyword of ['箱号','  港口  ','租箱','RoRo','ISO6346']){
   fireEvent.change(search,{target:{value:keyword}})
   expect(screen.getByRole('heading',{name:'海运工具',level:2})).toBeTruthy()
  }
  fireEvent.keyDown(search,{key:'Enter'});expect(open).not.toHaveBeenCalled()
 })

 it('shows honest search-empty feedback and restores the real directory on reset',()=>{
  const open=vi.fn();render(<ToolsPage onOpenTool={open}/>);const search=screen.getByRole('textbox',{name:'搜索工具'}) as HTMLInputElement
  expect((screen.getByRole('button',{name:'重置'}) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(search,{target:{value:'尚不存在的工具'}})
  expect(screen.getByRole('status').textContent).toContain('未找到匹配的工具')
  expect(screen.queryByRole('heading',{name:'海运工具',level:2})).toBeNull()
  expect(screen.queryByRole('button',{name:'打开海运工具'})).toBeNull()
  fireEvent.click(screen.getByRole('button',{name:'重置'}));expect(search.value).toBe('');expect(screen.getByRole('button',{name:'打开海运工具'})).toBeTruthy();expect(open).not.toHaveBeenCalled()
 })
})
