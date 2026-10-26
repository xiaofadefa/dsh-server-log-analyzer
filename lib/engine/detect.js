/**
 * 品牌 / 日志格式 / 日志来源识别 + 设备台账抽取。
 *
 * 目标：拿到任意一坨"服务器日志"（不带任何元数据），也能给出
 * ①这是哪家的机器 ②这是哪一类日志（带外 SEL / 生命周期 / 系统日志 / Redfish JSON）
 * ③这台机器的型号/序列号/固件版本（报告开头的设备台账）。
 */

import { normalizeText, toLines, truncate } from './text.js';

export const VENDOR_LABELS = {
  dell: 'DELL 戴尔',
  hpe: 'HPE 慧与',
  lenovo: 'Lenovo 联想',
  inspur: 'Inspur 浪潮',
  huawei: 'Huawei 华为',
  supermicro: 'Supermicro 超微',
  sugon: 'Sugon 曙光',
  zte: 'ZTE 中兴',
  h3c: 'H3C 新华三',
  fujitsu: 'Fujitsu 富士通',
  generic: '通用 / 未识别品牌',
};

const VENDOR_SIGNATURES = {
  dell: [
    /\biDRAC\b/i, /\bLifecycle\s+Log\b/i, /\bPowerEdge\b/i, /\bDSET\b/i,
    /Integrated\s+Dell\s+Remote/i, /\bFQDD\b/i, /Dell\s+Inc/i, /\bRAC\d{3}\b/, /\bOMSA\b|OpenManage/i,
  ],
  hpe: [
    /\biLO\b/i, /Integrated\s+Management\s+Log/i, /\bProLiant\b/i, /Hewlett[-\s]?Packard|HPE\b/i,
    /Smart\s+Array/i, /\bIML\b/, /POST\s+Error:/i, /\bAHS\b.*\bActive\s+Health/i,
  ],
  lenovo: [
    /\bXCC\b/i, /XClarity/i, /ThinkSystem|ThinkAgile/i, /\bIMM2?\b/, /\bFQXS[A-Z]{2}\d{4}/,
    /Lenovo/i, /System\s+Management\s+Module/i,
  ],
  inspur: [
    /\bInspur\b/i, /浪潮/, /\bISBMC\b/i, /\bNF\d{4}M\d\b/, /Inspur\s+Electronic/i, /\bPMC\b/,
  ],
  huawei: [
    /\biBMC\b/i, /Huawei/i, /华为/, /FusionServer/i, /\b(?:RH|CH|XH)\d{4}/, /TaiShan/i,
    /\b(?:2288|1288|2488|5288)H[\w-]*/i,
  ],
  supermicro: [/\bSupermicro\b/i, /\bSMC\b/i, /\bX1[01][A-Z]{2}[A-Z-]*/i, /Super\s+Server/i],
  sugon: [/\bSugon\b/i, /曙光/, /\bI620[-\w]*/i, /Dawning/i],
  zte: [/\bZTE\b/i, /中兴/, /\bR\d{4}\s+G\d/i],
  h3c: [/\bH3C\b/i, /新华三/, /UniServer/i, /\bR4900\b|\bR6900\b/i],
  fujitsu: [/\bFujitsu\b/i, /\biRMC\b/i, /PRIMERGY/i],
};

/**
 * 识别品牌：按签名族计分，命中族越多越可信；无签名命中的 SEL 文本归 generic。
 * @param {string} text - 日志全文（内部会只取前 400 行做识别，避免大文件全扫）。
 * @returns {{ vendor: string, label: string, confidence: number, scores: object, evidence: string[] }}
 */
export function detectBrand(text) {
  const lines = toLines(text).slice(0, 400);
  const scores = {};
  const evidence = [];
  for (const line of lines) {
    for (const [vendor, patterns] of Object.entries(VENDOR_SIGNATURES)) {
      for (const re of patterns) {
        if (!re.test(line)) continue;
        scores[vendor] = (scores[vendor] || 0) + 1;
        if (evidence.length < 6 && !evidence.some((item) => item.startsWith(vendor))) {
          evidence.push(`${vendor}: ${truncate(line.trim(), 120)}`);
        }
      }
    }
  }

  let best = 'generic';
  let bestScore = 0;
  for (const [vendor, score] of Object.entries(scores)) {
    if (score > bestScore) {
      best = vendor;
      bestScore = score;
    }
  }

  return {
    vendor: best,
    label: VENDOR_LABELS[best] || best,
    confidence: bestScore === 0 ? 0 : Math.min(0.99, 0.45 + 0.1 * bestScore),
    scores,
    evidence,
  };
}

