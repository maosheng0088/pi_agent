<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { Search, UserPlus, UserMinus, Users, Check, ShieldCheck } from '@lucide/vue'
import UiModal from './UiModal.vue'
import UserAvatar from './UserAvatar.vue'
import { api, errorMessage } from '../lib/api'
import { tone } from '../lib/utils'
import type { MembersResponse, Session, User } from '../lib/types'
const props=defineProps<{open:boolean;session:Session;user:User}>()
const emit=defineEmits<{close:[];changed:[];toast:[message:string]}>()
const directory=ref<User[]>([]),roster=ref<MembersResponse|null>(null),query=ref(''),chosen=ref<string[]>([]),error=ref(''),loading=ref(false),saving=ref(false),removing=ref<User|null>(null)
let request=0
const candidates=computed(()=>directory.value.filter(person=>!person.disabled && `${person.displayName} ${person.username}`.toLowerCase().includes(query.value.toLowerCase())))
const existing=computed(()=>new Set(roster.value?.members.map(person=>person.id)||[]))
watch([()=>props.open,()=>props.session.id],async()=>{
  const token=++request
  error.value='';chosen.value=[];roster.value=null;directory.value=[];query.value='';removing.value=null;saving.value=false
  if(!props.open)return
  loading.value=true
  try { const [people,members]=await Promise.all([api<{users:User[]}>('/api/directory'),api<MembersResponse>(`/api/sessions/${encodeURIComponent(props.session.id)}/members`)]);if(token===request){directory.value=people.users;roster.value=members} }
  catch(e){if(token===request)error.value=errorMessage(e)}finally{if(token===request)loading.value=false}
},{immediate:true})
onBeforeUnmount(()=>{request++})
function toggle(id:string){chosen.value=chosen.value.includes(id)?chosen.value.filter(value=>value!==id):[...chosen.value,id]}
async function add(){
  if(!chosen.value.length||saving.value)return
  saving.value=true;error.value='';const token=request
  try{const result=await api<MembersResponse>(`/api/sessions/${encodeURIComponent(props.session.id)}/members`,{method:'POST',body:{userIds:chosen.value}});if(token===request){roster.value=result;chosen.value=[];emit('changed');emit('toast','协作成员已添加。')}}catch(e){if(token===request)error.value=errorMessage(e)}finally{if(token===request)saving.value=false}
}
async function remove(){
  if(!removing.value||saving.value)return
  saving.value=true;error.value='';const token=request,target=removing.value
  try{const result=await api<MembersResponse>(`/api/sessions/${encodeURIComponent(props.session.id)}/members/${encodeURIComponent(target.id)}`,{method:'DELETE',body:{}});if(token===request){roster.value=result;removing.value=null;emit('changed');emit('toast','已移除协作成员。')}}catch(e){if(token===request)error.value=errorMessage(e)}finally{if(token===request)saving.value=false}
}
</script>
<template>
  <UiModal :open="open" title="协作成员" :description="`邀请同事加入「${session.title}」，共同使用智能体并接续任务。`" wide @close="emit('close')">
    <div v-if="error" class="error-box" role="alert">{{error}}</div>
    <div v-if="loading" class="empty-state">正在加载成员…</div>
    <template v-else>
      <div class="member-section-title"><span>已加入 · {{(roster?.members.length||0)+(roster?.externalMembers?.length||0)}}</span><span><ShieldCheck :size="13"/> 仅成员可见</span></div>
      <div class="roster-list"><div v-for="person in roster?.members" :key="person.id" class="roster-row"><UserAvatar :class="['person-avatar',`tone-${tone(person.id)}`]" :name="person.displayName" :identity="person.id"/><div class="person-label"><strong>{{person.displayName}}<small v-if="person.id===user.id">我</small></strong><span>{{person.id===roster?.ownerId?'创建人':person.disabled?'已停用':person.username}}</span></div><button v-if="roster?.canRemoveMembers && person.id!==user.id && person.id!==roster?.ownerId" class="icon-btn remove-person" :aria-label="`移除成员 ${person.displayName}`" @click="removing=person"><UserMinus :size="16"/></button></div><div v-for="person in roster?.externalMembers" :key="person.id" class="roster-row"><span class="person-avatar tone-1"><Users :size="17"/></span><div class="person-label"><strong>{{person.displayName}}</strong><span>{{person.source==='wecom'?'企业微信':'个人微信'}}参与人</span></div></div></div>
      <div v-if="removing" class="remove-confirm"><span>确认移除 {{removing.displayName}}？移除后将无法查看此空间。</span><div><button class="btn btn-ghost" :disabled="saving" @click="removing=null">取消</button><button class="btn btn-danger" :disabled="saving" @click="remove">确认移除</button></div></div>
      <div class="invite-section"><div class="member-section-title"><span>邀请同事</span><span>每位成员都可以邀请</span></div><div class="member-search"><Search :size="16"/><label class="sr-only" for="member-invite-search">搜索同事姓名或账号</label><input id="member-invite-search" v-model="query" placeholder="搜索同事姓名或账号"></div><div class="directory-list"><button v-for="person in candidates" :key="person.id" class="candidate-row" :disabled="existing.has(person.id)||saving" :aria-pressed="chosen.includes(person.id)" @click="toggle(person.id)"><UserAvatar :class="['person-avatar',`tone-${tone(person.id)}`]" :name="person.displayName" :identity="person.id"/><span class="person-label"><strong>{{person.displayName}}</strong><span>{{person.username}}</span></span><span v-if="existing.has(person.id)" class="already-joined">已加入</span><span v-else :class="['check-square',{'is-checked':chosen.includes(person.id)}]"><Check v-if="chosen.includes(person.id)" :size="12"/></span></button><p v-if="!candidates.length" class="empty-state">没有匹配的同事。</p></div></div>
      <div class="modal-footer"><button class="btn" @click="emit('close')">关闭</button><button class="btn btn-primary" :disabled="!chosen.length||saving" @click="add"><UserPlus :size="16"/>{{saving?'正在添加…':`添加成员${chosen.length?`（${chosen.length}）`:''}`}}</button></div>
    </template>
  </UiModal>
