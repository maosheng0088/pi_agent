import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {createWriteStream} from 'node:fs';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
const dir='D:/code/pi-web/.tools/android';
const jdk=JSON.parse(await fs.readFile(`${dir}/jdk.json`,'utf8'));
const sdk=JSON.parse(await fs.readFile(`${dir}/sdk.json`,'utf8'));
const inputs=[...(process.argv.includes('--sdk-only')?[]:[{url:jdk.link,name:'jdk.zip',checksum:jdk.checksum,algorithm:'sha256'}]),...sdk.filter(x=>x.package!=='platform-tools').map(x=>({...x,name:x.package.startsWith('build-tools')?'build-tools.zip':'platform.zip',algorithm:x.checksumType}))];
async function download(item){
 const file=`${dir}/${item.name}`;
 try{const data=await fs.readFile(file);if(crypto.createHash(item.algorithm).update(data).digest('hex')===item.checksum){console.log(`${item.name} verified cache`);return}}catch(e){if(e.code!=='ENOENT')throw e}
 const response=await fetch(item.url,{signal:AbortSignal.timeout(600000)});if(!response.ok)throw new Error(`${item.name}: HTTP ${response.status}`);
 await pipeline(Readable.fromWeb(response.body),createWriteStream(`${file}.part`));
 const data=await fs.readFile(`${file}.part`);if(crypto.createHash(item.algorithm).update(data).digest('hex')!==item.checksum)throw new Error(`${item.name}: checksum mismatch`);
 await fs.rename(`${file}.part`,file);console.log(`${item.name}: ${data.length} bytes verified`);
}
const results=await Promise.allSettled(inputs.map(download));for(let i=0;i<results.length;i++)if(results[i].status==='rejected')throw results[i].reason;
