import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {Readable} from 'node:stream';
import {createFixture,configure,session} from './auth-helpers.mjs';
import {Store} from '../lib/store.mjs';
import {AttachmentService} from '../lib/attachments.mjs';

test('mail file bridge reads only immutable registered files from the same business group and honors limits and revocation',async()=>{
 const f=await createFixture({prefix:'email-attachment'});let store;
 try{
  const admin=f.client();await admin.request('/auth/setup',{method:'POST',body:{username:'mail-file-admin',displayName:'Mail files',password:'Fixture-mail-file-only-2026'}});await configure(admin,f);
  const one=await session(admin,'Mail file group'),two=await session(admin,'Another group');
  store=new Store(f.dataDir,f.workspace);const attachments=new AttachmentService(store);let allowed=true;const authorize=()=>{if(!allowed)throw Object.assign(new Error('revoked'),{status:403});};
  const item=await attachments.upload({sessionId:one.id,name:'报价表.csv',stream:Readable.from([Buffer.from('Shipment,Units\nFBA193,24')]),authorize});
  const read=await attachments.readBytes({sessionId:one.id,id:item.id,authorize});assert.equal(read.name,'报价表.csv');assert.match(read.content.toString(),/FBA193/);
  await assert.rejects(attachments.readBytes({sessionId:two.id,id:item.id,authorize}),{status:404});
  await assert.rejects(attachments.readBytes({sessionId:one.id,id:item.id,authorize,maxBytes:1}),{status:413});
  allowed=false;await assert.rejects(attachments.readBytes({sessionId:one.id,id:item.id,authorize}));allowed=true;
  await fs.unlink(`${attachments.directory}/${item.id}.bin`);const error=await attachments.readBytes({sessionId:one.id,id:item.id,authorize}).catch(error=>error);assert.equal(error.status,404);assert.doesNotMatch(error.message,/\.data|attachments[\\/]/);
 }finally{store?.close();await f.close();}
});
