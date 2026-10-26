/**
 * 自测：node --test test/run-tests.mjs
 *
 * 覆盖：品牌/格式识别、规则命中、槽位定位、噪音过滤、台账抽取、聚类与评分、
 * 根因关联、报告渲染、基线对比、采集清单、技能落地、doctor 自检。
 * 断言全部基于 samples/ 下的 11 个样例文件（它们就是"验收标准"）。
 */

import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  readDocuments, analyzeDocuments, analyzeTargets, parseText, rulesDigest,
  renderMarkdown, renderBrief, toDigest, collectPlan, renderCollectScript,
  makeBaseline, diffBaseline, renderDiffMarkdown, doctor, RULE_STATS, collectFiles,
  parseCodeTableText, writeCodeTable, codeTableStatus, parseIdlCode,
  loadOpsLibrary, searchOps, writeOpsTable, relatedOps, opsStatus,
} from '../lib/engine/index.js';
import { installSkills, skillsStatus, listBundledSkills } from '../lib/skills-install.js';
import { normalizeConfig, resolveDefineTool } from '../lib/runtime.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, '..');
const SAMPLES = path.join(PACKAGE_ROOT, 'samples');

/* ── 测试自给自足：把 $DSH_HOME 指向临时目录，并预装一份"手册抽取结果"形态的码表夹具 ──
   这样测试既不污染用户机器，也不依赖用户本机导入过哪些码表（换台机器照样绿）。 */
const TEST_HOME = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-hwlog-test-home-'));
process.env.DSH_HOME = TEST_HOME;
writeCodeTable({
  brand: 'huawei',
  source: 'TaiShan 机架服务器 iBMC 告警处理（测试夹具）',
  version: 'V19-test',
  codes: {
    '0x080000C1': { meaning: 'PCIe卡CPU严重异常', severity: 'critical', category: 'pcie', rule: 'PCIE_DEVICE_ERROR' },
    '0x080000D1': { meaning: 'PCIe卡网卡严重异常', severity: 'critical', category: 'pcie', rule: 'PCIE_DEVICE_ERROR' },
    '0x080000DD': { meaning: 'PCIe卡温度严重异常', severity: 'critical', category: 'pcie' },
    '0x12000013': { meaning: '进风口温度读取失败', severity: 'minor', category: 'thermal' },
    '0x2C000007': { meaning: '系统异常下电', severity: 'critical', category: 'board' },
  },
}, { home: TEST_HOME });
const parseModule = await import('../lib/engine/parse.js');
parseModule.reloadCodeTables();

const EXPECT = {
  'dell-idrac-lifecycle.log': { vendor: 'dell', format: 'idrac-lifecycle', rules: ['MEM_UCE', 'PSU_INPUT_LOST', 'FAN_FAIL', 'CPU_MCE', 'DRIVE_FAIL'] },
  'dell-idrac-sel.log': { vendor: 'dell', format: 'ipmi-sel', rules: ['MEM_UCE', 'PSU_FAIL', 'VOLT_OUT_OF_RANGE', 'RAID_UNUSED_OR_DRIVE'] },
  'hpe-ilo-iml.log': { vendor: 'hpe', format: 'ilo-iml', rules: ['MEM_UCE', 'MEM_TRAINING_FAIL', 'PSU_FAIL', 'PCIE_DEVICE_ERROR', 'RAID_DEGRADED'] },
  'lenovo-xcc-eventlog.log': { vendor: 'lenovo', format: 'bmc-text', rules: ['MEM_UCE', 'FAN_FAIL', 'INTRUSION', 'PSU_REDUNDANCY_LOST', 'BMC_RESET'] },
  'inspur-bmc-sel.log': { vendor: 'inspur', format: 'bmc-text', rules: ['MEM_UCE', 'PSU_FAIL', 'VOLT_OUT_OF_RANGE', 'FAN_FAIL'] },
  'huawei-ibmc-sel.log': { vendor: 'huawei', format: 'bmc-text', rules: ['MEM_UCE', 'MEM_CE', 'PSU_FAIL', 'PSU_INPUT_LOST', 'FAN_FAIL'] },
  'supermicro-sel.log': { vendor: 'supermicro', format: 'ipmi-sel', rules: ['MEM_UCE', 'PSU_FAIL', 'FAN_LOW_SPEED', 'BMC_SEL_FULL', 'INTRUSION'] },
  'linux-syslog-messages.log': { vendor: 'generic', format: 'syslog', rules: ['MEM_CE', 'MEM_UCE', 'PCIE_AER_UE', 'RAID_DEGRADED', 'NIC_HW_ERROR', 'OS_SHUTDOWN_UNEXPECTED'] },
  'linux-dmesg.log': { vendor: 'generic', format: 'dmesg', rules: ['CPU_MCE', 'MEM_UCE', 'HBA_PHY_ERROR', 'PCIE_AER_CE', 'DISK_IO_ERROR'] },
  'redfish-logservice.json': { vendor: 'generic', format: 'redfish-json', rules: ['MEM_UCE', 'PSU_FAIL', 'FAN_FAIL', 'DRIVE_FAIL'] },
  'storage-smartctl-storcli.log': { vendor: 'generic', format: 'storage-cli', rules: ['DRIVE_FAIL', 'DRIVE_PREDICTIVE', 'HBA_PHY_ERROR', 'RAID_REBUILD'] },
  // ── 只有带外（进不去 OS）场景的四种真实导出形态 ──
  'inspur-bmc-export-gbk.txt': { vendor: 'inspur', format: 'ipmi-sel', rules: ['MEM_UCE', 'MEM_CE', 'PSU_FAIL', 'PSU_INPUT_LOST', 'FAN_FAIL', 'DRIVE_FAIL', 'PSU_REDUNDANCY_LOST', 'CPU_THERMAL_THROTTLE'] },
  'hpe-iml-export.html': { vendor: 'hpe', format: 'ipmi-sel', rules: ['MEM_UCE', 'PSU_FAIL', 'FAN_FAIL', 'DRIVE_FAIL', 'PCIE_AER_UE', 'CPU_OVER_TEMP'] },
  'generic-sel.bin': { vendor: 'generic', format: 'ipmi-sel', rules: ['MEM_UCE', 'MEM_CE', 'PSU_INPUT_LOST', 'DRIVE_FAIL', 'THERMAL_TEMP_HIGH', 'BMC_WATCHDOG'] },
  // 浪潮 BMC 独有：IDL 故障诊断日志（结构依据 BMC日志收集和分析指南 V2.5）
  'inspur-idl-log.log': { vendor: 'inspur', format: 'inspur-idl', rules: ['MEM_UCE', 'PSU_FAIL', 'FAN_FAIL', 'DRIVE_FAIL', 'PCIE_AER_CE'] },
  // 华为 TaiShan iBMC 告警日志（ALM-0x… 码，靠手册码表命中）
  'huawei-taishan-alm.log': { vendor: 'huawei', format: 'bmc-text', rules: [] },
};

