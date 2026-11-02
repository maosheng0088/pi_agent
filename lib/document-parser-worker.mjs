import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yauzl from 'yauzl';

const { filePath, format, limits } = workerData;
const result = { format, status: 'ready', text: '', sections: [], warnings: [], truncated: false };
let remaining = limits.characters;
class ParseError extends Error {}
function warning(text) { if (!result.warnings.includes(text)) result.warnings.push(text); }
function truncate(text) { result.truncated = true; if (text) warning(text); }
function clean(value) { return String(value ?? '').toWellFormed().replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ''); }
function take(value, maximum = remaining) {
  const source = clean(value), length = Math.min(remaining, maximum);
  const output = source.slice(0, length);
  if (output.length < source.length) truncate('内容超过显示上限，已截取部分内容。');
  remaining -= output.length; return output;
}
function lineLimited(value) {
  const source = clean(value), lines = source.split(/\r\n|\r|\n/, limits.lines + 1);
  if (lines.length > limits.lines) { truncate(`文本超过 ${limits.lines} 行，已截取。`); return lines.slice(0, limits.lines).join('\n'); }
  return source.replace(/\r\n?/g, '\n');
}
function section(title, body, extra = {}) {
  const separator = result.sections.length ? '\n\n' : '';
  const heading = `${separator}【${title}】\n`;
  const available = Math.max(0, remaining - heading.length);
  const text = take(body, available);
  if (!text && body) return;
  if (heading.length > remaining) { truncate('内容超过显示上限，已截取部分内容。'); return; }
  remaining -= heading.length;
  result.sections.push({ title, text, ...extra }); result.text += heading + text;
}

async function readInput() {
  const resolved = path.resolve(filePath), before = await fs.lstat(resolved);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || await fs.realpath(resolved) !== resolved) throw new ParseError('只能解析普通文档文件。');
  if (before.size > limits.fileBytes) throw new ParseError('文件超过 50 MiB，无法解析。');
  const handle = await fs.open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size || opened.nlink !== 1) throw new ParseError('文件已变化，请重新上传后解析。');
    const bytes = Buffer.alloc(opened.size); let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (offset !== bytes.length || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || after.nlink !== 1) throw new ParseError('文件在读取期间发生变化，请重试。');
    return bytes;
  } finally { await handle.close(); }
}

function decodeText(bytes, xml = false) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe || bytes[0] === 0x3c && bytes[1] === 0) return new TextDecoder('utf-16le', { fatal: true }).decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff || bytes[0] === 0 && bytes[1] === 0x3c) return new TextDecoder('utf-16be', { fatal: true }).decode(bytes);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch {
    if (xml) throw new ParseError('文档 XML 编码无效。');
    try {
      const text = new TextDecoder('gb18030', { fatal: true }).decode(bytes);
      warning('文件按 GB18030 编码读取，建议另存为 UTF-8 后核对文字。'); return text;
    } catch { throw new ParseError('无法识别文本编码，请另存为 UTF-8 后重新上传。'); }
  }
}

