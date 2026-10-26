/**
 * 文本/时间/槽位提取的公共工具层。
 *
 * 铁律：这一层不做任何"品牌判断"，只做纯函数式的字符串处理，方便单测与复用。
 */

const MONTHS = {
  Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
  Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12,
};

export const SEVERITY_ORDER = ['info', 'minor', 'major', 'critical'];

export const SEVERITY_ZH = {
  critical: '紧急',
  major: '严重',
  minor: '轻微',
  info: '提示',
};

export const SEVERITY_WEIGHT = {
  critical: 22,
  major: 9,
  minor: 3,
  info: 0,
};

export function severityRank(sev) {
  const idx = SEVERITY_ORDER.indexOf(String(sev || 'info'));
  return idx < 0 ? 0 : idx;
}

export function maxSeverity(a, b) {
  return severityRank(a) >= severityRank(b) ? a : b;
}

/** 去掉 BOM / ANSI 色码 / CRLF / 不可见控制字符，统一成 LF 文本。 */
export function normalizeText(input) {
  let text = String(input == null ? '' : input);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
  text = text.replace(/\r\n?/g, '\n');
  text = text.replace(/\u00a0/g, ' ');
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  return text;
}

export function toLines(text) {
  return normalizeText(text).split('\n');
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function truncate(text, limit = 200) {
  const raw = String(text == null ? '' : text);
  if (raw.length <= limit) return raw;
  return `${raw.slice(0, limit - 1)}…`;
}

export function uniq(list) {
  return Array.from(new Set(list));
}

export function pad(value, width, fill = ' ') {
  const raw = String(value == null ? '' : value);
  return raw.length >= width ? raw : raw + fill.repeat(width - raw.length);
}

export function padLeft(value, width, fill = ' ') {
  const raw = String(value == null ? '' : value);
  return raw.length >= width ? raw : fill.repeat(width - raw.length) + raw;
}

/** 32 位 FNV-1a，用于给事件生成稳定 id（不引依赖，跨进程一致）。 */
export function stableHash(text) {
  let hash = 0x811c9dc5;
  const raw = String(text == null ? '' : text);
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function two(value) {
  return String(value).padStart(2, '0');
}

/**
 * 从一行里抽时间戳前缀。
 *
 * 支持（其余为"无时间戳行"，作为上一条记录的续行）：
 *   - ISO / Redfish: 2026-08-16T13:37:23.797+08:00 / 2026-08-16 13:37:23
 *   - syslog:        Aug 16 13:37:23
 *   - dmesg:         [ 1234.567890]
 *   - ipmitool sel:  ` 1 | 08/16/2026 | 13:37:23 | ...` 与 hex 变体
 *   - HPE IML:       [13:37:23 08/16/2026]
 *   - 中文日期:       2026年08月16日 13:37:23
 * @param {string} line - 原始行（未 normalize 亦可）。
 * @param {{ defaultYear?: number }} [options] - syslog 这类不带年份的格式用哪个年份。
 * @returns {{ ts: string|null, uptimeSec: number|null, consumed: number }|null}
 */
export function parseTimestamp(line, options = {}) {
  const text = String(line == null ? '' : line).replace(/^\uFEFF/, '');
  const defaultYear = options.defaultYear || new Date().getUTCFullYear();

  let m = /^\[?\s*(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,6}))?\s*(Z|[+-]\d{2}:?\d{2})?/.exec(text);
  if (m) {
    const frac = m[7] ? `.${m[7].padEnd(3, '0').slice(0, 3)}` : '';
    const zone = m[8] ? (m[8] === 'Z' ? 'Z' : m[8].replace(/^([+-]\d{2})(\d{2})$/, '$1:$2')) : '';
    return { ts: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${frac}${zone}`, uptimeSec: null, consumed: m[0].length };
  }

  m = /^\[(\d{2}:\d{2}:\d{2})\s+(\d{2})\/(\d{2})\/(\d{4})\]/.exec(text);
  if (m) {
    return { ts: `${m[4]}-${m[3]}-${m[2]}T${m[1]}`, uptimeSec: null, consumed: m[0].length };
  }

  m = /^\[?\s*(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2}):(\d{2})/.exec(text);
  if (m) {
    return { ts: `${m[1]}-${two(m[2])}-${two(m[3])}T${two(m[4])}:${m[5]}:${m[6]}`, uptimeSec: null, consumed: m[0].length };
  }

  m = /^\s*\d+\s*\|\s*(\d{2})\/(\d{2})\/(\d{4})\s*\|\s*(\d{2}):(\d{2}):(\d{2})/.exec(text);
  if (m) {
    return { ts: `${m[3]}-${m[1]}-${m[2]}T${m[4]}:${m[5]}:${m[6]}`, uptimeSec: null, consumed: m[0].length };
  }

  m = /^\s*\d+\s*\|\s*([0-9a-fA-F]{2})\/([0-9a-fA-F]{2})\/([0-9a-fA-F]{4})\s*\|\s*([0-9a-fA-F]{2}):([0-9a-fA-F]{2}):([0-9a-fA-F]{2})/.exec(text);
  if (m) {
    const year = parseInt(m[3], 16);
    const month = parseInt(m[1], 16);
    const day = parseInt(m[2], 16);
    const hh = parseInt(m[4], 16);
    const mi = parseInt(m[5], 16);
    const ss = parseInt(m[6], 16);
    const valid = year >= 1990 && year <= 2100 && month >= 1 && month <= 12 && day >= 1 && day <= 31;
    return {
      ts: valid ? `${year}-${two(month)}-${two(day)}T${two(hh)}:${two(mi)}:${two(ss)}` : null,
      uptimeSec: null,
      consumed: m[0].length,
    };
  }

  m = /^([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})/.exec(text);
  if (m && MONTHS[m[1]]) {
    return {
      ts: `${defaultYear}-${two(MONTHS[m[1]])}-${two(m[2])}T${m[3]}:${m[4]}:${m[5]}`,
      uptimeSec: null,
      consumed: m[0].length,
    };
  }

  m = /^\[\s*(\d+)\.(\d+)\s*\]/.exec(text);
  if (m) {
    return { ts: null, uptimeSec: Number(`${m[1]}.${m[2]}`), consumed: m[0].length };
  }

  return null;
}

/** 把 19 位 naive 时间当作可排序键；缺失时返回空串（排在最后）。 */
export function timeKey(ts) {
  if (!ts) return '';
  return String(ts).slice(0, 19).replace(' ', 'T');
}

export function earliest(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return timeKey(a) <= timeKey(b) ? a : b;
}

export function latest(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return timeKey(a) >= timeKey(b) ? a : b;
}

/** 从日志文本里抽"严重度"词（品牌无关的常见写法）。 */
export function severityFromText(text) {
  const raw = String(text == null ? '' : text);
  if (/\b(critical|fatal|emerg|emergency|alert|upper non-?recoverable|unrecoverable|non-recoverable)\b/i.test(raw)) return 'critical';
  if (/\b(error|err|fail|failed|failure|major|upper critical|lower critical|degraded|asserted|uncorrectable)\b/i.test(raw)) return 'major';
  if (/\b(warning|warn|minor|lower non-?critical|upper non-?critical|correctable|predictive|throttl\w*|deasserted)\b/i.test(raw)) return 'minor';
  if (/\b(info|informational|notice|normal|resolved|ok|deassert)\b/i.test(raw)) return 'info';
  return null;
}

/**
 * 槽位候选模式。`pr` 是优先级（越小越优先）：同一个"部件"语义的模式优先，
 * 例如 "DIMM slot 7" 应给内存而不是盘位，"EDAC MC0 ... DIMM_A1" 应给内存而不是 BMC。
 * 同级候选之间取"在行里出现更早"的那个（一行里先提的部件才是故障主体）。
 */
const SLOT_PATTERNS = [
  { kind: 'dimm', pr: 1, re: /\bDIMM\s+slot\s+(\d{1,3})\b/i },
  { kind: 'dimm', pr: 1, re: /\bDIMM[ _#-]?([A-Z]\d{1,2}|\d{1,3})\b/i },
  { kind: 'dimm', pr: 1, re: /\bmemory\s+module\s+(\d{1,3})\b/i },
  { kind: 'dimm', pr: 1, re: /\bmemory\s+slot\s+(\d{1,3})\b/i },
  { kind: 'dimm', pr: 1, re: /内存(?:条|槽|模块)?\s*([A-Z]\d{1,2}|\d{1,3})/ },
  { kind: 'pcie', pr: 2, re: /插槽\s*(\d{1,3})/ },
  { kind: 'fan', pr: 3, re: /风扇\s*(\d{1,2})/ },
  { kind: 'psu', pr: 3, re: /电源(?:模块|单元|供应器)\s*(\d{1,2})/ },
  { kind: 'disk', pr: 3, re: /(?:硬盘|磁盘)\s*(\d{1,2})/ },
  { kind: 'pcie', pr: 4, re: /\b(\d{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-9a-f])\b/i },
  { kind: 'pcie', pr: 2, re: /\b(?:PCIE|PCIe|PCI)\s*slot\s*#?\s*(\d{1,3})\b/i },
  { kind: 'pcie', pr: 2, re: /\b(?:BDF|Bus)\s*[:=]?\s*([0-9a-f]{2}:[0-9a-f]{2}\.[0-9a-f])\b/i },
  { kind: 'psu', pr: 3, re: /\b(?:PSU|PWR\s*SUPPLY|POWER\s*SUPPLY|PowerSupply)\s*(\d{1,2})\b/i },
  { kind: 'psu', pr: 3, re: /\bPS([0-9]{1,2})\b/ },
  { kind: 'fan', pr: 3, re: /\b(?:FAN\s*MODULE|SYS\s*FAN|FAN)\s*(\d{1,2})\b/i },
  { kind: 'fan', pr: 3, re: /\bFM([0-9]{1,2})\b/ },
  { kind: 'disk', pr: 3, re: /\b(?:physical\s+drive|Disk|Drive|Bay|HDD)\s*(\d{1,3})\b/i },
  { kind: 'disk', pr: 3, re: /\bDrive\s+slot\s*(\d{1,3})\b/i },
  { kind: 'disk', pr: 3, re: /\b(sd[a-z])\b/ },
  { kind: 'disk', pr: 3, re: /\b(nvme\d+n\d+)\b/ },
  { kind: 'cpu', pr: 3, re: /\bCPU\s*#?\s*(\d{1,2})\b/i },
  { kind: 'cpu', pr: 3, re: /\bprocessor\s*#?\s*(\d{1,2})\b/i },
  { kind: 'raid', pr: 4, re: /\b(?:Virtual\s+Drive|VD|Volume|RAID\s*Group|Array)\s*#?\s*(\d{1,2})\b/i },
  { kind: 'nic', pr: 3, re: /\b(eth\d+|eno\d+(?:np\d+)?|ens\d+(?:f\d+)?|enp\d+s\d+(?:f\d+)?|bond\d+)\b/i },
  { kind: 'dimm', pr: 5, re: /\bDIMM(\d{3})\b/i },
  { kind: 'bmc', pr: 6, re: /\b(MC\d+)\b/ },
  { kind: 'temp', pr: 6, re: /\b(TMP\d{3,4})\b/i },
  { kind: 'fan', pr: 7, re: /\bFan\s*#\s*(\d{1,3})\b/i },
  { kind: 'psu', pr: 7, re: /\bPower\s*Supply\s*#\s*0x([0-9a-f]{2})\b/i },
];

/**
 * 抽取"告警落在哪个部件"的槽位信息，用于报告里精确定位备件。
 * @param {string} text - 原始行或事件标题。
 * @returns {{ kind: string, id: string, raw: string }|null}
 */
export function extractSlot(text) {
  const raw = String(text == null ? '' : text);
  let best = null;
  for (const pattern of SLOT_PATTERNS) {
    pattern.re.lastIndex = 0;
    const m = pattern.re.exec(raw);
    if (!m) continue;
    const candidateId = String((m[2] || m[1] || '')).trim();
    if (!candidateId || candidateId.length > 24) continue;
    const candidate = { kind: pattern.kind, id: candidateId, raw: m[0], pr: pattern.pr, index: m.index };
    if (!best
      || candidate.pr < best.pr
      || (candidate.pr === best.pr && candidate.index < best.index)) {
      best = candidate;
    }
  }
  if (!best) return null;
  return { kind: best.kind, id: best.id, raw: best.raw };
}

const TEMP_RE = /(\d{2,3}(?:\.\d)?)\s*(?:deg(?:rees)?\s*)?(?:C|℃|摄氏度)\b/gi;

/** 抽取温度读数（摄氏度），带上下游摘要便于报告取证。 */
export function extractTemps(text) {
  const raw = String(text == null ? '' : text);
  const out = [];
  let m;
  TEMP_RE.lastIndex = 0;
  while ((m = TEMP_RE.exec(raw)) !== null) {
    const value = Number(m[1]);
    if (!Number.isFinite(value) || value < -40 || value > 200) continue;
    const start = Math.max(0, m.index - 40);
    out.push({ value, context: raw.slice(start, m.index + m[0].length).replace(/\s+/g, ' ').trim() });
    if (out.length >= 4) break;
  }
  return out;
}

/** 抽取 "Correctable ECC 1024" 这类计数阈值，报告里用来说明劣化程度。 */
export function extractCount(text) {
  const raw = String(text == null ? '' : text);
  const patterns = [
    /\b(?:count|counts|occurrences|threshold exceeded|exceeded(?: the)? threshold(?:\s*of)?)\D{0,6}(\d{1,9})\b/i,
    /\b(\d{1,9})\s*(?:CE|UE|errors?)\b/i,
  ];
  for (const re of patterns) {
    const m = re.exec(raw);
    if (m) return Number(m[1]);
  }
  return null;
}

/** 计算毫秒级时间差（naive 时间也能比较）；任一缺失返回 null。 */
export function timeSpanMs(first, last) {
  if (!first || !last) return null;
  const a = Date.parse(`${timeKey(first)}Z`);
  const b = Date.parse(`${timeKey(last)}Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.abs(b - a);
}

export function humanSpan(ms) {
  if (ms == null) return '';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec} 秒`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} 分钟`;
  const hour = Math.round(min / 60);
  if (hour < 48) return `${hour} 小时`;
  return `${Math.round(hour / 24)} 天`;
}
