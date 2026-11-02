import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=path.join(root,'frontend','dist'),target=path.join(root,'public');
const html=await fs.readFile(path.join(source,'index.html'),'utf8');
if(!html.includes('/assets/'))throw new Error('Build the frontend first: npm run build:frontend');
const current=await fs.readFile(path.join(target,'index.html'),'utf8');
if(current.includes('/app.js')){
  try{await fs.copyFile(path.join(target,'index.html'),path.join(target,'legacy.html'),1)}catch(error){if(error.code!=='EEXIST')throw error}
}
await fs.mkdir(path.join(target,'assets'),{recursive:true});
let files=0;
await fs.cp(path.join(source,'assets'),path.join(target,'assets'),{recursive:true,force:true,filter:async file=>{const stat=await fs.lstat(file);if(stat.isSymbolicLink())return false;if(stat.isFile())files++;return true;}});
await fs.writeFile(path.join(target,'.next-index.tmp'),html);
await fs.rename(path.join(target,'.next-index.tmp'),path.join(target,'index.html'));
await fs.writeFile(path.join(target,'next.html'),html);
console.log(`Frontend published (${files} assets). Restart the service separately to apply backend changes.`);
