/**
 * 解析层：把任意品牌的日志文件 → 统一的"事件模型"。
 *
 * 统一事件模型（后续 analyze/report 只认它）：
 * {
 *   id, ts, uptimeSec, source, vendor,
 *   ruleId|null, cat, sev, title, detail,
 *   slot: {kind,id,raw}|null, temps[], count|null, codes[],
 *   raw, file, line, noise, unmatched
 * }
 */

import {
  normalizeText, toLines, parseTimestamp, stableHash, severityFromText,
  extractSlot, extractTemps, extractCount, severityRank, maxSeverity, truncate,
} from './text.js';
import { matchRules, ruleById, assertionSeverity } from './rules.js';
import { detectBrand, detectFormat, sourceOfFormat, extractLedger } from './detect.js';
import { loadCodeTables, lookupExternalCode } from './codes.js';
import { parseIdlLine, idlHaystack, idlSeverity } from './inspur-idl.js';

/** 外部码表（厂商手册导入）懒加载一次；文件改动后由 CLI 的 codes import 清缓存。 */
let CODE_TABLES = null;
function codeTables() {
  if (!CODE_TABLES) CODE_TABLES = loadCodeTables();
  return CODE_TABLES;
}
export function reloadCodeTables() {
  CODE_TABLES = loadCodeTables({ force: true });
  return CODE_TABLES;
}

/** 看起来像硬件的关键词：用于把"非硬件的系统噪音"和"没识别的硬件行"分开。 */
const HARDWARE_HINT = /(?:ECC|DIMM|memory|MCE|machine\s+check|EDAC|AER|PCIe|PCI\b|fan\b|temp|thermal|power|PSU|voltage|battery|drive|disk|SEL|BMC|iDRAC|iLO|iBMC|XCC|IPMI|watchdog|SMART|raid|sensor|CPU|processor|NVRAM|BIOS|POST|CMOS|CPLD|backplane|intrusion|row\s+sparing|smartctl|storcli|megacli|md\/raid|sd[a-z]\b|nvme|SAS|PHY|内存|处理器|风扇|电源|供电|硬盘|磁盘|阵列|电池|主板|机箱|温度|电压|传感器|冗余|固件|背板|插槽|网卡|缓存|部件)/i;

/** 看起来像"故障描述"的措辞：用于判断一条没命中规则的行值不值得当成"未识别硬件行"。 */
const FAULT_HINT = /(?:fail|error|fault|degrad|critical|warn|assert|exceed|invalid|offline|unavailable|timeout|timed\s+out|lost|remov|abnormal|corrupt|panic|stuck|over\s*temp|out\s+of\s+range|upper\s+non|lower\s+non|\bUCE\b|\bUE\b|\bCE\b|dead|missing|full|overflow|not\s+present|disabled|reset|失效|故障|不在位|丢失|降级|异常|过高|超限|越限|错误|告警|报警|失败|离线|掉盘|断开|重试)/i;

