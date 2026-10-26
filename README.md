# dsh-server-log-analyzer

> DSH 插件：**服务器带外日志 + 系统日志的硬件初步分析**。
> 不管什么品牌（戴尔 / 浪潮 / 华为 / HPE / 联想 / 超微 / 曙光 / 中兴 / H3C / 富士通 / 未知品牌），
> 把日志丢进来就能给出：这是哪台机器 → 哪个部件不行了 → 要不要换件 → 换之前还要做什么。
> 每条结论都能追溯到原始行（`文件:行号`）。
>
> **想先看"这是什么东西"**（发给别人时也用这篇）：[`docs/intro.md`](docs/intro.md) —
> 一页纸介绍：能回答什么、怎么用、和关键词搜索的区别、它不做什么、隐私口径。
> 发给别人安装：`docs/install-for-others.md`；打包外发：`scripts/pack-release.ps1`。

- 插件形态：dsh profile bundle（`dsh.bundle.patch` → `cordis.patch.yml`），注册 **8** 个模型可见工具（analyze / collect / baseline / diff / rules / report / ops / doctor）
- 技能形态：3 个运维技能自动落地到 `$DSH_HOME/skills`（技能目录热发现，装完无需重启即可见）
- 独立形态：`bin/dsh-hwlog.js` 命令行，不装 dsh 也能跑（纯 Node ≥18，零第三方依赖）

---

## 一、它解决什么问题

服务器巡检/值班最常见的两件事：

1. **日志堆在眼前但看不出所以然**：SEL 里 200 行英文事件、`journalctl` 里一片 `mce:`/`AER:`，
   到底哪个是硬件坏、哪个可以观察？
2. **定性结论没有证据**：报修单写"主板可能有问题"，现场要重新定位，备件白跑一趟。

这个插件做三件事：

| 能力 | 说明 |
| --- | --- |
| **识别** | 自动判断品牌（14 类签名）、日志类型（10 种格式）、设备台账（型号/SN/BMC/BIOS/CPU/内存/系统） |
| **定性** | 57 条品牌无关规则 + 品牌事件码别名表，把日志压成"故障类"（内存 UCE、电源冗余丢失、风扇失效、RAID 降级、PCIe AER…），并给出槽位定位（DIMM A1 / PSU2 / Fan3 / Disk5 / `0000:65:00.0`） |
| **出结论** | 健康评分 + 分级（A/B/C/D）+ 根因关联链（11 类组合判断）+ 处置动作（含厂商命令）+ 证据行 |

---

## 二、支持范围

### 品牌与带外日志

| 品牌 | 管理模块 | 日志形态 | 事件码支持 |
| --- | --- | --- | --- |
| DELL 戴尔 | iDRAC | SEL（`racadm selshow`）、生命周期日志（Lifecycle Log） | `MEM0001/MEM0701/MEM0702/PWR0000/PWR0004/PWR1000/FAN0001/CPU0000/TMP0104/DRV0001/STO0003/VLT0204/BAT0000/SEC0030…` |
| HPE 慧与 | iLO | IML（`hplog -v`）、AHS | `POST Error: 207-/201-/202-/1785-/1720-`、`Uncorrectable Memory Error`、`Drive Array … degraded` |
| Lenovo 联想 | XCC / IMM | 事件日志（Redfish `EventLog`）、SEL | `FQXSPMA`（内存）/`FQXSPPW`（电源）/`FQXSPUN`（散热）/`FQXSPSD`（存储）/`FQXSPIO`（插槽）/`FQXSPBR`（主板）事件族 |
| Inspur 浪潮 | BMC | 中文/英文文本 SEL、ipmitool SEL | `PSU Failure`、`AC lost`、`DIMM xx UCE`、`RAID degraded`、`SEL Full` |
| Huawei 华为 | iBMC | `ipmcget -d sel` 键值块、一键收集包、Redfish | `Power supply unit is faulty`、`Memory UCE`、`Fan module fault`、`iBMC reset` |
| Supermicro 超微 | BMC | ipmitool SEL | `PWR Supply n`、`Memory … ECC`、`Fan n Lower Critical` |
| Sugon 曙光 / ZTE 中兴 / H3C 新华三(HDM) / Fujitsu 富士通(iRMC) | 各自 BMC | ipmitool SEL + Redfish | 走通用规则与传感器断言 |
| **其它品牌** | 任意符合 IPMI/Redfish 的实现 | SEL / Redfish LogService | 品牌无关规则兜底（无签名也能分析） |