async function analyzeFile(name, options = {}) {
  const { documents } = await readDocuments([path.join(SAMPLES, name)]);
  return analyzeDocuments(documents, options);
}

function ruleIds(analysis) {
  const ids = new Set();
  for (const finding of analysis.findings) {
    if (finding.ruleId) ids.add(finding.ruleId);
    for (const extra of finding.secondary || []) ids.add(extra);
  }
  return ids;
}

/* ───────── 样例自检：缺样例时点名 + skip，而不是让整套断言莫名全红 ─────────

   samples/ 是"验收标准"，也是版本控制资产。被误删/打包丢失时，以前的表现是
   十几个测试同时红、报错却是 "Cannot read properties of undefined"，很难定位。
   这里从每个测试函数自身的源码里认出它引用的样例文件名：缺哪个就只 skip 哪几个，
   并在 stderr 明确列出缺失清单和恢复办法。 */

const SAMPLE_FILE_REF = /['"]([\w.-]+\.(?:log|txt|json|html|bin|zip))['"]/g;
const EXPECTED_SAMPLES = [...new Set([...Object.keys(EXPECT), 'ibmc-onekey-collect.zip'])];
const MISSING_SAMPLES = EXPECTED_SAMPLES.filter((name) => !existsSync(path.join(SAMPLES, name)));

/** 该测试要用到哪些不存在的样例；不需要样例时返回 false（照常执行）。 */
function skipReasonFor(fn) {
  if (MISSING_SAMPLES.length === 0) return false;
  const source = fn.toString();
  const referenced = [...source.matchAll(SAMPLE_FILE_REF)].map((match) => match[1]);
  const gone = [...new Set(referenced)].filter((name) => MISSING_SAMPLES.includes(name));
  if (gone.length > 0) return `samples/ 缺样例：${gone.join(', ')}（git checkout -- samples 恢复）`;
  // 遍历 EXPECT 的测试（品牌识别 / 规则命中）体里没有字面文件名，但它们依赖全部样例
  if (/Object\.entries\(EXPECT\)|analyzeFile\(\s*[A-Za-z_$]/.test(source)) {
    return `依赖全部样例，缺 ${MISSING_SAMPLES.length} 个：${MISSING_SAMPLES.join(', ')}（git checkout -- samples 恢复）`;
  }
  if (/\bSAMPLES\b/.test(source)) {
    return `samples/ 不完整，缺 ${MISSING_SAMPLES.length} 个：${MISSING_SAMPLES.join(', ')}（git checkout -- samples 恢复）`;
  }
  return false;
}

const test = (name, ...rest) => {
  const fn = rest.pop();
  const options = rest.length > 0 ? rest[0] : {};
  return nodeTest(name, { ...options, skip: skipReasonFor(fn) ?? options.skip }, fn);
};

if (MISSING_SAMPLES.length > 0) {
  console.warn(`\n[样例自检] samples/ 缺 ${MISSING_SAMPLES.length}/${EXPECTED_SAMPLES.length} 个文件，依赖它们的断言会 skip：`);
  for (const name of MISSING_SAMPLES) console.warn(`  - ${name}`);
  console.warn('  恢复：git checkout -- samples\n');
}

test('样例目录：17 个文件都能读出来，压缩包会展开而不是被跳过', async () => {
  const { files, skipped } = await collectFiles([SAMPLES]);
  assert.equal(skipped.length, 0);
  assert.equal(files.length, 17, `样例文件数：${files.length}`);
  const read = await readDocuments([SAMPLES]);
  assert.equal(read.skipped.length, 0, `不应有"跳过"项：${JSON.stringify(read.skipped)}`);
  assert.equal(read.documents.length, 23, 'zip 一键收集包应展开成多条文档');
  assert.ok(read.notes.length >= 5, '展开/解码说明应记录成 notes');
  assert.ok(read.notes.some((note) => note.includes('归档已展开')));
  assert.ok(read.notes.some((note) => note.includes('按 gbk 解码')));
  assert.ok(read.notes.some((note) => note.includes('二进制 SEL 已解码')));
});

test('品牌与格式识别：每个样例都对得上', async () => {
  for (const [name, expect] of Object.entries(EXPECT)) {
    const analysis = await analyzeFile(name);
    const file = analysis.files[0];
    assert.equal(file.vendorKey, expect.vendor, `${name} 品牌识别`);
    assert.equal(file.formatKey, expect.format, `${name} 日志格式识别`);
  }
});

test('规则命中：样例里的关键故障都被识别到', async () => {
  for (const [name, expect] of Object.entries(EXPECT)) {
    const analysis = await analyzeFile(name);
    const ids = ruleIds(analysis);
    for (const ruleId of expect.rules) {
      if (ruleId.endsWith('_UNUSED_OR_DRIVE')) continue;
      assert.ok(ids.has(ruleId), `${name} 应命中 ${ruleId}，实际：${[...ids].join(',')}`);
    }
  }
});

test('槽位定位：DIMM/PSU/Fan/磁盘/PCIe 都落在正确部件上', async () => {
  const dell = await analyzeFile('dell-idrac-lifecycle.log');
  const slotOf = (ruleId) => dell.findings.find((finding) => finding.ruleId === ruleId)?.slots?.[0];
  assert.equal(slotOf('MEM_UCE'), 'DIMM:A1');
  assert.equal(slotOf('MEM_CE'), 'DIMM:B1');
  assert.equal(slotOf('PSU_FAIL'), 'PSU:2');
  assert.equal(slotOf('FAN_FAIL'), 'FAN:3');
  assert.equal(slotOf('CPU_MCE'), 'CPU:1');

  const hpe = await analyzeFile('hpe-ilo-iml.log');
  const dimmFinding = hpe.findings.find((finding) => finding.ruleId === 'MEM_TRAINING_FAIL');
  assert.equal(dimmFinding.slots[0], 'DIMM:7', '「DIMM slot 7」不应被当成盘位 7');
  const pcieFinding = hpe.findings.find((finding) => finding.ruleId === 'PCIE_AER_UE');
  assert.equal(pcieFinding.slots[0], 'PCIE:3', '「PCIe Slot 3」应定位到 PCIe');

  const syslog = await analyzeFile('linux-syslog-messages.log');
  const nicFinding = syslog.findings.find((finding) => finding.ruleId === 'NIC_HW_ERROR');
  assert.equal(nicFinding.slots[0], 'NIC:eth2', '网卡故障应定位网口而不是 BDF');
  const aerFinding = syslog.findings.find((finding) => finding.ruleId === 'PCIE_AER_UE');
  assert.match(aerFinding.slots[0], /^PCIE:0000:65:00\.0$/, 'AER 应落到 BDF');
});

test('台账抽取：型号/序列号/固件版本可用', async () => {
  const dell = await analyzeFile('dell-idrac-lifecycle.log');
  assert.equal(dell.ledger.model, 'PowerEdge R750');
  assert.equal(dell.ledger.serial, 'ABCD123');
  assert.equal(dell.ledger.bmcVersion, '7.10.30.00');
  assert.equal(dell.ledger.biosVersion, '1.15.2');

  const hpe = await analyzeFile('hpe-ilo-iml.log');
  assert.equal(hpe.ledger.model, 'ProLiant DL380 Gen10');
  assert.equal(hpe.ledger.hostname, 'proxmox-01');

  const inspur = await analyzeFile('inspur-bmc-sel.log');
  assert.equal(inspur.ledger.serial, '220800A12345');
});

test('回归：iDRAC 固件版本不能被当成管理 IP', async () => {
  const dell = await analyzeFile('dell-idrac-lifecycle.log');
  assert.notEqual(dell.ledger.managementIp, '7.10.30.00');
  const withIp = parseText('iDRAC IP Address: 192.0.2.44\niDRAC Firmware Version: 7.10.30.00', { file: 'x.log' });
  assert.equal(withIp.ledger.managementIp, '192.0.2.44');
});

test('噪音过滤与覆盖率：不该把 sshd/cron 当硬件事件，也不该漏掉故障行', async () => {
  const syslog = await analyzeFile('linux-syslog-messages.log');
  assert.ok(syslog.coverage.noiseRecords >= 3, 'sshd/cron/systemd 系统噪音应被过滤');
  assert.equal(syslog.coverage.unmatchedRecords, 0, '样例里所有硬件行都应识别（未识别应为 0）');
  const raw = parseText('Aug 16 09:00:05 node01 sshd[1]: Accepted password for root\nAug 16 09:00:06 node01 kernel: EDAC MC0: 1 CE row 1 label "DIMM_A1" Correctable error', { file: 'x.log' });
  assert.equal(raw.events.length, 1, '纯系统行不进事件流');
  assert.equal(raw.events[0].ruleId, 'MEM_CE');
});

test('聚类与评分：同类告警合并、健康分与等级合理', async () => {
  const { analysis } = await analyzeTargets({ paths: [SAMPLES] });
  assert.ok(analysis.findings.length >= 20, `聚类后的告警类数应≥20，实际 ${analysis.findings.length}`);
  assert.ok(analysis.health.score < 40, `满是故障的样例集应给低分，实际 ${analysis.health.score}`);
  assert.equal(analysis.health.grade, 'D');
  assert.ok(analysis.coverage.matchedRatio > 0.7, `命中率应>0.7，实际 ${analysis.coverage.matchedRatio}`);
  assert.ok(analysis.coverage.unmatchedRecords <= 3, `未识别硬件行应≤3，实际 ${analysis.coverage.unmatchedRecords}`);
  assert.ok(analysis.byCategory.memory.events >= 5);
  assert.ok(analysis.timeline.length > 5, '应有严重级以上的时间线');
});

test('根因关联：供电/内存/散热/存储/PCIe/BMC/机房七个链条能触发', async () => {
  const { analysis } = await analyzeTargets({ paths: [SAMPLES] });
  const ids = analysis.correlations.map((item) => item.id);
  for (const expect of ['CR_POWER_CHAIN', 'CR_MEMORY_DEGRADE', 'CR_THERMAL_CHAIN', 'CR_STORAGE_CHAIN', 'CR_PCIE_CHAIN', 'CR_FLEET_POWER']) {
    assert.ok(ids.includes(expect), `应触发 ${expect}，实际：${ids.join(',')}`);
  }
  const power = analysis.correlations.find((item) => item.id === 'CR_POWER_CHAIN');
  assert.equal(power.sev, 'critical');
  assert.match(power.statement, /供电侧/);
  assert.ok(power.actions.length >= 3);
});

test('报告渲染：Markdown 章节齐全、证据带文件行号', async () => {
  const { analysis } = await analyzeTargets({ paths: [SAMPLES] });
  const md = renderMarkdown(analysis, { title: '测试报告', asset: 'node01', operator: 'ops' });
  for (const heading of ['# 测试报告 · node01', '## 0. 结论摘要', '## 1. 设备与日志台账', '## 2. 输入文件与解析覆盖', '## 3. 分级发现明细', '## 4. 按类别汇总', '## 5. 根因关联推断', '## 6. 故障时间线', '## 8. 采集缺口、未识别样本与复判建议']) {
    assert.ok(md.includes(heading), `缺少章节：${heading}`);
  }
  assert.match(md, /\.log:\d+/, '证据应带 文件:行号');
  assert.ok(md.includes('带外日志：已有'), '应说明带外日志已采集');
  const brief = renderBrief(analysis);
  assert.match(brief, /健康评分 \d/);
  assert.ok(JSON.stringify(toDigest(analysis)).length > 500, 'JSON 摘要应可序列化');
});

test('基线对比：无变化 / 新增 / 已恢复 三种情况都判得出来', async () => {
  const first = await analyzeFile('dell-idrac-lifecycle.log');
  const baseline = makeBaseline(first, { label: 'node01-ABCD123' });
  assert.equal(baseline.kind, 'dsh-server-log-analyzer/baseline');

  const same = diffBaseline(baseline, await analyzeFile('dell-idrac-lifecycle.log'));
  assert.equal(same.summary.added, 0);
  assert.equal(same.summary.increased, 0);
  assert.equal(same.summary.resolved, 0);
  assert.equal(same.health.delta, 0);
  assert.match(renderDiffMarkdown(same), /没有新增或恶化项/);

  const worse = diffBaseline(baseline, await analyzeFile('dell-idrac-sel.log'));
  assert.ok(worse.summary.added > 0 || worse.summary.increased > 0, '换一份含新故障的日志应体现新增/恶化');

  const better = diffBaseline(baseline, await analyzeFile('redfish-logservice.json'));
  assert.ok(better.summary.resolved > 0, '另一份日志里没有的告警应算已恢复');

  assert.throws(() => diffBaseline({ kind: 'wrong' }, first), /基线文件格式不对/);
});

test('采集清单：各品牌命令齐全，脚本可直接执行', () => {
  const huawei = collectPlan({ brand: 'huawei', scope: 'all' });
  const text = JSON.stringify(huawei);
  assert.match(text, /ipmcget -d sel -v list/);
  assert.match(text, /ipmcget -d health/);
  const dell = JSON.stringify(collectPlan({ brand: 'dell', scope: 'bmc' }));
  assert.match(dell, /racadm lclog view/);
  assert.match(dell, /racadm hwinventory/);
  const auto = collectPlan({ brand: 'auto', scope: 'all' });
  assert.ok(auto.sections.length >= 12, 'auto 应覆盖全部品牌 + OS 侧');
  const script = renderCollectScript({ brand: 'inspur', scope: 'all', host: '192.0.2.10' });
  assert.ok(script.startsWith('#!/bin/bash'));
  assert.match(script, /192\.0\.2\.10/);
  assert.match(script, /ipmitool -I lanplus/);
  // 生成脚本里每条命令只能有一次输出重定向（不能出现 `> a.log >> b.log` 叠加）
  for (const line of script.split('\n')) {
    const redirects = line.match(/(?:^|\s)(?:>>?)\s*"?\$/g) || [];
    assert.ok(redirects.length <= 1, `命令行重定向多于一次：${line}`);
  }
  assert.ok(!/> \w+\.log >>/.test(script), '命令自带的日志重定向应被清洗掉');
});

test('规则库：条数与类别查询', () => {
  assert.ok(RULE_STATS.total >= 55, `规则条数应≥55，实际 ${RULE_STATS.total}`);
  const digest = rulesDigest({ category: 'memory' });
  assert.ok(digest.rules.some((rule) => rule.id === 'MEM_UCE'));
  assert.ok(digest.rules.every((rule) => rule.category === 'memory'));
  const byQuery = rulesDigest({ query: 'fqxsp' });
  assert.ok(byQuery.rules.length >= 1, '按品牌事件码前缀应能搜到规则');
  const all = rulesDigest({ verbose: true });
  assert.ok(all.rules.every((rule) => rule.advice.length >= 1), '每条规则都要有处置建议');
});

test('技能落地：安装 → 幂等 → 用户改过不覆盖', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-hwlog-home-'));
  const bundled = await listBundledSkills();
  assert.equal(bundled.length, 3);
  const ids = bundled.map((item) => item.id).sort();
  assert.deepEqual(ids, ['bmc-log-collection', 'hardware-fault-playbook', 'server-hw-log-triage']);

  const first = await installSkills({ home });
  assert.equal(first.installed.length, 3);
  assert.equal(first.failed.length, 0);
  for (const id of ids) {
    const skillFile = path.join(home, 'skills', id, 'SKILL.md');
    assert.ok(existsSync(skillFile), `${skillFile} 应存在`);
    const content = await fsp.readFile(skillFile, 'utf8');
    assert.match(content, /^---\nname: /, 'SKILL.md 需要 frontmatter');
    assert.match(content, /\ndescription: /);
  }
  assert.ok(existsSync(path.join(home, 'dsh-server-log-analyzer', 'skills-manifest.json')), '应写清单文件');

  const second = await installSkills({ home });
  assert.equal(second.installed.length, 0);
  assert.equal(second.upToDate.length, 3);

  const target = path.join(home, 'skills', 'server-hw-log-triage', 'SKILL.md');
  await fsp.writeFile(target, '---\nname: server-hw-log-triage\ndescription: 用户自己改的\n---\n\n我的版本\n', 'utf8');
  const third = await installSkills({ home });
  assert.equal(third.skipped.length, 1, '用户改过的文件应保留不覆盖');
  assert.match(await fsp.readFile(target, 'utf8'), /我的版本/);

  const status = await skillsStatus({ home });
  assert.equal(status.items.length, 3);
  assert.ok(status.items.every((item) => item.installed));
  await fsp.rm(home, { recursive: true, force: true });
});

test('doctor 自检：规则/探针/品牌/样例全通过', async () => {
  const result = await doctor({ skillsDir: true, sampleDir: SAMPLES });
  const failed = result.checks.filter((check) => !check.ok);
  assert.equal(failed.length, 0, `自检失败项：${failed.map((check) => `${check.name}:${check.detail}`).join('；')}`);
  assert.ok(result.ok);
});

test('运行时适配：配置归一化与 defineTool 解析', async () => {
  assert.deepEqual(normalizeConfig(undefined), { enabled: true, installSkills: true, maxFindings: 12, reportDir: '' });
  assert.equal(normalizeConfig({ maxFindings: 999 }).maxFindings, 200);
  assert.equal(normalizeConfig({ enabled: false }).enabled, false);
  const resolved = resolveDefineTool();
  assert.equal(typeof resolved.defineTool, 'function');
  // 本机装了 dsh 时应解析到真实 defineTool；否则至少是退化实现（不能抛）
  assert.equal(typeof resolved.degraded, 'boolean');
});

test('通用输入：不认识品牌的 SEL 也能分析（品牌无关兜底）', async () => {
  const text = [
    '=== Unknown Brand BMC Event Log ===',
    '   1 | 05/01/2026 | 08:00:01 | Memory | Memory | Uncorrectable ECC error | Asserted',
    '   2 | 05/01/2026 | 08:00:03 | Fan 2 | Fan | Failure detected | Asserted',
    '   3 | 05/01/2026 | 08:00:05 | PSU 1 | Power Supply | Input power lost | Asserted',
  ].join('\n');
  const analysis = analyzeDocuments([{ file: 'unknown.log', text }], {});
  const ids = ruleIds(analysis);
  assert.ok(ids.has('MEM_UCE') && ids.has('FAN_FAIL') && ids.has('PSU_INPUT_LOST'), `兜底解析应命中关键规则，实际 ${[...ids].join(',')}`);
  const fan = analysis.findings.find((finding) => finding.ruleId === 'FAN_FAIL');
  assert.equal(fan.slots[0], 'FAN:2');
});

/* ───────── 只有带外（进不去 OS）场景 ───────── */

function findingsByRule(analysis) {
  return new Map(analysis.findings.filter((finding) => finding.ruleId).map((finding) => [finding.ruleId, finding]));
}

test('只有带外①：GBK 中文导出（浪潮 BMC）照样能定性并定位部件', async () => {
  const analysis = await analyzeFile('inspur-bmc-export-gbk.txt');
  const byRule = findingsByRule(analysis);
  assert.ok(byRule.size >= 7, `中文日志应命中≥7 类，实际 ${byRule.size}`);
  assert.equal(byRule.get('MEM_UCE').slots[0], 'DIMM:C1', '中文行也要能定位到内存槽位');
  assert.equal(byRule.get('MEM_CE').slots[0], 'DIMM:D1');
  assert.equal(byRule.get('PSU_FAIL').slots[0], 'PSU:1');
  assert.equal(byRule.get('FAN_FAIL').slots[0], 'FAN:3');
  assert.ok(byRule.has('PSU_REDUNDANCY_LOST') && byRule.has('PSU_INPUT_LOST') && byRule.has('DRIVE_FAIL'));
  assert.equal(analysis.coverage.unmatchedRecords, 0, '中文日志不应留下未识别硬件行');
});

test('只有带外②：BMC 网页 HTML 导出 → 清洗成 SEL 形态可直接分析', async () => {
  const analysis = await analyzeFile('hpe-iml-export.html');
  const byRule = findingsByRule(analysis);
  assert.equal(analysis.files[0].formatKey, 'ipmi-sel', 'HTML 表格应被识别成 SEL 形态');
  assert.equal(byRule.get('PCIE_AER_UE').slots[0], 'PCIE:3');
  assert.equal(byRule.get('PCIE_AER_UE').sev, 'critical', 'HTML 导出里的 "Uncorrected (Fatal)" 应按不可纠正错误定级');
  assert.equal(byRule.get('FAN_FAIL').slots[0], 'FAN:4');
  assert.equal(byRule.get('PSU_FAIL').slots[0], 'PSU:2');
  assert.ok(byRule.has('MEM_UCE') && byRule.has('DRIVE_FAIL') && byRule.has('PSU_INPUT_LOST'));
  assert.equal(analysis.coverage.unmatchedRecords, 0);
});

test('只有带外③：二进制 SEL（.bin）8 条记录全部解码并定性', async () => {
  const read = await readDocuments([path.join(SAMPLES, 'generic-sel.bin')]);
  assert.equal(read.documents.length, 1);
  assert.match(read.documents[0].note, /二进制 SEL 已解码（8 条记录）/);
  const analysis = analyzeDocuments(read.documents, { notes: read.notes });
  assert.equal(analysis.coverage.records, 8);
  assert.equal(analysis.coverage.unmatchedRecords, 0);
  const ids = ruleIds(analysis);
  for (const id of ['MEM_UCE', 'MEM_CE', 'PSU_INPUT_LOST', 'DRIVE_FAIL', 'THERMAL_TEMP_HIGH', 'BMC_WATCHDOG']) {
    assert.ok(ids.has(id), `二进制 SEL 应命中 ${id}，实际 ${[...ids].join(',')}`);
  }
});

test('只有带外④：一键收集包（zip）自动展开，归档内 GBK 文本与 .bin 都能吃', async () => {
  const read = await readDocuments([path.join(SAMPLES, 'ibmc-onekey-collect.zip')]);
  assert.ok(read.documents.length >= 6, `归档应展开出多条文档，实际 ${read.documents.length}`);
  assert.ok(read.documents.some((document) => document.file.includes('ibmc/Sel.txt')), '应包含归档内的 SEL 文本');
  assert.ok(read.documents.some((document) => document.file.includes('sel.bin') && /二进制 SEL/.test(document.note || '')), '归档内的二进制 SEL 应被解码');
  assert.ok(read.notes.some((note) => note.includes('归档已展开')));
  const analysis = analyzeDocuments(read.documents, { notes: read.notes });
  const ids = ruleIds(analysis);
  for (const id of ['MEM_UCE', 'PSU_FAIL', 'FAN_FAIL', 'PSU_INPUT_LOST']) {
    assert.ok(ids.has(id), `收集包应命中 ${id}，实际 ${[...ids].join(',')}`);
  }
  assert.equal(analysis.coverage.unmatchedRecords, 0);
});

test('纯带外场景：报告标出"业务影响需另证"（CR_BMC_ONLY），有 OS 日志时不报', async () => {
  const { analysis } = await analyzeTargets({ paths: [path.join(SAMPLES, 'generic-sel.bin')] });
  const correlation = analysis.correlations.find((item) => item.id === 'CR_BMC_ONLY');
  assert.ok(correlation, `应触发 CR_BMC_ONLY，实际 ${analysis.correlations.map((item) => item.id).join(',')}`);
  assert.ok(correlation.actions.length >= 4, '要给出替代证据与采集建议');
  const md = renderMarkdown(analysis);
  assert.match(md, /纯带外场景/);
  assert.match(md, /读取与解码说明/);

  const withOs = await analyzeTargets({ paths: [path.join(SAMPLES, 'generic-sel.bin'), path.join(SAMPLES, 'linux-syslog-messages.log')] });
  assert.ok(!withOs.analysis.correlations.some((item) => item.id === 'CR_BMC_ONLY'), '有 OS 日志时不应报"仅带外"');
});

test('Excel 导出：给出"另存为 CSV"的明确提示，而不是静默跳过', async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-hwlog-xlsx-'));
  const xlsx = path.join(tmp, 'bmc-event-log.xlsx');
  await fsp.writeFile(xlsx, Buffer.from(`504b0304${'00'.repeat(40)}`, 'hex'));
  const { documents, skipped } = await readDocuments([tmp]);
  assert.equal(documents.length, 0);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /另存为 CSV/);
  await fsp.rm(tmp, { recursive: true, force: true });
});