async function preflightArchive(bytes, required) {
  if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50) throw new ParseError('文件内容与文档格式不匹配，或文档已加密。');
  const zip = await new Promise((resolve, reject) => yauzl.fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, value) => error ? reject(error) : resolve(value)));
  const entries = [], names = new Set(); let expanded = 0;
  try {
    await new Promise((resolve, reject) => {
      zip.on('error', reject); zip.once('end', resolve);
      zip.on('entry', entry => {
        try {
          if (entries.length >= limits.zipEntries) throw new ParseError('压缩文档条目过多，无法安全解析。');
          if (entry.generalPurposeBitFlag & 1 || ![0, 8].includes(entry.compressionMethod)) throw new ParseError('暂不支持加密或特殊压缩的文档。');
          if (entry.fileName.includes('\\') || entry.fileName.includes(':') || entry.fileName.includes('\0') || entry.fileName.split('/').some(part => part === '..' || part === '.')) throw new ParseError('压缩文档包含不安全的文件路径。');
          const canonical = entry.fileName.toLowerCase();
          if (names.has(canonical)) throw new ParseError('压缩文档包含重复条目，无法解析。');
          names.add(canonical);
          if (/vba(?:project|data)\.(?:bin|xml)$/i.test(entry.fileName)) throw new ParseError('含宏文档暂不解析，请另存为不含宏的 DOCX/XLSX。');
          if ((entry.externalFileAttributes >>> 16 & 0o170000) === 0o120000) throw new ParseError('压缩文档包含链接条目，无法解析。');
          expanded += entry.uncompressedSize;
          if (!Number.isSafeInteger(expanded) || expanded > limits.zipExpandedBytes || entry.uncompressedSize > limits.zipEntryBytes) throw new ParseError('文档解压后过大，请拆分文件后重试。');
          if (entry.uncompressedSize / Math.max(1, entry.compressedSize) > limits.zipCompressionRatio) throw new ParseError('文档压缩比例过高，无法安全解析。');
          entries.push(entry); zip.readEntry();
        } catch (error) { reject(error); zip.close(); }
      });
      zip.readEntry();
    });
    if (!names.has(required)) throw new ParseError('文件缺少必要的文档结构，无法解析。');
    let actualTotal = 0;
    for (const entry of entries) {
      if (entry.fileName.endsWith('/')) continue;
      const stream = await new Promise((resolve, reject) => zip.openReadStream(entry, (error, value) => error ? reject(error) : resolve(value)));
      let actual = 0; const chunks = /\.(?:xml|rels)$/i.test(entry.fileName) ? [] : null;
      for await (const chunk of stream) {
        actual += chunk.length; actualTotal += chunk.length;
        if (actual > limits.zipEntryBytes || actualTotal > limits.zipExpandedBytes || actual > entry.uncompressedSize) { stream.destroy(); throw new ParseError('文档实际解压大小超过安全上限。'); }
        if (chunks) chunks.push(chunk);
      }
      if (actual !== entry.uncompressedSize) throw new ParseError('压缩文档内容不完整。');
      if (chunks && /<!(?:DOCTYPE|ENTITY)\b/i.test(decodeText(Buffer.concat(chunks), true))) throw new ParseError('文档包含不支持的 DTD 或实体声明，无法安全解析。');
    }
  } finally { zip.close(); }
}

async function parsePdf(bytes) {
  if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new ParseError('文件内容不是有效 PDF。');
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const packageDirectory = fileURLToPath(new URL('../node_modules/pdfjs-dist/', import.meta.url));
  const loading = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0, stopAtErrors: true,
    useSystemFonts: false, disableFontFace: true, enableXfa: false, useWasm: false,
    useWorkerFetch: false, disableAutoFetch: true, disableStream: true, disableRange: true,
    cMapUrl: path.join(packageDirectory, 'cmaps').replaceAll('\\', '/') + '/', cMapPacked: true,
    standardFontDataUrl: path.join(packageDirectory, 'standard_fonts').replaceAll('\\', '/') + '/',
    maxImageSize: 0, isOffscreenCanvasSupported: false, isImageDecoderSupported: false });
  let document;
  try {
    document = await loading.promise;
    result.pageCount = document.numPages;
    const count = Math.min(document.numPages, limits.pages), empty = [];
    if (document.numPages > count) truncate(`PDF 共 ${document.numPages} 页，仅提取前 ${limits.pages} 页。`);
    let visibleCharacters = 0;
    for (let index = 1; index <= count; index++) {
      if (remaining < 32) { truncate('PDF 文字超过显示上限，后续页未提取。'); break; }
      const page = await document.getPage(index), reader = page.streamTextContent({ includeMarkedContent: false }).getReader();
      let text = '', stop = false;
      const available = Math.max(0, remaining - `\n\n【第 ${index} 页】\n`.length);
      try {
        while (!stop) {
          const { value, done } = await reader.read(); if (done) break;
          for (const item of value.items) {
            if (typeof item.str !== 'string') continue;
            const chunk = `${item.str}${item.hasEOL ? '\n' : ' '}`;
            if (text.length + chunk.length > available) {
              text += chunk.slice(0, Math.max(0, available - text.length));
              truncate('PDF 文字超过显示上限，已截取部分内容。'); stop = true; break;
            }
            text += chunk;
          }
        }
      } finally { if (stop) await reader.cancel(new Error('Document text limit reached')); reader.releaseLock(); page.cleanup(); }
      text = text.trim(); visibleCharacters += text.replace(/\s/g, '').length;
      if (!text) empty.push(index);
      section(`第 ${index} 页`, lineLimited(text), { page: index });
    }
    if (!visibleCharacters) {
      result.status = 'needs_ocr'; result.text = '';
      warning('未提取到可读文字，此 PDF 可能是扫描件或图片，需要视觉识别或 OCR。');
    } else if (empty.length) warning(`第 ${empty.slice(0, 15).join('、')}${empty.length > 15 ? '等' : ''} 页未提取到文字，图片或扫描内容需要视觉识别或 OCR。`);
  } finally { await loading.destroy(); }
}

