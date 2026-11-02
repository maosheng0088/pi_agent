import { useEffect, useState } from 'react'
import { Banner, Tabs, TabPane } from '@douyinfe/semi-ui'
import type { User } from '../lib/types'
import AdminLogsPage from './AdminLogsPage'
import AdministrationPage from './AdministrationPage'
import ExecutionProcess from '../components/ExecutionProcess'
import './admin-logs-center.css'

function LogsCenter({ user }: { user: User }) {
  const [tab, setTab] = useState('runtime'), [locked, setLocked] = useState(false)
  useEffect(() => {
    const expire = () => setLocked(true)
    window.addEventListener('pi:auth-expired', expire)
    return () => window.removeEventListener('pi:auth-expired', expire)
  }, [])
  if (locked) return <Banner type="warning" description="登录已失效，日志内容已清除。请重新登录。" />
  return <section className="admin-logs-center" aria-label="管理员日志中心">
    <Tabs activeKey={tab} onChange={setTab} keepDOM={false} lazyRender aria-label="日志类型">
      <TabPane itemKey="runtime" tab="运行日志" />
      <TabPane itemKey="executions" tab="智能体执行" />
      <TabPane itemKey="conversations" tab="所有对话" />
    </Tabs>
    {tab === 'conversations' && <p className="admin-logs-conversations-note">管理员可查阅所有智能体的协作记录，无需加入群聊。关键词筛选智能体、创建人或参与人；详情包含原始持久消息与历史分支，群内讨论可分页加载更早记录。</p>}
    <div className="admin-logs-center-content" key={tab}>{tab === 'runtime' ? <AdminLogsPage user={user} /> : tab === 'executions' ? <ExecutionProcess user={user}/> : <AdministrationPage view="audit" user={user} />}</div>
  </section>
}

export default function AdminLogsCenter({ user }: { user: User }) {
  if (user.role !== 'admin') return <Banner type="warning" description="仅管理员可查看日志与所有对话。" />
  return <LogsCenter key={`${user.id}:${user.role}`} user={user} />
}
