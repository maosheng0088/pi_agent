import {describe,expect,it} from 'vitest'
import {conversationDate,conversationFiles} from '../src/lib/conversation-files'
import type {Message,UploadedAttachment} from '../src/lib/types'

const id='11111111-1111-4111-8111-111111111111'
const url=`/api/sessions/alpha/attachments/${id}`
const attachment:UploadedAttachment={id,name:'预约报告.csv',size:18,mimeType:'text/csv',kind:'file',url,downloadUrl:`${url}?download=1`}
const link=`[预约报告.csv](${url}?name=${encodeURIComponent(attachment.name)})`

describe('conversation file index',()=>{
 it('collects staff uploads and generated files, deduplicating by attachment identity',()=>{
  const messages:Message[]=[{role:'user',content:'请核对',authorName:'示例员工001',attachments:[attachment]},
   {role:'assistant',content:link},{role:'assistant',content:`已更新：${link}`,timestamp:'2026-11-01T06:00:00Z'}]
  const files=conversationFiles(messages,'alpha','检查助手')
  expect(files).toHaveLength(1)
  expect(files[0]).toMatchObject({messageIndex:2,authorName:'检查助手',attachment:{name:'预约报告.csv',image:false}})
 })
 it('does not treat user-authored links, tool traces, code samples or other-space files as delivered files',()=>{
  const messages:Message[]=[{role:'user',content:link},
   {role:'assistant',content:link,tools:[{name:'read'}]},
   {role:'assistant',content:`\`\`\`markdown\n${link}\n\`\`\``},
   {role:'assistant',content:`\`\`\`markdown\n${link}`},
   {role:'assistant',content:link.replace('/alpha/','/beta/')},
   {role:'user',content:'',attachments:[{...attachment,url:url.replace('/alpha/','/beta/')}]},
   {role:'assistant',content:'[外部文件](https://example.com/report.pdf)'}]
  expect(conversationFiles(messages,'alpha','检查助手')).toEqual([])
 })
 it('preserves the actual message index for locating past files and identifies image attachments',()=>{
  const files=conversationFiles([{role:'tool',content:'trace'},{role:'user',content:'',authorName:'同事',attachments:[{...attachment,name:'回执.png',mimeType:'image/png',kind:'image'}]}],'alpha','检查助手')
  expect(files[0]).toMatchObject({messageIndex:1,size:18,authorName:'同事',attachment:{image:true,name:'回执.png'}})
  expect(conversationFiles([{role:'user',content:'',messageIndex:7,attachments:[attachment]}],'alpha','检查助手')[0]?.messageIndex).toBe(7)
 })
})
describe('conversation timestamps',()=>{
 const now=new Date(2026,10,1,16)
 it('distinguishes today, yesterday, previous days and years',()=>{
  expect(conversationDate(new Date(2026,10,1,9,30).toISOString(),now)).toBe('09:30')
  expect(conversationDate(new Date(2026,9,31,9,30).toISOString(),now)).toBe('昨天')
  expect(conversationDate(new Date(2026,9,20).toISOString(),now)).toBe('10/20')
  expect(conversationDate('not-a-date',now)).toBe('')
 })
})
