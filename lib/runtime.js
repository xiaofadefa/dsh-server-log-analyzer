/**
 * 插件运行时适配层：把"dsh 宿主里的 defineTool / 配置 / 技能目录"收敛到这里。
 *
 * 为什么不直接 import '@deepseek-ai/dsh-tools'：
 *   插件装在 profile 的 node_modules 里，而 dsh-tools 在 dsh 主程序自己的依赖树中，
 *   静态 import 在不同安装形态（link / tarball / 全局 dsh）下解析结果不同。
 *   这里按"锚点 package.json → createRequire"逐个尝试，做法参考了
 *   dsh-purge（https://github.com/YuJunZhiXue/dsh-purge，MIT）；
 *   全部失败时退化成"原样注册"，保证插件不会因为解析不到而整体不可用。
 */

import { createRequire } from 'node:module';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** 解析 $DSH_HOME（优先环境变量，其次 ~/.dsh）。 */
export function dshHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME;
  return join(homedir(), '.dsh');
}

function addCandidate(list, value) {
  if (!value) return;
  const normalized = String(value).replace(/\\/g, '/');
  if (!list.includes(normalized)) list.push(normalized);
}

/** 从"运行中的 dsh 可执行入口"反推 dsh 包目录（link 安装时唯一可靠的线索）。 */
function considerBin(list, bin) {
  if (!bin) return;
  let text = String(bin).replace(/\\/g, '/');
  try {
    text = realpathSync(bin).replace(/\\/g, '/');
  } catch { /* 解析不了就用原路径 */ }
  const needle = '/node_modules/@deepseek-ai/dsh/';
  const at = text.lastIndexOf(needle);
  if (at >= 0) addCandidate(list, `${text.slice(0, at + needle.length - 1)}/package.json`);
  const nm = text.lastIndexOf('/node_modules/');
  if (nm >= 0) {
    const root = text.slice(0, nm);
    addCandidate(list, join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'));
    addCandidate(list, join(root, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'));
  }
  const dir = dirname(text);
  addCandidate(list, join(dir, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'));
  addCandidate(list, join(dir, '..', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'));
}

function candidates() {
  const list = [];
  try { considerBin(list, process.argv[1]); } catch { /* ignore */ }
  try { considerBin(list, process.execPath); } catch { /* ignore */ }

  const home = dshHome();
  addCandidate(list, join(home, 'package.json'));
  for (const profile of ['desktop', 'web', 'default', 'tui', 'headless']) {
    addCandidate(list, join(home, 'profiles', profile, 'package.json'));
    addCandidate(list, join(home, 'profiles', profile, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'));
    addCandidate(list, join(home, 'profiles', profile, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'));
  }
  addCandidate(list, join(process.cwd(), 'package.json'));

  // 全局 npm 安装（Windows: %APPDATA%\npm；POSIX: 常见前缀）
  const appData = process.env.APPDATA || (process.env.HOME ? join(process.env.HOME, '.config') : '');
  if (appData) {
    const npmDir = join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh');
    addCandidate(list, join(npmDir, 'package.json'));
    addCandidate(list, join(npmDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'));
    // dsh 主程序把 dsh-tools 放在自己的 node_modules 里
    addCandidate(list, join(npmDir, 'node_modules', '@deepseek-ai', 'dsh-tools', 'package.json'));
  }
  for (const guess of [
    join('/', 'usr', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    join('/', 'usr', 'local', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    join('D:', 'DeepSeek Harness', 'npm-global', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
  ]) addCandidate(list, guess);

  return list;
}

/**
 * 释放 defineTool（工具定义校验器）。失败时返回"原样透传"的退化实现。
 * @returns {{ defineTool: Function, source: string, degraded: boolean }}
 */
export function resolveDefineTool() {
  for (const pkg of candidates()) {
    if (!pkg || !existsSync(pkg)) continue;
    try {
      const mod = createRequire(pkg)('@deepseek-ai/dsh-tools');
      const fn = mod && (mod.defineTool || (mod.default && mod.default.defineTool));
      if (typeof fn === 'function') return { defineTool: fn, source: pkg, degraded: false };
    } catch { /* 试下一个锚点 */ }
  }
  return { defineTool: (spec) => spec, source: 'fallback(原样注册)', degraded: true };
}

/** 统一的文本结果块渲染（与 dsh 内置工具一致）。 */
export const text = (value) => [{
  type: 'text',
  text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
}];

/**
 * 把工具执行异常收敛成结构化失败返回（模型能据此换参数重试）。
 * 约定参考了 dsh-purge（https://github.com/YuJunZhiXue/dsh-purge，MIT）。
 */
export function withStructuredErrors(tool) {
  const inner = tool.execute;
  if (typeof inner !== 'function') return tool;
  return {
    ...tool,
    async execute(args, exec) {
      try {
        return await inner(args, exec);
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        const kind = /不存在|required|必填|非法|invalid|not found|没有可分析的输入/i.test(message) ? 'bad_input' : 'failed';
        return JSON.stringify({
          ok: false,
          error: message,
          error_kind: kind,
          hint: kind === 'bad_input'
            ? '参数或输入问题：确认路径存在、日志内容非空，或改用 text 直接粘贴日志内容。'
            : '执行失败，错误原文见 error；把失败原因告诉用户，不要静默跳过。',
        }, null, 2);
      }
    },
  };
}

const CONFIG_DEFAULTS = {
  enabled: true,
  installSkills: true,
  maxFindings: 12,
  reportDir: '',
};

/** 归一化插件配置（宿主传入的 config 可能是 undefined / 字符串数字）。 */
export function normalizeConfig(raw) {
  const config = { ...CONFIG_DEFAULTS };
  if (raw && typeof raw === 'object') {
    if (raw.enabled === false) config.enabled = false;
    if (raw.installSkills === false) config.installSkills = false;
    if (Number.isFinite(Number(raw.maxFindings))) config.maxFindings = Math.max(1, Math.min(200, Number(raw.maxFindings)));
    if (typeof raw.reportDir === 'string') config.reportDir = raw.reportDir;
  }
  return config;
}

/** 插件自带资源目录（skills / samples / docs）。 */
export function packageDirOf(importMetaUrl) {
  const filePath = importMetaUrl.startsWith('file:') ? new URL(importMetaUrl).pathname : importMetaUrl;
  const decoded = decodeURIComponent(filePath.replace(/^\/([A-Za-z]:)/, '$1'));
  return resolve(dirname(decoded), '..');
}
