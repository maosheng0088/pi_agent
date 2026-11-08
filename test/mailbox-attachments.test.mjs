import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {HttpError} from '../lib/security.mjs';
import {MailboxAttachmentArchive} from '../lib/mailbox-attachments.mjs';

const accountId='00000000-0000-4000-8000-000000000001',otherId='00000000-0000-4000-8000-000000000002';
const reference={folder:'INBOX',uid:'8',uidValidity:'45',part:'2'};
async function setup(t){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'pi-mailbox-file-')),db=new DatabaseSync(':memory:'),archive=new MailboxAttachmentArchive({directory,db});
 t.after(async()=>{db.close();assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('pi-mailbox-file-'));await fs.rm(directory,{recursive:true,force:true});});
 return {archive,directory,db};
}
const file=()=>({name:'../预约确认.txt',mimeType:'text/plain',content:Buffer.from('Mailbox attachment fixture')});
test('account attachments are archived once and survive account permission revisions',async t=>{
 const {archive,directory,db}=await setup(t);let reads=0,checks=0;
 const input={accountId,archiveId:`${accountId}:1`,reference,authorize:()=>checks++,read:async()=>{reads++;return file();}};
 const [one,two]=await Promise.all([archive.acquire(input),archive.acquire(input)]);
 assert.equal(one.id,two.id);assert.equal(one.name,'预约确认.txt');assert.equal(reads,1);assert.ok(checks>=4);
 assert.equal(one.downloadUrl,`/api/mailbox/${accountId}/attachments/${one.id}?download=1`);
 assert.equal((await fs.readFile(path.join(directory,'mailboxes',accountId,'attachments',`${one.id}.bin`))).toString(),file().content.toString());
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mailbox_attachments').get().n,1);
 assert.equal(await archive.lookup({...input,archiveId:`${accountId}:2`}),null);
 assert.equal(await archive.lookup({...input,accountId:otherId,archiveId:`${otherId}:1`}),null);
});
test('revoked access during download leaves no registered or partial local file',async t=>{
 const {archive,directory,db}=await setup(t);let allowed=true;
 await assert.rejects(()=>archive.acquire({accountId,archiveId:`${accountId}:1`,reference,authorize:()=>{if(!allowed)throw new HttpError(403,'revoked');},read:async()=>{allowed=false;return file();}}),error=>error.status===403);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mailbox_attachments').get().n,0);
 assert.deepEqual(await fs.readdir(path.join(directory,'mailboxes')),[]);
});
test('mailbox archive rejects source path injection, oversized content and linked directories',async t=>{
 const {archive,directory,db}=await setup(t);
 await assert.rejects(()=>archive.acquire({accountId:'../../outside',archiveId:'../../outside:1',reference,read:file}),error=>error.status===400);
 await assert.rejects(()=>archive.acquire({accountId,archiveId:`${accountId}:1`,reference:{...reference,part:'../../other'},read:file}),error=>error.status===400);
 await assert.rejects(()=>archive.acquire({accountId,archiveId:`${accountId}:1`,reference,read:async()=>({...file(),content:Buffer.alloc(50*1024*1024+1)})}),error=>error.status===413);
 const external=path.join(directory,'outside');await fs.mkdir(external);
 const alias=path.join(directory,'mailboxes',accountId);await fs.symlink(external,alias,process.platform==='win32'?'junction':'dir');
 await assert.rejects(()=>archive.acquire({accountId,archiveId:`${accountId}:1`,reference,read:async()=>file()}),error=>error.status===403);
 assert.deepEqual(await fs.readdir(external),[]);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mailbox_attachments').get().n,0);
});
