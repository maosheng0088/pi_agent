import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const directory=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../frontend-react/src/assets/workspace/agent-icons');
const icons={
  assistant:{colors:['#6878EC','#6253CF'],body:'<path d="m32 15 4.9 11.9L49 32l-12.1 4.9L32 49l-4.9-12.1L15 32l12.1-5.1Z" fill="white" stroke="none"/><path d="m48 14 1.7 4.3L54 20l-4.3 1.7L48 26l-1.7-4.3L42 20l4.3-1.7Z" fill="#DDE2FF" stroke="none"/>'},
  ocean:{colors:['#188CC7','#2164C7'],body:'<path d="M22 32V20h20v12M28 20v-5h8v5M19 32l13-6 13 6-4 13H23Z" fill="white" fill-opacity=".16"/><path d="m19 32 13-6 13 6-4 13H23ZM32 27v17M27 25h.1M37 25h.1M14 48c4-4 8 4 12 0s8 4 12 0 8 4 12 0"/>'},
  po:{colors:['#D98124','#D65C25'],body:'<rect x="14" y="17" width="25" height="32" rx="5" fill="white" fill-opacity=".18" stroke="none"/><rect x="22" y="13" width="27" height="33" rx="5" fill="white" stroke="none"/><path d="M29 22h13M29 28h8" stroke="#CB6B20"/><circle cx="42" cy="43" r="10" fill="#8354D7" stroke="none"/><path d="m37 43 3 3 6-7"/>'},
  unit:{colors:['#6679EC','#5950CF'],body:'<path d="m15 24 17-9 17 9-17 9ZM15 24v19l17 9 17-9V24M32 33v19M24 19l17 9" fill="white" fill-opacity=".13"/><path d="m15 24 17-9 17 9-17 9ZM15 24v19l17 9 17-9V24M32 33v19M24 19l17 9"/><path d="m39 40 3 3 5-6" stroke="#FFF4B5"/>'},
  quote:{colors:['#0A9E9A','#087C97'],body:'<rect x="17" y="12" width="30" height="40" rx="7" fill="white" stroke="none"/><rect x="23" y="19" width="18" height="9" rx="2" fill="#15999E" stroke="none"/><path d="M24 35h3m10 0h3M24 43h3m10 0h3" stroke="#168D98" stroke-width="3.8"/>'},
  pickup:{colors:['#397EE9','#3260CA'],body:'<path d="M12 21h25v23H12ZM37 29h9l7 9v6H37Z" fill="white" fill-opacity=".14"/><path d="M12 21h25v23H12ZM37 29h9l7 9v6H37M39 30v8h13"/><circle cx="22" cy="45" r="5" fill="#477BE2"/><circle cx="44" cy="45" r="5" fill="#3C6BD4"/><path d="M18 27h12M18 33h8"/>'},
  warehouse:{colors:['#DC7147','#BD4C48'],body:'<path d="m12 27 20-13 20 13M17 25v26h30V25"/><rect x="24" y="31" width="16" height="20" rx="1" fill="white" fill-opacity=".2"/><path d="M25 37h14M25 44h14M30 22h4"/>'},
  sync:{colors:['#9364DA','#6C4FC1'],body:'<path d="M17 26a17 17 0 0 1 29-7l4 5M50 15v10h-10M47 38a17 17 0 0 1-29 7l-4-5M14 49V39h10" stroke-width="3.5"/><path d="M26 29h12v10H26Z" fill="white" fill-opacity=".24" stroke="none"/>'},
  finance:{colors:['#0B9F7A','#0C7F74'],body:'<ellipse cx="26" cy="23" rx="12" ry="6" fill="white" fill-opacity=".2"/><path d="M14 23v18c0 8 24 8 24 0V23M14 23c0 8 24 8 24 0s-24-8-24 0ZM14 32c0 8 24 8 24 0"/><circle cx="44" cy="39" r="11" fill="#F6D983" stroke="none"/><path d="m40 35 4 4 4-4m-4 4v6m-4-3h8" stroke="#8B6628" stroke-width="2.4"/>'},
  support:{colors:['#4C8CEB','#3B5BCC'],body:'<path d="M16 34v-3a16 16 0 0 1 32 0v3" stroke-width="3.5"/><rect x="12" y="30" width="9" height="15" rx="4.5" fill="white" stroke="none"/><rect x="43" y="30" width="9" height="15" rx="4.5" fill="white" stroke="none"/><path d="M47 43v3c0 5-5 7-12 7"/><rect x="28" y="49" width="10" height="5" rx="2.5" fill="#FFE2A4" stroke="none"/>'},
  document:{colors:['#697FE3','#6551BE'],body:'<path d="M19 12h18l10 10v26a4 4 0 0 1-4 4H19a4 4 0 0 1-4-4V16a4 4 0 0 1 4-4Z" fill="white" stroke="none"/><path d="M37 12v11h10" stroke="#CAD3FB" fill="#DDE4FF"/><path d="M23 31h15M23 38h15M23 45h9" stroke="#6D78D5"/>'},
  team:{colors:['#D6609A','#A54DAD'],body:'<circle cx="32" cy="24" r="7" fill="white" stroke="none"/><path d="M18 49v-4a14 14 0 0 1 28 0v4" fill="white" fill-opacity=".8" stroke="none"/><path d="M16 33a6 6 0 1 1 5-10M11 47v-3c0-5 3-8 7-9M48 33a6 6 0 1 0-5-10M53 47v-3c0-5-3-8-7-9"/>'},
  automation:{colors:['#5176DA','#6552BE'],body:'<circle cx="30" cy="30" r="17" fill="white" fill-opacity=".12"/><path d="M30 18v12l8 5" stroke-width="3.4"/><path d="m45 31-9 15h8l-2 11 12-17h-9l4-9Z" fill="#FFE4A0" stroke="none"/>'},
  mail:{colors:['#DB647B','#BA486F'],body:'<rect x="12" y="19" width="40" height="29" rx="6" fill="white" fill-opacity=".15"/><path d="m14 21 18 14 18-14M14 46l12-12m24 12L38 34"/>'},
};
await fs.mkdir(directory,{recursive:true});
for(const [name,{colors,body}] of Object.entries(icons)){
 const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none"><defs><linearGradient id="bg" x1="8" y1="3" x2="56" y2="65" gradientUnits="userSpaceOnUse"><stop stop-color="${colors[0]}"/><stop offset="1" stop-color="${colors[1]}"/></linearGradient></defs><rect width="64" height="64" rx="18" fill="url(#bg)"/><path d="M0 0h64v14C40 4 24 26 0 21Z" fill="white" fill-opacity=".06"/><g stroke="white" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round">${body}</g></svg>\n`;
 await fs.writeFile(path.join(directory,`${name}.svg`),svg);
}
await fs.writeFile(path.join(directory,'README.md'),'# 智能体业务图标\n\nPiConsole 原创 SVG 业务图标，参考企业 IM 的彩色群头像呈现方式。由 scripts/build-agent-artwork.mjs 生成，图形、配色和背景均为本项目代码，无外部请求或字体依赖。\n\n统一 64×64 viewBox、18px 圆角、2.8px 描边；仅自动头像采用业务图标，用户已配置的头像保持优先。\n');
console.log(`Generated ${Object.keys(icons).length} local business icons.`);
