# 品牌事件码与日志形态速查

给"看日志定位硬件"用的对照表。**待查表**（不确定的码不要硬猜，交给 `hwlog_rules` 与厂商手册）。

> **内容声明**：本文所有日志样例行均为**合成示例**（虚构时间、槽位与主机），用于说明各品牌日志的形态差异；
> 事件码属事实性标识符，描述性文字为本项目自行转述，未照录任何厂商手册原文。来源与许可见
> [`THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md)。

---

## 一、日志形态对照

| 品牌 | 带外日志文件名/命令 | 长什么样（节选） |
| --- | --- | --- |
| Dell | `racadm selshow`、`racadm lclog view` | `2026-08-16 09:00:05.402 [Critical] [MEM0001] Memory device at DIMM_A1 is disabled: Uncorrectable ECC error detected` |
| Dell | SEL（ipmitool/racadm 同形） | `   1 \| 08/16/2026 \| 09:00:05 \| Memory \| Memory \| Uncorrectable ECC error at DIMM A1 \| Asserted` |
| HPE | `hplog -v`（IML） | `[09:00:05 08/16/2026] [Critical] Uncorrectable Memory Error (DIMM 7, Slot 7)` |
| HPE | POST 错误 | `[Critical] POST Error: 207-Memory initialization failure, DIMM slot 7 disabled` |
| Lenovo | XCC 事件日志（Redfish/CSV） | `2026-08-16 09:00:05 FQXSPMA0011M Memory DIMM A1 uncorrectable error detected (UCE)` |
| 浪潮 | BMC 事件日志 | `2026-08-16 09:20:41 [Critical] PSU1 Failure detected (power supply failure)` |
| 华为 | `ipmcget -d sel -v list` | `Event Description : Memory uncorrectable ECC error (UCE) detected at DIMM B1` |
| 超微 | `ipmitool sel elist` | `   3 \| 08/16/2026 \| 09:20:41 \| PWR Supply 1 \| Power Supply \| Failure detected \| Asserted` |
| 通用 | `ipmitool sel elist` | `   1 \| 08/16/2026 \| 09:00:05 \| Memory \| Memory \| Uncorrectable ECC error \| Asserted` |
| 通用 | Redfish | `{"Created":"2026-08-16T09:00:05+08:00","Severity":"Critical","SensorType":"Memory","Message":"Uncorrectable ECC error detected at DIMM A1"}` |
| 通用 | OS | `Aug 16 09:00:12 node01 kernel: EDAC MC0: 1 UE row 3, channel 1, label "DIMM_A1": Uncorrected error` |

> 时间戳形态差异是解析的坑：ipmitool 是 `MM/DD/YYYY`，Dell 生命周期是 `YYYY-MM-DD HH:MM:SS.mmm`，
> HPE IML 是 `[HH:MM:SS MM/DD/YYYY]`，syslog 是 `Aug 16 09:00:12`（无年份）。

---

## 二、品牌事件码 → 故障语义（本插件内置的常用集）

### Dell iDRAC（`[XXXXnnnn]`）

| 码 | 语义（本工具规则） |
| --- | --- |
| `MEM0001` / `MEM8000` | 内存不可纠正 ECC（UCE） |
| `MEM0002` / `MEM0701` | 内存可纠正 ECC 超阈值（CE 计数） |
| `MEM0702` / `MEM1201` | 内存训练失败 / DIMM 被禁用 |
| `CPU0000` / `CPU0004` | 处理器机器检查（IERR / MCE） |
| `CPU0803` | 处理器热降频 |
| `PWR0000` / `PWR0002` / `PWR1003` | 电源模块失效 |
| `PWR0004` / `PWR0005` | 电源冗余丢失 |
| `PWR1000` / `PWR1006` | 电源输入丢失（AC 掉电） |
| `PWR2000` / `PWR2001` | 机箱电源单元 / 整机掉电 |
| `VLT0204` | 电压轨越限 |
| `FAN0000` / `FAN0001` / `FAN0003` | 风扇失效 |
| `FAN0004` / `RFM0005` | 风扇冗余丢失 |
| `TMP0100` / `TMP0104` / `TMP0118` | 温度越限（含风扇临界） |
| `DRV0001` / `PDR0001` | 硬盘预测性失效（SMART） |
| `DRV0002` / `DRV0003` / `DRV0012` / `PDR0003` | 硬盘失效 / 掉盘 |
| `STO0003` / `STO0005` / `STOR0009` | RAID 降级 / 阵列异常 |
| `BAT0000` / `BAT0001` / `BAT0005` | 电池类（RAID BBU / CMOS / NVRAM） |
| `SEC0030` / `SEC0031` | 机箱入侵检测 |
| `WDG0001` / `WDG0002` | 看门狗触发 |

### HPE（IML 文本 + POST 码）

| 特征 | 语义 |
| --- | --- |
| `Uncorrectable Memory Error` | 内存 UCE |
| `Corrected Memory Errors - Memory Module N` | 内存 CE（模块 N） |
| `POST Error: 207-/201-/202-` | 内存初始化 / 训练失败 |
| `POST Error: 1785-` / `Drive Array - Physical Drive Failure` | 硬盘 / 阵列故障 |
| `Power Supply N Failure` / `power supply redundancy has been lost` | 电源失效 / 冗余丢失 |
| `Fan N Failure` | 风扇失效 |
| `Processor N temperature is above the upper critical threshold` | CPU 过温（可能伴随降频） |
| `Battery for Smart Array … is degraded` | RAID 卡电池劣化（写缓存关闭） |

### Lenovo XCC（`FQXSP…` 事件族，按前缀归类）

| 前缀 | 类别 | 前缀 | 类别 |
| --- | --- | --- | --- |
| `FQXSPMA` | 内存 | `FQXSPSD` | 硬盘/存储 |
| `FQXSPCA` | 处理器 | `FQXSPIO` | PCIe/插槽 |
| `FQXSPPW` | 电源 | `FQXSPBR` | 主板/机箱 |
| `FQXSPUN` | 散热/温度 | `FQXSPSP` | 传感器 |
| `FQXSPSE` | 安全/TPM | `FQXSPSM` | 系统管理模块(BMC) |

> 单码语义会随固件版本变化，**按族归类 + 文本措辞**双确认最稳。

### 华为 iBMC / 浪潮 BMC / 超微

这些品牌的 SEL 基本是**描述型英文**（本地化版本可能出现中文），因此走文本规则：

| 文本特征 | 语义 |
| --- | --- |
| `Power supply unit N is faulty` / `PSU1 Failure detected` | 电源失效 |
| `AC power lost` / `input power lost` | 输入掉电（先查配电） |
| `Memory uncorrectable ECC error (UCE)` | 内存 UCE |
| `Memory correctable ECC error reporting limit exceeded` | 内存 CE 超阈值 |
| `Fan module N is faulty` / `Fan n Lower Critical` | 风扇失效 / 转速低 |
| `RAID degraded` / `Virtual Drive degraded` | 阵列降级 |
| `Drive N predictive failure` | 硬盘预警 |
| `SEL Full, log entries overwritten` | 事件日志写满（先导出再清） |
| `iBMC reset` / `sensor readings temporarily invalid` | BMC 复位 / 传感器失效 |

---

## 三、Redfish 取日志的路径规律

```
GET /redfish/v1/Systems/1/LogServices                 # 先列清单（各品牌命名不同）
  ├── Dell:    .../Systems/System.Embedded.1/LogServices/Sel/Entries
  │            .../Managers/iDRAC.Embedded.1/LogServices/Lclog/Entries
  ├── HPE:     .../Systems/1/LogServices/IML/Entries
  ├── Lenovo:  .../Systems/1/LogServices/EventLog/Entries
  ├── 浪潮:    .../Systems/1/LogServices/Log1/Entries
  ├── 华为:    .../Systems/1/LogServices/SEL/Entries
  └── 通用:    先 GET LogServices，再按返回的 @odata.id 取 Entries
GET /redfish/v1/Managers/1/LogServices                # 管理面（BMC 自身）日志
```

加 `?$expand=*($levels=1)` 一次展开条目，省掉逐条 GET。

---

## 四、OS 侧"硬件证据"关键词对照

| 关键词 | 含义 | 进一步动作 |
| --- | --- | --- |
| `EDAC MCx: … CE/UE row …` | 内存纠错（CE/UE）+ rank/channel/label | label 就是 DIMM 丝印，配合 SEL 定位 |
| `mce: [Hardware Error]` / `Machine Check Exception` | CPU/总线机器检查 | 看 bank 归属判断内存控制器还是内核 |
| `pcieport … AER: Corrected/Uncorrected` | PCIe 可纠正/不可纠正错误 | 记录 BDF → `lspci -s` → 重插/换槽 |
| `smartd: … Currently unreadable sectors` | 硬盘 SMART 预警 | 结合 Reallocated/Pending 计数 |
| `blk_update_request: I/O error, dev sdX` | 块层 I/O 错误 | 结合 SMART 与背板/线缆判断 |
| `md/raid1:md0: … degraded` | 软阵列降级 | 先保数据，再插备盘 |
| `mpt3sas … PHY error` / `invalid DWORD` | SAS 链路错误 | 单 PHY → 换盘位/线缆；多 PHY → 背板 |
| `CPU#n stuck for Ns` / `hard lockup` | 硬锁定（常见于硬件问题） | 必须同时看 BMC SEL 有无硬件事件 |
| `Previous boot incomplete` / `unexpected shutdown` | 非预期宕机 | 与 BMC 掉电事件时间对齐 |
