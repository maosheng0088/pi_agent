import {createRequire} from 'node:module'
import {dirname,join} from 'node:path'
import {readFileSync,readdirSync} from 'node:fs'
import type {Plugin} from 'vite'

/** PDF resources are shipped locally; uploaded documents never choose resource URLs. */
export function pdfjsAssets():Plugin{
  const root=dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
  const files=new Map<string,string>()
  for(const folder of ['cmaps','standard_fonts','iccs','wasm'])for(const name of readdirSync(join(root,folder))){
    const allowed=/\.(?:bcmap|pfb|ttf|otf|icc)$/.test(name)||/^(?:openjpeg|jbig2)_nowasm_fallback\.js$/.test(name)||/^LICENSE(?:_|$)/.test(name)
    if(allowed)files.set(`assets/pdfjs/${folder}/${name}`,join(root,folder,name))
  }
  return {name:'pi-local-pdf-resources',
    generateBundle(){for(const [fileName,path] of files)this.emitFile({type:'asset',fileName,source:readFileSync(path)})},
    configureServer(server){server.middlewares.use((req,res,next)=>{
      const name=(req.url||'').split('?',1)[0].replace(/^\//,''),path=files.get(name)
      if(!path)return next()
      const bytes=readFileSync(path);res.statusCode=200;res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript; charset=utf-8':'application/octet-stream');res.setHeader('Content-Length',bytes.length);res.end(bytes)
    })},
  }
}
