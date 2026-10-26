#!/usr/bin/env node
/**
 * 手册抽取结果（CSV）→ 插件码表（JSON）后处理。
 *
 * 为什么需要这一层：
 *   抽取器只管"把码和它附近的文本捞出来"，但抽取结果往往缺 `severity` / `category`，
 *   而这些信息在厂商码里其实是**结构化**的，可以直接算出来，不必人读：
 *     · Lenovo XCC：`FQXS` + 3 字母域 + 4 位数字 + 严重度字母
 *       - 域：PCA 处理器 / PSD 存储 / PPW 电源 / PUN 散热 / PMA 内存 / PIO 插槽(PCIe)
 *             PEM 存储管理(RAID) / PBR 主板 / PSM 系统管理(BMC) / PSE 安全 / PAD 环境(风扇/温度)
 *       - 尾字母：I=info, N/W=minor, M=critical（Lenovo 手册约定）
 *     · Dell：前缀 MEM / PWR / CPU / FAN / TMP / VLT / DRV / STO / BAT / SEC / RAC / WDG 直接给类别
 *   有了 category/severity + rule 挂载，手册码表就能真正参与聚类与跨源关联。
 *
 * 用法：
 *   node scripts/codes-postprocess.mjs --csv manuals/out/dell-codes.csv   --brand dell   --source "..." --version "..."
 *   node scripts/codes-postprocess.mjs --csv manuals/out/lenovo-codes.csv --brand lenovo --source "..." --version "..."
 *   （默认写到 $DSH_HOME/server-log-analyzer/vendor-codes/，即"本机自用"，不随插件分发）
 *
 * 可选 `--out <路径>` 指定输出文件；`--sample 10` 打印前 10 条供抽查。
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, '..');
// 相对说明符由 ESM 按本文件 URL 解析（Windows 上传绝对路径会因缺少 file:// 前缀而失败）
const { parseCodeTableText, writeCodeTable, userCodesDir } = await import('../lib/engine/codes.js');

/* ── 结构化推断表 ─────────────────────────────────────────── */

// Lenovo XCC 域 → { category, rule }（rule 为空表示只给类别，不硬挂内部规则）
const LENOVO_DOMAINS = {
  PMA: { category: 'memory', rule: 'MEM_UCE', note: '内存事件族' },
  PCA: { category: 'cpu', rule: 'CPU_MCE', note: '处理器/传感器事件族' },
  PPW: { category: 'power', rule: 'PSU_FAIL', note: '电源事件族' },
  PUN: { category: 'thermal', rule: 'FAN_FAIL', note: '散热/温度事件族' },
  PAD: { category: 'thermal', rule: null, note: '环境(风扇/温度)事件族' },
  PSD: { category: 'storage', rule: 'DRIVE_FAIL', note: '硬盘/存储事件族' },
  PEM: { category: 'raid', rule: 'RAID_CONTROLLER', note: 'RAID/存储管理事件族' },
  PIO: { category: 'pcie', rule: 'PCIE_DEVICE_ERROR', note: '插槽/PCIe 事件族' },
  PBR: { category: 'board', rule: 'BOARD_ERROR', note: '主板事件族' },
  PSM: { category: 'firmware', rule: 'BMC_RESET', note: '系统管理(BMC)事件族' },
  PSE: { category: 'security', rule: 'SECURE_BOOT_TPM', note: '安全事件族' },
  PFW: { category: 'firmware', rule: 'FW_UPDATE', note: '固件事件族' },
  PCL: { category: 'firmware', rule: null, note: 'LXPM(部署/配置)事件族' },
  PAD2: { category: 'thermal', rule: null, note: '环境事件族' },
};

const LENOVO_SEVERITY_LETTER = { I: 'info', N: 'minor', W: 'minor', M: 'critical', S: 'major' };

