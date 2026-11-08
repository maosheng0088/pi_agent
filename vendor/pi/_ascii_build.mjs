import sharp from 'sharp';
import fs from 'fs';
import path from 'path';

const SRC = 'D:/code/pi/客服素材/01a182b5-3abe-77f3-b89e-bdcd7149714a';
const OUT = 'D:/code/pi/_ref';
fs.mkdirSync(OUT, { recursive: true });

const files = fs.readdirSync(SRC).filter(f => f.endsWith('.png')).sort();
const rows = [];

// analyze + thumbnail
const CELL = 300;
const PAD = 12;
const LABEL = 30;
const COLS = 4;
const n = files.length;
const GRID_ROWS = Math.ceil(n / COLS);

function hex(r, g, b) {
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : d / max;
  return [h, s, max];
}

const meta = [];

for (const f of files) {
  const p = path.join(SRC, f);
  const img = sharp(p);
  const m = await img.metadata();
  const buf = await img.raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = buf.info;
  const data = buf.data;

  // pixel stats
  let rs = 0, gs = 0, bs = 0, count = 0;
  const hist = new Array(4096).fill(0);
  const hueHist = new Array(36).fill(0);
  const colorCounts = new Map();
  let satSum = 0, satCount = 0;
  for (let i = 0; i < data.length; i += channels) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    rs += r; gs += g; bs += b; count++;
    const key = (r >> 4) << 8 | (g >> 4) << 4 | (b >> 4);
    hist[key]++;
    colorCounts.set(key, (colorCounts.get(key) || 0) + 1);
    const [h, s] = rgbToHsv(r, g, b);
    if (s > 0.12) { satSum += s; satCount++; hueHist[Math.floor(h / 10) % 36]++; }
  }
  const avg = [Math.round(rs / count), Math.round(gs / count), Math.round(bs / count)];
  const avgSat = satCount ? satSum / satCount : 0;

  // top quantized colors
  const top = [...colorCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const topColors = top.map(([k, c]) => {
    const r = ((k >> 8) & 15) * 17, g = ((k >> 4) & 15) * 17, b = (k & 15) * 17;
    return { hex: hex(r, g, b), pct: +(100 * c / count).toFixed(1) };
  });

  // dominant hue bucket
  let domHue = null, domCount = 0;
  for (let i = 0; i < 36; i++) if (hueHist[i] > domCount) { domCount = hueHist[i]; domHue = i * 10 + 5; }

  // edge density via grayscale gradient on a downscaled version
  const small = await sharp(p).resize(160, 160, { fit: 'fill' }).greyscale().raw().toBuffer();
  const SW = 160; let edges = 0, tot = 0;
  for (let y = 1; y < SW - 1; y++) {
    for (let x = 1; x < SW - 1; x++) {
      const i = y * SW + x;
      const gx = Math.abs(small[i + 1] - small[i - 1]);
      const gy = Math.abs(small[i + SW] - small[i - SW]);
      if (gx + gy > 24) edges++;
      tot++;
    }
  }
  const edgeDensity = 100 * edges / tot;

  const thumb = await sharp(p).resize(CELL, CELL, { fit: 'cover' }).png().toBuffer();

  meta.push({
    file: f,
    width: m.width, height: m.height,
    bytes: fs.statSync(p).size,
    format: m.format, channels: m.channels,
    avgHex: hex(...avg),
    avgSat: +avgSat.toFixed(3),
    domHue: domHue,
    domHuePct: +(100 * domCount / count).toFixed(1),
    edgeDensity: +edgeDensity.toFixed(3),
    topColors,
  });
  rows.push(thumb);
}

// compose 4x4 grid
const W = COLS * CELL + (COLS + 1) * PAD;
const H = GRID_ROWS * (CELL + LABEL) + (GRID_ROWS + 1) * PAD;
const comps = [];
for (let i = 0; i < rows.length; i++) {
  const c = i % COLS, r = Math.floor(i / COLS);
  const left = PAD + c * (CELL + PAD);
  const top = PAD + r * (CELL + LABEL + PAD);
  comps.push({ input: rows[i], left, top });
  // label bar
  const labelSvg = `<svg width="${CELL}" height="${LABEL}">
    <rect width="${CELL}" height="${LABEL}" fill="#111418"/>
    <text x="6" y="${LABEL - 10}" font-family="Consolas, monospace" font-size="12" fill="#c8d0da">${meta[i].file.replace('exec-', '').replace(/-[0-9a-f]{8}-.*/, '')}</text>
  </svg>`;
  comps.push({ input: Buffer.from(labelSvg), left, top: top + CELL });
}
const bg = { r: 24, g: 26, b: 30 };
await sharp({ create: { width: W, height: H, channels: 3, background: bg } })
  .composite(comps)
  .png()
  .toFile(path.join(OUT, 'assets-montage-4x4.png'));

// stats json
fs.writeFileSync(path.join(OUT, 'assets-stats.json'), JSON.stringify(meta, null, 2));

// CSV ledger
const cols = ['file', 'width', 'height', 'bytes_kb', 'avg_hex', 'avg_saturation', 'dominant_hue_deg', 'dominant_hue_pct', 'edge_density_pct', 'top5_colors'];
const esc = v => `"${String(v).replace(/"/g, '""')}"`;
const lines = [cols.join(',')];
for (const m of meta) {
  lines.push([
    esc(m.file), m.width, m.height, Math.round(m.bytes / 1024),
    esc(m.avgHex), m.avgSat, m.domHue, m.domHuePct, m.edgeDensity,
    esc(m.topColors.map(c => `${c.hex}(${c.pct}%)`).join(' '))
  ].join(','));
}
fs.writeFileSync(path.join(OUT, 'assets-ledger.csv'), '\uFEFF' + lines.join('\n'), 'utf8');

console.log(JSON.stringify({ montage: path.join(OUT, 'assets-montage-4x4.png'), grid: `${COLS}x${GRID_ROWS}`, size: `${W}x${H}`, count: meta.length }, null, 2));
for (const m of meta) {
  console.log(`${m.file.slice(5,13)}  ${m.avgHex}  sat=${m.avgSat}  hue=${m.domHue}  edge=${m.edgeDensity}%  ${m.topColors.map(c=>c.hex).join(' ')}`);
}
