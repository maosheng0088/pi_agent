import {describe,expect,it} from 'vitest'
import {attachmentDocument,documentBase,documentFormat,fileReadingHint} from '../src/lib/attachment-document'
import {messageAttachment} from '../src/lib/message-links'
const document={format:'text',status:'ready',text:'资料',sections:[],warnings:[],truncated:false}
describe('document preview data boundary',()=>{
 it('identifies supported file types without promoting HTML, legacy Office or archives',()=>{
  for(const name of ['a.PDF','a.docx','a.xlsx','a.csv','a.txt','a.md'])expect(documentFormat(name)).not.toBe('unsupported')
  for(const name of ['a.html','a.htm','a.svg','a.doc','a.xls','a.zip','a.exe'])expect(documentFormat(name)).toBe('unsupported')
  expect(fileReadingHint('a.xls')).toContain('仅下载');expect(fileReadingHint('a.png')).toContain('图片');expect(fileReadingHint('a.pdf')).toContain('逐页')
 })
 it('only derives content endpoints from controlled same-origin attachment URLs',()=>{
  const base='/api/sessions/alpha/attachments/11111111-1111-4111-8111-111111111111'
  expect(documentBase(messageAttachment(`${base}?name=a.pdf`) as any)).toBe(base)
  expect(documentBase({href:'https://example.com/a.pdf',name:'a.pdf'} as any)).toBeUndefined()
 })
 it('accepts only text and cell primitives, retaining formulas as inert strings',()=>{
  const parsed=attachmentDocument({...document,format:'xlsx',sheets:[{name:'Sheet1',rows:[['=HYPERLINK("https://example.com")',false,12,null]],truncated:false}]})
  expect(parsed.sheets?.[0].rows[0]).toEqual(['=HYPERLINK("https://example.com")',false,12,null])
  for(const patch of [{sections:[{title:'x',text:'y',page:0}]},{format:'html'},{sheets:[{name:'x',rows:[[{}]],truncated:false}]},{warnings:'not array'}])expect(()=>attachmentDocument({...document,...patch})).toThrow()
 })
 it('caps oversized preview data and explicitly marks truncation',()=>{
  const parsed=attachmentDocument({...document,text:'x'.repeat(600001),sheets:[{name:'Large',rows:[Array.from({length:51},()=>null)],truncated:false}]})
  expect(parsed.text).toHaveLength(600000);expect(parsed.sheets?.[0].rows[0]).toHaveLength(50);expect(parsed.sheets?.[0].truncated).toBe(true);expect(parsed.truncated).toBe(true)
 })
})