/* ───────── 厂商手册当码表（不用手写代码，导入即可扩展覆盖率） ───────── */

test('厂商手册码表：CSV/JSON 导入、命中"内置规则不认识"的码、同码可被手册覆盖', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-hwlog-codes-'));
  const previousHome = process.env.DSH_HOME;
  try {
    // ① 手册导出的表格（CSV）→ 码表：一条"内置没有"的码 + 一条"覆盖内置语义"的码
    const csv = [
      'code,meaning,severity,rule,category,action',
      'XCC7777,Manual-only unknown board event,critical,,board,按手册描述处置并留证',
      'PWR1000,手册版本：输入电压越界（覆盖内置语义与分类）,critical,,memory,按手册处理',
    ].join('\n');
    const table = parseCodeTableText(csv, { brand: 'dell', source: 'Dell Event Reference (test)', version: '2026-01' });
    assert.equal(Object.keys(table.codes).length, 2, 'CSV 两行都要解析出来');
    const written = writeCodeTable(table, { home });
    assert.ok(existsSync(written.file), '码表应落盘到用户目录');
    assert.equal(written.count, 2);

    // JSON 形态也要认（手册网页导出的 JSON 可以直接喂）
    const jsonTable = parseCodeTableText(JSON.stringify({
      brand: 'huawei',
      source: 'iBMC 告警处理手册（test）',
      version: 'V3.68',
      codes: { '0x2F': { rule: 'MEM_UCE', severity: 'critical', meaning: '内存 UCE（手册）' } },
    }));
    assert.equal(jsonTable.brand, 'huawei');
    assert.ok(jsonTable.codes['0x2F']);

    // ② 让解析层加载用户码表（真实使用中由插件启动/CLI 自动加载）
    process.env.DSH_HOME = home;
    const parseModule = await import('../lib/engine/parse.js');
    parseModule.reloadCodeTables();

    const analysis = analyzeDocuments([{
      file: 'manual-only.log',
      text: '2026-08-16 09:00:05 [Critical] [XCC7777] Manual-only unknown board event on motherboard',
    }], {});
    assert.equal(analysis.coverage.unmatchedRecords, 0, '手册码表命中的行不应算"未识别"');
    const finding = analysis.findings.find((item) => item.external);
    assert.ok(finding, '应产出带 external 语义来源的发现');
    assert.equal(finding.external.code, 'XCC7777');
    assert.match(finding.title, /手册码表/);
    assert.equal(finding.sev, 'critical');
    const md = renderMarkdown(analysis);
    assert.match(md, /语义来源：Dell Event Reference \(test\)/);
    assert.match(md, /（手册建议）按手册描述处置并留证/);

    // ③ 同码覆盖：PWR1000 内置映射到电源类，手册把它判成内存类 → 以手册为准
    const overridden = analyzeDocuments([{
      file: 'override.log',
      text: '2026-08-16 09:00:05 [Critical] [PWR1000] manual override case',
    }], {});
    const hit = overridden.findings.find((item) => item.external);
    assert.ok(hit, '同码应命中外部码表');
    assert.equal(hit.external.source, 'Dell Event Reference (test)');
    assert.equal(hit.categoryLabel, '内存', '分类应以手册为准（覆盖内置推断）');
  } finally {
    process.env.DSH_HOME = previousHome;
    const parseModule = await import('../lib/engine/parse.js');
    parseModule.reloadCodeTables();
    await fsp.rm(home, { recursive: true, force: true });
  }
});

