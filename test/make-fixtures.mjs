/**
 * 生成二进制 IPMI SEL 样例（`.bin`）—— 只有带外、进不去 OS 时最常见的导出形态之一。
 * 用法：node test/make-fixtures.mjs
 *
 * 输出：
 *   samples/generic-sel.bin        独立样例（分析演示 / 测试用）
 *   test/.tmp/sel-in-archive.bin   供打包进一键收集包（zip 样例）用
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { binarySelToLines } from '../lib/engine/ipmi-sel-binary.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, '..');

function record(id, sensorType, sensorNumber, offset, asserted, unix) {
  const buffer = Buffer.alloc(16);
  buffer.writeUInt16LE(id, 0);
  buffer[2] = 0x02; // 系统事件记录
  buffer.writeUInt32LE(unix, 3);
  buffer.writeUInt16LE(0x0020, 7); // 生成者 ID
  buffer[9] = 0x04; // EvMRev
  buffer[10] = sensorType;
  buffer[11] = sensorNumber;
  buffer[12] = (asserted ? 0x80 : 0x00) | 0x6f; // 传感器专有事件类型 + 断言位
  buffer[13] = offset & 0x0f;
  buffer[14] = 0xff;
  buffer[15] = 0xff;
  return buffer;
}

const at = (day, hour, minute, second) => Math.floor(new Date(2026, 7, day, hour, minute, second).getTime() / 1000);

// 一台"内存 UCE + 电源掉电 + 风扇 + 掉盘 + 看门狗"的典型故障机
const records = [
  record(1, 0x0c, 0x12, 0x01, true, at(16, 9, 0, 5)),   // Memory  #0x12 Uncorrectable ECC
  record(2, 0x0c, 0x13, 0x00, true, at(16, 9, 0, 6)),   // Memory  #0x13 Correctable ECC
  record(3, 0x04, 0x03, 0x06, true, at(16, 9, 21, 2)),  // Fan     #0x03 Upper Non-recoverable
  record(4, 0x08, 0x51, 0x03, true, at(19, 3, 14, 2)),  // PSU     #0x51 Input lost (AC lost)
  record(5, 0x0d, 0x05, 0x01, true, at(16, 9, 31, 12)), // Drive   #0x05 Drive failure
  record(6, 0x01, 0x01, 0x06, true, at(16, 9, 22, 3)),  // Temp    #0x01 Upper Non-recoverable
  record(7, 0x17, 0x00, 0x00, true, at(18, 10, 2, 11)), // Watchdog2 expired
  record(8, 0x09, 0x01, 0x04, true, at(19, 3, 14, 3)),  // Power Unit A/C lost
];

const buffer = Buffer.concat(records);
const outDir = path.join(PACKAGE_ROOT, 'samples');
await fsp.mkdir(outDir, { recursive: true });
await fsp.writeFile(path.join(outDir, 'generic-sel.bin'), buffer);

const tmpDir = path.join(HERE, '.tmp');
await fsp.mkdir(tmpDir, { recursive: true });
await fsp.writeFile(path.join(tmpDir, 'sel-in-archive.bin'), Buffer.concat(records.slice(0, 5)));

const { lines } = binarySelToLines(buffer);
process.stdout.write(`已生成 samples/generic-sel.bin（${records.length} 条记录 / ${buffer.length} 字节）\n`);
process.stdout.write(lines.map((line) => `  ${line}`).join('\n') + '\n');
