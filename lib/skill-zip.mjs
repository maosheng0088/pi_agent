import yauzl from 'yauzl';
import { parseDocument } from 'yaml';
import { crc32 } from 'node:zlib';
import { HttpError } from './security.mjs';

const fail = message => new HttpError(400, message);
export async function readSkillZip(base64) {
  if (typeof base64 !== 'string' || !base64.length || base64.length > 14_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw fail('请上传不超过 10 MB 的 ZIP 文件。');
  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length > 10 * 1024 * 1024) throw fail('ZIP 文件不能超过 10 MB。');
  let zip;
  try { zip = await new Promise((resolve, reject) => yauzl.fromBuffer(buffer, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, value) => error ? reject(error) : resolve(value))); }
  catch { throw fail('无法读取 ZIP，请检查文件是否完整。'); }
  const files = []; const names = new Set(); let total = 0, count = 0;
  try {
    await new Promise((resolve, reject) => {
      zip.on('error', reject); zip.on('end', resolve);
      zip.on('entry', entry => {
        (async () => {
          if (++count > 500) throw fail('技能包最多包含 500 个文件和目录。');
          const name = entry.fileName, parts = name.replace(/\/$/, '').split('/');
          if (name.length > 240 || parts.some(p => !p || p === '.' || p === '..' || /[\\<>:"|?*\x00-\x1f]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p))) throw fail('ZIP 包含不安全的文件路径。');
          const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
          if (mode && mode !== 0x8000 && mode !== 0x4000) throw fail('技能包不能包含链接或特殊文件。');
          if (entry.generalPurposeBitFlag & 1) throw fail('不支持加密 ZIP。');
          const key = name.replace(/\/$/, '').toLowerCase();
          if (names.has(key)) throw fail('ZIP 包含重名文件。'); names.add(key);
          if (entry.uncompressedSize > 10 * 1024 * 1024 || total + entry.uncompressedSize > 40 * 1024 * 1024) throw fail('解压后单文件最多 10 MB，整个技能包最多 40 MB。');
          if (name.endsWith('/')) { zip.readEntry(); return; }
          const stream = await new Promise((res, rej) => zip.openReadStream(entry, (error, value) => error ? rej(error) : res(value)));
          const chunks = []; let size = 0, checksum = 0;
          for await (const chunk of stream) {
            size += chunk.length; total += chunk.length;
            if (size > 10 * 1024 * 1024 || total > 40 * 1024 * 1024) { stream.destroy(); throw fail('ZIP 解压大小超过限制。'); }
            chunks.push(chunk);
            checksum = crc32(chunk, checksum);
          }
          if (checksum !== entry.crc32) throw fail('ZIP 文件校验失败，请重新压缩或下载。');
          if (!parts.includes('__MACOSX') && parts.at(-1) !== '.DS_Store') files.push({ path: name, data: Buffer.concat(chunks) });
          zip.readEntry();
        })().catch(reject);
      });
      zip.readEntry();
    });
  } catch (error) { throw error instanceof HttpError ? error : fail('ZIP 文件损坏或包含不支持的内容。'); }
  finally { zip.close(); }
  const skills = files.filter(file => file.path.split('/').at(-1) === 'SKILL.md');
  const fileNames = new Set(files.map(file => file.path.toLowerCase()));
  for (const file of files) { const parts = file.path.toLowerCase().split('/'); parts.pop(); while (parts.length) { if (fileNames.has(parts.join('/'))) throw fail('ZIP 中的文件和目录发生冲突。'); parts.pop(); } }
  if (skills.length !== 1) throw fail('ZIP 必须包含且只包含一个 SKILL.md，可放在根目录或技能文件夹内。');
  const main = skills[0], prefix = main.path.slice(0, -'SKILL.md'.length);
  if (files.some(file => !file.path.startsWith(prefix))) throw fail('所有配套文件必须放在 SKILL.md 所在文件夹内。');
  if (main.data.length > 256 * 1024) throw fail('SKILL.md 不能超过 256 KB。');
  let source;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(main.data).replace(/^\uFEFF/, ''); } catch { throw fail('SKILL.md 必须使用 UTF-8 编码。'); }
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) throw fail('SKILL.md 须包含 YAML 头，其中填写 name 和 description。');
  let metadata;
  try { const doc = parseDocument(match[1]); if (doc.errors.length) throw new Error(); metadata = doc.toJS({ maxAliasCount: 20 }); } catch { throw fail('SKILL.md 的 YAML 元数据无效。'); }
  return { name: metadata?.name, description: metadata?.description, content: match[2], files: files.map(file => ({ ...file, path: file.path.slice(prefix.length) })) };
}
