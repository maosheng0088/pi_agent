import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
const android=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),root=path.dirname(android);
const tools=path.join(root,'.tools','android');
const version=JSON.parse(await fs.readFile(path.join(android,'version.json'),'utf8'));
async function find(base,suffix){for(const file of await fs.readdir(base,{withFileTypes:true})){const name=path.join(base,file.name);if(file.isDirectory()){const match=await find(name,suffix);if(match)return match}else if(name.endsWith(suffix))return name}return null}
const java=await find(path.join(tools,'jdk'),path.join('bin','java.exe'));
const aapt=await find(path.join(tools,'build-tools'),'aapt2.exe');
const jar=await find(path.join(tools,'platform'),'android.jar');
if(!java||!aapt||!jar)throw new Error('Missing project-local Android toolchain. See README.md.');
const javaBin=path.dirname(java),buildTools=path.dirname(aapt),jdkHome=path.dirname(javaBin);
const output=path.join(android,'build',new Date().toISOString().replace(/[:.]/g,'-'));
for(const dir of ['classes','gen','dex','tests'])await fs.mkdir(path.join(output,dir),{recursive:true});
const env={...process.env,JAVA_HOME:jdkHome};
async function run(executable,args,extra={}){
 await new Promise((resolve,reject)=>{const child=spawn(executable,args,{cwd:android,env:{...env,...extra},stdio:'inherit',windowsHide:true});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(`${path.basename(executable)} exited ${code}`)))})
}
async function sources(dir){const result=[];for(const entry of await fs.readdir(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())result.push(...await sources(file));else if(entry.name.endsWith('.java'))result.push(file)}return result}
const res=path.join(android,'app','src','main','res'),manifest=path.join(android,'app','src','main','AndroidManifest.xml');
await run(aapt,['compile','--dir',res,'-o',path.join(output,'resources.zip')]);
await run(aapt,['link','-o',path.join(output,'resources.apk'),'--manifest',manifest,'-I',jar,'--min-sdk-version',String(version.minSdk),'--target-sdk-version',String(version.targetSdk),'--version-code',String(version.versionCode),'--version-name',version.versionName,'--java',path.join(output,'gen'),path.join(output,'resources.zip')]);
await run(path.join(javaBin,'javac.exe'),['-encoding','UTF-8','--release','8','-classpath',jar,'-d',path.join(output,'classes'),...await sources(path.join(android,'app','src','main','java')),...await sources(path.join(output,'gen'))]);
await run(path.join(javaBin,'javac.exe'),['-encoding','UTF-8','--release','8','-classpath',path.join(output,'classes'),'-d',path.join(output,'tests'),...await sources(path.join(android,'test'))]);
await run(java,['-cp',`${path.join(output,'classes')};${path.join(output,'tests')}`,'AppPolicyTest']);
await run(java,['-cp',`${path.join(output,'classes')};${path.join(output,'tests')}`,'asia.junweirpa.piconsole.android.WorkspaceDownloadTest']);
await run(path.join(javaBin,'jar.exe'),['--create','--file',path.join(output,'classes.jar'),'-C',path.join(output,'classes'),'.']);
await run(java,['-cp',path.join(buildTools,'lib','d8.jar'),'com.android.tools.r8.D8','--lib',jar,'--min-api',String(version.minSdk),'--output',path.join(output,'dex'),path.join(output,'classes.jar')]);
await run(path.join(javaBin,'jar.exe'),['--update','--file',path.join(output,'resources.apk'),'-C',path.join(output,'dex'),'classes.dex']);
await run(path.join(buildTools,'zipalign.exe'),['-f','4',path.join(output,'resources.apk'),path.join(output,'aligned.apk')]);
const signing=path.join(root,'.data','android-signing');await fs.mkdir(signing,{recursive:true});
const key=path.join(signing,'piconsole-release.p12'),secret=path.join(signing,'signing.json');
let config;
try{config=JSON.parse(await fs.readFile(secret,'utf8'))}catch(error){if(error.code!=='ENOENT')throw error;config={alias:'piconsole',password:crypto.randomBytes(32).toString('hex')};await fs.writeFile(secret,JSON.stringify(config),{mode:0o600,flag:'wx'})}
const signingEnv={PI_ANDROID_KEY_PASSWORD:config.password};
try{await fs.access(key)}catch(error){if(error.code!=='ENOENT')throw error;await run(path.join(javaBin,'keytool.exe'),['-genkeypair','-keystore',key,'-storetype','PKCS12','-storepass:env','PI_ANDROID_KEY_PASSWORD','-keypass:env','PI_ANDROID_KEY_PASSWORD','-alias',config.alias,'-keyalg','RSA','-keysize','3072','-validity','10000','-dname','CN=PiConsole Android, OU=PiConsole, O=PiConsole, C=CN'],signingEnv)}
const release=path.join(android,'release');await fs.mkdir(release,{recursive:true});
const apk=path.join(release,`PiConsole-Android-${version.versionName}.apk`);
await run(java,['-jar',path.join(buildTools,'lib','apksigner.jar'),'sign','--ks',key,'--ks-key-alias',config.alias,'--ks-pass','env:PI_ANDROID_KEY_PASSWORD','--key-pass','env:PI_ANDROID_KEY_PASSWORD','--out',apk,path.join(output,'aligned.apk')],signingEnv);
await run(java,['-jar',path.join(buildTools,'lib','apksigner.jar'),'verify','--verbose','--print-certs',apk]);
await run(path.join(buildTools,'zipalign.exe'),['-c','4',apk]);
await run(aapt,['dump','badging',apk]);
const bytes=await fs.readFile(apk),hash=crypto.createHash('sha256').update(bytes).digest('hex');
await fs.writeFile(path.join(release,'release.json'),JSON.stringify({...version,file:path.basename(apk),size:bytes.length,sha256:hash,builtAt:new Date().toISOString()},null,2));
await fs.writeFile(`${apk}.sha256`,`${hash}  ${path.basename(apk)}\n`);
console.log(`Built and verified ${path.basename(apk)} (${bytes.length} bytes)`);
