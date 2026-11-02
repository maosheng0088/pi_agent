<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { Eye, EyeOff, FolderOpen, Settings2, ShieldCheck, X } from '@lucide/vue'
import { api, errorMessage } from '../lib/api'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: []; saved: []; toast: [message: string] }>()
const dialog = ref<HTMLDialogElement>(), loading = ref(false), ready = ref(false), saving = ref(false), error = ref(''), keyVisible = ref(false)
const config = reactive({ provider: 'custom', model: '', baseUrl: '', cwd: '', mode: 'read-only', systemPrompt: '', apiKeySet: false })
const apiKey = ref(''), models = ref<Array<{id: string;name?:string}>>([]), remoteProviders = ref<Array<{id:string;name?:string}>>([])
const providerNames: Record<string,string> = { custom: 'OpenAI 兼容接口', openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google', deepseek: 'DeepSeek', openrouter: 'OpenRouter', 'minimax-cn': 'MiniMax 中国' }
const providers = computed(() => [...new Set([...Object.keys(providerNames), config.provider, ...remoteProviders.value.map(p => p.id)])].filter(Boolean).map(id => ({ id, name: remoteProviders.value.find(p => p.id === id)?.name || providerNames[id] || id })))
let version = 0, modelVersion = 0, alive = true
let controller: AbortController | undefined, modelController: AbortController | undefined
function close() { if (!saving.value) emit('close') }
function clearSensitive() { apiKey.value = ''; keyVisible.value = false }
async function loadModels() {
  const token = ++modelVersion
  modelController?.abort(); modelController = new AbortController()
  try {
    const result = await api(`/api/models?provider=${encodeURIComponent(config.provider)}`, { signal: modelController.signal })
    if (!alive || !props.open || token !== modelVersion) return
    models.value = result.models || []; remoteProviders.value = result.providers || []
  } catch { if (token === modelVersion) models.value = [] }
}
async function open() {
  const token = ++version
  clearSensitive(); error.value = ''; loading.value = true; ready.value = false
  controller?.abort(); controller = new AbortController()
  await nextTick()
  if (!alive || !props.open || token !== version) return
  if (!dialog.value?.open) dialog.value?.showModal()
  try {
    const result = await api('/api/config', { signal: controller.signal })
    if (!alive || !props.open || token !== version) return
    Object.assign(config, result); ready.value = true; void loadModels()
  } catch (e) { if (alive && props.open && token === version) error.value = errorMessage(e) }
  finally { if (alive && token === version) loading.value = false }
}
async function save() {
  if (saving.value || loading.value || !ready.value) return
  if (!config.apiKeySet && !apiKey.value.trim()) { error.value = '请输入模型服务的 API Key。'; return }
  const body = { provider: config.provider, model: config.model.trim(), baseUrl: config.baseUrl.trim(), cwd: config.cwd.trim(), mode: config.mode, systemPrompt: config.systemPrompt, ...(apiKey.value.trim() ? { apiKey: apiKey.value.trim() } : {}) }
  clearSensitive(); saving.value = true; error.value = ''
  const token = version
  try {
    await api('/api/config', { method: 'PUT', body, signal: controller?.signal })
    if (!alive || token !== version || !props.open) return
    emit('saved'); emit('toast', '业务空间配置已保存。'); emit('close')
  } catch (e) { if (alive && token === version && props.open) error.value = errorMessage(e) }
  finally { if (alive && token === version) saving.value = false }
}
watch(() => props.open, async value => {
  if (value) await open()
  else { version++; modelVersion++; controller?.abort(); modelController?.abort(); dialog.value?.close(); clearSensitive(); saving.value = false }
}, { immediate: true })
onBeforeUnmount(() => { alive = false; version++; modelVersion++; controller?.abort(); modelController?.abort(); clearSensitive(); dialog.value?.close() })
</script>

<template>
  <dialog ref="dialog" class="modal-card settings-dialog" aria-labelledby="settings-title" @cancel.prevent="close" @close="props.open && emit('close')">
    <form @submit.prevent="save">
      <header class="modal-header"><div><span class="settings-kicker">WORKSPACE SETTINGS</span><h2 id="settings-title">业务空间设置</h2><p>统一配置模型连接、工作目录与默认执行能力。</p></div><button type="button" class="icon-btn" aria-label="关闭业务空间设置" :disabled="saving" @click="close"><X /></button></header>
      <p v-if="error" class="error-box" role="alert">{{ error }}</p>
      <p v-if="loading" class="empty-state" role="status">正在读取最新配置…</p>
      <fieldset v-else :disabled="saving || !ready" class="settings-fields">
        <h3 class="section-title"><Settings2 :size="16" />模型连接</h3>
        <div class="form-grid"><div class="field"><label for="settings-provider">模型提供商</label><select id="settings-provider" v-model="config.provider" class="input" @change="loadModels"><option v-for="provider in providers" :key="provider.id" :value="provider.id">{{ provider.name }}</option></select></div><div class="field"><label for="settings-model">模型 ID</label><input id="settings-model" v-model="config.model" class="input" list="settings-models" required autocomplete="off" placeholder="例如 MiniMax-M3" /><datalist id="settings-models"><option v-for="model in models.slice(0, 600)" :key="model.id" :value="model.id">{{ model.name || model.id }}</option></datalist></div></div>
        <div class="field"><label for="settings-base-url">API 地址 <span class="optional">可选</span></label><input id="settings-base-url" v-model="config.baseUrl" class="input" type="url" placeholder="使用提供商默认地址，或填写兼容接口地址" autocomplete="off" spellcheck="false" /></div>
        <div class="field"><label for="settings-api-key">API Key <span class="badge" :class="{ 'badge-green': config.apiKeySet }">{{ config.apiKeySet ? '已配置' : '尚未配置' }}</span></label><div class="key-input"><input id="settings-api-key" v-model="apiKey" class="input" :type="keyVisible ? 'text' : 'password'" :placeholder="config.apiKeySet ? '留空保留现有密钥' : '输入模型服务的 API Key'" autocomplete="new-password" spellcheck="false" maxlength="4096" /><button type="button" class="icon-btn" :aria-label="keyVisible ? '隐藏 API Key' : '显示 API Key'" :aria-pressed="keyVisible" @click="keyVisible = !keyVisible"><EyeOff v-if="keyVisible" :size="17" /><Eye v-else :size="17" /></button></div><small>密钥保存在服务端，不会回传至浏览器；输入新密钥可替换。</small></div>
        <h3 class="section-title"><FolderOpen :size="16" />工作空间</h3>
        <div class="field"><label for="settings-cwd">工作目录</label><input id="settings-cwd" v-model="config.cwd" class="input" required placeholder="D:\code\pi" autocomplete="off" spellcheck="false" /><small>智能体在此目录读取文件、使用技能和执行任务。</small></div>
        <div class="field"><label for="settings-system-prompt">系统提示词 <span class="optional">可选</span></label><textarea id="settings-system-prompt" v-model="config.systemPrompt" class="input" rows="4" placeholder="补充业务背景、回答要求与执行规范" /></div>
        <h3 class="section-title"><ShieldCheck :size="16" />默认执行能力</h3>
        <div class="mode-options"><label class="mode-option" :class="{ selected: config.mode === 'read-only' }"><input v-model="config.mode" type="radio" value="read-only" name="settings-mode" /><span><strong>只读分析</strong><small>读取文件、检索与分析，不执行脚本。</small></span></label><label class="mode-option" :class="{ selected: config.mode === 'workspace' }"><input v-model="config.mode" type="radio" value="workspace" name="settings-mode" /><span><strong>工作区执行</strong><small>允许写入文件、执行技能与系统命令。</small></span></label></div>
        <p class="mode-hint">工具在本机执行；此设置控制可用能力，不提供系统级隔离。已有智能体可单独设置执行模式。</p>
      </fieldset>
      <footer class="modal-footer"><button type="button" class="btn" :disabled="saving" @click="close">取消</button><button class="btn btn-primary" :disabled="loading || saving || !ready">{{ saving ? '正在保存…' : '保存配置' }}</button></footer>
    </form>
  </dialog>
</template>

<style scoped>
.settings-dialog{margin:auto;width:min(700px,calc(100vw - 32px));max-height:90dvh;color:var(--foreground);overscroll-behavior:contain}.settings-dialog::backdrop{background:#17243a55;backdrop-filter:blur(3px)}.modal-header{align-items:flex-start}.modal-header p{margin-bottom:0}.modal-header .icon-btn{flex-shrink:0}.settings-kicker{display:block;font-size:10px;letter-spacing:1.4px;color:#91a0b5;margin-bottom:9px}.settings-fields{border:0;padding:0;margin:0;min-width:0}.section-title{display:flex;align-items:center;gap:8px;color:#596c89;font-size:13px;margin:24px 0 18px}.section-title:first-child{margin-top:0}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}.optional{font-size:11px;font-weight:400;color:#a0aaba;margin-left:5px}.key-input{position:relative}.key-input input{padding-right:45px}.key-input .icon-btn{position:absolute;right:2px;top:1px}.mode-options{display:grid;grid-template-columns:1fr 1fr;gap:12px}.mode-option{display:flex;align-items:flex-start;gap:10px;border:1px solid var(--border);border-radius:10px;padding:14px;cursor:pointer}.mode-option.selected{border-color:#82a6f7;background:#f5f8ff}.mode-option input{accent-color:#2563eb;margin-top:3px}.mode-option strong{font-size:12px;font-weight:600;display:block}.mode-option small{display:block;font-size:11px;color:#8b98ac;margin-top:6px;line-height:1.6}.mode-hint{font-size:11px!important;color:#92a0b2!important;margin:12px 0 0}@media(max-width:600px){.form-grid,.mode-options{grid-template-columns:1fr}.form-grid{gap:0}}
</style>
