/**
 * 引擎门面：对外只暴露这几个函数（工具面 / CLI / 测试都走这里）。
 */

import { readDocuments, documentsFromText, writeTextFile, readJsonFile, collectFiles, loadDocument } from './io.js';
import { parseText, summarizeParse } from './parse.js';
import { analyzeDocuments, analyzeParsed, clusterEvents, scoreHealth, correlate } from './analyze.js';
import { renderMarkdown, renderBrief, toDigest } from './report.js';
import { collectPlan, renderCollectScript, normalizeCollectCommand, BRAND_CHOICES } from './collect.js';
import { makeBaseline, diffBaseline, renderDiffMarkdown, BASELINE_KIND } from './diff.js';
import { RULES, RULE_STATS, CATEGORY_LABELS, ruleById, categoryLabel } from './rules.js';
import { detectBrand, detectFormat, VENDOR_LABELS, FORMAT_LABELS, SOURCE_LABELS } from './detect.js';
import {
  parseIdlCode, parseIdlLine, idlSeverity, idlHaystack, IDL_COMPONENT_TYPES, IDL_COMPONENT_ALIASES,
} from './inspur-idl.js';
import {
  loadOpsLibrary, searchOps, writeOpsTable, opsStatus, relatedOps, OPS_KINDS,
  bundledOpsDir, userOpsDir,
} from './ops.js';
import {
  parseCodeTableText, writeCodeTable, codeTableStatus, loadCodeTables, lookupExternalCode,
  bundledCodesDir, userCodesDir, normalizeSeverity, normalizeCategory,
} from './codes.js';

export {
  readDocuments, documentsFromText, writeTextFile, readJsonFile, collectFiles, loadDocument,
  parseText, summarizeParse, analyzeDocuments, analyzeParsed, clusterEvents, scoreHealth, correlate,
  renderMarkdown, renderBrief, toDigest,
  collectPlan, renderCollectScript, normalizeCollectCommand, BRAND_CHOICES,
  makeBaseline, diffBaseline, renderDiffMarkdown, BASELINE_KIND,
  RULES, RULE_STATS, CATEGORY_LABELS, ruleById, categoryLabel,
  detectBrand, detectFormat, VENDOR_LABELS, FORMAT_LABELS, SOURCE_LABELS,
  parseIdlCode, parseIdlLine, idlSeverity, idlHaystack, IDL_COMPONENT_TYPES, IDL_COMPONENT_ALIASES,
  parseCodeTableText, writeCodeTable, codeTableStatus, loadCodeTables, lookupExternalCode,
  bundledCodesDir, userCodesDir, normalizeSeverity, normalizeCategory,
  loadOpsLibrary, searchOps, writeOpsTable, opsStatus, relatedOps, OPS_KINDS, bundledOpsDir, userOpsDir,
};

/**
 * 一步到位分析：本地路径 +（可选）直接粘贴的文本。
 * @param {{ paths?: string[], text?: string, textName?: string, vendor?: string, format?: string,
 *           maxFiles?: number, maxFindings?: number, includeNoise?: boolean, defaultYear?: number }} input
 * @returns {Promise<{ analysis: object, skipped: object[] }>}
 */
export async function analyzeTargets(input = {}) {
  const documents = [];
  const skipped = [];
  const notes = [];

  if (input.paths && input.paths.length) {
    const read = await readDocuments(input.paths, { maxFiles: input.maxFiles || 160 });
    documents.push(...read.documents);
    skipped.push(...read.skipped);
    notes.push(...(read.notes || []));
  }
  if (input.text && String(input.text).trim()) {
    documents.push(...documentsFromText(input.text, input.textName || '<粘贴内容>'));
  }
  if (documents.length === 0) {
    throw new Error('没有可分析的输入：请给出日志文件/目录/压缩包路径，或直接粘贴日志文本');
  }

  const analysis = analyzeDocuments(documents, {
    vendor: input.vendor || 'auto',
    format: input.format || 'auto',
    maxFindings: input.maxFindings || 12,
    includeNoise: Boolean(input.includeNoise),
    defaultYear: input.defaultYear,
    notes,
  });

  return { analysis, skipped, notes };
}

/** 规则库查询（给"这个工具能识别什么"用）。 */
export function rulesDigest(options = {}) {
  const { category, query, verbose } = options;
  let list = RULES;
  if (category && category !== 'all') list = list.filter((rule) => rule.cat === category);
  if (query) {
    const needle = String(query).toLowerCase();
    list = list.filter((rule) => rule.id.toLowerCase().includes(needle)
      || rule.title.toLowerCase().includes(needle)
      || rule.cat.toLowerCase().includes(needle)
      || JSON.stringify(rule.codes || {}).toLowerCase().includes(needle)
      || (rule.patterns || []).some((re) => re.source.toLowerCase().includes(needle)));
  }
  return {
    total: RULES.length,
    matched: list.length,
    byCategory: RULE_STATS.byCategory,
    categories: CATEGORY_LABELS,
    rules: list.map((rule) => ({
      id: rule.id,
      category: rule.cat,
      categoryLabel: categoryLabel(rule.cat),
      severity: rule.sev,
      title: rule.title,
      vendorCodes: rule.codes && Object.keys(rule.codes).length ? rule.codes : undefined,
      advice: verbose ? rule.advice : (rule.advice || []).slice(0, 1),
    })),
  };
}

