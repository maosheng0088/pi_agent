import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { parseDocument, documentFormat, supportsDocument, DOCUMENT_LIMITS } from '../lib/document-parser.mjs';
import { makePdf, makeDocx, makeXlsx, makeZip } from './document-fixtures.mjs';

const directories = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('pi-document-parser-'));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
async function fixture(name, bytes) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-document-parser-')); directories.push(directory);
  const filePath = path.join(directory, name); await fs.writeFile(filePath, bytes);
  return { filePath, name, directory };
}
async function parse(name, bytes, options = {}) { return parseDocument({ ...await fixture(name, bytes), ...options }); }

test('document formats are explicit, case-insensitive, and exclude old office and executable formats', async () => {
  for (const [name, format] of [['a.PDF', 'pdf'], ['合同.docx', 'docx'], ['货物.XLSX', 'xlsx'], ['data.csv', 'csv'], ['readme.md', 'text'], ['x.markdown', 'text'], ['x.txt', 'text'], ['x.json', 'text']]) {
    assert.equal(documentFormat(name), format); assert.equal(supportsDocument(name), true);
  }
  for (const name of ['a.doc', 'a.xls', 'a.xlsm', 'a.docm', 'a.html', 'a.svg', 'a.js', 'a.py', 'a.png', undefined]) {
    assert.equal(supportsDocument(name), false); assert.equal(documentFormat(name), 'unsupported');
    const result = await parseDocument({ filePath: 'not-read', name });
    assert.equal(result.status, 'unsupported'); assert.equal(result.text, ''); assert.ok(result.warnings[0]);
  }
  assert.match((await parseDocument({ name: 'old.doc' })).warnings[0], /另存为 DOCX\/XLSX/);
});

test('PDF extracts text by one-based page and preserves original page count', async () => {
  const source = await fixture('shipment.pdf', makePdf(['Shipment 123', 'Appointment 42']));
  const before = await fs.readFile(source.filePath), result = await parseDocument(source);
  assert.equal(result.status, 'ready'); assert.equal(result.format, 'pdf'); assert.equal(result.pageCount, 2);
  assert.deepEqual(result.sections.map(value => [value.page, value.text]), [[1, 'Shipment 123'], [2, 'Appointment 42']]);
  assert.match(result.text, /第 1 页/); assert.match(result.text, /Appointment 42/); assert.equal(result.truncated, false);
  assert.deepEqual(await fs.readFile(source.filePath), before);
});

test('blank or scanned PDF requests OCR rather than claiming content was read', async () => {
  const result = await parse('scanned.pdf', makePdf([null, null]));
  assert.equal(result.status, 'needs_ocr'); assert.equal(result.text, ''); assert.equal(result.pageCount, 2);
  assert.match(result.warnings.join(' '), /视觉识别或 OCR/); assert.doesNotMatch(result.warnings.join(' '), /安装依赖/);
});

test('PDF page cap is explicit without replacing total page count with the parsed count', async () => {
  const result = await parse('long.pdf', makePdf(Array.from({ length: 101 }, (_, index) => `Page ${index + 1}`)));
  assert.equal(result.status, 'ready'); assert.equal(result.pageCount, 101); assert.equal(result.sections.length, 100);
  assert.equal(result.sections.at(-1).page, 100); assert.equal(result.truncated, true); assert.match(result.warnings.join(' '), /前 100 页/);
  assert.ok(!result.text.includes('Page 101'));
});

test('PDF text cap cancels extraction cleanly and preserves readable partial content', async () => {
  const result = await parse('long-page.pdf', makePdf('Appointment '.repeat(12_000), { fontSize: 0.001 }));
  assert.equal(result.status, 'ready'); assert.equal(result.truncated, true); assert.ok(result.text.length <= DOCUMENT_LIMITS.characters);
  assert.match(result.text, /Appointment/); assert.equal(result.pageCount, 1);
});

test('password-protected PDF reports an actionable error without exposing internals', async () => {
  const result = await parse('password.pdf', makePdf('Secret', { passwordProtected: true }));
  assert.equal(result.status, 'error'); assert.match(result.warnings.join(' '), /密码/); assert.equal(result.text, '');
});

test('DOCX extracts Chinese paragraphs as plain text and leaves the source immutable', async () => {
  const source = await fixture('操作手册.docx', makeDocx(['客户预约：请先检查箱号', '<script>plain text, never executed</script>']));
  const before = await fs.readFile(source.filePath), result = await parseDocument(source);
  assert.equal(result.status, 'ready'); assert.match(result.text, /客户预约/); assert.match(result.text, /<script>plain text/);
  assert.equal(result.sections.length, 1); assert.deepEqual(await fs.readFile(source.filePath), before);
  assert.equal(globalThis.documentParserFixtureExecuted, undefined);
});

test('DOCX without text reports OCR attention without inventing a successful body', async () => {
  const result = await parse('image-document.docx', makeDocx(''));
  assert.equal(result.status, 'needs_ocr'); assert.equal(result.text, ''); assert.deepEqual(result.sections, []);
  assert.match(result.warnings.join(' '), /空白或图片/); assert.match(result.warnings.join(' '), /OCR/);
});

