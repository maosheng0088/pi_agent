import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import AutomationView from '../src/components/AutomationView.vue'
import type { Skill } from '../src/lib/types'
import { json, session } from './fixtures'

vi.mock('../src/lib/workspace-assets', () => ({
  skillArtwork: (_name: string, avatarId?: string) => `/test-artwork/${avatarId || 'auto'}.svg`,
  uiArtwork: { business: '/test-artwork/business.svg', calendar: '/test-artwork/calendar.svg' },
}))

// Exercise the real AvatarPicker radios and AutomationView requests/state while
// avoiding native dialog positioning/focus APIs, covered by its own component.
const modal = {
  props: ['open','title','description','busy'], emits: ['close'],
  template: '<section v-if="open" class="test-modal" :data-title="title"><slot/><footer><slot name="footer"/></footer></section>',
}

describe('Skill avatar settings persist through real configuration interactions', () => {
  let view: VueWrapper | undefined
  let saved: Skill[]
  let writes: Array<{ path: string; method: string; body: Record<string, any> }>
  let listLoads: number

  beforeEach(() => {
    saved = [{id:'report',name:'业务报表',description:'真实技能说明',enabled:true,scope:'all',groupIds:[],avatarId:'portrait-03',version:1}]
    writes = []; listLoads = 0
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input), method = init?.method || 'GET'
      if (method === 'GET' && path === '/api/skills') { listLoads++; return Promise.resolve(json({skills:structuredClone(saved)})) }
      if (method === 'GET' && path.startsWith('/api/sessions?')) return Promise.resolve(json({sessions:[session('alpha')],total:1}))
      if (method === 'GET' && path === '/api/skills/report') return Promise.resolve(json({skill:{...saved[0],content:'# 报表技能',files:[]}}))
      if (method === 'PATCH' && path === '/api/admin/skills/report') {
        const body = JSON.parse(String(init?.body)); writes.push({path,method,body})
        Object.assign(saved[0]!,body)
        return Promise.resolve(json({skill:saved[0]}))
      }
      if (method === 'POST' && /^\/api\/admin\/skills\/import(?:\/report)?$/.test(path)) {
        const body = JSON.parse(String(init?.body)); writes.push({path,method,body})
        const skill = path.endsWith('/report') ? saved[0]! : {id:'new-skill',name:'新技能',version:1}
        Object.assign(skill,{avatarId:body.avatarId,enabled:body.enabled,scope:body.scope,groupIds:body.groupIds})
        if (!path.endsWith('/report')) saved.push(skill)
        return Promise.resolve(json({skill}))
      }
      return Promise.reject(new Error(`Unexpected isolated request: ${method} ${path}`))
    }))
  })
  afterEach(() => { view?.unmount(); view=undefined; vi.restoreAllMocks(); vi.unstubAllGlobals() })

  async function render() {
    view = mount(AutomationView,{props:{view:'skills',sessions:[session('alpha')]},global:{stubs:{AutomationModal:modal}}})
    await flushPromises()
    return view
  }
  async function cardAction(label: string) {
    const button = view!.get('.skill-card').findAll('button').find(item => item.text() === label)
    expect(button, `Missing skill action ${label}`).toBeTruthy()
    await button!.trigger('click'); await flushPromises()
  }
  function checked(value: string) { return (view!.get(`input[type="radio"][value="${value}"]`).element as HTMLInputElement).checked }
  async function choose(value: string) { await view!.get(`input[type="radio"][value="${value}"]`).setValue(true) }
  async function submit() { await view!.get('#skill-management-form').trigger('submit'); await flushPromises() }
  async function cancel() { await view!.get('.test-modal footer').findAll('button').find(button => button.text() === '取消')!.trigger('click'); await flushPromises() }
  async function zip(name = 'report.zip') {
    const file = new File([new Uint8Array([80,75,3,4])],name,{type:'application/zip'})
    Object.defineProperty(file,'arrayBuffer',{value:async () => new Uint8Array([80,75,3,4]).buffer})
    Object.defineProperty(view!.get('#skill-zip').element,'files',{value:[file],configurable:true})
    await view!.get('#skill-zip').trigger('change')
  }

  it('loads the persisted choice, saves it with authorization scope and reloads the displayed card and detail',async () => {
    const wrapper = await render()
    expect(wrapper.get('.skill-card .capability-icon img').attributes('src')).toBe('/test-artwork/portrait-03.svg')
    await cardAction('配置')
    expect(wrapper.get('.avatar-picker legend').text()).toBe('技能头像')
    expect(checked('portrait-03')).toBe(true)
    await choose('portrait-07')
    expect(writes).toHaveLength(0)
    await submit()
    expect(writes).toEqual([{path:'/api/admin/skills/report',method:'PATCH',body:{scope:'all',groupIds:[],avatarId:'portrait-07'}}])
    expect(listLoads).toBe(2)
    expect(wrapper.find('.test-modal').exists()).toBe(false)
    expect(wrapper.get('.skill-card .capability-icon img').attributes('src')).toBe('/test-artwork/portrait-07.svg')
    await cardAction('配置')
    expect(checked('portrait-07')).toBe(true)
    await cancel()
    await cardAction('详情')
    expect(wrapper.get('.skill-detail-identity img').attributes('src')).toBe('/test-artwork/portrait-07.svg')
  })

  it('keeps cancelled choices local and resets the next dialog to the saved choice',async () => {
    const wrapper = await render()
    await cardAction('配置'); await choose('portrait-14'); await cancel()
    expect(writes).toHaveLength(0)
    expect(saved[0]!.avatarId).toBe('portrait-03')
    expect(wrapper.get('.skill-card .capability-icon img').attributes('src')).toBe('/test-artwork/portrait-03.svg')
    await cardAction('配置')
    expect(checked('portrait-03')).toBe(true)
  })

  it('explicitly saves automatic selection as an empty string and reflects the automatic artwork',async () => {
    const wrapper = await render()
    await cardAction('配置'); await choose(''); await submit()
    expect(writes[0]!.body.avatarId).toBe('')
    expect(saved[0]!.enabled).toBe(true)
    expect(wrapper.get('.skill-card .capability-icon img').attributes('src')).toBe('/test-artwork/auto.svg')
    await cardAction('配置'); expect(checked('')).toBe(true)
  })

  it('leaves existing avatars untouched when enabling or disabling a skill',async () => {
    const wrapper = await render()
    await cardAction('停用')
    expect(writes).toEqual([{path:'/api/admin/skills/report',method:'PATCH',body:{enabled:false}}])
    expect(saved[0]!.avatarId).toBe('portrait-03')
    expect(wrapper.get('.skill-card .capability-icon img').attributes('src')).toBe('/test-artwork/portrait-03.svg')
  })

  it('includes the selected avatar in new ZIP imports and reloads the new skill artwork',async () => {
    const wrapper = await render()
    await wrapper.get('.heading-buttons').findAll('button').find(button => button.text() === '导入技能')!.trigger('click')
    await flushPromises()
    expect(checked('')).toBe(true)
    await choose('portrait-14'); await zip(); await submit()
    expect(writes).toEqual([{path:'/api/admin/skills/import',method:'POST',body:{zipBase64:'UEsDBA==',enabled:false,scope:'all',groupIds:[],avatarId:'portrait-14'}}])
    expect(wrapper.findAll('.skill-card .capability-icon img').map(image => image.attributes('src'))).toContain('/test-artwork/portrait-14.svg')
    expect(listLoads).toBe(2)
  })

  it('preserves the saved avatar when replacing a ZIP without changing its selection',async () => {
    await render(); await cardAction('更新 ZIP')
    expect(checked('portrait-03')).toBe(true)
    await zip(); await submit()
    expect(writes[0]).toMatchObject({path:'/api/admin/skills/import/report',method:'POST',body:{avatarId:'portrait-03',enabled:true}})
    expect(saved[0]!.avatarId).toBe('portrait-03')
  })

  it('continues to reject a non-ZIP file without persisting its draft avatar',async () => {
    const wrapper = await render(); await cardAction('更新 ZIP')
    await choose('portrait-01'); await zip('report.txt'); await submit()
    expect(writes).toHaveLength(0)
    expect(wrapper.get('#skill-management-form [role="alert"]').text()).toContain('ZIP')
    expect(saved[0]!.avatarId).toBe('portrait-03')
  })
})
