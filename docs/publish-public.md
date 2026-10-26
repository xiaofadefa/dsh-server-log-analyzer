# 把插件上传/公开分享出去（公共分发）

> DSH 没有「官方上传入口」那种东西 —— 公共分发由三块拼成：
> **① 一个可被别人安装的包**（npm 公共源 / 公开 Git 仓库 / 公开 tarball 直链）
> **② 一个市场索引 JSON**（别人在「插件 → 发现 → 添加索引源」填它的 URL，就能看到并一键装）
> **③ 一条社区注册表条目**（进公共列表，被搜到、被推荐）
>
> 三者互相独立，可以只做 ①，也可以全做。做完 ① 就已经算"公开了"。

本文档对应的文件：

| 文件 | 作用 |
| --- | --- |
| `scripts/make-market-index.mjs` | 生成 `market/index.json`（format 1，已用 DSH 自带校验器验证通过） |
| `market/index.json` | 生成好的索引，托管出去就能当索引源 |
| `LICENSE` | MIT 授权（原 `package.json` 已声明 MIT 但缺文件） |

---

## 一、发布前体检（三项，都可离线做）

```powershell
cd D:\dafeiyu\dsh-plugins\dsh-server-log-analyzer

# 1) 打包预演：确认 files 白名单带上的东西对，且没有厂商手册 PDF 混进来
npm pack --dry-run
pwsh -File scripts\pack-release.ps1 -NoSource     # 生成 .tgz 并做 PDF/大文件自检

# 2) 名字可用性（已实测：npm 上 404，未被占用）
npm view dsh-server-log-analyzer version

# 3) 本机能否安装（装自己，验证 bundle patch 生效）
dsh plugin --profile desktop add "$PWD\dist\dsh-server-log-analyzer-1.0.0.tgz"
```

已经就绪的部分（不用改）：

- `package.json` 有 `dsh.bundle.patch` → 是**合法 bundle**，`dsh plugin add` 认；
- `lib/` 是纯 ESM JS，**无构建步骤、零第三方依赖** → Git 安装也不会卡在 build；
- `files` 白名单已含 `lib bin scripts skills docs data samples cordis.patch.yml README.md`；
- 未声明 `@deepseek-ai/dsh*` 的 peer，只有 `@deepseek-ai/cordis ^4.0.1` → 不受 0.1.7-rc.1 起的 peer 门禁影响。

建议顺带补的两处（可选，但公共分发建议加）：

```jsonc
// package.json
"repository": { "type": "git", "url": "git+https://github.com/OWNER/dsh-server-log-analyzer.git" },
"homepage": "https://github.com/OWNER/dsh-server-log-analyzer#readme",
"engines": { "node": ">=18", "dsh": ">=0.1.0-rc.6" }   // 0.2.1-alpha.4 起 engines.dsh 单独决定兼容性
```

> `engines.dsh` 一旦写上就以它为准：范围要覆盖你打算支持的**所有** dsh 版本（含预发布），写窄了对方会被 `dsh plugin add` 直接拒装。

---

## 二、通道 A：npm 公共源（最推荐，别人的安装最省事）

```powershell
npm adduser                      # 或 npm login（首次需要，本机当前未登录）
npm publish --access public      # 无 scope 包名，直接 public
# 若改成 scope 名（如 @yg/dsh-server-log-analyzer），先改 package.json 的 name 再发布
```

发布后别人两种装法都对：

```powershell
dsh plugin --profile desktop add dsh-server-log-analyzer          # 最新版
dsh plugin --profile desktop add dsh-server-log-analyzer@1.0.0    # 精确版本
```

GUI：侧边栏 **插件 → 添加插件**，输入框里填 `dsh-server-log-analyzer`。

注意：

- 国内镜像（npmmirror）**只同步已发布到 npm 的包**，所以先发 npm，镜像自然会有；GitHub 直连失败时 DSH 的安装对话框会提示「改用国内镜像」，那条路只在包已上传 npm 时成立；
- 升级流程是**卸载后重装**（DSH 目前没有 upgrade 操作）：`dsh plugin --profile desktop remove ...` 再 `add`。

