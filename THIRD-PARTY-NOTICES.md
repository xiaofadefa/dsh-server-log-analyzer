# 第三方声明与内容来源

本文件说明本项目的代码来源、数据来源，以及**明确不随仓库/包分发**的内容。

## 一、代码

本项目为原创实现，按 MIT 许可发布（见 [`LICENSE`](../LICENSE)）。

以下为**实现思路参考**（未复制其代码；MIT 许可允许借鉴，此处保留出处以示尊重）：

| 项目 | 许可 | 参考点 |
|---|---|---|
| [dsh-purge](https://github.com/YuJunZhiXue/dsh-purge) | MIT | `lib/runtime.js`：以「锚点 package.json → createRequire」逐级解析宿主模块，全部失败时退化为原样注册 |
| 同上 | MIT | `lib/runtime.js`：把工具执行异常收敛成结构化失败返回的约定 |

若后续有任何代码片段直接取自第三方项目，将在此逐条列出并随附其完整许可文本。

## 二、数据与文档

| 路径 | 内容来源 |
|---|---|
| `data/ops-runbooks/generic-baseline.json` | 作者自写的通用取证/处置基线；命令为公开的 `ipmitool` / `racadm` 用法 |
| `data/vendor-codes/*.template.json` | 仅含**事件码标识符（事实性短标识）**与作者自行转述的中文含义，作为格式示例 |
| `docs/example-vendor-codes.csv` | 同上，演示导入码表的 CSV 格式 |
| `samples/`、`test/` | 全部为**合成数据**：虚构的主机名、DIMM 槽位、时间戳，不含任何真实生产环境信息 |

**本仓库不包含任何厂商手册原文、也不包含手册的抽取结果。** 事件码与日志格式属于事实性信息，其描述性文字均为本项目自行撰写，未照录手册表述。

## 三、不随仓库 / 包分发的内容

厂商手册 PDF 及其抽取产物（事件码全表、操作条目全文）受版权保护，**不进入本仓库、不进入 npm 包、不进 Release 附件**。需要完整码表时：

```powershell
# 自行获取官方手册后，在本地抽取（结果落在 $DSH_HOME，不提交）
python scripts/extract-vendor-codes.py --pdf <手册.pdf> --brand <品牌> --source "<手册全名>" --version "<版本>" --out .\out
node scripts/codes-postprocess.mjs --csv .\out\<brand>-codes.csv --brand <品牌> --version "<版本>"
```

## 四、商标

Dell、PowerEdge、iDRAC、HPE、iLO、Lenovo、XClarity、Inspur、Huawei、iBMC、Supermicro、Sugon、ZTE、H3C、Fujitsu 等名称与标识为其各自所有者的商标。本项目提及这些名称仅为说明**兼容性**，与上述公司无隶属或背书关系。