test('华为 TaiShan ALM 告警码：手册码表命中（含 8 位 hex 与大小写不一致）', async () => {
  const analysis = await analyzeFile('huawei-taishan-alm.log');
  assert.equal(analysis.files[0].vendorKey, 'huawei');
  assert.equal(analysis.coverage.unmatchedRecords, 0, 'ALM 码应被手册码表接住');
  const withExternal = analysis.findings.filter((finding) => finding.external);
  assert.ok(withExternal.length >= 3, `应有多个码表命中的发现，实际 ${withExternal.length}`);
  const codes = withExternal.map((finding) => finding.external.code.toUpperCase());
  assert.ok(codes.includes('0X080000C1') || codes.includes('0x080000C1'.toUpperCase()));
  assert.ok(withExternal.every((finding) => /TaiShan 机架服务器 iBMC 告警处理/.test(finding.external.source)), '要标出手册来源');
  assert.ok(withExternal.every((finding) => finding.sev === 'critical' || finding.sev === 'minor'));
  // 不同告警码不能被合并成一条（按码聚类）
  const pcieCodes = new Set(withExternal.filter((finding) => finding.categoryLabel === 'PCIe/插槽').map((finding) => finding.external.code));
  assert.ok(pcieCodes.size >= 2, '不同 ALM 码应各自成条，不能按内部规则合并');
  assert.match(renderMarkdown(analysis), /语义来源：TaiShan 机架服务器 iBMC 告警处理/);
});

