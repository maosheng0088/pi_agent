<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { Check, Layers, Users, Cable, ArrowRight, Search } from '@lucide/vue'
import UiModal from './UiModal.vue'
import AgentAvatar from './AgentAvatar.vue'
import AvatarPicker from './AvatarPicker.vue'
import ChannelMark from './ChannelMark.vue'
import { channelIdentity } from '../lib/workspace-assets'
import { api,errorMessage } from '../lib/api'
import type { Session,Skill,User } from '../lib/types'
const props=defineProps<{open:boolean;user:User}>()
const emit=defineEmits<{close:[];created:[id:string];toast:[text:string]}>()
const title=ref(''),skills=ref<Skill[]>([]),directory=ref<User[]>([]),channels=ref<any[]>([]),selectedSkills=ref<string[]>([]),selectedPeople=ref<string[]>([]),selectedChannels=ref<string[]>([]),query=ref(''),error=ref(''),busy=ref(false),loading=ref(false),createdId=ref('')
const avatarId=ref('')
let request=0
const globalSkills=computed(()=>skills.value.filter(skill=>skill.scope!=='groups'&&skill.enabled))
const availableSkills=computed(()=>skills.value.filter(skill=>skill.scope==='groups'&&skill.enabled))
const people=computed(()=>directory.value.filter(person=>person.id!==props.user.id&&`${person.displayName} ${person.username}`.toLowerCase().includes(query.value.toLowerCase())))
watch(()=>props.open,async open=>{
  const token=++request
  title.value='';selectedSkills.value=[];selectedPeople.value=[];selectedChannels.value=[];error.value='';query.value='';createdId.value='';skills.value=[];directory.value=[];channels.value=[]
  avatarId.value=''
  if(!open)return
  loading.value=true
  try{const [s,p,c]=await Promise.all([api<{skills:Skill[]}>('/api/skills'),api<{users:User[]}>('/api/directory'),api<{channels:any[]}>('/api/admin/channels')]);if(token===request){skills.value=s.skills||[];directory.value=p.users||[];channels.value=c.channels||[]}}catch(e){if(token===request)error.value=errorMessage(e)}finally{if(token===request)loading.value=false}
})
onBeforeUnmount(()=>{request++})
function toggle(list:'skills'|'people'|'channels',id:string){const target=list==='skills'?selectedSkills:list==='people'?selectedPeople:selectedChannels;target.value=target.value.includes(id)?target.value.filter(item=>item!==id):[...target.value,id]}
function close(){if(busy.value){emit('toast','正在保存配置，请稍候。');return}emit('close')}
async function save(){
  if(busy.value||!title.value.trim())return
  busy.value=true;error.value='';const token=request
  try{
    if(!createdId.value){const result=await api<{session:Session}>('/api/sessions',{method:'POST',body:{title:title.value.trim(),avatarId:avatarId.value,...(selectedChannels.value.length?{channelIds:selectedChannels.value}:{})}});createdId.value=result.session.id}
    const id=createdId.value
    if(selectedPeople.value.length)await api(`/api/sessions/${encodeURIComponent(id)}/members`,{method:'POST',body:{userIds:selectedPeople.value}})
    for(const skill of availableSkills.value.filter(item=>selectedSkills.value.includes(item.id)))await api(`/api/admin/skills/${encodeURIComponent(skill.id)}`,{method:'PATCH',body:{scope:'groups',groupIds:[...new Set([...(skill.groupIds||[]),id])]}})
    if(token===request){emit('created',id);emit('toast','智能体已创建，可以开始协作。');emit('close')}
  }catch(e){if(token===request)error.value=`${createdId.value?'智能体已创建，部分配置未完成。可重试完成配置，或稍后在管理页调整。\n':''}${errorMessage(e)}`}finally{if(token===request)busy.value=false}
}
</script>
<template>
  <UiModal :open="open" title="创建专业智能体" description="为一项专业工作配置技能，邀请相关同事共同协作。" wide @close="close">
    <form @submit.prevent="save">
      <div v-if="error" class="error-box whitespace-pre-wrap" role="alert">{{error}}</div>
      <div class="create-agent-identity"><AgentAvatar :title="title||'专业智能体'" :avatar-id="avatarId" :size="64"/><div class="field"><label for="create-agent-name">智能体名称</label><input id="create-agent-name" v-model="title" class="input" required maxlength="120" placeholder="例如：报价助手、提柜助手、财务助手" :disabled="busy||!!createdId" autofocus></div></div>
      <AvatarPicker v-model="avatarId" label="智能体头像" :disabled="busy||!!createdId"/>
      <div v-if="loading" class="empty-state">正在读取可用技能和成员…</div>
      <template v-else>
        <div class="create-section"><h3><Layers :size="16"/>分配专业技能<span>{{globalSkills.length+selectedSkills.length}} 项</span></h3><p>全局共享技能自动可用，也可以添加指定范围的技能。</p><div v-for="skill in globalSkills" :key="skill.id" class="skill-option shared-skill"><span class="skill-option-check"><Check :size="12"/></span><div><strong>{{skill.name}}</strong><span>{{skill.description||'团队共享能力'}}</span></div><small>全局共享</small></div><button v-for="skill in availableSkills" :key="skill.id" class="skill-option" type="button" :aria-pressed="selectedSkills.includes(skill.id)" :disabled="busy" @click="toggle('skills',skill.id)"><span :class="['skill-option-check',{'is-checked':selectedSkills.includes(skill.id)}]"><Check v-if="selectedSkills.includes(skill.id)" :size="12"/></span><div><strong>{{skill.name}}</strong><span>{{skill.description||'可分配到此智能体'}}</span></div></button><div v-if="!skills.filter(s=>s.enabled).length" class="create-empty">暂无已启用技能。创建后可在技能中心导入 ZIP 并分配。</div></div>
        <div class="create-section"><h3><Users :size="16"/>邀请协作成员<span>{{selectedPeople.length+1}} 人</span></h3><p>你将自动加入。成员可以邀请同事，加入后共享此空间的历史记录。</p><div class="create-people-search"><Search :size="14"/><label class="sr-only" for="create-agent-people">搜索员工</label><input id="create-agent-people" v-model="query" placeholder="搜索姓名或账号"></div><div class="create-people-list"><label v-for="person in people" :key="person.id"><input type="checkbox" :checked="selectedPeople.includes(person.id)" :disabled="busy" @change="toggle('people',person.id)"><span>{{person.displayName}}</span><small>{{person.username}}</small></label><div v-if="!people.length" class="create-empty">没有匹配的员工。</div></div></div>
        <div v-if="channels.length" class="create-section"><h3><Cable :size="16"/>绑定消息渠道<span>可选</span></h3><p>绑定后可在对应微信或企微渠道中接续工作。</p><label v-for="channel in channels" :key="channel.id" class="channel-option" :class="{'channel-unavailable':!!channel.sessionId}"><input type="checkbox" :checked="selectedChannels.includes(channel.id)" :disabled="busy||!!channel.sessionId" @change="toggle('channels',channel.id)"><ChannelMark :type="channel.type" :size="32"/><span class="channel-option-copy"><strong>{{channel.name}}</strong><small>{{channel.sessionId?'已绑定其他智能体':channelIdentity(channel.type).label}}</small></span></label></div>
      </template>
      <div class="modal-footer"><button class="btn" type="button" :disabled="busy" @click="close">取消</button><button class="btn btn-primary" type="submit" :disabled="busy||loading||!title.trim()">{{busy?'正在配置…':createdId?'完成配置':'创建智能体'}}<ArrowRight :size="15"/></button></div>
    </form>
  </UiModal>
