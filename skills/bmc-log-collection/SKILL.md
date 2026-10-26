---
name: bmc-log-collection
description: 各品牌服务器带外日志与硬件快照的采集命令速查（DELL iDRAC、HPE iLO、Lenovo XCC、浪潮 BMC、华为 iBMC、超微、曙光、中兴、H3C、富士通 iRMC、通用 IPMI/Redfish）与 OS 侧采集清单。
whenToUse: 需要指导用户"怎么把带外日志、传感器、FRU、固件版本导出来"，或要生成一份可执行的采集脚本时。
---

# 带外与系统日志采集速查

原则：**先采集，再清理**。清 SEL / 重启 BMC 之前，必须先导出留证；SEL 一旦被 clear，历史劣化趋势（CE 计数、掉电次数、掉盘记录）就没了。

## 一、通用双路径（几乎所有品牌都适用）

```bash
# IPMI over LAN（端口 623/udp）——最通用
ipmitool -I lanplus -H $BMC_IP -U $BMC_USER -P "$BMC_PASS" sel elist > sel.log
ipmitool -I lanplus -H $BMC_IP -U $BMC_USER -P "$BMC_PASS" sel save sel.bin   # 二进制留证
ipmitool -I lanplus -H $BMC_IP -U $BMC_USER -P "$BMC_PASS" sensor > sensor.log
ipmitool -I lanplus -H $BMC_IP -U $BMC_USER -P "$BMC_PASS" sdr type Temperature
ipmitool -I lanplus -H $BMC_IP -U $BMC_USER -P "$BMC_PASS" fru > fru.log
ipmitool -I lanplus -H $BMC_IP -U $BMC_USER -P "$BMC_PASS" mc info        # BMC 固件/IPMI 版本

# Redfish（HTTPS/443）——字段最结构化，脚本化首选
curl -k -u "$BMC_USER:$BMC_PASS" "https://$BMC_IP/redfish/v1/Systems/1/LogServices"
curl -k -u "$BMC_USER:$BMC_PASS" "https://$BMC_IP/redfish/v1/Managers/1/LogServices"
# 再按返回的 @odata.id 取 Entries（各品牌路径不同，但一定先列 LogServices）
```

Redfish 取日志时加 `?$expand=*($levels=1)` 可以一次把条目展开，省掉逐条 GET。

## 二、分品牌要点

### DELL（iDRAC / Lifecycle Controller）
```bash
racadm selshow                       # SEL
racadm lclog view -i 200             # 生命周期日志（固件/配置变更都在这）
racadm getsysinfo && racadm getversion -l -b -f
racadm getsensorinfo                 # 温度/风扇/电压/功耗
racadm hwinventory > hwinventory.xml # DIMM 槽位 ↔ 丝印对应（换内存前必看）
racadm supportsave -t 0              # 深度排查时的一键支持包
# Redfish: /redfish/v1/Managers/iDRAC.Embedded.1/LogServices/Lclog/Entries
#          /redfish/v1/Systems/System.Embedded.1/LogServices/Sel/Entries
```
要点：**生命周期日志（LCLog）是 Dell 独有优势**，配置/固件变更、部件更换记录都在里面，判"什么时候动过什么"必看。

### HPE（iLO / IML / AHS）
```bash
hplog -v > iml.log                   # IML 集成管理日志
hplog -t && hplog -f && hplog -p     # 温度 / 风扇 / 电源快照
hpasmcli -s "show iml; show server; show dimm; show powersupply; show fans"
ilorest login $BMC_IP -u $BMC_USER -p "$BMC_PASS" && ilorest get --select Logs
# Redfish: /redfish/v1/Systems/1/LogServices/IML/Entries
# AHS: POST /redfish/v1/Managers/1/ActiveHealthSystemLog  {"Action":"Download"}
```
要点：HPE 的 **AHS（主动健康日志）** 是深度取证的杀手锏，SEL/IML 之外还有传感器历史曲线。

### Lenovo（XCC / IMM）
```bash
ipmitool -I lanplus -H $BMC_IP -U $BMC_USER -P "$BMC_PASS" sel elist
curl -k -u "$BMC_USER:$BMC_PASS" "https://$BMC_IP/redfish/v1/Systems/1/LogServices/EventLog/Entries?$expand=*($levels=1)"
# XCC 网页 → 服务 → 事件日志 → 导出 CSV
```
要点：XCC 事件码形如 `FQXSPMA0011M`，**按前缀族归类**最稳（MA 内存 / PW 电源 / UN 散热 / SD 存储 / IO 插槽 / BR 主板）。

### 浪潮 Inspur（NF 系列 BMC）
```bash
ipmitool -I lanplus -H $BMC_IP -U $BMC_USER -P "$BMC_PASS" sel elist > inspur-sel.log
ipmitool -I lanplus -H $BMC_IP -U $BMC_USER -P "$BMC_PASS" sensor > inspur-sensor.log
# BMC 网页 → 日志 → 系统事件日志 → 导出（中文事件文本）
```
要点：不同固件版本 Redfish 的 LogServices 名可能是 `Log1`/`SEL`，先 GET `LogServices` 列清单再取。

