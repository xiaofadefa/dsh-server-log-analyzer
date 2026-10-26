#!/usr/bin/env node
// make-market-index.mjs —— 生成 DSH 插件市场索引（format 1）的 market/index.json
//
// 索引被 DSH「插件 → 发现」标签页读取（Host 服务 dsh-plugin-market，校验器
// dsh-plugin-market-index）。把生成的文件托管到任意 https 静态地址，别人在
// 「发现 → 添加索引源」里填这个 URL 就能看到并一键安装本插件。
//
// 用法：
//   node scripts/make-market-index.mjs --source npm
//   node scripts/make-market-index.mjs --source git --git-url https://github.com/OWNER/REPO
//   node scripts/make-market-index.mjs --source npm --desc-en "Server BMC/IPMI log triage for DSH"
//
// 说明：
// - 零依赖，只用 Node 内置模块；不需要 npm install。
// - --source npm 需要包已 `npm publish`；--source git 需要一个公开仓库和已提交的 HEAD。
// - 末尾做一次本地预检（format 1 规则的子集），不通过就不写文件。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const COMMIT = /^[0-9a-f]{40}$/;
// 只用于预检的宽松 SemVer range 形状检查（真正的判定在 DSH 侧用 semver 完成）
const RANGE = /^(?:[<>=~^]*\s*(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?|latest|\*)$/;

function die(message) {
  console.error(`✖ ${message}`);
  process.exit(1);
}

function warn(message) {
  console.warn(`! ${message}`);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) die(`无法识别的参数：${token}`);
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}

// git@github.com:OWNER/REPO.git / https://github.com/OWNER/REPO.git → https://github.com/OWNER/REPO
function normalizeGitUrl(raw) {
  if (raw === undefined) return undefined;
  let url = raw.trim();
  const scp = /^git@([^:]+):(.+)$/u.exec(url);
  if (scp) url = `https://${scp[1]}/${scp[2]}`;
  url = url.replace(/^git\+/u, '').replace(/^http:/u, 'https:').replace(/\.git$/u, '').replace(/\/$/u, '');
  return url;
}

function entry(object, path, value) {
  if (value === undefined || value === '') return;
  object[path] = value;
}

const args = parseArgs(process.argv.slice(2));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

if (!PACKAGE_NAME.test(pkg.name)) die(`package.json 的 name 不是合法的 npm 包名：${pkg.name}`);
if (!SEMVER.test(String(pkg.version))) die(`package.json 的 version 必须是精确 SemVer：${pkg.version}`);

const sourceKind = args.source === undefined ? 'npm' : String(args.source);
if (sourceKind !== 'npm' && sourceKind !== 'git') die('--source 只接受 npm 或 git');

// ── 版本来源 ──────────────────────────────────────────────────────────────
const version = String(pkg.version);
let source;
let installHint;

if (sourceKind === 'npm') {
  source = { type: 'npm' };
  const registry = args.registry === undefined ? undefined : String(args.registry);
  if (registry !== undefined) {
    if (!/^https?:\/\//u.test(registry) || registry.includes('?') || registry.includes('#')) {
      die('--registry 必须是 http(s) 绝对地址，且不含查询串或片段');
    }
    source.registry = registry;
  }
  installHint = registry === undefined ? `${pkg.name}@${version}` : `${pkg.name}@${version}（registry ${registry}）`;
} else {
  const remote = normalizeGitUrl(args['git-url'] ?? git(['remote', 'get-url', 'origin']));
  if (remote === undefined) die('拿不到仓库地址：先 git remote add origin …，或用 --git-url 指定');
  if (!/^https:\/\/[^/]+(?:\/[^/]+){2,}$/u.test(remote)) {
    die(`仓库地址必须是 https 且至少两段路径（当前：${remote}）`);
  }
  if (args['git-url'] !== undefined || remote !== normalizeGitUrl(git(['remote', 'get-url', 'origin']))) {
    warn(`索引里的仓库地址按 https 规范化：${remote}`);
  }
  const commit = args.commit === undefined ? git(['rev-parse', 'HEAD']) : String(args.commit);
  if (commit === undefined || !COMMIT.test(commit)) {
    die('拿不到提交：先 git commit，或用 --commit 指定 40 位小写 commit SHA');
  }
  source = { type: 'git', url: remote, commit };
  if (args.path !== undefined) source.path = String(args.path);
  installHint = `git+${remote}.git#${commit}`;
  warn('git 源安装时 pnpm 会克隆整个仓库：请确认 lib/ 已提交且无需构建（本插件是纯 ESM JS，无构建步骤）');
}

