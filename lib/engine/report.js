/**
 * 报告层：把分析结论渲染成"能直接发给运维/工单系统"的 Markdown。
 */

import { SEVERITY_ZH, severityRank, truncate } from './text.js';
import { categoryLabel, RULE_STATS, CATEGORY_ACTIONS } from './rules.js';
import { OPS_KINDS } from './ops.js';

const SEV_ICON = { critical: '🔴', major: '🟠', minor: '🟡', info: '⚪' };

function esc(text) {
  return String(text == null ? '' : text).replace(/\|/g, '\\|');
}

/** 摘要里用短路径（长绝对路径只保留尾两段），证据行仍用完整路径以便定位。 */
function shortPath(filePath) {
  const raw = String(filePath == null ? '' : filePath);
  if (raw.length <= 48) return raw;
  const parts = raw.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return raw;
  return `…${parts.slice(-2).join('/')}`;
}

function sevCell(sev) {
  return `${SEV_ICON[sev] || ''} ${SEVERITY_ZH[sev] || sev}`;
}

function timeRange(first, last) {
  if (!first && !last) return '无时间戳';
  if (!first) return String(last);
  if (!last || first === last) return String(first);
  return `${first} → ${last}`;
}

/**
 * 渲染 Markdown 报告。
 * @param {object} analysis - analyzeParsed/analyzeDocuments 的返回值。
 * @param {{ title?: string, asset?: string, operator?: string, maxFindings?: number }} [options]
 * @returns {string}
 */
