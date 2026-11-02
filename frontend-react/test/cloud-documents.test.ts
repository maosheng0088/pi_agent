import {describe,expect,it} from 'vitest'
import {cloudAuthorization,cloudAuthorizationUrl,cloudFeedback,cloudProviders} from '../src/lib/cloud-documents'
describe('cloud document public data boundary',()=>{
 it('opens only approved official HTTPS authorization domains without embedded credentials',()=>{
  for(const url of ['https://docs.qq.com/oauth','https://www.kdocs.cn/oauth2/authorize?client_id=public','https://365.kdocs.cn/','https://open.wps.cn/a','https://account.wps.com/','https://foo.wps.cn/device?user_code=public'])expect(cloudAuthorizationUrl(url)).toBeDefined()
  for(const url of ['http://docs.qq.com/','javascript:alert(1)','https://docs.qq.com.evil.com/','https://user:password@docs.qq.com/','https://docs.qq.com/?access_token=private','https://docs.qq.com/?access%5Ftoken=private','https://docs.qq.com/#?client_secret=private','https://account.wps.com:444/','https://foo.kdocs.cn/'])expect(cloudAuthorizationUrl(url)).toBeUndefined()
 })
 it('never projects credential values or hints into the provider model',()=>{
  const values=['tencent','kdocs','wps365'].map(id=>({id,name:'server name',installed:true,configured:true,status:'ready',token:'private',clientSecret:'private',credentialHint:'private',skills:[]}))
  const providers=cloudProviders(values);expect(JSON.stringify(providers)).not.toContain('private');expect(providers.map(item=>item.name)).toEqual(['腾讯文档','金山文档','WPS365']);expect(()=>cloudProviders([])).toThrow('完整状态')
 })
 it('normalizes pending authorization and keeps errors bounded with entered secrets redacted',()=>{
  expect(cloudAuthorization({id:'auth-one',url:'https://docs.qq.com/'}).status).toBe('pending');expect(()=>cloudAuthorization({id:'',status:'pending'})).toThrow()
  expect(cloudFeedback('失败 private-token\n请重试',['private-token'])).toBe('失败 （已隐藏） 请重试');expect(cloudFeedback('x'.repeat(1000))).toHaveLength(350)
 })
})
