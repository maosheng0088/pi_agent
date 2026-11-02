<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { Download, Plus, RefreshCw, Search, ShieldCheck, Users, X } from '@lucide/vue'
import { api, errorMessage } from '../lib/api'
import type { Session, User } from '../lib/types'
import { clock } from '../lib/utils'
import UserAvatar from './UserAvatar.vue'

const props = defineProps<{ view: 'users' | 'audit' | 'events'; user: User }>()
const emit = defineEmits<{ toast: [message: string] }>()
const users = ref<User[]>([]), events = ref<any[]>([]), sessions = ref<Session[]>([])
const loading = ref(false), error = ref(''), userQuery = ref(''), eventQuery = ref('')
const filter = reactive({ userId: '', q: '', from: '', to: '' })
const total = ref(0), selected = ref<Session | null>(null), messages = ref<any[]>([]), detailLoading = ref(false)
const userDialog = ref<HTMLDialogElement>(), editUser = ref<User | null>(null), userSaving = ref(false), userError = ref('')
const userForm = reactive({ username: '', displayName: '', password: '', role: 'member' })
const busyUser = ref(''), alive = ref(true)
let request = 0, detailRequest = 0, auditQuery = ''
const lifetime = new AbortController()
const titles = { users: ['协作成员', '管理业务空间的登录账户与访问状态。'], audit: ['会话审计', '按创建人、关键词与日期查阅智能体协作记录。'], events: ['操作记录', '追踪业务空间中的账户、配置与任务操作。'] }
const title = computed(() => titles[props.view])
const filteredUsers = computed(() => users.value.filter(u => `${u.displayName} ${u.username}`.toLowerCase().includes(userQuery.value.toLowerCase())))
const filteredEvents = computed(() => events.value.filter(e => JSON.stringify(e).toLowerCase().includes(eventQuery.value.toLowerCase())))
const activeCount = computed(() => users.value.filter(u => !u.disabled).length)
const actionLabels: Record<string, string> = {
  'workspace.setup': '初始化业务空间', 'auth.login': '登录', 'auth.login_failed': '登录失败', 'auth.logout': '退出登录',
  'auth.password_changed': '修改密码', 'user.created': '创建协作成员', 'user.updated': '更新成员账户',
  'config.viewed': '查看空间配置', 'config.updated': '更新空间配置', 'session.created': '创建智能体',
  'session.mode_changed': '切换执行权限', 'session.exported': '导出协作记录', 'admin.sessions_listed': '查询会话审计',
  'admin.session_viewed': '查看会话详情', 'skill.created': '创建技能', 'skill.updated': '更新技能', 'skill.deleted': '删除技能',
  'schedule.created': '创建定时任务', 'schedule.updated': '更新定时任务', 'schedule.deleted': '删除定时任务',
  'schedule.run_requested': '请求运行任务', 'schedule.run_started': '开始运行任务', 'schedule.run_finished': '任务运行结束',
  'channel.created': '创建消息渠道', 'channel.updated': '更新消息渠道', 'channel.deleted': '删除消息渠道', 'channel.bound': '更新渠道绑定',
}
const actor = (e: any) => e.actorName || e.displayName || e.username || e.actor?.displayName || e.userName || '系统'
const normalizeUsers = (items: User[] = []) => items.map(user => ({ ...user, disabled: Boolean(user.disabled) }))
function textContent(value: any): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(v => v.text || (v.type === 'image' ? '[图片]' : v.type === 'toolCall' ? `[工具调用：${v.name}]` : '')).filter(Boolean).join('\n')
  return value ? JSON.stringify(value, null, 2) : ''
}
function safeDetails(value: any) { return typeof value === 'string' ? value : JSON.stringify(value, null, 2) }
async function load(append = false) {
  const token = ++request
  loading.value = true; error.value = ''
  try {
    if (props.view === 'users') {
      const result = await api<{ users: User[] }>('/api/admin/users', { signal: lifetime.signal })
      if (alive.value && token === request) users.value = normalizeUsers(result.users)
    } else if (props.view === 'events') {
      const result = await api('/api/admin/audit?limit=200', { signal: lifetime.signal })
      if (alive.value && token === request) events.value = result.events || []
    } else {
      if (filter.from && filter.to && filter.from > filter.to) throw new Error('开始日期不能晚于结束日期。')
      if (!append) {
        const query = new URLSearchParams()
        Object.entries(filter).forEach(([key, value]) => { if (value.trim()) query.set(key, value.trim()) })
        auditQuery = query.toString()
      }
      const params = new URLSearchParams(auditQuery)
      params.set('limit', '100'); params.set('offset', String(append ? sessions.value.length : 0))
      const result = await api(`/api/admin/sessions?${params}`, { signal: lifetime.signal })
      if (!alive.value || token !== request) return
      sessions.value = append ? [...sessions.value, ...(result.sessions || [])] : result.sessions || []
      total.value = result.total ?? sessions.value.length
      if (!append) { detailRequest++; selected.value = null; messages.value = []; detailLoading.value = false }
    }
  } catch (e) { if (alive.value && token === request) error.value = errorMessage(e) }
  finally { if (alive.value && token === request) loading.value = false }
}
async function openAudit(session: Session) {
  const token = ++detailRequest
  selected.value = session; messages.value = []; detailLoading.value = true; error.value = ''
  try {
    const result = await api(`/api/admin/sessions/${encodeURIComponent(session.id)}`, { signal: lifetime.signal })
    if (!alive.value || token !== detailRequest) return
    selected.value = result.session; messages.value = result.messages || []
  } catch (e) { if (alive.value && token === detailRequest) error.value = errorMessage(e) }
  finally { if (alive.value && token === detailRequest) detailLoading.value = false }
}
async function openUser(user: User | null = null) {
  if (!alive.value || userSaving.value) return
  editUser.value = user; userError.value = ''
  Object.assign(userForm, { username: '', displayName: '', password: '', role: 'member' })
  await nextTick(); if (alive.value && !userDialog.value?.open) userDialog.value?.showModal()
}
function closeUser() { if (!userSaving.value) userDialog.value?.close() }
async function saveUser() {
  if (userSaving.value) return
  userSaving.value = true; userError.value = ''
  const editing = editUser.value
  const body = editing ? { password: userForm.password } : { ...userForm, username: userForm.username.trim(), displayName: userForm.displayName.trim() }
  userForm.password = ''
  try {
    await api(editing ? `/api/admin/users/${encodeURIComponent(editing.id)}` : '/api/admin/users', { method: editing ? 'PATCH' : 'POST', body, signal: lifetime.signal })
    if (!alive.value) return
    userDialog.value?.close(); emit('toast', editing ? '密码已重置，请告知账户本人。' : '协作成员已创建。'); await load()
  } catch (e) { if (alive.value) userError.value = errorMessage(e) }
  finally { userSaving.value = false }
}
async function toggleUser(user: User) {
  if (busyUser.value || user.id === props.user.id) return
  busyUser.value = user.id; error.value = ''
  try {
    await api(`/api/admin/users/${encodeURIComponent(user.id)}`, { method: 'PATCH', body: { disabled: !user.disabled }, signal: lifetime.signal })
    if (!alive.value) return
    emit('toast', user.disabled ? '账户已启用。' : '账户已停用。'); await load()
  } catch (e) { if (alive.value) error.value = errorMessage(e) }
  finally { busyUser.value = '' }
}
watch(() => props.view, async () => {
  request++; detailRequest++; selected.value = null; messages.value = []; error.value = ''; sessions.value = []
  userDialog.value?.close(); userForm.password = ''
  if (props.view === 'audit') {
    try { const r = await api('/api/admin/users', { signal: lifetime.signal }); if (alive.value) users.value = normalizeUsers(r.users) }
    catch (e) { if (alive.value) error.value = errorMessage(e) }
  }
  if (alive.value) await load()
}, { immediate: true })
onBeforeUnmount(() => { alive.value = false; request++; detailRequest++; lifetime.abort(); userForm.password = ''; userDialog.value?.close() })
</script>

