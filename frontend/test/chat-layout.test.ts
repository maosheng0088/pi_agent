import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ChatView from '../src/components/ChatView.vue'
import { useWorkspaceStore } from '../src/stores/workspace'
import { fakeBackend, json, person } from './fixtures'

describe('Compact conversation interaction', () => {
  let wrapper: VueWrapper | undefined
  let store: ReturnType<typeof useWorkspaceStore>
  beforeEach(async () => {
    setActivePinia(createPinia())
    const backend = fakeBackend()
    backend.route(path => path.endsWith('/members') ? json({members:[person('old-id')],externalMembers:[],canRemoveMembers:false,canLeave:true}) : path.endsWith('/channels') ? json({channels:[]}) : undefined)
    store = useWorkspaceStore()
    await store.authenticate('old', 'fake-password')
  })
  afterEach(() => { wrapper?.unmount(); wrapper=undefined; store.$dispose(); vi.restoreAllMocks() })
  function render() {
    wrapper=mount(ChatView,{props:{detailsOpen:true},global:{stubs:{MembersDialog:true,HistorySearch:true,UiModal:true,DropdownMenu:true}}})
    return wrapper
  }
  it('preserves skill selection and handles IME / Shift+Enter without accidental submission',async()=>{
    const send=vi.spyOn(store,'send').mockResolvedValue(true)
    const view=render()
    await flushPromises()
    const input=view.get('#agent-prompt')
    await input.setValue('请查询业务记录')
    await view.get('select[aria-label="本次调用技能"]').setValue('alpha-skill')
    expect(store.selectedSkill).toBe('alpha-skill')
    await input.trigger('keydown',{key:'Enter',isComposing:true})
    await input.trigger('keydown',{key:'Enter',shiftKey:true})
    expect(send).not.toHaveBeenCalled()
    await input.trigger('keydown',{key:'Enter'})
    expect(send).toHaveBeenCalledExactlyOnceWith('请查询业务记录')
  })
  it('reports delivery rather than inferring execution success from model-authored text',async()=>{
    store.messages=[{role:'assistant',taskRunId:'qa-run',content:'定时任务：业务汇总\n\n示例：\n执行成功',timestamp:Date.now()}]
    const view=render()
    await flushPromises()
    expect(view.get('.detail-task').text()).toContain('业务汇总')
    expect(view.get('.task-state-label').text()).toBe('已投递')
    expect(view.findAll('.details-section-heading button').some(button=>button.text()==='管理')).toBe(false)
    expect(view.find('[aria-label="修改智能体名称"]').exists()).toBe(true)
  })
})
