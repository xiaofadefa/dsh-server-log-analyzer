/**
 * dsh-server-log-analyzer —— dsh 插件入口（cordis 插件）。
 *
 * 作用：给 dsh 会话挂上一套"服务器带外/系统日志硬件初判"工具面，并把三个运维技能
 * 落地到 $DSH_HOME/skills（技能随技能目录热发现，无需重启；工具面需要 dsh 重启后注册）。
 *
 * 工具面：
 *   hwlog_analyze   分析日志（文件/目录/粘贴文本）→ 硬件体检结论
 *   hwlog_collect   生成各品牌带外日志/硬件快照的采集清单或脚本
 *   hwlog_baseline  存基线快照（供下次对比）
 *   hwlog_diff      基线与本次对比（新增/恶化/缓解/已恢复）
 *   hwlog_rules     查规则库（能识别哪些故障、覆盖哪些品牌事件码）
 *   hwlog_report    把分析结论写成报告文件（Markdown / JSON）
 *   hwlog_doctor    自检（规则库、探针解析、品牌识别、技能落地状态）
 */

import { join } from 'node:path';
import {
  analyzeTargets, rulesDigest, doctor,
  analyzeDocuments, renderMarkdown, renderBrief, toDigest,
  makeBaseline, diffBaseline, renderDiffMarkdown,
  collectPlan, renderCollectScript, BRAND_CHOICES, CATEGORY_LABELS,
  readJsonFile, writeTextFile, documentsFromText,
  loadOpsLibrary, searchOps, writeOpsTable, opsStatus, OPS_KINDS,
} from './engine/index.js';
import { normalizeConfig, resolveDefineTool, text, withStructuredErrors, dshHome, packageDirOf } from './runtime.js';
import { installSkills, skillsStatus, listBundledSkills } from './skills-install.js';

export const name = 'dsh-server-log-analyzer';
export const inject = ['tools'];

const CATEGORY_CHOICES = ['all', ...Object.keys(CATEGORY_LABELS)];

/** 报告默认落盘目录：配置优先，其次工作目录下的 server-hw-reports/。 */
function resolveReportDir(config) {
  if (config && config.reportDir) return config.reportDir;
  return join(process.cwd(), 'server-hw-reports');
}

const OUTPUT_PARAM = {
  type: 'string',
  enum: ['markdown', 'brief', 'json'],
  description: '输出形态：markdown=完整报告（默认）；brief=几行摘要（省上下文）；json=结构化摘要（便于入库/二次处理）',
};

const PATHS_PARAM = {
  type: 'array',
  items: { type: 'string' },
  description: '日志文件或目录路径（可多个）。支持 SEL 导出、iDRAC 生命周期日志、iLO IML、iBMC/浪潮文本 SEL、XCC 事件日志、Redfish JSON、Linux syslog/dmesg/journal、smartctl/storcli 输出；目录会浅层递归收集（最多 80 个文件，跳过二进制/压缩包）。',
};