---

## 三、通道 B：GitHub 公开仓库（源码可见 + 自动被社区发现）

```powershell
cd D:\dafeiyu\dsh-plugins\dsh-server-log-analyzer
git init; git add -A; git commit -m "feat: dsh-server-log-analyzer 1.0.0"
git branch -M main
git remote add origin https://github.com/OWNER/dsh-server-log-analyzer.git
git push -u origin main
git tag v1.0.0; git push --tags
```

仓库设置里加 topic：**`dsh-plugin`**（`dsh-plugins` / `dsh-bundle` / `dsh-skill` 也在扫描范围内）——社区注册表的定时任务会扫这些 topic，自动把你排进候选队列。

别人装法（`dsh plugin add` 接受的全部 Git 形式）：

```powershell
dsh plugin --profile desktop add github:OWNER/dsh-server-log-analyzer   # 简写
dsh plugin --profile desktop add https://github.com/OWNER/dsh-server-log-analyzer  # 仓库 URL
dsh plugin --profile desktop add git+https://github.com/OWNER/dsh-server-log-analyzer.git
```

> Git 安装是**克隆整个仓库**（不是只取 `files` 白名单）：所以厂商手册 PDF、抽取产物**绝不能进仓库**，用 `scripts/pack-release.ps1` 的排除清单当 `.gitignore` 参考。

**Release 附件路线**（不想发 npm 时最轻）：把 `pack-release.ps1` 产出的 `.tgz` 传到 GitHub Release，别人填那个直链：

```powershell
dsh plugin --profile desktop add https://github.com/OWNER/dsh-server-log-analyzer/releases/download/v1.0.0/dsh-server-log-analyzer-1.0.0.tgz
```

---

## 四、通道 C：市场索引 → 出现在「发现」标签页

「发现」读的是**用户自己配置的索引源**，Host 不内置任何公共索引，所以"上传"= 把一份 `index.json` 托管到一个 https 静态地址，然后把这个 URL 给出去。

1. 生成索引（已生成过；改了版本/来源就重跑）：

```powershell
# npm 源（推荐）
node scripts/make-market-index.mjs --source npm --author YG `
  --title-zh "服务器硬件日志研判" --title-en "Server Hardware Log Triage" `
  --desc-en "BMC/IPMI/iDRAC/iLO hardware log triage: rules, scoring, reports, baselines"

# 或 git 源（需要公开仓库 + 已提交的 HEAD，脚本自己取 commit）
node scripts/make-market-index.mjs --source git --author YG
```

2. 托管：任选一个 https 静态地址（GitHub Pages / 自己的对象存储 / 反代到内网都行）。
   例：把 `market/` 提交进 `gh-pages`，最终 URL 形如
   `https://OWNER.github.io/dsh-server-log-analyzer/market/index.json`
3. 让对方打开：**插件 → 发现 → 添加索引源**，粘贴上面的 URL。
   注意 Host 校验要求：`http:`/`https:`、**不含账号密码、不含 `?` 和 `#`、不跟随重定向**（要跳转就填最终地址）。

索引格式（format 1）关键约束，脚本已按此校验：

- 顶层 `format: 1`、`title`（本地化对象必须含 `en`）、`plugins[]`；
- 每个版本必须有 `version`（精确 SemVer）、`publishTimestamp`（整数秒）、`source`；
- `source.type: "npm"` → 装 `name@version`；`source.type: "git"` → 必须有 40 位小写 `commit` 和 https 仓库地址，装 `git+URL.git#commit`；
- `metadata.category` / `metadata.labels` 引用的 id 必须在顶层 `metadata` 里声明过；
- `icon` 只能是 `data:` 内联图（≤32 KiB）或 https / 同源相对路径。