// Dell 前缀 → { category, rule }
const DELL_PREFIXES = [
  { prefix: 'MEM', category: 'memory', rule: null, note: '内存' },
  { prefix: 'CPU', category: 'cpu', rule: null, note: '处理器' },
  { prefix: 'PWR', category: 'power', rule: null, note: '电源' },
  { prefix: 'VLT', category: 'power', rule: 'VOLT_OUT_OF_RANGE', note: '电压' },
  { prefix: 'BAT', category: 'power', rule: 'BATTERY', note: '电池' },
  { prefix: 'FAN', category: 'thermal', rule: null, note: '风扇' },
  { prefix: 'TMP', category: 'thermal', rule: 'THERMAL_TEMP_HIGH', note: '温度' },
  { prefix: 'DRV', category: 'storage', rule: null, note: '硬盘' },
  { prefix: 'PDR', category: 'storage', rule: null, note: '物理盘' },
  { prefix: 'STO', category: 'raid', rule: null, note: '存储/RAID' },
  { prefix: 'RFC', category: 'pcie', rule: null, note: 'PCIe/插槽' },
  { prefix: 'PCI', category: 'pcie', rule: null, note: 'PCIe' },
  { prefix: 'NIC', category: 'network', rule: null, note: '网卡' },
  { prefix: 'HWC', category: 'board', rule: null, note: '硬件配置' },
  { prefix: 'SEC', category: 'security', rule: 'INTRUSION', note: '安全/机箱' },
  { prefix: 'RAC', category: 'firmware', rule: null, note: 'iDRAC/BMC' },
  { prefix: 'WDG', category: 'firmware', rule: 'BMC_WATCHDOG', note: '看门狗' },
  { prefix: 'BIOS', category: 'firmware', rule: 'BIOS_POST_ERROR', note: 'BIOS' },
  { prefix: 'UEFI', category: 'firmware', rule: null, note: 'UEFI' },
  { prefix: 'NVR', category: 'firmware', rule: 'NVRAM_ERROR', note: 'NVRAM' },
  { prefix: 'SWC', category: 'firmware', rule: null, note: '软件控制器' },
  { prefix: 'CBL', category: 'board', rule: null, note: '线缆/连接' },
  { prefix: 'RFM', category: 'power', rule: null, note: '冗余' },
];

const SEVERITY_FROM_TEXT = [
  { re: /\b(critical|fatal|severe)\b/i, sev: 'critical' },
  { re: /\b(warning|warn|caution)\b/i, sev: 'minor' },
  { re: /\b(error|failed|failure|fault)\b/i, sev: 'major' },
  { re: /\b(informational|info|notice)\b/i, sev: 'info' },
];

/** 华为部件类别 → 可挂的内部规则（有对应语义的才挂，避免硬套）。 */
const HUAWEI_COMPONENT_RULES = {
  memory: 'MEM_UCE',
  cpu: 'CPU_MCE',
  power: 'PSU_FAIL',
  thermal: 'THERMAL_TEMP_HIGH',
  storage: 'DRIVE_FAIL',
  raid: 'RAID_CONTROLLER',
  pcie: 'PCIE_DEVICE_ERROR',
  network: 'NIC_HW_ERROR',
  firmware: 'BMC_RESET',
  board: 'BOARD_ERROR',
};

function inferFromCode(brand, code, row = {}) {
  const upper = String(code || '').toUpperCase();
  if (brand === 'huawei' && row.category) {
    // 华为 ALM 手册的抽取结果自带"部件"列（CPU / Memory / PCIe Card / Power / Fan / Chassis …），
    // 比按码前缀猜更准，直接用。
    return { category: row.category, rule: HUAWEI_COMPONENT_RULES[row.category] || null, severity: '', note: `华为 ALM（部件：${row.component || row.category}）` };
  }
  if (brand === 'lenovo' && upper.startsWith('FQX') && upper.length >= 10) {
    const domainKey = upper.slice(4, 7);
    const domain = LENOVO_DOMAINS[domainKey] || null;
    const tail = upper.slice(-1);
    return {
      category: domain ? domain.category : 'other',
      rule: domain ? domain.rule : null,
      severity: LENOVO_SEVERITY_LETTER[tail] || '',
      note: domain ? `Lenovo ${domain.note}（域 ${domainKey}，尾字母 ${tail}）` : 'Lenovo 未知事件族',
    };
  }
  if (brand === 'dell') {
    const hit = DELL_PREFIXES.find((item) => upper.startsWith(item.prefix));
    if (hit) return { category: hit.category, rule: hit.rule, severity: '', note: `Dell ${hit.note}` };
  }
  return { category: 'other', rule: null, severity: '', note: '' };
}