// 发布时间：优先 --publish-time，其次包的提交时间，最后当前时间
let publishTimestamp;
if (args['publish-time'] !== undefined) {
  publishTimestamp = Number(args['publish-time']);
} else {
  const committerDate = git(['log', '-1', '--format=%ct']);
  publishTimestamp = committerDate === undefined ? Math.floor(Date.now() / 1000) : Number(committerDate);
}

// ── 展示元信息 ────────────────────────────────────────────────────────────
const localize = (zh, en) => {
  if (en === undefined) {
    if (zh === undefined) return undefined;
    warn('只给了中文标题/描述：索引在英文界面下也会显示中文，建议补 --title-en / --desc-en');
    return zh;
  }
  return { en, ...(zh === undefined ? {} : { zh }) };
};

const pluginTitle = localize(
  args['title-zh'] === undefined ? undefined : String(args['title-zh']),
  args['title-en'] === undefined ? undefined : String(args['title-en']),
);
const pluginDescription = localize(
  String(args['desc-zh'] ?? pkg.description ?? ''),
  args['desc-en'] === undefined ? undefined : String(args['desc-en']),
);

const repositoryUrl = normalizeGitUrl(
  args.repository ?? (typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url) ?? git(['remote', 'get-url', 'origin']),
);

const plugin = { name: pkg.name };
entry(plugin, 'title', pluginTitle);
entry(plugin, 'description', pluginDescription);
if (args.icon !== undefined) plugin.icon = String(args.icon);
// npm 的 author 允许是 "名字 <邮箱> (主页)" 字符串或 {name, email, url} 对象；索引里只要一个短标识
const authorName =
  args.author ?? (typeof pkg.author === 'string' ? pkg.author : pkg.author?.name) ?? '';
