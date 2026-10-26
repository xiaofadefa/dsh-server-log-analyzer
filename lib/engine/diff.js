/**
 * 基线与对比：巡检的核心价值不在"看一次"，而在"看变化"。
 *
 * 用法：每次巡检先 baseline（留档），下次 diff（只看新增/恶化/已恢复）。
 */

export const BASELINE_KIND = 'dsh-server-log-analyzer/baseline';

/**
 * 生成基线快照。
 * @param {object} analysis - analyzeDocuments 的结果。
 * @param {{ label?: string }} [options]
 * @returns {object} 可 JSON 序列化的基线。
 */
export function makeBaseline(analysis, options = {}) {
  return {
    kind: BASELINE_KIND,
    version: 1,
    label: options.label || (analysis.ledger && analysis.ledger.model) || '未命名设备',
    generatedAt: analysis.generatedAt,
    ledger: analysis.ledger || {},
    health: analysis.health,
    severityTotals: analysis.severityTotals,
    findings: (analysis.findings || []).map((finding) => ({
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
    })),
    sources: (analysis.files || []).map((file) => ({ file: file.file, vendor: file.vendor, format: file.format })),
  };
}

function indexByKey(findings) {
  const map = new Map();
  for (const finding of findings || []) map.set(finding.key, finding);
  return map;
}

/**
 * 对比基线与当前分析结果。
 * @param {object} baseline - makeBaseline 的输出。
 * @param {object} analysis - 本次 analyzeDocuments 的结果。
 * @returns {object} 差异结论。
 */
export function diffBaseline(baseline, analysis) {
  if (!baseline || baseline.kind !== BASELINE_KIND) {
    throw new Error('基线文件格式不对：不是本工具生成的 baseline（缺 kind 字段）');
  }
  const before = indexByKey(baseline.findings);
  const after = indexByKey(analysis.findings);

  const added = [];
  const increased = [];
  const decreased = [];
  const unchanged = [];
  for (const [key, finding] of after) {
    const previous = before.get(key);
    if (!previous) {
      added.push({ key, severity: finding.sev, title: finding.title, count: finding.count, slots: finding.slots });
      continue;
    }
    if (finding.count > previous.count) {
      increased.push({
        key,
        severity: finding.sev,
        title: finding.title,
        from: previous.count,
        to: finding.count,
        delta: finding.count - previous.count,
        slots: finding.slots,
      });
    } else if (finding.count < previous.count) {
      decreased.push({ key, severity: finding.sev, title: finding.title, from: previous.count, to: finding.count });
    } else {
      unchanged.push({ key, severity: finding.sev, title: finding.title, count: finding.count });
    }
  }

  const resolved = [];
  for (const [key, finding] of before) {
    if (after.has(key)) continue;
    resolved.push({ key, severity: finding.severity, title: finding.title, count: finding.count });
  }

  const ledgerChanges = [];
  for (const key of Object.keys(analysis.ledger || {})) {
    const now = analysis.ledger[key];
    const was = (baseline.ledger || {})[key];
    if (was !== undefined && String(was) !== String(now)) {
      ledgerChanges.push({ field: key, from: was, to: now });
    }
  }

  const scoreBefore = baseline.health ? baseline.health.score : null;
  const scoreAfter = analysis.health ? analysis.health.score : null;

  return {
    generatedAt: new Date().toISOString(),
    baseline: { label: baseline.label, generatedAt: baseline.generatedAt, score: scoreBefore },
    current: { score: scoreAfter, grade: analysis.health ? analysis.health.grade : null },
    health: {
      before: scoreBefore,
      after: scoreAfter,
      delta: scoreBefore == null || scoreAfter == null ? null : Number((scoreAfter - scoreBefore).toFixed(1)),
    },
    summary: {
      added: added.length,
      increased: increased.length,
      decreased: decreased.length,
      resolved: resolved.length,
      unchanged: unchanged.length,
    },
    added,
    increased,
    decreased,
    resolved,
    unchanged,
    ledgerChanges,
  };
}

/** 差异结论 → Markdown（巡检对比报告）。 */
export function renderDiffMarkdown(diff, options = {}) {
  const out = [];
  out.push(`# 巡检对比报告${options.asset ? ` · ${options.asset}` : ''}`);
  out.push('');
  out.push(`> 基线：${diff.baseline.label} @ ${diff.baseline.generatedAt}（评分 ${diff.baseline.score}）`);
  out.push(`> 本次：${diff.current.score}（${diff.current.grade}）　变化：${diff.health.delta > 0 ? '+' : ''}${diff.health.delta}`);
  out.push('');
  out.push(`新增 ${diff.summary.added} 类｜恶化 ${diff.summary.increased} 类｜缓解 ${diff.summary.decreased} 类｜已恢复 ${diff.summary.resolved} 类｜无变化 ${diff.summary.unchanged} 类`);
  out.push('');

  const section = (title, list, render) => {
    out.push(`## ${title}`);
    out.push('');
    if (!list.length) {
      out.push('_无_');
      out.push('');
      return;
    }
    out.push('| 等级 | 事件 | 数量 | 定位 |');
    out.push('| --- | --- | --- | --- |');
    for (const item of list) out.push(render(item));
    out.push('');
  };

  section('一、新增告警（基线里没有）', diff.added, (item) => `| ${item.severity} | ${item.title} | ${item.count} | ${(item.slots || []).join('、')} |`);
  section('二、恶化（同一条告警次数上升）', diff.increased, (item) => `| ${item.severity} | ${item.title} | ${item.from} → ${item.to}（+${item.delta}） | ${(item.slots || []).join('、')} |`);
  section('三、缓解（次数下降）', diff.decreased, (item) => `| ${item.severity} | ${item.title} | ${item.from} → ${item.to} |  |`);
  section('四、已恢复（本次不再出现）', diff.resolved, (item) => `| ${item.severity} | ${item.title} | ${item.count}（历史） |  |`);

  if (diff.ledgerChanges.length) {
    out.push('## 五、台账变化');
    out.push('');
    out.push('| 字段 | 基线 | 本次 |');
    out.push('| --- | --- | --- |');
    for (const change of diff.ledgerChanges) out.push(`| ${change.field} | ${change.from} | ${change.to} |`);
    out.push('');
  }

  out.push('## 六、结论');
  out.push('');
  if (diff.summary.added === 0 && diff.summary.increased === 0) {
    out.push('- 本次对比没有新增或恶化项：硬件状态稳定（若"已恢复"里有条目，请确认是修好了还是日志被清了）。');
  } else {
    out.push(`- 有 ${diff.summary.added + diff.summary.increased} 类新增/恶化项，优先处理紧急与严重级（见 1、2 节）。`);
    if (diff.summary.resolved > 0) out.push(`- ${diff.summary.resolved} 类历史告警已消失：确认是硬件修复还是日志轮转/清空导致。`);
  }
  out.push('');
  out.push('_本报告由 dsh-server-log-analyzer 生成。_');
  return out.join('\n');
}