test('XLSX returns typed cells and readable sheet text without evaluating formulas or links', async () => {
  const bytes = await makeXlsx([{ name: '加约记录', rows: [['账号', '预约', '通过', '备注'], ['009001', 2, true, { formula: '1+1', result: 2 }],
    ['009002', 1, false, { formula: 'HYPERLINK("https://example.invalid", "link")' }], ['009003', null, true, { text: 'source label', hyperlink: 'https://example.invalid/' }]] }]);
  const result = await parse('预约.xlsx', bytes);
  assert.equal(result.status, 'ready'); assert.equal(result.sheets.length, 1); assert.equal(result.sheets[0].name, '加约记录');
  assert.deepEqual(result.sheets[0].rows[1], ['009001', 2, true, 2]);
  assert.match(result.sheets[0].rows[2][3], /未计算/); assert.match(result.text, /工作表：加约记录/); assert.match(result.text, /009001\t2\ttrue\t2/);
  assert.match(result.warnings.join(' '), /不执行计算/);
});

test('XLSX enforces worksheet, row and column caps and marks partial data', async () => {
  const sheets = Array.from({ length: 6 }, (_, sheet) => ({ name: `Sheet${sheet + 1}`, rows: Array.from({ length: 102 }, (_, row) => Array.from({ length: 32 }, (_, col) => `${sheet}-${row}-${col}`)) }));
  const result = await parse('large.xlsx', await makeXlsx(sheets));
  assert.equal(result.status, 'ready'); assert.equal(result.sheets.length, 5); assert.equal(result.truncated, true);
  for (const sheet of result.sheets) { assert.equal(sheet.rows.length, 100); assert.equal(sheet.rows[0].length, 30); assert.equal(sheet.truncated, true); }
  assert.ok(result.text.length <= DOCUMENT_LIMITS.characters); assert.ok(!result.text.includes('Sheet6'));
});

test('CSV preserves leading zeros, quoted commas/newlines, escaped quotes and literal formulas', async () => {
  const result = await parse('records.csv', Buffer.from('\uFEFF账号,备注,公式\r\n009001,"a,b\nnext line","=1+1"\r\n009002,"two ""quotes""",@literal\r\n'));
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.sheets[0].rows, [['账号', '备注', '公式'], ['009001', 'a,b\nnext line', '=1+1'], ['009002', 'two "quotes"', '@literal']]);
  assert.match(result.text, /009001/); assert.match(result.warnings.join(' '), /不执行其中的公式/);
});

test('CSV handles UTF16 and explicit delimiter declarations and rejects broken quoting', async () => {
  const encoded = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('sep=;\r\n账号;数量\r\n009001;2', 'utf16le')]);
  const result = await parse('records.csv', encoded);
  assert.equal(result.status, 'ready'); assert.deepEqual(result.sheets[0].rows[1], ['009001', '2']);
  const semicolon = await parse('semicolon.csv', Buffer.from('"memo,with,commas";units\n"a,b,c";2'));
  assert.equal(semicolon.status, 'ready'); assert.deepEqual(semicolon.sheets[0].rows[1], ['a,b,c', '2']);
  const broken = await parse('broken.csv', Buffer.from('a,b\n"unterminated,42'));
  assert.equal(broken.status, 'error'); assert.match(broken.warnings[0], /引号/);
});

test('CSV row, column and cell bounds are explicit', async () => {
  const csv = Array.from({ length: 103 }, (_, row) => Array.from({ length: 32 }, (_, column) => `${row}:${column}`).join(',')).join('\n');
  const result = await parse('large.csv', Buffer.from(csv));
  assert.equal(result.status, 'ready'); assert.equal(result.sheets[0].rows.length, 100); assert.equal(result.sheets[0].rows[0].length, 30); assert.equal(result.truncated, true);
  const longCell = await parse('long-cell.csv', Buffer.from('x'.repeat(5000)));
  assert.equal(longCell.sheets[0].rows[0][0].length, 4000); assert.equal(longCell.truncated, true);
  const longText = await parse('long-text.csv', Buffer.from(Array.from({ length: 50 }, () => Array.from({ length: 30 }, () => 'q'.repeat(300)).join(',')).join('\n')));
  assert.equal(longText.truncated, true); assert.ok(longText.text.length <= DOCUMENT_LIMITS.characters);
});

test('TXT, Markdown and JSON stay plain text with character and line bounds', async () => {
  for (const name of ['notes.txt', 'readme.md', 'records.json']) {
    const result = await parse(name, Buffer.from('<script>globalThis.documentParserFixtureExecuted=true</script>\n{"shipment":42}'));
    assert.equal(result.status, 'ready'); assert.match(result.text, /<script>/); assert.match(result.text, /shipment/);
  }
  assert.equal(globalThis.documentParserFixtureExecuted, undefined);
  const long = await parse('long.txt', Buffer.from('清'.repeat(130_000)));
  assert.equal(long.truncated, true); assert.ok(long.text.length <= DOCUMENT_LIMITS.characters); assert.match(long.warnings.join(' '), /截取/);
  const lines = await parse('lines.txt', Buffer.from(Array.from({ length: 5100 }, (_, index) => `line${index}`).join('\n')));
  assert.equal(lines.truncated, true); assert.ok(!lines.text.includes('line5000')); assert.match(lines.warnings.join(' '), /5000 行/);
});

