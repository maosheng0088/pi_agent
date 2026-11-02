import path from 'node:path';
import { Worker } from 'node:worker_threads';

export const DOCUMENT_LIMITS = Object.freeze({
  fileBytes: 50 * 1024 * 1024, characters: 120_000, pages: 100,
  sheets: 5, rows: 100, columns: 30, lines: 5000, cellCharacters: 4000,
  zipEntries: 2000, zipExpandedBytes: 64 * 1024 * 1024, zipEntryBytes: 16 * 1024 * 1024,
  zipCompressionRatio: 200, timeoutMs: 30_000,
});

const extensions = new Map([['.pdf', 'pdf'], ['.docx', 'docx'], ['.xlsx', 'xlsx'], ['.csv', 'csv'],
  ['.txt', 'text'], ['.md', 'text'], ['.markdown', 'text'], ['.json', 'text']]);

export function documentFormat(name) {
  return typeof name === 'string' ? extensions.get(path.extname(name.replaceAll('\\', '/')).toLowerCase()) || 'unsupported' : 'unsupported';
}

export function supportsDocument(name) { return documentFormat(name) !== 'unsupported'; }

function unavailable(format, status, reason) {
  return { format, status, text: '', sections: [], warnings: [reason], truncated: false };
}

function cancelled() { return new DOMException('文档解析已取消。', 'AbortError'); }

/** Parse an already-authorized private file. No document content is executed. */
export async function parseDocument({ filePath, name, mimeType, signal } = {}, { timeoutMs = DOCUMENT_LIMITS.timeoutMs } = {}) {
  if (signal?.aborted) throw cancelled();
  const format = documentFormat(name);
  if (format === 'unsupported') {
    const legacy = /\.(?:doc|xls)$/i.test(typeof name === 'string' ? name : '');
    return unavailable(format, 'unsupported', legacy ? '暂不支持旧版 DOC/XLS 文件，请另存为 DOCX/XLSX 后重新上传。' : '暂不支持此文件格式，请使用 PDF、DOCX、XLSX、CSV、TXT、Markdown 或 JSON。');
  }
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || filePath.includes('\0')) return unavailable(format, 'error', '文档文件路径无效。');
  const deadline = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(DOCUMENT_LIMITS.timeoutMs, timeoutMs)) : DOCUMENT_LIMITS.timeoutMs;
  return new Promise((resolve, reject) => {
    let worker, timer, settled = false;
    const finish = (value, error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      const stopped = worker ? worker.terminate().catch(() => {}) : Promise.resolve();
      stopped.then(() => { if (error) reject(error); else resolve(value); });
    };
    const abort = () => finish(undefined, cancelled());
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    try {
      worker = new Worker(new URL('./document-parser-worker.mjs', import.meta.url), {
        workerData: { filePath, format, limits: DOCUMENT_LIMITS },
        resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
        env: {}, execArgv: [], stdout: true, stderr: true,
      });
      // Library diagnostics can contain document text. Consume rather than forwarding them to application logs.
      worker.stdout.resume(); worker.stderr.resume();
      worker.once('message', value => finish(value));
      worker.once('error', () => finish(unavailable(format, 'error', '文档解析失败或超出资源限制，请简化文件后重试。')));
      worker.once('exit', () => { if (!settled) finish(unavailable(format, 'error', '文档解析进程已结束，未能读取内容。')); });
      timer = setTimeout(() => finish(unavailable(format, 'error', '文档解析超时，请拆分或简化文件后重试。')), deadline);
    } catch { finish(unavailable(format, 'error', '无法启动文档解析，请稍后重试。')); }
  });
}
