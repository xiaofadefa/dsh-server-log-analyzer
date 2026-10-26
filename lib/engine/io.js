/**
 * 文件收集与读取：把"用户给的路径/压缩包/网页导出/二进制 SEL"统一变成 [{file, text}]。
 *
 * 现实约束（现场常见）：
 *   · 进不去 OS → 只有带外日志；BMC 网页导出的可能是 **HTML/CSV**，一键收集是 **zip**，
 *     有些机器只能导 **二进制 SEL（.bin）**；
 *   · 国产/中文导出常是 **GBK/GB18030**，按 UTF-8 读会整篇乱码（这是最容易被忽略的坑）；
 *   · 一键收集包里几十上百个文件，大部分是配置和十六进制 dump，要按"相关性"取前 N 个。
 *
 * 所以这一层负责：编码嗅探 → 归档展开 → 二进制 SEL 解码 → HTML 清洗 →
 * 文件名相关性排序 → 限流，输出统一文本，后续 parse/analyze 完全复用。
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { gunzipSync, inflateRawSync } from 'node:zlib';
import { binarySelToLines, looksLikeBinarySel } from './ipmi-sel-binary.js';

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '__pycache__', '.venv', 'venv',
  'dist', 'build', '.cache', 'AppData', 'Windows',
]);

const TEXT_EXT = new Set([
  '.log', '.txt', '.out', '.err', '.json', '.jsonl', '.ndjson', '.csv', '.tsv',
  '.md', '.sel', '.evt', '.xml', '.yaml', '.yml', '.conf', '.trace', '.dmesg',
  '.messages', '.htm', '.html', '.bin', '.dat', '.lst',
]);

const ARCHIVE_EXT = new Set(['.zip', '.gz', '.tgz', '.tar']);

const BINARY_EXT = new Set([
  '.7z', '.rar', '.xz', '.bz2', '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.exe', '.dll', '.so', '.iso', '.img', '.pyc', '.class', '.jar', '.db', '.sqlite',
]);

const EXCEL_EXT = new Set(['.xls', '.xlsx']);

/** 归档/收集包里的条目数量与体积上限（防止把一次分析变成解压炸弹）。 */
export const ARCHIVE_LIMITS = { maxEntries: 120, maxEntryBytes: 8 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024, maxDepth: 2 };

/** 文件名相关性：一键收集包里 SEL/健康/传感器才是我们要的，配置和 dump 不是。 */
export function relevanceScore(filePath) {
  const name = path.basename(String(filePath)).toLowerCase();
  const full = String(filePath).toLowerCase();
  if (/(sel|eventlog|event_log|event|iml|lifecycle|lclog|blackbox|faultlog|alarm)/.test(name)) return 4;
  if (/(health|sensor|thermal|powermon|fan)/.test(name)) return 3;
  if (/(log|fault|error|critical|smart|dump_status)/.test(name)) return 2;
  if (/(fru|version|inventory|board|config|cfg|\.ini|\.ya?ml)/.test(name)) return 0;
  if (/(hex|memdump|core|\.json$|\.xml$)/.test(full)) return 0;
  return 1;
}

export function classify(filePath) {
  const lower = String(filePath).toLowerCase();
  const ext = path.extname(lower);
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'archive';
  if (ARCHIVE_EXT.has(ext)) return 'archive';
  if (EXCEL_EXT.has(ext)) return 'excel';
  if (BINARY_EXT.has(ext)) return 'binary';
  if (TEXT_EXT.has(ext)) return 'text';
  return 'unknown';
}

/* ─────────────────────────── 编码嗅探 ─────────────────────────── */

let gbkDecoder;
function gbkText(buffer) {
  try {
    if (!gbkDecoder) gbkDecoder = new TextDecoder('gbk');
    return gbkDecoder.decode(buffer);
  } catch {
    return buffer.toString('latin1');
  }
}

function replacementRatio(text) {
  if (!text.length) return 0;
  const bad = (text.match(/\uFFFD/g) || []).length;
  return bad / text.length;
}

/** 中文字符占比：判断"哪种解码更对"的第二个信号。 */
function cjkRatio(text) {
  if (!text.length) return 0;
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  return cjk / text.length;
}

/**
 * 文本解码：UTF-8 优先，失败按 UTF-16 BOM / GBK(GB18030) 回退。
 * 现场最常踩的坑就是"国产 BMC 导出的中文日志是 GBK，被当 UTF-8 读成乱码"。
 * @param {Buffer} buffer
 * @returns {{ text: string, encoding: string }}
 */
