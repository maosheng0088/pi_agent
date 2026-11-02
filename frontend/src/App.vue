<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onMounted, ref, watch } from 'vue'
import { useEventListener, useIntervalFn, useMediaQuery } from '@vueuse/core'
import { ArrowLeft, Bot, Building2, CalendarClock, Cable, Check, ChevronDown, ChevronRight, Layers, LogOut, MessageSquare, Plus, Search, Settings2, ShieldCheck, Users, X, List, KeyRound } from '@lucide/vue'
import { useWorkspaceStore } from './stores/workspace'
import { api,errorMessage } from './lib/api'
import { clock,tone } from './lib/utils'
import type { Session,View } from './lib/types'
import { conversationPreview } from './lib/conversation-preview'
import AuthView from './components/AuthView.vue'
import ChatView from './components/ChatView.vue'
import AgentAvatar from './components/AgentAvatar.vue'
import UserAvatar from './components/UserAvatar.vue'
import CreateAgentDialog from './components/CreateAgentDialog.vue'
import UiModal from './components/UiModal.vue'
import { Button } from './components/ui/button'
import { DropdownMenu,DropdownMenuContent,DropdownMenuItem,DropdownMenuLabel,DropdownMenuSeparator,DropdownMenuTrigger } from './components/ui/dropdown-menu'
const AutomationView=defineAsyncComponent(()=>import('./components/AutomationView.vue'))
const AdministrationView=defineAsyncComponent(()=>import('./components/AdministrationView.vue'))
const ChannelsView=defineAsyncComponent(()=>import('./components/ChannelsView.vue'))
const SettingsDialog=defineAsyncComponent(()=>import('./components/SettingsDialog.vue'))
const store=useWorkspaceStore()
const query=ref(''),listFilter=ref<'all'|'running'>('all'),createOpen=ref(false),settingsOpen=ref(false),passwordOpen=ref(false),passwordBusy=ref(false),passwordError=ref(''),currentPassword=ref(''),newPassword=ref(''),confirmPassword=ref(''),mobileList=ref(false)
const wideScreen=useMediaQuery('(min-width: 1180px)'),detailsOpen=ref(window.innerWidth>=1180)
function runningFor(agent:Session){return agent.id===store.current?.id?store.active:!!agent.running}
const listedAgents=computed(()=>store.sessions.filter(agent=>(listFilter.value!=='running'||runningFor(agent))&&agent.title.toLowerCase().includes(query.value.trim().toLowerCase())))
const activeCount=computed(()=>store.sessions.filter(runningFor).length)
const previewCache=ref<Record<string,{text:string;revision?:number}>>({})
const currentPreview=computed(()=>store.loading?'':conversationPreview(store.messages,store.active))
watch(()=>store.user?.id,()=>{previewCache.value={}},{flush:'sync'})
watch([()=>store.current?.id,currentPreview],([id,text])=>{if(id&&text&&store.user)previewCache.value[id]={text,revision:store.current?.revision}})
watch(()=>store.sessions,agents=>{const permitted=new Set(agents.map(agent=>agent.id));for(const id of Object.keys(previewCache.value))if(!permitted.has(id))delete previewCache.value[id]},{flush:'sync'})
function agentPreview(agent:Session){
  const draft=store.drafts[agent.id]?.trim();if(draft)return '草稿：'+draft.replace(/\s+/g,' ')
  if(runningFor(agent))return ((agent.id===store.current?.id?store.current?.activeUserName:agent.activeUserName)||'成员')+'发起的任务正在处理…'
  if(agent.id===store.current?.id&&currentPreview.value)return currentPreview.value
  const cached=previewCache.value[agent.id];if(cached&&cached.revision===agent.revision)return cached.text
  return agent.messageCount?'打开查看最近的协作消息':'描述任务，开始与团队协作'
}
const adminView=computed(() => store.view==='users'||store.view==='audit'||store.view==='events'?store.view:'users')
const pageNames:Record<View,string>={chat:'智能体',skills:'技能中心',schedules:'定时任务',channels:'消息渠道',users:'成员管理',audit:'聊天审计',events:'操作记录'}
const navItems=[{view:'chat',label:'智能体',icon:MessageSquare},{view:'skills',label:'技能中心',icon:Layers},{view:'schedules',label:'定时任务',icon:CalendarClock},{view:'channels',label:'消息渠道',icon:Cable},{view:'users',label:'团队',icon:Users}] as const
onMounted(()=>store.initialize())
useEventListener(window,'pi:auth-expired',()=>store.expire())
useEventListener(document,'visibilitychange',()=>{if(!document.hidden)store.synchronize()})
useEventListener(window,'online',()=>store.synchronize())
useIntervalFn(()=>store.synchronize(),2500)
useEventListener(window,'keydown',(event:KeyboardEvent)=>{if(event.key==='Escape')mobileList.value=false;if((event.ctrlKey||event.metaKey)&&event.key==='k'&&store.user){event.preventDefault();focusAgents()}})
watch(wideScreen,value=>detailsOpen.value=value)
watch(()=>store.user?.id,()=>{createOpen.value=false;settingsOpen.value=false;passwordOpen.value=false;mobileList.value=false;query.value='';listFilter.value='all';currentPassword.value='';newPassword.value='';confirmPassword.value='';passwordError.value=''})
watch(passwordOpen,()=>{currentPassword.value='';newPassword.value='';confirmPassword.value='';passwordError.value=''})
function navigate(view:View){store.navigate(view);mobileList.value=false}
async function focusAgents(){
  store.navigate('chat')
  if(store.view!=='chat')return
  mobileList.value=window.innerWidth<=800
  await nextTick()
  document.getElementById('agent-list-search')?.focus()
}
async function openAgent(id:string,skillId?:string){await store.select(id);if(skillId&&store.skills.some(skill=>skill.id===skillId))store.selectedSkill=skillId;mobileList.value=false}
async function created(id:string){await store.refreshSessions();await openAgent(id)}
async function refreshContext(){const owner=store.user?.id;if(!owner)return;try{const result=await api('/api/status');if(store.user?.id===owner){store.status=result;await store.refreshSessions();if(store.current&&!store.running){const available=await api(`/api/sessions/${encodeURIComponent(store.current.id)}/skills`);if(store.user?.id===owner)store.skills=available.skills||[]}}}catch(e){if(store.user?.id===owner)store.toast(errorMessage(e))}}
async function changePassword(){
  if(passwordBusy.value)return
  if(newPassword.value!==confirmPassword.value){passwordError.value='两次输入的新密码不一致。';return}
  const owner=store.user?.id;passwordBusy.value=true;passwordError.value=''
  try{await api('/api/auth/password',{method:'POST',body:{currentPassword:currentPassword.value,newPassword:newPassword.value}});if(store.user?.id===owner){passwordOpen.value=false;store.toast('密码已修改。')}}catch(e){if(store.user?.id===owner)passwordError.value=errorMessage(e)}finally{currentPassword.value='';newPassword.value='';confirmPassword.value='';passwordBusy.value=false}
}
</script>
<template>
  <AuthView v-if="!store.user"/>
  <div v-else class="im-canvas"><div :class="['workspace-shell',{'mobile-list-open':mobileList,'management-view':store.view!=='chat'}]">
    <a class="skip-link" href="#agent-prompt">跳到消息输入框</a>
    <header class="workspace-topbar">
      <button class="workspace-brand" aria-label="Pi 智能体工作台首页" @click="navigate('chat')"><span class="brand-symbol" aria-hidden="true">π</span><span>Pi Workspace</span></button>
      <nav class="top-navigation" aria-label="工作台导航">
        <template v-for="item in navItems" :key="item.view">
          <button v-if="item.view==='chat'||store.isAdmin" :class="['top-nav-item',{'is-active':store.view===item.view}]" :aria-current="store.view===item.view?'page':undefined" @click="navigate(item.view)"><component :is="item.icon" :size="17" aria-hidden="true"/><span>{{item.label}}</span></button>
        </template>
      </nav>
      <div class="topbar-actions">
        <button class="topbar-search icon-btn" aria-label="搜索智能体" title="搜索智能体（Ctrl+K）" @click="focusAgents"><Search :size="20"/></button>
        <DropdownMenu v-if="store.isAdmin"><DropdownMenuTrigger as-child><button :class="['icon-btn topbar-settings',{'is-active':store.view==='audit'||store.view==='events'}]" aria-label="管理与设置" title="管理与设置"><Settings2 :size="20"/></button></DropdownMenuTrigger><DropdownMenuContent align="end" class="min-w-48"><DropdownMenuLabel class="text-xs text-slate-500">管理员工作台</DropdownMenuLabel><DropdownMenuItem @select="settingsOpen=true"><Settings2/>模型与系统设置</DropdownMenuItem><DropdownMenuItem @select="navigate('audit')"><ShieldCheck/>聊天审计</DropdownMenuItem><DropdownMenuItem @select="navigate('events')"><List/>操作记录</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
        <DropdownMenu><DropdownMenuTrigger as-child><button class="account-menu" :aria-label="`${store.user.displayName}，账号菜单`"><UserAvatar :class="['account-avatar',`tone-${tone(store.user.id)}`]" :name="store.user.displayName" :identity="store.user.id"/><span class="account-name">{{store.user.displayName}}</span><ChevronDown :size="14" aria-hidden="true"/></button></DropdownMenuTrigger><DropdownMenuContent align="end" class="min-w-48"><DropdownMenuLabel><div class="text-sm font-medium">{{store.user.displayName}}</div><div class="mt-1 text-xs font-normal text-slate-500">{{store.user.username}} · {{store.isAdmin?'管理员':'协作成员'}}</div></DropdownMenuLabel><DropdownMenuSeparator/><DropdownMenuItem @select="passwordOpen=true"><KeyRound/>修改密码</DropdownMenuItem><DropdownMenuItem @select="store.logout"><LogOut/>退出登录</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
      </div>
    </header>
    <button v-if="mobileList" class="agent-list-backdrop" aria-label="关闭智能体列表" @click="mobileList=false"></button>
    <aside class="agent-list-panel" aria-label="我的智能体">
      <header class="agent-list-heading"><h1>智能体</h1><Button v-if="store.isAdmin" variant="ghost" size="icon" class="create-agent-button" aria-label="创建智能体" title="创建智能体" :disabled="store.running" @click="createOpen=true"><Plus :size="21"/></Button><button class="icon-btn mobile-list-close" aria-label="关闭智能体列表" @click="mobileList=false"><X :size="18"/></button></header>
      <div class="agent-list-search"><Search :size="16" aria-hidden="true"/><label class="sr-only" for="agent-list-search">搜索智能体</label><input id="agent-list-search" v-model="query" type="search" placeholder="搜索智能体" autocomplete="off"></div>
      <div class="agent-list-tabs" role="group" aria-label="筛选智能体"><button :class="{'is-selected':listFilter==='all'}" :aria-pressed="listFilter==='all'" @click="listFilter='all'">全部</button><button :class="{'is-selected':listFilter==='running'}" :aria-pressed="listFilter==='running'" @click="listFilter='running'">处理中<span v-if="activeCount">{{activeCount}}</span></button></div>
      <nav class="agents-scroll" aria-label="已加入的智能体">
        <button v-for="agent in listedAgents" :key="agent.id" :class="['agent-list-item',{'agent-selected':agent.id===store.current?.id&&store.view==='chat'}]" :aria-current="agent.id===store.current?.id&&store.view==='chat'?'page':undefined" @click="openAgent(agent.id)">
          <AgentAvatar :title="agent.title" :identity="agent.id" :avatar-id="agent.avatarId" :size="42"/>
          <span class="agent-list-item-content"><span class="agent-list-name"><strong>{{agent.title}}</strong><time :title="`最近更新 ${clock(agent.updatedAt,true)}`">{{clock(agent.updatedAt)}}</time></span><span :class="['agent-list-description',{'has-draft':!!store.drafts[agent.id]?.trim(),'is-processing':runningFor(agent)}]">{{agentPreview(agent)}}</span></span>
        </button>
        <div v-if="!listedAgents.length" class="list-empty"><Bot :size="28"/><strong>{{query?'没有匹配的智能体':listFilter==='running'?'暂无处理中的任务':'还没有加入智能体'}}</strong><p>{{query?'试试其他名称。':store.isAdmin?'创建智能体，分配专业能力。':'请管理员或同事邀请你加入。'}}</p><button v-if="store.isAdmin&&!query&&listFilter==='all'" class="btn btn-primary" @click="createOpen=true"><Plus :size="15"/>创建智能体</button></div>
      </nav>
      <footer class="agent-list-footer"><Building2 :size="19" aria-hidden="true"/><div><strong>{{store.workspace?.name||'公司共享空间'}}</strong><span v-if="!store.online" class="connection-pending">正在重新连接…</span></div><span :class="['workspace-connection',{'offline':!store.online}]" :title="store.online?'工作空间已连接':'正在重新连接'" role="img" :aria-label="store.online?'工作空间已连接':'正在重新连接'"></span></footer>
    </aside>
    <main class="workspace-main">
      <ChatView v-if="store.view==='chat'" :details-open="detailsOpen" @toggle-details="detailsOpen=!detailsOpen" @open-agents="mobileList=true" @manage-skills="navigate('skills')" @manage-schedules="navigate('schedules')" @manage-channels="navigate('channels')" @settings="settingsOpen=true"/>
      <template v-else-if="store.isAdmin"><header class="management-topbar"><button class="management-back" @click="navigate('chat')"><ArrowLeft :size="15"/>返回智能体</button><span class="management-breadcrumb">工作台<ChevronRight :size="12"/><strong>{{pageNames[store.view]}}</strong></span><span class="management-role"><ShieldCheck :size="12"/>管理员</span></header><div class="management-content"><AutomationView v-if="store.view==='skills'||store.view==='schedules'" :view="store.view" :sessions="store.sessions" :current-session-id="store.current?.id" @toast="store.toast" @changed="refreshContext" @open-session="openAgent"/><ChannelsView v-else-if="store.view==='channels'" :sessions="store.sessions" @toast="store.toast" @changed="refreshContext"/><AdministrationView v-else :view="adminView" :user="store.user" @toast="store.toast"/></div></template>
    </main>
    <CreateAgentDialog v-if="store.isAdmin" :open="createOpen" :user="store.user" @close="createOpen=false" @created="created" @toast="store.toast"/>
    <SettingsDialog v-if="store.isAdmin" :open="settingsOpen" @close="settingsOpen=false" @saved="settingsOpen=false;refreshContext()" @toast="store.toast"/>
    <UiModal :open="passwordOpen" title="修改登录密码" description="密码更新后，其他设备上的登录将失效。" @close="!passwordBusy&&(passwordOpen=false)"><form @submit.prevent="changePassword"><div v-if="passwordError" class="error-box" role="alert">{{passwordError}}</div><div class="field"><label for="my-current-password">当前密码</label><input id="my-current-password" v-model="currentPassword" class="input" type="password" required autocomplete="current-password" maxlength="128"></div><div class="field"><label for="my-new-password">新密码</label><input id="my-new-password" v-model="newPassword" class="input" type="password" required minlength="8" maxlength="128" autocomplete="new-password"></div><div class="field"><label for="my-confirm-password">确认新密码</label><input id="my-confirm-password" v-model="confirmPassword" class="input" type="password" required minlength="8" maxlength="128" autocomplete="new-password"></div><div class="modal-footer"><button class="btn" type="button" :disabled="passwordBusy" @click="passwordOpen=false">取消</button><button class="btn btn-primary" :disabled="passwordBusy">{{passwordBusy?'正在保存…':'更新密码'}}</button></div></form></UiModal>
    <Transition name="toast"><div v-if="store.toastText" class="global-toast" role="status"><Check :size="15"/>{{store.toastText}}</div></Transition>
  </div></div>
</template>
<style scoped src="./styles/im-shell.css"></style>
