import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button, Checkbox, Input, Modal, Spin, Tag, Toast } from '@douyinfe/semi-ui';
import { api, errorMessage } from '../lib/api';
import type { MembersResponse, Session, User } from '../lib/types';
import UserAvatar from './UserAvatar';
import './management-dialogs.css';

interface Props { open: boolean; session: Session; user: User; onClose(): void; onChanged(): void }

export default function MembersDialog({ open, session, user, onClose, onChanged }: Props) {
  const id = useId();
  const [directory, setDirectory] = useState<User[]>([]), [roster, setRoster] = useState<MembersResponse | null>(null);
  const [query, setQuery] = useState(''), [chosen, setChosen] = useState<string[]>([]), [error, setError] = useState('');
  const [loading, setLoading] = useState(false), [saving, setSaving] = useState<'add' | 'remove' | null>(null), [removing, setRemoving] = useState<User | null>(null);
  const version = useRef(0), working = useRef(false), controller = useRef<AbortController>();

  useEffect(() => {
    const token = ++version.current, request = new AbortController(); controller.current = request;
    setDirectory([]); setRoster(null); setQuery(''); setChosen([]); setError(''); setRemoving(null); setSaving(null); working.current = false;
    if (!open) return () => { version.current++; request.abort(); };
    setLoading(true);
    void Promise.all([api<{ users: User[] }>('/api/directory', { signal: request.signal }), api<MembersResponse>(`/api/sessions/${encodeURIComponent(session.id)}/members`, { signal: request.signal })])
      .then(([people, members]) => { if (token === version.current) { setDirectory(people.users || []); setRoster(members); } })
      .catch(reason => { if (token === version.current && !request.signal.aborted) setError(errorMessage(reason)); })
      .finally(() => { if (token === version.current) setLoading(false); });
    return () => { version.current++; request.abort(); };
  }, [open, session.id]);

  const existing = useMemo(() => new Set(roster?.members.map(person => person.id) || []), [roster]);
  const candidates = useMemo(() => directory.filter(person => !person.disabled && `${person.displayName} ${person.username}`.toLowerCase().includes(query.toLowerCase())), [directory, query]);
  const canRemove = (person: User) => !!roster?.canRemoveMembers && person.id !== user.id && person.id !== roster.ownerId;
  function close() { if (!working.current) onClose(); }
  function toggle(personId: string) { setChosen(previous => previous.includes(personId) ? previous.filter(value => value !== personId) : [...previous, personId]); }
  async function add() {
    if (!chosen.length || working.current) return;
    const token = version.current; working.current = true; setSaving('add'); setError('');
    try {
      const result = await api<MembersResponse>(`/api/sessions/${encodeURIComponent(session.id)}/members`, { method: 'POST', body: { userIds: chosen }, signal: controller.current?.signal });
      if (token === version.current) { setRoster(result); setChosen([]); onChanged(); Toast.success('协作成员已添加。'); }
    } catch (reason) { if (token === version.current && !controller.current?.signal.aborted) setError(errorMessage(reason)); }
    finally { if (token === version.current) { working.current = false; setSaving(null); } }
  }
  async function remove() {
    if (!removing || !canRemove(removing) || working.current) return;
    const token = version.current, target = removing; working.current = true; setSaving('remove'); setError('');
    try {
      const result = await api<MembersResponse>(`/api/sessions/${encodeURIComponent(session.id)}/members/${encodeURIComponent(target.id)}`, { method: 'DELETE', body: {}, signal: controller.current?.signal });
      if (token === version.current) { setRoster(result); setRemoving(null); onChanged(); Toast.success('已移除协作成员。'); }
    } catch (reason) { if (token === version.current && !controller.current?.signal.aborted) setError(errorMessage(reason)); }
    finally { if (token === version.current) { working.current = false; setSaving(null); } }
  }

  return <Modal visible={open} title="协作成员" className="pi-management-modal" width={720} onCancel={close} maskClosable={!saving} closeOnEsc={!saving} closable={!saving}
    footer={<><Button theme="light" type="tertiary" disabled={!!saving} onClick={close}>关闭</Button><Button theme="solid" type="primary" loading={saving === 'add'} disabled={!chosen.length || !!saving || loading} onClick={() => void add()}>添加成员{chosen.length ? `（${chosen.length}）` : ''}</Button></>}>
    <p className="pi-dialog-description">邀请同事加入「{session.title}」，共同使用智能体并接续任务。</p>
    {error && <div className="pi-dialog-error" role="alert">{error}</div>}
    {loading ? <div className="pi-dialog-empty" role="status"><Spin />正在加载成员…</div> : <>
      <div className="pi-dialog-section-line"><strong>已加入 · {(roster?.members.length || 0) + (roster?.externalMembers?.length || 0)}</strong></div>
      <div className="pi-member-roster">
        {roster?.members.map(person => <div className="pi-member-row" key={person.id}>
          <UserAvatar className="pi-person-avatar" name={person.displayName} identity={person.id} />
          <div className="pi-person-copy"><strong>{person.displayName}{person.id === user.id && <Tag size="small" color="blue">我</Tag>}</strong><small>{person.id === roster.ownerId ? '创建人' : person.disabled ? '已停用' : person.username}</small></div>
          {canRemove(person) && <Button theme="borderless" type="danger" size="small" aria-label={`移除成员 ${person.displayName}`} disabled={!!saving} onClick={() => setRemoving(person)}>移除</Button>}
        </div>)}
        {roster?.externalMembers?.map(person => <div className="pi-member-row" key={person.id}><UserAvatar className="pi-person-avatar" name={person.displayName} identity={person.id} external /><div className="pi-person-copy"><strong>{person.displayName}</strong><small>{person.source === 'wecom' ? '企业微信' : '个人微信'}参与人</small></div></div>)}
      </div>
      {removing && <div className="pi-member-remove-confirm" role="group" aria-label="确认移除成员"><p>确认移除 {removing.displayName}？移除后将无法查看此空间。</p><div><Button theme="borderless" type="tertiary" disabled={!!saving} onClick={() => setRemoving(null)}>取消</Button><Button theme="solid" type="danger" loading={saving === 'remove'} disabled={!!saving} onClick={() => void remove()}>确认移除</Button></div></div>}
      <div className="pi-dialog-section pi-member-invites"><div className="pi-dialog-section-line"><strong>邀请同事</strong><span>每位成员都可以邀请</span></div>
        <label className="pi-visually-hidden" htmlFor={`invite-${id}`}>搜索同事姓名或账号</label><Input id={`invite-${id}`} value={query} onChange={setQuery} placeholder="搜索同事姓名或账号" showClear />
        <div className="pi-member-directory">{candidates.map(person => <Checkbox className="pi-member-choice" key={person.id} checked={existing.has(person.id) || chosen.includes(person.id)} disabled={existing.has(person.id) || !!saving} onChange={() => toggle(person.id)}>
          <span className="pi-member-choice-copy"><UserAvatar className="pi-person-avatar" name={person.displayName} identity={person.id} /><span className="pi-person-copy"><strong>{person.displayName}</strong><small>{person.username}</small></span>{existing.has(person.id) && <small className="pi-already-joined">已加入</small>}</span>
        </Checkbox>)}{!candidates.length && <p className="pi-dialog-empty">没有匹配的同事。</p>}</div>
      </div>
    </>}
  </Modal>;
}