const VENDOR_PARAM = {
  type: 'string',
  enum: BRAND_CHOICES,
  description: '品牌（默认 auto 自动识别）。识别不准时手动指定：dell/hpe/lenovo/inspur/huawei/supermicro/sugon/zte/h3c/fujitsu/generic',
};

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  if (!config.enabled) {
    ctx.logger?.info?.('[dsh-server-log-analyzer] disabled by config, skip registration');
    return;
  }

  const { defineTool, degraded, source } = resolveDefineTool();
  if (degraded) {
    ctx.logger?.warn?.('[dsh-server-log-analyzer] 未解析到 @deepseek-ai/dsh-tools.defineTool，工具以退化模式注册（参数校验由工具自身完成）');
  } else {
    ctx.logger?.debug?.(`[dsh-server-log-analyzer] defineTool ← ${source}`);
  }

  const register = (spec) => ctx.tools.register(withStructuredErrors(defineTool(spec)));

  /* ── 1. 分析 ─────────────────────────────────────────────── */
  register({
    name: 'hwlog_analyze',
    description: [
      '服务器硬件日志初判：吃进带外日志（BMC/iDRAC/iLO/iBMC/XCC/IPMI SEL/Redfish）与系统日志（syslog/dmesg/journal/smartctl/storcli），',
      '自动识别品牌与日志类型，抽取设备台账，按"内存/CPU/电源/散热/存储/RAID/PCIe/网络/固件/主板"分类，输出健康评分、分级发现、根因关联与处置动作，',
      '每条结论都带原始行（文件:行号）。不认识的牌子也能分析（品牌无关规则库 + 通用 IPMI/Redfish 解析）。',
      '注意：只有系统日志没有带外日志时，工具会明确提示"证据不全"，不要据此下硬件定性结论。',
    ].join(''),
    parameters: {
      paths: PATHS_PARAM,
      text: { type: 'string', description: '直接粘贴的日志内容（与 paths 二选一，或同时给）' },
      textName: { type: 'string', description: '粘贴内容的显示名（默认 <粘贴内容>）' },
      vendor: VENDOR_PARAM,
      format: { type: 'string', description: '强制指定日志类型（一般不用填，留空自动识别）：ipmi-sel/idrac-lifecycle/ilo-iml/redfish-json/journal-json/syslog/dmesg/storage-cli/bmc-text/plain' },
      output: OUTPUT_PARAM,
      maxFindings: { type: 'number', description: '最多列出多少类发现，默认 12' },
      includeNoise: { type: 'boolean', description: 'true 时把"非硬件系统噪音"（sshd/cron 之类）也计入事件，默认 false' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      const { analysis, skipped, notes } = await analyzeTargets({
        paths: args.paths || [],
        text: args.text,
        textName: args.textName,
        vendor: args.vendor || 'auto',
        format: args.format || 'auto',
        maxFindings: args.maxFindings || config.maxFindings,
        includeNoise: Boolean(args.includeNoise),
      });
      const output = args.output || 'markdown';
      const head = [
        skipped.length ? `\n\n> 跳过的输入：\n${skipped.map((item) => `> - ${item.path}（${item.reason}）`).join('\n')}\n` : '',
        notes && notes.length ? `\n> 读取/解码说明：\n${notes.map((note) => `> - ${note}`).join('\n')}\n` : '',
      ].join('');
      if (output === 'brief') return `${renderBrief(analysis)}${head}`;
      if (output === 'json') {
        // JSON 形态要把"读取/解码说明"和"跳过项"并进同一份对象，否则 JSON.parse 会失败
        return JSON.stringify({ ...toDigest(analysis), read_notes: notes || [], skipped_inputs: skipped }, null, 2);
      }
      return `${renderMarkdown(analysis, { asset: args.asset || '' })}${head}`;
    },
  });

  /* ── 2. 采集清单 ─────────────────────────────────────────── */
  register({
    name: 'hwlog_collect',
    description: '生成服务器日志采集清单：各品牌（DELL iDRAC / HPE iLO / Lenovo XCC / 浪潮 / 华为 iBMC / 超微 / 曙光 / 中兴 / H3C / 富士通 / 通用 IPMI+Redfish）的带外日志、传感器、FRU、固件版本命令，以及 OS 侧日志与硬件快照命令。要现场执行就用 transport=ssh/ipmi 生成脚本。',
    parameters: {
      brand: { type: 'string', enum: BRAND_CHOICES, description: '品牌，默认 auto=全部品牌都给（不知道怎么选就用 auto）' },
      scope: { type: 'string', enum: ['bmc', 'os', 'all'], description: '范围：bmc=只带外；os=只系统侧；all=都要（默认）' },
      transport: { type: 'string', enum: ['ipmi', 'redfish', 'racadm', 'ilo', 'ssh'], description: '采集通道（影响提示语）：默认 ipmi' },
      host: { type: 'string', description: 'BMC 地址占位（默认 BMC_IP，只做占位不会去连）' },
      asScript: { type: 'boolean', description: 'true 时输出可直接执行/保存的 bash 采集脚本' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      const options = { brand: args.brand || 'auto', scope: args.scope || 'all', transport: args.transport || 'ipmi', host: args.host || 'BMC_IP' };
      if (args.asScript) return renderCollectScript(options);
      const plan = collectPlan(options);
      const lines = [`# 采集清单 · ${plan.label}（通道：${plan.transport}）`, ''];
      if (plan.note) lines.push(`> ${plan.note}`, '');
      for (const section of plan.sections) {
        lines.push(`## ${section.title}`);
        if (section.note) lines.push(`> ${section.note}`);
        for (const item of section.items) {
          lines.push(`- \`${item.cmd}\``);
          lines.push(`  - ${item.note}`);
        }
        lines.push('');
      }
      lines.push('> 纪律：清 SEL / 重启 BMC / 一键收集之前，先把日志导出来留证；SEL 一旦 clear，历史劣化趋势就没了。');
      return lines.join('\n');
    },
  });

  /* ── 3. 基线 ─────────────────────────────────────────────── */
  register({
    name: 'hwlog_baseline',
    description: '把本次日志分析结果存成基线快照（JSON），供以后用 hwlog_diff 做"新增/恶化/已恢复"对比。巡检建议每次留一份：baseline-<SN>-<日期>.json。',
    parameters: {
      paths: PATHS_PARAM,
      text: { type: 'string', description: '直接粘贴的日志内容（与 paths 二选一）' },
      out: { type: 'string', description: '基线文件路径；不填则写到 <报告目录>/baseline-<时间戳>.json' },
      label: { type: 'string', description: '基线标签（默认用机型名，建议写"主机名-SN"）' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      const { analysis } = await analyzeTargets({ paths: args.paths || [], text: args.text, maxFindings: 200 });
      const baseline = makeBaseline(analysis, { label: args.label });
      const out = args.out || join(resolveReportDir(config), `baseline-${Date.now()}.json`);
      const written = await writeTextFile(out, JSON.stringify(baseline, null, 2));
      return `基线已保存：${written}\n- 标签：${baseline.label}\n- 健康评分：${baseline.health.score}（${baseline.health.grade} ${baseline.health.label}）\n- 记录告警类数：${baseline.findings.length}\n- 下次对比：hwlog_diff(baseline="${written}", paths=[...])`;
    },
  });

  /* ── 4. 对比 ─────────────────────────────────────────────── */
  register({
    name: 'hwlog_diff',
    description: '把本次日志与基线对比，只输出变化：新增告警、次数恶化、次数缓解、已恢复，以及台账变化与评分变化。巡检复判、验证"修好了没有"就用它。',
    parameters: {
      baseline: { type: 'string', required: true, description: '基线文件路径（hwlog_baseline 生成的 JSON），或直接给基线 JSON 文本' },
      paths: PATHS_PARAM,
      text: { type: 'string', description: '直接粘贴的日志内容（与 paths 二选一）' },
      asset: { type: 'string', description: '设备标识（写进对比报告标题）' },
      output: OUTPUT_PARAM,
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      const raw = String(args.baseline || '').trim();
      const baseline = raw.startsWith('{') ? JSON.parse(raw) : await readJsonFile(raw);
      const { analysis } = await analyzeTargets({ paths: args.paths || [], text: args.text, maxFindings: 200 });
      const diff = diffBaseline(baseline, analysis);
      if (args.output === 'json') return JSON.stringify(diff, null, 2);
      return renderDiffMarkdown(diff, { asset: args.asset || '' });
    },
  });

  /* ── 5. 规则库 ───────────────────────────────────────────── */
  register({
    name: 'hwlog_rules',
    description: '查本插件的硬件规则库：能识别哪些故障（内存 UCE/CE、CPU MCE、电源失效/冗余、风扇/过温、硬盘预警、RAID 降级、PCIe AER、BMC 看门狗…），覆盖哪些品牌事件码（Dell MEM/PWR/FAN/CPU 码、Lenovo FQXSP 事件族、HPE POST 码等）。分析结果里出现"未识别事件"时，用它可以判断要不要补规则。',
    parameters: {
      category: { type: 'string', enum: CATEGORY_CHOICES, description: '只列某一类（默认 all）' },
      query: { type: 'string', description: '关键字过滤（规则 id / 名称 / 类别 / 正则片段）' },
      verbose: { type: 'boolean', description: 'true 时输出每条规则的完整处置动作' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      const digest = rulesDigest({ category: args.category || 'all', query: args.query, verbose: Boolean(args.verbose) });
      const lines = [`规则库：共 ${digest.total} 条，本次匹配 ${digest.matched} 条`, `类别分布：${Object.entries(digest.byCategory).map(([cat, num]) => `${digest.categories[cat] || cat} ${num}`).join('、')}`, ''];
      for (const rule of digest.rules) {
        lines.push(`### ${rule.id} · ${rule.categoryLabel} · ${rule.severity}`);
        lines.push(`- ${rule.title}`);
        if (rule.vendorCodes) {
          lines.push(`- 品牌事件码：${Object.entries(rule.vendorCodes).map(([brand, codes]) => `${brand}: ${[].concat(codes).join('/')}`).join('；')}`);
        }
        for (const advice of rule.advice || []) lines.push(`- 处置：${advice}`);
        lines.push('');
      }
      return lines.join('\n');
    },
  });

  /* ── 6. 出报告文件 ───────────────────────────────────────── */
  register({
    name: 'hwlog_report',
    description: '把分析结论写成文件（Markdown 报告 / JSON 摘要），可直接贴工单或归档。默认写到 <reportDir>/server-hw-report-<时间戳>.md。',
    parameters: {
      paths: PATHS_PARAM,
      text: { type: 'string', description: '直接粘贴的日志内容（与 paths 二选一）' },
      out: { type: 'string', description: '输出文件路径（.md 或 .json）' },
      title: { type: 'string', description: '报告标题（默认「服务器硬件巡检分析报告」）' },
      asset: { type: 'string', description: '设备标识：主机名/序列号/机房位置' },
      operator: { type: 'string', description: '操作者署名（写进报告抬头）' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      const { analysis, skipped, notes } = await analyzeTargets({ paths: args.paths || [], text: args.text, maxFindings: 200 });
      const header = [
        skipped.length ? `\n\n> 跳过输入：${skipped.map((item) => `${item.path}（${item.reason}）`).join('；')}\n` : '',
        notes && notes.length ? `\n> 读取/解码说明：${notes.join('；')}\n` : '',
      ].join('');
      const isJson = String(args.out || '').toLowerCase().endsWith('.json');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const out = args.out || join(resolveReportDir(config), `server-hw-report-${stamp}.${isJson ? 'json' : 'md'}`);
      const body = isJson
        ? JSON.stringify({ ...toDigest(analysis), read_notes: notes || [], skipped_inputs: skipped }, null, 2)
        : `${renderMarkdown(analysis, { title: args.title, asset: args.asset, operator: args.operator })}${header}`;
      const written = await writeTextFile(out, body);
      return `报告已生成：${written}\n${renderBrief(analysis)}`;
    },
  });

  /* ── 7. 运维操作库（runbook：命令 / 界面路径 / 处理步骤） ── */
  register({
    name: 'hwlog_ops',
    description: [
      '运维操作库检索：厂商手册里的「命令 / 界面路径 / 处理步骤」被抽成了可检索资产。',
      '用途：遇到某类告警时查"该敲什么命令、点哪个菜单、按什么顺序处理"；也能列出某品牌/类别的全部操作条目。',
      '数据来源（已抽取入库）：华为 RAID 控制卡用户指南、浪潮 BMC 用户手册、华为 iBMC 告警处理、联想 XCC 消息参考。',
      '与 hwlog_analyze 联动：分析报告里每条发现都会自动附上相关操作条目。',
    ].join(''),
    parameters: {
      action: { type: 'string', enum: ['search', 'list', 'import', 'path'], description: 'search=按关键词检索（默认）；list=列出条目；import=导入抽取出的 JSON 文件；path=打印库目录与统计' },
      query: { type: 'string', description: '检索关键词，如「RAID 降级」「保留缓存」「日志导出」「storcli」「电源模块」' },
      brand: { type: 'string', enum: BRAND_CHOICES, description: '品牌过滤（默认不过滤）' },
      category: { type: 'string', enum: CATEGORY_CHOICES, description: '类别过滤' },
      kind: { type: 'string', enum: ['command', 'ui', 'step', 'check'], description: '条目类型：command=命令 / ui=界面路径 / step=操作步骤 / check=检查项' },
      limit: { type: 'number', description: '返回条数上限，默认 8' },
      file: { type: 'string', description: 'action=import 时的 JSON 文件路径（extract-vendor-ops.py 的输出）' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      const action = args.action || 'search';
      const status = opsStatus();
      if (action === 'path') {
        return [
          `运维操作库总计 ${status.total} 条（命令 ${status.byKind.command || 0} / 界面路径 ${status.byKind.ui || 0} / 步骤 ${status.byKind.step || 0} / 检查项 ${status.byKind.check || 0}）`,
          `自带模板：${status.bundledDir}`,
          `导入目录：${status.userDir}`,
          '',
          ...status.sources.map((item) => `- [${item.origin}] ${item.brand}｜${item.count} 条｜${item.source}${item.version ? `（${item.version}）` : ''}`),
        ].join('\n');
      }
      if (action === 'import') {
        if (!args.file) return '导入需要 file：extract-vendor-ops.py 输出的 JSON 路径';
        const parsed = await readJsonFile(args.file);
        const tables = Array.isArray(parsed) ? parsed : [parsed];
        const lines = [];
        for (const table of tables) {
          const written = writeOpsTable(table);
          lines.push(`已导入 ${written.count} 条 → ${written.file}`);
        }
        return lines.join('\n');
      }
      const library = loadOpsLibrary();
      if (action === 'list') {
        const rows = searchOps(library, { brand: args.brand, category: args.category, kind: args.kind, limit: args.limit || 30 });
        if (!rows.length) return '没有匹配的操作条目（检查 brand / category / kind 过滤条件）';
        return rows.map((entry) => `- 【${OPS_KINDS[entry.kind]}】[${entry.categoryLabel || entry.category}] ${entry.title}　（${entry.source}）`).join('\n');
      }
      const rows = searchOps(library, { query: args.query, brand: args.brand, category: args.category, kind: args.kind, limit: args.limit || 8 });
      if (!rows.length) return `没有找到匹配「${args.query || ''}」的操作条目。可用 hwlog_ops(action="list") 看全部条目，或 hwlog_ops(action="path") 确认操作库是否已导入。`;
      const out = [`运维操作库命中 ${rows.length} 条：`, ''];
      for (const entry of rows) {
        out.push(`### 【${OPS_KINDS[entry.kind]}】${entry.title}　·　${entry.category}`);
        out.push(`来源：${entry.source}${entry.version ? `（${entry.version}）` : ''}${entry.brand ? `　品牌：${entry.brand}` : ''}`);
        if (entry.symptoms && entry.symptoms.length) out.push(`适用场景：${entry.symptoms.join(' / ')}`);
        for (const command of entry.commands || []) out.push(`- 命令：\`${command}\``);
        for (const step of entry.steps || []) out.push(`- 步骤：${step}`);
        if (entry.notes) out.push(`- 备注：${entry.notes}`);
        out.push('');
      }
      return out.join('\n');
    },
  });

  /* ── 8. 自检 ─────────────────────────────────────────────── */
  register({
    name: 'hwlog_doctor',
    description: '插件自检：规则库是否加载、内置探针能否命中（内存/电源/EDAC/AER）、品牌识别是否正常、三个技能是否已落地到 $DSH_HOME/skills、自带样例能否解析。装完插件或技能没出现在目录里时先跑它。',
    parameters: {
      withSamples: { type: 'boolean', description: '是否连自带样例目录一起解析（默认 true）' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      const sampleDir = args.withSamples === false ? undefined : join(packageDirOf(import.meta.url), 'samples');
      const result = await doctor({ skillsDir: true, sampleDir });
      const skills = await skillsStatus({ home: dshHome() });
      const bundled = await listBundledSkills();
      const lines = [
        `# dsh-server-log-analyzer 自检：${result.ok ? '通过 ✅' : '存在问题 ❌'}`,
        '',
        `- 定义函数来源：${degraded ? '退化模式（未解析到 defineTool）' : source}`,
        `- $DSH_HOME：${dshHome()}`,
        `- 技能目录：${skills.skillsRoot}`,
        `- 插件内置技能：${bundled.map((item) => item.id).join('、')}`,
        '',
      ];
      for (const check of result.checks) lines.push(`- ${check.ok ? '✅' : '❌'} ${check.name}：${check.detail}`);
      lines.push('', '技能落地状态：');
      for (const item of skills.items) {
        lines.push(`- ${item.installed ? (item.userModified ? '⚠️' : '✅') : '❌'} ${item.id}：${item.installed ? (item.userModified ? '已安装但被用户改过（不覆盖）' : item.synced ? '已同步' : '内容落后于插件（可重新安装）') : '未安装'}${item.path ? ` → ${item.path}` : ''}`);
        lines.push(`  - ${item.description}`);
      }
      lines.push('', `如技能缺失：调用 hwlog_doctor 后仍缺，可手动执行 \`node ${join(packageDirOf(import.meta.url), 'bin', 'dsh-hwlog.js')} skills install\`。`);
      return lines.join('\n');
    },
  });

  /* ── 技能自动落地（技能根目录热点：无需重启即生效）───────── */
  if (config.installSkills) {
    Promise.resolve()
      .then(() => installSkills({ home: dshHome() }))
      .then((report) => {
        const changed = report.installed.length + report.updated.length;
        ctx.logger?.info?.(`[dsh-server-log-analyzer] 技能${changed ? `已更新（新增 ${report.installed.length} / 更新 ${report.updated.length}）` : '已是最新'}：${report.root}`);
        if (report.skipped.length) {
          ctx.logger?.warn?.(`[dsh-server-log-analyzer] ${report.skipped.length} 个技能文件被用户修改过，保留用户版本：${report.skipped.map((item) => item.file).join('、')}`);
        }
        if (report.failed.length) {
          ctx.logger?.warn?.(`[dsh-server-log-analyzer] 技能写入失败：${report.failed.map((item) => `${item.file}（${item.error}）`).join('、')}`);
        }
      })
      .catch((error) => {
        ctx.logger?.warn?.(`[dsh-server-log-analyzer] 技能安装失败：${error && error.message ? error.message : error}`);
      });
  }

  ctx.logger?.info?.('[dsh-server-log-analyzer] 已注册 7 个工具：hwlog_analyze / hwlog_collect / hwlog_baseline / hwlog_diff / hwlog_rules / hwlog_report / hwlog_doctor');
}

/** 供 CLI/测试复用（不经过 cordis）。 */
export { analyzeDocuments, documentsFromText, renderMarkdown, renderBrief, toDigest, installSkills, skillsStatus };
