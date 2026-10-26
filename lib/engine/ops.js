/**
 * 运维操作库（runbook）：把厂商手册里的"命令 / 界面路径 / 操作步骤 / 检查项"变成可检索资产。
 *
 * 为什么单独一层（和 codes.js 的分工）：
 *   · codes.js 回答"这个事件码是什么故障"（码 → 语义）
 *   · ops.js   回答"遇到这个故障该敲什么命令 / 点哪个菜单"（故障 → 操作）
 *   两者都用"自带模板 + 用户导入两层、用户覆盖自带"的同一套模式，便于替换版本、不污染包内容。
 *
 * 数据格式（一个文件一个来源）：
 * {
 *   "brand": "huawei",
 *   "product": "RAID 控制卡（V2&V3）",
 *   "source": "华为V2&V3服务器 RAID 控制卡 用户指南 35",
 *   "version": "35 (2019-08-17)",
 *   "entries": [
 *     { "id": "...", "kind": "command|ui|step|check",
 *       "title": "查看 RAID 卡控制器事件日志",
 *       "category": "raid",                       // 复用规则库的类别
 *       "symptoms": ["RAID 降级", "硬盘掉盘"],      // 什么场景用
 *       "commands": ["storcli64 /c0 show events"],
 *       "steps": ["..."], "notes": "..." }
 *   ]
 * }
 *
 * 目录：插件自带 <pkg>/data/ops-runbooks/*.json；用户导入 $DSH_HOME/server-log-analyzer/ops-runbooks/
 * 版权口径同码表：自带目录只放我们提炼的条目（含来源标注），手册原文由使用者自己保管。
 */

import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dshHome } from '../runtime.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, '..', '..');

export const OPS_KINDS = {
  command: '命令',
  ui: '界面路径',
  step: '操作步骤',
  check: '检查项',
};

export function bundledOpsDir() {
  return path.join(PACKAGE_ROOT, 'data', 'ops-runbooks');
}

export function userOpsDir(home = dshHome()) {
  return path.join(home, 'server-log-analyzer', 'ops-runbooks');
}

let cache = null;
export function clearOpsCache() {
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
      const list = Array.isArray(parsed) ? parsed : [parsed];
      for (const table of list) {
        if (!table || typeof table !== 'object') continue;
        out.push({
          brand: String(table.brand || 'generic').toLowerCase(),
          product: table.product || '',
          source: table.source || entry.name,
          version: table.version || '',
          entries: Array.isArray(table.entries) ? table.entries : [],
          file,
        });
      }
    } catch (error) {
      out.push({ brand: 'unknown', source: entry.name, entries: [], file, error: 'JSON 解析失败' });
    }
  }
  return out;
}

/**
 * 加载运维操作库（自带 + 用户，用户覆盖同 id 条目）。
 * @param {{ home?: string, force?: boolean }} [options]
 */
export function loadOpsLibrary(options = {}) {
  const home = options.home || dshHome();
  if (cache && !options.force && cache.home === home) return cache;

  const bundled = readTablesFrom(bundledOpsDir());
  const user = readTablesFrom(userOpsDir(home));
  const byId = new Map();
  const sources = [];

  const addTable = (table, origin) => {
    let count = 0;
    for (const entry of table.entries || []) {
      if (!entry || typeof entry !== 'object') continue;
      const id = String(entry.id || `${table.brand}:${(entry.title || '').slice(0, 24)}:${count}`);
      byId.set(id, {
        id,
        kind: OPS_KINDS[entry.kind] ? entry.kind : 'step',
        title: entry.title || id,
        category: entry.category || 'other',
        symptoms: [].concat(entry.symptoms || []),
        commands: [].concat(entry.commands || []),
        steps: [].concat(entry.steps || []),
        notes: entry.notes || '',
        brand: table.brand,
        product: table.product,
        source: table.source,
        version: table.version,
        origin,
      });
      count += 1;
    }
    sources.push({ brand: table.brand, product: table.product, source: table.source, version: table.version, count, origin, file: table.file, error: table.error });
  };

  for (const table of bundled) addTable(table, 'bundled');
  for (const table of user) addTable(table, 'user');   // 用户后加载 → 同 id 覆盖自带

  cache = { home, entries: Array.from(byId.values()), sources, total: byId.size };
  return cache;
}

