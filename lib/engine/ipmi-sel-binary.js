/**
 * 二进制 IPMI SEL 解析（`ipmitool sel save` / BMC 导出的 .bin）。
 *
 * 为什么需要：很多场景**进不去 OS**，甚至 BMC 网页只能导出二进制 SEL 或一键收集包里的 .bin，
 * 这类文件以前会被当成"二进制、跳过"。这里把标准 16 字节 SEL 记录解成
 * ipmitool `sel list` 同样形态的文本行，后续解析/规则/报告全部复用同一条管线。
 *
 * 记录布局（IPMI v1.5 / v2.0 SEL，16 字节，小端）：
 *   [0..1] Record ID   [2] Record Type(0x02=系统事件)  [3..6] 时间戳(unix 秒)
 *   [7..8] Generator ID  [9] EvMRev  [10] Sensor Type  [11] Sensor Number
 *   [12] Event Dir|Type(bit7=1 表示 Asserted)  [13] Event Data 1  [14] Event Data 2  [15] Event Data 3
 *
 * 事件语义用"常用表"（各厂商对同一 sensor type 的 event offset 有细微差异，
 * 表里给的是通用语义；命中不了的会退化成 `SensorType(0xNN) event offset 0xM`，仍能被断言级别定级）。
 */

export const SEL_RECORD_BYTES = 16;

export const SENSOR_TYPES = {
  0x01: 'Temperature',
  0x02: 'Voltage',
  0x03: 'Current',
  0x04: 'Fan',
  0x05: 'Physical Security',
  0x06: 'Platform Security',
  0x07: 'Processor',
  0x08: 'Power Supply',
  0x09: 'Power Unit',
  0x0a: 'Cooling Device',
  0x0b: 'Other Units',
  0x0c: 'Memory',
  0x0d: 'Drive Slot',
  0x0e: 'POST Memory Resize',
  0x0f: 'System Firmware Progress',
  0x10: 'Event Logging Disabled',
  0x11: 'Watchdog 1',
  0x12: 'System Event',
  0x13: 'Critical Interrupt',
  0x14: 'Button',
  0x15: 'Module / Board',
  0x16: 'Microcontroller',
  0x17: 'Watchdog 2',
  0x18: 'Entity Presence',
  0x19: 'Chip Set',
  0x1a: 'Other FRU',
  0x1b: 'Cable / Interconnect',
  0x1c: 'Memory Buffer',
  0x1d: 'Memory Module',
  0x1e: 'Slot / Connector',
  0x1f: 'System Firmware',
  0x20: 'OS Boot',
  0x21: 'System Boot',
  0x23: 'Battery',
  0x24: 'Session Audit',
  0x25: 'Version Change',
  0x27: 'System Boot',
  0x28: 'Management Subsystem Health',
  0x29: 'System Bus / PCIe',
  0x2a: 'Fan Module',   // 部分厂商私有
  0x2b: 'Power Module', // 部分厂商私有
};

