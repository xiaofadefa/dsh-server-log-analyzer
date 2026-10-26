/**
 * 采集清单层：把"该采什么日志、用什么命令采"变成可执行清单。
 *
 * 覆盖：DELL iDRAC / HPE iLO / Lenovo XCC / 浪潮 Inspur BMC / 华为 iBMC / 超微 /
 * 曙光 / 中兴 / H3C / 富士通 iRMC / 通用 IPMI+Redfish，以及所有品牌共用的 OS 侧采集。
 */

export const BRAND_CHOICES = [
  'auto', 'dell', 'hpe', 'lenovo', 'inspur', 'huawei',
  'supermicro', 'sugon', 'zte', 'h3c', 'fujitsu', 'generic',
];

const COMMON_OS = [
  { cmd: 'journalctl -k -b -1 --no-pager > os-kernel-prevboot.log', note: '上一引导周期的内核日志（查上一次为什么挂了）' },
  { cmd: 'journalctl -k -b 0 --no-pager > os-kernel.log', note: '本次引导内核日志（MCE/EDAC/AER/IO 错误都在这里）' },
  { cmd: 'dmesg -T > os-dmesg.log', note: '带人类时间戳的环缓冲' },
  { cmd: 'cat /var/log/messages /var/log/syslog /var/log/kern.log > os-syslog.log 2>/dev/null', note: '发行版差异：RHEL 系看 messages，Debian 系看 syslog/kern.log' },
  { cmd: 'cp /var/log/dmesg /var/log/boot.log . 2>/dev/null', note: '老发行版的启动日志' },
  { cmd: 'sos report --batch --tmp-dir /tmp 2>/dev/null || sosreport --batch 2>/dev/null', note: '整机取证包（sos），适合离线带回来分析' },
];

const COMMON_OS_HW = [
  { cmd: 'mcelog --client 2>/dev/null || ras-mc-ctl --summary 2>/dev/null', note: '内存/CPU 机器检查记录（MCE）' },
  { cmd: 'edac-util -v 2>/dev/null', note: 'EDAC 视角的内存纠错统计（CE/UE 计数）' },
  { cmd: 'dmidecode -t 1 -t 2 -t 16 -t 17 -t 39 2>/dev/null', note: '系统/主板/内存/电源的物理台账' },
  { cmd: 'smartctl -x /dev/sdX | head -80', note: '硬盘 SMART 全量（含错误日志、磨损、重映射）' },
  { cmd: 'storcli64 /c0 show all > storcli.log 2>/dev/null || MegaCli -AdpAllInfo -aALL -NoLog > megacli.log 2>/dev/null', note: 'RAID 卡状态（降级/重建/掉盘）' },
  { cmd: 'storcli64 /c0 show events file=raid-events.log 2>/dev/null || storcli64 /c0 show events > raid-events.log 2>/dev/null', note: 'RAID 卡**控制器事件日志**——区分"卡自身故障 vs 硬盘 vs 背板"的关键证据' },
  { cmd: 'storcli64 /c0 show termlog > raid-tty.log 2>/dev/null', note: 'RAID 卡 **TTY 日志**（终端操作日志，厂商支持要的就是它）' },
  { cmd: 'storcli64 /c0 show preservedCache 2>/dev/null; storcli64 /c0 show patrolread 2>/dev/null', note: '保留缓存（Preserved Cache）与后台巡检状态：有保留缓存说明曾掉盘/掉电，且可能连带删组' },
  { cmd: 'mdadm --detail /dev/md0 2>/dev/null', note: '软阵列状态' },
  { cmd: 'lspci -vv 2>/dev/null | grep -A4 -i "aer\\|ltssm" ', note: 'PCIe AER/链路协商状态' },
  { cmd: 'ethtool -S eth0 2>/dev/null | grep -i "err\\|drop\\|crc"', note: '网卡错误计数' },
  { cmd: 'ipmitool sel elist > os-ipmi-sel.log 2>/dev/null', note: '带内取带外 SEL（最省事的兜底路径）' },
  { cmd: 'ipmitool sdr type Temperature > os-ipmi-temp.log 2>/dev/null', note: '带内取温度传感器' },
];

