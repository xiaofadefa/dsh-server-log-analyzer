/**
 * 外部码表层：让"厂商手册"成为知识来源，而不是靠人肉抄进代码。
 *
 * 分工（重要）：
 *   · 厂商手册能顶的：**码 → 语义（meaning）/ 严重度 / 建议动作**，以及"这个码属于哪一类故障"。
 *     这正是本文件负责的层：数据驱动，改手册不用改代码。
 *   · 厂商手册顶不了的：**日志长什么样（句法/格式/时间戳）** 与 **跨源关联/换件阈值**。
 *     前者靠真实样本写解析器（io.js/parse.js），后者靠运维经验写规则与关联（rules.js/analyze.js）。
 *
 * 码表来源两级（用户目录优先，同码覆盖自带）：
 *   1. 插件自带模板：<pkg>/data/vendor-codes/*.json
 *   2. 用户导入：$DSH_HOME/server-log-analyzer/vendor-codes/*.json（从手册导出的 CSV/JSON 生成）
 *
 * 版权口径：本目录只放"我们自己的映射与来源标注"。厂商手册原文由使用者自己保管/导入，
 * 不随插件分发（导入结果落在他本机的 $DSH_HOME 下）。
 */

import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dshHome } from '../runtime.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, '..', '..');

export const SEVERITY_ALIASES = {
  critical: 'critical', crit: 'critical', fatal: 'critical', severe: 'critical', 紧急: 'critical', 严重: 'critical',
  major: 'major', error: 'major', err: 'major', 警告: 'major',
  minor: 'minor', warning: 'minor', warn: 'minor', caution: 'minor', 轻微: 'minor', 提示: 'minor',
  info: 'info', informational: 'info', notice: 'info', ok: 'info', 信息: 'info',
};

const CATEGORY_ALIASES = {
  内存: 'memory', memory: 'memory', cpu: 'cpu', processor: 'cpu', 处理器: 'cpu',
  电源: 'power', power: 'power', psu: 'power', 散热: 'thermal', 温度: 'thermal', thermal: 'thermal', fan: 'thermal',
  存储: 'storage', 硬盘: 'storage', storage: 'storage', disk: 'storage', drive: 'storage',
  raid: 'raid', 阵列: 'raid', pcie: 'pcie', 插槽: 'pcie', 网络: 'network', network: 'network',
  固件: 'firmware', bmc: 'firmware', firmware: 'firmware', 主板: 'board', 机箱: 'board', board: 'board',
  安全: 'security', security: 'security', 系统: 'os', os: 'os', other: 'other',
};

export function normalizeSeverity(value, fallback = 'major') {
  if (!value) return fallback;
  const key = String(value).trim().toLowerCase();
  return SEVERITY_ALIASES[key] || fallback;
}

export function normalizeCategory(value, fallback = 'other') {
  if (!value) return fallback;
  const key = String(value).trim().toLowerCase();
  return CATEGORY_ALIASES[key] || fallback;
}

/** 插件自带码表模板目录。 */
export function bundledCodesDir() {
  return path.join(PACKAGE_ROOT, 'data', 'vendor-codes');
}

/** 用户目录（手册导入结果落这里；同码覆盖自带模板）。 */
export function userCodesDir(home = dshHome()) {
  return path.join(home, 'server-log-analyzer', 'vendor-codes');
}

/* ─────────────────── 解析：JSON / CSV / TSV ─────────────────── */

function splitDelimited(text) {
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim() !== '');
  if (!lines.length) return { header: null, rows: [] };
  const delimiter = (lines[0].match(/\t/g) || []).length >= (lines[0].match(/,/g) || []).length ? '\t' : ',';
  const cells = (line) => {
    const out = [];
    let current = '';
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"') {
        if (quoted && line[i + 1] === '"') { current += '"'; i += 1; } else quoted = !quoted;
        continue;
      }
      if (ch === delimiter && !quoted) { out.push(current); current = ''; continue; }
      current += ch;
    }
    out.push(current);
    return out.map((value) => value.trim());
  };
  const header = cells(lines[0]).map((value) => value.toLowerCase().replace(/[\s_-]+/g, ''));
  return { header, rows: lines.slice(1).map(cells) };
}

