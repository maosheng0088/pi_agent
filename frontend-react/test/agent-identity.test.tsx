// @vitest-environment jsdom
import {afterEach,describe,expect,it,vi} from 'vitest'
import {cleanup,render} from '@testing-library/react'
import {agentIdentities,agentIdentity} from '../src/lib/agent-identity'
import {avatarSource} from '../src/lib/avatar-catalog'
import AgentAvatar from '../src/components/AgentAvatar'
vi.mock('lottie-web',()=>({default:{loadAnimation:vi.fn(()=>({destroy(){},play(){},pause(){},addEventListener(){},removeEventListener(){}}))}}))

afterEach(cleanup)
describe('business identity for automatic agent avatars',()=>{
 it('distinguishes the actual business agents instead of mapping all of them to a generic bot',()=>{
  expect(agentIdentity('PO 重复检查助手')).toBe('po')
  expect(agentIdentity('Amazon UnitCount 数量检查')).toBe('unit')
  expect(agentIdentity('海运业务查询助手')).toBe('ocean')
  expect(agentIdentity('业务报价助手')).toBe('quote')
  expect(agentIdentity('提柜预报助手')).toBe('pickup')
  expect(agentIdentity('pierpass-terminal-sync')).toBe('sync')
 })
 it('prioritizes specific business purpose over broad task and customer words',()=>{
  expect(agentIdentity('客户报价定时任务')).toBe('quote')
  expect(agentIdentity('UnitCount 预约检查')).toBe('unit')
  expect(agentIdentity('财务对账数据同步')).toBe('finance')
  expect(agentIdentity('客服助手')).toBe('support')
  expect(agentIdentity('新的智能体')).toBe('assistant')
 })
 it('preserves explicitly configured portraits when names or business categories change',()=>{
  const view=render(<AgentAvatar title="报价助手" avatarId="portrait-04"/>)
  expect(view.container.querySelector('img')?.getAttribute('src')).toBe(avatarSource('portrait-04'))
  expect(view.container.querySelector('[data-agent-category="custom"]')).toBeTruthy()
  view.rerender(<AgentAvatar title="PO 重复检查助手" avatarId="portrait-04"/>)
  expect(view.container.querySelector('img')?.getAttribute('src')).toBe(avatarSource('portrait-04'))
 })
 it('uses bundled business artwork at different display sizes and safely falls back for an invalid custom ID',()=>{
  const view=render(<AgentAvatar title="海运助手" avatarId="https://example.com/avatar.png" size={46}/>)
  expect(view.container.querySelector('img')?.getAttribute('src')).toBe(agentIdentities.ocean.src)
  expect(view.container.querySelector<HTMLElement>('.agent-avatar')?.style.width).toBe('46px')
 })
})
