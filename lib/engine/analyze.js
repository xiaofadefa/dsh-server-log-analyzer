/**
 * 分析层：聚类 → 评分 → 根因关联 → 时间线。
 *
 * 输出结构（report.js 只消费它）：
 * {
 *   files[], ledger{}, findings[], health{}, correlations[], timeline[],
 *   byCategory{}, coverage{}, unmatchedPatterns[], vendors{}
 * }
 */

import {
  SEVERITY_WEIGHT, SEVERITY_ZH, severityRank, maxSeverity,
  timeKey, earliest, latest, timeSpanMs, humanSpan, truncate, stableHash,
} from './text.js';
import { ruleById, categoryLabel } from './rules.js';
import { parseText, signatureOf } from './parse.js';
import { loadOpsLibrary, relatedOps } from './ops.js';

const GRADE_TABLE = [
  { min: 90, grade: 'A', label: '正常', advice: '按常规巡检周期跟踪即可。' },
  { min: 75, grade: 'B', label: '关注', advice: '列入观察清单，安排一次带外信息复核。' },
  { min: 55, grade: 'C', label: '告警', advice: '需要处置：按报告"处置清单"派单，72 小时内闭环。' },
  { min: 0, grade: 'D', label: '危急', advice: '立即处置：存在业务中断或数据丢失风险，建议先做业务切换。' },
];

function gradeOf(score) {
  return GRADE_TABLE.find((row) => score >= row.min) || GRADE_TABLE[GRADE_TABLE.length - 1];
}

/**
 * 聚类：把 N 条事件压成"一类告警"（同规则 + 同部件槽位）。
 * 这样报告里出现的是"DIMM A1 UCE ×7"，而不是 7 行流水。
 */
export function clusterEvents(events) {
  const buckets = new Map();
  for (const event of events) {
    if (event.noise) continue;
    const slotKey = event.slot ? `${event.slot.kind}:${event.slot.id}` : '';
    // 断言状态要进聚类键：IDL/SEL 里同一条告警会有 Assert（触发）与 Deassert（解除）两条记录，
    // 合并成一簇会把"一次告警 + 一次恢复"显示成"告警 ×2"。
    const assertionTag = event.idl && event.idl.assertion ? `|${event.idl.assertion}` : '';
    // 手册码表命中的事件**按码聚类**（优先于内部规则）：华为 0x080000C1 与 0x080000D1 是两条不同告警，
    // 若按内部规则（都为 PCIE_DEVICE_ERROR）合并，报告会把"网卡异常"藏进"CPU 异常"里。
    const key = event.external
      ? `EXT:${event.external.code}|${slotKey}${assertionTag}`
      : (event.ruleId
        ? `${event.ruleId}|${slotKey}${assertionTag}`
        : (event.idl
          ? `IDL:${event.idl.component || 'X'}:${event.idl.eventName || event.idl.code || 'E'}|${slotKey}${assertionTag}`
          : signatureOf(event)));
    if (!buckets.has(key)) {
      buckets.set(key, {
        key,
        ruleId: event.ruleId,
        cat: event.cat,
        sev: event.sev,
        title: event.title,
        count: 0,
        first: null,
        last: null,
        files: new Set(),
        slots: new Map(),
        codes: new Set(),
        matchedRules: new Set(),
        sources: new Set(),
        external: null,
        idl: null,
        details: new Set(),
        temps: [],
        unmatched: false,
        samples: [],
      });
    }
    const bucket = buckets.get(key);
    bucket.count += 1;
    bucket.sev = maxSeverity(bucket.sev, event.sev);
    bucket.first = earliest(bucket.first, event.ts);
    bucket.last = latest(bucket.last, event.ts);
    bucket.files.add(event.file);
    if (event.slot) bucket.slots.set(`${event.slot.kind}:${event.slot.id}`, event.slot);
    event.codes.forEach((code) => bucket.codes.add(code));
    if (event.ruleId) bucket.matchedRules.add(event.ruleId);
    event.secondary.forEach((id) => bucket.matchedRules.add(id));
    if (event.source) bucket.sources.add(event.source);
    if (event.external && !bucket.external) bucket.external = event.external;
    if (event.idl && !bucket.idl) bucket.idl = event.idl;
    if (event.detail) bucket.details.add(event.detail);
    if (event.unmatched) bucket.unmatched = true;
    if (event.temps && event.temps.length) bucket.temps.push(...event.temps);
    if (bucket.samples.length < 4) {
      bucket.samples.push({ file: event.file, line: event.line, ts: event.ts, raw: truncate(event.raw.replace(/\s*\n\s*/g, ' ⏎ '), 240) });
    }
  }

  const findings = Array.from(buckets.values()).map((bucket) => {
    const rule = bucket.ruleId ? ruleById(bucket.ruleId) : null;
    return {
      key: bucket.key,
      ruleId: bucket.ruleId,
      cat: bucket.cat,
      categoryLabel: categoryLabel(bucket.cat),
      sev: bucket.sev,
      title: bucket.title,
      count: bucket.count,
      first: bucket.first,
      last: bucket.last,
      span: humanSpan(timeSpanMs(bucket.first, bucket.last)),
      files: Array.from(bucket.files),
      slots: Array.from(bucket.slots.values()).map((slot) => `${slot.kind.toUpperCase()}:${slot.id}`),
      codes: Array.from(bucket.codes),
      secondary: Array.from(bucket.matchedRules).filter((id) => id !== bucket.ruleId),
      matchedRules: Array.from(bucket.matchedRules),
      source: Array.from(bucket.sources)[0] || null,
      sources: Array.from(bucket.sources),
      external: bucket.external,
      idl: bucket.idl,
      details: Array.from(bucket.details).slice(0, 6),
      maxTemp: bucket.temps.length ? Math.max(...bucket.temps.map((item) => item.value)) : null,
      advice: rule && rule.advice ? rule.advice : [],
      unmatched: bucket.unmatched,
      samples: bucket.samples,
      id: stableHash(bucket.key),
    };
  });

  findings.sort((a, b) => {
    const bySev = severityRank(b.sev) - severityRank(a.sev);
    if (bySev !== 0) return bySev;
    if (b.count !== a.count) return b.count - a.count;
    return timeKey(b.last || '') > timeKey(a.last || '') ? 1 : -1;
  });

  return findings;
}

