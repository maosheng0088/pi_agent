import { defineStore } from 'pinia'
import { computed, ref, onScopeDispose } from 'vue'
import { api, ApiError, advanceApiIdentity, consumeStream, errorMessage } from '../lib/api'
import type { Message, Session, Skill, User, View, Workspace } from '../lib/types'

export const useWorkspaceStore = defineStore('workspace', () => {
  const user = ref<User | null>(null), workspace = ref<Workspace | null>(null)
  const sessions = ref<Session[]>([]), current = ref<Session | null>(null), messages = ref<Message[]>([])
  const skills = ref<Skill[]>([]), selectedSkill = ref(''), view = ref<View>('chat')
  const status = ref<any>(null), booting = ref(true), loading = ref(false), running = ref(false), stopping = ref(false)
  const setupRequired = ref(false), setupAllowed = ref(true), authError = ref(''), chatError = ref(''), online = ref(true)
  const drafts = ref<Record<string, string>>({}), toastText = ref('')
  const isAdmin = computed(() => user.value?.role === 'admin')
  const active = computed(() => running.value || !!current.value?.running)
  const canStop = computed(() => active.value && (running.value || isAdmin.value || current.value?.activeUserId === user.value?.id))
  let identity = 0, selection = 0, syncing = false, toastTimer: ReturnType<typeof setTimeout> | undefined
  let stream: AbortController | null = null, syncController: AbortController | null = null
  const authChannel=typeof BroadcastChannel==='undefined'?null:new BroadcastChannel('pi-workspace-auth')
  if(authChannel){
    authChannel.onmessage=(event)=>{
      if(event.data?.type!=='identity'||event.data.userId===user.value?.id)return
      const hadUser=!!user.value
      if(hadUser)clearIdentity()
      if(event.data.userId)void initialize()
      else if(hadUser)authError.value='已在其他标签页退出登录，请重新登录。'
    }
    onScopeDispose(()=>authChannel.close())
  }

  function toast(text: string) { clearTimeout(toastTimer); toastText.value = text; toastTimer = setTimeout(() => { toastText.value = '' }, 4200) }
  function setHash(id?: string) { const url = new URL(location.href); url.hash = id ? `agent=${encodeURIComponent(id)}` : ''; history.replaceState(null, '', url) }
  function clearIdentity() {
    identity++; advanceApiIdentity(); selection++; stream?.abort(); stream = null; syncController?.abort(); syncController = null; syncing = false
    user.value = null; sessions.value = []; current.value = null; messages.value = []; skills.value = []; selectedSkill.value = ''
    drafts.value = {}; status.value = null; view.value = 'chat'; running.value = false; stopping.value = false; loading.value = false; chatError.value = ''; toastText.value = ''; setHash()
  }
  function expire() { if (user.value) { clearIdentity(); authError.value = '登录已过期或账户已停用，请重新登录。' } }
  async function listSessions(signal?: AbortSignal): Promise<Session[]> {
    const all: Session[] = [], seen = new Set<string>()
    let offset = 0
    while (true) {
      const result = await api<{sessions: Session[]; total?: number}>(`/api/sessions?limit=100&offset=${offset}`, { signal })
      const page = result.sessions || []
      for (const item of page) if (!seen.has(item.id)) { seen.add(item.id); all.push(item) }
      offset += page.length
      if (!page.length || offset >= (result.total ?? offset)) return all
    }
  }
  async function refreshSessions() {
    const token = identity
    const data = await listSessions(AbortSignal.timeout(12000))
    if (token !== identity || !user.value) return
    sessions.value = data
    if (current.value && !data.some(item => item.id === current.value?.id)) forget(current.value.id)
  }
  function forget(id: string, left = false) {
    sessions.value = sessions.value.filter(item => item.id !== id); delete drafts.value[id]
    if (current.value?.id !== id) return
    selection++; stream?.abort(); stream = null; current.value = null; messages.value = []; skills.value = []; selectedSkill.value = ''
    running.value = false; stopping.value = false; loading.value = false; chatError.value = ''; setHash()
    toast(left ? '已退出此智能体的协作空间。' : '你已失去此智能体的访问权限，相关内容已关闭。')
  }
  async function select(id: string) {
    if (running.value) { toast('请等待当前任务完成，或先停止任务。'); return }
    const token = ++selection, owner = identity
    current.value = sessions.value.find(item => item.id === id) || null
    messages.value = []; skills.value = []; selectedSkill.value = ''; view.value = 'chat'; chatError.value = ''; loading.value = true
    const valid = () => token === selection && owner === identity && !!user.value
    try {
      const result = await api<{session: Session; messages: Message[]}>(`/api/sessions/${encodeURIComponent(id)}`)
      if (!valid()) return
      current.value = result.session; messages.value = result.messages || []; setHash(id)
      try { const result = await api<{skills: Skill[]}>(`/api/sessions/${encodeURIComponent(id)}/skills`); if (valid()) skills.value = result.skills || [] } catch { /* Chat remains available if the skills panel cannot load. */ }
    } catch (error) {
      if (!valid()) return
      if (error instanceof ApiError && error.status === 404) forget(id)
      else chatError.value = errorMessage(error)
    } finally { if (valid()) loading.value = false }
  }
  async function enter(auth: any, preferred?: string) {
    const token = ++identity
    advanceApiIdentity()
    user.value = auth.user; workspace.value = auth.workspace; authError.value = ''; online.value = true
    const results = await Promise.allSettled([api('/api/status'), listSessions(AbortSignal.timeout(12000))])
    if (token !== identity || !user.value) return
    if (results[0].status === 'fulfilled') status.value = results[0].value
    else online.value = false
    if (results[1].status === 'fulfilled') sessions.value = results[1].value
    else throw results[1].reason
    const initial = preferred && sessions.value.some(item => item.id === preferred) ? preferred : sessions.value[0]?.id
    if (initial) await select(initial)
    if(token===identity&&user.value)authChannel?.postMessage({type:'identity',userId:user.value.id})
  }
  async function initialize() {
    booting.value = true; authError.value = ''
    const preferred = new URLSearchParams(location.hash.slice(1)).get('agent') || new URLSearchParams(location.hash.slice(1)).get('session') || undefined
    try {
      const auth = await api('/api/auth/status')
      workspace.value = auth.workspace; setupRequired.value = !!auth.setupRequired; setupAllowed.value = auth.setupAllowed !== false
      if (auth.authenticated && auth.user) await enter(auth, preferred)
    } catch (error) { authError.value = errorMessage(error); online.value = false }
    finally { booting.value = false }
  }
  async function authenticate(username: string, password: string, displayName?: string) {
    authError.value = ''
    try {
      const auth = await api(setupRequired.value ? '/api/auth/setup' : '/api/auth/login', { method: 'POST', body: { username: username.trim(), password, ...(setupRequired.value ? { displayName } : {}) } })
      setupRequired.value = false; await enter(auth)
    } catch (error) { authError.value = errorMessage(error); throw error }
  }
  async function logout() {
    if (running.value) { toast('请等待当前任务完成或停止后退出。'); return }
    const owner=identity
    try { await api('/api/auth/logout', { method: 'POST', body: {} }); if(owner===identity){clearIdentity(); authError.value = '';authChannel?.postMessage({type:'identity',userId:null})} } catch (error) { if(owner===identity)toast(errorMessage(error)) }
  }
  async function synchronize() {
    if (!user.value || document.hidden || syncing || running.value || loading.value) return
    const owner = identity, token = selection, id = current.value?.id
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 12000)
    syncController = controller; syncing = true
    const valid = () => owner === identity && !!user.value
    const same = () => valid() && token === selection && current.value?.id === id && !running.value && !loading.value
    try {
      const results = await Promise.allSettled([api('/api/status', { signal: controller.signal }), listSessions(controller.signal)])
      if (!valid()) return
      if (results[0].status === 'fulfilled') { status.value = results[0].value; online.value = true }
      if (results[1].status === 'fulfilled') {
        sessions.value = results[1].value
        if (same() && id && !sessions.value.some(item => item.id === id)) { forget(id); return }
      }
      if (results.every(result => result.status === 'rejected')) { online.value = false; return }
      if (!same() || !id || view.value !== 'chat') return
      const summary = sessions.value.find(item => item.id === id)
      if (summary && current.value) {
        const oldRevision = current.value.revision
        current.value = { ...current.value, ...summary }
        if (summary.revision != null && summary.revision === oldRevision && messages.value.length) {
          const result=await api<{skills:Skill[]}>(`/api/sessions/${encodeURIComponent(id)}/skills`,{signal:controller.signal})
          if(same()){skills.value=result.skills||[];if(selectedSkill.value&&!skills.value.some(skill=>skill.id===selectedSkill.value))selectedSkill.value=''}
          return
        }
      }
      const result = await api<{session: Session; messages: Message[]}>(`/api/sessions/${encodeURIComponent(id)}`, { signal: controller.signal })
      if (same()) { current.value = result.session; if (JSON.stringify(messages.value) !== JSON.stringify(result.messages || [])) messages.value = result.messages || [] }
      const available=await api<{skills:Skill[]}>(`/api/sessions/${encodeURIComponent(id)}/skills`,{signal:controller.signal})
      if(same()){skills.value=available.skills||[];if(selectedSkill.value&&!skills.value.some(skill=>skill.id===selectedSkill.value))selectedSkill.value=''}
    } catch (error) {
      if (same() && error instanceof ApiError && error.status === 404 && id) forget(id)
      else if (valid() && !(error instanceof ApiError && error.status === 401)) online.value = false
    } finally { clearTimeout(timer); if (syncController === controller) { syncing = false; syncController = null } }
  }
  async function send(text: string) {
    const id = current.value?.id, prompt = text.trim()
    if (!id || !prompt || active.value || loading.value || !user.value) return false
    if (!status.value?.configured) { toast(isAdmin.value ? '请先在系统设置中配置模型。' : '请联系管理员完成模型配置。'); return false }
    const owner = identity, token = selection, actor = { ...user.value }
    const valid = () => owner === identity && token === selection && current.value?.id === id && !!user.value
    running.value = true; chatError.value = ''; stream = new AbortController()
    let accepted = false, finished = false, answer = '', failed = false
    const restoreDraft=()=>{if(!drafts.value[id]?.trim()||drafts.value[id]===text)drafts.value[id]=text}
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/messages`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify({ message: prompt, ...(selectedSkill.value ? { skillId: selectedSkill.value } : {}) }), signal: stream.signal })
      if (!valid()) return false
      if (!response.ok) {
        const result = await response.json().catch(() => ({}))
        if (response.status === 401) expire()
        if (response.status === 404 && valid()) forget(id)
        throw new Error(result.error || `请求失败（${response.status}）`)
      }
      if (!response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('服务响应异常，请重新打开智能体。')
      accepted = true; if(drafts.value[id]===text)drafts.value[id] = ''
      messages.value.push({ role: 'user', content: prompt, authorId: actor.id, authorName: actor.displayName || actor.username, timestamp: Date.now() })
      await consumeStream(response, event => {
        if (!valid()) return
        if (event.type === 'access_revoked') { forget(id); return }
        if (event.type === 'start' && current.value) current.value = { ...current.value, running: true, activeUserId: event.authorId || actor.id, activeUserName: event.authorName || actor.displayName }
        if (event.type === 'text_delta') answer += event.delta || ''
        if (event.type === 'tool_start') answer = ''
        if (event.type === 'error') { chatError.value = event.message || '本次请求失败，请重试。'; failed = true }
        if (event.type === 'done') {
          finished = true
          if (event.session) current.value = event.session
          if (answer.trim()) messages.value.push({ role: 'assistant', content: answer, timestamp: Date.now() })
          if (event.aborted) toast('已停止本次任务。')
        }
      })
      if (!finished && valid()) throw new Error('连接中断，请重新打开智能体查看已保存的结果。')
      return true
    } catch (error) {
      if (valid()) { chatError.value = errorMessage(error); if (!accepted || !answer) restoreDraft() }
      return false
    } finally {
      if (valid()) {
        running.value = false; stopping.value = false; stream = null
        if (current.value) current.value.running = false
        try {
          const result = await api<{session:Session;messages:Message[]}>(`/api/sessions/${encodeURIComponent(id)}`)
          if (valid()) { current.value = result.session; messages.value = result.messages || [] }
        } catch (error) { if (valid() && error instanceof ApiError && error.status === 404) forget(id) }
        if (valid()) await refreshSessions().catch(() => {})
        if (valid() && failed && !answer) restoreDraft()
      }
    }
  }
  async function stop() {
    const id = current.value?.id
    if (!id || !canStop.value || stopping.value) return
    stopping.value = true
    const owner=identity,token=selection
    const valid=()=>owner===identity&&token===selection&&current.value?.id===id
    try { await api(`/api/sessions/${encodeURIComponent(id)}/abort`, { method: 'POST', body: {} }); if (valid()&&!running.value) await synchronize() }
    catch (error) { if(valid())toast(errorMessage(error)) }
    finally { if(valid())stopping.value = false }
  }
  function navigate(next: View) {
    if (next !== 'chat' && !isAdmin.value) return
    if (running.value) { toast('请等待当前任务完成或停止后切换页面。'); return }
    view.value = next
  }
  function applySession(session: Session) {
    if (current.value?.id === session.id) current.value = session
    sessions.value = sessions.value.map(item => item.id === session.id ? { ...item, ...session } : item)
  }
  return { user, workspace, sessions, current, messages, skills, selectedSkill, view, status, booting, loading, running, stopping, setupRequired, setupAllowed, authError, chatError, online, drafts, toastText, isAdmin, active, canStop, toast, expire, initialize, authenticate, logout, refreshSessions, select, synchronize, send, stop, navigate, applySession, forget }
})
