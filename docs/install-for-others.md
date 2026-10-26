# 把插件装到别人的机器上

> 分发物只有两种：**插件包 `.tgz`（推荐）** 或 **净化后的源码 zip**。
> 不要把整个源码目录直接压缩外发 —— 该目录里可能放着你收集的**厂商手册 PDF**（受版权文档）与**抽取结果**，
> 用 `scripts/pack-release.ps1` 一键生成干净包即可。

## 一、对方的前置条件

| 项目 | 要求 |
| --- | --- |
| DSH | 已安装 DSH（桌面版或全局 CLI）。CLI 建议 `npm i -g @deepseek-ai/dsh@latest`（老版本读配置会报错） |
| Node.js | 随 DSH 自带运行时即可，无需额外安装 |
| 依赖 | **零第三方依赖**（只用 Node 内置模块），不需要联网装包 |

## 二、安装（三种方式任选）

**方式 A：插件包（推荐）**

对方把 `dsh-server-log-analyzer-<版本>.tgz` 放到任意路径，然后：

```powershell
dsh plugin --profile desktop add "C:\path\to\dsh-server-log-analyzer-1.0.0.tgz"
```

桌面版也可以走 GUI：侧边栏「插件」页 → **添加插件** → 选那个 `.tgz`（该输入框同样接受包名 / Git 地址 / 本地绝对路径）。

**方式 B：源码目录（开发/改代码用）**

解压净化后的源码 zip，然后：

```powershell
dsh plugin --profile desktop add "C:\path\to\dsh-server-log-analyzer"        # 本地目录
# 或（开发时改动即时生效）
dsh plugin --profile desktop add "link:C:\path\to\dsh-server-log-analyzer"
```

**方式 C：内网 npm / Git 仓库**

```powershell
dsh plugin --profile desktop add "@your-scope/dsh-server-log-analyzer"
dsh plugin --profile desktop add "https://your-git/dsh-server-log-analyzer.git"
```

## 三、生效与验证

1. **重启 DSH**（工具面在启动时注册；技能是文件监听热发现，不必重启）；
2. 自检：`dsh-hwlog doctor`（不依赖 DSH，可直接跑）或让 AI 调 `hwlog_doctor`；
   期望看到：规则库 61 条 ✅ / 技能 3 个 ✅ / 样例解析 ✅（码表与操作库显示为**自带模板**数量）；
3. 验证工具面：让 AI 调一次 `hwlog_analyze`（比如分析插件自带的 `samples/` 目录），能看到 D 级评分与发现列表即成功。

## 四、对方装上后"有什么、缺什么"（重要）

| 能力 | 状态 |
| --- | --- |
| 58+ 条硬件规则、12 类故障、跨源关联、报告/基线/对比 | ✅ 随包自带，开箱可用 |
| 3 个技能（采集清单 / 研判流程 / 处置手册） | ✅ 自动安装到 `$DSH_HOME/skills` |
| 自带样例（`samples/` 17 份：二进制 SEL、GBK 中文导出、HTML 导出、zip 一键收集包、syslog/dmesg 等） | ✅ 可直接跑通全流程 |
| 厂商**事件码表**（Dell/Lenovo/华为/浪潮手册抽取） | ⚠ **不随包分发**（版权原因）。对方自己下手册后三步导入 |
| 厂商**操作条目**（命令/界面路径/处理步骤） | ⚠ 同上；但自带 10 条通用取证基线（SEL / RAID 三连 / SMART / 供电 / 散热 / PCIe） |

对方要补齐码表/操作库（都用插件自带脚本，不需要改代码）：

```powershell
# 1) 抽事件码（PDF），2) 后处理入库，3) 核对
python <plugin>\scripts\extract-vendor-codes.py --pdf <手册.pdf> --brand dell `
    --source "手册全名" --version "版本" --out .\out
node   <plugin>\scripts\codes-postprocess.mjs --csv .\out\dell-codes.csv --brand dell --version "版本"
dsh-hwlog codes list

# 操作条目同理
python <plugin>\scripts\extract-vendor-ops.py --pdf <手册.pdf> --brand huawei --source "..." --version "35" --out .\out
dsh-hwlog ops import .\out\huawei-ops-35.json
```

> 码表与操作库落在**对方自己的** `$DSH_HOME\server-log-analyzer\{vendor-codes,ops-runbooks}`，不进插件包、也不影响插件升级。

## 五、隐私与安全口径（对方一定会问）

- 引擎（解析/规则/评分/报告/基线）**100% 本地离线**：`lib/` 里没有任何网络请求；
- `hwlog_collect` 只**生成**命令清单与脚本（含 `BMC_IP` 占位），要不要执行、在哪执行由使用者决定；
- 日志内容何时离开本机，取决于**怎么用**：走 DSH 对话层 → 日志片段会进模型上下文；只用 CLI（`dsh-hwlog analyze <路径> --out 报告.md`）→ 全程不联网；
- 生成的报告默认写到插件配置的 `reportDir`（可改），里面会包含原始日志行引用 —— 外发报告前先确认是否含敏感信息（IP/主机名/序列号）。

## 六、卸载

```powershell
dsh plugin --profile desktop remove dsh-server-log-analyzer
```

技能目录 `$DSH_HOME\skills\{server-hw-log-triage,bmc-log-collection,hardware-fault-playbook}` 与数据目录
`$DSH_HOME\server-log-analyzer\` 需手工删除（插件不主动删用户数据）。
