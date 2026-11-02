import { useSyncExternalStore } from 'react'
import { Toast } from '@douyinfe/semi-ui'
import { api, ApiError, advanceApiIdentity, consumeStream, errorMessage } from './api'
import {conversationRunning} from './session-activity'
import {isPublicView,isView,toolViewFromHash,workspaceViewFromHash} from './navigation'
import type { User, Workspace, Session, SessionAttention, Message, Skill, View } from './types'

export interface WorkspaceState {
  user: User | null; workspace: Workspace | null; sessions: Session[]; current: Session | null; messages: Message[];
  skills: Skill[]; selectedSkill: string; view: View; status: any; booting: boolean; loading: boolean;
  running: boolean; stopping: boolean; setupRequired: boolean; setupAllowed: boolean; authError: string;
  chatError: string; online: boolean; drafts: Record<string, string>; submitting?: boolean
}
function initialState(): WorkspaceState { return { user: null, workspace: null, sessions: [], current: null, messages: [], skills: [], selectedSkill: '', view: 'chat', status: null, booting: true, loading: false, running: false, stopping: false, setupRequired: false, setupAllowed: true, authError: '', chatError: '', online: true, drafts: {} } }

export class WorkspaceStore {
  state = initialState()
  listeners = new Set<() => void>()
  private identity = 0
  private selection = 0
  private authRequest = 0
  private sessionsRequest = 0
  private statusRequest = 0
  private skillsRequest = 0
  private execution = 0
  private syncing = false
  private disposed = false
  private stream: AbortController | null = null
  private syncController: AbortController | null = null
  private channel: BroadcastChannel | null = null
  private posting = new Set<string>()
  private pendingPosts = new Map<string, { fingerprint: string; requestId: string }>()
  private readRequests = new Set<string>()
  private readPositions = new Map<string, number>()