export const FORMAT_LABELS = {
  'ipmi-sel': 'IPMI SEL 事件表（ipmitool / BMC 原生日志）',
  'idrac-lifecycle': 'iDRAC 生命周期日志（Lifecycle Log）',
  'ilo-iml': 'HPE iLO 集成管理日志（IML/AHS）',
  'redfish-json': 'Redfish LogService JSON',
  'journal-json': 'systemd journal JSON 导出',
  'syslog': 'OS syslog / messages / kern.log',
  'dmesg': '内核环缓冲（dmesg）',
  'storage-cli': '存储工具输出（smartctl / storcli / MegaCli / mdadm）',
  'bmc-text': '带外文本日志（iBMC / 浪潮 BMC / XCC 事件文本）',
  'inspur-idl': '浪潮 BMC IDL 故障诊断日志（传感器事件 + 结构化 8 字节事件码）',
  'plain': '纯文本（按关键字扫描）',
};

const FORMAT_PROBES = [
  { format: 'redfish-json', test: (text) => /"@odata\.type"\s*:\s*"#LogEntry/i.test(text) || /"Members"\s*:\s*\[\s*\{[^]*?"MessageId"/.test(text) },
  { format: 'journal-json', test: (text) => /"__REALTIME_TIMESTAMP"|"MESSAGE"\s*:\s*"/.test(text) },
  {
    format: 'ipmi-sel',
    test: (text) => /^\s*\d+\s*\|\s*(?:\d{2}\/\d{2}\/\d{4}|[0-9a-fA-F]{2}\/[0-9a-fA-F]{2}\/[0-9a-fA-F]{4})\s*\|/m.test(text),
  },
  { format: 'idrac-lifecycle', test: (text) => /Lifecycle|\[(?:Critical|Warning|Info)\]\s*\[?[A-Z]{2,6}\d{3,4}/.test(text) && /\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+/.test(text) },
  { format: 'ilo-iml', test: (text) => /^\s*\[?\d{2}:\d{2}:\d{2}\s+\d{2}\/\d{2}\/\d{4}\]?/m.test(text) || /Integrated\s+Management\s+Log/i.test(text) },
  {
    // 浪潮 BMC 的 IDL 故障诊断日志：管道分隔 + 断言列 + 8/16 位十六进制事件码（序列号 IEIB... 是强特征）
    format: 'inspur-idl',
    test: (text) => /\|\s*(?:Assert|Deassert)\s*\|\s*(?:0x)?[0-9A-Fa-f]{8,16}\b/.test(text)
      || (/IEIB[0-9A-Fa-f]{8,}/.test(text) && /\|\s*(?:Info|Warning|Critical|Alert)\s*\|/i.test(text)),
  },
  { format: 'dmesg', test: (text) => /^\[\s*\d+\.\d+\]\s+\S/m.test(text) },
  {
    format: 'syslog',
    test: (text) => /^[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\S+\s+[\w[\]()./-]+:/m.test(text)
      || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[^\s]*\s+\S+\s+[\w[\]()./-]+:/m.test(text),
  },
  {
    format: 'storage-cli',
    test: (text) => /SMART\s+Attributes|Reallocated_Sector_Ct|Controller\s+=\s+\d|CLI\s+Version|MegaCli|PD\s+List|Virtual\s+Drives|md\/raid/i.test(text),
  },
  {
    // 注意不用 \b 包中文（CJK 属于 \w，"告警日志" 里 \b告警\b 不成立）
    format: 'bmc-text',
    test: (text) => /(?:iBMC|iDRAC|iLO|BMC|XCC)\b/i.test(text)
      && /(?:SEL|Event\s+Log|Alarm|告警|ALM-0x|诊断日志)/.test(text),
  },
];

/**
 * 识别日志格式。
 * @param {string} text - 日志全文。
 * @param {string} [filename] - 文件名（用于兜底）。
 * @returns {{ format: string, label: string, nodeType: 'json'|'json-lines'|'text' }}
 */
export function detectFormat(text, filename = '') {
  const raw = normalizeText(text);
  const head = raw.slice(0, 200000);
  for (const probe of FORMAT_PROBES) {
    if (probe.test(head)) {
      const jsonNode = probe.format === 'redfish-json' ? 'json' : probe.format === 'journal-json' ? 'json-lines' : 'text';
      return { format: probe.format, label: FORMAT_LABELS[probe.format], nodeType: jsonNode };
    }
  }

  const name = String(filename || '').toLowerCase();
  if (/\.json$/.test(name)) {
    const trimmed = head.trimStart();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      return { format: 'redfish-json', label: FORMAT_LABELS['redfish-json'], nodeType: 'json' };
    }
  }
  if (/sel|ipmi|bmc/.test(name)) return { format: 'ipmi-sel', label: FORMAT_LABELS['ipmi-sel'], nodeType: 'text' };
  if (/messages|syslog|kern\.log|secure|daemon/.test(name)) return { format: 'syslog', label: FORMAT_LABELS.syslog, nodeType: 'text' };
  if (/dmesg/.test(name)) return { format: 'dmesg', label: FORMAT_LABELS.dmesg, nodeType: 'text' };

  return { format: 'plain', label: FORMAT_LABELS.plain, nodeType: 'text' };
}

/** 日志格式 → 事件来源（报告里按来源分组）。 */
export function sourceOfFormat(format) {
  switch (format) {
    case 'ipmi-sel': return 'bmc-sel';
    case 'idrac-lifecycle': return 'bmc-lifecycle';
    case 'ilo-iml': return 'bmc-iml';
    case 'bmc-text': return 'bmc-text';
    case 'inspur-idl': return 'bmc-idl';
    case 'redfish-json': return 'bmc-redfish';
    case 'journal-json':
    case 'syslog':
    case 'dmesg': return 'os-log';
    case 'storage-cli': return 'storage-cli';
    default: return 'plain';
  }
}

export const SOURCE_LABELS = {
  'bmc-sel': '带外 SEL 事件表',
  'bmc-lifecycle': '带外生命周期日志',
  'bmc-iml': '带外集成管理日志(IML)',
  'bmc-text': '带外文本日志',
  'bmc-idl': '带外 IDL 诊断日志（浪潮）',
  'bmc-redfish': 'Redfish 日志服务',
  'os-log': '操作系统日志',
  'storage-cli': '存储工具输出',
  plain: '普通文本',
};

const LEDGER_PATTERNS = {
  model: [
    /(?:Product\s+Name|Product|System\s+Model|Machine\s+Model|Device\s+Model|Server\s+Model|机型|产品名称)\s*[:：]\s*(.+)/i,
    /\b(PowerEdge\s+[RTMXC][0-9A-Za-z]+)\b/i,
    /\b(ProLiant\s+[A-Z]{2}\d+[A-Za-z0-9]*)\b/i,
    /\b(ThinkSystem\s+[A-Z]{2}\d+[A-Za-z0-9]*)\b/i,
    /\b((?:NF|SA|TS)\d{4}M\d[A-Za-z0-9]*)\b/,
    /\b((?:RH|CH|XH|TaiShan)\s?\d{4}[A-Za-z0-9\s-]*)\b/,
    /\b((?:R|G)\d{4}\s?G\d{0,2}[A-Za-z0-9]*)\b/,
  ],
  serial: [
    /(?:Serial\s+Number|Serial\s+No\.?|Service\s+Tag|S\/N|SN|序列号|服务代码)\s*[:：]?\s*([A-Za-z0-9][A-Za-z0-9-]{4,23})/i,
    /\b(?:ServiceTag|ServiceTagNumber)\s*[:：=]\s*([A-Za-z0-9-]{5,23})/i,
  ],
  hostname: [
    /(?:Host\s*name|Hostname|Computer\s+Name|主机名)\s*[:：]\s*([A-Za-z0-9._-]{2,63})/i,
    /^[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+([A-Za-z0-9._-]{2,63})\s+/m,
  ],
  bmcVersion: [
    /\b(?:iDRAC|iLO|iBMC|BMC|XCC|IPMI|ISBMC|CPLD|ME)\b[^\n:：]{0,20}(?:Firmware|FW|Version|Ver)\s*[:：]?\s*([0-9][0-9A-Za-z._()/-]{1,30})/i,
    /\bBMC\s+Version\s*[:：]\s*([0-9][0-9A-Za-z._()-]{1,30})/i,
    /\bFirmware\s+Version\s*[:：]\s*([0-9][0-9A-Za-z._()-]{1,30})/i,
  ],
  biosVersion: [
    /\bBIOS\s*(?:Firmware\s*)?(?:Version|Ver|Revision|Rev\.?)\s*[:：]?\s*([0-9][0-9A-Za-z._()-]{1,30})/i,
    /\bSystem\s+BIOS\s*[:：]?\s*([0-9][0-9A-Za-z._()-]{1,30})/i,
    /\bBIOS\s+Date\s*[:：]\s*(.+)/i,
  ],
  cpuModel: [
    /\b(?:Processor|CPU|处理器)\s*[:：]\s*(.+)/i,
    /\b((?:Intel|AMD)[^\n]{0,60}(?:Xeon|EPYC|Ryzen)[^\n]{0,40})/i,
    /\b((?:Kunpeng|Hygon|Phytium|飞腾|鲲鹏|海光)[^\n]{0,40})/i,
  ],
  memoryTotal: [
    /\b(?:Total\s+Memory|Installed\s+Memory|Memory\s+Size|Memory\s+Total|内存总量)\s*[:：]?\s*([0-9.]+\s*(?:TB|GB|MB|T|G|M))\b/i,
    /\bMemory\s+Capacity\s*[:：]?\s*([0-9.]+\s*(?:TB|GB))\b/i,
  ],
  osVersion: [
    /\b(?:OS|Operating\s+System|操作系统)\s*(?:Version|Release|Name)?\s*[:：]\s*(.+)/i,
    /\bLinux\s+version\s+(\S+)/i,
    /\b((?:Red\s*Hat|CentOS|Ubuntu|Debian|openEuler|Kylin|麒麟|统信|UOS|SUSE|Rocky)[^\n]{0,40})/i,
  ],
  managementIp: [
    // 必须与"管理/BMC/IP/地址"同现，否则会把 iDRAC 固件版本 7.10.30.00 当成 IP（真实踩过的坑）
    /\b(?:BMC|iDRAC|iLO|iBMC|XCC|IPMI|HDM|iRMC|管理)\b[^\n]{0,24}(?:IP|Address|Addr|地址)\s*[:：=]?\s*(\d{1,3}(?:\.\d{1,3}){3})/i,
    /(?:management|out-?of-?band|带外)\s+(?:IP|address|addr|地址)\s*[:：=]?\s*(\d{1,3}(?:\.\d{1,3}){3})/i,
    /\b(?:IP|IPAddress|IP Address)\s*[:：=]\s*(\d{1,3}(?:\.\d{1,3}){3})/i,
  ],
};

function isPlausibleIp(value) {
  const parts = String(value).split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255 && !(part.length > 1 && part.startsWith('0')));
}

function firstMatch(patterns, lines, field) {
  for (const re of patterns) {
    for (const line of lines) {
      const m = re.exec(line);
      if (!m) continue;
      const value = String(m[1] || '').trim().replace(/\s{2,}/g, ' ');
      if (!value || value.length > 120) continue;
      // 只有"管理地址"这个字段需要做 IP 合法性校验（固件版本 7.10.30.00 长得很像 IP，会误判）
      if (field === 'managementIp' && /^\d{1,3}(\.\d{1,3}){3}$/.test(value) && !isPlausibleIp(value)) continue;
      return { value, evidence: truncate(line.trim(), 160) };
    }
  }
  return null;
}

/**
 * 抽取设备台账（型号/序列号/固件/CPU/内存/系统）。
 * @param {string} text - 日志全文。
 * @returns {{ fields: object, evidence: object, missing: string[] }}
 */
export function extractLedger(text) {
  const lines = toLines(text).slice(0, 20000);
  const fields = {};
  const evidence = {};
  for (const [key, patterns] of Object.entries(LEDGER_PATTERNS)) {
    const hit = firstMatch(patterns, lines, key);
    if (hit) {
      fields[key] = hit.value;
      evidence[key] = hit.evidence;
    }
  }
  const missing = Object.keys(LEDGER_PATTERNS).filter((key) => !fields[key]);

  // 电源/风扇数量这类"配置台账"用计数方式统计一下，报告里很有用。
  const psuIds = new Set();
  const fanIds = new Set();
  const dimmIds = new Set();
  for (const line of lines) {
    const psu = /\b(?:PSU|Power\s*Supply)\s*([0-9]{1,2})\b/i.exec(line);
    if (psu) psuIds.add(psu[1]);
    const fan = /\bFAN\s*([0-9]{1,2})\b/i.exec(line);
    if (fan) fanIds.add(fan[1]);
    const dimm = /\bDIMM[ _]?([A-Z]\d{1,2}|\d{1,3})\b/i.exec(line);
    if (dimm) dimmIds.add(dimm[1].toUpperCase());
  }
  if (psuIds.size) fields.powerSuppliesSeen = `${psuIds.size} 个（编号 ${Array.from(psuIds).sort().join(',')}）`;
  if (fanIds.size) fields.fansSeen = `${fanIds.size} 个（编号 ${Array.from(fanIds).sort().join(',')}）`;
  if (dimmIds.size) fields.dimmsSeen = `${dimmIds.size} 条（${Array.from(dimmIds).sort().slice(0, 12).join(',')}${dimmIds.size > 12 ? '…' : ''}）`;

  return { fields, evidence, missing };
}