export function renderMarkdown(analysis, options = {}) {
  const title = options.title || '服务器硬件巡检分析报告';
  const asset = options.asset || '';
  const out = [];
  const totals = analysis.severityTotals || { critical: 0, major: 0, minor: 0, info: 0 };
  const counts = { critical: 0, major: 0, minor: 0, info: 0 };
  for (const finding of analysis.findings) counts[finding.sev] = (counts[finding.sev] || 0) + 1;

  out.push(`# ${title}${asset ? ` · ${asset}` : ''}`);
  out.push('');
  out.push(`> 生成时间：${analysis.generatedAt}　|　分析文件：${analysis.files.length} 个　|　规则库：${RULE_STATS.total} 条　|　操作者：${options.operator || '自动分析'}`);
  out.push('');

  /* ── 0. 结论摘要 ── */
  out.push('## 0. 结论摘要');
  out.push('');
  out.push(`- **健康评分：${analysis.health.score} / 100　（${analysis.health.grade} 级 · ${analysis.health.label}）** — ${analysis.health.advice}`);
  out.push(`- 告警统计（类数 / 次数）：紧急 ${counts.critical || 0} 类 / ${totals.critical || 0} 次　严重 ${counts.major || 0} 类 / ${totals.major || 0} 次　轻微 ${counts.minor || 0} 类 / ${totals.minor || 0} 次　提示 ${counts.info || 0} 类 / ${totals.info || 0} 次`);
  if (analysis.health.reasons.length) {
    out.push('- 扣分构成：');
    for (const reason of analysis.health.reasons) out.push(`  ${reason}`);
  }
  const topDiagnosis = analysis.correlations.slice(0, 3);
  if (topDiagnosis.length) {
    out.push('- 关键判断：');
    topDiagnosis.forEach((item, index) => {
      out.push(`  ${index + 1}. **${item.title}**：${item.statement}`);
    });
  }
  out.push('');

  /* ── 1. 台账 ── */
  out.push('## 1. 设备与日志台账');
  out.push('');
  const ledgerKeys = Object.keys(analysis.ledger || {});
  if (ledgerKeys.length === 0) {
    out.push('_未从日志里提取到台账字段（可补采 `racadm getsysinfo` / `ipmcget -d fru` / `dmidecode -t 1` 这类信息）_');
  } else {
    out.push('| 项目 | 值 | 证据（原始行） |');
    out.push('| --- | --- | --- |');
    const LABELS = {
      model: '机型', serial: '序列号/服务代码', hostname: '主机名', bmcVersion: '带外固件版本',
      biosVersion: 'BIOS 版本', cpuModel: '处理器', memoryTotal: '内存总量', osVersion: '操作系统',
      managementIp: '管理地址', powerSuppliesSeen: '日志中出现的电源编号', fansSeen: '日志中出现的风扇编号',
      dimmsSeen: '日志中出现的内存槽位',
    };
    for (const key of ledgerKeys) {
      const evidence = analysis.ledgerEvidence ? analysis.ledgerEvidence[key] : '';
      out.push(`| ${LABELS[key] || key} | ${esc(analysis.ledger[key])} | ${evidence ? '`' + esc(truncate(evidence, 90)) + '`' : ''} |`);
    }
    const vendorCount = Object.keys(analysis.vendors || {}).length;
    if (analysis.files.length > 1 && vendorCount > 1) {
      out.push('');
      out.push(`> ⚠️ 本次输入包含 **${analysis.files.length} 份日志 / ${vendorCount} 个品牌**：台账字段取"第一个有值的文件"，不保证同一台机器；` +
        '对比多台设备时请按第 2 节的文件清单逐台核对（或每台机器单独跑一次并把基线分开存）。');
    }
  }
  out.push('');

  /* ── 2. 输入文件 ── */
  out.push('## 2. 输入文件与解析覆盖');
  out.push('');
  out.push('| 文件 | 品牌 | 日志类型 | 记录数 | 命中硬件事件 | 未识别 | 非硬件忽略 |');
  out.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const file of analysis.files) {
    out.push(`| ${esc(shortPath(file.file))} | ${esc(file.vendor)} | ${esc(file.format)} | ${file.records} | ${file.matched} | ${file.unmatched} | ${file.noise} |`);
  }
  out.push(`| **合计** |  |  | **${analysis.coverage.records}** | **${analysis.coverage.matchedEvents}** | **${analysis.coverage.unmatchedRecords}** | **${analysis.coverage.noiseRecords}** |`);
  out.push('');

  /* ── 3. 分级发现 ── */
  out.push('## 3. 分级发现明细');
  out.push('');
  const groups = { critical: [], major: [], minor: [], info: [] };
  for (const finding of analysis.findings) {
    if (!groups[finding.sev]) groups[finding.sev] = [];
    groups[finding.sev].push(finding);
  }
  const order = ['critical', 'major', 'minor', 'info'];
  let serial = 0;
  for (const sev of order) {
    const list = groups[sev] || [];
    if (!list.length) continue;
    out.push(`### 3.${order.indexOf(sev) + 1} ${SEV_ICON[sev]} ${SEVERITY_ZH[sev]}（${list.length} 类）`);
    out.push('');
    for (const finding of list) {
      serial += 1;
      out.push(`#### ${serial}. ${finding.title}　·　${finding.categoryLabel}　·　×${finding.count}`);
      const meta = [];
      if (finding.slots.length) meta.push(`定位：${finding.slots.join('、')}`);
      if (finding.codes.length) meta.push(`事件码：${finding.codes.join(', ')}`);
      if (finding.maxTemp != null) meta.push(`最高温度：${finding.maxTemp}℃`);
      const span = finding.span && finding.span !== '0 秒' ? `（跨 ${finding.span}）` : '';
      meta.push(`时间：${timeRange(finding.first, finding.last)}${span}`);
      meta.push(`来源文件：${finding.files.map((file) => shortPath(file)).join('、')}`);
      if (finding.secondary.length) meta.push(`本类事件同行还命中：${finding.secondary.join(', ')}`);
      out.push(`- ${meta.join('　|　')}`);
      if (finding.details.length) {
        out.push(`- 抽取信息：${finding.details.map((item) => '`' + esc(item) + '`').join('　')}`);
      }
      if (finding.external) {
        out.push(`- 语义来源：${esc(finding.external.source)}${finding.external.version ? `（${esc(finding.external.version)}）` : ''}${finding.external.code ? `　事件码：${esc(finding.external.code)}` : ''}`);
      }
      if (finding.idl) {
        const bits = [`部件：${esc(finding.idl.componentLabel || '未知')}`];
        if (finding.idl.level) bits.push(`级别：${esc(finding.idl.level)}`);
        if (finding.idl.assertion) bits.push(`断言：${esc(finding.idl.assertion)}`);
        if (finding.idl.code) bits.push(`事件码：${esc(finding.idl.code)}`);
        out.push(`- 浪潮 IDL：${bits.join('　')}`);
        if (finding.idl.codeNote) out.push(`  - 事件码解读：${esc(finding.idl.codeNote)}`);
        if (finding.idl.reading) {
          out.push(`  - 读数：${esc(finding.idl.reading.sensor)} = ${finding.idl.reading.value}（${finding.idl.reading.direction === 'higher' ? '高于' : '低于'}阈值 ${finding.idl.reading.threshold}）`);
        }
      }
      out.push('- 证据：');
      for (const sample of finding.samples) {
        out.push(`  - \`${esc(sample.file)}:${sample.line}\`　${sample.ts ? `[${sample.ts}] ` : ''}${esc(sample.raw)}`);
      }
      const manualAction = finding.external && finding.external.action ? finding.external.action : '';
      const fallbackAction = CATEGORY_ACTIONS[finding.cat] || '';
      if (manualAction || finding.advice.length || fallbackAction) {
        out.push('- 处置动作：');
        if (manualAction) out.push(`  - （手册建议）${manualAction}`);
        for (const advice of finding.advice) out.push(`  - ${advice}`);
        if (!manualAction && !finding.advice.length && fallbackAction) out.push(`  - （按类别通用建议）${fallbackAction}`);
      }
      if (finding.relatedOps && finding.relatedOps.length) {
        out.push('- 相关操作（来自运维操作库 / 厂商手册）：');
        for (const entry of finding.relatedOps) {
          out.push(`  - 【${OPS_KINDS[entry.kind] || entry.kind}】${esc(entry.title)}${entry.source ? `　（${esc(entry.source)}${entry.version ? ` ${esc(entry.version)}` : ''}）` : ''}`);
          for (const command of (entry.commands || []).slice(0, 3)) out.push(`    - \`${esc(command)}\``);
          for (const step of (entry.steps || []).slice(0, 4)) out.push(`    - ${esc(step)}`);
        }
      }
      if (finding.unmatched) {
        out.push('- 说明：该事件未命中内置规则（保留原样以便扩展规则库；见第 8 节"未识别样本"）。');
      }
      out.push('');
    }
  }
  if (serial === 0) out.push('_未发现任何硬件相关事件：日志里没有可识别的硬件告警（注意区分"没问题"和"没采到"，见第 8 节）。_');
  out.push('');

  /* ── 4. 类别汇总 ── */
  out.push('## 4. 按类别汇总');
  out.push('');
  const cats = Object.entries(analysis.byCategory || {}).sort((a, b) => severityRank(b[1].worst) - severityRank(a[1].worst));
  if (!cats.length) {
    out.push('_无_');
  } else {
    out.push('| 类别 | 告警类数 | 事件次数 | 最高等级 |');
    out.push('| --- | --- | --- | --- |');
    for (const [cat, stats] of cats) {
      out.push(`| ${stats.label || categoryLabel(cat)} | ${stats.count} | ${stats.events} | ${sevCell(stats.worst)} |`);
    }
  }
  out.push('');

  /* ── 5. 根因关联 ── */
  out.push('## 5. 根因关联推断');
  out.push('');
  if (!analysis.correlations.length) {
    out.push('_本次日志中没有出现可组合成故障链的事件组合（单点告警按第 3 节逐条处理即可）。_');
  } else {
    for (const item of analysis.correlations) {
      out.push(`### ${SEV_ICON[item.sev]} ${item.title}`);
      out.push('');
      out.push(`- 判断：${item.statement}`);
      if (item.evidence.length) out.push(`- 依据事件：${item.evidence.join('；')}`);
      out.push('- 动作：');
      for (const action of item.actions) out.push(`  - ${action}`);
      out.push('');
    }
  }

  /* ── 6. 时间线 ── */
  out.push('## 6. 故障时间线（严重及以上）');
  out.push('');
  if (!analysis.timeline.length) {
    out.push('_无严重级以上事件。_');
  } else {
    out.push('| 时间 | 等级 | 事件 | 定位 | 来源 |');
    out.push('| --- | --- | --- | --- | --- |');
    for (const item of analysis.timeline) {
      out.push(`| ${item.ts || '无时间戳'} | ${SEV_ICON[item.severity]} ${SEVERITY_ZH[item.severity] || item.severity} | ${esc(item.title)} | ${esc(item.slot)} | \`${esc(shortPath(item.file))}:${item.line}\` |`);
    }
  }
  out.push('');

  /* ── 7. 温度要点 ── */
  if (analysis.sensorHighlights && analysis.sensorHighlights.length) {
    out.push('## 7. 传感器与温度要点');
    out.push('');
    out.push('| 事件 | 最高温度 | 定位 |');
    out.push('| --- | --- | --- |');
    for (const item of analysis.sensorHighlights) {
      out.push(`| ${esc(item.title)} | ${item.maxTemp}℃ | ${esc(item.slots.join('、'))} |`);
    }
    out.push('');
  }

  /* ── 8. 采集缺口 ── */
  out.push('## 8. 采集缺口、未识别样本与复判建议');
  out.push('');
  const files = analysis.files.map((file) => file.file).join(' ').toLowerCase();
  const hasBmc = /sel|lifecycle|iml|bmc|idrac|ilo|ibmc|xcc|redfish/.test(files) || analysis.files.some((file) => String(file.source).startsWith('bmc'));
  const hasOs = analysis.files.some((file) => ['os-log', 'storage-cli'].includes(file.source));
  out.push(`- 带外日志：${hasBmc ? '已有 ✅' : '**缺失 ❌**（硬件定性必须要有带外 SEL / 生命周期 / IML 日志）'}`);
  out.push(`- 系统日志：${hasOs ? '已有 ✅' : '**缺失 ❌**（MCE/EDAC/AER/SMART 等关键证据在 OS 侧）'}`);
  if (analysis.correlations && analysis.correlations.some((item) => item.id === 'CR_BMC_ONLY')) {
    out.push('- 本次为**纯带外场景**（进不去 OS）：部件级结论可用；"业务影响"层不做推断，替代证据见第 5 节 `CR_BMC_ONLY`。');
  }
  if (analysis.notes && analysis.notes.length) {
    out.push('- 读取与解码说明（压缩包展开 / 编码嗅探 / 二进制 SEL 解码）：');
    for (const note of analysis.notes.slice(0, 20)) out.push(`  - ${note}`);
  }
  if (analysis.coverage.unmatchedRecords > 0) {
    out.push(`- 未识别硬件行 ${analysis.coverage.unmatchedRecords} 条，命中率 ${(analysis.coverage.matchedRatio * 100).toFixed(1)}%。占比如下（可直接补规则）：`);
    out.push('');
    out.push('  | 次数 | 原样（截断） |');
    out.push('  | --- | --- |');
    for (const item of analysis.unmatchedPatterns || []) {
      out.push(`  | ${item.count} | \`${esc(truncate(item.text, 150))}\` |`);
    }
  } else {
    out.push('- 未识别硬件行：无 ✅（当前规则库覆盖了全部硬件相关行）。');
  }
  out.push('- 复判建议：');
  out.push('  - 用 `dsh-hwlog baseline`（或工具 `hwlog_baseline`）留一份本次快照，下次巡检用 `dsh-hwlog diff` 看"新增/恶化/已恢复"。');
  out.push('  - 采集命令清单直接生成：`dsh-hwlog collect --brand auto`（含 DELL/HPE/Lenovo/浪潮/华为/超微/曙光/中兴/H3C/富士通）。');
  out.push('');

  /* ── 附录 ── */
  out.push('## 附录：规则库覆盖');
  out.push('');
  out.push(`共 ${RULE_STATS.total} 条规则，按类别：` + Object.entries(RULE_STATS.byCategory).map(([cat, num]) => `${categoryLabel(cat)} ${num}`).join('、') + '。');
  out.push('');
  out.push(`_本报告由 dsh-server-log-analyzer 生成；所有结论均可追溯到原始行（见各条"证据"）。_`);

  return out.join('\n');
}