### 导出形态（进不去 OS 时最关心的一节）

| 你手上是什么 | 本工具怎么处理 |
| --- | --- |
| `ipmitool sel save` 的 **二进制 SEL（.bin）** | 自动解码成 SEL 事件（内置 sensor type / event offset 语义表），直接出结论 |
| 厂商 **一键收集包（zip / tar.gz）** | 自动展开，按"文件名相关性"优选 SEL/健康/传感器/黑匣子（最多 120 条），递归吃里面的 .bin 与 .txt |
| BMC 网页 **导出的 HTML（表格）** | 自动清洗成行（`</td>`→`|`、`</tr>`→换行），表格直接变成 SEL 形态 |
| BMC 网页 **导出的 CSV / TXT** | 直接分析 |
| 浪潮 BMC **IDL 故障诊断日志**（管道分隔 + 8 字节事件码） | 专用解析：级别 / 部件 / 断言 / 事件码解码（型号表 + IPMI 偏移语义）/ 传感器读数与阈值；`Deassert` 视为**已恢复**（不算故障）。依据《浪潮 BMC 日志收集和分析指南 V2.5》表 3-3 与三条真实示例 |
| 华为 **iBMC ALM 告警日志**（`ALM-0x080000C1 PCIe卡CPU严重异常（PCIe Card，严重告警）`） | 靠**手册码表**命中：抽出 312 条告警码（名称 / 级别 / 部件），按部件挂到内部规则；8 位十六进制码、大小写不一致都能认 |
| **GBK / GB18030 中文导出** | 自动编码嗅探（UTF-8 → UTF-16 BOM → GBK），不会整篇乱码 |
| **Excel（.xlsx/.xls）** | 明确提示"另存为 CSV"，不静默跳过 |
| Dell 生命周期日志 / iLO IML / iBMC SEL / XCC 事件日志 / Redfish JSON | 原生支持（见上表） |

### 日志格式（自动识别，也可手动 `--format` 指定）

`ipmi-sel`（含 `sel list` / `sel elist` / 十进制与十六进制时间戳）· `idrac-lifecycle` · `ilo-iml` ·
`bmc-text`（iBMC/浪潮/XCC 文本）· `redfish-json`（`Members[]`/`Entries[]`/裸数组/NDJSON）·
`syslog`（messages/kern.log/secure，含 ISO 与 `Aug 16` 两种前缀）· `dmesg` · `journal-json` ·
`storage-cli`（smartctl / storcli / MegaCli / mdadm）· `plain`（关键字扫描兜底）

另有四种"非文本"入口会在**读取层**被自动转换，之后走完全相同的管线（详见 5.2 节）：
**二进制 SEL（.bin）** · **zip/tar.gz 一键收集包** · **HTML 网页导出** · **GBK/GB18030 编码文本**。

---

## 三、安装

### 1. 作为 dsh 插件安装（推荐）

```bash
# 在插件源码目录的上一级执行；link: 是软链，改代码后重启 dsh 即生效
dsh plugin --profile desktop add link:D:\harness\bigplumpfish\dsh-server-log-analyzer

# 验证补丁层是否进入 profile 树（不需要重启）
dsh --profile desktop --dump-config | findstr /i server-log-analyzer
```

安装后**重启 dsh**（桌面版退出再打开）：插件行随进程启动注册工具面。
技能是另一条路：它们在 `$DSH_HOME/skills` 下，技能目录被 chokidar 监视，**无需重启就已可见**。

### 2. 只当命令行工具用（不装 dsh）

```bash
node D:\harness\bigplumpfish\dsh-server-log-analyzer\bin\dsh-hwlog.js analyze .\logs --out report.md
```

### 3. 技能单独落地