/** 健康分：按"每条告警的严重度权重 × 重复放大（对数，封顶）"扣分。 */
export function scoreHealth(findings) {
  let score = 100;
  const reasons = [];
  for (const finding of findings) {
    if (finding.unmatched) continue;
    const base = SEVERITY_WEIGHT[finding.sev] || 0;
    if (base === 0) continue;
    const factor = 1 + Math.log2(Math.min(Math.max(finding.count, 1), 32)) / 4;
    const contribution = Math.min(base * factor, base * 2.5);
    score -= contribution;
    if (contribution >= 6) {
      reasons.push(`-${contribution.toFixed(1)} 分：${finding.title}（${finding.count} 次${finding.slots.length ? '，' + finding.slots.join('/') : ''}）`);
    }
  }
  score = Math.max(0, Math.min(100, Math.round(score * 10) / 10));
  const grade = gradeOf(score);
  return {
    score,
    grade: grade.grade,
    label: grade.label,
    advice: grade.advice,
    reasons: reasons.slice(0, 8),
  };
}

/**
 * 根因关联：单条告警看不出问题，把"一起出现的事实"组合成故障链。
 * 每条关联都是可执行结论（statement + actions），而不是"建议关注"。
 */
export function correlate(findings) {
  const byRule = new Map();
  for (const finding of findings) {
    const ids = finding.matchedRules && finding.matchedRules.length ? finding.matchedRules : (finding.ruleId ? [finding.ruleId] : []);
    for (const id of ids) {
      const list = byRule.get(id) || [];
      list.push(finding);
      byRule.set(id, list);
    }
  }
  const has = (...ids) => ids.some((id) => byRule.has(id));
  const get = (id) => byRule.get(id) || [];
  const totalCount = (...ids) => ids.reduce((sum, id) => sum + get(id).reduce((acc, item) => acc + item.count, 0), 0);
  const filesOf = (...ids) => Array.from(new Set(ids.flatMap((id) => get(id).flatMap((item) => item.files))));
  /** 结论文字里只显示文件名，避免把整条绝对路径糊进结论。 */
  const namesOf = (files) => Array.from(new Set(files.map((file) => String(file).split(/[\\/]/).pop())));
  const nameList = (...ids) => namesOf(filesOf(...ids));

  const out = [];

  if (has('PSU_INPUT_LOST', 'POWER_UNIT') && has('OS_SHUTDOWN_UNEXPECTED', 'OS_BOOT')) {
    out.push({
      id: 'CR_POWER_CHAIN',
      sev: 'critical',
      title: '供电侧掉电 → 整机非预期宕机（疑似市电/PDU/UPS）',
      statement: `带外日志出现电源输入丢失/电源单元事件，同时操作系统侧出现非预期重启或启动记录：${nameList('PSU_INPUT_LOST', 'POWER_UNIT').join('、')}。时间对齐后基本可判定掉电来自供电侧，而不是服务器自身部件随机故障。`,
      evidence: [...get('PSU_INPUT_LOST'), ...get('POWER_UNIT'), ...get('OS_SHUTDOWN_UNEXPECTED')].map((item) => item.title),
      actions: [
        '拉该机柜/PDU 的配电记录与 UPS 日志，确认是否存在一路空开跳闸或双路同源接线。',
        '核对同机柜其它设备同一时刻的带外日志（判断是单机还是整柜）。',
        '服务器侧只需确认 PSU 无硬件故障，不需要换件。',
      ],
    });
  }

  const memUncorrectable = totalCount('MEM_UCE');
  const memCorrectable = totalCount('MEM_CE');
  if (has('MEM_UCE', 'MEM_CE', 'MEM_TRAINING_FAIL')) {
    const slots = Array.from(new Set(get('MEM_UCE').concat(get('MEM_CE'), get('MEM_TRAINING_FAIL')).flatMap((item) => item.slots)));
    out.push({
      id: 'CR_MEMORY_DEGRADE',
      sev: memUncorrectable > 0 ? 'critical' : 'major',
      title: memUncorrectable > 0 ? '内存不可纠正错误（UCE）' : '内存可纠正错误（CE）趋势性劣化',
      statement: memUncorrectable > 0
        ? `出现 ${memUncorrectable} 次内存 UCE${slots.length ? `，涉及 ${slots.join('、')}` : ''}：这是"数据完整性已受威胁"的信号，不是可长期观察的状态。`
        : `出现 ${memCorrectable} 次内存 CE${slots.length ? `，集中在 ${slots.join('、')}` : ''}：单点偶发可观察，若速率持续上升即为内存条劣化。`,
      evidence: get('MEM_UCE').concat(get('MEM_CE')).map((item) => `${item.title} ×${item.count}`),
      actions: [
        '在 BMC 里核对槽位丝印与容量差（被禁用的那条就是嫌疑 DIMM）。',
        'UCE：安排业务切换后重启并更换该 DIMM；CE：设定"速率上升"阈值后再决定更换窗口。',
        '更换后回读 SEL/生命周期日志确认无复现，并保留原条做备件返修。',
      ],
    });
  }

  if (has('FAN_FAIL', 'FAN_LOW_SPEED', 'FAN_REDUNDANCY_LOST', 'THERMAL_TEMP_HIGH', 'THERMAL_TEMP_WARN')
    && has('CPU_THERMAL_THROTTLE', 'THERMAL_TEMP_HIGH', 'CPU_OVER_TEMP')) {
    out.push({
      id: 'CR_THERMAL_CHAIN',
      sev: has('CPU_OVER_TEMP', 'THERMAL_TEMP_HIGH') ? 'critical' : 'major',
      title: '散热链异常：风扇/温度告警 → 处理器降频',
      statement: '散热通道（风扇、导风罩、进风温度）异常已经传导到处理器层，表现为降频或过温保护；性能问题只是表象，硬件散热是根因。',
      evidence: get('FAN_FAIL').concat(get('FAN_LOW_SPEED'), get('CPU_THERMAL_THROTTLE')).map((item) => `${item.title} ×${item.count}`),
      actions: [
        '恢复风扇满配与冗余，检查导风罩/防尘网/线缆遮挡。',
        '核对机房进风温度（>27℃ 要改制冷），并给出更换风扇的备件工单。',
        '处置后做 30 分钟满载温度复测，确认无降频再回业务。',
      ],
    });
  }

  if (has('DRIVE_FAIL', 'DRIVE_PREDICTIVE', 'DISK_IO_ERROR', 'DRIVE_REMOVED') && has('RAID_DEGRADED', 'RAID_REBUILD')) {
    out.push({
      id: 'CR_STORAGE_CHAIN',
      sev: 'critical',
      title: '存储链异常：硬盘故障/预警 → RAID 降级或重建',
      statement: '单盘失效或预警与 RAID 降级/重建同时出现，说明阵列已失去冗余保护，此时再做任何单盘操作都可能触发数据不可用。',
      evidence: get('DRIVE_FAIL').concat(get('RAID_DEGRADED')).map((item) => `${item.title} ×${item.count}`),
      actions: [
        '先确认是否有热备正在重建；没有则立即插备盘，但不要拔任何在位盘。',
        '重建期间禁止重启、禁止压测；完成前不要做固件升级。',
        '对业务做一次备份校验，并记录重建耗时作为后续容量/IO 评估依据。',
      ],
    });
  }

  if (has('PCIE_AER_UE', 'PCIE_AER_CE', 'PCIE_LINK_DEGRADE', 'PCIE_DEVICE_ERROR')
    && has('NIC_HW_ERROR', 'NIC_LINK_FLAP', 'DISK_IO_ERROR', 'GPU_UNKNOWN')) {
    out.push({
      id: 'CR_PCIE_CHAIN',
      sev: has('PCIE_AER_UE') ? 'critical' : 'major',
      title: 'PCIe 链异常：链路/AER 错误 → 卡功能异常',
      statement: 'PCIe 链路错误与网卡/存储/加速卡功能异常同时出现，问题更可能落在插槽、转接卡（riser）或卡本身，而不是上层业务。',
      evidence: get('PCIE_AER_UE').concat(get('PCIE_AER_CE'), get('NIC_HW_ERROR')).map((item) => `${item.title} ×${item.count}`),
      actions: [
        '按 BDF/插槽号定位卡与 riser，先重插 + 换槽验证。',
        '升级卡固件与 BIOS（PCIe 协商问题大量由微码修复）。',
        '复现仍存在则换卡，最后才考虑主板/riser 更换。',
      ],
    });
  }

  if (has('BMC_RESET', 'BMC_WATCHDOG', 'BMC_SEL_FULL', 'SENSOR_FAIL')
    && has('FAN_FAIL', 'FAN_LOW_SPEED', 'THERMAL_TEMP_HIGH', 'VOLT_OUT_OF_RANGE')) {
    out.push({
      id: 'CR_BMC_CHAIN',
      sev: 'major',
      title: '带外控制面异常：BMC 复位/看门狗 + 传感器类告警',
      statement: 'BMC（带外管理）自身出现复位/看门狗/传感器失效，同时伴随风扇或电压类告警：这类组合往往是 BMC 固件或 NVRAM 问题，会导致散热/电源闭环失控。',
      evidence: get('BMC_RESET').concat(get('BMC_WATCHDOG'), get('SENSOR_FAIL')).map((item) => `${item.title} ×${item.count}`),
      actions: [
        '先导出完整 SEL + 生命周期日志留证（清空前必须导出）。',
        '升级 BMC/iDRAC/iLO/iBMC 固件到厂商推荐版本，并执行一次 BMC 复位。',
        '若复位后仍反复自愈重启，按主板/BMC 模块更换处理。',
      ],
    });
  }

  const inputLostFiles = filesOf('PSU_INPUT_LOST', 'POWER_UNIT');
  if (inputLostFiles.length >= 2) {
    out.push({
      id: 'CR_FLEET_POWER',
      sev: 'critical',
      title: '多台设备同时掉电 → 机房供电事件（不是单机故障）',
      statement: `本次分析的文件中，有 ${filesOf('PSU_INPUT_LOST', 'POWER_UNIT').length} 台设备的日志出现电源输入丢失/整机掉电事件：${nameList('PSU_INPUT_LOST', 'POWER_UNIT').join('、')}。这是配电侧（PDU/UPS/空开/双路同源）特征。`,
      evidence: [`涉及 ${inputLostFiles.length} 台设备`],
      actions: [
        '暂停挨个换电源的动作，先查配电柜与 UPS 切换记录。',
        '核对双路供电是否同源（同一路 PDU 的两个插座），并纠正接线。',
        '对这批机器统一复核电源模块健康（PSU 事件计数），区分"被拖死"与"自身故障"。',
      ],
    });
  }

  if (has('BIOS_POST_ERROR') && has('MEM_TRAINING_FAIL', 'MEM_UCE', 'CPU_MCE', 'PCIe_UNKNOWN')) {
    out.push({
      id: 'CR_POST_CHAIN',
      sev: 'major',
      title: '开机自检失败链（POST + 部件级错误）',
      statement: 'POST/BIOS 报错与内存/处理器级错误同时出现，说明故障发生在加电自检阶段，属于"上电即失败"型问题，需要最小化配置复测。',
      evidence: get('BIOS_POST_ERROR').concat(get('MEM_TRAINING_FAIL')).map((item) => `${item.title} ×${item.count}`),
      actions: [
        '按最小配置复测：1 CPU + 1 DIMM + 无插卡 + 最小电源，逐步加回定位部件。',
        '记录 POST 错误码去查厂商手册（不同码指向内存/CPU/PCIe 自检阶段）。',
        '内存类自检失败必须先做内存训练/换槽，避免直接换主板。',
      ],
    });
  }

  if (memCorrectable >= 100) {
    out.push({
      id: 'CR_CE_RATE',
      sev: 'major',
      title: '内存 CE 数量已达需处置量级',
      statement: `本次日志累计 ${memCorrectable} 次内存可纠正错误，超过"偶发"量级：按劣化处理，纳入计划性更换。`,
      evidence: [`CE 累计 ${memCorrectable} 次`],
      actions: ['计算 CE 速率（次/天）并绘制趋势；速率上升即换条。', '同步检查机房温度与内存供电电压是否偏高。'],
    });
  }

  if (has('DRIVE_REMOVED') && has('RAID_DEGRADED')) {
    out.push({
      id: 'CR_DISK_REMOVE',
      sev: 'critical',
      title: '存在"拔盘 → 阵列降级"时序',
      statement: '硬盘不在位与 RAID 降级同时出现：若非计划维护，须先核对是否有人在未做下线操作的情况下拔盘（热拔会直接打掉冗余）。',
      evidence: get('DRIVE_REMOVED').map((item) => `${item.title} ×${item.count}`),
      actions: ['核对该时段机房维护记录与人员操作。', '恢复盘位前确认 RAID 已识别为 failed/offline，避免误判为"重新插入即可"。'],
    });
  }

  if (has('FW_MISMATCH') && has('LICENSE_CERT')) {
    out.push({
      id: 'CR_FW_CERT',
      sev: 'minor',
      title: '固件/版本与证书/许可问题并存',
      statement: '固件版本不匹配与证书/许可告警同时出现，通常是"换件后未统一刷版本"或"带外证书过期"，会表现为 BMC 页面打不开、功能受限。',
      evidence: get('FW_MISMATCH').map((item) => `${item.title} ×${item.count}`),
      actions: ['按整机固件基线统一升级，并同步更新带外证书与许可。'],
    });
  }

  const hasOsCritical = findings.some((finding) => finding.sev === 'critical' && ['os', 'storage', 'network'].includes(finding.cat));
  const hasBmcEvents = findings.some((finding) => String(finding.files.join()).match(/sel|lifecycle|iml|bmc|idrac|ilo|xcc/i) || ['bmc-sel', 'bmc-lifecycle', 'bmc-iml', 'bmc-text', 'bmc-redfish'].includes(finding.source));
  if (hasOsCritical && !hasBmcEvents) {
    out.push({
      id: 'CR_NO_BMC_EVIDENCE',
      sev: 'minor',
      title: '系统日志已报警，但缺少同机带外日志佐证',
      statement: '本次分析的输入以系统日志为主，没有对应的带外（SEL/生命周期/IML）日志：硬件定性结论会缺一半证据。',
      evidence: ['未发现带外日志文件'],
      actions: [
        '补齐采集：ipmitool sel elist / Redfish LogService / 厂商导出（iDRAC racadm selshow、iLO IML export、iBMC ipmcget -d sel、XCC 事件日志导出）。',
        '把带外日志与系统日志时间对齐后再复判（本工具的 diff/baseline 可做周期对比）。',
      ],
    });
  }

  /* 「进不去 OS，只有带外」是现场主流场景：这时结论的边界必须写清楚，不能假装证据齐全。 */
  const sources = new Set(findings.flatMap((finding) => (finding.sources && finding.sources.length ? finding.sources : (finding.source ? [finding.source] : []))));
  const bmcOnly = (sources.has('bmc-sel') || sources.has('bmc-lifecycle') || sources.has('bmc-iml') || sources.has('bmc-text') || sources.has('bmc-redfish'))
    && !sources.has('os-log') && !sources.has('storage-cli');
  const hasHwFinding = findings.some((finding) => !finding.unmatched && severityRank(finding.sev) >= severityRank('major'));
  if (bmcOnly && hasHwFinding) {
    out.push({
      id: 'CR_BMC_ONLY',
      sev: 'minor',
      title: '只有带外日志（进不去 OS）：硬件定性成立，业务影响需另证',
      statement: '本次输入全部来自带外（BMC/生命周期/IML/SEL/Redfish）：部件级判定（谁坏了、要不要换件）依据充分；但"对业务造成了什么影响"（内核 MCE/EDAC、文件系统、SMART 明细、I/O 错误）缺 OS 侧证据，本报告不会替你推断这一层。',
      evidence: ['输入来源：仅带外'],
      actions: [
        '能拿到 OS 就补一份 syslog/dmesg（采集清单的 OS 部分）；拿不到就用下面的替代证据。',
        '替代证据：BMC 传感器/温度曲线、RAID 卡自身的硬盘状态、业务侧监控告警时间点。',
        '报修单写清"部件级结论来自带外 SEL"，避免现场因为要不到 OS 日志而卡流程。',
        '采集建议：优先 `ipmitool sel save`（.bin，本工具可直接解码）或厂商一键收集包（zip，本工具自动展开）。',
      ],
    });
  }

  const order = { critical: 0, major: 1, minor: 2, info: 3 };
  out.sort((a, b) => order[a.sev] - order[b.sev]);
  return out;
}

