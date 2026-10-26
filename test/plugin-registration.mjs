/**
 * 插件面自测：用假的 cordis ctx 调 apply()，验证
 * ①7 个工具都注册了、schema 合法；②工具真能跑出结果；③技能落地被触发；④配置能禁用插件。
 * 这样在没有重启 dsh 的情况下也能证明"插件装上去是活的"。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as plugin from '../lib/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, '..');
const SAMPLES = path.join(PACKAGE_ROOT, 'samples');

function makeCtx() {
  const registered = [];
  const logs = [];
  return {
    registered,
    logs,
    ctx: {
      tools: { register: (tool) => registered.push(tool) },
      logger: {
        info: (message) => logs.push(`info:${message}`),
        warn: (message) => logs.push(`warn:${message}`),
        debug: (message) => logs.push(`debug:${message}`),
      },
    },
  };
}

test('cordis 插件面：插件元信息与 7 个工具注册', async () => {
  const { ctx, registered } = makeCtx();
  plugin.apply(ctx, {});
  assert.equal(plugin.name, 'dsh-server-log-analyzer');
  assert.deepEqual(plugin.inject, ['tools']);
  const names = registered.map((tool) => tool.name).sort();
  assert.deepEqual(names, ['hwlog_analyze', 'hwlog_baseline', 'hwlog_collect', 'hwlog_diff', 'hwlog_doctor', 'hwlog_ops', 'hwlog_report', 'hwlog_rules']);

  for (const tool of registered) {
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length > 30, `${tool.name} 描述太短，模型无法判断何时用`);
    assert.equal(typeof tool.execute, 'function');
    assert.equal(typeof tool.output.render, 'function');

    // defineTool 会把参数规格归一成 JSON Schema（{type:'object', properties:{...}}）；
    // 没解析到 dsh-tools 的退化路径下则是原始 spec。两种形态都要能自检。
    const params = tool.parameters || {};
    const isJsonSchema = params.type === 'object' && params.properties;
    const props = isJsonSchema ? params.properties : params;
    assert.ok(Object.keys(props).length >= 1, `${tool.name} 至少要有一个参数`);
    for (const [key, spec] of Object.entries(props)) {
      assert.ok(['string', 'number', 'boolean', 'array', 'object'].includes(spec.type), `${tool.name}.${key} 参数类型非法：${spec.type}`);
      assert.ok(typeof spec.description === 'string' && spec.description.length > 2, `${tool.name}.${key} 缺 description`);
    }
    const required = isJsonSchema ? (params.required || []) : Object.entries(props).filter(([, spec]) => spec.required).map(([key]) => key);
    assert.ok(Array.isArray(required));
  }

  // 必填参数应该被保留（diff 的 baseline 是必填）
  const diffTool = registered.find((tool) => tool.name === 'hwlog_diff');
  const diffRequired = diffTool.parameters.properties ? (diffTool.parameters.required || []) : [];
  assert.ok(diffRequired.includes('baseline'), 'hwlog_diff 的 baseline 应为必填');
});

test('工具执行：analyze 出报告、brief 省上下文、json 可解析', async () => {
  const { ctx, registered } = makeCtx();
  plugin.apply(ctx, {});
  const analyze = registered.find((tool) => tool.name === 'hwlog_analyze');

  const md = await analyze.execute({ paths: [SAMPLES], asset: '样例机' }, {});
  const mdBlocks = analyze.output.render({}, md);
  assert.equal(mdBlocks[0].type, 'text');
  assert.match(mdBlocks[0].text, /# 服务器硬件巡检分析报告 · 样例机/);
  assert.match(mdBlocks[0].text, /## 5. 根因关联推断/);

  const brief = await analyze.execute({ paths: [SAMPLES], output: 'brief' }, {});
  assert.ok(brief.length < 2500, 'brief 应是摘要而不是完整报告');
  assert.ok(!brief.includes('## 0. 结论摘要'), 'brief 不应含 Markdown 章节');
  assert.match(brief, /健康评分/);

  const json = await analyze.execute({ paths: [SAMPLES], output: 'json' }, {});
  const digest = JSON.parse(json);
  assert.ok(digest.findings.length > 10);
  assert.ok(digest.coverage.records > 100);
});

test('工具执行：粘贴文本也能分析（不必落盘）', async () => {
  const { ctx, registered } = makeCtx();
  plugin.apply(ctx, {});
  const analyze = registered.find((tool) => tool.name === 'hwlog_analyze');
  const out = await analyze.execute({
    text: '2026-08-16 09:00:05 [Critical] [MEM0001] Uncorrectable ECC error at DIMM_A3\n2026-08-16 09:20:41 [Critical] [PWR1000] AC lost detected on power supply 1',
  }, {});
  assert.match(out, /内存不可纠正错误/);
  assert.match(out, /电源输入丢失/);
});

test('工具执行：collect 出采集清单与脚本', async () => {
  const { ctx, registered } = makeCtx();
  plugin.apply(ctx, {});
  const collect = registered.find((tool) => tool.name === 'hwlog_collect');
  const plan = await collect.execute({ brand: 'huawei', scope: 'bmc' }, {});
  assert.match(plan, /ipmcget -d sel/);
  assert.match(plan, /采集清单/);
  const script = await collect.execute({ brand: 'dell', scope: 'all', asScript: true }, {});
  assert.ok(script.startsWith('#!/bin/bash'));
  assert.match(script, /racadm lclog view/);
  assert.match(script, /journalctl -k -b -1/);
});

test('工具执行：baseline → diff 全链路（含写文件）', async () => {
  const { ctx, registered } = makeCtx();
  plugin.apply(ctx, {});
  const baseline = registered.find((tool) => tool.name === 'hwlog_baseline');
  const diff = registered.find((tool) => tool.name === 'hwlog_diff');
  const report = registered.find((tool) => tool.name === 'hwlog_report');

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-hwlog-tool-'));
  const baselineFile = path.join(tmp, 'baseline.json');
  const baselineOut = await baseline.execute({ paths: [path.join(SAMPLES, 'dell-idrac-lifecycle.log')], out: baselineFile, label: 'node01' }, {});
  assert.ok(existsSync(baselineFile));
  assert.match(baselineOut, /基线已保存/);

  const diffOut = await diff.execute({ baseline: baselineFile, paths: [SAMPLES] }, {});
  assert.match(diffOut, /巡检对比报告/);
  assert.match(diffOut, /新增告警/);

  const reportFile = path.join(tmp, 'report.md');
  const reportOut = await report.execute({ paths: [SAMPLES], out: reportFile, title: '巡检报告', asset: 'node01', operator: 'ops' }, {});
  assert.ok(existsSync(reportFile));
  assert.match(reportOut, /报告已生成/);
  const content = await fsp.readFile(reportFile, 'utf8');
  assert.match(content, /# 巡检报告 · node01/);
  assert.match(content, /操作者：ops/);
  await fsp.rm(tmp, { recursive: true, force: true });
});

test('工具执行：ops 运维操作库（检索 / 列表 / 目录）', async () => {
  const { ctx, registered } = makeCtx();
  plugin.apply(ctx, {});
  const ops = registered.find((tool) => tool.name === 'hwlog_ops');
  assert.ok(ops, '应注册 hwlog_ops');
  const path = await ops.execute({ action: 'path' }, {});
  assert.match(path, /运维操作库/);
  assert.match(path, /导入目录/);
  const list = await ops.execute({ action: 'list', limit: 5 }, {});
  assert.ok(list.length > 0);
  const search = await ops.execute({ query: 'RAID' }, {});
  assert.ok(typeof search === 'string' && search.length > 10);
});

test('工具执行：rules 与 doctor 有输出且自检通过', async () => {
  const { ctx, registered } = makeCtx();
  plugin.apply(ctx, {});
  const rules = registered.find((tool) => tool.name === 'hwlog_rules');
  const out = await rules.execute({ category: 'power' }, {});
  assert.match(out, /PSU_FAIL/);
  assert.match(out, /规则库/);

  const doctor = registered.find((tool) => tool.name === 'hwlog_doctor');
  const docOut = await doctor.execute({ withSamples: true }, {});
  assert.match(docOut, /自检：通过/);
  assert.match(docOut, /技能落地状态/);
});

test('错误处理：参数不对时返回结构化失败而不是抛异常', async () => {
  const { ctx, registered } = makeCtx();
  plugin.apply(ctx, {});
  const analyze = registered.find((tool) => tool.name === 'hwlog_analyze');
  const out = await analyze.execute({ paths: [path.join(SAMPLES, '不存在的文件.log')] }, {});
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /没有可分析的输入/);
  assert.ok(parsed.hint.length > 0);
});

test('配置：enabled=false 时不注册任何工具', async () => {
  const { ctx, registered, logs } = makeCtx();
  plugin.apply(ctx, { enabled: false });
  assert.equal(registered.length, 0);
  assert.ok(logs.some((line) => line.includes('disabled')));
});