</template>
<style scoped>
.member-section-title { display:flex;align-items:center;justify-content:space-between;font-size:12px;color:#526178;margin-bottom:13px;font-weight:500; }.member-section-title>span:last-child { display:flex;align-items:center;gap:4px;color:#64748b;font-size:12px;font-weight:400; }.roster-list { max-height:210px;overflow-y:auto;display:grid;grid-template-columns:1fr 1fr;gap:5px 14px; }.roster-row,.candidate-row { display:flex;align-items:center;gap:10px;padding:8px;min-width:0; }.person-avatar { width:36px;height:36px;border-radius:11px;display:grid;place-items:center;flex-shrink:0;font-size:12px; }.person-label { display:flex;flex-direction:column;gap:3px;min-width:0;text-align:left; }.person-label strong { font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }.person-label span { font-size:12px;color:#64748b; }.person-label small { font-size:10px;color:#64748b;background:#edf3ff;padding:1px 4px;border-radius:4px;margin-left:6px; }.remove-person { margin-left:auto;min-width:30px;height:30px;color:#64748b; }.remove-person:hover { color:#c03030;background:#fff0f0; }.invite-section { margin-top:15px;border-top:1px solid #edf0f6;padding-top:20px; }.member-search { display:flex;gap:9px;align-items:center;background:#f5f7fb;padding:10px 12px;border:1px solid #edf0f5;border-radius:9px;color:#64748b; }.member-search input { background:none;border:0;outline:0;font-size:12px;width:100%; }.member-search:focus-within { outline:2px solid #bdd0fa; }.directory-list { max-height:230px;overflow-y:auto;margin-top:10px; }.candidate-row { width:100%;border:0;background:white;border-radius:8px; }.candidate-row:hover:not(:disabled) { background:#f5f8ff; }.candidate-row:disabled { opacity:.6; }.already-joined { margin-left:auto;color:#64748b;font-size:12px; }.check-square { width:17px;height:17px;border-radius:5px;border:1px solid #dce2ec;display:grid;place-items:center;margin-left:auto; }.is-checked { background:#2563eb;color:white;border-color:#2563eb; }.remove-confirm { padding:13px;background:#fff6f5;border:1px solid #f5dcdc;border-radius:9px;font-size:12px;color:#a45c5c; }.remove-confirm>div { display:flex;justify-content:flex-end;gap:6px;margin-top:10px; }
@media(max-width:500px) { .roster-list { grid-template-columns:1fr; } }
</style>