async function parseDocx(bytes) {
  await preflightArchive(bytes, 'word/document.xml');
  const { default: mammoth } = await import('mammoth');
  const output = await mammoth.extractRawText({ buffer: bytes });
  if (output.messages?.length) warning('部分文档结构未能完整提取，请结合原文件核对。');
  const text = lineLimited(output.value).trim();
  if (!text) {
    result.status = 'needs_ocr';
    warning('文档未提取到可读文字，可能为空白或图片内容，需要视觉识别或 OCR。');
    return;
  }
  section('文档正文', text);
}

function cellValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'boolean' || typeof value === 'string') return value;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  if (value.formula !== undefined || value.sharedFormula !== undefined) {
    warning('公式仅展示文件内缓存结果，不执行计算；请核对缓存结果是否最新。');
    return value.result === undefined ? `=${clean(value.formula || value.sharedFormula).slice(0, limits.cellCharacters)}（未计算）` : cellValue(value.result);
  }
  if (Array.isArray(value.richText)) {
    let text = '';
    for (const part of value.richText) { text += clean(part.text).slice(0, limits.cellCharacters - text.length); if (text.length >= limits.cellCharacters) { truncate('部分单元格文字过长，已截取。'); break; } }
    return text;
  }
  return value.text !== undefined ? clean(value.text) : value.error !== undefined ? clean(value.error) : '';
}

function addSheet(name, sourceRows, wasTruncated = false) {
  const title = `工作表：${clean(name).slice(0, 100)}`, heading = `${result.sections.length ? '\n\n' : ''}【${title}】\n`;
  if (remaining <= heading.length) { truncate('表格文字超过显示上限，后续内容未提取。'); return; }
  remaining -= heading.length;
  const rows = [], lines = []; let clipped = wasTruncated;
  for (const sourceRow of sourceRows) {
    if (!remaining || rows.length >= limits.rows) { clipped = true; break; }
    const row = [], columns = Math.min(sourceRow.length, limits.columns);
    if (columns < sourceRow.length) clipped = true;
    for (let index = 0; index < columns; index++) {
      if (!remaining) { clipped = true; break; }
      const original = cellValue(sourceRow[index]);
      const source = original === null ? '' : clean(original);
      const text = take(source, Math.min(limits.cellCharacters, Math.max(0, remaining - 2)));
      if (text.length < source.length) clipped = true;
      row.push(typeof original === 'string' || text.length !== source.length ? text : original);
      if (index < columns - 1) { if (remaining) remaining--; else clipped = true; }
    }
    rows.push(row); lines.push(row.map(value => value === null ? '' : String(value)).join('\t'));
    if (remaining) remaining--; else clipped = true;
  }
  const text = lines.join('\n');
  result.sections.push({ title, text }); result.text += heading + text;
  result.sheets ||= []; result.sheets.push({ name: clean(name).slice(0, 100), rows, truncated: clipped });
  if (clipped) truncate('表格仅展示部分内容：最多 5 张工作表，每表 100 行、30 列，单元格最多 4000 字符，全文最多 120000 字符。');
}

async function parseXlsx(bytes) {
  await preflightArchive(bytes, 'xl/workbook.xml');
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes, { ignoreNodes: ['drawing', 'legacyDrawing', 'picture', 'dataValidations', 'conditionalFormatting', 'extLst', 'hyperlinks', 'headerFooter', 'pageSetup', 'pageMargins', 'sheetProtection'] });
  if (workbook.worksheets.length > limits.sheets) truncate(`文件共有 ${workbook.worksheets.length} 张工作表，仅提取前 ${limits.sheets} 张。`);
  for (const sheet of workbook.worksheets.slice(0, limits.sheets)) {
    const rows = [], rowCount = Math.min(sheet.rowCount, limits.rows), columns = Math.min(sheet.columnCount, limits.columns);
    for (let index = 1; index <= rowCount; index++) rows.push(Array.from({ length: columns }, (_, column) => sheet.getRow(index).getCell(column + 1).value));
    addSheet(sheet.name, rows, sheet.rowCount > limits.rows || sheet.columnCount > limits.columns);
    if (!remaining) break;
  }
  if (!workbook.worksheets.length) warning('文件中没有可读取的工作表。');
}

