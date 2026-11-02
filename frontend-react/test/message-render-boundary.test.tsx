// @vitest-environment jsdom
import {afterEach,describe,expect,it,vi} from 'vitest'
import {cleanup,render,screen} from '@testing-library/react'
import MessageText from '../src/components/MessageText'
vi.mock('lottie-web',()=>({default:{loadAnimation:vi.fn(()=>({destroy:vi.fn()}))}}))
vi.mock('react-markdown',async importOriginal=>{
 const actual=await importOriginal<any>()
 return {...actual,default:(props:any)=>{if(props.children==='无法解析的原始业务文本')throw new Error('Parser fixture failure');return <actual.default {...props}/>}}
})
const expectedError=(event:ErrorEvent)=>{if(event.error?.message==='Parser fixture failure')event.preventDefault()}
afterEach(()=>{cleanup();vi.restoreAllMocks();window.removeEventListener('error',expectedError)})
describe('message rendering recovery',()=>{
 it('keeps a renderer failure local, preserves original text, and recovers on a changed answer',()=>{
  vi.spyOn(console,'error').mockImplementation(()=>{})
  window.addEventListener('error',expectedError)
  const view=render(<MessageText content="无法解析的原始业务文本"/>)
  expect(screen.getByText('无法解析的原始业务文本')).toBeTruthy()
  view.rerender(<MessageText content="## 新回复正常显示"/>)
  expect(screen.getByRole('heading',{level:2,name:'新回复正常显示'})).toBeTruthy()
 })
})
