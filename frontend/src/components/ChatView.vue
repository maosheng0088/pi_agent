<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useIntervalFn, useTextareaAutosize } from '@vueuse/core'
import { ArrowDown, ArrowUp, Bot, CalendarClock, ChevronRight, CircleAlert, CircleCheck, CircleHelp, Copy, FileSearch, FileText, Layers, LockKeyhole, LogOut, MoreHorizontal, PanelRightClose, PanelRightOpen, Search, Send, ShieldCheck, Square, UserPlus, X, Pencil, MessageSquare, Cable } from '@lucide/vue'
import { useWorkspaceStore } from '../stores/workspace'
import { api, ApiError, errorMessage } from '../lib/api'
import { clock,tone } from '../lib/utils'
import type { MembersResponse,Skill } from '../lib/types'
import MessageContent from './MessageContent.vue'
import MembersDialog from './MembersDialog.vue'
import HistorySearch from './HistorySearch.vue'
import UiModal from './UiModal.vue'
import AgentAvatar from './AgentAvatar.vue'
import UserAvatar from './UserAvatar.vue'
import AvatarPicker from './AvatarPicker.vue'
import ChannelMark from './ChannelMark.vue'
import { channelIdentity, skillArtwork, uiArtwork } from '../lib/workspace-assets'
import { DropdownMenu,DropdownMenuContent,DropdownMenuItem,DropdownMenuSeparator,DropdownMenuTrigger } from './ui/dropdown-menu'
const props=defineProps<{detailsOpen:boolean}>()
const emit=defineEmits<{toggleDetails:[];openAgents:[];manageSkills:[];manageSchedules:[];manageChannels:[];settings:[]}>()
const store=useWorkspaceStore()
const scroll=ref<HTMLElement>(),roster=ref<MembersResponse|null>(null),channels=ref<any[]>([]),membersOpen=ref(false),searchOpen=ref(false),renameOpen=ref(false),leaveOpen=ref(false),name=ref(''),modalError=ref(''),busy=ref(false),memberError=ref(''),skillInfo=ref<Skill|null>(null),hasScroll=ref(false),highlight=ref<number|null>(null)
const {textarea,input:textareaInput,triggerResize}=useTextareaAutosize({input:''})
let metadataRequest=0,highlightTimer:ReturnType<typeof setTimeout>|undefined,scrollTimer:ReturnType<typeof setTimeout>|undefined
const visibleMessages=computed(()=>{
  const lastUser=store.messages.findLastIndex(item=>item.role==='user')
  return store.messages.map((item,index)=>({...item,messageIndex:index})).filter(item=>item.role==='user'||item.role==='assistant'&&item.content?.trim()&&!item.tools?.length&&!(!item.taskRunId&&store.active&&item.messageIndex>lastUser)).map((item,index,items)=>({...item,dateSeparator:messageDay(item.timestamp)!==messageDay(items[index-1]?.timestamp)?messageDay(item.timestamp):''}))
})
const participantCount=computed(()=>(roster.value?.members.length||0)+(roster.value?.externalMembers?.length||0))
const participantPreview=computed(()=>[...(roster.value?.members||[]),...(roster.value?.externalMembers||[])].slice(0,7))
const filteredSkills=computed(()=>store.skills.filter(skill=>skill.enabled!==false))
const recentTasks=computed(()=>visibleMessages.value.filter(message=>message.taskRunId).slice(-3).reverse().map(message=>{
  const lines=message.content.split(/\r?\n/).map(line=>line.trim())
  const title=lines.find(line=>/^定时任务[：:]/.test(line))?.replace(/^定时任务[：:]\s*/,'')||'任务结果'
  // A delivered message can contain quoted or model-authored status text.
  // Only delivery is known here; execution state belongs to the run record.
  return {...message,title,state:'delivered',label:'已投递'}
}))
const modeOpen=ref(false),modeChoice=ref('read-only')
const nameAvatar=ref('')
const onlineLabel=computed(()=>!store.online?'连接中断':store.active?'正在处理任务':store.status?.configured?'随时为团队服务':'等待管理员配置')
function messageDay(value?:string|number){if(!value)return '';const date=new Date(value);if(Number.isNaN(date.getTime()))return '';return date.toLocaleDateString()===new Date().toLocaleDateString()?'今天':date.toLocaleDateString('zh-CN',{year:'numeric',month:'long',day:'numeric'})}
function messageTime(value?:string|number){if(!value)return '';const date=new Date(value);return Number.isNaN(date.getTime())?'':date.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false})}
function syncDraft(){const id=store.current?.id;if(id&&store.drafts[id]!==textareaInput.value)store.drafts[id]=textareaInput.value}
watch(textareaInput,syncDraft)
watch(()=>store.current?.id,()=>{
  metadataRequest++;roster.value=null;channels.value=[];memberError.value='';membersOpen.value=false;searchOpen.value=false;renameOpen.value=false;leaveOpen.value=false;skillInfo.value=null;modeOpen.value=false;modalError.value=''
  textareaInput.value=store.current?store.drafts[store.current.id]||'':''
  nextTick(()=>{triggerResize();toBottom(true)});loadMembers()
},{immediate:true})
watch(()=>store.current&&store.drafts[store.current.id],value=>{if((value||'')!==textareaInput.value)textareaInput.value=value||''})
watch(()=>store.current?.revision,()=>loadMembers())
watch(()=>visibleMessages.value.length,()=>nextTick(()=>toBottom()))
watch(()=>store.loading,value=>{if(!value)nextTick(()=>toBottom(true))})
useIntervalFn(()=>{if(!document.hidden&&store.current&&!store.loading)loadMembers()},15000)
onBeforeUnmount(()=>{metadataRequest++;clearTimeout(highlightTimer);clearTimeout(scrollTimer)})
async function loadMembers(){
  const id=store.current?.id,token=++metadataRequest;if(!id||!store.user)return
  try{const [members,bound]=await Promise.all([api<MembersResponse>(`/api/sessions/${encodeURIComponent(id)}/members`),api<{channels:any[]}>(`/api/sessions/${encodeURIComponent(id)}/channels`)]);if(token===metadataRequest&&store.current?.id===id){roster.value=members;channels.value=bound.channels||[];memberError.value=''}}catch(e){if(token===metadataRequest&&store.current?.id===id){if(e instanceof ApiError&&e.status===404)store.forget(id);else memberError.value=errorMessage(e)}}
}
function toBottom(force=false){if(scroll.value&&(force||scroll.value.scrollHeight-scroll.value.scrollTop-scroll.value.clientHeight<220)){scroll.value.scrollTop=scroll.value.scrollHeight;hasScroll.value=false}}
function onScroll(){if(scroll.value)hasScroll.value=scroll.value.scrollHeight-scroll.value.scrollTop-scroll.value.clientHeight>220}
async function send(){const text=textareaInput.value;if(!text.trim()||store.active||store.loading)return;syncDraft();await store.send(text);nextTick(()=>{triggerResize();toBottom()})}
function keydown(event:KeyboardEvent){if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();send()}}
function rename(){name.value=store.current?.title||'';nameAvatar.value=store.current?.avatarId||'';modalError.value='';renameOpen.value=true}
function configureMode(){modeChoice.value=store.current?.mode||'read-only';modalError.value='';modeOpen.value=true}
async function saveMode(){
  const id=store.current?.id,actor=store.user?.id;if(!id||!store.isAdmin||busy.value)return;busy.value=true;modalError.value=''
  try{const result=await api(`/api/sessions/${encodeURIComponent(id)}`,{method:'PATCH',body:{mode:modeChoice.value}});if(store.current?.id===id&&store.user?.id===actor){store.applySession(result.session);modeOpen.value=false;store.toast('智能体执行权限已更新。')}}catch(e){if(store.current?.id===id&&store.user?.id===actor)modalError.value=errorMessage(e)}finally{busy.value=false}
}
async function saveName(){
  const id=store.current?.id;if(!id||!name.value.trim()||busy.value)return;busy.value=true;modalError.value=''
  try{const result=await api(`/api/sessions/${encodeURIComponent(id)}`,{method:'PATCH',body:{title:name.value.trim(),...(store.isAdmin?{avatarId:nameAvatar.value}:{})}});if(store.current?.id===id){store.applySession(result.session);renameOpen.value=false;store.toast('智能体资料已更新。')}}catch(e){if(store.current?.id===id)modalError.value=errorMessage(e)}finally{busy.value=false}
}
async function leave(){
  const id=store.current?.id;if(!id||busy.value)return;busy.value=true;modalError.value=''
  try{await api(`/api/sessions/${encodeURIComponent(id)}/leave`,{method:'POST',body:{}});store.forget(id,true);leaveOpen.value=false}catch(e){if(store.current?.id===id)modalError.value=errorMessage(e)}finally{busy.value=false}
}
async function locate(index:number){await nextTick();const el=scroll.value?.querySelector(`[data-message-index="${index}"]`);if(el){el.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'center'});highlight.value=index;clearTimeout(highlightTimer);highlightTimer=setTimeout(()=>highlight.value=null,2400)}else store.toast('消息暂未显示，请等待同步后重试。')}
async function openTaskResult(index:number){
  if(props.detailsOpen&&matchMedia('(max-width: 1050px)').matches){emit('toggleDetails');await nextTick()}
  await locate(index)
}
async function copy(text:string){try{await navigator.clipboard.writeText(text);store.toast('内容已复制。')}catch{store.toast('浏览器暂不允许复制，请手动选择消息文本。')}}
function activateSkill(skill:Skill){store.selectedSkill=store.selectedSkill===skill.id?'':skill.id;skillInfo.value=null;textarea.value?.focus()}
const starterPrompts=[{icon:FileSearch,title:'查询业务信息',description:'快速找到需要的数据',text:'请帮我查询业务信息。开始前，请先向我确认查询对象和范围。'},{icon:Layers,title:'使用专业能力',description:'了解这个智能体能做什么',text:'请介绍你在当前协作空间可以使用的技能，以及我需要提供哪些信息。'},{icon:CalendarClock,title:'推进一项任务',description:'从目标到清晰的行动',text:'请帮我推进一项业务任务。先向我确认目标、所需资料和完成标准。'}]
</script>
<template>
  <div v-if="store.current" :class="['agent-workspace',{'details-open':detailsOpen}]">
    <section class="conversation-area" aria-label="智能体协作会话">
      <header class="conversation-header">
        <button class="icon-btn mobile-agents" aria-label="打开智能体列表" @click="emit('openAgents')"><MessageSquare :size="20"/></button>
        <AgentAvatar class="header-agent-avatar" :title="store.current.title" :identity="store.current.id" :avatar-id="store.current.avatarId" :size="40"/>
        <div class="conversation-identity">
          <h1><span class="conversation-title" :title="store.current.title">{{store.current.title}}</span><span class="ai-label">AI</span></h1>
          <p><span :class="['presence-dot',{'is-busy':store.active,'is-offline':!store.online}]"></span><span class="service-label">{{onlineLabel}}</span><i></i><span class="participant-label">{{participantCount}} 位成员</span></p>
        </div>
        <div class="conversation-actions">
          <button class="icon-btn" aria-label="查找聊天记录" title="查找聊天记录" @click="searchOpen=true"><Search/></button>
          <button class="icon-btn" aria-label="协作成员" title="协作成员" @click="membersOpen=true"><UserPlus/></button>
          <button class="icon-btn" :aria-label="detailsOpen?'收起智能体资料':'展开智能体资料'" :aria-expanded="detailsOpen" title="智能体资料" @click="emit('toggleDetails')"><PanelRightClose v-if="detailsOpen"/><PanelRightOpen v-else/></button>
          <DropdownMenu><DropdownMenuTrigger as-child><button class="icon-btn" aria-label="更多智能体操作"><MoreHorizontal/></button></DropdownMenuTrigger><DropdownMenuContent align="end" class="min-w-44"><DropdownMenuItem @select="rename"><Pencil/>{{store.isAdmin?'修改名称与头像':'修改名称'}}</DropdownMenuItem><DropdownMenuItem @select="membersOpen=true"><UserPlus/>邀请协作成员</DropdownMenuItem><DropdownMenuItem @select="searchOpen=true"><Search/>查找记录</DropdownMenuItem><DropdownMenuItem v-if="store.isAdmin" :disabled="store.active" @select="configureMode"><ShieldCheck/>执行权限</DropdownMenuItem><DropdownMenuSeparator/><DropdownMenuItem :disabled="!roster?.canLeave" variant="destructive" @select="leaveOpen=true;modalError='' "><LogOut/>退出协作空间</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
        </div>
      </header>
      <div v-if="!store.online" class="chat-connection-banner" role="status">连接暂时中断，正在自动重连。<button @click="store.synchronize">重新连接</button></div>
      <div ref="scroll" class="conversation-scroll" @scroll="onScroll">
        <div v-if="store.loading" class="chat-loading"><span class="loading-dot"></span>正在加载协作记录…</div>
        <div v-else-if="!visibleMessages.length" class="agent-welcome"><div class="welcome-artwork" aria-hidden="true"><img :src="uiArtwork.reading" alt=""/><AgentAvatar class="welcome-bot" :title="store.current.title" :identity="store.current.id" :avatar-id="store.current.avatarId" :size="48"/></div><div class="welcome-label">专业智能体 · 团队协作</div><h2>你好，我是{{store.current.title}}</h2><p>描述你的问题或任务，和团队一起推进工作。</p><div v-if="filteredSkills.length" class="welcome-skills"><span v-for="skill in filteredSkills.slice(0,3)" :key="skill.id"><Layers :size="12"/>{{skill.name}}</span></div><div class="starter-grid"><button v-for="item in starterPrompts" :key="item.title" @click="textareaInput=item.text;textarea?.focus()"><component :is="item.icon" :size="20"/><strong>{{item.title}}</strong><span>{{item.description}}</span></button></div><div v-if="!store.status?.configured" class="welcome-setup"><CircleHelp :size="15"/>{{store.isAdmin?'连接模型后即可开始工作。':'请联系管理员完成模型配置。'}}<button v-if="store.isAdmin" @click="emit('settings')">去配置<ChevronRight :size="13"/></button></div><div class="welcome-privacy"><LockKeyhole :size="12"/>此空间的对话与上下文仅协作成员可见</div></div>
        <div v-else class="conversation-messages">
          <template v-for="message in visibleMessages" :key="`${store.current.id}-${message.messageIndex}`">
            <div v-if="message.dateSeparator" class="history-start"><span>{{message.dateSeparator}}</span></div>
            <article :data-message-index="message.messageIndex" :class="['chat-message',{'message-own':message.role==='user'&&message.authorId===store.user?.id,'message-ai':message.role==='assistant','message-highlight':highlight===message.messageIndex}]">
              <AgentAvatar v-if="message.role==='assistant'" class="chat-avatar" :title="store.current.title" :identity="store.current.id" :avatar-id="store.current.avatarId" :size="36"/>
              <UserAvatar v-else :class="['chat-avatar',`tone-${tone(message.authorId||message.authorName)}`]" :name="message.authorName||'成员'" :identity="message.authorUnknown?undefined:message.authorId"/>
              <div class="chat-message-body">
                <div class="chat-message-author"><strong :title="message.role==='assistant'?store.current.title:message.authorName||'历史成员'">{{message.role==='assistant'?store.current.title:message.authorName||'历史成员'}}</strong><span v-if="message.role==='assistant'" class="ai-label">AI</span><time v-if="message.timestamp" :title="clock(message.timestamp,true)">{{messageTime(message.timestamp)}}</time></div>
                <div class="chat-bubble"><span v-if="message.taskRunId" class="task-result-label"><CalendarClock :size="12"/>定时任务结果</span><MessageContent :content="message.content" :plain="message.role==='user'"/></div>
                <div v-if="message.role==='assistant'" class="chat-message-tools"><button aria-label="复制智能体回复" @click="copy(message.content)"><Copy :size="13"/>复制</button></div>
              </div>
            </article>
          </template>
          <div v-if="store.active" class="chat-message message-ai pending-message" role="status"><AgentAvatar class="chat-avatar" :title="store.current.title" :identity="store.current.id" :avatar-id="store.current.avatarId" :size="36"/><div class="chat-message-body"><div class="chat-message-author"><strong>{{store.current.title}}</strong><span class="ai-label">AI</span></div><div class="pending-bubble"><span class="typing-dots" aria-hidden="true"><i></i><i></i><i></i></span><span>{{store.stopping?'正在停止…':'正在处理，请稍候'}}</span></div></div></div>
        </div>
      </div>
      <button v-if="hasScroll" class="scroll-to-latest" @click="toBottom(true)"><ArrowDown :size="13"/>回到最新</button>
      <div class="composer-container">
        <div v-if="store.chatError" class="chat-error" role="alert"><span>{{store.chatError}}</span><button class="icon-btn" aria-label="关闭消息错误" @click="store.chatError=''"><X :size="14"/></button></div>
        <div v-if="store.active&&!store.running" class="remote-running"><span class="loading-dot"></span>{{store.current.activeUserName||'协作成员'}}已发起任务，完成后可继续提问。</div>
        <form class="chat-composer" @submit.prevent="send">
          <label class="sr-only" for="agent-prompt">发送给{{store.current.title}}的任务</label>
          <textarea id="agent-prompt" ref="textarea" v-model="textareaInput" rows="1" :readonly="store.loading" placeholder="输入任务或消息…" maxlength="100000" @keydown="keydown"></textarea>
          <div class="composer-toolbar">
            <label v-if="filteredSkills.length" class="skill-select" :class="{'skill-selected':!!store.selectedSkill}" :title="store.selectedSkill?`使用技能：${filteredSkills.find(skill=>skill.id===store.selectedSkill)?.name||'已选技能'}`:'选择本次调用技能'">
              <Layers :size="18"/><span class="sr-only">本次调用技能</span>
              <select v-model="store.selectedSkill" :disabled="store.active" aria-label="本次调用技能"><option value="">自动选择技能</option><option v-for="skill in filteredSkills" :key="skill.id" :value="skill.id">{{skill.name}}</option></select>
              <span v-if="store.selectedSkill" class="skill-selected-dot" aria-hidden="true"></span>
            </label>
            <button v-if="store.canStop" class="composer-stop" type="button" :disabled="store.stopping" @click="store.stop"><Square :size="14"/><span>{{store.stopping?'停止中':'停止'}}</span></button>
            <button v-else class="composer-send-button" type="submit" :disabled="!textareaInput.trim()||store.active||store.loading||!store.online" aria-label="发送任务"><Send :size="17"/><span>发送</span></button>
          </div>
        </form>
        <div class="composer-caption"><span><LockKeyhole :size="11"/>仅协作成员可见</span><span>Enter 发送 · Shift + Enter 换行</span></div>
      </div>
    </section>
    <aside v-if="detailsOpen" class="agent-details" aria-label="智能体资料与协作成员">
      <div class="agent-profile">
        <AgentAvatar :title="store.current.title" :identity="store.current.id" :avatar-id="store.current.avatarId" :size="42"/>
        <div class="profile-identity"><h2 :title="store.current.title">{{store.current.title}}</h2><p>{{store.current.description||'专业智能体 · 团队协作'}}</p></div>
        <div class="profile-actions"><button class="icon-btn profile-edit" :aria-label="store.isAdmin?'修改智能体名称与头像':'修改智能体名称'" :title="store.isAdmin?'修改名称与头像':'修改名称'" @click="rename"><Pencil :size="14"/></button><button class="icon-btn details-close" aria-label="关闭智能体资料" @click="emit('toggleDetails')"><X :size="16"/></button></div>
      </div>
      <section class="details-block members-block">
        <div class="details-section-heading"><h3>协作成员<span>{{participantCount}}</span></h3><button @click="membersOpen=true"><UserPlus :size="14"/>邀请 / 管理</button></div>
        <p v-if="memberError" class="metadata-error">{{memberError}}<button @click="loadMembers">重试</button></p>
        <div class="member-avatar-list">
          <button v-for="person in participantPreview" :key="person.id" class="detail-member" :title="`${person.displayName} · ${person.id===store.current.ownerId?'创建人':'协作成员'}`" @click="membersOpen=true"><UserAvatar :class="`tone-${tone(person.id)}`" :name="person.displayName" :identity="person.id" :external="'source' in person"/><small>{{person.displayName}}</small></button>
          <button class="detail-member member-add" aria-label="邀请协作成员" @click="membersOpen=true"><span><UserPlus :size="19"/></span><small>邀请同事</small></button>
        </div>
        <p class="member-rights-note"><ShieldCheck :size="12"/>每位成员都可以邀请同事加入</p>
      </section>
      <section class="details-block">
        <div class="details-section-heading"><h3>专业技能<span>{{filteredSkills.length}}</span></h3><button v-if="store.isAdmin" @click="emit('manageSkills')">配置<ChevronRight :size="13"/></button></div>
        <button v-for="skill in filteredSkills" :key="skill.id" class="detail-skill" @click="skillInfo=skill"><span class="skill-icon"><img :src="skillArtwork(skill.name,skill.avatarId)" alt="" aria-hidden="true"/></span><span><strong>{{skill.name}}</strong><small>{{skill.description||'已分配的专业能力'}}</small></span><ChevronRight :size="14"/></button>
        <p v-if="!filteredSkills.length" class="details-empty">{{store.isAdmin?'暂未分配技能，可前往技能中心配置。':'暂未分配技能，由管理员统一配置。'}}</p>
      </section>
      <section class="details-block task-results-block">
        <div class="details-section-heading"><h3>业务任务<span v-if="recentTasks.length">{{recentTasks.length}} 条近期结果</span></h3><button v-if="store.isAdmin" @click="emit('manageSchedules')">管理<ChevronRight :size="13"/></button></div>
        <button v-for="task in recentTasks" :key="task.taskRunId" class="detail-task" @click="openTaskResult(task.messageIndex)">
          <span class="task-state-icon" :class="`task-${task.state}`"><img :src="uiArtwork.calendar" alt="" aria-hidden="true"/></span>
          <span class="task-summary"><strong :title="task.title">{{task.title}}</strong><small>{{task.timestamp?clock(task.timestamp,true):'查看群内结果'}}</small></span>
          <span class="task-state-label" :class="`task-${task.state}`">{{task.label}}</span><ChevronRight :size="13"/>
        </button>
        <p v-if="!recentTasks.length" class="details-empty">暂无投递到此空间的任务结果。</p>
      </section>
      <section class="details-block">
        <div class="details-section-heading"><h3>关联渠道<span v-if="channels.length">{{channels.length}}</span></h3><button v-if="store.isAdmin" @click="emit('manageChannels')">管理<ChevronRight :size="13"/></button></div>
        <div v-for="channel in channels" :key="channel.id" class="detail-channel"><ChannelMark :type="channel.type" :size="32"/><div><strong>{{channel.name}}</strong><small>{{channelIdentity(channel.type).label}}</small></div><span class="channel-state" :class="{'channel-connected':channel.enabled!==false&&channel.connected}">{{channel.enabled===false?'已暂停':channel.connected?'已连接':'待连接'}}</span></div>
        <p v-if="!channels.length" class="details-empty">暂未绑定消息渠道。</p>
      </section>
      <div class="details-block details-shortcuts"><button class="details-shortcut" @click="searchOpen=true"><span class="shortcut-icon"><Search :size="18"/></span>查找聊天记录<ChevronRight :size="14"/></button></div>
      <div class="details-footer"><LockKeyhole :size="14"/><div><strong>仅协作成员可见</strong><p>加入后可查看此空间的历史消息。</p></div></div>
      <button v-if="roster?.canLeave" class="leave-space" @click="leaveOpen=true;modalError='' "><LogOut :size="14"/>退出协作空间</button>
    </aside>
    <UiModal v-if="store.isAdmin" :open="modeOpen" title="智能体执行权限" :description="`设置「${store.current.title}」处理业务任务时可使用的能力。`" @close="!busy&&(modeOpen=false)"><form @submit.prevent="saveMode"><div v-if="modalError" class="error-box" role="alert">{{modalError}}</div><label class="mode-choice"><input v-model="modeChoice" type="radio" value="read-only" name="agent-mode"><span><strong>仅查询与分析</strong><small>读取文件、检索内容与分析资料。</small></span></label><label class="mode-choice"><input v-model="modeChoice" type="radio" value="workspace" name="agent-mode"><span><strong>执行专业任务</strong><small>允许修改文件、运行技能脚本和本机系统命令。</small></span></label><p class="mode-explanation">技能仍受分配范围约束。此设置控制可用工具，不提供系统级隔离。定时任务使用各自配置的执行权限。</p><div class="modal-footer"><button class="btn" type="button" :disabled="busy" @click="modeOpen=false">取消</button><button class="btn btn-primary" type="submit" :disabled="busy||store.active">{{busy?'正在保存…':'保存权限'}}</button></div></form></UiModal>
    <MembersDialog v-if="store.user" :open="membersOpen" :session="store.current" :user="store.user" @close="membersOpen=false" @changed="loadMembers();store.refreshSessions()" @toast="store.toast"/>
    <HistorySearch :open="searchOpen" :session="store.current" @close="searchOpen=false" @locate="locate"/>
    <UiModal :open="renameOpen" :title="store.isAdmin?'智能体名称与头像':'修改智能体名称'" description="清晰的名称和头像，帮助团队找到合适的专业能力。" @close="!busy&&(renameOpen=false)"><form @submit.prevent="saveName"><div v-if="modalError" class="error-box" role="alert">{{modalError}}</div><div class="field"><label for="rename-agent-name">智能体名称</label><input id="rename-agent-name" v-model="name" class="input" required maxlength="120" autofocus></div><AvatarPicker v-if="store.isAdmin" v-model="nameAvatar" label="智能体头像" :disabled="busy"/><div class="modal-footer"><button class="btn" type="button" :disabled="busy" @click="renameOpen=false">取消</button><button class="btn btn-primary" :disabled="busy||!name.trim()">{{busy?'正在保存…':'保存配置'}}</button></div></form></UiModal>
    <UiModal :open="leaveOpen" title="退出协作空间" :description="`退出「${store.current.title}」后，将无法查看这里的消息与任务结果。`" @close="!busy&&(leaveOpen=false)"><div v-if="modalError" class="error-box" role="alert">{{modalError}}</div><p class="text-sm leading-7 text-slate-500">需要再次使用时，可请其他成员邀请你加入。</p><div class="modal-footer"><button class="btn" :disabled="busy" @click="leaveOpen=false">取消</button><button class="btn btn-danger" :disabled="busy" @click="leave">{{busy?'正在退出…':'确认退出'}}</button></div></UiModal>
    <UiModal :open="!!skillInfo" :title="skillInfo?.name||'专业技能'" description="当前智能体可使用的专业能力。" @close="skillInfo=null"><p class="skill-description">{{skillInfo?.description||'向智能体描述你的需求，它会结合此技能完成任务。'}}</p><div class="modal-footer"><button class="btn" @click="skillInfo=null">关闭</button><button class="btn btn-primary" :disabled="store.active" @click="skillInfo&&activateSkill(skillInfo)">使用此技能<ArrowUp :size="14"/></button></div></UiModal>
  </div>
  <section v-else class="no-agent-selected"><img class="no-agent-artwork" :src="uiArtwork.collaboration" alt="" aria-hidden="true"/><span class="welcome-label">YOUR TEAM'S AGENT WORKSPACE</span><h1>{{store.sessions.length?'选择一个专业智能体':'让专业智能体加入你的团队'}}</h1><p>{{store.sessions.length?'从左侧选择智能体，继续协作、查询信息或发起任务。':store.isAdmin?'创建专业智能体，分配技能，邀请同事一起完成业务。':'你还没有加入智能体。请联系管理员或同事邀请你。'}}</p><button class="btn mobile-agent-entry" @click="emit('openAgents')"><MessageSquare :size="16"/>查看智能体</button><div class="no-agent-note"><ShieldCheck :size="13"/>每个智能体都有自己的技能与协作空间</div></section>
</template>
<style scoped src="../styles/im-conversation.css"></style>
