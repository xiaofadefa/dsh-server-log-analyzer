#!/usr/bin/env node
/**
 * dsh-hwlog —— 服务器日志硬件分析的命令行入口（不依赖 dsh 也能用）。
 *
 * 用法：
 *   dsh-hwlog analyze <日志文件/目录...> [--out 报告.md|报告.json] [--brief] [--json] [--vendor dell]
 *   dsh-hwlog collect [--brand auto] [--scope all] [--transport ipmi] [--host BMC_IP] [--script]
 *   dsh-hwlog baseline <日志...> --out baseline.json [--label 主机名-SN]
 *   dsh-hwlog diff <baseline.json> <日志...> [--json]
 *   dsh-hwlog rules [--category memory] [--query uce] [--verbose]
 *   dsh-hwlog report <日志...> [--out 报告.md] [--title 标题] [--asset 设备] [--operator 姓名]
 *   dsh-hwlog doctor [--no-samples]
 *   dsh-hwlog samples            # 用自带样例跑一遍演示
 *   dsh-hwlog skills install|status
 */

import { parseArgs } from 'node:util';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
  analyzeTargets, renderMarkdown, renderBrief, toDigest, rulesDigest, doctor,
  makeBaseline, diffBaseline, renderDiffMarkdown, collectPlan, renderCollectScript,
  readJsonFile, writeTextFile, BRAND_CHOICES,
  parseCodeTableText, writeCodeTable, codeTableStatus,
  loadOpsLibrary, searchOps, writeOpsTable, opsStatus, OPS_KINDS,
} from '../lib/engine/index.js';
import { promises as fsp } from 'node:fs';
import { installSkills, skillsStatus, listBundledSkills } from '../lib/skills-install.js';
import { dshHome, normalizeConfig } from '../lib/runtime.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '..');

const USAGE = `dsh-hwlog —— 服务器带外/系统日志硬件分析

用法:
  dsh-hwlog analyze <日志文件|目录...> [选项]      分析日志并给出硬件体检结论
  dsh-hwlog collect [选项]                        生成各品牌日志采集清单/脚本
  dsh-hwlog baseline <日志...> --out <文件>        存基线快照
  dsh-hwlog diff <基线.json> <日志...>             与基线对比（新增/恶化/已恢复）
  dsh-hwlog rules [选项]                          查规则库
  dsh-hwlog codes list|import|path                厂商手册码表（导入后不改代码即可扩展覆盖率）
  dsh-hwlog ops search|list|import|path           运维操作库（命令 / 界面路径 / 处理步骤）
  dsh-hwlog report <日志...> [选项]                生成报告文件
  dsh-hwlog doctor                                自检插件状态
  dsh-hwlog samples                               用自带样例演示
  dsh-hwlog skills install|status                 技能落地到 $DSH_HOME/skills / 查看状态

常用选项:
  --paths <a,b>        路径也可用逗号分隔写在 --paths 里
  --text <日志文本>    直接粘贴日志（与路径二选一）
  --vendor <品牌>      ${BRAND_CHOICES.join('|')}
  --format <类型>      ipmi-sel|idrac-lifecycle|ilo-iml|redfish-json|syslog|dmesg|storage-cli|bmc-text|plain
  --out <文件>         报告/基线输出路径
  --brief              只输出几行摘要
  --json               输出 JSON（摘要/差异）
  --max-findings <n>   最多列多少类发现（默认 12；报告默认 200）
  --include-noise      连非硬件系统噪音一起统计

示例:
  dsh-hwlog analyze ./logs/dell-sel.log ./logs/os-messages.log
  dsh-hwlog analyze ./logs --out report.md --asset node01-SN123
  dsh-hwlog baseline ./logs --out baseline-node01.json --label node01-ABCD123
  dsh-hwlog diff baseline-node01.json ./logs-new
  dsh-hwlog collect --brand huawei --scope all --script > collect.sh
`;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function parse(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      paths: { type: 'string' },
      text: { type: 'string' },
      vendor: { type: 'string' },
      format: { type: 'string' },
      out: { type: 'string' },
      title: { type: 'string' },
      asset: { type: 'string' },
      operator: { type: 'string' },
      label: { type: 'string' },
      brand: { type: 'string' },
      scope: { type: 'string' },
      transport: { type: 'string' },
      host: { type: 'string' },
      category: { type: 'string' },
      query: { type: 'string' },
      file: { type: 'string' },
      source: { type: 'string' },
      version: { type: 'string' },
      kind: { type: 'string' },
      limit: { type: 'string' },
      'max-findings': { type: 'string' },
      brief: { type: 'boolean' },
      json: { type: 'boolean' },
      script: { type: 'boolean' },
      verbose: { type: 'boolean' },
      noise: { type: 'boolean' },
      'include-noise': { type: 'boolean' },
      samples: { type: 'boolean' },
      'no-samples': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  return { values, positionals };
}

