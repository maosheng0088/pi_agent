import type {View} from './types'

export const viewLabels:Record<View,string>={chat:'智能体',agents:'智能体管理',tools:'工具',ocean:'海运工具',skills:'技能中心',schedules:'定时任务',channels:'消息渠道',users:'员工管理',audit:'聊天审计',events:'操作记录',logs:'系统日志'}
export const adminPrimaryViews=['skills','schedules','channels'] as const
export const managementViews=['agents','users','audit','events','logs'] as const
export function isView(value:unknown):value is View{return typeof value==='string'&&Object.hasOwn(viewLabels,value)}
export function isPublicView(view:View){return view==='chat'||view==='tools'||view==='ocean'}
export function navigationSection(view:View):'chat'|'tools'|'skills'|'schedules'|'channels'|'manage'{return view==='chat'?'chat':view==='tools'||view==='ocean'?'tools':view==='skills'||view==='schedules'||view==='channels'?view:'manage'}
export function toolViewFromHash(hash:string):'tools'|'ocean'|null{const view=new URLSearchParams(hash.replace(/^#/,'' )).get('view');return view==='tools'||view==='ocean'?view:null}
export function workspaceViewFromHash(hash:string):'tools'|'ocean'|'agents'|null{return new URLSearchParams(hash.replace(/^#/,'' )).get('view')==='agents'?'agents':toolViewFromHash(hash)}