test('RAID 卡特有状态：保留缓存 / 外部配置 / 巡检能区分（依据华为 RAID 控制卡用户指南）', () => {
  const digest = rulesDigest({ query: 'preserved' });
  assert.ok(digest.rules.some((rule) => rule.id === 'RAID_PRESERVED_CACHE'), '应有保留缓存规则');
  const analysis = analyzeDocuments([{
    file: 'storcli.log',
    text: [
      'CLI Version = 007.3103.0000.0000',
      'Controller = 0',
      'VD0 Properties : State = Degraded',
      'Preserved Cache : Yes ( VD 0 )',
      'PD 8:4 : State = Unconfigured Good ( Foreign Configuration present )',
      'Patrol Read : In progress',
      'Media Error Count = 12',
    ].join('\n'),
  }], {});
  const ids = ruleIds(analysis);
  for (const id of ['RAID_PRESERVED_CACHE', 'RAID_FOREIGN_CONFIG', 'RAID_DEGRADED', 'RAID_PATROL_READ']) {
    assert.ok(ids.has(id), `应命中 ${id}，实际 ${[...ids].join(',')}`);
  }
  const preserved = analysis.findings.find((finding) => finding.ruleId === 'RAID_PRESERVED_CACHE');
  assert.ok(preserved.advice.some((item) => /清除保留缓存/.test(item)), '保留缓存必须带"清前留证/可能删组"的告警');
});