/**
 * 把多份解析结果合并成一份分析结论。
 * @param {Array<object>} parsedList - parseText 的结果数组。
 * @param {{ maxFindings?: number, timelineLimit?: number, includeInfo?: boolean }} [options]
 */
export function analyzeParsed(parsedList, options = {}) {
  const events = parsedList.flatMap((item) => item.events);
  const findings = clusterEvents(events);
  const visible = options.includeInfo ? findings : findings.filter((finding) => finding.sev !== 'info' || !finding.unmatched);

  // 给每条发现挂上"相关操作条目"（命令 / 界面路径 / 处理步骤）——
  // 报告因此能直接回答"现在该敲什么、点哪个菜单"，而不是只说"电源失效"。
  try {
    const opsLibrary = loadOpsLibrary();
    if (opsLibrary.total > 0) {
      for (const finding of visible) {
        const related = relatedOps(opsLibrary, { title: finding.title, category: finding.cat, limit: 2 });
        if (related.length) finding.relatedOps = related;
      }
    }
  } catch { /* 操作库不可用时不影响分析 */ }

  const health = scoreHealth(findings);
  const correlations = correlate(findings);

  const ledger = {};
  const ledgerEvidence = {};
  for (const parsed of parsedList) {
    for (const [key, value] of Object.entries(parsed.ledger || {})) {
      if (!ledger[key]) {
        ledger[key] = value;
        ledgerEvidence[key] = parsed.ledgerEvidence ? parsed.ledgerEvidence[key] : '';
      }
    }
  }

  const byCategory = {};
  for (const finding of findings) {
    if (finding.unmatched) continue;
    if (!byCategory[finding.cat]) byCategory[finding.cat] = { label: categoryLabel(finding.cat), count: 0, events: 0, worst: 'info' };
    byCategory[finding.cat].count += 1;
    byCategory[finding.cat].events += finding.count;
    byCategory[finding.cat].worst = maxSeverity(byCategory[finding.cat].worst, finding.sev);
  }

  const severityTotals = { critical: 0, major: 0, minor: 0, info: 0 };
  for (const finding of findings) severityTotals[finding.sev] += finding.count;

  const timeline = events
    .filter((event) => event.ruleId && severityRank(event.sev) >= severityRank('major'))
    .sort((a, b) => (timeKey(a.ts) || 'zzz').localeCompare(timeKey(b.ts) || 'zzz'))
    .slice(0, options.timelineLimit || 40)
    .map((event) => ({
      ts: event.ts,
      severity: event.sev,
      title: event.title,
      slot: event.slot ? `${event.slot.kind.toUpperCase()}:${event.slot.id}` : '',
      file: event.file,
      line: event.line,
    }));

  const sensorHighlights = findings
    .filter((finding) => finding.maxTemp != null && finding.sev !== 'info')
    .map((finding) => ({ title: finding.title, maxTemp: finding.maxTemp, slots: finding.slots, sev: finding.sev }))
    .sort((a, b) => b.maxTemp - a.maxTemp)
    .slice(0, 8);

  const unmatchedPatterns = parsedList
    .flatMap((item) => item.unmatchedPatterns || [])
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  const coverage = parsedList.reduce((acc, item) => ({
    records: acc.records + item.coverage.records,
    matchedEvents: acc.matchedEvents + item.coverage.matchedEvents,
    noiseRecords: acc.noiseRecords + item.coverage.noiseRecords,
    unmatchedRecords: acc.unmatchedRecords + item.coverage.unmatchedRecords,
  }), { records: 0, matchedEvents: 0, noiseRecords: 0, unmatchedRecords: 0 });
  coverage.matchedRatio = coverage.records === 0 ? 0 : Number((coverage.matchedEvents / coverage.records).toFixed(3));

  const vendors = {};
  for (const parsed of parsedList) {
    vendors[parsed.vendor] = (vendors[parsed.vendor] || 0) + 1;
  }

  const maxFindings = options.maxFindings || 12;

  return {
    generatedAt: new Date().toISOString(),
    notes: options.notes || [],
    files: parsedList.map((item) => ({
      file: item.file,
      vendor: item.vendorLabel,
      vendorKey: item.vendor,
      format: item.formatLabel,
      formatKey: item.format,
      source: item.source,
      records: item.coverage.records,
      matched: item.coverage.matchedEvents,
      unmatched: item.coverage.unmatchedRecords,
      noise: item.coverage.noiseRecords,
    })),
    vendors,
    ledger,
    ledgerEvidence,
    findings: visible.slice(0, Math.max(maxFindings, 40)),
    allFindingCount: findings.length,
    health,
    correlations,
    timeline,
    byCategory,
    severityTotals,
    sensorHighlights,
    coverage,
    unmatchedPatterns,
  };
}

/** 一步到位：一批 {file, text} → 分析结论。 */
export function analyzeDocuments(documents, options = {}) {
  const parsedList = [];
  for (const document of documents) {
    parsedList.push(parseText(document.text, {
      file: document.file,
      vendor: options.vendor,
      format: options.format,
      defaultYear: options.defaultYear,
      includeNoise: options.includeNoise,
    }));
  }
  const analysis = analyzeParsed(parsedList, options);
  analysis.parsed = parsedList;
  return analysis;
}
