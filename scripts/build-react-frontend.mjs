import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const frontend=path.join(root,'frontend-react');
async function run(relative,args){await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[path.join(frontend,'node_modules',relative),...args],{cwd:frontend,stdio:'inherit',windowsHide:true});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(`Frontend command exited with code ${code}`)))})}
await run('typescript/bin/tsc',['--noEmit']);
await run('vite/bin/vite.js',['build']);
const built=path.join(frontend,'dist'),deployed=path.join(root,'frontend','dist');
const html=await fs.readFile(path.join(built,'index.html'),'utf8');
if(!html.includes('id="root"')||!html.includes('/assets/'))throw new Error('React build did not produce a valid entry.');
// Keep earlier hashed files so tabs opened before deployment can still load chunks.
await fs.mkdir(path.join(deployed,'assets'),{recursive:true});
await fs.cp(path.join(built,'assets'),path.join(deployed,'assets'),{recursive:true,force:true,filter:async source=>!(await fs.lstat(source)).isSymbolicLink()});
await fs.writeFile(path.join(deployed,'.react-index.tmp'),html);
await fs.rename(path.join(deployed,'.react-index.tmp'),path.join(deployed,'index.html'));
console.log('React + Semi frontend built and staged in frontend/dist.');
