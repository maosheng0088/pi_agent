import {describe,expect,it} from 'vitest'
import {emailAccounts,emailFeedback,emailForm,emailInput,emailSkill} from '../src/lib/email-connections'

function receivingForm(){const form=emailForm(undefined,'alpha');return {...form,name:'客服收件箱',email:'support@example.test',imap:{...form.imap,host:'imap.example.test',username:'support',password:'fixture-imap-only'}}}
function account(){const {imap,...body}=emailInput(receivingForm());return {id:'account-one',...body,imap:{...imap,passwordSet:true},smtp:{host:'',port:465,tls:'implicit' as const,username:'',passwordSet:false},status:'not_checked' as const}}

describe('email connection public model and submissions',()=>{
 it('starts with no invented identity or server, safe TLS defaults, and no access or sending enabled',()=>{
  const form=emailForm();expect([form.name,form.email,form.imap.host,form.smtp.host,form.imap.username,form.smtp.username]).toEqual(['','','','','','']);expect(form.enabled).toBe(false);expect(form.allowSend).toBe(false);expect(form.groupIds).toEqual([]);expect(form.imap.port).toBe(993);expect(form.smtp.port).toBe(465);expect(form.imap.tls).toBe('implicit');expect(form.smtp.tls).toBe('implicit')
 })
 it('projects only public state and never returns stored credential fields',()=>{
  const original={...account(),password:'saved-secret',imap:{...account().imap,password:'saved-secret'},smtp:{...account().smtp,password:'saved-secret'}};const result=emailAccounts([original]);expect(JSON.stringify(result)).not.toContain('saved-secret');expect(result[0].imap.passwordSet).toBe(true);expect(emailForm(result[0]).imap.password).toBe('');expect(emailForm(result[0]).smtp.password).toBe('');expect(()=>emailAccounts([{...original,status:'invented_ready'}])).toThrow('完整状态');expect(()=>emailAccounts([{...original,imap:{...original.imap,tls:'none'}}])).toThrow('连接配置')
 })
 it('accepts an IMAP-only receiving connection and never invents SMTP configuration',()=>{
  const payload=emailInput(receivingForm());expect(payload.imap).toMatchObject({host:'imap.example.test',port:993,tls:'implicit',username:'support',password:'fixture-imap-only'});expect(payload).not.toHaveProperty('smtp');expect(payload.allowSend).toBe(false);expect(payload.scope).toBe('groups');expect(payload.groupIds).toEqual(['alpha'])
 })
 it('accepts the backend null SMTP projection as a blank optional configuration',()=>{
  const value=emailAccounts([{...account(),smtp:null}])[0];expect(value.smtp).toEqual({host:'',port:465,tls:'implicit',username:'',passwordSet:false});expect(emailInput(emailForm(value))).not.toHaveProperty('smtp')
 })
 it('requires a complete independent SMTP account before enabling sends',()=>{
  const form={...receivingForm(),allowSend:true};expect(()=>emailInput(form)).toThrow('SMTP 发件服务器');form.smtp={...form.smtp,host:'smtp.example.test',port:587,tls:'starttls',username:'sender',password:'fixture-smtp-only'};expect(emailInput(form).smtp).toEqual({host:'smtp.example.test',port:587,tls:'starttls',username:'sender',password:'fixture-smtp-only'})
 })
 it('keeps saved passwords on update by omitting blank fields and retains independent scope IDs',()=>{
  const value=emailAccounts([account()])[0],form=emailForm({...value,groupIds:['alpha','historical']});form.name='新名称';const payload=emailInput(form);expect(payload.imap).not.toHaveProperty('password');expect(payload).not.toHaveProperty('smtp');expect(payload.groupIds).toEqual(['alpha','historical']);form.scope='all';expect(emailInput(form).groupIds).toEqual([]);form.scope='groups';form.groupIds=[];expect(()=>emailInput(form)).toThrow('至少选择')
 })
 it('rejects unsafe server, port, email, unencrypted protocol, and multiline password input',()=>{
  for(const host of ['https://imap.example.test','imap.example.test/path','imap.example.test@other','imap example.test'])expect(()=>emailInput({...receivingForm(),imap:{...receivingForm().imap,host}})).toThrow('服务器域名');for(const port of [0,65536,1.5])expect(()=>emailInput({...receivingForm(),imap:{...receivingForm().imap,port}})).toThrow('端口');expect(()=>emailInput({...receivingForm(),email:'Display Name <user@example.test>'})).toThrow('邮箱地址');expect(()=>emailInput({...receivingForm(),imap:{...receivingForm().imap,tls:'none' as any}})).toThrow('安全连接');expect(()=>emailInput({...receivingForm(),imap:{...receivingForm().imap,password:'x\r\ny'}})).toThrow('控制字符')
 })
 it('redacts entered secrets and bounds failure feedback',()=>{
  expect(emailFeedback('连接失败 fixture-secret\n请重试',['fixture-secret'])).toBe('连接失败 （已隐藏） 请重试');expect(emailFeedback('x'.repeat(1000))).toHaveLength(350);expect(emailSkill({...account(),id:'skill-one',name:'email-workspace',enabled:false,password:'private'})).toEqual({id:'skill-one',name:'email-workspace',enabled:false,scope:'groups',groupIds:['alpha']})
 })
})