  constructor() {
    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel('pi-workspace-auth')
      this.channel.onmessage = event => {
        if (this.disposed || event.data?.type !== 'identity' || event.data.userId === this.state.user?.id) return
        const hadUser = !!this.state.user
        this.clear()
        if (event.data.userId) void this.initialize()
        else if (hadUser) this.patch({ authError: '已在其他标签页退出登录，请重新登录。' })
      }
    }
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  snapshot = () => this.state
  patch(value: Partial<WorkspaceState>) { if (this.disposed) return; this.state = { ...this.state, ...value }; this.listeners.forEach(listener => listener()) }
  get isAdmin() { return this.state.user?.role === 'admin' }
  get active() { return conversationRunning(this.state.current,this.state.running) }
  get canStop() { return this.active && (this.state.running || this.isAdmin || this.state.current?.activeUserId === this.state.user?.id) }
  hash(id?: string) { const url = new URL(location.href); url.hash = id ? `agent=${encodeURIComponent(id)}` : ''; history.replaceState(null, '', url) }
  private resetIdentity(invalidateAuthentication = true) {
    if (invalidateAuthentication) this.authRequest++
    this.identity++; advanceApiIdentity(); this.selection++; this.sessionsRequest++; this.statusRequest++; this.skillsRequest++; this.execution++
    this.stream?.abort(); this.stream = null; this.syncController?.abort(); this.syncController = null; this.syncing = false
    this.posting.clear(); this.pendingPosts.clear()
    this.readRequests.clear(); this.readPositions.clear()
    const { workspace, setupRequired, setupAllowed } = this.state
    this.patch({ ...initialState(), workspace, setupRequired, setupAllowed, booting: false, submitting: false }); this.hash()
  }
  clear() { this.resetIdentity() }
  expire() { if (this.state.user) { this.clear(); this.patch({ authError: '登录已过期或账户已停用，请重新登录。' }) } }
  toast(message: string) { if (!this.disposed) Toast.info(message) }
  setDraft(id: string, value: string) { if (this.state.user && (this.state.current?.id === id || this.state.sessions.some(session => session.id === id))) this.patch({ drafts: { ...this.state.drafts, [id]: value } }) }
  setSkill(value: string) { this.patch({ selectedSkill: value && this.state.skills.some(skill => skill.id === value && skill.enabled !== false) ? value : '' }) }
  async markRead(id:string,cursor?:number) {
    if(this.disposed||!this.state.user||this.state.current?.id!==id||this.state.loading||this.state.view!=='chat'||typeof cursor!=='number'||!Number.isSafeInteger(cursor)||cursor<0||document.hidden)return
    const owner=this.identity,key=`${owner}:${id}:${cursor}`
    if((this.readPositions.get(id)??-1)>=cursor||this.readRequests.has(key))return
    this.readRequests.add(key)
    try{
      const result=await api<{attention:SessionAttention}>(`/api/sessions/${encodeURIComponent(id)}/read`,{method:'POST',body:{cursor},signal:AbortSignal.timeout(12000)})
      if(this.disposed||owner!==this.identity||!this.state.user||!this.state.sessions.some(session=>session.id===id)||(this.readPositions.get(id)??-1)>cursor)return
      this.readPositions.set(id,cursor);this.sessionsRequest++
      this.patch({sessions:this.state.sessions.map(session=>session.id===id?{...session,attention:result.attention}:session),current:this.state.current?.id===id?{...this.state.current,attention:result.attention}:this.state.current})
    }catch(error){if(owner===this.identity&&this.state.current?.id===id&&error instanceof ApiError&&error.status===404)this.forget(id)}
    finally{this.readRequests.delete(key)}
  }
  async listSessions(signal?: AbortSignal) {
    const all: Session[] = [], seen = new Set<string>(); let offset = 0
    while (true) {
      const result = await api<{ sessions: Session[]; total?: number }>(`/api/sessions?limit=100&offset=${offset}`, { signal })
      for (const session of result.sessions || []) if (!session.taskWorker && !seen.has(session.id)) { seen.add(session.id); all.push(session) }
      offset += (result.sessions || []).length
      if (!result.sessions?.length || offset >= (result.total ?? offset)) return all
    }
  }
  async refreshSessions() {
    if (!this.state.user || this.disposed) return
    const owner = this.identity, request = ++this.sessionsRequest
    const sessions = await this.listSessions(AbortSignal.timeout(12000))
    if (this.disposed || owner !== this.identity || request !== this.sessionsRequest || !this.state.user) return
    this.patch({ sessions })
    if (this.state.current && !this.state.current.taskWorker && !sessions.some(session => session.id === this.state.current?.id)) this.forget(this.state.current.id)
  }
  applySession(session: Session) {
    this.sessionsRequest++
    this.patch({ current: this.state.current?.id === session.id ? session : this.state.current, sessions: this.state.sessions.map(item => item.id === session.id ? { ...item, ...session } : item) })
  }
  forget(id: string, left = false, announce = true) {
    // A list response begun before revocation must never restore the group.
    this.sessionsRequest++
    const drafts = { ...this.state.drafts }; delete drafts[id]
    this.patch({ sessions: this.state.sessions.filter(item => item.id !== id), drafts })
    if (this.state.current?.id !== id) return
    this.selection++; this.skillsRequest++; this.execution++; this.stream?.abort(); this.stream = null
    this.patch({ current: null, messages: [], skills: [], selectedSkill: '', running: false, stopping: false, loading: false, submitting: false, chatError: '' }); if(this.state.view==='chat')this.hash()
    if (announce) this.toast(left ? '已退出此智能体的协作空间。' : '你已失去此智能体的访问权限，相关内容已关闭。')
  }
  private applySkills(skills: Skill[]) { this.patch({ skills, selectedSkill: this.state.selectedSkill && skills.some(skill => skill.id === this.state.selectedSkill && skill.enabled !== false) ? this.state.selectedSkill : '' }) }
  async select(id: string) {
    if (!this.state.user || this.disposed) return
    if (this.state.running) { this.toast('请等待当前任务完成或停止。'); return }
    const token = ++this.selection, owner = this.identity
    this.skillsRequest++
    this.patch({ current: this.state.sessions.find(item => item.id === id) || null, messages: [], skills: [], selectedSkill: '', view: 'chat', chatError: '', loading: true, submitting: this.posting.has(id) })
    const valid = () => !this.disposed && token === this.selection && owner === this.identity && !!this.state.user
    try {
      const result = await api<{ session: Session; messages: Message[] }>(`/api/sessions/${encodeURIComponent(id)}`)
      if (!valid()) return
      this.patch({ current: result.session, messages: result.messages || [] }); if(this.state.view==='chat')this.hash(id)
      const skillsToken = ++this.skillsRequest
      try { const available = await api<{ skills: Skill[] }>(`/api/sessions/${encodeURIComponent(id)}/skills`); if (valid() && skillsToken === this.skillsRequest) this.applySkills(available.skills || []) }
      catch (error) { if (valid() && error instanceof ApiError && error.status === 404) this.forget(id) }
    } catch (error) { if (!valid()) return; if (error instanceof ApiError && error.status === 404) this.forget(id); else this.patch({ chatError: errorMessage(error) }) }
    finally { if (valid()) this.patch({ loading: false }) }
  }
  async enter(auth: any, preferred?: string, authentication = ++this.authRequest) {
    if (this.disposed || authentication !== this.authRequest || !auth?.user) return
    const booting = this.state.booting
    // Reset before publishing a different account, including when it has no groups.
    this.resetIdentity(false)
    const owner = this.identity, sessionsToken = ++this.sessionsRequest, statusToken = ++this.statusRequest
    this.patch({ user: auth.user, workspace: auth.workspace || this.state.workspace, authError: '', online: true, booting, setupRequired: false, loading: true })
    const results = await Promise.allSettled([api('/api/status'), this.listSessions(AbortSignal.timeout(12000))])
    if (this.disposed || owner !== this.identity || authentication !== this.authRequest || !this.state.user) return
    if (statusToken === this.statusRequest) { if (results[0].status === 'fulfilled') this.patch({ status: results[0].value }); else this.patch({ online: false }) }
    if (results[1].status === 'rejected') { this.patch({ loading: false }); throw results[1].reason }
    if (sessionsToken !== this.sessionsRequest) { this.patch({ loading: false }); return }
    const sessions = results[1].value; this.patch({ sessions })
    const id = preferred && sessions.some(session => session.id === preferred) ? preferred : sessions[0]?.id
    if (id) await this.select(id)
    else this.patch({ loading: false })
    if (!this.disposed && owner === this.identity && authentication === this.authRequest && this.state.user) this.channel?.postMessage({ type: 'identity', userId: this.state.user.id })
  }
  async initialize() {
    if (this.disposed) return
    const token = ++this.authRequest, owner = this.identity
    this.patch({ booting: true, authError: '' })
    const params = new URLSearchParams(location.hash.slice(1)), preferred = params.get('agent') || params.get('session') || undefined
    const valid = () => !this.disposed && token === this.authRequest
    try {
      const auth = await api('/api/auth/status')
      if (!valid() || owner !== this.identity) return
      this.patch({ workspace: auth.workspace, setupRequired: !!auth.setupRequired, setupAllowed: auth.setupAllowed !== false })
      if (auth.authenticated && auth.user) await this.enter(auth, preferred, token)
      else if (this.state.user) this.clear()
    } catch (error) { if (valid()) this.patch({ authError: errorMessage(error), online: false }) }
    finally { if (valid()) this.patch({ booting: false }) }
  }
  async authenticate(username: string, password: string, displayName?: string) {
    if (this.disposed) return
    const setup = this.state.setupRequired
    if (this.state.user) this.clear()
    const token = ++this.authRequest
    this.patch({ authError: '' })
    try {
      const auth = await api(setup ? '/api/auth/setup' : '/api/auth/login', { method: 'POST', body: { username: username.trim(), password, ...(setup ? { displayName } : {}) } })
      if (this.disposed || token !== this.authRequest) return
      this.patch({ setupRequired: false }); await this.enter(auth, undefined, token)
    } catch (error) { if (!this.disposed && token === this.authRequest) { this.patch({ authError: errorMessage(error) }); throw error } }
  }
  async logout() {
    if (this.state.running) { this.toast('请等待当前任务完成或停止后退出。'); return }
    const owner = this.identity, token = ++this.authRequest
    try { await api('/api/auth/logout', { method: 'POST', body: {} }); if (!this.disposed && owner === this.identity && token === this.authRequest) { this.clear(); this.channel?.postMessage({ type: 'identity', userId: null }) } }
    catch (error) { if (!this.disposed && owner === this.identity && token === this.authRequest) this.toast(errorMessage(error)) }
  }
  navigate(view: View) {
    if(!this.state.user||!isView(view)||!isPublicView(view)&&!this.isAdmin)return
    if(this.state.running){this.toast('请等待当前任务完成或停止后切换页面。');return}
    if(view==='ocean'){
      if(toolViewFromHash(location.hash)!=='ocean'){const url=new URL(location.href);url.hash='view=ocean&tool=track';history.replaceState(null,'',url)}
    }else if(view==='tools'){
      const url=new URL(location.href);url.hash='view=tools';history.replaceState(null,'',url)
    }else if(view==='agents'){
      const url=new URL(location.href);url.hash='view=agents';history.replaceState(null,'',url)
    }else if(workspaceViewFromHash(location.hash))this.hash(this.state.current?.id)
    this.patch({view})
  }
  async synchronize() {
    if (this.disposed || !this.state.user || document.hidden || this.syncing || this.state.running || this.state.loading) return
    const owner = this.identity, token = this.selection, id = this.state.current?.id, sessionsToken = ++this.sessionsRequest, statusToken = ++this.statusRequest
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 12000)
    this.syncController = controller; this.syncing = true
    const valid = () => !this.disposed && owner === this.identity && !!this.state.user
    const same = () => valid() && token === this.selection && id === this.state.current?.id && !this.state.running && !this.state.loading
    try {
      const results = await Promise.allSettled([api('/api/status', { signal: controller.signal }), this.listSessions(controller.signal)])
      if (!valid()) return
      if (results[0].status === 'fulfilled' && statusToken === this.statusRequest) this.patch({ status: results[0].value, online: true })
      if (results[1].status === 'fulfilled' && sessionsToken === this.sessionsRequest) { this.patch({ sessions: results[1].value }); if (same() && id && !this.state.current?.taskWorker && !results[1].value.some(session => session.id === id)) { this.forget(id); return } }
      if (results.every(result => result.status === 'rejected')) { this.patch({ online: false }); return }
      if (!same() || !id || this.state.view !== 'chat') return
      const summary = this.state.sessions.find(session => session.id === id), revision = this.state.current?.revision
      if (summary && this.state.current) this.patch({ current: { ...this.state.current, ...summary } })
      if (!summary || summary.revision == null || summary.revision !== revision || (summary.attentionLatest??0)>(this.state.current?.attentionCursor??0) || !this.state.messages.length) { const result = await api<{ session: Session; messages: Message[] }>(`/api/sessions/${encodeURIComponent(id)}`, { signal: controller.signal }); if (same()) this.patch({ current: result.session, messages: result.messages || [] }) }
      if (!same()) return
      const skillsToken = ++this.skillsRequest, available = await api<{ skills: Skill[] }>(`/api/sessions/${encodeURIComponent(id)}/skills`, { signal: controller.signal })
      if (same() && skillsToken === this.skillsRequest) this.applySkills(available.skills || [])
    } catch (error) { if (same() && id && error instanceof ApiError && error.status === 404) this.forget(id); else if (valid() && !(error instanceof ApiError && error.status === 401)) this.patch({ online: false }) }
    finally { clearTimeout(timer); if (this.syncController === controller) { this.syncing = false; this.syncController = null } }
  }
  async refreshContext() {
    if (this.disposed || !this.state.user) return
    const owner = this.identity, statusToken = ++this.statusRequest
    try {
      const status = await api('/api/status')
      if (this.disposed || owner !== this.identity) return
      if (statusToken === this.statusRequest) this.patch({ status })
      await this.refreshSessions()
      if (this.disposed || owner !== this.identity) return
      const id = this.state.current?.id, token = this.selection
      if (id && !this.state.running) { const skillsToken = ++this.skillsRequest, result = await api<{ skills: Skill[] }>(`/api/sessions/${encodeURIComponent(id)}/skills`); if (!this.disposed && owner === this.identity && token === this.selection && this.state.current?.id === id && skillsToken === this.skillsRequest) this.applySkills(result.skills || []) }
    } catch (error) { if (this.disposed || owner !== this.identity) return; if (error instanceof ApiError && error.status === 404 && this.state.current) this.forget(this.state.current.id); else this.toast(errorMessage(error)) }
  }
  async send(text: string) {
    const id = this.state.current?.id, prompt = text.trim()
    if (this.disposed || !id || !prompt || this.active || this.state.loading || !this.state.user) return false
    if (!this.state.status?.configured) { this.toast(this.isAdmin ? '请先在系统设置中配置模型。' : '请联系管理员完成模型配置。'); return false }
    const owner = this.identity, token = this.selection, execution = ++this.execution, actor = { ...this.state.user }, controller = new AbortController()
    const valid = () => !this.disposed && owner === this.identity && token === this.selection && execution === this.execution && this.state.current?.id === id && !!this.state.user
    this.patch({ running: true, chatError: '' }); this.stream = controller
    let accepted = false, started = false, finished = false, finalSession = false, answer = '', failed = false
    const restore = () => { if (!this.state.drafts[id]?.trim() || this.state.drafts[id] === text) this.setDraft(id, text) }
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/messages`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify({ message: prompt, ...(this.state.selectedSkill ? { skillId: this.state.selectedSkill } : {}) }), signal: controller.signal })
      if (!valid()) return false
      if (!response.ok) { const result = await response.json().catch(() => ({})); if (response.status === 401) this.expire(); if (response.status === 404 && valid()) this.forget(id); throw new Error(result.error || `请求失败（${response.status}）`) }
      if (!response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('服务响应异常，请重新打开智能体。')
      accepted = true; if (this.state.drafts[id] === text) this.setDraft(id, '')
      this.patch({ messages: [...this.state.messages, { role: 'user', content: prompt, authorId: actor.id, authorName: actor.displayName || actor.username, timestamp: Date.now() }] })
      // Buffer intermediate text privately; raw tool events never enter messages.
      await consumeStream(response, event => {
        if (!valid()) return
        if (event.type === 'access_revoked') { this.forget(id); return }
        if (event.type === 'start' && this.state.current) { started = true; this.applySession({ ...this.state.current, running: true, conversationRunning: true, runningTaskCount: (this.state.current.runningTaskCount || 0) + 1, activeUserId: event.authorId || actor.id, activeUserName: event.authorName || actor.displayName }) }
        if (event.type === 'text_delta') answer += event.delta || ''
        if (event.type === 'tool_start') answer = ''
        if (event.type === 'error') { this.patch({ chatError: event.message || '本次请求失败，请重试。' }); failed = true }
        if (event.type === 'done') { finished = true; if (event.session) { finalSession = true; this.applySession(event.session) }; if (!failed && !event.aborted && answer.trim()) this.patch({ messages: [...this.state.messages, { role: 'assistant', content: answer, timestamp: Date.now() }] }); if (event.aborted) this.toast('已停止本次任务。') }
      })
      if (!valid()) return false
      if (!finished) throw new Error('连接中断，请重新打开智能体查看已保存的结果。')
      return true
    } catch (error) { if (valid()) { this.patch({ chatError: errorMessage(error) }); if (!accepted || !answer) restore() }; return false }
    finally {
      if (valid()) {
        this.patch({ running: false, stopping: false, current: this.state.current ? { ...this.state.current, conversationRunning: false, ...(!finalSession && started ? { running: (this.state.current.runningTaskCount || 0) > 1, runningTaskCount: Math.max(0,(this.state.current.runningTaskCount || 0)-1) } : {}) } : null }); this.stream = null
        try { const result = await api<{ session: Session; messages: Message[] }>(`/api/sessions/${encodeURIComponent(id)}`); if (valid()) this.patch({ current: result.session, messages: result.messages || [] }) }
        catch (error) { if (valid() && error instanceof ApiError && error.status === 404) this.forget(id) }
        if (valid()) await this.refreshSessions().catch(() => {})
        if (valid() && failed && !answer) restore()
      }
    }
  }
  async collaborate(text: string, options: { mode: 'agent' | 'discussion'; replyTo?: string; mentions?: string[]; attachmentIds?: string[] }) {
    const id = this.state.current?.id, content = text.trim()
    const attachmentIds = options.attachmentIds || []
    if (!id || (!content && !attachmentIds.length) || !this.state.user || this.disposed || this.posting.has(id) || this.state.loading) return false
    if (!Array.isArray(attachmentIds) || attachmentIds.length > 10 || new Set(attachmentIds).size !== attachmentIds.length || attachmentIds.some(value => typeof value !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value))) { this.patch({ chatError: '附件编号无效，请移除后重新上传。' }); return false }
    const invoke = options.mode === 'agent' || options.mentions?.includes('agent') || /(^|\s)@智能体(?:\s|$)/.test(content)
    if (invoke && !this.state.status?.configured) { this.toast(this.isAdmin ? '请先在系统设置中配置模型。' : '请联系管理员完成模型配置。'); return false }
    const owner = this.identity, selection = this.selection
    const fingerprint = JSON.stringify([content, invoke, options.replyTo, options.mentions, invoke ? this.state.selectedSkill : null, attachmentIds])
    const pending = this.pendingPosts.get(id)
    const requestId = pending?.fingerprint === fingerprint ? pending.requestId : crypto.randomUUID()
    this.pendingPosts.set(id, { fingerprint, requestId }); this.posting.add(id)
    this.patch({ submitting: true, chatError: '' })
    const sameIdentity = () => !this.disposed && owner === this.identity && !!this.state.user
    const sameSelection = () => sameIdentity() && selection === this.selection && id === this.state.current?.id
    let accepted = false
    try {
      const result = await api<{ task?: { id: string }; message?: Message }>(`/api/sessions/${encodeURIComponent(id)}/${invoke ? 'tasks' : 'discussion'}`, { method: 'POST', signal: AbortSignal.timeout(20000), body: {
        ...(invoke ? { instruction: content, ...(this.state.selectedSkill ? { skillId: this.state.selectedSkill } : {}) } : { content }),
        clientRequestId: requestId, ...(options.replyTo ? { replyTo: options.replyTo } : {}), mentions: options.mentions || [],
        ...(attachmentIds.length ? { attachmentIds } : {}),
      } })
      if (!result.task?.id && !result.message?.id) throw new Error('服务未确认提交结果，请先检查任务与聊天记录，避免重复提交。')
      accepted = true
      if (!sameIdentity()) return true
      this.pendingPosts.delete(id)
      if (this.state.drafts[id] === text) this.setDraft(id, '')
      if (sameSelection()) {
        if (result.message && !this.state.messages.some(message => message.id === result.message!.id)) this.patch({ messages: [...this.state.messages, result.message] })
        if (result.task) this.toast('已加入任务队列，可在智能体工作台查看进度或人工接手。')
        const history = await api<{ session: Session; messages: Message[] }>(`/api/sessions/${encodeURIComponent(id)}`)
        if (sameSelection()) this.patch({ current: history.session, messages: history.messages || [] })
      }
      if (sameIdentity()) await this.refreshSessions()
      return true
    } catch (error) {
      if (sameSelection()) {
        if (error instanceof ApiError && error.status === 404) this.forget(id)
        else this.patch({ chatError: accepted ? '消息已提交，记录暂未刷新，请稍后重新连接，避免重复提交。' : errorMessage(error) })
      }
      return accepted
    } finally {
      if (sameIdentity()) { this.posting.delete(id); if (this.state.current?.id === id) this.patch({ submitting: false }) }
    }
  }
  async stop() {
    const id = this.state.current?.id
    if (!id || !this.canStop || this.state.stopping || this.disposed) return
    this.patch({ stopping: true }); const owner = this.identity, token = this.selection
    const valid = () => !this.disposed && owner === this.identity && token === this.selection && this.state.current?.id === id
    try { await api(`/api/sessions/${encodeURIComponent(id)}/abort`, { method: 'POST', body: {} }); if (valid() && !this.state.running) await this.synchronize() }
    catch (error) { if (valid()) this.toast(errorMessage(error)) }
    finally { if (valid()) this.patch({ stopping: false }) }
  }
  dispose() { if (this.disposed) return; this.clear(); this.channel?.close(); this.channel = null; this.listeners.clear(); this.disposed = true }
}
export const workspace = new WorkspaceStore()
export function useWorkspace() { return useSyncExternalStore(workspace.subscribe, workspace.snapshot) }