const COLUMN_HINTS = {
  code: ['code', 'eventcode', 'eventid', 'id', '码', '事件码', '事件id', '编号'],
  meaning: ['meaning', 'message', 'description', 'event', 'text', '含义', '描述', '事件描述', '说明', '消息'],
  severity: ['severity', 'level', 'priority', 'severitylevel', '级别', '等级', '严重度', '严重性'],
  rule: ['rule', 'ruleid', 'internalrule', '规则', '内部规则'],
  category: ['category', 'type', 'class', '类别', '分类'],
  action: ['action', 'suggestion', 'resolution', 'recommendation', 'remedy', '建议', '处理', '处置', '解决方案'],
};

function pick(header, row, field) {
  if (!header) return '';
  for (const hint of COLUMN_HINTS[field]) {
    const index = header.indexOf(hint);
    if (index >= 0 && row[index]) return String(row[index]).trim();
  }
  return '';
}

/**
 * 把"手册导出的表格文本 / JSON"解析成码表。
 * 支持：
 *   · JSON：{brand, source, version, codes:{ CODE: {meaning, severity, rule?, category?, action?} }}
 *   · CSV/TSV：表头含 code/meaning/severity（中文表头也认），可选 rule/category/action
 * @param {string} text
 * @param {{ brand?: string, source?: string, version?: string }} [meta]
 */
export function parseCodeTableText(text, meta = {}) {
  const raw = String(text == null ? '' : text).replace(/^\uFEFF/, '').trim();
  if (!raw) throw new Error('码表内容为空');

  if (raw.startsWith('{') || raw.startsWith('[')) {
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const tables = list.map((entry) => ({
      brand: String(entry.brand || meta.brand || 'generic').toLowerCase(),
      source: entry.source || meta.source || '手册导入',
      version: entry.version || meta.version || '',
      codes: entry.codes || {},
    }));
    return tables.length === 1 ? tables[0] : tables;
  }

  const { header, rows } = splitDelimited(raw);
  const codes = {};
  for (const row of rows) {
    const code = pick(header, row, 'code');
    if (!code) continue;
    codes[code] = {
      meaning: pick(header, row, 'meaning'),
      severity: pick(header, row, 'severity'),
      rule: pick(header, row, 'rule') || undefined,
      category: pick(header, row, 'category') || undefined,
      action: pick(header, row, 'action') || undefined,
    };
  }
  if (!Object.keys(codes).length) {
    throw new Error('没能从表格里解析出任何事件码：请确认表头含 code/meaning/severity（中文表头"事件码/描述/级别"也认）');
  }
  return {
    brand: String(meta.brand || 'generic').toLowerCase(),
    source: meta.source || '手册导入',
    version: meta.version || '',
    codes,
  };
}

/** 把码表写到用户目录（文件名：<brand>-<version|imported>.json）。 */
export function writeCodeTable(table, options = {}) {
  const home = options.home || dshHome();
  const dir = userCodesDir(home);
  mkdirSync(dir, { recursive: true });
  const stamp = table.version ? String(table.version).replace(/[^\w.-]+/g, '-') : 'imported';
  const file = path.join(dir, `${table.brand}-${stamp}.json`);
  const payload = {
    brand: table.brand,
    source: table.source,
    version: table.version || '',
    importedAt: new Date().toISOString(),
    codes: table.codes,
  };
  writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
  clearCache();
  return { file, count: Object.keys(table.codes).length };
}

/* ─────────────────── 加载与查询 ─────────────────── */

let cache = null;

export function clearCache() {
  cache = null;
}