test('运维操作库：命令 / 界面路径 / 处理步骤可检索，并能挂到分析结果上', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-hwlog-ops-'));
  try {
    writeOpsTable({
      brand: 'huawei',
      product: 'RAID 控制卡（测试夹具）',
      source: '华为 RAID 控制卡用户指南（测试夹具）',
      version: '35-test',
      entries: [
        {
          id: 'cmd-raid-events',
          kind: 'command',
          title: '查看 RAID 卡控制器事件日志',
          category: 'raid',
          symptoms: ['RAID 降级', '硬盘掉盘'],
          commands: ['storcli64 /c0 show events'],
          steps: [],
          notes: '章节 4 LSI SAS2208',
        },
        {
          id: 'ui-bmc-log',
          kind: 'ui',
          title: '导出 BMC 系统事件日志',
          category: 'firmware',
          symptoms: ['需要导出带外日志'],
          commands: [],
          steps: ['日志和告警 > 系统事件日志 > 导出'],
          notes: '浪潮 BMC 用户手册 V2.7',
        },
        {
          id: 'step-psu',
          kind: 'step',
          title: '电源模块故障处理步骤',
          category: 'power',
          symptoms: ['电源模块故障'],
          commands: [],
          steps: ['确认 PSU 槽位与指示灯', '导出 SEL 留证', '更换电源模块并确认冗余恢复'],
          notes: 'iBMC 告警处理',
        },
      ],
    }, { home });

    const library = loadOpsLibrary({ home, force: true });
    assert.ok(library.total >= 3, `夹具 + 自带模板应至少 3 条，实际 ${library.total}`);

    const byQuery = searchOps(library, { query: 'RAID 事件日志' });
    assert.ok(byQuery.some((entry) => entry.id === 'cmd-raid-events'), '按关键词应能检索到命令条目');
    assert.ok(byQuery[0].commands[0].includes('storcli64'));

    const byKind = searchOps(library, { kind: 'ui' });
    assert.ok(byKind.length >= 1, `应至少命中 1 条界面路径（含自带基线），实际 ${byKind.length}`);
    assert.ok(byKind.some((entry) => /日志和告警/.test(entry.steps[0] || '')), '夹具的界面路径应可检索');

    const byCategory = searchOps(library, { category: 'power' });
    assert.ok(byCategory.length >= 1);

    const related = relatedOps(library, { title: 'RAID 阵列降级', category: 'raid', limit: 2 });
    assert.ok(related.length >= 1, '应按标题/类别给出相关操作');
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
    const parseModule = await import('../lib/engine/parse.js');
    parseModule.reloadCodeTables();
  }
});

