import type {Skill} from './types'
export const cloudProviderIds=['tencent','kdocs','wps365'] as const
export type CloudProviderId=typeof cloudProviderIds[number]
export type CloudAuthorization={id:string;url?:string;status:'instructions'|'pending'|'ready'|'expired'|'error';expiresAt?:string;message?:string}
export interface CloudProvider{id:CloudProviderId;name:string;installed:boolean;toolVersion?:string;configured:boolean;status:'not_installed'|'not_configured'|'ready'|'error'|'authorizing';message?:string;checkedAt?:string;authorizationUrl?:string;authorization?:CloudAuthorization;skills:Skill[]}
export const cloudProviderInfo={
 tencent:{name:'腾讯文档',audience:'腾讯文档账号',description:'连接账号有权访问的腾讯文档与表格。',requirement:'可用能力受文档权限及平台账号权益限制。'},
 kdocs:{name:'金山文档',audience:'个人账号',description:'面向个人金山文档账号，与企业 WPS365 分开配置。',requirement:'部分功能可能需要相应会员权益，以平台授权提示为准。'},
 wps365:{name:'WPS365',audience:'企业账号',description:'通过企业应用连接企业组织内的文档服务。',requirement:'需要企业开放平台应用、企业管理员授权及对应接口权限。'},
} as const
export const cloudStatusNames={not_installed:'环境未就绪',not_configured:'待配置',ready:'连接就绪',error:'需要处理',authorizing:'等待授权'} as const
export function cloudFeedback(value:unknown,secrets:string[]=[]){let text=typeof value==='string'?value:'操作失败，请重试。';for(const secret of secrets)if(secret)text=text.split(secret).join('（已隐藏）');return text.replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,350)}
export function cloudAuthorizationUrl(value?:string){
 if(typeof value!=='string'||value.length>4096||/[\u0000-\u0020\u007f\\]/.test(value))return
 try{
  const url=new URL(value),hosts=['docs.qq.com','www.kdocs.cn','365.kdocs.cn','open.wps.cn','account.wps.cn','account.wps.com','wps.cn']
  if(url.protocol!=='https:'||url.username||url.password||url.port||!hosts.includes(url.hostname)&&!url.hostname.endsWith('.wps.cn'))return
  const secretKeys=new Set(['accesstoken','refreshtoken','token','clientsecret','cookie','password'])
  if([...url.searchParams.keys()].some(key=>secretKeys.has(key.toLowerCase().replace(/[_-]/g,'')))||/[?&#](?:access_?token|refresh_?token|token|client_?secret|cookie|password)=/i.test(decodeURIComponent(url.hash)))return
  return url.href
 }catch{return}
}
export function cloudProviders(value:unknown):CloudProvider[]{
 if(!Array.isArray(value))throw new Error('连接服务未返回有效状态，请刷新重试。')
 return cloudProviderIds.map(id=>{
  const item=value.find(item=>item?.id===id)
  if(!item||typeof item.installed!=='boolean'||typeof item.configured!=='boolean'||!Object.hasOwn(cloudStatusNames,item.status)||!Array.isArray(item.skills))throw new Error('连接服务未返回完整状态，请刷新重试。')
  const skills=item.skills.filter((skill:any)=>skill&&typeof skill.id==='string'&&/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(skill.id)&&typeof skill.name==='string').slice(0,20).map((skill:any)=>({id:skill.id,name:skill.name.slice(0,160),enabled:!!skill.enabled,scope:skill.scope==='groups'?'groups':'all',groupIds:Array.isArray(skill.groupIds)?skill.groupIds.filter((id:unknown)=>typeof id==='string'):[]}))
  return {id,name:cloudProviderInfo[id].name,installed:item.installed,configured:item.configured,status:item.status,skills,...(typeof item.toolVersion==='string'?{toolVersion:cloudFeedback(item.toolVersion).slice(0,80)}:{}),...(typeof item.message==='string'?{message:cloudFeedback(item.message)}:{}),...(typeof item.checkedAt==='string'?{checkedAt:item.checkedAt}:{}),...(typeof item.authorizationUrl==='string'?{authorizationUrl:item.authorizationUrl}:{}),...(item.authorization?{authorization:cloudAuthorization(item.authorization)}:{})}
 })
}
export function cloudAuthorization(value:unknown):CloudAuthorization{
 const item=value as CloudAuthorization
 if(!item||typeof item.id!=='string'||!item.id||item.id.length>180||item.status!==undefined&&!['instructions','pending','ready','expired','error'].includes(item.status))throw new Error('服务未返回有效授权状态，请重试。')
 return {id:item.id,status:item.status||'pending',...(typeof item.url==='string'?{url:item.url}:{}),...(typeof item.expiresAt==='string'?{expiresAt:item.expiresAt}:{}),...(typeof item.message==='string'?{message:cloudFeedback(item.message)}:{})}
}