function readTablesFrom(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue;
    const file = path.join(dir, entry.name);
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || !parsed.codes) continue;
      out.push({
        brand: String(parsed.brand || 'generic').toLowerCase(),
        source: parsed.source || entry.name,
        version: parsed.version || '',
        codes: parsed.codes,
        file,
      });
    } catch {
      out.push({ brand: 'unknown', source: entry.name, version: '', codes: {}, file, error: 'JSON 解析失败' });
    }
  }
  return out;
}

/**
 * 加载码表（自带模板 + 用户导入），用户目录同码覆盖自带。
 * @param {{ home?: string, force?: boolean }} [options]
 */
export function loadCodeTables(options = {}) {
  const home = options.home || dshHome();
  if (cache && !options.force && cache.home === home) return cache;

  const bundled = readTablesFrom(bundledCodesDir());
  const user = readTablesFrom(userCodesDir(home));
  const index = new Map();   // key: `${brand}|${code}` 与 `${brand}|${前缀}`
  const sources = [];

  const addTable = (table, origin) => {
    const codes = table.codes || {};
    let count = 0;
    for (const [code, meta] of Object.entries(codes)) {
      if (!meta || typeof meta !== 'object') continue;
      const entry = {
        brand: table.brand,
        code,
        meaning: meta.meaning || meta.description || '',
        severity: normalizeSeverity(meta.severity, meta.severity ? undefined : 'major'),
        rule: meta.rule || null,
        category: meta.category ? normalizeCategory(meta.category) : null,
        action: meta.action || meta.suggestion || '',
        source: table.source,
        version: table.version,
        origin,
      };
      index.set(`${table.brand}|${code}`, entry);
      // 也注册大写键：日志里的 `0x080000d1` 与手册里的 `0x080000C1` 大小写常不一致
      const upper = code.toUpperCase();
      if (upper !== code) index.set(`${table.brand}|${upper}`, entry);
      count += 1;
    }
    sources.push({ brand: table.brand, source: table.source, version: table.version, count, origin, file: table.file, error: table.error });
  };

  // 先自带、后用户 → 用户覆盖
  for (const table of bundled) addTable(table, 'bundled');
  for (const table of user) addTable(table, 'user');

  cache = { home, index, sources, total: index.size };
  return cache;
}

const PREFIX_FALLBACK_BRANDS = ['lenovo', 'dell', 'hpe', 'huawei', 'inspur', 'supermicro'];

/**
 * 查码：先精确（品牌 → 通用），再前缀族（Lenovo 的 FQXSPxx 这类事件族）。
 * @param {{index: Map}} tables
 * @param {string} brand
 * @param {string} code
 */
export function lookupExternalCode(tables, brand, code) {
  if (!tables || !tables.index || !code) return null;
  const clean = String(code).trim();
  const upper = clean.toUpperCase();
  const brands = [String(brand || 'generic').toLowerCase(), 'generic', ...PREFIX_FALLBACK_BRANDS];
  for (const key of brands) {
    const hit = tables.index.get(`${key}|${clean}`) || tables.index.get(`${key}|${upper}`);
    if (hit) return hit;
  }
  // 前缀族：FQXSPMA0011M 命中 FQXSPMA 这类前缀条目（取最长前缀）
  let best = null;
  for (const key of brands) {
    for (const [indexKey, value] of tables.index) {
      const [tableBrand, tableCode] = indexKey.split('|');
      if (tableBrand !== key) continue;
      if (tableCode.length >= clean.length) continue;
      if (!upper.startsWith(tableCode.toUpperCase())) continue;
      if (!best || tableCode.length > best.code.length) best = value;
    }
  }
  return best;
}

/** 码表状态（doctor / CLI 用）。 */
export function codeTableStatus(options = {}) {
  const tables = loadCodeTables(options);
  return {
    bundledDir: bundledCodesDir(),
    userDir: userCodesDir(options.home || dshHome()),
    total: tables.total,
    sources: tables.sources,
    brands: Array.from(new Set(tables.sources.map((item) => item.brand))),
  };
}

export function codeTableFileStats(file) {
  try {
    const stat = statSync(file);
    return { size: stat.size, mtime: stat.mtime.toISOString() };
  } catch {
    return null;
  }
}