const BRAND_COLLECT = {
  dell: {
    label: 'DELL 戴尔（iDRAC / Lifecycle Controller）',
    bmc: [
      { cmd: 'racadm selshow', note: 'SEL 事件表（当前）' },
      { cmd: 'racadm lclog view -i 200 -s "2026-01-01 00:00:00" > lclog.txt', note: '生命周期日志（含固件变更、配置变更，SEL 里看不到的都在这里）' },
      { cmd: 'racadm getsysinfo', note: '服务标签/型号/BMC 版本（报告台账用）' },
      { cmd: 'racadm getversion -l -b -f', note: '固件版本清单（BMC/BIOS/RAID/网卡/PSU）' },
      { cmd: 'racadm getsensorinfo', note: '传感器快照（温度/风扇/电压/功耗）' },
      { cmd: 'racadm hwinventory > hwinventory.xml', note: '硬件清单（DIMM 槽位 · 丝印对应关系）' },
      { cmd: 'racadm supportsave -t 0 > /dev/null', note: '一键收集支持包（深度排查再走这条）' },
      { cmd: 'curl -k -u root:PASSWORD "https://BMC_IP/redfish/v1/Managers/iDRAC.Embedded.1/LogServices/Lclog/Entries?$expand=*($levels=1)"', note: 'Redfish 方式取生命周期日志（推荐脚本化）' },
      { cmd: 'curl -k -u root:PASSWORD "https://BMC_IP/redfish/v1/Systems/System.Embedded.1/LogServices/Sel/Entries"', note: 'Redfish 方式取 SEL' },
    ],
  },
  hpe: {
    label: 'HPE 慧与（iLO / IML / AHS）',
    bmc: [
      { cmd: 'hplog -v > iml.log', note: 'IML 集成管理日志（iLO/服务器在线时）' },
      { cmd: 'hplog -t > temp.log && hplog -f > fan.log && hplog -p > power.log', note: '温度/风扇/电源快照' },
      { cmd: 'hpasmcli -s "show iml; show server; show dimm; show powersupply; show fans" > hpasmcli.log', note: '一体化快照（老版本 iLO/健康驱动）' },
      { cmd: 'ilorest login BMC_IP -u admin -p PASSWORD && ilorest get --select Logs', note: 'Redfish/ilorest 取事件日志' },
      { cmd: 'curl -k -u admin:PASSWORD "https://BMC_IP/redfish/v1/Systems/1/LogServices/IML/Entries?$expand=*($levels=1)"', note: 'Redfish 方式取 IML（结构化，字段最全）' },
      { cmd: 'curl -k -u admin:PASSWORD -X POST "https://BMC_IP/redfish/v1/Managers/1/ActiveHealthSystemLog" -d \'{"Action":"Download"}\'', note: 'AHS 主动健康日志（HPE 的深度取证路径）' },
      { cmd: 'iLOrest -u admin -p PASSWORD --server BMC_IP  # 交互式 show /system1', note: 'iLO CLI 全量信息' },
    ],
  },
  lenovo: {
    label: 'Lenovo 联想（XCC / IMM / Event Log）',
    bmc: [
      { cmd: 'ipmitool -I lanplus -H BMC_IP -U USER -P PASS sel elist > xcc-sel.log', note: '标准 IPMI SEL' },
      { cmd: 'ipmitool -I lanplus -H BMC_IP -U USER -P PASS sdr > xcc-sdr.log', note: '传感器/风扇/温度读数' },
      { cmd: 'ipmitool -I lanplus -H BMC_IP -U USER -P PASS fru > xcc-fru.log', note: '部件 FRU（序列号、型号）' },
      { cmd: 'curl -k -u USER:PASS "https://BMC_IP/redfish/v1/Systems/1/LogServices/EventLog/Entries?$expand=*($levels=1)"', note: 'XCC 事件日志（FQXSP 事件码族）' },
      { cmd: 'curl -k -u USER:PASS "https://BMC_IP/redfish/v1/Systems/1/LogServices/Dump"', note: '诊断转储（XCC 侧的 crash dump）' },
      { cmd: 'XCC 网页 → 服务 → 事件日志 → 导出（CSV）', note: '人工路径：导出后可直接喂给本工具' },
    ],
  },
  inspur: {
    label: 'Inspur 浪潮（BMC / NF 系列）',
    bmc: [
      { cmd: 'ipmitool -I lanplus -H BMC_IP -U USER -P PASS sel elist > inspur-sel.log', note: 'SEL 事件表（标准 IPMI 路径，任何固件版本都能用）' },
      { cmd: 'ipmitool -I lanplus -H BMC_IP -U USER -P PASS sensor > inspur-sensor.log', note: '全部传感器（温度/风扇/电压）' },
      { cmd: 'ipmitool -I lanplus -H BMC_IP -U USER -P PASS fru > inspur-fru.log', note: 'FRU 信息' },
      { cmd: 'BMC 网页 → 日志和告警 → IDL 日志 → 导出', note: '【浪潮独有，优先看】IDL 是"基于 IPMI 传感器的事件历史记录"（BMC 用户手册 3.6.4），每条告警自带处理建议，比裸 SEL 更好读' },
      { cmd: 'BMC 网页 → 日志和告警 → 一键收集日志（含 SEL / IDL / 传感器）', note: '最全：导出 zip 直接交给本工具，会自动展开并按相关性挑 SEL/IDL/健康类条目' },
      { cmd: 'BMC 网页 → 日志和告警 → 当前告警 / 审计日志', note: '当前告警看现状；审计日志回答"谁在什么时候改过什么"' },
      { cmd: 'BMC 网页 → 日志和告警 → 日志设置（syslog 外发）', note: '长期巡检：让 BMC 把告警外发到 syslog 服务器，再交给本工具做周期对比（baseline/diff）' },
      { cmd: 'curl -k -u USER:PASS "https://BMC_IP/redfish/v1/Systems/1/LogServices/Log1/Entries?$expand=*($levels=1)"', note: 'Redfish 事件日志：不同固件版本 LogServices 名可能是 Log1/SEL/IDL，先 GET LogServices 列清单' },
      { cmd: 'BMC 网页 → 系统信息/电源/风扇/传感器 页面（截图或复制文本）', note: '进不去 OS 且只能网页操作时，把这几页的表头与数值复制成文本，同样能分析（温度/转速读数会被抽取）' },
    ],
  },
  huawei: {
    label: 'Huawei 华为（iBMC / FusionServer）',
    bmc: [
      { cmd: 'ipmcget -d sel -v list > ibmc-sel.log', note: 'iBMC SEL 列表（部分版本用 `ipmcget -d sel`）' },
      { cmd: 'ipmcget -d sensor -v list > ibmc-sensor.log', note: '传感器（含 CPU/内存/进风温度、风扇转速）' },
      { cmd: 'ipmcget -d health -v list > ibmc-health.log', note: '健康状态总览（一眼看哪个部件不健康）' },
      { cmd: 'ipmcget -d fru -v list > ibmc-fru.log', note: 'FRU/部件序列号' },
      { cmd: 'ipmcget -d fw -v list > ibmc-fw.log', note: '固件版本清单' },
      { cmd: 'ipmcget -d blackbox -v list > ibmc-blackbox.log', note: '黑匣子日志（iBMC 侧问题定位）' },
      { cmd: 'iBMC 网页 → 一键收集（含 SEL/传感器/黑匣子）', note: '人工路径：华为的一键收集包含最全，导出 zip 解压后喂给本工具' },
      { cmd: 'curl -k -u USER:PASS "https://BMC_IP/redfish/v1/Systems/1/LogServices/SEL/Entries?$expand=*($levels=1)"', note: 'Redfish 方式取 SEL' },
      { cmd: 'OS 内：storcli64 /c0 show all; storcli64 /c0 show events; storcli64 /c0 show termlog; storcli64 /c0 show preservedCache', note: '华为 V2&V3 常用 RAID 卡（LSI SAS2208/2308/3108/3008、华为主控 PM8060/PM8068）状态与日志；进不去 OS 时见下一条' },
      { cmd: 'UEFI/HII：BIOS → Advanced → RAID 卡管理 → Controller Management → Save Controller Events / Save TTY Log', note: '【进不去 OS 时用】取 RAID 卡的"控制器事件日志"与"TTY 日志"（华为 RAID 控制卡用户指南第 35 版菜单路径）' },
      { cmd: 'RAID 卡侧证据链：preservedCache / foreign config / patrol read 三类状态单独记一次', note: '用于把"存储侧问题"与"服务器其它部件"区分开：保留缓存=曾掉盘掉电；外部配置=换过卡/盘；巡检报错=盘在劣化' },
    ],
  },
  supermicro: {
    label: 'Supermicro 超微（IPMI/BMC）',
    bmc: [
      { cmd: 'ipmitool -I lanplus -H BMC_IP -U USER -P PASS sel elist > smc-sel.log', note: 'SEL（超微 SEL 传感器命名很标准，好定位）' },
      { cmd: 'ipmitool -I lanplus -H BMC_IP -U USER -P PASS sensor > smc-sensor.log', note: '传感器读数' },
      { cmd: 'ipmitool -I lanplus -H BMC_IP -U USER -P PASS fru > smc-fru.log', note: 'FRU' },
      { cmd: 'BMC 网页 → Server Health → Event Log → 下载', note: '人工路径' },
    ],
  },
  sugon: {
    label: 'Sugon 曙光（BMC）',
    bmc: [
      { cmd: 'ipmitool -I lanplus -H BMC_IP -U USER -P PASS sel elist > sugon-sel.log', note: 'SEL' },
      { cmd: 'ipmitool -I lanplus -H BMC_IP -U USER -P PASS sensor list > sugon-sensor.log', note: '传感器' },
      { cmd: 'BMC 网页 → 日志管理 → 导出 SEL', note: '人工路径' },
    ],
  },
  zte: {
    label: 'ZTE 中兴（服务器 BMC）',
    bmc: [
      { cmd: 'ipmitool -I lanplus -H BMC_IP -U USER -P PASS sel elist > zte-sel.log', note: 'SEL' },
      { cmd: 'ipmitool -I lanplus -H BMC_IP -U USER -P PASS sensor > zte-sensor.log', note: '传感器' },
      { cmd: 'BMC 网页 → 事件日志 → 导出', note: '人工路径' },
    ],
  },
  h3c: {
    label: 'H3C 新华三（HDM）',
    bmc: [
      { cmd: 'ipmitool -I lanplus -H BMC_IP -U USER -P PASS sel elist > h3c-sel.log', note: 'HDM SEL' },
      { cmd: 'ipmitool -I lanplus -H BMC_IP -U USER -P PASS sensor > h3c-sensor.log', note: '传感器' },
      { cmd: 'curl -k -u USER:PASS "https://BMC_IP/redfish/v1/Systems/1/LogServices/EventLog/Entries"', note: 'HDM Redfish 事件日志' },
    ],
  },
  fujitsu: {
    label: 'Fujitsu 富士通（iRMC）',
    bmc: [
      { cmd: 'ipmitool -I lanplus -H BMC_IP -U USER -P PASS sel elist > fujitsu-sel.log', note: 'SEL' },
      { cmd: 'iRMC 网页 → System Event Log / iRMC 日志导出', note: '人工路径' },
    ],
  },
  generic: {
    label: '通用（IPMI + Redfish 双路径）',
    bmc: [
      { cmd: 'ipmitool -I lanplus -H BMC_IP -U USER -P PASS sel elist > sel.log', note: '标准 IPMI SEL（几乎所有品牌都支持）' },
      { cmd: 'ipmitool -I lanplus -H BMC_IP -U USER -P PASS sel save sel.bin && ipmitool sel list', note: '保存二进制 SEL（留证 + 可复解析）' },
      { cmd: 'ipmitool -I lanplus -H BMC_IP -U USER -P PASS sensor > sensor.log', note: '传感器全文（温度/风扇/电压/功耗）' },
      { cmd: 'ipmitool -I lanplus -H BMC_IP -U USER -P PASS sdr type Temperature', note: '只看温度类传感器' },
      { cmd: 'ipmitool -I lanplus -H BMC_IP -U USER -P PASS fru > fru.log', note: 'FRU' },
      { cmd: 'ipmitool -I lanplus -H BMC_IP -U USER -P PASS mc info', note: 'BMC 固件版本/IPMI 版本' },
      { cmd: 'curl -k -u USER:PASS "https://BMC_IP/redfish/v1/Systems/1/LogServices"', note: '先列 LogServices，再按返回的 @odata.id 取 Entries（各品牌路径不同但都遵循这一层）' },
      { cmd: 'curl -k -u USER:PASS "https://BMC_IP/redfish/v1/Managers/1/LogServices"', note: '管理面日志（BMC 自身日志）' },
    ],
  },
};

