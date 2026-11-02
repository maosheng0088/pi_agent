import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Banner, Button, Checkbox, Input, Modal, Select, Space, Spin, Tabs, TabPane, Tag, TextArea, Toast } from '@douyinfe/semi-ui'
import { IconPlus, IconRefresh, IconSearch } from '@douyinfe/semi-icons'
import { api, ApiError, errorMessage } from '../lib/api'
import type { User } from '../lib/types'
import MessageContent from './MessageContent'
import {ExecutionProcessDialog} from './ExecutionProcess'
import './agent-workbench.css'

type Tab = 'tasks' | 'profile' | 'knowledge'
interface Props { sessionId: string; user: User; members: User[]; initialTab?: Tab; embedded?: boolean; configurationOnly?: boolean; readOnlyConfiguration?: boolean; initialTaskId?: string; initialDocumentId?: string; initialSourceVersion?: number; initialSourceUpdatedAt?: string; initialSourceCardId?: string; onChanged?(): void; onClose(): void }
interface Profile { roleName: string; responsibilities: string; rules: string; workflow: string; outputTemplate: string; audience: string; commonTasks: string; completionCriteria: string; responseExamples: string; version?: number }
type KnowledgePurpose = 'business' | 'development'
interface KnowledgeDocument { id: string; groupId?: string; title: string; sourceName?: string; format?: string; purpose?: KnowledgePurpose; version?: number; updatedAt?: string; content?: string }
interface SourceReference { documentId: string; version?: number; updatedAt?: string }
interface SourceReview { source: { documentId: string; title?: string; sourceName?: string; version?: number; updatedAt?: string; contentHash?: string; excerpt?: string; citation?: string; cited?: boolean }; current: KnowledgeDocument | null; state: 'current' | 'updated' | 'deleted' }
interface KnowledgeMatch { documentId?: string; id?: string; title?: string; sourceName?: string; purpose?: KnowledgePurpose; updatedAt?: string; excerpt?: string; snippet?: string; content?: string }
interface TaskEvent { id: string; type: string; actorId?: string; actorName?: string; content?: string; data?: { content?: string }; createdAt?: string }
interface BusinessTask { id: string; sessionId: string; title: string; instruction: string; status: string; createdBy?: string; createdByName?: string; assigneeId?: string; assigneeName?: string; skillId?: string; progress?: string | number; progressText?: string; result?: string; error?: string; createdAt?: string; updatedAt?: string; startedAt?: string; finishedAt?: string; events?: TaskEvent[] }
type TaskAction = 'takeover' | 'assign' | 'supplement' | 'resume' | 'complete' | 'cancel'
const emptyProfile: Profile = { roleName: '', responsibilities: '', rules: '', workflow: '', outputTemplate: '', audience: '', commonTasks: '', completionCriteria: '', responseExamples: '' }
const emptyDocument: { title: string; sourceName: string; content: string; purpose: KnowledgePurpose } = { title: '', sourceName: '', content: '', purpose: 'business' }
const knowledgePurposes = [{ value: 'business', label: '业务资料' }, { value: 'development', label: '开发说明' }]
const purposeName = (value?: KnowledgePurpose) => value === 'development' ? '开发说明' : '业务资料'
const states: Record<string, string> = { queued: '排队中', running: '执行中', waiting_human: '等待人工处理', succeeded: '已完成', failed: '执行失败', cancelled: '已取消', interrupted: '运行中断' }
const actionNames: Record<TaskAction, string> = { takeover: '人工接手', assign: '转交负责人', supplement: '补充材料', resume: '恢复 AI 处理', complete: '人工完成', cancel: '取消任务' }
const eventNames: Record<string, string> = { created: '创建任务', queued: '加入队列', started: '开始执行', succeeded: '执行完成', failed: '执行失败', cancelled: '任务取消', interrupted: '运行中断', takeover: '人工接手', assign: '转交负责人', supplement: '补充材料', resume: '恢复 AI 处理', complete: '人工完成', progress: '更新进度' }
function date(value?: string) { if (!value) return '尚未记录'; const time = new Date(value); return Number.isNaN(time.getTime()) ? value : time.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) }
function Field({ label, id, hint, children }: { label: string; id: string; hint?: string; children: ReactNode }) { return <div className="workbench-field"><label id={`${id}-label`} htmlFor={id}>{label}</label>{children}{hint && <small id={`${id}-hint`}>{hint}</small>}</div> }
function Status({ value }: { value: string }) { return <Tag color={value === 'succeeded' ? 'green' : value === 'failed' || value === 'interrupted' ? 'red' : value === 'waiting_human' ? 'orange' : value === 'queued' || value === 'running' ? 'blue' : 'grey'}>{states[value] || value}</Tag> }

