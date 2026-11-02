<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { Link, MessageSquare, Plus, QrCode, RefreshCw, Settings2, Trash2, X } from '@lucide/vue'
import { api, errorMessage } from '../lib/api'
import type { Session } from '../lib/types'
import { clock } from '../lib/utils'
import { channelIdentity } from '../lib/workspace-assets'
import ChannelMark from './ChannelMark.vue'

interface Target { id: string; chatType: 'group' | 'single'; lastSeen?: string }
interface Channel { id: string; type: string; name: string; enabled: boolean; connected?: boolean; status: string; secretSet?: boolean; botId?: string; accountLabel?: string; sessionId?: string; sessionTitle?: string; lastError?: string; canReceive?: boolean; target?: Target | null }
const props = defineProps<{ sessions: Session[] }>()
const emit = defineEmits<{ toast: [message: string]; changed: [] }>()
const channels = ref<Channel[]>([]), loading = ref(false), error = ref(''), notice = ref(''), busy = ref('')
const createDialog = ref<HTMLDialogElement>(), createError = ref(''), createBusy = ref(false)
const createForm = reactive({ type: 'weixin', name: '', botId: '', secret: '' })
const renameValues = reactive<Record<string,string>>({})
const qrDialog = ref<HTMLDialogElement>(), qrChannel = ref<Channel | null>(null), loginId = ref(''), loginStatus = ref(''), loginError = ref(''), loginBusy = ref(false), verifyCode = ref(''), qrFailed = ref(false)
const wecomDialog = ref<HTMLDialogElement>(), wecomChannel = ref<Channel | null>(null), wecomError = ref(''), wecomBusy = ref(false), conversationsBusy = ref(false), conversations = ref<Target[]>([])
const wecomForm = reactive({ botId: '', secret: '', target: '' })
const bindingDialog = ref<HTMLDialogElement>(), bindingSession = ref(''), bindingIds = ref<string[]>([]), bindingError = ref(''), bindingBusy = ref(false), bindingLoading = ref(false), bindingReady = ref(false)
const deleteDialog = ref<HTMLDialogElement>(), deleteTarget = ref<Channel | null>(null), deleteBusy = ref(false), deleteError = ref('')
let alive = true, managerRequest = 0, loginRequest = 0, wecomRequest = 0, bindingRequest = 0, failures = 0
let managerTimer: ReturnType<typeof setTimeout> | undefined, loginTimer: ReturnType<typeof setTimeout> | undefined
let loginController: AbortController | undefined, conversationController: AbortController | undefined
const lifetime = new AbortController()
const statusLabels: Record<string,string> = { idle: '未登录', login_required: '需重新登录', disconnected: '未登录', unconfigured: '待配置', connecting: '待扫码', waiting: '待扫码', waiting_scan: '待扫码', wait: '待扫码', scaned: '待确认', scanned: '待确认', scaned_but_redirect: '确认处理中', binded_redirect: '确认处理中', confirmed: '已连接', connected: '已连接', paused: '已暂停', disabled: '已暂停', expired: '二维码已过期', error: '连接异常', need_verify: '待手机验证', need_verifycode: '待手机验证', verify_code_blocked: '请重新扫码', unavailable: '不可用' }
function state(channel: Channel) {
  if (!channel.enabled) return '已暂停'
  if (channel.connected) return '已连接'
  if (channel.type === 'wecom') return channel.status === 'connecting' ? '连接中' : !channel.secretSet ? '待配置' : channel.status === 'error' ? '连接异常' : '未连接'
  return statusLabels[channel.status] || '未登录'
}
const connectedCount = computed(() => channels.value.filter(c => c.connected && c.enabled).length)
const loginConnected = computed(() => ['confirmed', 'connected'].includes(loginStatus.value))
const needsVerify = computed(() => ['need_verify', 'need_verifycode'].includes(loginStatus.value))
const qrUrl = computed(() => qrChannel.value && loginId.value && !loginConnected.value && !['expired','error','verify_code_blocked'].includes(loginStatus.value) && !qrFailed.value ? `/api/admin/channels/${encodeURIComponent(qrChannel.value.id)}/logins/${encodeURIComponent(loginId.value)}/qr.svg` : '')
const loginHint = computed(() => loginConnected.value ? qrChannel.value?.canReceive === false ? '已连接。请先在微信给机器人发送一条消息，再接收智能体新消息。' : '微信已连接，可以关闭此窗口。' : needsVerify.value ? '请在手机完成验证提示，并填写验证码。' : ['scaned','scanned'].includes(loginStatus.value) ? '已扫码，请在手机上确认登录。' : ['scaned_but_redirect','binded_redirect'].includes(loginStatus.value) ? '已扫码，确认处理中，请稍候。' : loginStatus.value === 'expired' ? '二维码已过期，请刷新后重新扫描。' : loginStatus.value === 'verify_code_blocked' ? '手机验证已被限制，请刷新二维码重新扫码。' : '请使用本人微信扫码，并在手机上确认登录。')
const targetKey = (target?: Target | null) => target?.id ? JSON.stringify([target.chatType, target.id]) : ''
const targetLabel = (target: Target) => `${target.chatType === 'group' ? '群聊' : '私聊'} · ${target.id}${target.lastSeen ? ` · ${clock(target.lastSeen, true)}` : ''}`
const conflict = (channel: Channel) => Boolean(channel.sessionId && channel.sessionId !== bindingSession.value)
async function show(dialog: HTMLDialogElement | undefined) { await nextTick(); if (alive && dialog && !dialog.open) dialog.showModal() }
async function refresh(quiet = false) {
  clearTimeout(managerTimer)
  const token = ++managerRequest
  if (!quiet) { loading.value = true; error.value = '' }
  try {
    const result = await api<{channels: Channel[]}>('/api/admin/channels', { signal: lifetime.signal })
    if (!alive || token !== managerRequest) return
    channels.value = result.channels || []; notice.value = ''
    channels.value.forEach(c => { if (!(c.id in renameValues)) renameValues[c.id] = c.name })
  } catch (e) { if (alive && token === managerRequest) quiet ? notice.value = '渠道状态暂未更新，正在自动重试…' : error.value = errorMessage(e) }
  finally { if (alive && token === managerRequest) { loading.value = false; managerTimer = setTimeout(() => refresh(true), 3000) } }
}
async function openCreate() { createError.value = ''; Object.assign(createForm, { type: 'weixin', name: '', botId: '', secret: '' }); await nextTick(); await show(createDialog.value) }
async function create() {
  if (!alive || createBusy.value) return
  createBusy.value = true; createError.value = ''
  const body = { type: createForm.type, name: createForm.name.trim(), ...(createForm.type === 'wecom' ? {botId:createForm.botId.trim(),secret:createForm.secret.trim()} : {}) }
  createForm.secret = ''
  try {
    const result = await api<{channel:Channel}>('/api/admin/channels', { method: 'POST', body, signal: lifetime.signal })
    if (!alive) return
    createDialog.value?.close(); await refresh(true)
    if (!alive) return
    emit('changed'); emit('toast', '消息渠道已添加。')
    if (result.channel.type === 'wecom') await openWecom(result.channel); else await startLogin(result.channel)
  } catch (e) { if (alive) createError.value = errorMessage(e) }
  finally { createBusy.value = false }
}
async function mutate(channel: Channel, body: Record<string,unknown>, message: string) {
  if (busy.value) return
  busy.value = channel.id; error.value = ''
  try { await api(`/api/admin/channels/${encodeURIComponent(channel.id)}`, { method: 'PATCH', body, signal: lifetime.signal }); if (alive) { emit('toast', message); emit('changed'); await refresh(true) } }
  catch (e) { if (alive) error.value = errorMessage(e) }
  finally { busy.value = '' }
}
async function reconnect(channel: Channel) {
  if (busy.value) return
  busy.value = channel.id; error.value = ''
  try { await api(`/api/admin/channels/${encodeURIComponent(channel.id)}/connect`, {method:'POST',body:{},signal:lifetime.signal}); if (alive) { emit('toast','企业微信连接已发起。'); await refresh(true); emit('changed') } }
  catch (e) { if (alive) error.value = errorMessage(e) }
  finally { busy.value = '' }
}
function stopLogin() { loginRequest++; clearTimeout(loginTimer); loginController?.abort(); loginController = undefined; loginBusy.value = false; verifyCode.value = '' }
function applyLogin(result: any) {
  loginId.value = result.login?.id || loginId.value
  if (result.channel) qrChannel.value = result.channel
  loginStatus.value = result.channel?.connected ? 'connected' : result.login?.status || result.channel?.status || 'waiting'
  return !['connected','confirmed','expired','error','verify_code_blocked'].includes(loginStatus.value)
}
function schedulePoll(token: number, delay = 2000) {
  clearTimeout(loginTimer)
  loginTimer = setTimeout(async () => {
    if (!alive || token !== loginRequest || !qrChannel.value || !loginId.value || !qrDialog.value?.open) return
    loginController = new AbortController()
    try {
      const result = await api(`/api/admin/channels/${encodeURIComponent(qrChannel.value.id)}/logins/${encodeURIComponent(loginId.value)}`, {signal:loginController.signal})
      if (!alive || token !== loginRequest) return
      failures = 0; loginError.value = ''
      if (applyLogin(result)) schedulePoll(token)
      else { await refresh(true); if (alive) emit('changed') }
    } catch (e: any) {
      if (!alive || token !== loginRequest || e?.name === 'AbortError') return
      failures++
      if ((!e.status || e.status >= 500 || [408,429].includes(e.status)) && failures < 5) { loginError.value = '连接暂时中断，正在自动重试…'; schedulePoll(token, Math.min(10000, 2000 * 2 ** (failures - 1))) }
      else loginError.value = errorMessage(e)
    }
  }, delay)
}
async function startLogin(channel: Channel) {
  if (!alive) return
  stopLogin(); const token = loginRequest
  qrChannel.value = channel; loginId.value = ''; loginStatus.value = 'waiting'; loginError.value = ''; qrFailed.value = false; loginBusy.value = true; failures = 0
  await nextTick(); await show(qrDialog.value)
  if (!alive || token !== loginRequest || !qrDialog.value?.open) return
  loginController = new AbortController()
  try {
    const result = await api(`/api/admin/channels/${encodeURIComponent(channel.id)}/logins`, {method:'POST',body:{},signal:loginController.signal})
    if (!alive || token !== loginRequest) return
    if (applyLogin(result)) schedulePoll(token); else { await refresh(true); if (alive) emit('changed') }
  } catch (e) { if (alive && token === loginRequest) loginError.value = errorMessage(e) }
  finally { if (alive && token === loginRequest) loginBusy.value = false }
}
async function verify() {
  if (!qrChannel.value || !loginId.value || loginBusy.value) return
  const code = verifyCode.value.trim()
  stopLogin(); const token = loginRequest
  loginBusy.value = true; loginError.value = ''; loginController = new AbortController()
  try {
    const result = await api(`/api/admin/channels/${encodeURIComponent(qrChannel.value.id)}/logins/${encodeURIComponent(loginId.value)}`, {method:'POST',body:{verifyCode:code},signal:loginController.signal})
    if (!alive || token !== loginRequest) return
    verifyCode.value = ''; if (applyLogin(result)) schedulePoll(token); else { await refresh(true); if (alive) emit('changed') }
  } catch (e) { if (alive && token === loginRequest) loginError.value = errorMessage(e) }
  finally { if (alive && token === loginRequest) loginBusy.value = false }
}
function closeQr() { stopLogin(); qrChannel.value = null; loginId.value = ''; loginStatus.value = '' }
async function openWecom(channel: Channel) {
  if (!alive) return
  wecomRequest++; wecomChannel.value = channel; wecomError.value = ''; wecomForm.botId = channel.botId || ''; wecomForm.secret = ''; wecomForm.target = targetKey(channel.target)
  conversations.value = channel.target ? [channel.target] : []
  await nextTick(); await show(wecomDialog.value)
  if (alive && wecomDialog.value?.open) await refreshConversations()
}
async function refreshConversations() {
  if (!wecomChannel.value || wecomBusy.value) return
  const token = ++wecomRequest, channelId = wecomChannel.value.id
  conversationController?.abort(); conversationController = new AbortController(); conversationsBusy.value = true; wecomError.value = ''
  try {
    const result = await api<{conversations:Target[]}>(`/api/admin/channels/${encodeURIComponent(channelId)}/conversations`, {signal:conversationController.signal})
    if (!alive || token !== wecomRequest) return
    const previous = conversations.value.find(c => targetKey(c) === wecomForm.target)
    conversations.value = result.conversations || []
    if (previous && !conversations.value.some(c => targetKey(c) === wecomForm.target)) conversations.value.unshift(previous)
  } catch (e) { if (alive && token === wecomRequest) wecomError.value = errorMessage(e) }
  finally { if (alive && token === wecomRequest) conversationsBusy.value = false }
}
async function saveWecom() {
  if (!wecomChannel.value || wecomBusy.value) return
  wecomBusy.value = true; wecomError.value = ''; const channel = wecomChannel.value, token = ++wecomRequest
  conversationController?.abort(); conversationsBusy.value = false
  const credentialsChanged = !!wecomForm.secret.trim() || wecomForm.botId.trim() !== (channel.botId || '')
  const target = conversations.value.find(c => targetKey(c) === wecomForm.target)
  const body = {botId:wecomForm.botId.trim(), ...(wecomForm.secret.trim() ? {secret:wecomForm.secret.trim()} : {}), ...(!credentialsChanged ? { target:target ? {id:target.id,chatType:target.chatType} : null } : {})}
  wecomForm.secret = ''
  try {
    await api(`/api/admin/channels/${encodeURIComponent(channel.id)}`, {method:'PATCH',body,signal:lifetime.signal})
    if (!alive || token !== wecomRequest) return
    wecomDialog.value?.close(); emit('toast',credentialsChanged ? '凭据已更新，请重新发现并选择外部会话。' : '企业微信配置已保存。'); emit('changed'); await refresh(true)
  } catch (e) { if (alive && token === wecomRequest) wecomError.value = errorMessage(e) }
  finally { wecomBusy.value = false }
}
function closeWecom() { wecomRequest++; conversationController?.abort(); wecomForm.secret = ''; wecomChannel.value = null; conversations.value = []; conversationsBusy.value = false }
async function openBinding(channel?: Channel) {
  if (!alive) return
  bindingError.value = ''; bindingReady.value = false; bindingIds.value = []
  bindingSession.value = channel?.sessionId || props.sessions[0]?.id || ''
  await nextTick(); await show(bindingDialog.value); await loadBinding()
}
async function loadBinding() {
  if (!alive) return
  const target = bindingSession.value, token = ++bindingRequest
  bindingReady.value = false; bindingError.value = ''; bindingIds.value = []
  if (!target) return
  bindingLoading.value = true
  try {
    const result = await api(`/api/sessions/${encodeURIComponent(target)}/channels`, {signal:lifetime.signal})
    if (!alive || token !== bindingRequest) return
    if (result.canManage === false) throw new Error('仅此智能体内的管理员可以配置消息渠道。')
    bindingIds.value = (result.channels || []).map((c:Channel) => c.id); bindingReady.value = true
  } catch (e) { if (alive && token === bindingRequest) bindingError.value = errorMessage(e) }
  finally { if (alive && token === bindingRequest) bindingLoading.value = false }
}
async function saveBinding() {
  if (bindingBusy.value || !bindingReady.value || !bindingSession.value) return
  bindingBusy.value = true; bindingError.value = ''; const token = bindingRequest
  try {
    await api(`/api/sessions/${encodeURIComponent(bindingSession.value)}/channels`, {method:'PUT',body:{channelIds:[...bindingIds.value]},signal:lifetime.signal})
    if (!alive || token !== bindingRequest) return
    bindingDialog.value?.close(); emit('toast','消息渠道绑定已保存。'); emit('changed'); await refresh(true)
  } catch (e) { if (alive && token === bindingRequest) bindingError.value = errorMessage(e) }
  finally { bindingBusy.value = false }
}
async function openDelete(channel:Channel) { deleteTarget.value = channel; deleteError.value = ''; await nextTick(); await show(deleteDialog.value) }
async function remove() {
  if (!deleteTarget.value || deleteBusy.value) return
  deleteBusy.value = true; deleteError.value = ''
  try { await api(`/api/admin/channels/${encodeURIComponent(deleteTarget.value.id)}`, {method:'DELETE',body:{},signal:lifetime.signal}); if (alive) { deleteDialog.value?.close(); emit('toast','消息渠道已删除。'); emit('changed'); await refresh(true) } }
  catch (e) { if (alive) deleteError.value = errorMessage(e) }
  finally { deleteBusy.value = false }
}
watch(() => createForm.type, () => { createForm.secret = '' })
onMounted(() => refresh())
onBeforeUnmount(() => { alive = false; managerRequest++; bindingRequest++; wecomRequest++; lifetime.abort(); stopLogin(); conversationController?.abort(); clearTimeout(managerTimer); createForm.secret = ''; wecomForm.secret = ''; [createDialog,qrDialog,wecomDialog,bindingDialog,deleteDialog].forEach(d => d.value?.close()) })
</script>

