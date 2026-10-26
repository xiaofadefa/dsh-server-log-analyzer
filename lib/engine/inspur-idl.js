/**
 * 浪潮 BMC「IDL 日志」专用解析（Inspur IDL = 故障诊断日志）。
 *
 * 依据：《浪潮英信服务器 BMC日志收集和分析指南 V2.5》表 3-3「IDL 事件码说明」与表 3-4/3-5/3-6 的三条真实日志示例。
 *
 * ① 事件码：手册定义 **8 个字节**，字节含义（表 3-3）
 *      0-1 字节 = 告警级别（00 INFO / 01 WARNING / 02 CRITICAL / 03 ALERT）
 *      2-3 字节 = 事件的偏移量（表示事件类型）
 *      4-5 字节 = 部件序号（该部件类型内的序号）
 *      6-7 字节 = 部件类型（04 FAN / 05 INTRUSION / 07 CPU / 08 PSU / 0B ADDIN_CARD / 0C MEMORY / 0D DISK …）
 *    注意：部件类型值与 **IPMI sensor type 一致**（0x04 Fan / 0x08 Power Supply / 0x0C Memory / 0x0D Drive Slot），
 *    因此事件偏移可以复用 IPMI SEL 的 offset 语义表（见 ipmi-sel-binary.js）。
 *    手册示例里出现的是 8 个十六进制字符（4 字节），属**简写/截断形态**——
 *    这种情况本模块只标注"简写，无法按 8 字节表解"，不做臆测。
 *
 * ② 日志行：手册示例为管道分隔
 *      事件名 | 级别 | 部件 | 事件描述 | 时间戳 | Assert/Deassert | 事件码 | 序列号
 *    其中"事件描述"往往就是传感器读数（如 `Outlet_Temp reading 36.00 higher than threshold 35.00
 *    (Upper Non-Critical-Going High)`）→ 直接交给规则引擎，英文/中文措辞都能命中。
 */

import { SENSOR_TYPES } from './ipmi-sel-binary.js';
// 说明：IDL 的"部件类型"取值与 IPMI sensor type 一致（0x04 Fan / 0x08 Power Supply / 0x0C Memory / 0x0D Drive Slot），
// 因此事件偏移直接复用 IPMI SEL 的 offset 语义表（见 ipmi-sel-binary.js 的 EVENT_OFFSETS）。
import { EVENT_OFFSETS } from './ipmi-sel-binary.js';

/** 手册表 3-3 明确给出的部件类型值。 */
export const IDL_COMPONENT_TYPES = {
  0x01: 'SYSTEM',
  0x02: 'POWER_BUTTON',
  0x03: 'MAINBOARD',
  0x04: 'FAN',
  0x05: 'INTRUSION',
  0x06: 'SYSTEM_EVENT',
  0x07: 'CPU',
  0x08: 'PSU',
  0x09: 'EVENT_LOG',
  0x0a: 'SYS_FW_PROGRESS',
  0x0b: 'ADDIN_CARD',
  0x0c: 'MEMORY',
  0x0d: 'DISK',
  0x0e: 'PCIE',
  0x0f: 'CABLE',
  0x10: 'BMC',
  0x11: 'OS_STATUS',
  0x12: 'BOOT_ERROR',
  0x13: 'WATCHDOG1',
  0x17: 'IPMI_WATCHDOG',
  0x20: 'RAID',
  0x21: 'FW_UPDATE',
  0x22: 'ACPI_STATUS',
  0x23: 'PCH',
  0x24: 'GPU',
  0x25: 'LAN',
  0x26: 'SUB_SYSTEM',
  0x27: 'BIOS_OPTIONS',
  0x28: 'SYS_RESTART',
  0x29: 'BIOS_BOOT',
};

const IDL_LEVELS = {
  0x00: { name: 'INFO', severity: 'info' },
  0x01: { name: 'WARNING', severity: 'minor' },
  0x02: { name: 'CRITICAL', severity: 'critical' },
  0x03: { name: 'ALERT', severity: 'critical' },
};

