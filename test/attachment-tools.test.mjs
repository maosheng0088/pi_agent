import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {sessionTools} from '../lib/shared-tools.mjs';

const definitions=['Read','Ls','Find','Grep','Write','Edit','PowerShell','Bash'];
const sdk=Object.fromEntries(definitions.map(label=>[`create${label}ToolDefinition`,()=>({name:label.toLowerCase(),description:'Fixture tool',execute:async(_id,args)=>label==='Read'?await fs.readFile(args.path,'utf8'):args.path})]));
const tool=(tools,name)=>tools.customTools.find(value=>value.name===name);
async function fixture(){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'pi-attachment-tool-'));
 const cwd=path.join(directory,'workspace'),dataDir=path.join(directory,'data'),inbox=path.join(dataDir,'attachment-inbox');
 await fs.mkdir(cwd);await fs.mkdir(inbox,{recursive:true});
 const own=path.join(inbox,'own.txt'),other=path.join(inbox,'other.txt');
 await fs.writeFile(own,'OWN_ATTACHMENT_BYTES');await fs.writeFile(other,'OTHER_GROUP_PRIVATE');
 return {directory,cwd,dataDir,inbox,own,other,close:async()=>{assert.equal(path.dirname(directory),os.tmpdir());assert.ok(path.basename(directory).startsWith('pi-attachment-tool-'));await fs.rm(directory,{recursive:true,force:true});}};
}

test('attachment read permission grants exact files for one run without exposing private directories',async()=>{
 const f=await fixture();try{
  const tools=await sessionTools(sdk,{cwd:f.cwd,dataDir:f.dataDir,mode:'read-only',attachmentFiles:[f.own]});
  assert.equal(await tool(tools,'read').execute('r',{path:f.own}),'OWN_ATTACHMENT_BYTES');
  await assert.rejects(tool(tools,'read').execute('r',{path:f.other}),/拒绝访问/);
  for(const name of ['ls','find','grep'])await assert.rejects(tool(tools,name).execute('r',{path:f.inbox}),/仅允许访问/);
  const another=await sessionTools(sdk,{cwd:f.cwd,dataDir:f.dataDir,mode:'read-only'});
  await assert.rejects(tool(another,'read').execute('r',{path:f.own}),/拒绝访问/);
  assert.ok(!tools.tools.includes('open_attachment'));
 }finally{await f.close();}
});

test('open_attachment registers only a verified exact file and rechecks actor authorization',async()=>{
 const f=await fixture();try{
  let calls=0,revoked=false;
  const validId='24c29d5c-6177-4340-9778-6543dbf9d22b';
  const tools=await sessionTools(sdk,{cwd:f.cwd,dataDir:f.dataDir,mode:'workspace',authorize:()=>{if(revoked)throw new Error('actor revoked');},openAttachment:async({id})=>{calls++;return {id,path:f.own};}});
  await assert.rejects(tool(tools,'read').execute('r',{path:f.own}),/拒绝访问/);
  await assert.rejects(tool(tools,'open_attachment').execute('o',{id:'../other',path:f.other}),/编号无效/);assert.equal(calls,0);
  const result=await tool(tools,'open_attachment').execute('o',{id:validId});assert.equal(result.details.attachment.path,f.own);
  assert.equal(await tool(tools,'read').execute('r',{path:f.own}),'OWN_ATTACHMENT_BYTES');
  await assert.rejects(tool(tools,'read').execute('r',{path:f.other}),/拒绝访问/);
  const denied=await sessionTools(sdk,{cwd:f.cwd,dataDir:f.dataDir,mode:'workspace',authorize:()=>{if(revoked)throw new Error('actor revoked');},openAttachment:async()=>{revoked=true;return {id:validId,path:f.other};}});
  await assert.rejects(tool(denied,'open_attachment').execute('o',{id:validId}),/actor revoked/);
  revoked=false;await assert.rejects(tool(denied,'read').execute('r',{path:f.other}),/拒绝访问/);
 }finally{await f.close();}
});

test('registered document paths use the fixed parser while images retain native SDK reads',async()=>{
 const f=await fixture();try{
  const calls=[],id='24c29d5c-6177-4340-9778-6543dbf9d22b';
  const readDocument=async args=>{calls.push(args);return {content:[{type:'text',text:'PARSED_DOCUMENT_CONTENT'}]};};
  const tools=await sessionTools(sdk,{cwd:f.cwd,dataDir:f.dataDir,mode:'read-only',attachmentFiles:[f.own],attachmentMetadata:[{id,path:f.own,kind:'file'}],readDocument});
  const read=await tool(tools,'read').execute('r',{path:f.own,offset:2,limit:10});
  assert.equal(read.content[0].text,'PARSED_DOCUMENT_CONTENT');assert.equal(calls[0].id,id);assert.equal(calls[0].lineOffset,2);assert.equal(calls[0].lineLimit,10);
  const explicit=await tool(tools,'read_document').execute('d',{id,offset:16001,limit:200});
  assert.equal(explicit.content[0].text,'PARSED_DOCUMENT_CONTENT');assert.equal(calls[1].offset,16001);assert.equal(calls[1].limit,200);
  for(const args of [{id,path:f.other},{id,limit:16001},{id,offset:0},{id:'not-an-attachment'}])await assert.rejects(tool(tools,'read_document').execute('d',args),/读取范围无效/);
  const image=await sessionTools(sdk,{cwd:f.cwd,dataDir:f.dataDir,mode:'read-only',attachmentFiles:[f.own],attachmentMetadata:[{id,path:f.own,kind:'image'}],readDocument});
  assert.equal(await tool(image,'read').execute('r',{path:f.own}),'OWN_ATTACHMENT_BYTES');
  assert.equal(calls.length,2,'image reads must not invoke the document parser');
 }finally{await f.close();}
});