<template>
  <section class="admin-page">
    <header class="page-heading"><div><span class="eyebrow">WORKSPACE MANAGEMENT</span><h1>{{ title[0] }}</h1><p>{{ title[1] }}</p></div><button v-if="view === 'users'" class="btn btn-primary" @click="openUser()"><Plus :size="16" />添加成员</button><button v-else class="btn" :disabled="loading" @click="load()"><RefreshCw :size="16" />刷新</button></header>
    <p v-if="error" class="error-box" role="alert">{{ error }}</p>

    <template v-if="view === 'users'">
      <div class="summary-grid"><article class="panel summary-card"><Users :size="20" /><div><strong>{{ users.length }}</strong><span>全部协作成员</span></div></article><article class="panel summary-card"><span class="status-dot"></span><div><strong>{{ activeCount }}</strong><span>可登录账户</span></div></article><article class="panel summary-card"><ShieldCheck :size="20" /><div><strong>{{ users.filter(u => u.role === 'admin').length }}</strong><span>业务空间管理员</span></div></article></div>
      <div class="panel member-panel"><div class="panel-toolbar"><h2>成员目录 <span>{{ filteredUsers.length }}</span></h2><label class="search-field"><Search :size="16" /><input v-model="userQuery" placeholder="搜索姓名或账号" aria-label="搜索协作成员" /></label></div><div class="table-scroll"><table class="data-table"><thead><tr><th>姓名 / 账号</th><th>角色</th><th>账户状态</th><th>创建时间</th><th>操作</th></tr></thead><tbody><tr v-for="member in filteredUsers" :key="member.id"><td><div class="member-name"><UserAvatar class="avatar" :name="member.displayName || member.username" :identity="member.id"/><div><strong>{{ member.displayName || member.username }} <span v-if="member.id === user.id" class="badge badge-blue">你</span></strong><small>{{ member.username }}</small></div></div></td><td><span class="badge" :class="{ 'badge-blue': member.role === 'admin' }">{{ member.role === 'admin' ? '管理员' : '协作成员' }}</span></td><td><span class="account-state" :class="{ disabled: member.disabled }"><i></i>{{ member.disabled ? '已停用' : '可登录' }}</span></td><td class="muted">{{ clock(member.createdAt, true) }}</td><td><div class="row-actions"><button class="btn btn-ghost" @click="openUser(member)">重置密码</button><button class="btn btn-ghost" :class="{ 'text-danger': !member.disabled }" :disabled="member.id === user.id || !!busyUser" :title="member.id === user.id ? '不能停用当前登录账户' : ''" @click="toggleUser(member)">{{ member.disabled ? '启用' : '停用' }}</button></div></td></tr></tbody></table></div><div v-if="loading" class="empty-state" role="status">正在加载成员…</div><div v-else-if="!filteredUsers.length" class="empty-state">没有找到符合条件的成员。</div></div>
    </template>

    <template v-else-if="view === 'audit'">
      <form class="panel filter-form" @submit.prevent="load()"><div class="field"><label for="audit-user">创建人</label><select id="audit-user" v-model="filter.userId" class="input"><option value="">所有创建人</option><option v-for="member in users" :key="member.id" :value="member.id">{{ member.displayName || member.username }}{{ member.disabled ? '（已停用）' : '' }}</option></select></div><div class="field filter-query"><label for="audit-q">关键词</label><input id="audit-q" v-model="filter.q" class="input" placeholder="搜索智能体及协作记录" /></div><div class="field"><label for="audit-from">开始日期</label><input id="audit-from" v-model="filter.from" class="input" type="date" /></div><div class="field"><label for="audit-to">结束日期</label><input id="audit-to" v-model="filter.to" class="input" type="date" /></div><button class="btn btn-primary" :disabled="loading"><Search :size="16" />{{ loading ? '查询中…' : '查询' }}</button></form>
      <div class="panel audit-layout"><aside class="audit-sidebar"><div class="audit-list-title">智能体协作记录 <span>{{ total }}</span></div><button v-for="session in sessions" :key="session.id" class="audit-item" :class="{ selected: selected?.id === session.id }" @click="openAudit(session)"><strong>{{ session.title || '智能体' }}</strong><span>{{ session.legacyUnknownOwner ? '历史创建人未记录' : (session.createdByName || session.ownerName || '创建人未记录') }}</span><small>{{ clock(session.updatedAt || session.createdAt, true) }} · {{ session.messageCount || 0 }} 条消息</small></button><div v-if="!sessions.length" class="empty-state">{{ loading ? '正在查询…' : '没有符合条件的记录' }}</div><button v-if="sessions.length < total" class="btn more-button" :disabled="loading" @click="load(true)">加载更多（{{ sessions.length }} / {{ total }}）</button></aside><div class="audit-detail"><header v-if="selected" class="audit-detail-header"><div><strong>{{ selected.title }}</strong><small>仅供管理员查阅</small></div><a class="btn" :href="`/api/admin/sessions/${encodeURIComponent(selected.id)}/export`" :download="`pi-session-${selected.id}.json`"><Download :size="16" />导出记录</a></header><div class="audit-transcript"><div v-if="detailLoading" class="empty-state" role="status">正在加载完整记录…</div><template v-else-if="selected"><article v-for="(message, i) in messages" :key="i" class="audit-message"><div class="message-meta"><strong>{{ message.authorName || (message.role === 'assistant' ? 'Pi 智能体' : message.role === 'toolResult' ? '工具结果' : '历史发言人未记录') }}</strong><time>{{ clock(message.timestamp, true) }}</time></div><div class="message-content">{{ textContent(message.content) }}</div><details v-if="message.tools?.length || message.role === 'toolResult'" class="technical-details"><summary>执行详情</summary><pre>{{ safeDetails(message.tools || message) }}</pre></details></article><div v-if="!messages.length" class="empty-state">此智能体尚无协作消息。</div></template><div v-else class="empty-state"><Search :size="30" />选择左侧记录，查看完整协作会话。</div></div></div></div>
    </template>

    <div v-else class="panel events-panel"><div class="panel-toolbar"><h2>最近操作 <span>{{ events.length }}</span></h2><label class="search-field"><Search :size="16" /><input v-model="eventQuery" placeholder="搜索操作、人员" aria-label="搜索操作记录" /></label></div><div v-if="loading" class="empty-state" role="status">正在加载操作记录…</div><div v-else-if="!filteredEvents.length" class="empty-state">暂无符合条件的操作记录。</div><article v-for="(event, i) in filteredEvents" :key="event.id || i" class="event-row"><span class="event-icon"><ShieldCheck :size="17" /></span><div class="event-body"><strong>{{ actionLabels[event.action] || event.action }}</strong><p>{{ actor(event) }}</p><details v-if="event.details || event.detail || event.targetId"><summary>查看详情</summary><pre>{{ safeDetails(event.details || event.detail || { targetId: event.targetId }) }}</pre></details></div><time>{{ clock(event.at || event.timestamp || event.createdAt, true) }}</time></article><p class="event-limit">显示最近最多 200 条操作记录。</p></div>

    <dialog ref="userDialog" class="modal-card native-dialog" aria-labelledby="member-dialog-title" @close="userForm.password = ''" @cancel="userSaving && $event.preventDefault()"><form @submit.prevent="saveUser"><header class="modal-header"><div><h2 id="member-dialog-title">{{ editUser ? '重置成员密码' : '添加协作成员' }}</h2><p>{{ editUser ? `为 ${editUser.displayName || editUser.username} 设置新的登录密码。` : '创建账户后，可将成员邀请至相应智能体。' }}</p></div><button type="button" class="icon-btn" :disabled="userSaving" aria-label="关闭成员设置" @click="closeUser"><X /></button></header><p v-if="userError" class="error-box" role="alert">{{ userError }}</p><template v-if="!editUser"><div class="field"><label for="member-name">姓名</label><input id="member-name" v-model="userForm.displayName" class="input" required maxlength="80" autocomplete="off" /></div><div class="field"><label for="member-username">登录账号</label><input id="member-username" v-model="userForm.username" class="input" required minlength="3" maxlength="48" pattern="[a-zA-Z0-9][a-zA-Z0-9_.\-]{2,47}" autocomplete="off" spellcheck="false" /></div><div class="field"><label for="member-role">账户角色</label><select id="member-role" v-model="userForm.role" class="input"><option value="member">协作成员</option><option value="admin">管理员</option></select></div></template><div class="field"><label for="member-password">{{ editUser ? '新密码' : '初始密码' }}</label><input id="member-password" v-model="userForm.password" class="input" type="password" required minlength="8" maxlength="128" autocomplete="new-password" /><small>8–128 个字符，保存后请通过可信渠道告知本人。</small></div><footer class="modal-footer"><button type="button" class="btn" :disabled="userSaving" @click="closeUser">取消</button><button class="btn btn-primary" :disabled="userSaving">{{ userSaving ? '正在保存…' : editUser ? '重置密码' : '创建账户' }}</button></footer></form></dialog>
  </section>