test('码表状态：自带模板与用户导入都能被列出（doctor 依赖它）', () => {
  const status = codeTableStatus();
  assert.ok(status.total > 0, '自带模板码表应可加载');
  assert.ok(status.bundledDir.includes('data'), '自带模板目录应在包内 data/ 下');
  assert.ok(status.sources.some((item) => item.origin === 'bundled' && item.count > 0));
  assert.ok(status.brands.length >= 1);
});

/* ───────── 浪潮 BMC 独有：IDL 故障诊断日志 ───────── */

test('浪潮 IDL：手册结构驱动解析 + 8 字节事件码解码 + Deassert 视为故障解除', async () => {
  const analysis = await analyzeFile('inspur-idl-log.log');
  assert.equal(analysis.files[0].formatKey, 'inspur-idl', 'IDL 日志格式应被识别');
  assert.equal(analysis.files[0].vendorKey, 'inspur');

  const ids = ruleIds(analysis);
  for (const id of ['MEM_UCE', 'PSU_FAIL', 'FAN_FAIL', 'DRIVE_FAIL', 'PCIE_AER_CE']) {
    assert.ok(ids.has(id), `IDL 日志应命中 ${id}，实际 ${[...ids].join(',')}`);
  }

  // 事件码解码（手册表 3-3：级别 / 事件偏移 / 部件序号 / 部件类型）
  const decoded = parseIdlCode('0200010000010C01');
  assert.equal(decoded.form, '8-byte');
  assert.equal(decoded.level, 'CRITICAL');
  assert.equal(decoded.componentName, 'MEMORY');
  assert.equal(decoded.componentLabel, '内存');
  assert.equal(decoded.eventOffset, 1);
  assert.equal(decoded.eventOffsetText, 'Uncorrectable ECC error', '部件类型与 IPMI sensor type 一致，可直接复用偏移语义');
  assert.ok([decoded.componentIndex, decoded.componentIndexAlt].includes(1), '部件序号（字节序未定义，两种读法都给出）');
  assert.equal(parseIdlCode('17000701').form, '4-byte-shorthand', '手册示例的简写形态不臆测解码');
  assert.equal(parseIdlCode('not-a-code'), null);

  // IDL 信息进入发现，报告可见
  const mem = analysis.findings.find((finding) => finding.ruleId === 'MEM_UCE');
  assert.ok(mem.idl, '发现应带 IDL 结构化信息');
  assert.equal(mem.idl.componentLabel, '内存');
  assert.equal(mem.idl.code, '0200010000010C01');
  assert.match(mem.idl.codeNote, /Uncorrectable ECC/);
  assert.match(renderMarkdown(analysis), /浪潮 IDL：部件：/);

  // Deassert = 故障解除 → 降到 info 且标题标注
  const reset = analysis.findings.filter((finding) => finding.idl && finding.idl.assertion === 'Deassert');
  assert.ok(reset.length >= 1, '应识别出 Deassert 行');
  assert.ok(reset.every((finding) => finding.sev === 'info'), 'Deassert 不应算故障');
  assert.ok(reset.some((finding) => /故障解除|已恢复/.test(finding.title)), 'Deassert 的标题要标出已恢复');

  // 温度读数/阈值被抽出来
  const thermal = analysis.findings.find((finding) => finding.idl && finding.idl.reading);
  assert.ok(thermal, '应抽取温度读数与阈值');
  assert.ok(thermal.idl.reading.threshold > 0);
});
