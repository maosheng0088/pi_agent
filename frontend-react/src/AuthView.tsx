import {useRef,useState,type FormEvent} from 'react'
import {Button,Input,Banner,Typography} from '@douyinfe/semi-ui'
import {IconUser,IconLock,IconArrowRight} from '@douyinfe/semi-icons'
import {workspace,useWorkspace} from './lib/workspace'
import {uiArtwork} from './lib/artwork'
import CompanyLogo from './components/CompanyLogo'
export default function AuthView(){
 const state=useWorkspace(),[username,setUsername]=useState(''),[password,setPassword]=useState(''),[confirm,setConfirm]=useState(''),[name,setName]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),working=useRef(false)
 const setup=state.setupRequired
 async function submit(event:FormEvent){
  event.preventDefault();if(working.current||!username.trim()||!password)return;setError('')
  if(setup){
   if(!name.trim()){setError('请输入管理员姓名。');return}
   if(password.length<8){setError('新密码须为 8 至 128 个字符。');return}
   if(password!==confirm){setError('两次输入的密码不一致。');return}
  }
  working.current=true;setBusy(true)
  try{await workspace.authenticate(username,password,name.trim())}catch{}finally{setPassword('');setConfirm('');working.current=false;setBusy(false)}
 }
 return <main className="auth-shell"><section className="auth-story"><div className="auth-company-brand"><CompanyLogo variant="full"/><div className="auth-brand-caption"><strong>企业智能体工作台</strong><small>TEAM WORKSPACE</small></div></div><div><span className="eyebrow">AI × 团队协作</span><h1>专业智能体，<br/>和团队一起工作。</h1><p>让知识、技能与任务在同一个协作空间流动。</p><img src={uiArtwork.reading} alt=""/></div><small>DREAMWAY 企业智能体工作台</small></section><section className="auth-panel"><form onSubmit={submit}><Typography.Title heading={3}>{setup?'创建管理员':'欢迎回来'}</Typography.Title><p className="muted">{setup?'完成首次设置，开始管理团队的智能体。':'登录后进入你参与的智能体协作空间。'}</p>{(error||state.authError)&&<Banner type="danger" description={error||state.authError} closeIcon={null}/>} {setup&&!state.setupAllowed?<Banner type="warning" description="请由服务所在电脑完成首次管理员设置。"/>:<>
 <label className="field-label" htmlFor="login-account">账号</label><Input id="login-account" prefix={<IconUser aria-hidden/>} value={username} onChange={setUsername} maxLength={48} autoComplete="username" disabled={busy} placeholder="请输入账号"/>
 {setup&&<><label className="field-label" htmlFor="login-name">姓名</label><Input id="login-name" value={name} onChange={setName} maxLength={80} autoComplete="name" disabled={busy} placeholder="管理员姓名"/></>}
 <label className="field-label" htmlFor="login-password">密码</label><Input id="login-password" prefix={<IconLock aria-hidden/>} mode="password" value={password} onChange={setPassword} maxLength={128} autoComplete={setup?'new-password':'current-password'} disabled={busy} placeholder={setup?'设置 8 至 128 位密码':'请输入密码'}/>
 {setup&&<><label className="field-label" htmlFor="login-confirm">确认密码</label><Input id="login-confirm" mode="password" value={confirm} onChange={setConfirm} maxLength={128} autoComplete="new-password" disabled={busy} placeholder="再次输入密码"/></>}
 <Button htmlType="submit" theme="solid" type="primary" block size="large" loading={busy} disabled={!username.trim()||!password} icon={<IconArrowRight aria-hidden/>} iconPosition="right">{setup?'创建并进入':'进入工作台'}</Button></>}<small className="auth-note"><IconLock aria-hidden/>仅可访问你已加入的协作空间</small></form></section></main>
}