</template>
<style scoped>
.create-agent-identity { display:flex;align-items:center;gap:18px; }.create-agent-identity>span { width:64px;height:64px;display:grid;place-items:center;border-radius:18px;background:#edf3ff;color:#5d85da;flex-shrink:0; }.create-agent-identity .field { flex:1;margin:0; }.create-section { margin-top:25px;padding-top:22px;border-top:1px solid #edf0f6; }.create-section h3 { display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;margin:0; }.create-section h3>svg { color:#64748b; }.create-section h3>span { margin-left:auto;font-size:12px;font-weight:400;color:#64748b; }.create-section>p { color:#64748b;font-size:12px;line-height:1.7;margin:9px 0 14px; }.skill-option { display:flex;gap:10px;align-items:center;width:100%;border:1px solid #e9edf4;background:white;border-radius:9px;padding:12px;text-align:left;margin-top:8px; }.skill-option:hover { border-color:#c3d4f8; }.skill-option>div { min-width:0; }.skill-option strong { display:block;font-size:12px;font-weight:500; }.skill-option>div>span { display:block;font-size:12px;color:#64748b;line-height:1.6;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }.skill-option small { margin-left:auto;color:#64748b;font-size:12px;white-space:nowrap; }.skill-option-check { width:17px;height:17px;border:1px solid #d8e0ed;border-radius:5px;display:grid;place-items:center;flex-shrink:0; }.shared-skill { background:#f7faff; }.shared-skill .skill-option-check,.is-checked { background:#2563eb;border-color:#2563eb;color:white; }.create-people-search { display:flex;align-items:center;gap:8px;padding:9px 10px;background:#f6f8fb;border-radius:8px;color:#64748b; }.create-people-search input { background:none;border:0;outline:0;font-size:12px;width:100%; }.create-people-search:focus-within { outline:2px solid #c2d3f6; }.create-people-list { margin-top:8px;max-height:170px;overflow-y:auto;display:grid;grid-template-columns:1fr 1fr;gap:3px 10px; }.create-people-list>label,.channel-option { display:flex;align-items:center;gap:9px;padding:10px 5px;font-size:12px;cursor:pointer; }.create-people-list small,.channel-option small { color:#64748b;font-size:12px;margin-left:auto; }.create-empty { padding:14px 0;font-size:12px;color:#64748b;line-height:1.8; }.channel-option { border-bottom:1px solid #f0f2f7; }
.channel-option { gap:11px;padding:11px 5px; }.channel-option>input { flex-shrink:0;margin:0; }.channel-option-copy { flex:1;min-width:0; }.channel-option-copy strong { display:block;font-size:13px;font-weight:500;line-height:1.6;overflow-wrap:anywhere; }.channel-option-copy small { display:block;margin:3px 0 0;font-size:12px;line-height:1.6; }.channel-unavailable { cursor:not-allowed; }.channel-unavailable .channel-option-copy strong { color:#64748b; }
@media(max-width:500px) { .create-people-list { grid-template-columns:1fr; }.create-agent-identity>span { width:45px;height:45px;border-radius:13px; }.create-agent-identity { gap:12px; } }
</style>