const FIELD_WEIGHT = { title: 4, symptoms: 3, commands: 3, steps: 1, notes: 1 };

/**
 * 检索操作条目：多词匹配 + 字段加权 + 品牌/类别/类型过滤。
 * @param {{entries: object[]}} library
 * @param {{ query?: string, brand?: string, category?: string, kind?: string, limit?: number }} [options]
 */
export function searchOps(library, options = {}) {
  if (!library || !library.entries) return [];
  const query = String(options.query || '').trim().toLowerCase();
  const terms = query.split(/[\s,，、;；]+/).filter((term) => term.length >= 2);

  const scored = [];
  for (const entry of library.entries) {
    if (options.brand && options.brand !== 'auto' && entry.brand !== options.brand) continue;
    if (options.category && entry.category !== options.category) continue;
    if (options.kind && entry.kind !== options.kind) continue;

    let score = query === '' ? 1 : 0;
    for (const term of terms) {
      for (const [field, weight] of Object.entries(FIELD_WEIGHT)) {
        const values = field === 'title' ? [entry.title] : (entry[field] || []);
        for (const value of values) {
          if (String(value).toLowerCase().includes(term)) score += weight;
        }
      }
      if (entry.category.toLowerCase() === term) score += 3;
      if (entry.brand === term) score += 2;
    }
    if (query !== '' && score === 0) continue;
    scored.push({ entry, score });
  }

  scored.sort((a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title));
  return scored.slice(0, options.limit || 10).map((item) => ({ ...item.entry, _score: item.score }));
}

/**
 * 把抽取结果写入用户目录。
 * @param {object} table - {brand, product, source, version, entries}
 * @param {{ home?: string }} [options]
 */
export function writeOpsTable(table, options = {}) {
  const home = options.home || dshHome();
  const dir = userOpsDir(home);
  mkdirSync(dir, { recursive: true });
  const stamp = table.version ? String(table.version).replace(/[^\w.-]+/g, '-') : 'imported';
  const file = path.join(dir, `${table.brand || 'generic'}-${stamp}.json`);
  writeFileSync(file, JSON.stringify({
    brand: table.brand || 'generic',
    product: table.product || '',
    source: table.source || '',
    version: table.version || '',
    importedAt: new Date().toISOString(),
    entries: table.entries || [],
  }, null, 2), 'utf8');
  clearOpsCache();
  return { file, count: (table.entries || []).length };
}

/** 状态（doctor / CLI 用）。 */
export function opsStatus(options = {}) {
  const library = loadOpsLibrary(options);
  const byKind = {};
  const byCategory = {};
  for (const entry of library.entries) {
    byKind[entry.kind] = (byKind[entry.kind] || 0) + 1;
    byCategory[entry.category] = (byCategory[entry.category] || 0) + 1;
  }
  return {
    bundledDir: bundledOpsDir(),
    userDir: userOpsDir(options.home || dshHome()),
    total: library.total,
    byKind,
    byCategory,
    sources: library.sources,
  };
}

/** 供报告使用：按类别/标题给出一条 finding 的相关操作条目（最多 n 条）。 */
export function relatedOps(library, { title = '', category = '', limit = 2 } = {}) {
  if (!library || !library.entries) return [];
  const direct = searchOps(library, { query: title, limit: limit * 2 });
  const picked = direct.slice(0, limit);
  if (picked.length >= limit) return picked;
  const byCategory = searchOps(library, { category, limit });
  for (const entry of byCategory) {
    if (picked.length >= limit) break;
    if (!picked.some((item) => item.id === entry.id)) picked.push(entry);
  }
  return picked.slice(0, limit);
}
