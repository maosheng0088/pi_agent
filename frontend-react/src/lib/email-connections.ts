import type {Skill} from './types'
export type EmailTls='implicit'|'starttls'
export interface EmailProtocol{host:string;port:number;tls:EmailTls;username:string;passwordSet:boolean}
export interface EmailAccount{id:string;name:string;email:string;fromName?:string;enabled:boolean;allowSend:boolean;scope:'all'|'groups';groupIds:string[];imap:EmailProtocol;smtp:EmailProtocol;status:'not_configured'|'not_checked'|'ready'|'error';message?:string;checkedAt?:string}
export type EmailProtocolForm=EmailProtocol&{password:string;port:number}
export interface EmailAccountForm{name:string;email:string;fromName:string;enabled:boolean;allowSend:boolean;scope:string;groupIds:string[];imap:EmailProtocolForm;smtp:EmailProtocolForm}
export const emailStatusNames={not_configured:'待完善配置',not_checked:'待检测',ready:'连接检测通过',error:'需要处理'} as const
export function emailFeedback(value:unknown,secrets:string[]=[]){let text=typeof value==='string'?value:'操作失败，请重试。';for(const secret of secrets)if(secret)text=text.split(secret).join('（已隐藏）');return text.replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,350)}
function protocol(value:unknown):EmailProtocol{const item=value as EmailProtocol;if(!item||typeof item.host!=='string'||item.host.length>255||!Number.isInteger(item.port)||item.port<1||item.port>65535||!['implicit','starttls'].includes(item.tls)||typeof item.username!=='string'||typeof item.passwordSet!=='boolean')throw new Error('邮箱服务未返回有效的连接配置，请刷新。');return {host:item.host,port:item.port,tls:item.tls,username:item.username,passwordSet:item.passwordSet}}
export function emailAccounts(value:unknown):EmailAccount[]{
 if(!Array.isArray(value))throw new Error('邮箱服务未返回有效列表，请刷新。')
 return value.map(item=>{if(!item||typeof item.id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(item.id)||typeof item.name!=='string'||typeof item.email!=='string'||typeof item.enabled!=='boolean'||typeof item.allowSend!=='boolean'||!['all','groups'].includes(item.scope)||!Array.isArray(item.groupIds)||item.groupIds.some((id:unknown)=>typeof id!=='string')||!Object.hasOwn(emailStatusNames,item.status))throw new Error('邮箱服务未返回完整状态，请刷新。');return {id:item.id,name:item.name,email:item.email,...(typeof item.fromName==='string'?{fromName:item.fromName}:{}),enabled:item.enabled,allowSend:item.allowSend,scope:item.scope,groupIds:[...item.groupIds],imap:protocol(item.imap),smtp:item.smtp===null?{host:'',port:465,tls:'implicit',username:'',passwordSet:false}:protocol(item.smtp),status:item.status,...(typeof item.message==='string'?{message:emailFeedback(item.message)}:{}),...(typeof item.checkedAt==='string'?{checkedAt:item.checkedAt}:{})}})
}
export function emailSkill(value:unknown):Skill|null{const item=value as Skill;if(!item||typeof item.id!=='string'||typeof item.name!=='string'||typeof item.enabled!=='boolean')return null;return {id:item.id,name:item.name,enabled:item.enabled,scope:item.scope==='groups'?'groups':'all',groupIds:Array.isArray(item.groupIds)?item.groupIds.filter(id=>typeof id==='string'):[]}}
export function emailForm(account?:EmailAccount,currentGroup?:string):EmailAccountForm{
 return {name:account?.name||'',email:account?.email||'',fromName:account?.fromName||'',enabled:account?.enabled??false,allowSend:account?.allowSend??false,scope:account?.scope||'groups',groupIds:account?[...account.groupIds]:currentGroup?[currentGroup]:[],imap:{host:'',port:993,tls:'implicit',username:'',passwordSet:false,...account?.imap,password:''},smtp:{host:'',port:465,tls:'implicit',username:'',passwordSet:false,...account?.smtp,password:''}}
}
function protocolInput(value:EmailProtocolForm,label:string,required:boolean){
 const host=value.host.trim(),username=value.username.trim(),password=value.password
 if(!required&&!host&&!username&&!password&&!value.passwordSet)return undefined
 if(!host||host.length>253||!/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host)||host.includes('..'))throw new Error(`请填写${label}服务器域名或 IPv4 地址，不包含协议或路径。`)
 if(!Number.isInteger(value.port)||value.port<1||value.port>65535)throw new Error(`${label}端口须为 1–65535 的整数。`)
 if(!['implicit','starttls'].includes(value.tls))throw new Error(`请选择${label}的安全连接方式。`)
 if(!username||username.length>320)throw new Error(`请填写${label}登录用户名。`)
 if(!password&&!value.passwordSet)throw new Error(`请填写${label}密码或客户端授权码。`)
 if(/[\u0000-\u001f\u007f]/.test(password))throw new Error(`${label}密码不能包含换行或控制字符。`)
 return {host,port:value.port,tls:value.tls,username,...(password?{password}:{})}
}
export function emailInput(form:EmailAccountForm){
 if(!form.name.trim()||form.name.trim().length>100||/[\u0000-\u001f\u007f]/.test(form.name))throw new Error('请填写不超过 100 字的单行邮箱名称。')
 if(!/^[^\s<>@,;:"\\]+@[^\s<>@,;:"\\]+\.[^\s<>@,;:"\\]+$/.test(form.email.trim())||form.email.trim().length>254)throw new Error('请填写有效的完整邮箱地址，不包含姓名或邮件头。')
 if(form.fromName.trim().length>100||/[\u0000-\u001f\u007f]/.test(form.fromName))throw new Error('发件显示名须为不超过 100 字的单行文字。')
 if(!['all','groups'].includes(form.scope)||form.scope==='groups'&&!form.groupIds.length)throw new Error('请至少选择一个可使用此邮箱的智能体。')
 const imap=protocolInput(form.imap,'IMAP 收件',true)!,smtp=protocolInput(form.smtp,'SMTP 发件',form.allowSend)
 return {name:form.name.trim(),email:form.email.trim(),fromName:form.fromName.trim(),enabled:form.enabled,allowSend:form.allowSend,scope:form.scope,groupIds:form.scope==='groups'?[...new Set(form.groupIds)]:[],imap,...(smtp?{smtp}:{})}
}