entry(plugin, 'author', String(authorName));
entry(plugin, 'homepage', String(args.homepage ?? pkg.homepage ?? ''));
if (repositoryUrl !== undefined && /^https?:\/\//u.test(repositoryUrl)) plugin.repository = { url: repositoryUrl };

const category = String(args.category ?? 'observability');
plugin.metadata = {
  category,
  keywords: Array.isArray(pkg.keywords) ? pkg.keywords.slice(0, 12) : [],
  labels: args.label === undefined ? ['server-hardware'] : String(args.label).split(',').map((s) => s.trim()),
};

const engines = String(args['engines-dsh'] ?? pkg.engines?.dsh ?? '');
plugin.versions = [
  {
    version,
    publishTimestamp,
    source,
    ...(engines === '' ? {} : { engines: { dsh: engines } }),
  },
];

const index = {
  format: 1,
  title: { en: String(args['index-title-en'] ?? 'YG DSH Plugins'), zh: String(args['index-title-zh'] ?? 'YG 的 DSH 插件源') },
  description: {
    en: 'Third-party DSH plugin index maintained by YG.',
    zh: 'YG 维护的第三方 DSH 插件索引。',
  },
  metadata: {
    categories: { observability: { title: { en: 'Observability', zh: '可观测与诊断' } }, capabilities: { title: { en: 'Capabilities', zh: '模型可用能力' } } },
    labels: {
      'server-hardware': { title: { en: 'Server hardware', zh: '服务器硬件' } },
      'log-analysis': { title: { en: 'Log analysis', zh: '日志分析' } },
    },
  },
  plugins: [plugin],
};

// ── 本地预检（format 1 规则子集）──────────────────────────────────────────
function precheck(document) {
  const problems = [];
  const at = (cond, path, reason) => {
    if (!cond) problems.push(`${path} ${reason}`);
  };
  at(document.format === 1, '$.format', '必须为 1');
  for (const key of ['title']) {
    const value = document[key];
    at(typeof value === 'string' || (value && typeof value === 'object' && Object.keys(value).length > 0), `$.${key}`, '必须非空');
    if (value && typeof value === 'object') at(Object.hasOwn(value, 'en'), `$.${key}`, '本地化对象必须含 en');
  }
  at(Array.isArray(document.plugins) && document.plugins.length > 0, '$.plugins', '必须是非空数组');
  const seenNames = new Set();
  document.plugins.forEach((item, i) => {
    const p = `$.plugins[${i}]`;
    at(PACKAGE_NAME.test(item.name ?? ''), `${p}.name`, '必须是合法 npm 包名');
    at(!seenNames.has(item.name), `${p}.name`, '重复');
    seenNames.add(item.name);
    at(Array.isArray(item.versions) && item.versions.length > 0, `${p}.versions`, '必须是非空数组');
    const seenVersions = new Set();
    (item.versions ?? []).forEach((v, j) => {
      const q = `${p}.versions[${j}]`;
      at(SEMVER.test(String(v.version)), `${q}.version`, '必须是精确 SemVer');
      at(!seenVersions.has(v.version), `${q}.version`, '重复');
      seenVersions.add(v.version);
      at(
        Number.isInteger(v.publishTimestamp) && v.publishTimestamp >= 0 && v.publishTimestamp < 1e11,
        `${q}.publishTimestamp`,
        '必须是 [0, 10^11) 的整数秒',
      );
      const s = v.source ?? {};
      at(s.type === 'npm' || s.type === 'git', `${q}.source.type`, '必须是 npm 或 git');
      if (s.type === 'git') {
        at(typeof s.url === 'string' && /^https:\/\/[^/]+(?:\/[^/]+){2,}$/u.test(s.url), `${q}.source.url`, '必须是 https 仓库地址（至少两段路径、无 .tgz）');
        at(COMMIT.test(s.commit ?? ''), `${q}.source.commit`, '必须是 40 位小写 hex 提交');
      }
      if (s.type === 'npm' && s.registry !== undefined) {
        at(/^https?:\/\//u.test(s.registry), `${q}.source.registry`, '必须是 http(s) 地址');
      }
      if (v.engines?.dsh !== undefined) {
        at(!String(v.engines.dsh).startsWith('workspace:'), `${q}.engines.dsh`, '不能是 workspace: 范围');
        at(RANGE.test(String(v.engines.dsh).trim()), `${q}.engines.dsh`, '必须是 SemVer range（预检只做形状检查）');
      }
    });
  });
  // 引用的 category / label 必须已声明
  const declaredCategories = new Set(Object.keys(document.metadata?.categories ?? {}));
  const declaredLabels = new Set(Object.keys(document.metadata?.labels ?? {}));
  document.plugins.forEach((item, i) => {
    if (item.metadata?.category !== undefined) {
      at(declaredCategories.has(item.metadata.category), `$.plugins[${i}].metadata.category`, '引用了未声明的分类');
    }
    for (const label of item.metadata?.labels ?? []) {
      at(declaredLabels.has(label), `$.plugins[${i}].metadata.labels`, `引用了未声明的标签 ${label}`);
    }
  });
  return problems;
}

const problems = precheck(index);
if (problems.length > 0) {
  console.error('✖ 预检失败：');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

const outPath = resolve(ROOT, String(args.out ?? 'market/index.json'));
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8');

console.log(`✔ 索引已写入 ${outPath}`);
console.log(`  包：${pkg.name}@${version}   源：${sourceKind}   发布时间：${publishTimestamp}`);
console.log(`  安装用的 spec：${installHint}`);
console.log('  下一步：把 market/ 目录托管到 https 静态地址，');
console.log('          然后 插件 → 发现 → 添加索引源 → 填该 URL。');