<template>
  <section class="channels-page">
    <header class="page-heading"><div><span class="eyebrow">MESSAGE CHANNELS</span><h1>消息渠道</h1><p>连接个人微信与企业微信，让外部会话参与智能体协作。</p></div><div class="heading-actions"><button class="btn" :disabled="!sessions.length" @click="openBinding()"><Link :size="16" />配置绑定</button><button class="btn btn-primary" @click="openCreate"><Plus :size="16" />添加渠道</button></div></header>
    <p v-if="error" class="error-box" role="alert">{{ error }}</p>
    <div class="channel-overview"><div><span class="overview-icon"><MessageSquare :size="20" /></span><div><strong>{{ channels.length }} 个渠道</strong><p>{{ connectedCount }} 个已连接 · 每个渠道绑定一个智能体</p></div></div><button class="btn btn-ghost" :disabled="loading" @click="refresh()"><RefreshCw :size="15" />刷新状态</button></div>
    <p class="channel-notice">绑定后互通新消息，不同步历史记录。个人微信由扫码本人参与；企业微信按配置的外部会话参与。</p><p v-if="notice" class="channel-notice" role="status">{{ notice }}</p>
    <div v-if="loading && !channels.length" class="panel empty-state" role="status">正在加载消息渠道…</div><div v-else-if="!channels.length" class="panel empty-state"><MessageSquare />添加消息渠道，连接外部协作会话。</div>
    <div class="channel-grid"><article v-for="channel in channels" :key="channel.id" class="panel channel-card"><header><ChannelMark :type="channel.type" :size="44"/><div class="channel-identity"><h2>{{ channel.name }}</h2><span>{{ channel.type === 'wecom' ? '企业微信智能机器人' : channelIdentity(channel.type).label }}</span></div><span class="badge" :class="{ 'badge-green': channel.connected && channel.enabled, 'badge-blue': channel.enabled && !channel.connected }">{{ state(channel) }}</span></header><div class="channel-information"><p><span>外部会话</span><strong>{{ channel.type === 'wecom' ? (channel.target ? targetLabel(channel.target) : '待选择外部会话') : channel.accountLabel || '扫码本人参与' }}</strong></p><p><span>关联智能体</span><strong>{{ channel.sessionTitle || '尚未绑定' }}</strong></p></div><p v-if="channel.lastError" class="card-error">{{ channel.lastError }}</p><p v-if="channel.connected && channel.canReceive === false && channel.type !== 'wecom'" class="card-note">请先在微信给机器人发一条消息，再接收智能体新消息。</p><form class="rename-form" @submit.prevent="mutate(channel, {name:renameValues[channel.id]?.trim()}, '渠道名称已更新。')"><label class="sr-only" :for="`channel-name-${channel.id}`">渠道名称</label><input :id="`channel-name-${channel.id}`" v-model="renameValues[channel.id]" class="input" required maxlength="80" /><button class="btn" :disabled="!!busy || renameValues[channel.id]?.trim() === channel.name">保存名称</button></form><footer><div><button v-if="channel.type === 'wecom'" class="btn" :disabled="!!busy" @click="openWecom(channel)"><Settings2 :size="15" />配置</button><button class="btn" :disabled="!!busy || !channel.enabled" @click="channel.type === 'wecom' ? reconnect(channel) : startLogin(channel)"><QrCode v-if="channel.type !== 'wecom'" :size="15" /><RefreshCw v-else :size="15" />{{ channel.type === 'wecom' ? '重新连接' : channel.connected ? '重新扫码' : '扫码登录' }}</button></div><div><button class="btn btn-ghost" :disabled="!!busy" @click="mutate(channel, {enabled:!channel.enabled}, channel.enabled ? '渠道已暂停。' : '渠道已启用。')">{{ channel.enabled ? '暂停' : '启用' }}</button><button class="icon-btn delete-button" aria-label="删除渠道" :disabled="!!busy" @click="openDelete(channel)"><Trash2 :size="16" /></button></div></footer></article></div>

    <dialog ref="createDialog" class="modal-card native-dialog" aria-labelledby="channel-create-title" @close="createForm.secret = ''" @cancel="createBusy && $event.preventDefault()"><form @submit.prevent="create"><header class="modal-header"><div><h2 id="channel-create-title">添加消息渠道</h2><p>选择接入方式，完成连接后绑定智能体。</p></div><button type="button" class="icon-btn" aria-label="关闭添加渠道" :disabled="createBusy" @click="createDialog?.close()"><X /></button></header><p v-if="createError" class="error-box" role="alert">{{ createError }}</p><fieldset class="form-fields" :disabled="createBusy"><div class="field"><label for="channel-create-type">渠道类型</label><div class="channel-type-selector"><ChannelMark :type="createForm.type" :size="40"/><select id="channel-create-type" v-model="createForm.type" class="input"><option value="weixin">个人微信 · 扫码登录</option><option value="wecom">企业微信智能机器人 · 长连接</option></select></div></div><div class="field"><label for="channel-create-name">渠道名称</label><input id="channel-create-name" v-model="createForm.name" class="input" required maxlength="80" placeholder="例如：报价业务机器人" /></div><template v-if="createForm.type === 'wecom'"><div class="field"><label for="channel-create-bot">Bot ID</label><input id="channel-create-bot" v-model="createForm.botId" class="input" required maxlength="256" autocomplete="off" spellcheck="false" /></div><div class="field"><label for="channel-create-secret">Secret</label><input id="channel-create-secret" v-model="createForm.secret" class="input" type="password" required maxlength="1024" autocomplete="new-password" spellcheck="false" /></div><p class="channel-notice">在企业微信后台创建 API 模式、长连接方式的智能机器人，获取 Bot ID 和 Secret。无需 Webhook 回调地址。</p></template><p v-else class="channel-notice">添加后使用本人微信扫码，并在手机上确认登录。</p></fieldset><footer class="modal-footer"><button type="button" class="btn" :disabled="createBusy" @click="createDialog?.close()">取消</button><button class="btn btn-primary" :disabled="createBusy">{{ createBusy ? '正在添加…' : '添加渠道' }}</button></footer></form></dialog>

    <dialog ref="qrDialog" class="modal-card native-dialog qr-dialog" aria-labelledby="channel-qr-title" @close="closeQr"><header class="modal-header"><div class="modal-brand-heading"><ChannelMark type="weixin" :size="36"/><div><h2 id="channel-qr-title">微信扫码登录</h2><p>{{ qrChannel?.name }}</p></div></div><button type="button" class="icon-btn" aria-label="关闭微信登录" @click="qrDialog?.close()"><X /></button></header><p v-if="loginError" class="error-box" role="alert">{{ loginError }}</p><div class="qr-frame"><img v-if="qrUrl" :src="qrUrl" width="224" height="224" alt="使用本人微信扫描此二维码登录消息渠道" @error="qrFailed = true" /><span v-else>{{ loginBusy ? '正在申请二维码…' : loginConnected ? '微信已连接' : qrFailed ? '二维码加载失败，请刷新' : statusLabels[loginStatus] || '请刷新二维码' }}</span></div><p class="login-hint" role="status">{{ loginHint }}</p><form v-if="needsVerify" @submit.prevent="verify"><div class="field"><label for="channel-verify-code">手机验证码</label><input id="channel-verify-code" v-model="verifyCode" class="input" required maxlength="12" inputmode="numeric" autocomplete="one-time-code" /></div><button class="btn btn-primary" :disabled="loginBusy">{{ loginBusy ? '提交中…' : '提交验证码' }}</button></form><p class="channel-notice">需要微信支持 ClawBot 插件。当前支持文字与语音转写。</p><footer class="modal-footer"><button class="btn" :disabled="loginBusy" @click="qrChannel && startLogin(qrChannel)">刷新二维码</button><button class="btn btn-primary" @click="qrDialog?.close()">完成</button></footer></dialog>

    <dialog ref="wecomDialog" class="modal-card native-dialog" aria-labelledby="wecom-title" @close="closeWecom" @cancel="wecomBusy && $event.preventDefault()"><form @submit.prevent="saveWecom"><header class="modal-header"><div class="modal-brand-heading"><ChannelMark type="wecom" :size="36"/><div><h2 id="wecom-title">企业微信配置</h2><p>{{ wecomChannel?.name }}</p></div></div><button type="button" class="icon-btn" aria-label="关闭企业微信配置" :disabled="wecomBusy" @click="wecomDialog?.close()"><X /></button></header><p v-if="wecomError" class="error-box" role="alert">{{ wecomError }}</p><fieldset class="form-fields" :disabled="wecomBusy"><div class="field"><label for="wecom-bot-id">Bot ID</label><input id="wecom-bot-id" v-model="wecomForm.botId" class="input" required maxlength="256" autocomplete="off" spellcheck="false" /></div><div class="field"><label for="wecom-secret">Secret</label><input id="wecom-secret" v-model="wecomForm.secret" class="input" type="password" :required="!wecomChannel?.secretSet" maxlength="1024" autocomplete="new-password" spellcheck="false" :placeholder="wecomChannel?.secretSet ? '留空保留现有 Secret' : '请输入 Secret'" /><small>凭据仅保存在服务端。更新凭据会清空外部会话，请重新发现并选择。</small></div><div class="field"><div class="field-heading"><label for="wecom-target">消息互通会话</label><button type="button" class="btn btn-ghost" :disabled="conversationsBusy" @click="refreshConversations"><RefreshCw :size="14" />{{ conversationsBusy ? '刷新中…' : '刷新会话' }}</button></div><select id="wecom-target" v-model="wecomForm.target" class="input"><option value="">暂不选择</option><option v-for="target in conversations" :key="targetKey(target)" :value="targetKey(target)">{{ targetLabel(target) }}</option></select><small>先将机器人加入目标企微群并 @ 机器人发文字，或私聊机器人，再刷新选择。请按会话 ID 与最近收到时间核对。</small></div><p class="channel-notice">选择企微群后，该群所有成员可看到绑定智能体的新消息；选择私聊时，仅发送给该私聊用户。历史记录不转发。</p></fieldset><footer class="modal-footer"><button type="button" class="btn" :disabled="wecomBusy" @click="wecomDialog?.close()">取消</button><button class="btn btn-primary" :disabled="wecomBusy">{{ wecomBusy ? '保存中…' : '保存配置' }}</button></footer></form></dialog>

    <dialog ref="bindingDialog" class="modal-card native-dialog" aria-labelledby="channel-binding-title" @close="bindingRequest++; bindingReady = false" @cancel="bindingBusy && $event.preventDefault()"><form @submit.prevent="saveBinding"><header class="modal-header"><div><h2 id="channel-binding-title">智能体渠道绑定</h2><p>选择智能体，为它配置需要互通的消息渠道。</p></div><button type="button" class="icon-btn" aria-label="关闭渠道绑定" :disabled="bindingBusy" @click="bindingDialog?.close()"><X /></button></header><p v-if="bindingError" class="error-box" role="alert">{{ bindingError }}</p><div class="field"><label for="binding-session">关联智能体</label><select id="binding-session" v-model="bindingSession" class="input" :disabled="bindingBusy" required @change="loadBinding"><option value="">请选择智能体</option><option v-for="session in sessions" :key="session.id" :value="session.id">{{ session.title }}</option></select></div><p v-if="bindingLoading" class="channel-notice" role="status">正在读取绑定配置…</p><div v-else-if="bindingReady" class="binding-options"><label v-for="channel in channels" :key="channel.id" class="binding-option" :class="{ unavailable: conflict(channel) }"><input v-model="bindingIds" type="checkbox" :value="channel.id" :disabled="bindingBusy || conflict(channel)" /><ChannelMark :type="channel.type" :size="32"/><span class="binding-channel-copy"><strong>{{ channel.name }}</strong><small>{{ conflict(channel) ? `已绑定「${channel.sessionTitle || '其他智能体'}」，请先在原智能体解绑` : `${channelIdentity(channel.type).label} · ${state(channel)}` }}</small></span></label><p v-if="!channels.length" class="channel-notice">请先添加消息渠道。</p></div><p class="channel-notice">可选择多个渠道。绑定后外部会话参与者将接收此智能体的新消息。</p><footer class="modal-footer"><button type="button" class="btn" :disabled="bindingBusy" @click="bindingDialog?.close()">取消</button><button class="btn btn-primary" :disabled="bindingBusy || !bindingReady || bindingLoading">{{ bindingBusy ? '保存中…' : '保存绑定' }}</button></footer></form></dialog>

    <dialog ref="deleteDialog" class="modal-card native-dialog delete-dialog" aria-labelledby="channel-delete-title" @close="deleteTarget = null" @cancel="deleteBusy && $event.preventDefault()"><form @submit.prevent="remove"><header class="modal-header"><h2 id="channel-delete-title">删除消息渠道</h2><button type="button" class="icon-btn" aria-label="取消删除渠道" :disabled="deleteBusy" @click="deleteDialog?.close()"><X /></button></header><p v-if="deleteError" class="error-box" role="alert">{{ deleteError }}</p><p>确定删除「{{ deleteTarget?.name }}」？外部参与人将退出关联智能体，已保存的协作记录保留。</p><footer class="modal-footer"><button type="button" class="btn" :disabled="deleteBusy" @click="deleteDialog?.close()">取消</button><button class="btn btn-danger" :disabled="deleteBusy">{{ deleteBusy ? '正在删除…' : '确认删除' }}</button></footer></form></dialog>
  </section>