function targetPaths(values, positionals, skipFirst = false) {
  const list = [];
  if (values.paths) list.push(...String(values.paths).split(',').map((item) => item.trim()).filter(Boolean));
  const rest = skipFirst ? positionals.slice(1) : positionals;
  list.push(...rest);
  return list;
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'help';
  const { values, positionals } = parse(command === 'help' ? [] : argv.slice(1));

  if (command === 'help' || values.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const config = normalizeConfig({ reportDir: process.env.DSH_HWLOG_REPORT_DIR || '' });
  const reportDir = config.reportDir || join(process.cwd(), 'server-hw-reports');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  switch (command) {
    case 'analyze': {
      const paths = targetPaths(values, positionals);
      const { analysis, skipped, notes } = await analyzeTargets({
        paths,
        text: values.text,
        vendor: values.vendor || 'auto',
        format: values.format || 'auto',
        maxFindings: values['max-findings'] ? Number(values['max-findings']) : 12,
        includeNoise: Boolean(values.noise || values['include-noise']),
      });
      let body;
      if (values.json) {
        body = JSON.stringify({ ...toDigest(analysis), read_notes: notes || [], skipped_inputs: skipped }, null, 2);
      } else if (values.brief) {
        body = `${renderBrief(analysis)}\n`;
      } else {
        body = renderMarkdown(analysis, { asset: values.asset || '' });
      }
      if (!values.json) {
        if (notes && notes.length) {
          body += `\n> 读取/解码说明：\n${notes.map((note) => `> - ${note}`).join('\n')}\n`;
        }
        if (skipped.length) {
          body += `\n> 跳过输入：\n${skipped.map((item) => `> - ${item.path}（${item.reason}）`).join('\n')}\n`;
        }
      }
      if (values.out) {
        const written = await writeTextFile(values.out, body);
        process.stdout.write(`已写入 ${written}\n${renderBrief(analysis)}\n`);
      } else {
        process.stdout.write(`${body}\n`);
      }
      return 0;
    }

    case 'collect': {
      const options = {
        brand: values.brand || 'auto',
        scope: values.scope || 'all',
        transport: values.transport || 'ipmi',
        host: values.host || 'BMC_IP',
      };
      if (values.script) {
        process.stdout.write(`${renderCollectScript(options)}\n`);
        return 0;
      }
      const plan = collectPlan(options);
      process.stdout.write(`# 采集清单 · ${plan.label}（通道：${plan.transport}）\n\n`);
      for (const section of plan.sections) {
        process.stdout.write(`## ${section.title}\n`);
        if (section.note) process.stdout.write(`> ${section.note}\n`);
        for (const item of section.items) process.stdout.write(`- \`${item.cmd}\`\n  - ${item.note}\n`);
        process.stdout.write('\n');
      }
      return 0;
    }

    case 'baseline': {
      const paths = targetPaths(values, positionals);
      const { analysis } = await analyzeTargets({ paths, text: values.text, maxFindings: 200 });
      const baseline = makeBaseline(analysis, { label: values.label });
      const out = values.out || join(reportDir, `baseline-${stamp}.json`);
      const written = await writeTextFile(out, JSON.stringify(baseline, null, 2));
      process.stdout.write(`基线已保存：${written}\n评分 ${baseline.health.score}（${baseline.health.label}），告警类数 ${baseline.findings.length}\n`);
      return 0;
    }

    case 'diff': {
      const baselinePath = values.baseline || positionals[0];
      if (!baselinePath) fail('diff 需要基线文件：dsh-hwlog diff <baseline.json> <日志...>');
      const raw = String(baselinePath).trim();
      const baseline = raw.startsWith('{') ? JSON.parse(raw) : await readJsonFile(raw);
      const paths = targetPaths(values, positionals, true);
      const { analysis } = await analyzeTargets({ paths, text: values.text, maxFindings: 200 });
      const diff = diffBaseline(baseline, analysis);
      if (values.json) process.stdout.write(`${JSON.stringify(diff, null, 2)}\n`);
      else if (values.out) {
        const written = await writeTextFile(values.out, renderDiffMarkdown(diff, { asset: values.asset || '' }));
        process.stdout.write(`已写入 ${written}\n新增 ${diff.summary.added}｜恶化 ${diff.summary.increased}｜缓解 ${diff.summary.decreased}｜已恢复 ${diff.summary.resolved}\n`);
      } else process.stdout.write(`${renderDiffMarkdown(diff, { asset: values.asset || '' })}\n`);
      return 0;
    }

    case 'codes': {
      const action = positionals[0] || 'list';
      if (action === 'path') {
        const status = codeTableStatus();
        process.stdout.write(`自带码表模板：${status.bundledDir}\n手工册导入目录：${status.userDir}\n（用户目录优先，同码覆盖自带模板）\n`);
        return 0;
      }
      if (action === 'import') {
        const file = positionals[1] || values.file;
        if (!file) fail('codes import 需要一个码表文件：dsh-hwlog codes import <csv|json> --brand dell [--source "Dell Event Reference 2026"] [--version 2026-01]');
        const text = await fsp.readFile(String(file), 'utf8');
        const parsed = parseCodeTableText(text, {
          brand: values.brand,
          source: values.source,
          version: values.version,
        });
        const tables = Array.isArray(parsed) ? parsed : [parsed];
        for (const table of tables) {
          const written = writeCodeTable(table);
          process.stdout.write(`已导入 ${table.brand}：${written.count} 条码映射 → ${written.file}\n来源标注：${table.source}${table.version ? `（${table.version}）` : ''}\n`);
        }
        process.stdout.write('提示：分析时自动加载；同码覆盖自带模板。码表只补"码→语义"，日志句法/跨源关联仍由规则库负责。\n');
        return 0;
      }
      const status = codeTableStatus();
      process.stdout.write(`码表总计 ${status.total} 条｜覆盖品牌：${status.brands.join('、') || '无'}\n`);
      process.stdout.write(`自带模板：${status.bundledDir}\n导入目录：${status.userDir}\n`);
      for (const table of status.sources) {
        process.stdout.write(`- [${table.origin}] ${table.brand}｜${table.count} 条｜${table.source}${table.version ? `（${table.version}）` : ''}${table.error ? `｜⚠ ${table.error}` : ''}\n    ${table.file}\n`);
      }
      return 0;
    }

    case 'ops': {
      const action = positionals[0] || 'search';
      if (action === 'path') {
        const status = opsStatus();
        process.stdout.write(`运维操作库 ${status.total} 条（命令 ${status.byKind.command || 0} / 界面路径 ${status.byKind.ui || 0} / 步骤 ${status.byKind.step || 0}）\n自带模板：${status.bundledDir}\n导入目录：${status.userDir}\n`);
        return 0;
      }
      if (action === 'import') {
        const file = positionals[1] || values.file;
        if (!file) fail('用法：dsh-hwlog ops import <extract-vendor-ops.py 输出的 JSON>');
        const parsed = await readJsonFile(String(file));
        for (const table of (Array.isArray(parsed) ? parsed : [parsed])) {
          const written = writeOpsTable(table);
          process.stdout.write(`已导入 ${written.count} 条 → ${written.file}\n`);
        }
        return 0;
      }
      const library = loadOpsLibrary();
      if (action === 'list') {
        const rows = searchOps(library, { brand: values.brand, category: values.category, kind: values.kind, limit: Number(values.limit || 40) });
        process.stdout.write(`共 ${rows.length} 条：\n`);
        for (const entry of rows) process.stdout.write(`- 【${OPS_KINDS[entry.kind]}】[${entry.category}] ${entry.title}　（${entry.source}）\n`);
        return 0;
      }
      const query = positionals.slice(1).join(' ') || values.query || '';
      const rows = searchOps(library, { query, brand: values.brand, category: values.category, kind: values.kind, limit: Number(values.limit || 8) });
      if (!rows.length) {
        process.stdout.write(`没有匹配「${query}」的条目。用 dsh-hwlog ops list 看全部，dsh-hwlog ops path 确认库状态。\n`);
        return 0;
      }
      for (const entry of rows) {
        process.stdout.write(`### 【${OPS_KINDS[entry.kind]}】${entry.title}　·　${entry.category}\n`);
        process.stdout.write(`来源：${entry.source}${entry.version ? `（${entry.version}）` : ''}\n`);
        for (const command of entry.commands || []) process.stdout.write(`  命令：${command}\n`);
        for (const step of entry.steps || []) process.stdout.write(`  步骤：${step}\n`);
        if (entry.notes) process.stdout.write(`  备注：${entry.notes}\n`);
        process.stdout.write('\n');
      }
      return 0;
    }

    case 'rules': {
      const digest = rulesDigest({ category: values.category || 'all', query: values.query, verbose: Boolean(values.verbose) });
      process.stdout.write(`规则库：${digest.total} 条，匹配 ${digest.matched} 条\n`);
      for (const rule of digest.rules) {
        process.stdout.write(`- ${rule.id} [${rule.categoryLabel}/${rule.severity}] ${rule.title}\n`);
        if (rule.vendorCodes) {
          process.stdout.write(`    事件码：${Object.entries(rule.vendorCodes).map(([brand, codes]) => `${brand}:${[].concat(codes).join('/')}`).join('  ')}\n`);
        }
        if (values.verbose) for (const advice of rule.advice || []) process.stdout.write(`    · ${advice}\n`);
      }
      return 0;
    }

    case 'report': {
      const paths = targetPaths(values, positionals);
      const { analysis, skipped } = await analyzeTargets({ paths, text: values.text, maxFindings: 200 });
      const isJson = String(values.out || '').toLowerCase().endsWith('.json');
      const out = values.out || join(reportDir, `server-hw-report-${stamp}.${isJson ? 'json' : 'md'}`);
      const body = isJson
        ? JSON.stringify(toDigest(analysis), null, 2)
        : renderMarkdown(analysis, { title: values.title, asset: values.asset, operator: values.operator });
      const written = await writeTextFile(out, skipped.length ? `${body}\n\n> 跳过输入：${skipped.map((item) => `${item.path}（${item.reason}）`).join('；')}\n` : body);
      process.stdout.write(`报告已生成：${written}\n${renderBrief(analysis)}\n`);
      return 0;
    }

    case 'doctor': {
      const sampleDir = values['no-samples'] ? undefined : join(PACKAGE_ROOT, 'samples');
      const result = await doctor({ skillsDir: true, sampleDir });
      const skills = await skillsStatus({ home: dshHome() });
      const bundled = await listBundledSkills();
      process.stdout.write(`# dsh-server-log-analyzer 自检：${result.ok ? '通过 ✅' : '有问题 ❌'}\n\n`);
      process.stdout.write(`$DSH_HOME=${dshHome()}\n技能目录=${skills.skillsRoot}\n内置技能=${bundled.map((item) => item.id).join('、')}\n\n`);
      for (const check of result.checks) process.stdout.write(`- ${check.ok ? '✅' : '❌'} ${check.name}：${check.detail}\n`);
      process.stdout.write('\n技能落地状态：\n');
      for (const item of skills.items) {
        process.stdout.write(`- ${item.installed ? '✅' : '❌'} ${item.id} → ${item.path || '未安装'}${item.userModified ? '（用户已修改，不覆盖）' : ''}\n`);
      }
      return result.ok ? 0 : 1;
    }

    case 'samples': {
      const { analysis } = await analyzeTargets({ paths: [join(PACKAGE_ROOT, 'samples')], maxFindings: 200 });
      process.stdout.write(`${renderMarkdown(analysis, { title: '自带样例演示报告', asset: 'samples/（DELL/HPE/Lenovo/浪潮/华为/超微/Linux/Redfish）' })}\n`);
      return 0;
    }

    case 'skills': {
      const action = positionals[0] || 'status';
      if (action === 'install') {
        const report = await installSkills({ home: dshHome(), force: Boolean(values.force) });
        process.stdout.write(`技能目录：${report.root}\n新增：${report.installed.join('、') || '无'}\n更新：${report.updated.join('、') || '无'}\n已最新：${report.upToDate.join('、') || '无'}\n`);
        if (report.skipped.length) process.stdout.write(`用户已修改、保留：${report.skipped.map((item) => item.file).join('、')}\n`);
        if (report.failed.length) process.stdout.write(`失败：${report.failed.map((item) => `${item.file}(${item.error})`).join('、')}\n`);
        return report.failed.length ? 1 : 0;
      }
      const status = await skillsStatus({ home: dshHome() });
      process.stdout.write(`技能目录：${status.skillsRoot}\n清单：${status.manifest}\n`);
      for (const item of status.items) {
        process.stdout.write(`- ${item.id}：${item.installed ? (item.synced ? '已同步' : '内容已落后') : '未安装'}${item.userModified ? '（用户已修改）' : ''}\n  ${item.description}\n`);
      }
      return 0;
    }

    default:
      fail(`未知命令：${command}\n\n${USAGE}`);
  }
  return 0;
}

main().then((code) => {
  process.exitCode = code || 0;
}).catch((error) => {
  process.stderr.write(`执行失败：${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
});
