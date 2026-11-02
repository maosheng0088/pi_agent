import fs from 'node:fs/promises';
const dir='D:/code/pi-web/.tools/android';await fs.mkdir(dir,{recursive:true});
const [repository,jdk]=await Promise.all([
 fetch('https://dl.google.com/android/repository/repository2-1.xml',{signal:AbortSignal.timeout(45000)}),
 fetch('https://api.adoptium.net/v3/assets/latest/17/hotspot?architecture=x64&image_type=jdk&os=windows&vendor=eclipse',{signal:AbortSignal.timeout(45000)})
]);
if(!repository.ok||!jdk.ok)throw new Error(`Toolchain metadata HTTP ${repository.status}/${jdk.status}`);
await fs.writeFile(`${dir}/repository.xml`,await repository.text());
const items=await jdk.json();const item=items[0];
await fs.writeFile(`${dir}/jdk.json`,JSON.stringify({version:item.version.semver,...item.binary.package},null,2));
console.log({jdkVersion:item.version.semver,jdkSize:item.binary.package.size});