```bash
node <plugin>/bin/dsh-hwlog.js skills install   # 装到 $DSH_HOME/skills
node <plugin>/bin/dsh-hwlog.js skills status    # 看状态
```

> 技能文件带内容哈希清单（`$DSH_HOME/dsh-server-log-analyzer/skills-manifest.json`）：
> 你自己改过的 SKILL.md 不会被插件覆盖。

### 三之二、打包发给别人（重要：别直接压整个目录）

源码目录里可能放着你收集的**厂商手册 PDF**（受版权文档，如 `huawei/`、`inspur/` 下的手册）与**抽取结果**，
直接压缩外发会连它们一起发出去。用插件自带脚本生成干净包：

```powershell
pwsh -File <plugin>\scripts\pack-release.ps1            # 生成 .tgz + 净化源码 zip，并自动校验
pwsh -File <plugin>\scripts\pack-release.ps1 -NoSource  # 只要 .tgz
```

脚本会：① 用 npm 白名单打 `.tgz`（内容由 `package.json` 的 `files` 决定）；② 复制出排除手册/产物后的源码 zip；
③ **校验压缩包内不含任何 PDF、不含手册目录、无超大文件**，有问题直接报错退出。

对方拿到后的安装步骤、装完"有什么/缺什么"、隐私口径、卸载方式，全在
[`docs/install-for-others.md`](docs/install-for-others.md)（该文件会随包发出去，可直接转给对方）。

> 一句话：**发 `.tgz`，别发源码目录**。厂商码表与操作条目按版权口径不随包分发 —— 对方自己下手册，
> 用插件自带脚本三步导入（`docs/install-for-others.md` 里有命令）。

---

## 四、怎么用

### 工具面（dsh 会话里直接调）

| 工具 | 用途 |
| --- | --- |
| `hwlog_analyze` | 分析日志（路径/目录/粘贴文本）→ 体检报告。参数：`paths`、`text`、`vendor`、`format`、`output`(markdown/brief/json)、`maxFindings`、`includeNoise` |
| `hwlog_collect` | 生成各品牌采集清单或可直接执行的采集脚本（`brand`/`scope`/`transport`/`asScript`） |
| `hwlog_baseline` | 存基线快照（供下次对比） |
| `hwlog_diff` | 基线与本次对比：新增 / 恶化 / 缓解 / 已恢复 |
| `hwlog_rules` | 查规则库（能识别哪些故障、覆盖哪些品牌事件码） |
| `hwlog_report` | 把结论写成报告文件（Markdown / JSON） |
| `hwlog_doctor` | 自检：规则库、探针、品牌识别、技能落地状态 |

### 命令行

```bash
# 单机分析（带外 + 系统日志一起喂）
dsh-hwlog analyze .\logs\dell-sel.log .\logs\messages --out report.md --asset node01-ABCD123

# 只想要几行摘要
dsh-hwlog analyze .\logs --brief

# 目录分析 + 结构化输出（给工单系统/入库）
dsh-hwlog analyze .\logs --json > digest.json

# 先采日志：生成采集脚本（各品牌带外 + OS 侧）
dsh-hwlog collect --brand auto --scope all --script > collect.sh

# 巡检：留基线 → 下次只看变化
dsh-hwlog baseline .\logs --out baseline-node01.json --label node01-ABCD123
dsh-hwlog diff baseline-node01.json .\logs-new --out 对比报告.md

# 看能识别什么
dsh-hwlog rules --category memory --verbose
dsh-hwlog rules --query fqxsp        # 按品牌事件码搜
dsh-hwlog doctor                     # 自检
dsh-hwlog samples                    # 用自带样例演示
```

### 输出长什么样（摘要）

```
健康评分 42.5/100（C 级 · 告警）｜文件 3 个｜记录 55 条｜命中硬件事件 44 条
告警：紧急 6 类 / 26 次　严重 5 类 / 10 次　轻微 2 类 / 4 次
设备：PowerEdge R750 / SN ABCD123 / BMC 7.10.30.00
主要问题：
  · [紧急] 内存不可纠正错误（多比特 ECC / UCE） ×3 @ DIMM:A1
  · [紧急] 电源模块失效 ×2 @ PSU:2
  · [紧急] 电源输入丢失（AC 掉电/输入超范围） ×1 @ PSU:1
根因判断：供电侧掉电 → 整机非预期宕机（疑似市电/PDU/UPS）
```

