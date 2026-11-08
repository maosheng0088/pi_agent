import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {HttpError} from './security.mjs';

export const MAILBOX_ATTACHMENT_MAX_BYTES=50*1024*1024;
const idPattern=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const digest=value=>createHash('sha256').update(value).digest('hex');
function cleanName(value){
 const name=String(value||'attachment').replaceAll('\\','/').split('/').at(-1).normalize('NFC').replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g,'').trim();
 return [...(name&&!/^\.+$/.test(name)?name:'attachment')].slice(0,180).join('');
}
export function mailboxAttachmentDisposition(value){
 const name=cleanName(value);
 const fallback=name.replace(/[^\x20-\x7e]|["\\;]/g,'_');
 const encoded=encodeURIComponent(name.toWellFormed()).replace(/[!'()*]/g,value=>`%${value.charCodeAt(0).toString(16).toUpperCase()}`);
 return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
function sourceKey(reference){
 if(!reference||typeof reference.folder!=='string'||!reference.folder||reference.folder.length>1000||/[\x00-\x1f\x7f]/.test(reference.folder)||!/^\d{1,10}$/.test(String(reference.uid))||!/^\d{1,10}$/.test(String(reference.uidValidity))||!/^\d+(?:\.\d+){0,19}$/.test(reference.part||''))throw new HttpError(400,'邮件附件引用无效。');
 return digest(JSON.stringify([reference.folder,String(reference.uid),String(reference.uidValidity),reference.part]));
}
function safeError(error){
 if(error instanceof HttpError)return error;
 if(['ENOENT','ENOTDIR'].includes(error?.code))return new HttpError(404,'本地邮件附件不存在。');
 return new HttpError(500,'邮件附件归档或读取失败，请稍后重试。');
}

/** Account-owned immutable copies. A caller must recheck live mailbox access. */
export class MailboxAttachmentArchive {
 constructor(store){
  this.db=store.db;this.dataDirectory=fsSync.realpathSync(store.directory);this.directory=path.join(this.dataDirectory,'mailboxes');this.pending=new Map();
  if(fsSync.existsSync(this.directory)&&fsSync.lstatSync(this.directory).isSymbolicLink())throw new HttpError(403,'邮件归档目录不能是链接。');
  fsSync.mkdirSync(this.directory,{recursive:true,mode:0o700});
  if(fsSync.realpathSync(this.directory)!==this.directory)throw new HttpError(403,'邮件归档目录无效。');
  this.db.exec(`CREATE TABLE IF NOT EXISTS mailbox_attachments (
   id TEXT PRIMARY KEY,account_id TEXT NOT NULL,archive_id TEXT NOT NULL,source_key TEXT NOT NULL,
   name TEXT NOT NULL,size INTEGER NOT NULL,mime_type TEXT NOT NULL,sha256 TEXT NOT NULL,created_at TEXT NOT NULL,
   UNIQUE(account_id,archive_id,source_key));
   CREATE INDEX IF NOT EXISTS mailbox_attachments_account ON mailbox_attachments(account_id,archive_id);`);
 }
 validate(accountId,archiveId){if(!idPattern.test(accountId||'')||typeof archiveId!=='string'||archiveId.length>200||!archiveId.startsWith(`${accountId}:`))throw new HttpError(400,'邮件归档账号无效。');}
 view(row){return {id:row.id,name:row.name,size:row.size,mimeType:row.mime_type,downloadUrl:`/api/mailbox/${row.account_id}/attachments/${row.id}?download=1`};}
 async folder(accountId,create=false){
  let location=this.dataDirectory;
  for(const segment of ['mailboxes',accountId,'attachments']){
   location=path.join(location,segment);
   if(create){try{await fs.mkdir(location,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}}
   const stat=await fs.lstat(location);
   if(!stat.isDirectory()||stat.isSymbolicLink()||await fs.realpath(location)!==location)throw new HttpError(403,'邮件附件目录不能是链接。');
  }
  return location;
 }
 async lookup({accountId,archiveId,reference,authorize=()=>{}}){
  authorize();this.validate(accountId,archiveId);
  const row=this.db.prepare('SELECT * FROM mailbox_attachments WHERE account_id=? AND archive_id=? AND source_key=?').get(accountId,archiveId,sourceKey(reference));
  if(!row)return null;
  try{const directory=await this.folder(accountId),file=path.join(directory,`${row.id}.bin`),stat=await fs.lstat(file);
   if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size!==row.size||await fs.realpath(file)!==file)throw new HttpError(403,'邮件附件归档文件无效。');
   authorize();return this.view(row);
  }catch(error){if(error.code==='ENOENT')return null;throw safeError(error);}
 }
 async acquire({accountId,archiveId,reference,read,authorize=()=>{},signal}){
  authorize();signal?.throwIfAborted();this.validate(accountId,archiveId);
  const source=sourceKey(reference),key=`${archiveId}:${source}`;
  const old=await this.lookup({accountId,archiveId,reference,authorize});if(old)return old;
  if(this.pending.has(key)){const result=await this.pending.get(key);authorize();signal?.throwIfAborted();return result;}
  const operation=this.save({accountId,archiveId,source,read,authorize,signal});this.pending.set(key,operation);
  try{return await operation;}finally{if(this.pending.get(key)===operation)this.pending.delete(key);}
 }
 async save({accountId,archiveId,source,read,authorize,signal}){
  let handle,file,identity;
  try{
   authorize();signal?.throwIfAborted();const value=await read();authorize();signal?.throwIfAborted();
   if(!value||!Buffer.isBuffer(value.content))throw new HttpError(502,'邮箱未返回有效附件。');
   if(value.content.length>MAILBOX_ATTACHMENT_MAX_BYTES)throw new HttpError(413,'单个邮件附件不能超过 50 MiB。');
   const directory=await this.folder(accountId,true),id=randomUUID();file=path.join(directory,`${id}.bin`);
   handle=await fs.open(file,'wx',0o600);identity=await handle.stat();
   await handle.writeFile(value.content);await handle.sync();authorize();signal?.throwIfAborted();await this.folder(accountId);
   const stat=await handle.stat(),current=await fs.lstat(file);if(!stat.isFile()||stat.nlink!==1||stat.size!==value.content.length||stat.dev!==identity.dev||stat.ino!==identity.ino||current.isSymbolicLink()||!current.isFile()||current.dev!==stat.dev||current.ino!==stat.ino||current.size!==stat.size||current.birthtimeMs!==stat.birthtimeMs||await fs.realpath(file)!==file)throw new HttpError(403,'邮件附件归档路径已变更。');
   const row={id,account_id:accountId,archive_id:archiveId,source_key:source,name:cleanName(value.name),size:value.content.length,mime_type:/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(value.mimeType||'')?value.mimeType:'application/octet-stream',sha256:digest(value.content),created_at:new Date().toISOString()};
   authorize();
   this.db.prepare('INSERT INTO mailbox_attachments(id,account_id,archive_id,source_key,name,size,mime_type,sha256,created_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id,archive_id,source_key) DO UPDATE SET id=excluded.id,name=excluded.name,size=excluded.size,mime_type=excluded.mime_type,sha256=excluded.sha256,created_at=excluded.created_at').run(...Object.values(row));
   file=null;await handle.close().catch(()=>{});handle=null;return this.view(row);
  }catch(error){throw safeError(error);}
  finally{
   if(handle)await handle.close().catch(()=>{});
   // Remove only a file created by this operation and still pointing at its inode.
   if(file&&identity){try{await this.folder(accountId);const stat=await fs.lstat(file);if(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.dev===identity.dev&&stat.ino===identity.ino&&stat.birthtimeMs===identity.birthtimeMs)await fs.unlink(file);}catch{}}
  }
 }
 async serve(req,res,{accountId,archiveId,id,authorize=()=>{}}){
  let handle,timer;
  try{
   authorize();this.validate(accountId,archiveId);if(!idPattern.test(id||''))throw new HttpError(404,'邮件附件不存在。');
   const row=this.db.prepare('SELECT * FROM mailbox_attachments WHERE id=? AND account_id=? AND archive_id=?').get(id,accountId,archiveId);if(!row)throw new HttpError(404,'邮件附件不存在。');
   const directory=await this.folder(accountId),file=path.join(directory,`${id}.bin`),link=await fs.lstat(file);
   if(link.isSymbolicLink()||!link.isFile()||link.nlink!==1||await fs.realpath(file)!==file)throw new HttpError(403,'邮件附件文件无效。');
   handle=await fs.open(file,'r');const stat=await handle.stat();
   if(stat.size!==row.size||stat.size>MAILBOX_ATTACHMENT_MAX_BYTES||stat.dev!==link.dev||stat.ino!==link.ino||stat.nlink!==1)throw new HttpError(409,'邮件附件归档已变更。');
   authorize();res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':stat.size,'Content-Disposition':mailboxAttachmentDisposition(row.name),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
   if(req.method==='HEAD'){res.end();return;}
   const stream=handle.createReadStream({autoClose:false});timer=setInterval(()=>{try{authorize();}catch(error){stream.destroy(error);}},250);timer.unref?.();await pipeline(stream,res);
  }catch(error){if(res.headersSent){res.destroy();return;}throw safeError(error);}
  finally{clearInterval(timer);if(handle)await handle.close().catch(()=>{});}
 }
}
