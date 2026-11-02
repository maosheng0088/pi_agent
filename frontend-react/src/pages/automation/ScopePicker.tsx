import { useId, useMemo, useState } from 'react'
import { Checkbox, Input, Select, Tag, Typography } from '@douyinfe/semi-ui'
import type { Session } from '../../lib/types'

export function ScopePicker({ scope, groupIds, sessions, onChange, disabled = false }: { scope: string; groupIds: string[]; sessions: Session[]; onChange(value: { scope: string; groupIds: string[] }): void; disabled?: boolean }) {
  const id = useId(), [query, setQuery] = useState('')
  const choices = useMemo(() => {
    const result = sessions.map(group => ({ id: group.id, title: group.title || '未命名智能体', accessible: true }))
    for (const selected of groupIds) if (!result.some(group => group.id === selected)) result.push({ id: selected, title: '已授权智能体（目前不可访问）', accessible: false })
    return result.filter(group => group.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  }, [sessions, groupIds, query])
  return <div className="automation-scope">
    <label id={`${id}-scope-label`} className="automation-field-label" htmlFor={`${id}-scope`}>共享范围</label>
    <Select id={`${id}-scope`} aria-labelledby={`${id}-scope-label`} aria-label="共享范围" value={scope} disabled={disabled} style={{ width: '100%' }} optionList={[{ value: 'all', label: '全部智能体共享' }, { value: 'groups', label: '仅指定智能体' }]} onChange={value => onChange({ scope: String(value), groupIds })} />
    <p className="automation-help">{scope === 'all' ? '包含当前及今后创建的智能体，员工仍需加入相应业务空间才能使用。' : '仅授权智能体的协作成员及其定时任务可以使用此技能。'}</p>
    {scope === 'groups' && <div className="automation-scope-box">
      <Input id={`${id}-search`} value={query} onChange={setQuery} placeholder="搜索智能体" aria-label="搜索可授权的智能体" disabled={disabled} showClear />
      <p className="automation-scope-count" aria-live="polite"><Tag color="blue">已选择 {groupIds.length} 个智能体</Tag></p>
      <div className="automation-scope-choices">{choices.length ? choices.map(group => <Checkbox key={group.id} checked={groupIds.includes(group.id)} disabled={disabled} onChange={event => onChange({ scope, groupIds: event.target.checked ? [...new Set([...groupIds, group.id])] : groupIds.filter(value => value !== group.id) })}><span>{group.title}{!group.accessible && <small>历史授权，可保留或取消。</small>}</span></Checkbox>) : <Typography.Text type="tertiary">{query ? '没有匹配的智能体' : '请先创建或加入智能体业务空间。'}</Typography.Text>}</div>
      <p className="automation-help">只展示你已加入的智能体；不可访问的历史授权会隐藏名称。</p>
    </div>}
  </div>
}