完整报告包含：结论摘要 / 设备台账（带证据行）/ 输入文件与解析覆盖 / 分级发现明细（每条带槽位、事件码、时间跨度、证据行、处置动作）/ 类别汇总 / 根因关联 / 故障时间线 / 温度要点 / 采集缺口与未识别样本 / 规则库覆盖。

---

## 五、根因关联（这是"分析"而不是"罗列"的地方）

单条告警没有意义，插件把一起出现的事实组合成故障链：

| 关联 | 组合条件 | 结论方向 |
| --- | --- | --- |
| `CR_POWER_CHAIN` | 电源输入丢失/整机掉电 + OS 非预期重启 | 供电侧（市电/PDU/UPS），不是服务器 |
| `CR_FLEET_POWER` | ≥2 台设备的日志都出现掉电 | 机房供电事件，别挨个换电源 |
| `CR_MEMORY_DEGRADE` | 内存 UCE/CE/训练失败 | UCE 立即换条；CE 看速率 |
| `CR_THERMAL_CHAIN` | 风扇/温度 + CPU 降频或过温 | 散热通道是根因，性能是表象 |
| `CR_STORAGE_CHAIN` | 硬盘失效/预警 + RAID 降级/重建 | 数据单点，先保数据再换盘 |
| `CR_PCIE_CHAIN` | AER/链路降级 + 网卡/存储/卡异常 | 插槽/riser/卡，不是上层业务 |
| `CR_BMC_CHAIN` | BMC 复位/看门狗 + 传感器类告警 | BMC 固件/NVRAM，散热电源闭环失控 |
| `CR_POST_CHAIN` | POST 报错 + 内存/CPU 级错误 | 上电即失败，最小化配置复测 |
| `CR_CE_RATE` | CE 累计 ≥100 | 内存劣化，纳入计划更换 |
| `CR_DISK_REMOVE` | 拔盘 + RAID 降级 | 核对是否有人未下线就拔盘 |
| `CR_NO_BMC_EVIDENCE` | 只有系统日志、没有带外日志 | **证据不全**，先补采再定性 |

---

## 五之二（5.2）、只有带外日志（进不去 OS）怎么办

这是现场主流场景：**目标机不能登录**，只能从 BMC 侧收集。这套工具就是按这个前提设计的。

1. **采集**：`dsh-hwlog collect --brand auto --scope bmc` 只出带外部分；如果只能导一个东西，导 `ipmitool sel save sel.bin`（或厂商一键收集 zip）—— 两者本工具都能直接吃。
2. **分析**：`dsh-hwlog analyze sel.bin` / `analyze onekey-collect.zip` / `analyze bmc-export.html`，或直接把这些文件丢给会话里的 `hwlog_analyze`。
3. **结论边界**（工具会在报告里明说，不假装证据齐全）：
   - ✅ 成立：部件级定性 —— 谁坏了（DIMM B1 / PSU2 / Fan3 / Disk5 / `0000:65:00.0`）、要不要换件、换前还要做什么、是否属于供电/机房级事件；
   - ⚠️ 缺 OS 证据：业务影响的具体形态（内核 MCE/EDAC 计数、文件系统只读、SMART 明细、I/O 超时）。报告会给 `CR_BMC_ONLY` 关联项，列出替代证据（BMC 温度曲线、RAID 卡硬盘状态、业务监控时间点）与"报修单该怎么写"。
4. **常见导出陷阱**（已逐条处理，见"导出形态"表）：GBK 乱码、HTML 表格被当纯文本、一键收集包被当二进制跳过、`.bin` 只能靠人眼看不懂、xlsx 读不了。

> 一句话：**只有带外，硬件结论照样给；但它会明确告诉你"业务影响这一层我没有证据"，而不是编一个。**

## 五之三（5.3）、运维操作库（runbook）：命令与步骤也是资产

事件码回答"这是什么故障"，**运维操作库回答"现在该敲什么命令、点哪个菜单"**。