> 想让「发现」这个标签页出现，需要先启用官方可选组合包 `@deepseek-ai/dsh-experimental-plugin-market-bundle`：
> **插件 → 实验性插件 → 启用**（默认关闭，官方随附、不可卸载）。

---

## 五、通道 D：进社区公共注册表（被别人搜到）

公共注册表：`dshworks/awesome-dsh-plugins`（数据源是 `data/plugins.json`，README 由脚本生成；站点 <https://dsh.works/awesome-dsh-plugins/>，其「发现」索引在
`https://dsh.works/awesome-dsh-plugins/market/index.json` —— 这个 URL 可以直接在 DSH 里当索引源）。

做法：fork → 在 `data/plugins.json` 的 `plugins` 数组加一条 → 本地跑 `node scripts/validate.mjs && node scripts/render.mjs` → 提 PR（CI 跑同样两条）。

可直接用的条目（把 `OWNER` 和日期换成实际值）：

```json
{
  "name": "dsh-server-log-analyzer",
  "repo": "OWNER/dsh-server-log-analyzer",
  "npm": "dsh-server-log-analyzer",
  "description": "Server hardware log triage for DSH: BMC/IPMI/iDRAC/iLO SEL parsing, grading, reports and baselines.",
  "category": "bundle",
  "tags": ["observability", "capabilities"],
  "added": "2026-10-26",
  "lastVerified": "2026-10-26",
  "verifiedAgainst": "0.1.0-rc.6",
  "status": "unverified",
  "evidence": "package.json#dsh.bundle"
}
```

门槛（摘自其 CONTRIBUTING，逐条对照本插件）：

| 门槛 | 本插件 |
| --- | --- |
| 真实安装路径 | ✅ `package.json#dsh.bundle` + 已发布 npm 包 |
| 不是换壳模板 | ✅ 原创引擎（规则库/报告/基线） |
| 在 `verifiedAgainst` 上能加载 | ✅ 本机 `dsh --version` = `0.1.0-rc.6`，工具面已实际跑通 |
| `npm` 字段必须是**真的发布过**的名字 | ⚠ 先做通道 A，否则 404 会被 `npm-check` 摘掉该字段 |
| 描述诚实、不堆关键词 | ✅ |

> `status` 写 `unverified` 会被接受；只有 `verified` 需要 `evidence` 指向文件。别人替你复核后会自动升级。
> 另有 `awesome-dsh-plugin/awesome-dsh-plugin` 这个列表也收条目，可一并提。

---

## 六、给对方的话：四种装法对照

| 你给的 | 对方填 |
| --- | --- |
| npm 包名 | `dsh-server-log-analyzer`（可带 `@1.0.0`） |
| GitHub 仓库 | `github:OWNER/dsh-server-log-analyzer` 或仓库 https URL |
| Release 里的 tgz | `https://…/dsh-server-log-analyzer-1.0.0.tgz` |
| 离线 tgz / 源码目录 | 本机绝对路径 `D:\…\dsh-server-log-analyzer-1.0.0.tgz` 或 `D:\…\dsh-server-log-analyzer` |
| 市场索引 | 插件 → **发现** → 添加索引源 → 索引 URL，之后点「安装」 |

CLI 等价：`dsh plugin --profile <profile> add "<上面任一形式>"`。

装完：**重启 DSH**（工具面在启动时注册；3 个技能是文件监听热发现，不用重启），自检 `dsh-hwlog doctor` 或让 AI 调 `hwlog_doctor`。

---

## 七、公开分发的红线

- **厂商手册 PDF 与其抽取结果不进任何公开产物**（受版权文档）：仓库加 `.gitignore`、发包靠 `files` 白名单、`pack-release.ps1` 已做 PDF/大文件自检；
- 报告里会带原始日志行（IP / 主机名 / 序列号）——公开 README 与 issue 里贴输出前先脱敏；
- `LICENSE` 已补 MIT；若要换协议（如 Apache-2.0）同时改 `package.json.license` 与文件。