export function decodeText(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { text: buffer.toString('utf16le', 2), encoding: 'utf-16le' };
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return { text: buffer.swap16().toString('utf16le', 2), encoding: 'utf-16be' };
  }

  const utf8 = buffer.toString('utf8');
  const utf8Bad = replacementRatio(utf8);
  if (utf8Bad === 0) return { text: utf8, encoding: 'utf-8' };

  const gbk = gbkText(buffer);
  const gbkBad = replacementRatio(gbk);
  if (gbkBad < utf8Bad || cjkRatio(gbk) > cjkRatio(utf8)) {
    return { text: gbk, encoding: 'gbk' };
  }
  return { text: utf8, encoding: 'utf-8(lossy)' };
}

/* ─────────────────────────── 归档展开 ─────────────────────────── */

/** 解析 zip：走中央目录，支持 stored(0)/deflate(8)；zip64 明确报错而不是静默出错。 */
export function unzip(buffer) {
  let eocd = -1;
  const floor = Math.max(0, buffer.length - 66000);
  for (let i = buffer.length - 22; i >= floor; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是标准 zip（未找到中央目录结束记录）');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  if (offset === 0xffffffff || count === 0xffff) throw new Error('zip64 压缩包暂不支持，请先解压再把目录交给本工具');

  const entries = [];
  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compSize = buffer.readUInt32LE(offset + 20);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const rawName = buffer.subarray(offset + 46, offset + 46 + nameLen);

    let name = rawName.toString('utf8');
    if (replacementRatio(name) > 0.2) name = gbkText(rawName); // 中文 Windows 压出的包常见 GBK 条目名

    if (localOffset + 30 <= buffer.length && buffer.readUInt32LE(localOffset) === 0x04034b50) {
      const localNameLen = buffer.readUInt16LE(localOffset + 26);
      const localExtraLen = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLen + localExtraLen;
      const raw = buffer.subarray(dataStart, Math.min(dataStart + compSize, buffer.length));
      if (!name.endsWith('/') && raw.length) {
        let data = null;
        try {
          data = method === 0 ? Buffer.from(raw) : (method === 8 ? inflateRawSync(raw) : null);
        } catch {
          data = null;
        }
        if (data) entries.push({ name, data });
      }
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** 解析 tar（含 tar.gz 解压后的裸 tar）。 */
export function untar(buffer) {
  const entries = [];
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.toString('utf8', 0, 100).replace(/\0[\s\S]*$/, '').trim();
    const prefix = header.toString('utf8', 345, 500).replace(/\0[\s\S]*$/, '').trim();
    const sizeText = header.toString('utf8', 124, 136).replace(/\0[\s\S]*$/, '').trim();
    const size = parseInt(sizeText || '0', 8) || 0;
    const typeFlag = String.fromCharCode(header[156] || 48);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const dataStart = offset + 512;
    if ((typeFlag === '0' || typeFlag === '\0') && fullName) {
      entries.push({ name: fullName, data: buffer.subarray(dataStart, dataStart + size) });
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

/* ─────────────────────────── HTML 清洗 ─────────────────────────── */

export function decodeHtmlEntities(text) {
  const named = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", mdash: '—', hellip: '…' };
  return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body) => {
    const lower = body.toLowerCase();
    if (named[lower] !== undefined) return named[lower];
    if (lower.startsWith('#x')) {
      const code = parseInt(lower.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (lower.startsWith('#')) {
      const code = parseInt(lower.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return match;
  });
}

/**
 * HTML/网页导出 → 行式文本。
 * 关键点：`</td>` 变 ` | `、`</tr>` 变换行 —— 这样"编号|时间|部件|事件|断言"的表格导出
 * 会自然变成 ipmitool SEL 同形态的行，直接被现有解析器吃掉。
 */
export function htmlToText(raw) {
  let text = String(raw == null ? '' : raw);
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  text = text.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ');
  text = text.replace(/<\s*(?:br|\/tr|\/p|\/div|\/li|\/h[1-6]|\/table|\/tbody|\/thead)\s*\/?>/gi, '\n');
  text = text.replace(/<\s*\/\s*(?:td|th)\s*>/gi, ' | ');
  text = text.replace(/<[^>]*>/g, ' ');
  text = decodeHtmlEntities(text);
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').replace(/\s*\|\s*/g, ' | ').trim())
    .map((line) => line.replace(/^(\|\s*)+|(\s*\|)+$/g, '').trim())
    .filter((line) => line !== '')
    .join('\n');
}

function looksLikeHtml(buffer, filePath) {
  const ext = path.extname(String(filePath).toLowerCase());
  if (ext === '.html' || ext === '.htm') return true;
  const head = buffer.subarray(0, 2048).toString('utf8').toLowerCase();
  return /<!doctype\s+html|<html[\s>]|<table[\s>]|<meta\s+charset/.test(head);
}

/* ─────────────────────────── 单文件装载 ─────────────────────────── */

export function looksBinary(buffer) {
  const limit = Math.min(buffer.length, 8192);
  for (let i = 0; i < limit; i += 1) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

/**
 * 读一个文件 → 一份或多份 {file, text}（归档会展开，二进制 SEL 会解码，HTML 会清洗）。
 * @param {string} file
 * @param {{ maxFileBytes?: number, depth?: number }} [options]
 * @returns {Promise<{ documents: object[], skipped: object[] }>}
 */
export async function loadDocument(file, options = {}) {
  const maxFileBytes = options.maxFileBytes || 32 * 1024 * 1024;
  const depth = options.depth || 0;
  const documents = [];
  const skipped = [];

  const stat = await fsp.stat(file);
  if (stat.size > maxFileBytes) {
    return { documents, skipped: [{ path: file, reason: `单文件超过 ${Math.round(maxFileBytes / 1024 / 1024)}MB，跳过` }] };
  }
  const buffer = await fsp.readFile(file);
  const kind = classify(file);

  if (kind === 'excel') {
    return {
      documents,
      skipped: [{
        path: file,
        reason: 'Excel 导出：请在 Excel/WPS 里另存为 CSV（或导出为 txt），或直接把导出的 zip/HTML 交给本工具',
      }],
    };
  }

  const isZip = buffer.length > 4 && buffer.readUInt32LE(0) === 0x04034b50;
  const isGzip = buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
  const isTar = buffer.length > 262 && buffer.toString('utf8', 257, 262) === 'ustar';

  if (kind === 'archive' || isZip || isGzip || isTar) {
    if (depth >= ARCHIVE_LIMITS.maxDepth) {
      return { documents, skipped: [{ path: file, reason: '压缩包嵌套层数过深，跳过' }] };
    }
    let entries = [];
    try {
      if (isZip) entries = unzip(buffer);
      else if (isGzip) {
        const inflated = gunzipSync(buffer);
        entries = (inflated.length > 262 && inflated.toString('utf8', 257, 262) === 'ustar')
          ? untar(inflated)
          : [{ name: path.basename(file).replace(/\.(gz|tgz)$/i, ''), data: inflated }];
      } else if (isTar) entries = untar(buffer);
    } catch (error) {
      return { documents, skipped: [{ path: file, reason: `压缩包解析失败：${error.message}` }] };
    }

    const usable = entries
      .filter((entry) => entry.data && entry.data.length && !/\/$/.test(entry.name))
      .sort((a, b) => relevanceScore(b.name) - relevanceScore(a.name))
      .slice(0, ARCHIVE_LIMITS.maxEntries);

    skipped.push({
      path: file,
      reason: `归档已展开：共 ${entries.length} 个条目，按相关性取前 ${usable.length} 个文本类条目参与分析`,
      note: true,
    });

    let total = 0;
    for (const entry of usable) {
      if (total + entry.data.length > ARCHIVE_LIMITS.maxTotalBytes) {
        skipped.push({ path: `${file}::${entry.name}`, reason: '归档累计解压体积超限，跳过' });
        continue;
      }
      if (entry.data.length > ARCHIVE_LIMITS.maxEntryBytes) {
        skipped.push({ path: `${file}::${entry.name}`, reason: '归档内单条目过大，跳过' });
        continue;
      }
      total += entry.data.length;
      const label = `${file}::${entry.name}`;
      const entryKind = classify(entry.name);

      if (entryKind === 'excel') {
        skipped.push({ path: label, reason: '归档内的 Excel 文件：请另存为 CSV 后分析' });
        continue;
      }
      if (looksLikeBinarySel(entry.data)) {
        const decoded = binarySelToLines(entry.data);
        documents.push({
          file: label,
          text: `${decoded.lines.join('\n')}\n`,
          size: entry.data.length,
          note: `二进制 SEL 已解码（${decoded.records.length} 条记录）`,
        });
        continue;
      }
      if (looksLikeHtml(entry.data, entry.name)) {
        documents.push({ file: label, text: htmlToText(entry.data.toString('utf8')), size: entry.data.length, note: 'HTML 导出已清洗为文本行' });
        continue;
      }
      if (looksBinary(entry.data)) {
        skipped.push({ path: label, reason: '归档内疑似二进制文件，跳过' });
        continue;
      }
      const decoded = decodeText(entry.data);
      documents.push({ file: label, text: decoded.text, size: entry.data.length, note: decoded.encoding === 'utf-8' ? '' : `按 ${decoded.encoding} 解码` });
    }
    return { documents, skipped };
  }

  if (kind === 'binary') {
    return { documents, skipped: [{ path: file, reason: '二进制/压缩文件，跳过' }] };
  }

  // 二进制 IPMI SEL（`ipmitool sel save` / BMC 网页导出的 .bin）
  if (looksLikeBinarySel(buffer)) {
    const decoded = binarySelToLines(buffer);
    documents.push({
      file,
      text: `${decoded.lines.join('\n')}\n`,
      size: buffer.length,
      note: `二进制 SEL 已解码（${decoded.records.length} 条记录）`,
    });
    return { documents, skipped };
  }

  if (looksLikeHtml(buffer, file)) {
    const decodedHtml = decodeText(buffer);
    documents.push({
      file,
      text: htmlToText(decodedHtml.text),
      size: buffer.length,
      note: `HTML 导出已清洗为文本行${decodedHtml.encoding === 'utf-8' ? '' : `（按 ${decodedHtml.encoding} 解码）`}`,
    });
    return { documents, skipped };
  }

  if (looksBinary(buffer)) {
    return { documents, skipped: [{ path: file, reason: '内容看起来是二进制（且不像 IPMI SEL），跳过' }] };
  }

  const decoded = decodeText(buffer);
  documents.push({ file, text: decoded.text, size: buffer.length, note: decoded.encoding === 'utf-8' ? '' : `按 ${decoded.encoding} 解码` });
  return { documents, skipped };
}

/* ─────────────────────────── 路径收集 ─────────────────────────── */

export async function collectFiles(targets, options = {}) {
  const maxFiles = options.maxFiles || 160;
  const maxDepth = options.maxDepth == null ? 3 : options.maxDepth;
  const explicit = [];
  const discovered = [];
  const skipped = [];

  async function walk(dir, depth) {
    if (discovered.length >= maxFiles || depth > maxDepth) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (error) {
      skipped.push({ path: dir, reason: `无法读取目录：${error.message}` });
      return;
    }
    for (const entry of entries) {
      if (discovered.length >= maxFiles) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (classify(full) === 'binary') {
        skipped.push({ path: full, reason: '二进制文件（图片/可执行/库），跳过' });
        continue;
      }
      discovered.push(full);
    }
  }

  for (const target of targets) {
    const resolved = path.resolve(String(target));
    let stat;
    try {
      stat = await fsp.stat(resolved);
    } catch (error) {
      skipped.push({ path: resolved, reason: `路径不存在：${error.message}` });
      continue;
    }
    if (stat.isDirectory()) await walk(resolved, 0);
    else if (classify(resolved) === 'binary') skipped.push({ path: resolved, reason: '二进制文件（图片/可执行/库），跳过' });
    else explicit.push(resolved);
  }

  // 显式点名的文件保序；目录里扫出来的按"相关性"排序（一键收集包默认先吃 SEL/健康/传感器）
  discovered.sort((a, b) => relevanceScore(b) - relevanceScore(a) || a.localeCompare(b));
  if (explicit.length + discovered.length > maxFiles) {
    skipped.push({ path: '(批量输入)', reason: `文件数超过上限 ${maxFiles}，已按相关性截断（SEL/事件/健康类优先）` });
  }
  return { files: [...explicit, ...discovered].slice(0, maxFiles), skipped };
}

/**
 * 读取目标 → [{file, text, size, note}]。
 * @param {string[]} targets - 文件/目录/压缩包。
 * @param {{ maxFiles?: number, maxFileBytes?: number, maxTotalBytes?: number }} [options]
 */
export async function readDocuments(targets, options = {}) {
  const maxTotalBytes = options.maxTotalBytes || 96 * 1024 * 1024;
  const { files, skipped } = await collectFiles(targets, options);
  const documents = [];
  const notes = [];
  let total = 0;

  for (const file of files) {
    if (total > maxTotalBytes) {
      skipped.push({ path: file, reason: `累计读取超过 ${Math.round(maxTotalBytes / 1024 / 1024)}MB，跳过` });
      continue;
    }
    try {
      const result = await loadDocument(file, { maxFileBytes: options.maxFileBytes });
      for (const document of result.documents) {
        total += document.size || 0;
        documents.push(document);
        if (document.note) notes.push(`${document.file}：${document.note}`);
      }
      // 归档展开这类"信息性提示"进 notes，不当成"跳过"报给用户
      for (const item of result.skipped) {
        if (item.note) notes.push(`${item.path}：${item.reason}`);
        else skipped.push(item);
      }
    } catch (error) {
      skipped.push({ path: file, reason: `读取失败：${error.message}` });
    }
  }

  return { documents, skipped, notes, totalBytes: total };
}

export function documentsFromText(text, name = '<粘贴内容>') {
  return [{ file: name, text: String(text == null ? '' : text), size: String(text || '').length }];
}

export async function writeTextFile(filePath, content) {
  const resolved = path.resolve(String(filePath));
  await fsp.mkdir(path.dirname(resolved), { recursive: true });
  await fsp.writeFile(resolved, content, 'utf8');
  return resolved;
}

export async function readJsonFile(filePath) {
  const raw = await fsp.readFile(path.resolve(String(filePath)), 'utf8');
  return JSON.parse(raw);
}