/** 明显的系统层噪音（这些即使没命中规则、也没硬件关键词，也不算"未识别硬件行"）。 */
const NOISE_HINT = /(?:sshd|systemd-logind|systemd\[1\]:\s*(?:Started|Stopping|Reloading|Created)|cron|CRON|dhclient|NetworkManager|polkit|audit\[|kernel:\s*(?:usb|IPv6|random:|EXT4-fs\s*\(sda\):\s*mounted)|kubelet|containerd|dockerd|prometheus|node_exporter|rsyslogd|named\[|postfix|chronyd|ntpd|anacron|logrotate|autofs|getty|dbus|irqbalance)/i;

/**
 * 噪音判定：**没命中任何硬件规则，且"不是硬件关键词 + 故障措辞同时出现"的行**，
 * 算"非硬件系统噪音"（日志里的台账行、工具输出的表头、sshd/cron 之类）。
 * 反过来，含硬件关键词又带故障措辞的未知行会被保留为"未识别硬件行"，方便补规则。
 */
function isNoise(raw) {
  if (NOISE_HINT.test(raw) && !HARDWARE_HINT.test(raw)) return true;
  return !(HARDWARE_HINT.test(raw) && FAULT_HINT.test(raw));
}

/**
 * 按"时间戳开头的行 = 新记录"切分文本记录；不带时间戳的行作为上一条的续行
 * （ipmitool 长描述、dmesg 多行堆栈、HPE IML 折行都属于这类）。
 */
export function splitRecords(text, options = {}) {
  const { defaultYear, keyValueBlocks = false, splitEveryLine = false } = options;
  const lines = toLines(text);
  const records = [];
  let current = null;

  // 无时间戳的行式输出（smartctl / storcli / 纯文本）：一行一条记录，避免整文件糊成一条。
  if (splitEveryLine) {
    for (let i = 0; i < lines.length; i += 1) {
      const trimmed = lines[i].trim();
      if (trimmed === '' || /^[-=]{5,}/.test(trimmed)) continue;
      records.push({ raw: trimmed, ts: null, uptimeSec: null, line: i + 1, fields: {} });
    }
    return records;
  }

  const push = () => {
    if (current && current.raw.trim() !== '') records.push(current);
    current = null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const lineNo = i + 1;
    const trimmed = line.trim();
    if (trimmed === '') {
      // 空行只作为分隔，不结束记录（某些导出格式中间有空行）
      continue;
    }

    const startsNew = keyValueBlocks && /^SEL\s+Record\s+ID\b/i.test(trimmed);
    const stamp = startsNew ? null : parseTimestamp(line, { defaultYear });

    if (startsNew || stamp) {
      push();
      current = {
        raw: trimmed,
        ts: stamp ? stamp.ts : null,
        uptimeSec: stamp ? stamp.uptimeSec : null,
        line: lineNo,
        fields: keyValueBlocks ? parseKeyValue(trimmed) : {},
      };
      continue;
    }

    // 表头/分隔线（ipmitool sel 的表头、---- 分隔）丢弃
    if (/^(?:SEL\s+Record\s+ID|Record\s+Type|Event\s+Log|ID\s*\|\s*Date|=====|-----|[-=]{5,})/i.test(trimmed)) continue;

    if (current) {
      current.raw += `\n${trimmed}`;
      if (keyValueBlocks) Object.assign(current.fields, parseKeyValue(trimmed));
    } else {
      current = { raw: trimmed, ts: null, uptimeSec: null, line: lineNo, fields: keyValueBlocks ? parseKeyValue(trimmed) : {} };
    }
  }
  push();
  return records;
}

/** `键 : 值` 形式的字段（iBMC/浪潮的 SEL 导出、ipmitool sensor 输出都用它）。 */
export function parseKeyValue(line) {
  const m = /^\s*([A-Za-z][A-Za-z0-9 /#_()-]{2,32})\s*[:：]\s*(.+?)\s*$/.exec(line);
  if (!m) return {};
  const key = m[1].trim().replace(/\s{2,}/g, ' ');
  return { [key]: m[2].trim() };
}

/** 结构化解析 ipmitool `sel list/elist` 的一行：ID | Date | Time | Name | Type | Event | Assertion。 */
export function parseSelColumns(raw) {
  const parts = String(raw).split(/\s*\|\s*/).map((part) => part.trim());
  if (parts.length < 5) return null;
  if (!/^\d+$/.test(parts[0])) return null;
  const hasDate = /^\d{2}\/\d{2}\/\d{4}$/.test(parts[1]) || /^[0-9a-fA-F]{2}\/[0-9a-fA-F]{2}\/[0-9a-fA-F]{4}$/.test(parts[1]);
  if (!hasDate) return null;
  return {
    recordId: parts[0],
    date: parts[1],
    time: parts[2],
    sensor: parts[3] || '',
    sensorType: parts[4] || '',
    event: parts[5] || parts[4] || '',
    assertion: parts[6] || parts[5] || '',
  };
}

/** 从 SEL 字段里拼一条可读描述（让规则匹配到正确的英文关键词）。 */
function selHaystack(record) {
  const cols = parseSelColumns(record.raw);
  if (cols) {
    return `${record.raw} | ${cols.sensor} ${cols.sensorType} ${cols.event} ${cols.assertion}`;
  }
  const f = record.fields || {};
  const kv = Object.entries(f).map(([k, v]) => `${k}: ${v}`).join(' ');
  return kv ? `${record.raw} | ${kv}` : record.raw;
}

/** 归一化签名：数字/十六进制换成占位符，便于把"同一种告警"聚成一类。 */
export function signatureOf(event) {
  const base = String(event.ruleId || 'RAW_UNMATCHED');
  const slot = event.slot ? `${event.slot.kind}#${event.slot.id}` : '';
  const normalized = String(event.raw.split('\n')[0])
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?/g, '<TS>')
    .replace(/\b\d{2}\/\d{2}\/\d{4}\b/g, '<DATE>')
    .replace(/\b\d{2}:\d{2}:\d{2}\b/g, '<TIME>')
    .replace(/\b0x[0-9a-fA-F]+\b/g, '0x#')
    .replace(/\b\d+(\.\d+)?\b/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  return `${base}|${slot}|${stableHash(normalized)}`;
}

/**
 * 解析一段日志文本（已识别格式由调用方传入，或自动识别）。
 * @param {string} text - 原始文本。
 * @param {{ file?: string, vendor?: string, format?: string, defaultYear?: number, includeNoise?: boolean }} [options]
 * @returns {object} 解析结果（events/format/vendor/ledger/coverage）。
 */
export function parseText(text, options = {}) {
  const raw = normalizeText(text);
  const file = options.file || '<text>';
  const brand = options.vendor && options.vendor !== 'auto'
    ? { vendor: options.vendor, label: options.vendor, confidence: 1, scores: {}, evidence: [] }
    : detectBrand(raw);
  const format = options.format && options.format !== 'auto'
    ? { format: options.format, label: options.format, nodeType: options.format === 'redfish-json' ? 'json' : 'text' }
    : detectFormat(raw, file);
  const vendor = brand.vendor || 'generic';
  const source = sourceOfFormat(format.format);

  let records;
  if (format.nodeType === 'json') records = recordsFromJson(raw);
  else if (format.nodeType === 'json-lines') records = recordsFromJsonLines(raw);
  else {
    records = splitRecords(raw, {
      defaultYear: options.defaultYear,
      keyValueBlocks: true,
      // storage-cli/plain 是"无时间戳的行式输出"；IDL 日志的时间戳在行中间（...|时间|Assert|码|），
      // 也必须一行一条，否则会被"时间戳开头=新记录"的规则糊成一条。
      splitEveryLine: format.format === 'storage-cli' || format.format === 'plain' || format.format === 'inspur-idl',
    });
  }

  const events = [];
  let noiseCount = 0;
  const unmatchedPatterns = new Map();

  for (const record of records) {
    // 浪潮 IDL 故障诊断日志：先按手册的管道分隔结构解一遍，再把结构化字段拼进 haystack 交给规则引擎
    const idl = parseIdlLine((record.raw.split('\n')[0] || '').trim());
    const haystack = idl ? `${selHaystack(record)} ${idlHaystack(idl)}` : selHaystack(record);
    const matched = matchRules(haystack, vendor);
    const slot = extractSlot(haystack);
    const temps = extractTemps(haystack);
    const count = extractCount(haystack);

    // 逐个码查外部码表（厂商手册导入）：任一命中即采用它的语义/等级/处置
    let external = null;
    for (const code of matched.codes) {
      const hit = lookupExternalCode(codeTables(), vendor, code);
      if (hit) {
        external = hit;
        break;
      }
    }

    // 既没命中规则、也没有码表/IDL 语义的"无时间戳信息行"（导出标题、表头、说明行）
    // 归入噪音：否则它们会出现在"未识别硬件行"里，让人以为漏掉了故障。
    // 注意：码表/IDL 命中的行**永不**算噪音 —— 中文行不含英文硬件词，会被 isNoise 误判（实测踩过）。
    const headerLike = !record.ts && matched.codes.length === 0;
    const noisy = matched.primary === null && !external && !idl && (isNoise(record.raw) || headerLike);

    if (noisy) {
      noiseCount += 1;
      if (!options.includeNoise) continue;
    }

    let sev;
    let cat;
    let title;
    let detail = '';
    let ruleId = null;

    if (matched.primary) {
      ruleId = matched.primary.id;
      cat = matched.primary.cat;
      sev = matched.primary.sev;
      title = matched.primary.title;
      const assertLevel = assertionSeverity(haystack);
      if (assertLevel) sev = maxSeverity(sev, assertLevel);
      // 码表与文本措辞不一致时以"更高等级"为准（手册给 critical、措辞像 minor 时不要漏报）
      if (external && severityRank(external.severity) > severityRank(sev)) sev = external.severity;
      // 手册显式给出的分类优先（同一码在不同固件版本里可能换类别，用户手上那版手册更权威）
      if (external && external.category) cat = external.category;
      if (external && external.rule && external.rule !== ruleId) matched.secondary.push(ruleById(external.rule));
      if (idl) {
        sev = maxSeverity(sev, idlSeverity(idl));
        if (idl.assertion === 'Deassert') {
          sev = 'info';                                  // IDL 的 Deassert = 故障解除
          title = `（已恢复）${title}`;
        }
      }
    } else if (idl) {
      // 规则没命中但识别出 IDL 结构：用手册给的部件/级别/事件名生成事件（不是"未识别"）
      ruleId = null;
      cat = idl.category || 'other';
      sev = idlSeverity(idl);
      title = `【浪潮 IDL】${idl.eventName || idl.componentLabel || '诊断事件'}${idl.componentLabel ? `（${idl.componentLabel}）` : ''}`;
      if (idl.assertion === 'Deassert') title += ' — 故障解除';
    } else if (external) {
      // 手册码表命中：语义/等级/处置来自码表，不再算"未识别"
      ruleId = external.rule || null;
      cat = external.category || (external.rule ? ruleById(external.rule).cat : 'other');
      sev = external.severity || assertionSeverity(haystack) || severityFromText(haystack) || 'major';
      const assertLevel = assertionSeverity(haystack);
      if (assertLevel) sev = maxSeverity(sev, assertLevel);
      title = external.meaning ? `【手册码表】${truncate(external.meaning, 96)}` : `【手册码表】${external.code}`;
    } else {
      sev = assertionSeverity(haystack) || severityFromText(haystack) || 'info';
      cat = 'other';
      title = slot ? `未识别事件（${slot.kind} ${slot.id}）` : '未识别事件';
      if (!noisy) {
        const key = signatureOf({ ruleId: null, slot, raw: record.raw });
        unmatchedPatterns.set(key, {
          key,
          text: truncate(haystack.replace(/\s+/g, ' '), 180),
          count: (unmatchedPatterns.get(key)?.count || 0) + 1,
        });
      }
    }

    if (slot) detail += `定位=${slot.kind.toUpperCase()}:${slot.id} `;
    if (temps.length) detail += `温度=${temps.map((t) => `${t.value}C`).join('/')} `;
    if (count != null) detail += `计数=${count} `;
    if (matched.codes.length) detail += `事件码=${matched.codes.join(',')} `;
    if (external) detail += `语义来源=${external.source}${external.version ? '@' + external.version : ''} `;
    if (idl) {
      const bits = [];
      if (idl.assertion) bits.push(`断言=${idl.assertion}`);
      if (idl.code) bits.push(`IDL码=${idl.code}`);
      if (idl.codeDecoded && idl.codeDecoded.note) bits.push(idl.codeDecoded.note);
      if (idl.reading) {
        bits.push(`读数=${idl.reading.value}${idl.reading.direction === 'higher' ? '>' : '<'}阈值${idl.reading.threshold}`);
      } else if (idl.thresholdAssertion) {
        bits.push(idl.thresholdAssertion);
      }
      detail += `IDL[${idl.componentLabel || '未知部件'}${bits.length ? ` ${bits.join(' ')}` : ''}] `;
    }
    detail = detail.trim();

    events.push({
      id: stableHash(`${file}:${record.line}:${record.raw.slice(0, 200)}`),
      ts: record.ts,
      uptimeSec: record.uptimeSec,
      source,
      vendor,
      ruleId,
      cat,
      sev,
      title,
      detail,
      slot,
      temps,
      count,
      codes: matched.codes,
      secondary: matched.secondary.map((rule) => rule.id),
      external: external
        ? { code: external.code, meaning: external.meaning, action: external.action, source: external.source, version: external.version, origin: external.origin }
        : null,
      idl: idl
        ? {
          eventName: idl.eventName,
          level: idl.level,
          component: idl.component,
          componentLabel: idl.componentLabel,
          assertion: idl.assertion,
          code: idl.code,
          reading: idl.reading,
          codeNote: idl.codeDecoded ? idl.codeDecoded.note : '',
        }
        : null,
      raw: record.raw,
      file,
      line: record.line,
      noise: noisy,
      unmatched: matched.primary === null && !external && !noisy,
    });
  }

  const ledger = extractLedger(raw);
  const byRule = events.filter((event) => event.ruleId).length;

  return {
    file,
    format: format.format,
    formatLabel: format.label,
    source,
    vendor,
    vendorLabel: brand.label,
    vendorConfidence: brand.confidence,
    vendorEvidence: brand.evidence,
    ledger: ledger.fields,
    ledgerEvidence: ledger.evidence,
    ledgerMissing: ledger.missing,
    events,
    coverage: {
      records: records.length,
      matchedEvents: byRule,
      noiseRecords: noiseCount,
      unmatchedRecords: events.filter((event) => event.unmatched).length,
      matchedRatio: records.length === 0 ? 0 : Number((byRule / records.length).toFixed(3)),
    },
    unmatchedPatterns: Array.from(unmatchedPatterns.values()).sort((a, b) => b.count - a.count).slice(0, 8),
  };
}

/** Redfish LogService JSON → 记录列表（兼容 {Members:[]} / {Entries:[]} / 裸数组 / 单条对象）。 */
export function recordsFromJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return splitRecords(text, {});
  }
  const list = [];
  const pushEntry = (entry, index) => {
    if (!entry || typeof entry !== 'object') return;
    const ts = entry.Created || entry.Timestamp || entry.EventTimestamp || null;
    const severity = entry.Severity || entry.Level || '';
    const messageId = entry.MessageId || entry.EventId || entry.Id || '';
    const message = entry.Message || entry.Description || entry.EventDescription || entry.EntryType || '';
    const sensor = entry.SensorType ? `[${entry.SensorType}${entry.SensorNumber != null ? `#${entry.SensorNumber}` : ''}]` : '';
    const raw = [ts, severity, messageId, sensor, message].filter(Boolean).join(' | ');
    list.push({
      raw: raw || JSON.stringify(entry),
      ts: ts ? String(ts).replace(' ', 'T') : null,
      uptimeSec: null,
      line: index + 1,
      fields: {
        ...(entry.SensorType ? { 'Sensor Type': entry.SensorType } : {}),
        ...(entry.Severity ? { Severity: entry.Severity } : {}),
        ...(entry.MessageId ? { 'Message Id': entry.MessageId } : {}),
      },
    });
  };

  if (Array.isArray(data)) data.forEach(pushEntry);
  else if (Array.isArray(data.Members)) data.Members.forEach(pushEntry);
  else if (Array.isArray(data.Entries)) data.Entries.forEach(pushEntry);
  else if (Array.isArray(data.Logs)) data.Logs.forEach(pushEntry);
  else if (data['@odata.type'] || data.Message || data.MessageId) pushEntry(data, 0);
  else if (data.value && Array.isArray(data.value)) data.value.forEach(pushEntry);
  else pushEntry(data, 0);

  return list;
}

/** systemd journal 的 JSON 导出（每行一个 JSON 对象）。 */
export function recordsFromJsonLines(text) {
  const list = [];
  const rawLines = normalizeText(text).split('\n');
  for (let i = 0; i < rawLines.length; i += 1) {
    const line = rawLines[i].trim();
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = entry.MESSAGE || entry.MESSAGE_UTF8 || '';
    const ts = entry.__REALTIME_TIMESTAMP
      ? new Date(Number(entry.__REALTIME_TIMESTAMP) / 1000).toISOString()
      : (entry.__TIMESTAMP ? String(entry.__TIMESTAMP) : null);
    const unit = entry._SYSTEMD_UNIT || entry.SYSLOG_IDENTIFIER || entry._COMM || '';
    const prio = entry.PRIORITY != null ? `prio=${entry.PRIORITY}` : '';
    list.push({
      raw: [ts, entry._HOSTNAME || '', unit, prio, msg].filter(Boolean).join(' '),
      ts,
      uptimeSec: null,
      line: i + 1,
      fields: unit ? { Unit: unit } : {},
    });
  }
  return list;
}

/** 便捷函数：解析后的统计尾（给 CLI/工具用）。 */
export function summarizeParse(result) {
  const byCategory = {};
  for (const event of result.events) {
    if (!event.ruleId) continue;
    byCategory[event.cat] = (byCategory[event.cat] || 0) + 1;
  }
  const worst = result.events.reduce((acc, event) => (severityRank(event.sev) > severityRank(acc) ? event.sev : acc), 'info');
  return {
    file: result.file,
    vendor: result.vendorLabel,
    format: result.formatLabel,
    records: result.coverage.records,
    matched: result.coverage.matchedEvents,
    unmatched: result.coverage.unmatchedRecords,
    noise: result.coverage.noiseRecords,
    worstSeverity: worst,
    byCategory,
  };
}

export { ruleById };