- 数据来源：厂商手册抽取（`scripts/extract-vendor-ops.py`）+ 插件自带通用基线（`data/ops-runbooks/generic-baseline.json`）；用户导入放 `$DSH_HOME/server-log-analyzer/ops-runbooks/`；
- 四类条目：`command`（命令）/ `ui`（界面路径）/ `step`（处理步骤）/ `check`（检查项）；
- 两种用法：
  - **联动**：`hwlog_analyze` 的每条发现自动附上相关操作（命令 / 步骤 / 界面路径），报告直接可执行；
  - **检索**：工具 `hwlog_ops`，或 CLI `dsh-hwlog ops search|list|import|path`；
- 已抽入库（248 条）：华为 RAID 控制卡用户指南（**命令级 133 条**）、浪潮 BMC 用户手册（界面路径为主）、华为 iBMC 告警处理（处理步骤）、联想 XCC 消息参考（用户操作）。

```powershell
dsh-hwlog ops search "RAID 保留缓存" --limit 3     # 这类故障该敲什么命令
dsh-hwlog ops search "电源模块" --kind step        # 只看处理步骤
dsh-hwlog ops list --brand huawei --kind command   # 列某品牌所有命令条目
python <plugin>\scripts\extract-vendor-ops.py --pdf <手册.pdf> --brand huawei --source "..." --version "35" --out data\ops-runbooks
dsh-hwlog ops import <抽取出的 JSON>
```

> 抽取策略是**少而准**：页眉页脚、以及在手册里反复出现的套话会被"行频 + 是否像动作句"过滤掉 —— 实测踩过坑：过滤过狠会把"请联系技术支持"这类真实处置句一起删（iBMC 从 201 条被压到 29 条）。

## 六、诚实边界（避免误用）

1. **它不连设备、不采集、不修改任何东西**：只读日志文件 + 生成命令清单。采集要你自己在跳板机上执行（`hwlog_collect` 给命令/脚本）。
2. **时间戳是"日志里写的"**：带外时钟常漂移，`syslog` 无年份时用当前年兜底。跨源因果关系前请自行对齐时间（报告里会给出时间跨度帮你判断）。
3. **品牌事件码覆盖是"常用集"**，不是厂商全量码表：未命中的行会以"未识别硬件行"原样列出（含出现次数），照着补规则即可（见下）。
4. **规则命中≠换件结论**：分级与建议是"初判"，必须结合最小化复测与厂商手册。插件在报告里刻意区分"要立刻处置"和"可观察"。
5. **健康评分是相对量**：扣分按"同类告警严重度 × 重复次数（对数放大，封顶 2.5 倍）"，用于同一台机器纵向对比（基线/差异），不要跨机型横向比大小。

---

## 六之二、用手册当码表（最好别手写码表）

厂商手册是最好的码表来源。本插件把这件事做成**数据，而不是代码**：

```powershell
dsh-hwlog codes path        # 两个码表目录：插件自带模板 / 你的导入目录
dsh-hwlog codes list        # 已加载码表（品牌 · 来源 · 版本 · 条数）

# 把手册导出的表格（CSV/TSV）或 JSON 导进来，立刻生效，不用改一行代码
dsh-hwlog codes import .\dell-event-reference-2026.csv --brand dell `
    --source "Dell Event and Error Message Reference Guide" --version 2026-01