const TRANSPORT_NOTES = {
  ipmi: 'IPMI over LAN（端口 623/udp）：最通用，任何品牌都能用；注意在跳板机上执行，不要把 BMC 密码写进 shell 历史（用 -P 读环境变量或 ipmitool 的 .conf）。',
  redfish: 'Redfish over HTTPS（端口 443）：字段最结构化，适合脚本化周期采集；不同固件版本路径可能带 /Log1|/SEL|/EventLog 差异，先 GET LogServices 列清单。',
  racadm: 'Dell 专用：racadm（带内）或 ssh root@BMC（带外）执行；生命周期日志只能用这条路或 Redfish。',
  ilo: 'HPE 专用：hplog/hpasmcli（带内）或 iLOrest/Redfish（带外）。',
  ssh: 'OS 侧采集：直接 ssh 到被巡检主机执行（日志文件 + 工具输出）。',
};

/**
 * 生成采集清单。
 * @param {{ brand?: string, scope?: 'bmc'|'os'|'all', transport?: string, host?: string }} [options]
 * @returns {{ brand: string, label: string, sections: Array<{title:string, note:string, items:Array<{cmd:string,note:string}>}> }}
 */
export function collectPlan(options = {}) {
  const brand = BRAND_CHOICES.includes(options.brand) ? options.brand : 'auto';
  const scope = options.scope || 'all';
  const host = options.host || 'BMC_IP';
  const transport = options.transport || 'ipmi';
  const brands = brand === 'auto' ? Object.keys(BRAND_COLLECT) : [brand];

  const sections = [];
  if (scope === 'bmc' || scope === 'all') {
    for (const key of brands) {
      const entry = BRAND_COLLECT[key];
      if (!entry) continue;
      sections.push({
        title: entry.label,
        note: TRANSPORT_NOTES[transport] || '',
        items: entry.bmc.map((item) => ({ cmd: item.cmd.replace(/BMC_IP/g, host), note: item.note })),
      });
    }
  }
  if (scope === 'os' || scope === 'all') {
    sections.push({
      title: '操作系统侧：日志文件与硬件快照（所有品牌通用）',
      note: TRANSPORT_NOTES.ssh,
      items: COMMON_OS,
    });
    sections.push({
      title: '操作系统侧：硬件状态抓取（内存/硬盘/RAID/PCIe/网卡）',
      note: '这些命令是"硬件定性"的关键证据，一定要和带外日志一起分析。',
      items: COMMON_OS_HW,
    });
  }

  return {
    brand,
    label: brand === 'auto' ? '全部品牌（自动识别）' : BRAND_COLLECT[brand].label,
    transport,
    note: [
      '进不去 OS 时的最小采集：只做「带外」那几节就够 —— 本工具对**纯带外**日志（SEL 文本、`ipmitool sel save` 的 .bin、厂商一键收集 zip、网页导出的 HTML/CSV）',
      '同样能给出部件级结论（谁坏了、要不要换件、换前做什么），只是"业务影响"层会明确标注缺 OS 证据（报告里的 CR_BMC_ONLY）。',
      '优先推荐三种导出：① `ipmitool sel save sel.bin`（本工具可直接解码二进制 SEL）；② 厂商一键收集包（华为/浪潮/联想/Dell/HPE 的 zip，本工具会自动展开、按相关性挑 SEL/健康/传感器）；',
      '③ BMC 网页「日志 → 导出」（HTML/CSV 都行；xlsx 请另存为 CSV）。中文 GBK 编码也会自动识别，不会乱码。',
    ].join(''),
    sections,
  };
}