/** 部件（文本形态，手册"设备类型"枚举 + 表 3-3 数值形态）→ 规则引擎类别。 */
export const IDL_COMPONENT_ALIASES = {
  FAN: { category: 'thermal', label: '风扇' },
  TEMPERATURE: { category: 'thermal', label: '温度' },
  INTRUSION: { category: 'board', label: '机箱入侵' },
  CPU: { category: 'cpu', label: '处理器' },
  PSU: { category: 'power', label: '电源' },
  ADDIN_CARD: { category: 'pcie', label: '扩展卡' },
  MEMORY: { category: 'memory', label: '内存' },
  DISK: { category: 'storage', label: '硬盘' },
  SYS_FW_PROGRESS: { category: 'firmware', label: '固件进度' },
  EVENT_LOG: { category: 'firmware', label: '事件日志' },
  WATCHDOG1: { category: 'firmware', label: '看门狗1' },
  IPMI_WATCHDOG: { category: 'firmware', label: 'IPMI 看门狗' },
  SYSTEM_EVENT: { category: 'board', label: '系统事件' },
  SYSTEM: { category: 'board', label: '系统' },
  POWER_BUTTON: { category: 'board', label: '电源按钮' },
  MAINBOARD: { category: 'board', label: '主板' },
  PCIE: { category: 'pcie', label: 'PCIe' },
  PCI: { category: 'pcie', label: 'PCIe' },
  BMC: { category: 'firmware', label: 'BMC' },
  PCH: { category: 'board', label: 'PCH' },
  CABLE: { category: 'board', label: '线缆' },
  SYS_RESTART: { category: 'os', label: '系统重启' },
  BOOT_ERROR: { category: 'firmware', label: '启动错误' },
  BIOS_BOOT: { category: 'firmware', label: 'BIOS 启动' },
  BIOS_OPTIONS: { category: 'firmware', label: 'BIOS 配置' },
  OS_STATUS: { category: 'os', label: '操作系统状态' },
  ACPI_STATUS: { category: 'os', label: 'ACPI 状态' },
  ACPI: { category: 'os', label: 'ACPI' },
  LAN: { category: 'network', label: '网口' },
  SUB_SYSTEM: { category: 'board', label: '子系统' },
  GPU: { category: 'pcie', label: 'GPU' },
  RAID: { category: 'raid', label: 'RAID' },
  FW_UPDATE: { category: 'firmware', label: '固件更新' },
  SYSTEM_UEFI: { category: 'firmware', label: 'UEFI' },
  SNMP_TEST: { category: 'other', label: 'SNMP 测试' },
  SMTP_TEST: { category: 'other', label: 'SMTP 测试' },
};

const LEVEL_TEXT = {
  INFO: 'info', INFORMATIONAL: 'info', 信息: 'info',
  WARNING: 'minor', WARN: 'minor', 告警: 'minor', 警告: 'minor',
  CRITICAL: 'critical', CRIT: 'critical', 严重: 'critical', ALERT: 'critical',
};

/** 事件描述里的读数/阈值/断言级别，用于报告与规则命中。 */
const READING_RE = /([A-Za-z_][\w .-]{2,40}?)\s+reading\s+([\d.]+)\s+(higher|lower)\s+than\s+threshold\s+([\d.]+)/i;
const ASSERTION_RE = /(upper|lower)\s+(non-?recoverable|non-?critical|critical)[\s-]*going\s+(high|low)/i;

function hex(value, width = 2) {
  return value.toString(16).toUpperCase().padStart(width, '0');
}

/**
 * 解 IDL 事件码。
 * @param {string} raw - 形如 `040100000C0D`（8 字节）/ `0x0401...`；也接受手册示例的 8 字符简写。
 * @returns {object|null} 解析结果；无法识别时返回 null（交由通用路径处理）
 */
