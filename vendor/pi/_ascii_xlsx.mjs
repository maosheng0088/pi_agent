import fs from 'fs';
import path from 'path';
import XLSX from 'xlsx';
import sharp from 'sharp';

const SRC = 'D:/code/pi/客服素材/01a182b5-3abe-77f3-b89e-bdcd7149714a';
const OUT = 'D:/code/pi/_ref';
const meta = JSON.parse(fs.readFileSync(path.join(OUT, 'assets-stats.json'), 'utf8'));

function hueGroup(h) {
  if (h == null) return '灰阶';
  if (h < 15 || h >= 345) return '红/粉';
  if (h < 45) return '橙/棕';
  if (h < 70) return '黄';
  if (h < 160) return '绿';
  if (h < 200) return '青';
  if (h < 260) return '蓝';
  return '紫';
}
function composition(e) {
  if (e < 30) return '大色块/极简留白';
  if (e < 40) return '平滑渐变为主';
  if (e < 50) return '渐变+中等结构';
  return '密集笔触/强纹理';
}

const headers = ['文件名', '编号', '宽', '高', '体积(KB)', '格式', '通道', '平均色', '平均饱和度', '主色相(°)', '主色相占比(%)', '色系分组', '边缘密度(%)', '构图类型', '代表色 Top5'];
const rows = meta.map(m => ({
  '文件名': m.file,
  '编号': m.file.replace('exec-', '').slice(0, 8),
  '宽': m.width,
  '高': m.height,
  '体积(KB)': Math.round(m.bytes / 1024),
  '格式': m.format.toUpperCase(),
  '通道': m.channels,
  '平均色': m.avgHex,
  '平均饱和度': m.avgSat,
  '主色相(°)': m.domHue,
  '主色相占比(%)': m.domHuePct,
  '色系分组': hueGroup(m.domHue),
  '边缘密度(%)': m.edgeDensity,
  '构图类型': composition(m.edgeDensity),
  '代表色 Top5': m.topColors.map(c => `${c.hex} (${c.pct}%)`).join('  '),
}));

const ws = XLSX.utils.json_to_sheet(rows, { header: headers });
ws['!cols'] = [
  { wch: 46 }, { wch: 10 }, { wch: 7 }, { wch: 7 }, { wch: 10 }, { wch: 7 }, { wch: 7 },
  { wch: 10 }, { wch: 12 }, { wch: 11 }, { wch: 14 }, { wch: 11 }, { wch: 12 }, { wch: 18 }, { wch: 46 },
];
ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: headers.length - 1 } }) };

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, '素材台账');

// Sheet 2: montage image embedded
const imgPath = path.join(OUT, 'assets-montage-4x4.png');
const imgBuf = fs.readFileSync(imgPath);
const imgWs = XLSX.utils.aoa_to_sheet([['14 张素材 4×4 总览图（文件名短编号标注）'], ['原图尺寸：' + meta[0].width + ' × ' + meta[0].height + '，缩略后拼接'], ['']]);
XLSX.utils.book_append_sheet(wb, imgWs, '总览图');
if (!wb.Workbook) wb.Workbook = { Sheets: [] };
wb.Workbook.Sheets = [{ Hidden: 0 }, { Hidden: 0 }];
wb.Workbook.Views = [{}];
wb.Props = { Title: '客服素材台账', Author: 'Pi', Comments: '由 sharp 逐像素分析生成' };

const out = path.join(OUT, 'assets-ledger.xlsx');
XLSX.writeFile(wb, out);
console.log('xlsx written:', out, fs.statSync(out).size, 'bytes');
console.log('img buf', imgBuf.length);
