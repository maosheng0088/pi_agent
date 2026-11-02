import { deflateRawSync } from 'node:zlib';

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
}

/** Small independent fixture ZIP writer; never reads a user document. */
export function makeZip(entries, { compression = true } = {}) {
  const local = [], central = []; let offset = 0;
  for (const [name, value] of entries) {
    const filename = Buffer.from(name), data = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const compressed = compression ? deflateRawSync(data) : data;
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(compression ? 8 : 0, 8); header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(filename.length, 26);
    const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x800, 8); record.writeUInt16LE(compression ? 8 : 0, 10); record.writeUInt32LE(crc32(data), 16);
    record.writeUInt32LE(compressed.length, 20); record.writeUInt32LE(data.length, 24); record.writeUInt16LE(filename.length, 28); record.writeUInt32LE(offset, 42);
    local.push(header, filename, compressed); central.push(record, filename); offset += header.length + filename.length + compressed.length;
  }
  const index = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, index, end]);
}

function xml(value) { return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'); }

export function makeDocx(value = 'Shipment document') {
  const paragraphs = (Array.isArray(value) ? value : [value]).map(text => `<w:p><w:r><w:t xml:space="preserve">${xml(text)}</w:t></w:r></w:p>`).join('');
  return makeZip([
    ['[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
    ['_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
    ['word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr/></w:body></w:document>`],
  ]);
}

/** ASCII text PDF fixtures. A null/empty page represents a page with no text. */
export function makePdf(value = ['Shipment PDF'], { passwordProtected = false, fontSize = 12 } = {}) {
  const pages = Array.isArray(value) ? value : [value];
  const objects = [null, '<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const pageIds = [];
  for (const text of pages) {
    const pageId = objects.length, contentId = pageId + 1; pageIds.push(pageId);
    const encoded = String(text || '').replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
    const content = text ? `BT /F1 ${fontSize} Tf 50 750 Td (${encoded}) Tj ET` : '';
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  objects[2] = `<< /Type /Pages /Count ${pages.length} /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] >>`;
  let encryption = '';
  if (passwordProtected) {
    const id = objects.length;
    objects.push(`<< /Filter /Standard /V 1 /R 2 /O <${'00'.repeat(32)}> /U <${'00'.repeat(32)}> /P -4 /Length 40 >>`);
    encryption = ` /Encrypt ${id} 0 R /ID [<${'00'.repeat(16)}> <${'00'.repeat(16)}>]`;
  }
  const chunks = [Buffer.from('%PDF-1.4\n')], offsets = [0]; let length = chunks[0].length;
  for (let index = 1; index < objects.length; index++) {
    offsets[index] = length; const chunk = Buffer.from(`${index} 0 obj\n${objects[index]}\nendobj\n`); chunks.push(chunk); length += chunk.length;
  }
  const xref = `xref\n0 ${objects.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length} /Root 1 0 R${encryption} >>\nstartxref\n${length}\n%%EOF\n`;
  chunks.push(Buffer.from(xref)); return Buffer.concat(chunks);
}

/** Each sheet is {name,rows}; defaults to a small shipment table. */
export async function makeXlsx(sheets = [{ name: '预约', rows: [['shipment', 'units'], ['FBA-001', 12]] }]) {
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  for (const sheet of sheets) workbook.addWorksheet(sheet.name).addRows(sheet.rows);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