export function parseIdlCode(raw) {
  const text = String(raw == null ? '' : raw).trim().replace(/^0x/i, '').replace(/[\s:-]/g, '');
  if (!/^[0-9A-Fa-f]+$/.test(text)) return null;

  if (text.length === 16) {
    const bytes = [];
    for (let i = 0; i < 8; i += 1) bytes.push(parseInt(text.slice(i * 2, i * 2 + 2), 16));

    // 手册只说"0-1 字节 = 级别 / 2-3 = 偏移 / 4-5 = 序号 / 6-7 = 部件类型"，
    // 没写这两个字节里哪一个是有效值（十六进制值的书写字节序）。这里**按枚举反查**定位有效字节：
    // 谁落在已知取值集合里就用谁，两者都命中或都不命中才退回固定位置，并在 note 里标出用的是哪个字节。
    const pickByte = (table, leftIndex, rightIndex) => {
      const leftHit = table[bytes[leftIndex]] !== undefined;
      const rightHit = table[bytes[rightIndex]] !== undefined;
      if (leftHit && !rightHit) return leftIndex;
      if (rightHit && !leftHit) return rightIndex;
      return leftIndex;
    };

    const levelIndex = pickByte(IDL_LEVELS, 0, 1);
    const levelByte = bytes[levelIndex];
    const level = IDL_LEVELS[levelByte] || null;

    const componentIndex = pickByte(IDL_COMPONENT_TYPES, 6, 7);
    const componentType = bytes[componentIndex];
    const componentName = IDL_COMPONENT_TYPES[componentType] || `UNKNOWN_TYPE_0x${hex(componentType)}`;
    const alias = IDL_COMPONENT_ALIASES[componentName] || null;

    const offsetTable = EVENT_OFFSETS[componentType] || {};
    const offsetIndex = pickByte(offsetTable, 2, 3);
    const eventOffset = bytes[offsetIndex];

    // 部件序号：手册只说"4-5 字节 = 部件序号"，未给字节序 → 两种读法都给出，不臆测
    const slotBig = bytes[4] * 256 + bytes[5];
    const slotLittle = bytes[5] * 256 + bytes[4];

    return {
      form: '8-byte',
      bytes,
      level: level ? level.name : `UNKNOWN_LEVEL_0x${hex(levelByte)}`,
      severity: level ? level.severity : null,
      levelByteIndex: levelIndex,
      eventOffset,
      eventOffsetText: offsetTable[eventOffset] || null,
      componentIndex: slotBig,
      componentIndexAlt: slotLittle,
      componentType,
      componentTypeByteIndex: componentIndex,
      componentName,
      category: alias ? alias.category : null,
      componentLabel: alias ? alias.label : componentName,
      note: offsetTable[eventOffset]
        ? `${alias ? alias.label : componentName}：${offsetTable[eventOffset]}（IPMI 偏移语义）`
        : `${alias ? alias.label : componentName}（部件类型 0x${hex(componentType)}，事件偏移 0x${hex(eventOffset)}）`,
    };
  }

  if (text.length === 8) {
    // 手册示例里出现的是 8 个十六进制字符（4 字节）：属简写/截断，按定义无法解成 8 字节语义。
    return {
      form: '4-byte-shorthand',
      bytes: [0, 2, 4, 6].map((i) => parseInt(text.slice(i, i + 2), 16)),
      level: null,
      severity: null,
      componentName: null,
      note: '手册示例中的简写形态（4 字节）；完整 8 字节事件码才能按表 3-3 解出级别/部件/偏移',
    };
  }

  return null;
}

const COMPONENT_WORDS = Object.keys(IDL_COMPONENT_ALIASES)
  .sort((a, b) => b.length - a.length)
  .map((key) => key.replace(/_/g, ' '));

function matchComponent(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const upper = raw.toUpperCase().replace(/\s+/g, '_');
  if (IDL_COMPONENT_ALIASES[upper]) return upper;
  const spaced = raw.toUpperCase().replace(/_/g, ' ').replace(/\s+/g, ' ');
  for (const word of COMPONENT_WORDS) {
    if (spaced === word || spaced.startsWith(`${word} `)) return word.replace(/ /g, '_');
  }
  return null;
}

function matchLevel(text) {
  const key = String(text || '').trim().toUpperCase();
  return LEVEL_TEXT[key] || null;
}