function parseCsv(bytes) {
  let text = decodeText(bytes).replace(/^\uFEFF/, '');
  if (text.includes('\0')) throw new ParseError('文件含有二进制内容，不是可读取的 CSV。');
  let delimiter = ',';
  const declaration = /^sep=([,;\t])\r?\n/i.exec(text);
  if (declaration) { delimiter = declaration[1]; text = text.slice(declaration[0].length); }
  else {
    const counts = [[',', 0], [';', 0], ['\t', 0]]; let quoted = false;
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if (char === '"' && quoted && text[index + 1] === '"') { index++; continue; }
      if (char === '"') { quoted = !quoted; continue; }
      if (!quoted && (char === '\r' || char === '\n')) break;
      if (!quoted) for (const pair of counts) if (char === pair[0]) pair[1]++;
    }
    delimiter = counts.sort((a, b) => b[1] - a[1])[0][0];
  }
  const rows = []; let row = [], cell = '', quoted = false, closedQuote = false, columns = 0, clipped = false, any = false;
  function character(value) { if (cell.length < limits.cellCharacters) cell += value; else clipped = true; }
  function field() { if (columns++ < limits.columns) row.push(cell); else clipped = true; cell = ''; closedQuote = false; }
  function endRow() { field(); rows.push(row); row = []; columns = 0; any = false; }
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { character('"'); index++; }
      else if (char === '"') { quoted = false; closedQuote = true; }
      else character(char);
      any = true; continue;
    }
    if (closedQuote && char !== delimiter && char !== '\r' && char !== '\n' && char !== ' ' && char !== '\t') throw new ParseError('CSV 引号结构无效，请核对文件格式。');
    if (char === delimiter) { field(); any = true; }
    else if (char === '\r' || char === '\n') {
      if (char === '\r' && text[index + 1] === '\n') index++;
      endRow(); if (rows.length >= limits.rows && index < text.length - 1) { clipped = true; break; }
    } else if (char === '"' && !cell && !closedQuote) { quoted = true; any = true; }
    else if (!closedQuote) { character(char); any = true; }
  }
  if (quoted) throw new ParseError('CSV 引号未闭合，请核对文件是否完整。');
  if (rows.length < limits.rows && (any || columns || cell)) endRow();
  addSheet('CSV', rows, clipped);
  if (!rows.length) warning('CSV 文件为空。');
  if (rows.some(row => row.some(value => /^[=+@]/.test(value)))) warning('CSV 单元格按纯文本读取，不执行其中的公式或链接。');
}

async function main() {
  // Parsers only receive bytes. No URLs, executable documents or external resources are loaded.
  globalThis.fetch = async () => { throw new ParseError('文档解析不允许访问外部网络资源。'); };
  const bytes = await readInput();
  if (format === 'pdf') await parsePdf(bytes);
  else if (format === 'docx') await parseDocx(bytes);
  else if (format === 'xlsx') await parseXlsx(bytes);
  else if (format === 'csv') parseCsv(bytes);
  else {
    const text = decodeText(bytes);
    if (text.includes('\0')) throw new ParseError('文件含有二进制内容，不是可读取的纯文本。');
    section('文本内容', lineLimited(text));
    if (!text.trim()) warning('文件没有可读取的文字内容。');
  }
  return result;
}

try { parentPort.postMessage(await main()); }
catch (error) {
  const reason = error instanceof ParseError ? error.message : error?.name === 'PasswordException' ? 'PDF 需要密码，请上传已解除密码保护的副本。'
    : error?.code === 'ENOENT' ? '文档文件不存在。' : '文档无法解析，可能已损坏、加密或格式不匹配，请转换后重新上传。';
  parentPort.postMessage({ format, status: 'error', text: '', sections: [], warnings: [reason], truncated: false });
}