/**
 * 采集脚本里的命令清洗：把"清单里为了可读性写的重定向"去掉，
 * 统一由脚本生成器按"一节一命令一文件"的规则重定向（避免出现 `> a.log >> b.log` 这种叠加）。
 */
export function normalizeCollectCommand(cmd) {
  return String(cmd == null ? '' : cmd)
    .replace(/\s*2>&1\s*$/, '')
    .replace(/\s*2>\s*\/dev\/null\s*$/, '')
    .replace(/\s*(?:>>?)\s*[^\s|&;]+\s*$/, '')
    .trim();
}

/** 把采集清单渲染成可直接粘到跳板机上的 shell 脚本。 */
export function renderCollectScript(options = {}) {
  const plan = collectPlan(options);
  const lines = [
    '#!/bin/bash',
    '# 服务器日志采集脚本（由 dsh-server-log-analyzer 生成）',
    '# 用法：在跳板机上设置好 BMC 账号变量后执行；采集结果统一放进 ./server-log-<日期>/',
    'set -u',
    'OUT="server-log-$(date +%Y%m%d-%H%M%S)"',
    'mkdir -p "$OUT"',
    'BMC_IP="${BMC_IP:-192.0.2.10}"',
    'BMC_USER="${BMC_USER:-admin}"',
    'BMC_PASS="${BMC_PASS:-CHANGE_ME}"',
    '',
  ];
  for (const section of plan.sections) {
    const slugText = slug(section.title);
    lines.push(`# ── ${section.title} ──`);
    section.items.forEach((item, index) => {
      const cmd = normalizeCollectCommand(item.cmd);
      if (!cmd) return;
      const suffix = String(index + 1).padStart(2, '0');
      lines.push(`# ${item.note}`);
      lines.push(`${cmd} > "$OUT/${slugText}.${suffix}.log" 2>&1 || true`);
      lines.push('');
    });
  }
  lines.push('echo "采集完成：$OUT"');
  return lines.join('\n');
}

function slug(text) {
  return String(text).replace(/[^\w\u4e00-\u9fa5]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'section';
}