/**
 * 解析一行 IDL 日志（管道分隔）。
 * @param {string} line
 * @returns {object|null} 不是 IDL 行时返回 null
 */
export function parseIdlLine(line) {
  const raw = String(line == null ? '' : line).trim();
  if (!raw || !raw.includes('|')) return null;
  const fields = raw.split('|').map((item) => item.trim());
  if (fields.length < 3) return null;

  const used = new Set();
  let level = null;
  let levelIndex = -1;
  let component = null;
  let componentIndex = -1;
  let assertion = null;
  let assertionIndex = -1;
  let code = null;
  let codeIndex = -1;
  let timestamp = null;
  let timestampIndex = -1;

  fields.forEach((field, index) => {
    if (!timestamp && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(field)) {
      timestamp = field;
      timestampIndex = index;
      return;
    }
    if (!assertion && /^(assert|deassert|asserted|deasserted)$/i.test(field)) {
      assertion = field.toUpperCase().startsWith('DE') ? 'Deassert' : 'Assert';
      assertionIndex = index;
      return;
    }
    if (!code && /^(?:0x)?[0-9A-Fa-f]{8}(?:[0-9A-Fa-f]{8})?$/.test(field)) {
      code = field;
      codeIndex = index;
      return;
    }
    if (!level) {
      const mapped = matchLevel(field);
      if (mapped) {
        level = mapped;
        levelIndex = index;
        return;
      }
    }
    if (!component) {
      const matched = matchComponent(field);
      if (matched) {
        component = matched;
        componentIndex = index;
      }
    }
  });

  // 只有"级别 + 部件"或"断言 + 事件码"这类 IDL 特征同时出现，才认它是 IDL 行
  const idlSignal = (level && component) || (assertion && code);
  if (!idlSignal) return null;

  const leftovers = fields.filter((_, index) => !used.has(index)
    && index !== levelIndex && index !== componentIndex && index !== assertionIndex
    && index !== codeIndex && index !== timestampIndex);
  const description = leftovers.sort((a, b) => b.length - a.length)[0] || '';
  const eventName = leftovers.find((item) => item && item !== description) || '';

  const alias = component ? IDL_COMPONENT_ALIASES[component] : null;
  const reading = READING_RE.exec(description);
  const assertionDetail = ASSERTION_RE.exec(description);
  const decodedCode = code ? parseIdlCode(code) : null;

  return {
    isIdl: true,
    raw,
    eventName,
    level,
    component,
    componentLabel: alias ? alias.label : (component || ''),
    category: alias ? alias.category : null,
    description,
    timestamp,
    assertion,
    code,
    reading: reading
      ? {
        sensor: String(reading[1]).trim(),
        value: Number(reading[2]),
        direction: reading[3].toLowerCase(),
        threshold: Number(reading[4]),
      }
      : null,
    thresholdAssertion: assertionDetail
      ? `${assertionDetail[1]} ${assertionDetail[2]} going ${assertionDetail[3]}`
      : null,
    codeDecoded: decodedCode,
  };
}

/** IDL 行 → 供规则引擎使用的文本（把手册给的结构化字段拼回自然语言，便于命中英文/中文规则）。 */
export function idlHaystack(parsed) {
  if (!parsed) return '';
  const parts = [
    parsed.eventName,
    parsed.level,
    parsed.componentLabel || parsed.component,
    parsed.description,
    parsed.thresholdAssertion,
    parsed.assertion,
    parsed.codeDecoded && parsed.codeDecoded.note ? parsed.codeDecoded.note : '',
  ];
  return parts.filter(Boolean).join(' ');
}

/** IDL 行 → 严重度（Deassert 视为"故障解除"，降到 info）。 */
export function idlSeverity(parsed) {
  if (!parsed) return 'info';
  if (parsed.assertion === 'Deassert') return 'info';
  if (parsed.level) return parsed.level;
  if (parsed.codeDecoded && parsed.codeDecoded.severity) return parsed.codeDecoded.severity;
  return 'major';
}
