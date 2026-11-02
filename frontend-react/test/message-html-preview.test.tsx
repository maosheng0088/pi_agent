// @vitest-environment jsdom
import {afterEach,describe,expect,it,vi} from 'vitest'
import {cleanup,fireEvent,render,screen} from '@testing-library/react'
import MessageHtmlPreview,{reportPreviewDocument} from '../src/components/MessageHtmlPreview'
vi.mock('lottie-web',()=>({default:{loadAnimation:vi.fn(()=>({destroy:vi.fn()}))}}))
afterEach(cleanup)
describe('isolated report preview',()=>{
 it('opens only on request with an opaque sandbox and keeps the original content separate',()=>{
  const original='<h1>提柜日报</h1><p>已完成8/10</p>'
  const view=render(<MessageHtmlPreview code={original}/>)
  expect(view.container.querySelector('iframe')).toBeNull()
  fireEvent.click(screen.getByRole('button',{name:'预览页面'}))
  const frame=screen.getByTitle('HTML 内容预览')
  expect(frame.getAttribute('sandbox')).toBe('')
  expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer')
  expect(frame.getAttribute('srcdoc')).toContain('已完成8/10')
  expect(frame.getAttribute('srcdoc')).toContain("script-src 'none'")
  fireEvent.click(screen.getByRole('button',{name:'收起页面预览'}))
  expect(view.container.querySelector('iframe')).toBeNull()
 })
 it('removes navigation, scripts and external resources while retaining static layout and data',()=>{
  const html='<meta http-equiv="refresh" content="0;url=https://example.com"><style>.card{color:blue}</style><h1 onclick="alert(1)">报表</h1><a href="javascript:alert(1)" target="_top">查看</a><img src="https://example.com/pixel"><script>fetch("/api/private")</script><iframe src="/api/private"></iframe><form action="/api/private"><input name="secret"></form><p>USD 1280.00</p>'
  const result=reportPreviewDocument(html),doc=new DOMParser().parseFromString(result,'text/html')
  expect(doc.querySelector('script,iframe,form,input,[href],[src],[onclick],meta[http-equiv="refresh"]')).toBeNull()
  expect(doc.querySelector('style')?.textContent).toBe('.card{color:blue}')
  expect(doc.body.textContent).toContain('USD 1280.00')
  expect(doc.head.textContent).not.toContain('/api/private')
  expect(result).toContain("connect-src 'none'")
  expect(result).toContain("frame-src 'none'")
 })
})
