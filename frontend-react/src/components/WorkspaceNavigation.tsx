import {Button,Dropdown,Nav} from '@douyinfe/semi-ui'
import {useEffect,useState} from 'react'
import {IconApps,IconCalendar,IconChevronDown,IconComment,IconConnectionPoint1,IconFile,IconHistory,IconMail,IconSetting,IconUserGroup} from '@douyinfe/semi-icons'
import type {View} from '../lib/types'
import {adminPrimaryViews,isView,managementViews,navigationSection,viewLabels} from '../lib/navigation'

interface Props{view:View;isAdmin:boolean;onNavigate(view:View):void}
const icons={agents:IconComment,skills:IconApps,schedules:IconCalendar,channels:IconConnectionPoint1,users:IconUserGroup,audit:IconHistory,events:IconFile,logs:IconFile}
export default function WorkspaceNavigation({view,isAdmin,onNavigate}:Props){
 const [compact,setCompact]=useState(()=>matchMedia('(max-width: 1200px)').matches),[manageOpen,setManageOpen]=useState(false)
 useEffect(()=>{const screen=matchMedia('(max-width: 1200px)'),change=()=>setCompact(screen.matches);screen.addEventListener('change',change);return()=>screen.removeEventListener('change',change)},[])
 useEffect(()=>{if(navigationSection(view)==='manage')setManageOpen(true)},[view])
 const section=navigationSection(view),selected=section==='manage'?view:section
 const choose=(item:{itemKey?:string|number})=>{if(isView(item.itemKey))onNavigate(item.itemKey)}
 return <>
  <nav className="desktop-workspace-navigation" aria-label="工作台分类"><Nav mode="vertical" isCollapsed={compact} selectedKeys={[selected]} onClick={choose} className="top-navigation side-navigation">
   <Nav.Item itemKey="chat" text="智能体" icon={<IconComment aria-hidden/>}/>
   <Nav.Item itemKey="tools" text="工具" icon={<IconApps aria-hidden/>}/>
   <Nav.Item itemKey="mailbox" text="邮件" icon={<IconMail aria-hidden/>}/>
   {isAdmin&&adminPrimaryViews.map(key=>{const Icon=icons[key];return <Nav.Item key={key} itemKey={key} text={viewLabels[key]} icon={<Icon aria-hidden/>}/>})}
  </Nav>{isAdmin&&(compact?<Dropdown trigger="click" position="rightTop" render={<Dropdown.Menu>{managementViews.map(key=>{const Icon=icons[key];return <Dropdown.Item key={key} icon={<Icon aria-hidden/>} onClick={()=>onNavigate(key)}>{viewLabels[key]}</Dropdown.Item>})}</Dropdown.Menu>}><Button className={`management-trigger compact ${section==='manage'?'is-active':''}`} theme="borderless" aria-label="管理" icon={<IconSetting aria-hidden/>}/></Dropdown>:<div className="management-navigation"><Button className={`management-trigger ${section==='manage'?'is-active':''}`} theme="borderless" aria-expanded={manageOpen} aria-controls="workspace-management-items" icon={<IconSetting aria-hidden/>} onClick={()=>setManageOpen(value=>!value)}>管理<IconChevronDown className={manageOpen?'is-open':''} aria-hidden/></Button>{manageOpen&&<div id="workspace-management-items" className="management-items">{managementViews.map(key=>{const Icon=icons[key];return <Button key={key} className={`management-item ${view===key?'is-active':''}`} theme="borderless" icon={<Icon aria-hidden/>} aria-current={view===key?'page':undefined} onClick={()=>onNavigate(key)}>{viewLabels[key]}</Button>})}</div>}</div>)}</nav>
  <Dropdown trigger="click" position="bottomLeft" render={<Dropdown.Menu>
   <Dropdown.Item onClick={()=>onNavigate('chat')} icon={<IconComment aria-hidden/>}>智能体</Dropdown.Item>
   <Dropdown.Item onClick={()=>onNavigate('tools')} icon={<IconApps aria-hidden/>}>工具</Dropdown.Item>
   <Dropdown.Item onClick={()=>onNavigate('mailbox')} icon={<IconMail aria-hidden/>}>邮件</Dropdown.Item>
   {isAdmin&&adminPrimaryViews.map(key=>{const Icon=icons[key];return <Dropdown.Item key={key} icon={<Icon aria-hidden/>} onClick={()=>onNavigate(key)}>{viewLabels[key]}</Dropdown.Item>})}
   {isAdmin&&<><Dropdown.Divider/><Dropdown.Title>管理</Dropdown.Title>{managementViews.map(key=>{const Icon=icons[key];return <Dropdown.Item key={key} icon={<Icon aria-hidden/>} onClick={()=>onNavigate(key)}>{viewLabels[key]}</Dropdown.Item>})}</>}
  </Dropdown.Menu>}><Button className="mobile-navigation" theme="borderless" aria-label="切换工作台页面">{section==='manage'?'管理':viewLabels[section]}<IconChevronDown aria-hidden/></Button></Dropdown>
 </>
}