function severityFromMeaning(meaning) {
  for (const item of SEVERITY_FROM_TEXT) {
    if (item.re.test(meaning || '')) return item.sev;
  }
  return '';
}

/* ── CSV 读取（抽取器输出：code,meaning,severity,action,raw_block） ── */

function parseCsv(text) {
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim() !== '');
  if (!lines.length) return [];
  const split = (line) => {
    const out = [];
    let current = '';
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"') {
        if (quoted && line[i + 1] === '"') { current += '"'; i += 1; } else quoted = !quoted;
        continue;
      }
      if (ch === ',' && !quoted) { out.push(current); current = ''; continue; }
      current += ch;
    }
    out.push(current);
    return out.map((value) => value.trim());
  };
  const header = split(lines[0]).map((value) => value.toLowerCase());
  return lines.slice(1).map((line) => {
    const cells = split(line);
    const row = {};
    header.forEach((key, index) => { row[key] = cells[index] || ''; });
    return row;
  });
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    out[key] = value;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.csv || !args.brand) {
  process.stdout.write('用法：node scripts/codes-postprocess.mjs --csv <抽取结果.csv> --brand <dell|lenovo|...> [--source "..."] [--version "..."] [--out <file>] [--sample 10] [--home <DSH_HOME>]\n');
  process.exit(2);
}

const csvText = await fsp.readFile(path.resolve(args.csv), 'utf8');
const rows = parseCsv(csvText);
const brand = String(args.brand).toLowerCase();

const codes = {};
let inferredCategory = 0;
let inferredSeverity = 0;
let ruleMounted = 0;

for (const row of rows) {
  const code = (row.code || '').trim();
  if (!code) continue;
  const guess = inferFromCode(brand, code, row);
  const meaning = (row.meaning || '').trim();
  // Lenovo 尾字母（I/N/W/M）是结构化的严重度，优先于 CSV 列与文本推断
  const severity = guess.severity
    || (row.severity || '').trim()
    || severityFromMeaning(meaning)
    || '';
  const componentTag = row.component && !guess.note ? `（部件：${row.component}）` : '';
  if (guess.category && guess.category !== 'other') inferredCategory += 1;
  if (guess.severity && guess.severity !== (row.severity || '').trim()) inferredSeverity += 1;
  if (guess.rule) ruleMounted += 1;
  codes[code] = {
    meaning: meaning ? `${meaning}${componentTag}${guess.note ? `　[${guess.note}]` : ''}` : (guess.note || '（手册抽取：无描述，待补）'),
    severity: severity || 'major',
    ...(guess.rule ? { rule: guess.rule } : {}),
    ...(guess.category ? { category: guess.category } : {}),
    ...(row.action ? { action: row.action } : {}),
  };
}

const table = {
  brand,
  source: args.source || path.basename(args.csv),
  version: args.version || '',
  codes,
};

const written = writeCodeTable(table, args.home ? { home: args.home } : {});
process.stdout.write([
  `码表已生成：${written.file}`,
  `  品牌=${brand}  条目=${written.count}`,
  `  类别推断成功=${inferredCategory}  严重度推断成功=${inferredSeverity}  挂到内部规则=${ruleMounted}`,
  `  来源标注=${table.source}${table.version ? `（${table.version}）` : ''}`,
  `  导入目录=${userCodesDir(args.home)}`,
  '',
].join('\n'));

const sampleSize = Number(args.sample || 0);
if (sampleSize > 0) {
  const entries = Object.entries(codes).slice(0, sampleSize);
  for (const [code, meta] of entries) {
    process.stdout.write(`${code} | ${meta.severity} | ${meta.category || '-'} | ${meta.rule || '-'} | ${String(meta.meaning).slice(0, 90)}\n`);
  }
}