```

- **CSV 表头**（中文表头也认）：`code,meaning,severity,rule,category,action`（事件码/描述/级别/内部规则/类别/处置）。
- **JSON**：`{ "brand":"dell", "source":"...", "version":"...", "codes": { "MEM0701": { "meaning":"...", "severity":"minor", "rule":"MEM_CE", "action":"..." } } }`
- **同码覆盖**：你的导入优先于插件自带模板与内置别名表；`rule` 字段把码挂到内置语义上（继承聚类与跨源关联），不写 `rule` 就按手册的 `category/severity` 独立成事件。
- 报告里每条都会标 **语义来源**（哪本手册、哪个版本）+ **（手册建议）** 动作，便于复核。
- 示例格式见 [docs/example-vendor-codes.csv](docs/example-vendor-codes.csv)；自带模板见 `data/vendor-codes/*.template.json`。

**手册能顶哪一层（重要）**：

| 层 | 手册能不能顶 | 谁负责 |
| --- | --- | --- |
| 码 → 语义 / 严重度 / 建议动作 | ✅ 能，越全越好 | `data/vendor-codes/*.json`（手册驱动） |
| 分类归属（属哪类故障） | ✅ 能（`category` 字段） | 同上 |
| 日志句法 / 格式 / 时间戳形态 | ❌ 不能（手册不写"日志长什么样"） | `io.js` / `parse.js`（靠真实样本） |
| 换件阈值、观察还是换件 | ⚠ 部分（手册常写"联系技术支持"） | `rules.js` 的 advice（运维经验） |
| 跨源关联（掉电↔宕机、AER↔网卡） | ❌ 不能（手册是单条事件语义） | `analyze.js` 的 12 条关联 |

**版权口径**：手册是受版权文档。插件**不分发**手册内容 —— 包内只有示例模板（我写的映射 + 来源标注）；你把手册导出的表格导入到**本机** `$DSH_HOME/server-log-analyzer/vendor-codes/`，属于你自己保存和使用你有权访问的文档。要把码表拿去对外分享前，先确认来源许可。

### 用脚本把厂商手册变成码表（已实测跑通）

```powershell
# 1) 抽码：PDF 用 PyMuPDF 引擎（41MB/3800 页手册约 2 分钟），HTML 直接喂
python <plugin>\scripts\extract-vendor-codes.py --pdf <手册.pdf> --brand dell `
    --source "手册全名" --version "版本" --out manuals\out --dump-text manuals\out\dell-text.txt

# 2) 后处理：补类别/严重度 + 把码挂到内部规则上，输出插件码表 JSON（落到 $DSH_HOME）
node <plugin>\scripts\codes-postprocess.mjs --csv manuals\out\dell-codes.csv --brand dell `
    --source "手册全名" --version "版本" --sample 10
```

后处理会**从码本身推断类别与严重度**，不必人读原文：

- **Lenovo**：`FQXS` + 3 字母域（`PCA` 处理器 / `PMA` 内存 / `PPW` 电源 / `PUN` 散热 / `PSD` 存储 / `PEM` RAID / `PIO` 插槽 / `PBR` 主板 / `PSM` BMC / `PSE` 安全）+ 尾字母（`I`=info / `N`,`W`=minor / `M`=critical）；
- **Dell**：`MEM/PWR/CPU/FAN/TMP/VLT/DRV/STO/BAT/SEC/RAC/WDG` 前缀 → 类别，并把码挂到对应内部规则（因此能参与聚类与跨源关联）。

**实测结果**：Dell PowerEdge *Error and Event Messages Reference Guide* → **7145 条**（100% 带描述、99.7% 带严重度）；Lenovo *SR650 V3 消息和代码参考（简体中文）* → **812 条**（严重度用事件码尾字母 I/N/W/M 定，比扫文本可靠）；华为 *TaiShan iBMC 告警处理 V19* → **312 条**（`--mode alm` 抽 `ALM-0x… 名称（部件，级别告警）`）。三份合计后 `doctor` 显示 **8610 条码映射**，手册独有码从"未识别事件"变成带语义来源的可处置事件。

**两个踩过的坑**（已修，写在这里省得你再踩）：
1. CJK 紧贴事件码会让 `\b` 失效（`FQXSPCA0017M은`）→ 边界改用"前后非字母数字"断言；
2. Lenovo 事件码是 `FQXS`+3 字母+4 位数字+严重度字母（共 12 字符），正则写成"恰好 2 个字母"会**全部漏掉**（引擎侧当时也漏，Lenovo 码表路径其实从未生效，是靠英文文本措辞兜住的）。

> 抽取是"机器抽取 + 抽样核查"，不是全自动入库：手册排版千差万别（跨页表、多列、CJK 粘连），务必抽查 10~20 条与原文逐字对照再信。

## 七、扩展规则（30 秒上手）

`lib/engine/rules.js`：

```js
{
  id: 'MY_NEW_FAULT',            // 规则 id（报告里的聚类键）
  cat: 'power',                  // 类别：memory/cpu/power/thermal/storage/raid/pcie/network/firmware/board/security/os/other
  sev: 'critical',               // critical | major | minor | info
  title: '我的新故障（中文一句话）',
  patterns: [/your\s+regex/i],   // 描述型日志用正则
  codes: { dell: ['PWR9999'], lenovo: ['FQXSPPW'] },  // 编码型日志用码表/前缀族
  advice: ['现场第一步做什么', '什么条件才换件'],
}
```

补完自检：`dsh-hwlog doctor`（内置探针）+ `dsh-hwlog rules --query 你的关键字`。
想验证新规则对真实日志的命中：`dsh-hwlog analyze <文件> --brief` 看"未识别"是否下降。

---

## 八、目录结构

```
dsh-server-log-analyzer/
├── package.json              # dsh.bundle.patch 声明（被 dsh 识别为插件包）
├── cordis.patch.yml          # 插件行：id/name/config（enabled/installSkills/maxFindings/reportDir）
├── lib/
│   ├── index.js              # cordis 插件入口：注册 7 个工具 + 技能自动落地
│   ├── runtime.js            # defineTool 跨安装形态解析、配置归一化、dshHome
│   ├── skills-install.js     # 技能落地（哈希清单，不覆盖用户修改）
│   └── engine/
│       ├── text.js           # 时间戳/槽位/温度/计数/严重度 工具层
│       ├── rules.js          # 57 条品牌无关规则 + 品牌事件码别名表
│       ├── detect.js         # 品牌/格式识别 + 设备台账抽取
│       ├── parse.js          # 各格式 → 统一事件模型（含噪音过滤、覆盖率统计）
│       ├── analyze.js        # 聚类/评分/根因关联/时间线
│       ├── report.js         # Markdown 报告 + 摘要 + JSON digest
│       ├── collect.js        # 各品牌采集清单/脚本
│       ├── diff.js           # 基线/对比
│       └── io.js             # 文件收集与读取（跳过二进制、限流）
├── bin/dsh-hwlog.js          # CLI（analyze/collect/baseline/diff/rules/report/doctor/samples/skills）
├── skills/                   # 三个运维技能（自动落地到 $DSH_HOME/skills）
│   ├── server-hw-log-triage/     # 硬件日志初判流程
│   ├── bmc-log-collection/       # 各品牌带外/OS 采集速查
│   └── hardware-fault-playbook/  # 部件级处置手册（阈值/换件条件/证据保全）
├── samples/                  # 17 份样例（含 GBK 中文 / HTML 导出 / zip 一键收集包 / 二进制 SEL）
├── scripts/                  # 手册工具链：inspect-manual.py（侦察）/ extract-vendor-codes.py（抽码）/ codes-postprocess.mjs（入库）
├── data/vendor-codes/        # 码表（数据驱动）：厂商手册导入这里的格式，改手册不用改代码
├── docs/vendor-codes.md      # 品牌事件码与日志形态速查
├── docs/example-vendor-codes.csv  # 手册导出 → 码表 的示例表格
└── test/run-tests.mjs        # 29 组自测（含只有带外四形态、手册码表、浪潮 IDL）
```

---

## 九、自测

```bash
node --test test/run-tests.mjs test/plugin-registration.mjs   # 29 组断言（含"只有带外"四形态、手册码表、浪潮 IDL）
node bin/dsh-hwlog.js doctor       # 插件与技能状态自检
node bin/dsh-hwlog.js samples      # 拿样例跑一份完整报告
```

> `samples/` 里的 17 份样例是**合成的**（虚构主机名、槽位、时间，不含任何真实生产环境信息），
> 且**故意造得很糟**（内存 UCE + 电源失效 + 风扇停转 + RAID 降级 + 掉电重启），
> 所以样例集评分是 D 级 —— 这不是误报，是样例本身就这样。
>
> 样例属于测试资产：若被误删，`node test/run-tests.mjs` 会**点名缺哪几个并 skip 依赖它们的断言**（不是整套红掉），
> 用 `git checkout -- samples` 恢复即可。