test('invalid files, binary text and absent paths produce bounded errors without private paths', async () => {
  for (const [name, bytes] of [['fake.pdf', Buffer.from('<html>not PDF</html>')], ['fake.docx', Buffer.from('not ZIP')], ['fake.xlsx', Buffer.from('not ZIP')], ['fake.txt', Buffer.from([0, 1, 2, 3])]]) {
    const source = await fixture(name, bytes), result = await parseDocument(source);
    assert.equal(result.status, 'error'); assert.ok(result.warnings[0]); assert.ok(!JSON.stringify(result).includes(source.directory));
  }
  assert.equal((await parseDocument({ filePath: 'relative.txt', name: 'relative.txt' })).status, 'error');
  const missing = await parseDocument({ filePath: path.join(os.tmpdir(), `absent-${randomBytes(8).toString('hex')}.txt`), name: 'absent.txt' });
  assert.equal(missing.status, 'error'); assert.match(missing.warnings[0], /不存在/);
});

test('ZIP preflight rejects oversized claims, high ratios, too many entries and path escapes before conversion', async () => {
  const oversized = makeZip([['word/document.xml', 'x']], { compression: false });
  const central = oversized.indexOf(Buffer.from('504b0102', 'hex')); oversized.writeUInt32LE(DOCUMENT_LIMITS.zipEntryBytes + 1, central + 24);
  for (const bytes of [oversized, makeZip([['word/document.xml', 'x'.repeat(200_000)]]),
    makeZip([['word/document.xml', '<root/>'], ...Array.from({ length: 2000 }, (_, index) => [`entry${index}`, 'x'])]),
    makeZip([['word/document.xml', '<root/>'], ['../escape', 'x']])]) {
    const result = await parse('unsafe.docx', bytes);
    assert.equal(result.status, 'error'); assert.equal(result.text, ''); assert.ok(result.warnings[0]);
  }
});

test('ZIP preflight checks actual inflated sizes even when the directory understates them', async () => {
  const bytes = makeZip([['word/document.xml', '<root>' + 'content'.repeat(4000) + '</root>']]);
  const central = bytes.indexOf(Buffer.from('504b0102', 'hex')); bytes.writeUInt32LE(1, central + 24);
  const result = await parse('misreported.docx', bytes);
  assert.equal(result.status, 'error'); assert.equal(result.text, '');
});

test('file intake rejects oversized sparse files and hard links before parsing', async () => {
  const source = await fixture('oversized.txt', Buffer.alloc(0));
  const handle = await fs.open(source.filePath, 'r+');
  try { await handle.truncate(DOCUMENT_LIMITS.fileBytes + 1); } finally { await handle.close(); }
  const oversized = await parseDocument(source); assert.equal(oversized.status, 'error'); assert.match(oversized.warnings[0], /50 MiB/);
  const linked = await fixture('source.txt', Buffer.from('private fixture'));
  await fs.link(linked.filePath, path.join(linked.directory, 'alias.txt'));
  const result = await parseDocument(linked); assert.equal(result.status, 'error'); assert.match(result.warnings[0], /普通文档文件/);
});

test('ZIP XML DTD/entity declarations and disguised macros are rejected without external access', async () => {
  const dtd = '<?xml version="1.0"?><!DOCTYPE root [<!ENTITY external SYSTEM "file:///private-test-sentinel">]><root>&external;</root>';
  for (const bytes of [makeZip([['word/document.xml', dtd]]), makeZip([['word/document.xml', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(dtd, 'utf16le')])]]),
    makeZip([['word/document.xml', '<root/>'], ['word/vbaProject.bin', 'macro bytes']])]) {
    const result = await parse('unsafe.docx', bytes);
    assert.equal(result.status, 'error'); assert.match(result.warnings[0], /DTD|实体|宏/); assert.ok(!result.warnings[0].includes('private-test-sentinel'));
  }
});

test('PDF extraction and text parsing obey cancellation and timeout without returning half results', async () => {
  const source = await fixture('large.pdf', makePdf(Array.from({ length: 101 }, () => 'Shipment')));
  const before = new AbortController(); before.abort();
  await assert.rejects(parseDocument({ ...source, signal: before.signal }), { name: 'AbortError' });
  const during = new AbortController(), pending = parseDocument({ ...source, signal: during.signal }); during.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  const timedOut = await parseDocument(source, { timeoutMs: 1 });
  assert.equal(timedOut.status, 'error'); assert.match(timedOut.warnings[0], /超时/); assert.equal(timedOut.text, '');
  assert.ok((await fs.stat(source.filePath)).size > 0);
});
