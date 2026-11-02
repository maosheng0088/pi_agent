'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const folder = path.join(__dirname, '..', 'assets');
fs.mkdirSync(folder, { recursive: true });
const table = Array.from({ length: 256 }, (_, value) => { for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; return value >>> 0; });
function crc32(buffer) { let value = 0xffffffff; for (const byte of buffer) value = table[(value ^ byte) & 255] ^ (value >>> 8); return (value ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const name = Buffer.from(type), length = Buffer.alloc(4), checksum = Buffer.alloc(4); length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(Buffer.concat([name, data]))); return Buffer.concat([length, name, data, checksum]); }
function roundRect(x, y, left, top, width, height, radius) { if (x < left || x >= left + width || y < top || y >= top + height) return false; const dx = Math.max(left + radius - x, 0, x - (left + width - radius)), dy = Math.max(top + radius - y, 0, y - (top + height - radius)); return dx * dx + dy * dy <= radius * radius; }
function polygon(x, y, points) { let inside = false; for (let i = 0, j = points.length - 1; i < points.length; j = i++) { const a = points[i], b = points[j]; if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside; } return inside; }
function png(size) {
  const data = Buffer.alloc((size * 4 + 1) * size), samples = 4, scale = 256 / size;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) { let alpha = 0, white = 0; for (let sy = 0; sy < samples; sy++) for (let sx = 0; sx < samples; sx++) { const px = (x + (sx + .5) / samples) * scale, py = (y + (sy + .5) / samples) * scale; if (!roundRect(px, py, 8, 8, 240, 240, 52)) continue; alpha++; if (roundRect(px, py, 65, 74, 128, 23, 9) || polygon(px, py, [[87, 90], [110, 90], [104, 176], [80, 176]]) || polygon(px, py, [[148, 90], [172, 90], [172, 159], [190, 159], [190, 181], [168, 181], [150, 168]])) white++; } const offset = y * (size * 4 + 1) + 1 + x * 4; if (!alpha) continue; const mix = white / alpha; data[offset] = Math.round(52 + (255 - 52) * mix); data[offset + 1] = Math.round(102 + (255 - 102) * mix); data[offset + 2] = Math.round(235 + (255 - 235) * mix); data[offset + 3] = Math.round(255 * alpha / (samples * samples)); }
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(data)), chunk('IEND', Buffer.alloc(0))]);
}
const sizes = [32, 64, 128, 256], images = sizes.map(png), header = Buffer.alloc(6 + sizes.length * 16); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4); let offset = header.length;
sizes.forEach((size, index) => { const position = 6 + index * 16; header[position] = size === 256 ? 0 : size; header[position + 1] = size === 256 ? 0 : size; header.writeUInt16LE(1, position + 4); header.writeUInt16LE(32, position + 6); header.writeUInt32LE(images[index].length, position + 8); header.writeUInt32LE(offset, position + 12); offset += images[index].length; });
fs.writeFileSync(path.join(folder, 'icon.png'), images.at(-1)); fs.writeFileSync(path.join(folder, 'icon.ico'), Buffer.concat([header, ...images]));
console.log('PiConsole application icons generated.');