</template>

<style scoped>
.admin-page{max-width:1480px;margin:auto}.eyebrow{display:block;font-size:10px;letter-spacing:1.4px;color:#93a0b4;margin-bottom:8px}.summary-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px;margin-bottom:24px}.summary-card{display:flex;align-items:center;gap:18px;color:#7597cc}.summary-card strong{display:block;color:#263650;font-size:27px;font-weight:650}.summary-card span{display:block;color:#8591a3;font-size:12px;margin-top:4px}.summary-card .status-dot{width:14px;height:14px;background:#24a886;border:4px solid #e4f6ee;border-radius:50%;box-sizing:content-box}.member-panel,.events-panel{padding:0;overflow:hidden}.panel-toolbar{display:flex;justify-content:space-between;align-items:center;padding:20px 22px;gap:15px}.panel-toolbar h2{font-size:14px;font-weight:600;margin:0}.panel-toolbar h2 span,.audit-list-title span{color:#95a0af;margin-left:7px;font-weight:400}.search-field{display:flex;align-items:center;gap:10px;border:1px solid var(--border);border-radius:8px;padding:9px 12px;color:#95a0af}.search-field input{border:0;outline:0;font-size:12px;width:190px;background:transparent}.table-scroll{overflow:auto}.member-name{display:flex;align-items:center;gap:11px;min-width:160px}.avatar{display:flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:11px;background:#eef3fc;color:#6686b4;font-weight:600;flex-shrink:0}.member-name strong{font-size:13px;font-weight:500}.member-name small{display:block;font-size:11px;color:#8995a7;margin-top:4px}.account-state{display:flex;align-items:center;gap:6px;color:#378a70;white-space:nowrap}.account-state i{width:5px;height:5px;background:currentColor;border-radius:50%}.account-state.disabled{color:#a0a7b1}.muted{color:#8793a5;font-size:12px;white-space:nowrap}.row-actions{display:flex;gap:0}.row-actions .btn{min-height:32px;padding:6px 8px;font-size:12px}.text-danger{color:#bd5656}.filter-form{display:flex;align-items:flex-end;gap:14px;margin-bottom:20px;flex-wrap:wrap;padding:18px}.filter-form .field{margin:0;min-width:150px}.filter-form .filter-query{flex:1}.audit-layout{display:grid;grid-template-columns:300px minmax(0,1fr);padding:0;overflow:hidden;min-height:520px}.audit-sidebar{border-right:1px solid var(--border);max-height:70vh;overflow:auto}.audit-list-title{font-size:12px;padding:18px 16px;border-bottom:1px solid var(--border)}.audit-item{display:flex;flex-direction:column;gap:8px;width:100%;border:0;border-bottom:1px solid var(--border);background:white;padding:17px 16px;text-align:left}.audit-item:hover{background:#f8faff}.audit-item.selected{background:#edf3ff;box-shadow:inset 3px 0 #2563eb}.audit-item strong{font-size:13px;font-weight:600}.audit-item span{font-size:12px;color:#7f8ca1}.audit-item small{font-size:10px;color:#99a3b2}.audit-detail{min-width:0}.audit-detail-header{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:16px 22px;border-bottom:1px solid var(--border)}.audit-detail-header strong{font-size:14px}.audit-detail-header small{display:block;margin-top:6px;font-size:11px;color:#8f9bac}.audit-transcript{padding:10px 22px;max-height:65vh;overflow:auto}.audit-message{padding:18px 0;border-bottom:1px solid var(--border)}.message-meta{display:flex;justify-content:space-between;gap:12px;font-size:12px}.message-meta time{font-size:10px;color:#9ba6b5}.message-content{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.8;font-size:13px;margin-top:10px;color:#4f5e73}details{margin-top:10px;font-size:12px;color:#8a97a9}summary{cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px;line-height:1.7;background:#f6f8fc;padding:12px;border-radius:8px;max-height:320px;overflow:auto}.more-button{margin:14px;max-width:calc(100% - 28px)}.event-row{display:flex;align-items:flex-start;gap:14px;padding:20px 24px;border-top:1px solid var(--border)}.event-icon{display:flex;align-items:center;justify-content:center;width:34px;height:34px;background:#f0f5fc;border-radius:10px;color:#6d8dbd;flex-shrink:0}.event-body{flex:1;min-width:0}.event-body strong{font-size:13px;font-weight:500}.event-body p{font-size:12px;color:#8c98ab;margin:7px 0 0}.event-row>time{font-size:11px;color:#96a1b2;white-space:nowrap}.event-limit{text-align:center;font-size:11px;color:#99a4b5;padding:10px}.native-dialog{margin:auto;max-width:calc(100vw - 32px);color:var(--foreground);overscroll-behavior:contain}.native-dialog::backdrop{background:#17243a55;backdrop-filter:blur(3px)}.modal-header{align-items:flex-start}.modal-header p{margin-bottom:0}.modal-header .icon-btn{flex-shrink:0}
@media(max-width:1000px){.summary-grid{gap:12px}.audit-layout{grid-template-columns:240px minmax(0,1fr)}.filter-form .field{flex:1}}@media(max-width:760px){.summary-grid{grid-template-columns:1fr}.summary-card{padding:14px 18px}.summary-card strong{font-size:23px}.panel-toolbar{align-items:flex-start;flex-direction:column}.search-field,.search-field input{width:100%}.audit-layout{grid-template-columns:1fr}.audit-sidebar{max-height:260px;border-right:0;border-bottom:1px solid var(--border)}.audit-transcript{max-height:60vh}.event-row{padding:16px;gap:10px}.event-row>time{white-space:normal;width:75px;line-height:1.6}.filter-form .field{min-width:calc(50% - 14px)}}
</style>