export default function AgentWorkbench({ sessionId, user, members, initialTab = 'tasks', embedded = false, configurationOnly = false, readOnlyConfiguration = false, initialTaskId, initialDocumentId, initialSourceVersion, initialSourceUpdatedAt, initialSourceCardId, onChanged, onClose }: Props) {
  const [executionTask,setExecutionTask]=useState('')
  const targetTab: Tab = configurationOnly ? (initialTab === 'knowledge' ? 'knowledge' : 'profile') : initialDocumentId && (initialTab === 'knowledge' || !initialTaskId) ? 'knowledge' : initialTaskId ? 'tasks' : initialTab
  const fieldId = useId(), key = JSON.stringify([sessionId, user.id, user.role, configurationOnly, readOnlyConfiguration, targetTab, initialTaskId, initialDocumentId, initialSourceVersion, initialSourceUpdatedAt, initialSourceCardId])
  const currentKey = useRef(key); currentKey.current = key
  const [dataKey, setDataKey] = useState(key), [tab, setTab] = useState<Tab>(targetTab), [locked, setLocked] = useState(false), [error, setError] = useState('')
  const [profile, setProfile] = useState<Profile>(emptyProfile), [tasks, setTasks] = useState<BusinessTask[]>([]), [selectedTask, setSelectedTask] = useState<BusinessTask | null>(null)
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]), [matches, setMatches] = useState<KnowledgeMatch[]>([]), [selectedDocument, setSelectedDocument] = useState<KnowledgeDocument | null>(null)
  const [sourceReference, setSourceReference] = useState<SourceReference | null>(null)
  const [sourceReview, setSourceReview] = useState<SourceReview | null>(null)
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [detailLoading, setDetailLoading] = useState(false), [search, setSearch] = useState(''), [activeSearch, setActiveSearch] = useState('')
  const [creating, setCreating] = useState(false), [newTask, setNewTask] = useState({ title: '', instruction: '', assigneeId: '' }), [action, setAction] = useState<TaskAction | null>(null), [actionContent, setActionContent] = useState(''), [assigneeId, setAssigneeId] = useState(''), [acknowledged, setAcknowledged] = useState(false)
  const [editingDocument, setEditingDocument] = useState(false), [documentForm, setDocumentForm] = useState(emptyDocument), [deleteDocument, setDeleteDocument] = useState(false)
  const controller = useRef(new AbortController()), generation = useRef(0), pending = useRef(false), polling = useRef(false), lockRef = useRef(false), taskId = useRef(''), documentId = useRef(''), queryRef = useRef(''), createId = useRef(''), requests = useRef({ tasks: 0, detail: 0, knowledge: 0, document: 0 }), refreshRef = useRef<() => Promise<void>>(async () => {})
  const admin = user.role === 'admin', canConfigure = admin && !readOnlyConfiguration, visible = dataKey === key && !locked
  const people = members.filter(person => !person.disabled).map(person => ({ value: person.id, label: person.displayName || person.username }))
  function valid(token: number, context = key) { return generation.current === token && currentKey.current === context && !controller.current.signal.aborted && !lockRef.current }
  function clearPrivate() { setProfile(emptyProfile); setTasks([]); setSelectedTask(null); setDocuments([]); setMatches([]); setSelectedDocument(null); setSourceReference(null); setSourceReview(null); setDocumentForm(emptyDocument); setNewTask({ title: '', instruction: '', assigneeId: '' }); setActionContent(''); setEditingDocument(false); setCreating(false); setAction(null); taskId.current = ''; documentId.current = '' }
  function fail(reason: unknown, token: number, resource?: 'task' | 'document') {
    if (generation.current !== token || currentKey.current !== key || controller.current.signal.aborted) return
    if (reason instanceof ApiError && [401, 403, 404].includes(reason.status)) { lockRef.current = true; setLocked(true); clearPrivate(); controller.current.abort(); setError(reason.status === 404 ? resource === 'document' ? '引用的资料已被删除或你已无权访问，工作台内容已清除。请关闭后重新进入。' : resource === 'task' ? '此任务已被删除或你已无权访问，工作台内容已清除。请关闭后重新进入。' : '此群或资料已不可访问，工作台内容已清除。请关闭后重新进入。' : '登录已失效或已不在此群，工作台内容已清除。请关闭后重新进入。'); return }
    setError(errorMessage(reason))
  }
  function request<T>(path: string, options: { method?: string; body?: unknown } = {}) { return api<T>(`/api/sessions/${encodeURIComponent(sessionId)}${path}`, { ...options, signal: controller.current.signal }) }
  async function loadTasks() { const token = generation.current, sequence = ++requests.current.tasks; const data = await request<{ tasks: BusinessTask[] }>('/tasks'); if (valid(token) && sequence === requests.current.tasks) setTasks(data.tasks || []) }
  async function loadTask(id = taskId.current, showLoading = false) {
    if (!id) return
    const token = generation.current, sequence = ++requests.current.detail; if (showLoading) setDetailLoading(true)
    try { const data = await request<{ task: BusinessTask }>(`/tasks/${encodeURIComponent(id)}`); if (!valid(token) || sequence !== requests.current.detail || taskId.current !== id) return; if (!data.task || data.task.id !== id || data.task.sessionId !== sessionId) throw new ApiError('任务标识或群聊不匹配。', 404); setSelectedTask(data.task) }
    catch (reason) { if (valid(token) && sequence === requests.current.detail && taskId.current === id) throw reason }
    finally { if (valid(token) && sequence === requests.current.detail) setDetailLoading(false) }
  }
  async function loadKnowledge(query = queryRef.current) { const token = generation.current, sequence = ++requests.current.knowledge; const data = await request<{ documents: KnowledgeDocument[]; matches: KnowledgeMatch[] }>(`/knowledge?q=${encodeURIComponent(query)}&limit=20`); if (valid(token) && sequence === requests.current.knowledge && query === queryRef.current) { setDocuments(data.documents || []); setMatches(data.matches || []); setActiveSearch(query) } }
  async function refresh() { const token = generation.current; setError(''); try { await Promise.all([loadTasks(), loadTask()]) } catch (reason) { fail(reason, token) } }
  refreshRef.current = refresh
  useEffect(() => {
    const token = ++generation.current; controller.current = new AbortController(); lockRef.current = false; pending.current = false
    setDataKey(key); setLocked(false); clearPrivate(); setLoading(true); setDetailLoading(false); setBusy(false); setError(''); setTab(targetTab); setSearch(''); setActiveSearch(''); queryRef.current = ''
    const requestsToLoad: Promise<unknown>[] = [...(configurationOnly ? [] : [loadTasks()]), loadKnowledge(''), request<{ profile: Profile }>('/profile').then(data => { if (valid(token)) setProfile({ ...emptyProfile, ...data.profile }) })]
    if (targetTab === 'tasks' && initialTaskId) { taskId.current = initialTaskId; requestsToLoad.push(loadTask(initialTaskId, true).catch(reason => fail(reason, token, 'task'))) }
    if (targetTab === 'knowledge' && initialDocumentId) requestsToLoad.push(openDocument(initialDocumentId, {
      documentId: initialDocumentId,
      ...(Number.isSafeInteger(initialSourceVersion) && initialSourceVersion! > 0 ? { version: initialSourceVersion } : {}),
      ...(initialSourceUpdatedAt ? { updatedAt: initialSourceUpdatedAt } : {}),
    }, true, initialSourceCardId))
    void Promise.allSettled(requestsToLoad).then(results => {
      const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected'); if (failure) fail(failure.reason, token)
    }).finally(() => { if (generation.current === token && currentKey.current === key) setLoading(false) })
    return () => { generation.current++; controller.current.abort() }
  }, [key])
  useEffect(() => { if (configurationOnly) return; const timer = setInterval(async () => { if (document.hidden || pending.current || lockRef.current || polling.current) return; polling.current = true; try { await refreshRef.current() } finally { polling.current = false } }, 5000); return () => clearInterval(timer) }, [key])
  async function mutate(run: () => Promise<void>) { if (pending.current || lockRef.current) return; const token = generation.current; pending.current = true; setBusy(true); setError(''); try { await run() } catch (reason) { fail(reason, token) } finally { if (generation.current === token) { pending.current = false; setBusy(false) } } }
  async function saveProfile() { if (!canConfigure) return; await mutate(async () => { const token = generation.current; const data = await request<{ profile: Profile }>('/profile', { method: 'PATCH', body: { ...profile, expectedVersion: profile.version || 0 } }); if (!valid(token)) return; setProfile({ ...emptyProfile, ...data.profile }); onChanged?.(); Toast.success('岗位配置已保存，将用于后续任务。') }) }
  function openTask(task: BusinessTask) { if (busy) return; const token = generation.current; taskId.current = task.id; setSelectedTask(task); setCreating(false); setAction(null); setActionContent(''); setError(''); void loadTask(task.id, true).catch(reason => fail(reason, token, 'task')) }
  function openCreate() { taskId.current = ''; requests.current.detail++; setSelectedTask(null); setCreating(true); setAction(null); setNewTask({ title: '', instruction: '', assigneeId: '' }); createId.current = crypto.randomUUID(); setError('') }
  async function createTask() {
    await mutate(async () => { if (!newTask.instruction.trim()) throw new Error('请填写需要智能体完成的工作。'); const token = generation.current; const data = await request<{ task: BusinessTask }>('/tasks', { method: 'POST', body: { instruction: newTask.instruction.trim(), ...(newTask.title.trim() ? { title: newTask.title.trim() } : {}), ...(newTask.assigneeId ? { assigneeId: newTask.assigneeId } : {}), clientRequestId: createId.current } }); if (!valid(token)) return; setCreating(false); taskId.current = data.task.id; setSelectedTask(data.task); setNewTask({ title: '', instruction: '', assigneeId: '' }); onChanged?.(); await loadTasks(); Toast.success('任务已提交，智能体会按顺序处理。') })
  }
  function chooseAction(next: TaskAction) { setAction(next); setActionContent(''); setAssigneeId(''); setAcknowledged(false); setError('') }
  async function submitAction() {
    if (!selectedTask || !action) return
    const task = selectedTask, kind = action
    await mutate(async () => {
      if (kind === 'assign' && !assigneeId) throw new Error('请选择接手此任务的群成员。')
      if ((kind === 'supplement' || kind === 'complete') && !actionContent.trim()) throw new Error(kind === 'complete' ? '请填写处理结果，再标记人工完成。' : '请填写需要补充的资料。')
      if (kind === 'resume' && !acknowledged) throw new Error('请先核对已执行的操作，确认恢复不会造成重复处理。')
      const token = generation.current; requests.current.detail++
      const data = await request<{ task: BusinessTask }>(`/tasks/${encodeURIComponent(task.id)}/actions`, { method: 'POST', body: { action: kind, ...(assigneeId && kind === 'assign' ? { assigneeId } : {}), ...(actionContent.trim() ? { content: actionContent.trim() } : {}) } })
      if (!valid(token)) return; if (taskId.current === task.id) { setSelectedTask(data.task); setAction(null); setActionContent('') }; onChanged?.(); await loadTasks(); Toast.success(`${actionNames[kind]}已提交。`)
    })
  }
  async function openDocument(id: string, reference: SourceReference | null = null, initializing = false, cardId?: string) {
    if (busy && !initializing) return
    const token = generation.current, sequence = ++requests.current.document; documentId.current = id; setSelectedDocument(null); setSourceReference(reference); setSourceReview(null); setEditingDocument(false); setDeleteDocument(false); setError(''); setDetailLoading(true)
    try {
      const data = cardId ? await request<SourceReview>(`/message-cards/${encodeURIComponent(cardId)}/sources/${encodeURIComponent(id)}`) : await request<{ document: KnowledgeDocument }>(`/knowledge/${encodeURIComponent(id)}`)
      if (!valid(token) || sequence !== requests.current.document || documentId.current !== id) return
      if ('source' in data) {
        if (!data.source || data.source.documentId !== id || !['current', 'updated', 'deleted'].includes(data.state)) throw new ApiError('引用来源标识不匹配。', 404)
        if (data.state !== 'deleted' && (!data.current || data.current.id !== id || (data.current.groupId !== undefined && data.current.groupId !== sessionId))) throw new ApiError('当前资料标识或群聊不匹配。', 404)
        setSourceReview(data); setSourceReference({ documentId: id, version: data.source.version, updatedAt: data.source.updatedAt }); setSelectedDocument(data.state === 'deleted' ? null : data.current)
      } else {
        if (cardId || !data.document || data.document.id !== id || (data.document.groupId !== undefined && data.document.groupId !== sessionId)) throw new ApiError('资料标识或群聊不匹配。', 404)
        setSelectedDocument(data.document)
      }
    }
    catch (reason) { if (sequence === requests.current.document && documentId.current === id) fail(reason, token, 'document') } finally { if (valid(token) && sequence === requests.current.document) setDetailLoading(false) }
  }
  function editDocument(document?: KnowledgeDocument) { requests.current.document++; documentId.current = document?.id || ''; setSelectedDocument(document || null); setSourceReference(null); setSourceReview(null); setDocumentForm({ title: document?.title || '', sourceName: document?.sourceName || '', content: document?.content || '', purpose: document?.purpose === 'development' ? 'development' : 'business' }); setEditingDocument(true); setDeleteDocument(false); setError('') }
  async function chooseFile(file?: File) {
    if (!file) return
    const token = generation.current, sequence = ++requests.current.document
    try { if (!/\.(txt|md|markdown|csv|json)$/i.test(file.name)) throw new Error('请上传 TXT、Markdown、CSV 或 JSON 文件。'); if (file.size > 512 * 1024) throw new Error('单个知识文件不能超过 512 KB。'); const content = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()); if (valid(token) && sequence === requests.current.document) setDocumentForm(previous => ({ ...previous, sourceName: file.name, title: previous.title || file.name.replace(/\.[^.]+$/, ''), content })) }
    catch (reason) { fail(reason instanceof TypeError ? new Error('文件不是有效的 UTF-8 文本，请转换编码后重新上传。') : reason, token) }
  }
  async function saveDocument() {
    if (!canConfigure) return
    await mutate(async () => { if (!documentForm.title.trim() || !documentForm.content.trim()) throw new Error('请填写资料标题与正文。'); const token = generation.current, id = documentId.current; const data = await request<{ document: KnowledgeDocument }>(`/knowledge${id ? `/${encodeURIComponent(id)}` : ''}`, { method: id ? 'PATCH' : 'POST', body: { title: documentForm.title.trim(), sourceName: documentForm.sourceName.trim() || `${documentForm.title.trim()}.md`, content: documentForm.content, purpose: documentForm.purpose, expectedVersion: selectedDocument?.version || 0 } }); if (!valid(token)) return; documentId.current = data.document.id; setSelectedDocument({ ...data.document, content: data.document.content ?? documentForm.content }); setEditingDocument(false); setDocumentForm(emptyDocument); onChanged?.(); await loadKnowledge(); Toast.success('知识资料已保存。') })
  }
  async function removeDocument() { if (!canConfigure || !selectedDocument) return; const target = selectedDocument; await mutate(async () => { const token = generation.current; await request(`/knowledge/${encodeURIComponent(target.id)}?expectedVersion=${target.version || 0}`, { method: 'DELETE', body: {} }); if (!valid(token)) return; documentId.current = ''; setSelectedDocument(null); setDeleteDocument(false); onChanged?.(); await loadKnowledge(); Toast.success('知识资料已删除。') }) }
  function searchKnowledge() { queryRef.current = search.trim(); setError(''); const token = generation.current; void loadKnowledge().catch(reason => fail(reason, token)) }
  const managed = !!selectedTask && (admin || selectedTask.createdBy === user.id || selectedTask.assigneeId === user.id)
  const citedDocument = selectedDocument && sourceReference?.documentId === selectedDocument.id ? sourceReference : null
  const citedVersionDiffers = !!citedDocument?.version && citedDocument.version !== selectedDocument?.version
  const citedTimeDiffers = !!citedDocument?.updatedAt && (!selectedDocument?.updatedAt || Number(new Date(citedDocument.updatedAt)) !== Number(new Date(selectedDocument.updatedAt)))
  const citationWarning = citedVersionDiffers || citedTimeDiffers
  const citationNotice = citedDocument && !sourceReview && <Banner type={citationWarning ? 'warning' : 'info'} closeIcon={null} description={<span>
    {citationWarning ? '引用与当前资料版本不同。' : '以下展示资料的当前版本。'}引用版本 {citedDocument.version ?? '未记录'}，引用更新时间 {date(citedDocument.updatedAt)}；当前版本 {selectedDocument?.version ?? '未记录'}，当前更新时间 {date(selectedDocument?.updatedAt)}。
    {citationWarning ? '当前正文不是引用时的历史正文。' : !citedDocument.version && !citedDocument.updatedAt ? '此引用未记录版本，无法确认当前正文与引用时一致。' : '未读取历史版本正文。'}
  </span>} />
  const sourceReviewPanel = sourceReview && <section aria-label="引用时的资料片段">
    <h3>{sourceReview.source.title || sourceReview.source.sourceName || '引用来源'}</h3>
    <p className="workbench-help">引用时：{sourceReview.source.sourceName || '知识资料'} · 版本 {sourceReview.source.version ?? '未记录'} · 更新于 {date(sourceReview.source.updatedAt)}（北京时间）</p>
    {sourceReview.source.cited === false && <p className="workbench-help">此资料曾提供给智能体，但该回复未明确引用它。</p>}
    <Banner type={sourceReview.state === 'current' ? 'info' : 'warning'} closeIcon={null} description={sourceReview.state === 'deleted' ? '此资料当前已被删除。下方仅保留当时保存的引用片段，不是历史版本的完整正文。' : sourceReview.state === 'updated' ? '资料已更新。下方分别展示引用时保存的片段与当前版本正文，当前版本不是当时的历史正文。' : '下方先展示引用时保存的片段，再展示当前版本正文；引用片段不代表完整历史正文。'} />
    <h4>引用片段（非完整正文）</h4><pre className="workbench-document-content">{sourceReview.source.excerpt || '此引用未保存可显示的片段。'}</pre>
  </section>
  const active = !!selectedTask && ['queued', 'running', 'waiting_human', 'interrupted'].includes(selectedTask.status)
  const availableActions: TaskAction[] = selectedTask && active ? [
    ...((managed || !selectedTask.assigneeId) && (['queued', 'running'].includes(selectedTask.status) || selectedTask.assigneeId !== user.id) ? ['takeover' as const] : []),
    ...(managed ? ['assign' as const] : []),
    ...(managed && ['waiting_human', 'interrupted'].includes(selectedTask.status) ? ['supplement' as const] : []),
    ...(managed && ['waiting_human', 'interrupted'].includes(selectedTask.status) ? ['resume' as const, 'complete' as const] : []),
    ...(managed ? ['cancel' as const] : []),
  ] : []
  const profileFields: Array<{ key: Exclude<keyof Profile, 'version'>; label: string; hint: string; max: number; placeholder?: string; rows?: number }> = [
    { key: 'roleName', label: '岗位名称', hint: '例如：FBA 报价助手、提柜业务助手。', max: 120 },
    { key: 'audience', label: '服务对象', hint: '可选。说明谁会使用回答；默认以业务员工能直接理解和使用的表达为准，先说业务结果，再说必要依据。', max: 2000, rows: 3, placeholder: '例如：商务、客服、调度和财务员工。用业务语言说明结果、影响和下一步，避免后台术语。' },
    { key: 'responsibilities', label: '岗位职责', hint: '说明负责处理的业务和工作边界。', max: 12000 },
    { key: 'commonTasks', label: '常见任务', hint: '可选。列出员工常提出的问题、办理事项和期望得到的产物。', max: 8000, placeholder: '例如：查询提柜进度；核对柜号与日期；整理异常清单；生成可下载的交付文件。' },
    { key: 'rules', label: '业务规则', hint: '填写必须遵守的口径、校验条件与需转交人工的情况。', max: 12000 },
    { key: 'workflow', label: '处理流程', hint: '按顺序写出资料收集、检查、执行和交付步骤。', max: 12000 },
    { key: 'completionCriteria', label: '完成标准', hint: '可选。写清怎样才算业务办完；运行成功不等于业务结果正确，缺少依据时应说明待确认项。', max: 8000, placeholder: '例如：逐项核对柜号和日期；确认写入后的数据与要求一致；提供结果文件或可查来源；未完成项写明原因及下一步。' },
    { key: 'outputTemplate', label: '回复与交付模板', hint: '约定结果字段、格式和需要附带的依据。', max: 12000 },
    { key: 'responseExamples', label: '合格回复示例', hint: '可选。成功、失败和缺资料各写一个理想答复，用于统一此岗位的表达；占位示例不会自动保存。', max: 8000, rows: 6, placeholder: '成功：已核对 12 个柜号，10 个正常、2 个需确认，异常清单见附件。\n失败：本次更新未完成，尚未确认哪些记录受到影响；目标表暂时无法访问，请先核对数据和权限，再安排重试。\n缺资料：还缺柜号和计划提柜日期，补齐后我再核对安排。' },
  ]
  const content = <>
    <p className="workbench-description">岗位规范、知识资料与业务任务在此群内共享，协作记录随任务保留。</p>
    {error && <Banner type="danger" closeIcon={null} description={<span role="alert">{error}</span>} />}
    {!visible ? <div className="workbench-empty">此群的工作台内容已清除。</div> : loading ? <div className="workbench-empty"><Spin tip="正在加载工作台…" /></div> : <Tabs activeKey={tab} onChange={next => setTab(next as Tab)} type="line">
      {!configurationOnly && <TabPane tab={`任务中心（${tasks.length}）`} itemKey="tasks">
        <div className="workbench-toolbar"><span>任务依次执行 · 每 5 秒更新</span><Space><Button icon={<IconRefresh aria-hidden="true" />} disabled={busy} onClick={() => void refresh()}>刷新任务</Button><Button theme="solid" icon={<IconPlus aria-hidden="true" />} disabled={busy} onClick={openCreate}>创建业务任务</Button></Space></div>
        <div className="workbench-split"><nav className="workbench-list" aria-label="业务任务列表">{tasks.length ? tasks.map(task => <button type="button" className={`workbench-list-item ${selectedTask?.id === task.id && !creating ? 'selected' : ''}`} key={task.id} disabled={busy} onClick={() => openTask(task)}><span className="workbench-list-heading"><strong>{task.title || '业务任务'}</strong><Status value={task.status} /></span><span className="workbench-clamp">{task.instruction}</span><small>{task.assigneeName || '待分配负责人'} · {date(task.createdAt)}</small></button>) : <div className="workbench-empty">暂无业务任务，可创建任务或在群内请 AI 处理工作。</div>}</nav>
          <section className="workbench-detail" aria-label="业务任务详情">{creating ? <form onSubmit={event => { event.preventDefault(); void createTask() }}>
            <h3>创建业务任务</h3><Field label="任务标题" id={`${fieldId}-task-title`}><Input id={`${fieldId}-task-title`} value={newTask.title} maxLength={120} onChange={title => setNewTask(previous => ({ ...previous, title }))} /></Field>
            <Field label="工作要求" id={`${fieldId}-instruction`} hint="描述目标、资料和期望产物，任务将使用此智能体的岗位规范、知识与已授权技能。"><TextArea id={`${fieldId}-instruction`} value={newTask.instruction} rows={6} maxCount={20000} onChange={instruction => setNewTask(previous => ({ ...previous, instruction }))} /></Field>
            <Field label="负责人" id={`${fieldId}-task-assignee`}><Select id={`${fieldId}-task-assignee`} aria-labelledby={`${fieldId}-task-assignee-label`} value={newTask.assigneeId} optionList={[{ value: '', label: '暂不指定' }, ...people]} onChange={value => setNewTask(previous => ({ ...previous, assigneeId: String(value || '') }))} style={{ width: '100%' }} /></Field>
            <Space><Button disabled={busy} onClick={() => setCreating(false)}>取消创建</Button><Button theme="solid" htmlType="submit" loading={busy}>提交任务</Button></Space>
          </form> : selectedTask ? <>
            <header className="workbench-detail-header"><h3>{selectedTask.title || '业务任务'}</h3><Status value={selectedTask.status} />{detailLoading && <Spin size="small" />}</header>
            <dl className="workbench-metadata"><div><dt>创建人</dt><dd>{selectedTask.createdByName || '群成员'}</dd></div><div><dt>负责人</dt><dd>{selectedTask.assigneeName || '未分配'}</dd></div><div><dt>创建于</dt><dd>{date(selectedTask.createdAt)}</dd></div><div><dt>完成于</dt><dd>{selectedTask.finishedAt ? date(selectedTask.finishedAt) : '尚未完成'}</dd></div></dl>
            {admin&&<Button onClick={()=>setExecutionTask(selectedTask.id)}>查看执行过程</Button>}
            <h4>工作要求</h4><div className="workbench-text">{selectedTask.instruction}</div>
            {selectedTask.progress !== undefined && selectedTask.progress !== '' && <p className="workbench-help">当前进度：{selectedTask.progress}{typeof selectedTask.progress === 'number' ? '%' : ''}{selectedTask.progressText ? ` · ${selectedTask.progressText}` : ''}</p>}
            {selectedTask.error && <Banner type="danger" closeIcon={null} description={selectedTask.error} />}
            {selectedTask.result && <section className="workbench-result"><h4>交付结果</h4><MessageContent content={String(selectedTask.result)} /></section>}
            {!!availableActions.length && <div className="workbench-task-actions">{availableActions.map(kind => <Button key={kind} size="small" disabled={busy || detailLoading} type={kind === 'cancel' ? 'danger' : 'primary'} theme="light" onClick={() => chooseAction(kind)}>{actionNames[kind]}</Button>)}</div>}
            {action && <form className="workbench-action-form" onSubmit={event => { event.preventDefault(); void submitAction() }}><h4>{actionNames[action]}</h4>
              {action === 'takeover' && <p className="workbench-help">AI 处理将停止或移出队列，由你接续处理。已完成的业务操作会保留。</p>}
              {action === 'cancel' && <p className="workbench-help">取消将停止后续处理，已执行的外部业务操作不会自动撤销。</p>}
              {action === 'resume' && <p className="workbench-help">任务将重新加入 AI 队列，使用原要求与补充资料重新处理。请先核对已执行的外部操作，避免重复更新或提交。</p>}
              {action === 'assign' && <Field label="接手成员" id={`${fieldId}-assign`}><Select id={`${fieldId}-assign`} aria-labelledby={`${fieldId}-assign-label`} value={assigneeId} placeholder="选择群成员" optionList={people} onChange={value => setAssigneeId(String(value || ''))} style={{ width: '100%' }} /></Field>}
              <Field label={action === 'complete' ? '人工处理结果' : action === 'supplement' ? '补充资料' : '处理说明（选填）'} id={`${fieldId}-action-content`}><TextArea id={`${fieldId}-action-content`} rows={3} value={actionContent} maxCount={20000} onChange={setActionContent} /></Field>
              {action === 'resume' && <Checkbox checked={acknowledged} onChange={event => setAcknowledged(!!event.target.checked)}>我已核对已有操作，确认恢复不会造成重复处理</Checkbox>}
              <Space><Button disabled={busy} onClick={() => setAction(null)}>暂不处理</Button><Button theme="solid" type={action === 'cancel' ? 'danger' : 'primary'} htmlType="submit" loading={busy} disabled={action === 'resume' && !acknowledged}>确认{actionNames[action]}</Button></Space>
            </form>}
            <details className="workbench-events" open><summary>协作记录（{selectedTask.events?.length || 0}）</summary>{selectedTask.events?.length ? <ol>{selectedTask.events.map(event => <li key={event.id}><div><strong>{eventNames[event.type] || '任务更新'}</strong><small>{event.actorName || '系统'} · {date(event.createdAt)}</small></div>{(event.content || event.data?.content) && <p>{event.content || event.data?.content}</p>}</li>)}</ol> : <p className="workbench-help">尚无协作记录。</p>}</details>
          </> : detailLoading ? <div className="workbench-empty"><Spin tip="正在加载任务详情…" /></div> : <div className="workbench-empty">选择左侧任务，查看负责人、执行结果和协作记录。</div>}</section>
        </div>
      </TabPane>}
      <TabPane tab={readOnlyConfiguration ? "岗位规范" : "岗位配置"} itemKey="profile"><form className="workbench-profile" onSubmit={event => { event.preventDefault(); void saveProfile() }}><p className="workbench-help">此智能体独立使用本岗位配置。{canConfigure ? '各项可按需填写，保存后的规范将用于后续 AI 任务。' : '岗位规范由管理员维护，群成员可查看。'}</p>{profileFields.map(field => <Field key={field.key} id={`${fieldId}-${field.key}`} label={field.label} hint={field.hint}>{field.key === 'roleName' ? <Input id={`${fieldId}-${field.key}`} aria-describedby={`${fieldId}-${field.key}-hint`} value={profile[field.key]} disabled={!canConfigure || busy} maxLength={field.max} onChange={value => setProfile(previous => ({ ...previous, [field.key]: value }))} /> : <TextArea id={`${fieldId}-${field.key}`} aria-describedby={`${fieldId}-${field.key}-hint`} value={profile[field.key]} placeholder={field.placeholder} rows={field.rows || 4} disabled={!canConfigure || busy} maxCount={field.max} onChange={value => setProfile(previous => ({ ...previous, [field.key]: value }))} />}</Field>)}{canConfigure && <Button theme="solid" htmlType="submit" loading={busy}>保存岗位配置</Button>}</form></TabPane>
      <TabPane tab={`知识库（${documents.length}）`} itemKey="knowledge"><div className="workbench-toolbar"><form className="workbench-search" onSubmit={event => { event.preventDefault(); searchKnowledge() }}><Input aria-label="检索知识库" value={search} onChange={setSearch} placeholder="检索报价表、手册、客户要求" showClear prefix={<IconSearch aria-hidden="true" />} /><Button htmlType="submit" disabled={busy}>检索</Button></form>{canConfigure && <Button theme="solid" icon={<IconPlus aria-hidden="true" />} disabled={busy} onClick={() => editDocument()}>添加知识资料</Button>}</div>
        {activeSearch && <p className="workbench-help">“{activeSearch}” · 找到 {matches.length} 个相关片段 · 可查看资料来源和更新时间；开发说明仅在明确技术请求时提供给智能体</p>}
        <div className="workbench-split"><nav className="workbench-list" aria-label="知识资料列表">{activeSearch ? matches.length ? matches.map((match, index) => <button type="button" key={`${match.documentId || match.id}-${index}`} className="workbench-list-item" disabled={busy || !(match.documentId || match.id)} onClick={() => void openDocument(match.documentId || match.id || '')}><strong>{match.title || match.sourceName || '相关资料'}</strong><span className="workbench-clamp">{match.excerpt || match.snippet || match.content || ''}</span><small>{purposeName(match.purpose)} · {match.sourceName || '知识库资料'} · {date(match.updatedAt)}</small></button>) : <div className="workbench-empty">没有匹配资料，请尝试其他关键词。</div> : documents.length ? documents.map(document => <button type="button" key={document.id} className={`workbench-list-item ${selectedDocument?.id === document.id ? 'selected' : ''}`} disabled={busy} onClick={() => void openDocument(document.id)}><strong>{document.title}</strong><span>{document.sourceName || '知识资料'}</span><small>{purposeName(document.purpose)} · 版本 {document.version || 1} · {date(document.updatedAt)}</small></button>) : <div className="workbench-empty">暂无知识资料。{admin ? '可以上传文本文件或直接编写业务知识。' : '请联系管理员添加业务资料。'}</div>}</nav>
          <section className="workbench-detail" aria-label="知识资料详情">{!editingDocument && sourceReviewPanel}{editingDocument && canConfigure ? <form onSubmit={event => { event.preventDefault(); void saveDocument() }}><h3>{selectedDocument ? '编辑知识资料' : '添加知识资料'}</h3><Field id={`${fieldId}-file`} label="上传文本文件" hint="支持 UTF-8 编码的 TXT、Markdown、CSV、JSON，单个文件不超过 512 KB。"><input id={`${fieldId}-file`} type="file" accept=".txt,.md,.markdown,.csv,.json" disabled={busy} onChange={event => { void chooseFile(event.target.files?.[0]); event.target.value = '' }} /></Field><Field label="资料标题" id={`${fieldId}-document-title`}><Input id={`${fieldId}-document-title`} value={documentForm.title} maxLength={120} disabled={busy} onChange={title => setDocumentForm(previous => ({ ...previous, title }))} /></Field><Field label="资料用途" id={`${fieldId}-document-purpose`} hint="业务资料用于日常业务回答；开发说明仅在明确技术请求时提供给智能体。群成员仍可查看两类资料。"><Select id={`${fieldId}-document-purpose`} aria-labelledby={`${fieldId}-document-purpose-label`} aria-describedby={`${fieldId}-document-purpose-hint`} value={documentForm.purpose} optionList={knowledgePurposes} disabled={busy} style={{width:'100%'}} onChange={value => setDocumentForm(previous => ({ ...previous, purpose: value === 'development' ? 'development' : 'business' }))}/></Field><Field label="来源文件名" id={`${fieldId}-source-name`}><Input id={`${fieldId}-source-name`} value={documentForm.sourceName} maxLength={180} disabled={busy} onChange={sourceName => setDocumentForm(previous => ({ ...previous, sourceName }))} /></Field><Field label="知识正文" id={`${fieldId}-document-content`}><TextArea id={`${fieldId}-document-content`} value={documentForm.content} rows={12} disabled={busy} onChange={content => setDocumentForm(previous => ({ ...previous, content }))} /></Field><Space><Button disabled={busy} onClick={() => { setEditingDocument(false); setDocumentForm(emptyDocument) }}>取消编辑</Button><Button theme="solid" htmlType="submit" loading={busy}>保存知识资料</Button></Space></form> : detailLoading && !selectedDocument ? <div className="workbench-empty"><Spin tip="正在加载资料…" /></div> : selectedDocument ? <>{sourceReview && <h3>当前资料正文</h3>}{citationNotice}<h3>{selectedDocument.title}</h3><p className="workbench-help">用途：{purposeName(selectedDocument.purpose)}<br />来源：{selectedDocument.sourceName || '管理员录入'} · 版本 {selectedDocument.version || 1}<br />更新于 {date(selectedDocument.updatedAt)}（北京时间）</p>{canConfigure && <Space><Button size="small" disabled={busy} onClick={() => editDocument(selectedDocument)}>编辑资料</Button><Button size="small" type="danger" theme="borderless" disabled={busy} onClick={() => setDeleteDocument(true)}>删除资料</Button></Space>}{deleteDocument && <div className="workbench-action-form"><p>确认删除“{selectedDocument.title}”？后续任务将不再检索此资料。</p><Space><Button disabled={busy} onClick={() => setDeleteDocument(false)}>保留资料</Button><Button type="danger" theme="solid" loading={busy} onClick={() => void removeDocument()}>确认删除资料</Button></Space></div>}<pre className="workbench-document-content">{selectedDocument.content || '资料内容为空。'}</pre></> : sourceReview?.state === 'deleted' ? <p className="workbench-help">当前资料已不可用，引用片段仅用于复查当时的依据。</p> : <div className="workbench-empty">选择资料查看完整内容、来源和更新时间。</div>}</section>
        </div>
      </TabPane>
    </Tabs>}
    {admin&&executionTask&&visible&&<ExecutionProcessDialog user={user} workTaskId={executionTask} onClose={()=>setExecutionTask('')}/>}
  </>
  return embedded ? <section className="agent-workbench-embedded" aria-label="岗位规范与知识库">{content}</section> : <Modal visible title="智能体工作台" className="agent-workbench-modal" width={1040} onCancel={onClose} footer={<Button onClick={onClose}>关闭工作台</Button>}>{content}</Modal>
}