/** 自检：规则库、码表、品牌识别、样例解析、技能文件是否就位（doctor / CLI 用）。 */
export async function doctor({ skillsDir, sampleDir } = {}) {
  const checks = [];
  checks.push({ name: '规则库加载', ok: RULE_STATS.total > 30, detail: `${RULE_STATS.total} 条规则，覆盖 ${Object.keys(RULE_STATS.byCategory).length} 个类别` });

  const tables = codeTableStatus();
  checks.push({
    name: '外部码表（厂商手册）',
    ok: tables.total > 0,
    detail: `${tables.total} 条码映射，来源：${tables.sources.filter((item) => item.count > 0).map((item) => `${item.brand}/${item.origin}`).join('、') || '无'}｜导入目录：${tables.userDir}`,
  });

  const ops = opsStatus();
  checks.push({
    name: '运维操作库（runbook）',
    ok: ops.total > 0,
    detail: `${ops.total} 条（命令 ${ops.byKind.command || 0} / 界面路径 ${ops.byKind.ui || 0} / 步骤 ${ops.byKind.step || 0} / 检查项 ${ops.byKind.check || 0}）｜导入目录：${ops.userDir}`,
  });

  const probe = analyzeDocuments([{
    file: '<doctor-probe>',
    text: [
      '2026-08-16 09:00:01 [Critical] [MEM0001] Memory device at DIMM_A1 is disabled: Uncorrectable ECC',
      '   1 | 08/16/2026 | 09:00:05 | Power Supply #0x51 | Power Supply | Failure detected | Asserted',
      'Aug 16 09:00:09 node01 kernel: EDAC MC0: 1 CE row 2, channel 0, label "DIMM_B1": Correctable ECC',
      'Aug 16 09:00:11 node01 kernel: pcieport 0000:65:00.0: AER: Uncorrected (Fatal) error received',
    ].join('\n'),
  }], {});
  const ruleIds = probe.findings.map((finding) => finding.ruleId).filter(Boolean);
  const expect = ['MEM_UCE', 'PSU_FAIL', 'MEM_CE', 'PCIE_AER_UE'];
  const hit = expect.filter((id) => ruleIds.includes(id));
  checks.push({
    name: '内置探针解析',
    ok: hit.length === expect.length,
    detail: `命中 ${hit.length}/${expect.length}（${hit.join(',') || '无'}）`,
  });

  const brandProbe = [
    { text: 'iDRAC Lifecycle Log: PowerEdge R750 MEM0701 memory', expect: 'dell' },
    { text: 'HPE ProLiant DL380 iLO IML: POST Error: 207-Memory', expect: 'hpe' },
    { text: '浪潮 Inspur BMC SEL: DIMM C1 UCE asserted', expect: 'inspur' },
    { text: 'Huawei iBMC SEL: Power supply unit 1 is faulty', expect: 'huawei' },
    { text: 'Lenovo XCC FQXSPMA0011M Memory DIMM A1 uncorrectable', expect: 'lenovo' },
  ].map((item) => ({ ...item, got: detectBrand(item.text).vendor }));
  const brandOk = brandProbe.every((item) => item.got === item.expect);
  checks.push({
    name: '品牌识别',
    ok: brandOk,
    detail: brandProbe.map((item) => `${item.expect}:${item.got === item.expect ? 'ok' : 'got ' + item.got}`).join(' '),
  });

  if (skillsDir) {
    try {
      const { listBundledSkills } = await import('../skills-install.js');
      const bundled = await listBundledSkills();
      checks.push({ name: '插件内置技能', ok: bundled.length > 0, detail: `${bundled.length} 个：${bundled.map((item) => item.id).join(', ')}` });
    } catch (error) {
      checks.push({ name: '插件内置技能', ok: false, detail: error.message });
    }
  }

  if (sampleDir) {
    const read = await readDocuments([sampleDir], { maxFiles: 40 });
    const sample = analyzeDocuments(read.documents, {});
    checks.push({
      name: '样例目录解析',
      ok: read.documents.length > 0,
      detail: `${read.documents.length} 个样例，得分 ${sample.health.score}（${sample.health.label}），命中 ${sample.coverage.matchedEvents} 条硬件事件`,
    });
  }

  return { ok: checks.every((check) => check.ok), checks };
}