</template>

<style scoped>
.channels-page{max-width:1320px;margin:auto}.eyebrow{display:block;font-size:10px;letter-spacing:1.4px;color:#93a0b4;margin-bottom:8px}.heading-actions{display:flex;gap:10px}.channel-overview{display:flex;align-items:center;justify-content:space-between;background:#fff;border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:14px}.channel-overview>div{display:flex;align-items:center;gap:14px}.overview-icon{display:flex;align-items:center;justify-content:center;width:42px;height:42px;background:#edf3ff;color:#5689dc;border-radius:12px}.channel-overview strong{font-size:14px;font-weight:600}.channel-overview p{font-size:12px;color:#92a0b2;margin:6px 0 0}.channel-notice{font-size:12px!important;color:#8997aa!important;line-height:1.8!important;margin:12px 0 22px}.channel-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}.channel-card{padding:22px}.channel-card>header{display:flex;align-items:center;gap:12px}.channel-identity{flex:1;min-width:0}.channel-identity h2{font-size:14px;font-weight:600;margin:0 0 5px;overflow-wrap:anywhere}.channel-identity>span{font-size:11px;color:#9ba5b4}.channel-information{border-top:1px solid var(--border);border-bottom:1px solid var(--border);margin:20px 0;padding:7px 0}.channel-information p{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;font-size:12px;line-height:1.7;margin:12px 0}.channel-information p>span{color:#97a2b1;flex-shrink:0}.channel-information strong{font-size:12px;color:#65738b;font-weight:400;text-align:right;overflow-wrap:anywhere;min-width:0}.rename-form{display:flex;gap:9px;margin-top:16px}.rename-form input{font-size:12px}.rename-form button{font-size:12px;flex-shrink:0}.channel-card>footer{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-top:15px}.channel-card>footer>div{display:flex;align-items:center;gap:5px}.channel-card>footer .btn{font-size:12px;padding:8px 10px;min-height:35px}.delete-button:hover{color:#b85151;background:#fff3f3}.card-error{font-size:12px;color:#b56363;line-height:1.7;overflow-wrap:anywhere}.card-note{font-size:12px;color:#8b98ac;line-height:1.7}.native-dialog{margin:auto;max-width:calc(100vw - 32px);color:var(--foreground);overscroll-behavior:contain}.native-dialog::backdrop{background:#17243a55;backdrop-filter:blur(3px)}.modal-header{align-items:flex-start}.modal-header p{margin-bottom:0}.modal-header .icon-btn{flex-shrink:0}.form-fields{border:0;padding:0;margin:0;min-width:0}.qr-dialog{width:min(460px,calc(100vw - 32px))}.qr-frame{width:246px;height:246px;margin:20px auto;display:flex;align-items:center;justify-content:center;border:1px solid var(--border);border-radius:13px;padding:10px;color:#8a97aa;font-size:13px}.qr-frame img{width:224px;height:224px}.login-hint{text-align:center;line-height:1.7}.field-heading{display:flex;justify-content:space-between;align-items:center}.field-heading label{font-weight:500;color:#43516a}.field-heading .btn{font-size:11px;min-height:30px;padding:5px 7px}.binding-options{display:flex;flex-direction:column;gap:10px;max-height:340px;overflow:auto}.binding-option{display:flex;align-items:center;gap:11px;border:1px solid var(--border);border-radius:9px;padding:13px;cursor:pointer}.binding-option>input{margin:0;flex-shrink:0}.binding-option strong{font-size:12px;font-weight:500}.binding-option small{display:block;font-size:11px;color:#95a0b0;margin-top:6px;line-height:1.6}.binding-option.unavailable{background:#fafbfd;color:#9ca7b7;cursor:not-allowed}.delete-dialog{width:min(460px,calc(100vw - 32px))}.channel-type-selector{display:flex;align-items:center;gap:12px}.channel-type-selector>.input{flex:1;min-width:0}.modal-brand-heading{display:flex;align-items:center;gap:12px;min-width:0}.modal-brand-heading>div{min-width:0}.modal-brand-heading h2{margin:0}.binding-channel-copy{flex:1;min-width:0;overflow-wrap:anywhere}@media(max-width:1100px){.channel-grid{grid-template-columns:1fr}}@media(max-width:600px){.heading-actions{flex-wrap:wrap}.channel-overview{padding:16px}.channel-overview p{font-size:10px}.channel-overview .btn{padding:6px}.channel-card{padding:18px}.channel-card>header{gap:9px}.channel-information p{gap:10px}.channel-information strong{max-width:65%}.channel-overview>div{gap:10px}}
</style>