### 华为 iBMC（FusionServer）
```bash
ipmcget -d sel -v list > ibmc-sel.log      # 部分版本: ipmcget -d sel
ipmcget -d sensor -v list > ibmc-sensor.log
ipmcget -d health -v list > ibmc-health.log # 一眼看哪个部件不健康
ipmcget -d fru -v list   > ibmc-fru.log
ipmcget -d fw -v list    > ibmc-fw.log
ipmcget -d blackbox -v list > ibmc-blackbox.log
# iBMC 网页 → 一键收集（含 SEL/传感器/黑匣子，最全）
```
要点：华为的**一键收集包**内容最全（含黑匣子），能导就一定导，解压后整目录喂给分析工具。

### 超微 / 曙光 / 中兴 / H3C / 富士通
统一走通用 IPMI + Redfish 路径；超微的 SEL 传感器命名非常规范（`DIMMB1`、`PWR Supply 1`、`Fan 4`），解析友好。H3C 的管理模块叫 HDM，富士通叫 iRMC（iRMC 网页有独立 System Event Log 导出）。

## 三、OS 侧必采（所有品牌通用，硬件定性的一半证据）

```bash
journalctl -k -b -1 --no-pager > os-kernel-prevboot.log   # 上次为什么挂
journalctl -k -b 0  --no-pager > os-kernel.log            # MCE/EDAC/AER/IO 错误
dmesg -T > os-dmesg.log
cat /var/log/messages /var/log/syslog /var/log/kern.log > os-syslog.log 2>/dev/null
mcelog --client 2>/dev/null || ras-mc-ctl --summary 2>/dev/null
edac-util -v 2>/dev/null
dmidecode -t 1 -t 2 -t 16 -t 17 -t 39 2>/dev/null          # 台账 + DIMM 槽位 + 电源
smartctl -x /dev/sdX | head -80
storcli64 /c0 show all 2>/dev/null || MegaCli -AdpAllInfo -aALL -NoLog 2>/dev/null
mdadm --detail /dev/md0 2>/dev/null
lspci -vv 2>/dev/null | grep -A4 -i "aer\|ltssm"
ethtool -S eth0 2>/dev/null | grep -i "err\|drop\|crc"
sos report --batch 2>/dev/null || sosreport --batch 2>/dev/null
```

## 四、采集纪律（吃过亏的几条）

1. **BMC 密码不进 shell 历史**：用环境变量或 `ipmitool` 的 `.conf`（`-C` 加密选项也建议显式指定，避免明文密码告警）。
2. **导出命名规范**：`<主机名>-<SN>-<日志类型>-<采集日期>.log`，否则一周后你自己也分不清哪个文件是哪台机器。
3. **导出顺序**：先 SEL/生命周期 → 再传感器/FRU → 再支持包/一键收集 → 最后才是维护性清零。
4. **采集工具生成**：`dsh-hwlog collect --brand auto --scope all` 可以一次生成上面全部命令（含品牌分支），直接粘到跳板机执行。
5. **时间对齐**：采集时同时记录 `date`（OS）与 `ipmitool mc info`/BMC 页面时间，供后续对齐时间戳用。

## 五、进不去 OS 时怎么采（只有带外，现场主流）

优先级从高到低，能拿到哪一档就用哪一档：

1. `ipmitool -I lanplus -H $BMC_IP -U $BMC_USER -P "$BMC_PASS" sel save sel.bin` —— **二进制 SEL，本工具直接解码**（内置 sensor type/event offset 语义表），一份文件就能出部件级结论。
2. **厂商一键收集包**（华为 iBMC 一键收集 / Dell supportsave / HPE AHS / Lenovo XCC 诊断 / 浪潮 BMC 导出）—— zip 直接交给本工具，会自动展开并优先取 SEL/健康/传感器/黑匣子，里面的 `.bin` 与中文 `.txt` 都能吃。
3. **BMC 网页导出** HTML 或 CSV —— HTML 表格会被清洗成 SEL 形态；中文导出若是 GBK 也会自动识别，不会乱码。
4. 只能截图/手抄时：把能抄到的"时间 + 部件 + 事件 + 断言级别"按 `时间 | 部件 | 事件` 排成文本行粘进来，同样能分析（槽位信息越全越好）。

配套纪律：

- **不要把"采不到 OS 日志"当成不能出结论**：带外足以判定"谁坏了、要不要换件"；报告会标 `CR_BMC_ONLY`，把"业务影响需另证"和替代证据写清楚。
- xlsx 请在 Excel/WPS 里**另存为 CSV**（工具会提示，不会静默跳过）。
- 报修单写法（部件 + 槽位 + 证据行 + 来源）：
  `DIMM B1 不可纠正错误（UCE）×2；证据：ibmc/Sel.txt 第 7 行；采集来源：iBMC SEL（暂无 OS 日志）。`