/** 给模型/终端看的短摘要（放在 Markdown 之前，便于快速判断要不要深读）。 */
export function renderBrief(analysis) {
  const totals = analysis.severityTotals || { critical: 0, major: 0, minor: 0, info: 0 };
  const lines = [];
  lines.push(`健康评分 ${analysis.health.score}/100（${analysis.health.grade} ${analysis.health.label}）｜文件 ${analysis.files.length} 个｜记录 ${analysis.coverage.records} 条｜命中硬件事件 ${analysis.coverage.matchedEvents} 条｜未识别 ${analysis.coverage.unmatchedRecords} 条`);
  lines.push(`告警：紧急 ${totals.critical} 次 / 严重 ${totals.major} 次 / 轻微 ${totals.minor} 次 / 提示 ${totals.info} 次`);
  if (analysis.ledger && (analysis.ledger.model || analysis.ledger.serial)) {
    lines.push(`设备：${analysis.ledger.model || '未知机型'}${analysis.ledger.serial ? ` / SN ${analysis.ledger.serial}` : ''}${analysis.ledger.bmcVersion ? ` / BMC ${analysis.ledger.bmcVersion}` : ''}`);
  }
  const top = analysis.findings.filter((finding) => !finding.unmatched).slice(0, 5);
  if (top.length) {
    lines.push('主要问题：');
    for (const finding of top) {
      lines.push(`  · [${SEVERITY_ZH[finding.sev]}] ${finding.title} ×${finding.count}${finding.slots.length ? ` @ ${finding.slots.join('/')}` : ''}`);
    }
  }
  for (const item of analysis.correlations.slice(0, 2)) {
    lines.push(`根因判断：${item.title}`);
  }
  return lines.join('\n');
}

/** 结构化 JSON（去掉 raw 大字段，便于入库/对比）。 */
export function toDigest(analysis) {
  return {
    generatedAt: analysis.generatedAt,
    files: analysis.files,
    ledger: analysis.ledger,
    health: analysis.health,
    severityTotals: analysis.severityTotals,
    findings: analysis.findings.map((finding) => ({
      key: finding.key,
      ruleId: finding.ruleId,
      category: finding.cat,
      severity: finding.sev,
      title: finding.title,
      count: finding.count,
      first: finding.first,
      last: finding.last,
      slots: finding.slots,
      codes: finding.codes,
      unmatched: finding.unmatched,
      samples: finding.samples.map((sample) => ({ file: sample.file, line: sample.line })),
    })),
    correlations: analysis.correlations,
    timeline: analysis.timeline,
    coverage: analysis.coverage,
    unmatchedPatterns: analysis.unmatchedPatterns,
    byCategory: analysis.byCategory,
  };
}
