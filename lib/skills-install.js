/**
 * 技能落地：把插件自带的 skills/**（SKILL.md + references/**）安装到 $DSH_HOME/skills。
 *
 * 为什么落盘而不是只放在插件目录：
 *   dsh 的技能发现器（@deepseek-ai/dsh-skill-filesystem）扫描的是
 *   <project>/.dsh/skills、<project>/.agents/skills、$DSH_HOME/skills、~/.agents/skills 这些根，
 *   不会去 node_modules 里翻；落盘后技能会被热发现（chokidar 监视根目录），
 *   无需重启 dsh 就出现在技能目录里。
 *
 * 安全约定：
 *   · 只用内容哈希判断"是不是我们装的"，用户改过的文件绝不覆盖；
 *   · 所有写入都限制在 $DSH_HOME/skills/<skill-id>/ 之内（assertInside）。
 */

import { promises as fsp } from 'node:fs';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dshHome } from './runtime.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.resolve(HERE, '..');
export const BUNDLED_SKILLS_DIR = path.join(PACKAGE_ROOT, 'skills');
export const MANIFEST_NAME = 'skills-manifest.json';

const SKIP_NAMES = new Set(['.', '..', '.DS_Store', '__MACOSX', '.git']);

export function skillsRoot(home = dshHome()) {
  return path.join(home, 'skills');
}

export function manifestPath(home = dshHome()) {
  return path.join(home, 'dsh-server-log-analyzer', MANIFEST_NAME);
}

function hashOf(buffer) {
  return createHash('sha1').update(buffer).digest('hex');
}

function assertInside(root, target) {
  const a = path.resolve(root);
  const b = path.resolve(target);
  const prefix = a.endsWith(path.sep) ? a : a + path.sep;
  if (b !== a && !b.startsWith(prefix)) throw new Error(`拒绝写入技能目录以外的路径：${target}`);
}

async function pathExists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

async function walkFiles(root, depth = 0) {
  const out = [];
  if (depth > 4) return out;
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_NAMES.has(entry.name) || entry.name.startsWith('._')) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...await walkFiles(full, depth + 1));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** 列出插件自带的技能（id + description + 文件数）。 */
export async function listBundledSkills() {
  const result = [];
  let entries = [];
  try {
    entries = await fsp.readdir(BUNDLED_SKILLS_DIR, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(BUNDLED_SKILLS_DIR, entry.name);
    const skillFile = path.join(dir, 'SKILL.md');
    if (!existsSync(skillFile)) continue;
    const raw = await fsp.readFile(skillFile, 'utf8');
    const description = (/^description:\s*(.+)$/m.exec(raw) || [])[1] || '';
    const name = (/^name:\s*(.+)$/m.exec(raw) || [])[1] || entry.name;
    const files = await walkFiles(dir);
    result.push({ id: name.trim(), dir, description: description.trim(), files: files.length });
  }
  return result;
}

async function readManifest(home) {
  try {
    const raw = await fsp.readFile(manifestPath(home), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && parsed.files ? parsed : { files: {} };
  } catch {
    return { files: {} };
  }
}

async function writeManifest(home, manifest) {
  const target = manifestPath(home);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, JSON.stringify(manifest, null, 2), 'utf8');
}

/**
 * 安装/更新插件自带技能到 $DSH_HOME/skills。
 * @param {{ home?: string, force?: boolean, only?: string[] }} [options]
 * @returns {Promise<{ root: string, installed: string[], updated: string[], upToDate: string[], skipped: object[], failed: object[] }>}
 */
export async function installSkills(options = {}) {
  const home = options.home || dshHome();
  const root = skillsRoot(home);
  const manifest = await readManifest(home);
  const bundled = await listBundledSkills();
  const wanted = options.only && options.only.length ? bundled.filter((item) => options.only.includes(item.id)) : bundled;

  const report = { root, installed: [], updated: [], upToDate: [], skipped: [], failed: [] };
  await fsp.mkdir(root, { recursive: true });

  for (const skill of wanted) {
    const files = await walkFiles(skill.dir);
    for (const file of files) {
      const rel = path.relative(skill.dir, file).split(path.sep).join('/');
      const key = `${skill.id}/${rel}`;
      const dest = path.join(root, skill.id, rel);
      try {
        assertInside(root, dest);
      } catch (error) {
        report.failed.push({ file: dest, error: error.message });
        continue;
      }
      const nextHash = hashOf(await fsp.readFile(file));
      const knownHash = manifest.files[key];
      const exists = await pathExists(dest);

      if (exists && !options.force) {
        const currentHash = hashOf(await fsp.readFile(dest));
        if (currentHash === nextHash) {
          manifest.files[key] = nextHash;
          if (!report.upToDate.includes(skill.id)) report.upToDate.push(skill.id);
          continue;
        }
        if (knownHash && currentHash !== knownHash) {
          report.skipped.push({ file: dest, reason: '文件已被用户修改，保留用户版本' });
          continue;
        }
      }

      try {
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.copyFile(file, dest);
        manifest.files[key] = nextHash;
        if (exists) {
          if (!report.updated.includes(skill.id)) report.updated.push(skill.id);
        } else if (!report.installed.includes(skill.id)) {
          report.installed.push(skill.id);
        }
      } catch (error) {
        report.failed.push({ file: dest, error: error.message });
      }
    }
  }

  await writeManifest(home, { version: 1, updatedAt: new Date().toISOString(), files: manifest.files });
  return report;
}

/** 技能状态（doctor / 工具用）。 */
export async function skillsStatus(options = {}) {
  const home = options.home || dshHome();
  const root = skillsRoot(home);
  const bundled = await listBundledSkills();
  const manifest = await readManifest(home);
  const items = [];
  for (const skill of bundled) {
    const target = path.join(root, skill.id, 'SKILL.md');
    const installed = await pathExists(target);
    let same = false;
    let modified = false;
    if (installed) {
      const currentHash = hashOf(await fsp.readFile(target));
      const source = hashOf(await fsp.readFile(path.join(skill.dir, 'SKILL.md')));
      same = currentHash === source;
      const knownHash = manifest.files[`${skill.id}/SKILL.md`];
      modified = Boolean(knownHash) && currentHash !== knownHash;
    }
    items.push({
      id: skill.id,
      description: skill.description,
      installed,
      synced: same,
      userModified: modified,
      path: installed ? target : null,
      source: skill.dir,
    });
  }
  return { skillsRoot: root, manifest: manifestPath(home), items };
}