export const EVENT_OFFSETS = {
  0x01: {
    0: 'Temperature transition to OK', 1: 'Temperature Lower Non-critical', 2: 'Temperature Lower Critical',
    3: 'Temperature Lower Non-recoverable', 4: 'Temperature Upper Non-critical', 5: 'Temperature Upper Critical',
    6: 'Temperature Upper Non-recoverable',
  },
  0x04: {
    0: 'Fan transition to OK', 1: 'Fan Lower Non-critical (speed low)', 2: 'Fan Lower Critical (speed low)',
    3: 'Fan Lower Non-recoverable (speed low)', 4: 'Fan Upper Non-critical', 5: 'Fan Upper Critical',
    6: 'Fan Upper Non-recoverable', 7: 'Fan Failure detected',
  },
  0x07: {
    0: 'Processor IERR', 1: 'Processor thermal trip', 2: 'Processor FRB1/BIST failure',
    3: 'Processor FRB2/Hang in POST failure', 4: 'Processor FRB3/Configuration failure',
    5: 'Processor SM BIOS uncorrectable CPU-complex error', 6: 'Processor presence detected',
    7: 'Processor disabled', 8: 'Processor terminator presence detected', 9: 'Processor throttled',
  },
  0x08: {
    0: 'Power supply presence detected', 1: 'Power supply failure detected',
    2: 'Power supply predictive failure', 3: 'Power supply input lost (AC lost)',
    4: 'Power supply input lost or out of range', 5: 'Power supply input out of range',
    6: 'Power supply configuration error',
  },
  0x09: {
    0: 'Power Unit power off', 1: 'Power Unit power cycle', 2: 'Power Unit 240VA limit exceeded',
    3: 'Power Unit interlock (power off)', 4: 'Power Unit A/C lost', 5: 'Power Unit soft power control failure',
  },
  0x0c: {
    0: 'Correctable ECC error', 1: 'Uncorrectable ECC error', 2: 'Parity error', 3: 'Memory scrub error',
    4: 'Memory sparing (row spare)', 5: 'Memory mirroring redundancy lost', 6: 'Out-of-range memory temperature',
  },
  0x0d: {
    0: 'Drive presence detected', 1: 'Drive failure (fault)', 2: 'Drive predictive failure',
    3: 'Drive hot spare', 4: 'Drive rebuild in progress', 5: 'Drive rebuild aborted',
    6: 'Drive rebuild completed', 7: 'Drive slot in critical array', 8: 'Drive slot in failed array',
  },
  0x12: {
    0: 'System reconfigured', 1: 'OEM system boot event', 2: 'Undetermined system hardware failure',
    3: 'Entry added to auxiliary log', 4: 'PEF action', 5: 'Timestamp clock synch',
  },
  0x13: {
    0: 'Front panel NMI / diagnostic interrupt', 1: 'Bus timeout', 2: 'I/O channel check NMI',
    3: 'Software NMI', 4: 'PCI PERR', 5: 'PCI SERR', 6: 'Bus correctable error',
    7: 'Bus uncorrectable error', 8: 'Bus fatal NMI', 9: 'Bus degraded',
  },
  0x17: {
    0: 'Watchdog Timer expired', 1: 'Watchdog hard reset', 2: 'Watchdog power down',
    3: 'Watchdog power cycle', 4: 'Watchdog NMI / diagnostic interrupt',
  },
  0x19: {
    0: 'Chip set thermal trip',
  },
  0x1b: {
    0: 'Cable/Interconnect connected', 1: 'Cable/Interconnect config error',
  },
  0x1c: {
    0: 'Memory buffer correctable ECC', 1: 'Memory buffer uncorrectable ECC', 2: 'Memory buffer parity error',
  },
  0x1d: {
    0: 'Memory module presence detected', 1: 'Memory module failure', 2: 'Memory module correctable ECC',
    3: 'Memory module uncorrectable ECC',
  },
  0x23: {
    0: 'Battery low', 1: 'Battery failed', 2: 'Battery presence detected',
  },
  0x28: {
    0: 'Management subsystem health degraded (BMC)', 1: 'Management subsystem health failure (BMC)',
    2: 'Management subsystem out-of-band access unavailable', 3: 'Management subsystem health OK',
  },
  0x29: {
    0: 'PCIe Correctable error', 1: 'PCIe Uncorrectable error (Fatal)', 2: 'PCIe Uncorrectable error (Non-fatal)',
    3: 'PCIe Fatal error', 4: 'PCIe Bus degraded',
  },
  0x0f: {
    0: 'Memory initialization started', 1: 'Memory initialization completed', 2: 'Memory reset',
    3: 'POST memory resize', 4: 'Firmware progress',
  },
  0x10: {
    0: 'Event logging disabled', 1: 'SEL Full (event log overflow)', 2: 'SEL almost full', 3: 'Correctable memory error logging disabled',
  },
};

