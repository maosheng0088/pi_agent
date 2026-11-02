import {describe,expect,it,vi} from 'vitest'
import {pdfjsAssets} from '../pdfjs-assets'
describe('local PDF resource packaging',()=>{
 it('emits fonts, CMaps and non-wasm image decoders without a JavaScript evaluator',()=>{
  const plugin=pdfjsAssets(),emitFile=vi.fn();(plugin.generateBundle as Function).call({emitFile})
  const names=emitFile.mock.calls.map(([file])=>file.fileName as string)
  expect(names).toContain('assets/pdfjs/wasm/openjpeg_nowasm_fallback.js');expect(names).toContain('assets/pdfjs/wasm/jbig2_nowasm_fallback.js');expect(names.some(name=>name.endsWith('.bcmap'))).toBe(true);expect(names.some(name=>name.endsWith('.pfb'))).toBe(true);expect(names.some(name=>name.endsWith('.icc'))).toBe(true)
  expect(names.some(name=>name.includes('quickjs')||name.endsWith('.wasm'))).toBe(false)
 })
 it('does not expose arbitrary local paths through the development resource middleware',()=>{
  const use=vi.fn(),plugin=pdfjsAssets();(plugin.configureServer as Function)({middlewares:{use}});const middleware=use.mock.calls[0][0],next=vi.fn(),res={setHeader:vi.fn(),end:vi.fn()}
  middleware({url:'/assets/pdfjs/../../package.json'},res,next);expect(next).toHaveBeenCalledOnce();expect(res.end).not.toHaveBeenCalled()
 })
})
