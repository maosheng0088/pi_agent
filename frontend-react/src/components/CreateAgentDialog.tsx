import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button, Checkbox, Form, Input, Modal, Spin, Tag, Toast } from '@douyinfe/semi-ui';
import { api, errorMessage } from '../lib/api';
import { channelIdentity } from '../lib/artwork';
import type { Session, Skill, User } from '../lib/types';
import AgentAvatar from './AgentAvatar';
import AvatarPicker from './AvatarPicker';
import ChannelMark from './ChannelMark';
import './management-dialogs.css';

interface Props { open: boolean; user: User; onClose(): void; onCreated(id: string): void }
interface Channel { id: string; name: string; type: string; sessionId?: string | null; connectionMode?: 'websocket' | 'webhook' }
function toggleId(previous: string[], id: string) { return previous.includes(id) ? previous.filter(value => value !== id) : [...previous, id]; }

export default function CreateAgentDialog({ open, user, onClose, onCreated }: Props) {
  const id = useId(), formId = `create-agent-${id}`;
  const [title, setTitle] = useState(''), [avatarId, setAvatarId] = useState('');
  const [skills, setSkills] = useState<Skill[]>([]), [directory, setDirectory] = useState<User[]>([]), [channels, setChannels] = useState<Channel[]>([]);
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]), [selectedPeople, setSelectedPeople] = useState<string[]>([]), [selectedChannels, setSelectedChannels] = useState<string[]>([]);
  const [query, setQuery] = useState(''), [error, setError] = useState(''), [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [createdId, setCreatedId] = useState('');
  const version = useRef(0), working = useRef(false), created = useRef(''), controller = useRef<AbortController>();

  useEffect(() => {
    const token = ++version.current, request = new AbortController(); controller.current = request;
    working.current = false; created.current = ''; setCreatedId(''); setBusy(false); setTitle(''); setAvatarId(''); setSkills([]); setDirectory([]); setChannels([]);
    setSelectedSkills([]); setSelectedPeople([]); setSelectedChannels([]); setQuery(''); setError(''); setLoading(false);
    if (!open) return () => { version.current++; request.abort(); };
    if (user.role !== 'admin') { setError('仅管理员可创建智能体。'); return () => { version.current++; request.abort(); }; }
    setLoading(true);
    void Promise.all([api<{ skills: Skill[] }>('/api/skills', { signal: request.signal }), api<{ users: User[] }>('/api/directory', { signal: request.signal }), api<{ channels: Channel[] }>('/api/admin/channels', { signal: request.signal })])
      .then(([skillResult, people, channelResult]) => { if (token === version.current) { setSkills(skillResult.skills || []); setDirectory(people.users || []); setChannels(channelResult.channels || []); } })
      .catch(reason => { if (token === version.current && !request.signal.aborted) setError(errorMessage(reason)); })
      .finally(() => { if (token === version.current) setLoading(false); });
    return () => { version.current++; request.abort(); };
  }, [open, user.id, user.role]);

  const globalSkills = useMemo(() => skills.filter(skill => skill.scope !== 'groups' && skill.enabled), [skills]);
  const availableSkills = useMemo(() => skills.filter(skill => skill.scope === 'groups' && skill.enabled), [skills]);
  const people = useMemo(() => directory.filter(person => person.id !== user.id && !person.disabled && `${person.displayName} ${person.username}`.toLowerCase().includes(query.toLowerCase())), [directory, user.id, query]);
  function close() { if (working.current) { Toast.info('正在保存配置，请稍候。'); return; } onClose(); }
  async function save() {
    if (working.current || loading || !title.trim() || user.role !== 'admin') return;
    working.current = true; setBusy(true); setError(''); const token = version.current;
    try {
      if (!created.current) {
        const result = await api<{ session: Session }>('/api/sessions', { method: 'POST', body: { title: title.trim(), avatarId, ...(selectedChannels.length ? { channelIds: selectedChannels } : {}) }, signal: controller.current?.signal });
        if (token !== version.current) return;
        created.current = result.session.id; setCreatedId(result.session.id);
      }
      const sessionId = created.current;
      if (selectedPeople.length) await api(`/api/sessions/${encodeURIComponent(sessionId)}/members`, { method: 'POST', body: { userIds: selectedPeople }, signal: controller.current?.signal });
      for (const skill of availableSkills.filter(item => selectedSkills.includes(item.id))) {
        if (token !== version.current) return;
        await api(`/api/admin/skills/${encodeURIComponent(skill.id)}`, { method: 'PATCH', body: { scope: 'groups', groupIds: [...new Set([...(skill.groupIds || []), sessionId])] }, signal: controller.current?.signal });
      }
      if (token === version.current) { onCreated(sessionId); Toast.success('智能体已创建，可以开始协作。'); onClose(); }
    } catch (reason) {
      if (token === version.current && !controller.current?.signal.aborted) setError(`${created.current ? '智能体已创建，部分配置未完成。可重试完成配置，或稍后在管理页调整。\n' : ''}${errorMessage(reason)}`);
    } finally { if (token === version.current) { working.current = false; setBusy(false); } }
  }

  return <Modal visible={open} title="创建专业智能体" className="pi-management-modal" width={760} onCancel={close} maskClosable={!busy} closeOnEsc={!busy} closable={!busy}
    footer={<><Button theme="light" type="tertiary" disabled={busy} onClick={close}>取消</Button><Button type="primary" theme="solid" htmlType="submit" form={formId} loading={busy} disabled={loading || !title.trim() || user.role !== 'admin'}>{createdId ? '完成配置' : '创建智能体'}</Button></>}>
    <p className="pi-dialog-description">为一项专业工作配置技能，邀请相关同事共同协作。每个智能体拥有独立会话和工作目录，成员在该智能体内共享资料。</p>
    {error && <div className="pi-dialog-error pi-preserve-lines" role="alert">{error}</div>}
    <Form id={formId} className="pi-dialog-form" onSubmit={() => void save()}>
      <div className="pi-create-identity"><AgentAvatar title={title || '专业智能体'} avatarId={avatarId} size={64} /><div className="pi-dialog-field"><label htmlFor={`agent-name-${id}`}>智能体名称</label><Input id={`agent-name-${id}`} value={title} onChange={setTitle} maxLength={120} placeholder="例如：报价助手、提柜助手、财务助手" disabled={busy || !!createdId} autoFocus /></div></div>
      <AvatarPicker businessTitle={title} value={avatarId} onChange={setAvatarId} label="智能体头像" disabled={busy || !!createdId || user.role !== 'admin'} />
      {loading ? <div className="pi-dialog-empty" role="status"><Spin />正在读取可用技能和成员…</div> : <>
        <section className="pi-dialog-section"><div className="pi-dialog-section-line"><h3>分配专业技能</h3><span>{globalSkills.length + selectedSkills.length} 项</span></div><p className="pi-dialog-help">全局共享技能自动可用，也可以添加指定范围的技能。</p>
          {globalSkills.map(skill => <div key={skill.id} className="pi-skill-choice pi-skill-shared"><Checkbox checked disabled aria-label={`${skill.name}，全局共享`} /><div className="pi-skill-choice-copy"><strong>{skill.name}</strong><small>{skill.description || '团队共享能力'}</small></div><Tag size="small" color="blue">全局共享</Tag></div>)}
          {availableSkills.map(skill => <Checkbox className="pi-skill-choice" key={skill.id} checked={selectedSkills.includes(skill.id)} disabled={busy} onChange={() => setSelectedSkills(previous => toggleId(previous, skill.id))}><span className="pi-skill-choice-copy"><strong>{skill.name}</strong><small>{skill.description || '可分配到此智能体'}</small></span></Checkbox>)}
          {!skills.some(skill => skill.enabled) && <p className="pi-dialog-help">暂无已启用技能。创建后可在技能中心导入 ZIP 并分配。</p>}
        </section>
        <section className="pi-dialog-section"><div className="pi-dialog-section-line"><h3>邀请协作成员</h3><span>{selectedPeople.length + 1} 人</span></div><p className="pi-dialog-help">你将自动加入。成员可以邀请同事，加入后共享此空间的历史记录。</p>
          <label className="pi-visually-hidden" htmlFor={`agent-people-${id}`}>搜索员工姓名或账号</label><Input id={`agent-people-${id}`} value={query} onChange={setQuery} placeholder="搜索姓名或账号" showClear />
          <div className="pi-create-people">{people.map(person => <Checkbox key={person.id} checked={selectedPeople.includes(person.id)} disabled={busy} onChange={() => setSelectedPeople(previous => toggleId(previous, person.id))}><span>{person.displayName}</span><small>{person.username}</small></Checkbox>)}{!people.length && <p className="pi-dialog-help">没有匹配的员工。</p>}</div>
        </section>
        {!!channels.length && <section className="pi-dialog-section"><div className="pi-dialog-section-line"><h3>绑定消息渠道</h3><span>可选</span></div><p className="pi-dialog-help">绑定长连接渠道可互通新消息；绑定 Webhook 可向企业微信群推送回复和任务结果。</p>
          {channels.map(channel => <Checkbox className="pi-channel-choice" key={channel.id} checked={selectedChannels.includes(channel.id)} disabled={busy || !!createdId || !!channel.sessionId} onChange={() => setSelectedChannels(previous => toggleId(previous, channel.id))}><span className="pi-channel-choice-copy"><ChannelMark type={channel.type} size={32} /><span><strong>{channel.name}</strong><small>{channel.sessionId ? '已绑定其他智能体' : channel.type === 'wecom' && channel.connectionMode === 'webhook' ? '企业微信群 · 仅发送通知' : channelIdentity(channel.type).label}</small></span></span></Checkbox>)}
        </section>}
      </>}
    </Form>
  </Modal>;
}