const DIRECTION_LABELS = ['Asserted', 'Deasserted'];

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** unix 秒 → `MM/DD/YYYY | HH:MM:SS`（BMC 一般按本地时间记录，这里按本地时区还原）。 */
export function formatSelTime(unixSeconds) {
  if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) return { date: '01/01/1970', time: '00:00:00', iso: null };
  const date = new Date(unixSeconds * 1000);
  if (Number.isNaN(date.getTime()) || unixSeconds > 4102444800) return { date: '01/01/1970', time: '00:00:00', iso: null };
  const dateText = `${pad2(date.getMonth() + 1)}/${pad2(date.getDate())}/${date.getFullYear()}`;
  const timeText = `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
  const iso = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${timeText}`;
  return { date: dateText, time: timeText, iso };
}

/**
 * 判断一段 buffer 是否像二进制 SEL：长度是 16 的倍数，且过半记录是"系统事件(0x02)"。
 * @param {Buffer} buffer
 */
export function looksLikeBinarySel(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < SEL_RECORD_BYTES || buffer.length % SEL_RECORD_BYTES !== 0) return false;
  const total = buffer.length / SEL_RECORD_BYTES;
  const probe = Math.min(total, 64);
  let systemEvents = 0;
  for (let i = 0; i < probe; i += 1) {
    if (buffer[i * SEL_RECORD_BYTES + 2] === 0x02) systemEvents += 1;
  }
  return systemEvents / probe >= 0.5;
}

/** 单条 16 字节记录 → 结构化事件。 */
export function decodeSelRecord(record, index = 0) {
  const recordId = record.readUInt16LE(0);
  const recordType = record[2];
  const timestamp = record.readUInt32LE(3);
  const generatorId = record.readUInt16LE(7);
  const sensorType = record[10];
  const sensorNumber = record[11];
  const dirType = record[12];
  const asserted = (dirType & 0x80) !== 0;
  const eventOffset = record[13] & 0x0f;
  const eventData2 = record[14];
  const eventData3 = record[15];

  const typeName = SENSOR_TYPES[sensorType] || `SensorType(0x${sensorType.toString(16).padStart(2, '0')})`;
  const offsetTable = EVENT_OFFSETS[sensorType] || {};
  const eventText = offsetTable[eventOffset]
    || `${typeName} event offset 0x${eventOffset.toString(16)}`;
  const direction = DIRECTION_LABELS[asserted ? 0 : 1];
  const time = formatSelTime(timestamp);

  return {
    index,
    recordId,
    recordType,
    timestamp,
    iso: time.iso,
    date: time.date,
    time: time.time,
    generatorId,
    sensorType,
    sensorTypeName: typeName,
    sensorNumber,
    asserted,
    direction,
    eventOffset,
    eventText,
    eventData2,
    eventData3,
  };
}

/** 详细行（人看的，带原始字节），用于 doctor/调试。 */
export function selRecordLine(record) {
  return `${record.direction} 0x${record.eventOffset.toString(16)} ${record.sensorTypeName} #0x${record.sensorNumber.toString(16).padStart(2, '0')}`;
}

/**
 * 二进制 SEL → ipmitool `sel list` 形态的行（让整条文本管线直接复用）。
 * @param {Buffer} buffer
 * @returns {{ lines: string[], records: object[] }}
 */
export function binarySelToLines(buffer) {
  const records = [];
  const lines = [];
  const total = Math.floor(buffer.length / SEL_RECORD_BYTES);
  for (let i = 0; i < total; i += 1) {
    const record = decodeSelRecord(buffer.subarray(i * SEL_RECORD_BYTES, (i + 1) * SEL_RECORD_BYTES), i);
    records.push(record);
    const sensorLabel = `${record.sensorTypeName} #0x${record.sensorNumber.toString(16).padStart(2, '0')}`;
    lines.push([
      String(record.recordId).padStart(4, ' '),
      record.date,
      record.time,
      sensorLabel,
      record.sensorTypeName,
      record.eventText,
      record.direction,
    ].join(' | '));
  }
  return { lines, records };
}
