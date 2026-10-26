/**
 * 硬件故障规则库（品牌无关）。
 *
 * 设计：
 *   · 每一条规则 = 一类**硬件事实**（内存 UCE、电源失效、风扇失效、RAID 降级…），
 *     而不是某个品牌的某条日志文本；品牌差异收敛到 patterns / codes 两个字段里。
 *   · patterns 面向"描述型日志"（Dell Lifecycle、HPE IML、iBMC、浪潮、Supermicro 的英文文本、
 *     Linux 内核/存储栈输出都落在这一类）。
 *   · codes 面向"编码型日志"（Dell Lifecycle 事件码、Lenovo XCC 事件族前缀等）。
 *   · sev 是"这条事实本身的严重度"，实际告警等级还会被文本里的 Critical/Lower Non-critical
 *     等断言级别抬升或降低（见 parse.js 的 applyAssertion）。
 *
 * 想扩展：直接往 RULES 里加一条，patterns 用正则数组，codes 用 { 品牌: [码...] }，
 * 并用 `dsh-hwlog rules --category memory` 自检是否命中。
 */

import { severityRank } from './text.js';

export const CATEGORY_LABELS = {
  memory: '内存',  cpu: '处理器',
  power: '电源',
  thermal: '散热与温度',
  storage: '硬盘与存储',
  raid: 'RAID/控制器',
  pcie: 'PCIe/插槽',
  network: '网络',
  firmware: '固件与 BMC',
  board: '主板与机箱',
  security: '安全与完整性',
  os: '操作系统',
  other: '其它',
};

/**
 * 类别级通用处置建议：当一条事件既没有内部规则 advice、也没有手册 action 时兜底
 * （典型是"手册码表命中的新码"）。没有它，报告里会出现一个空的"处置动作："标题。
 */
export const CATEGORY_ACTIONS = {
  memory: '记录槽位与事件码后导出 BMC 日志；UCE 立即安排更换该内存条，CE 看速率（次/天）上升再换。',
  cpu: '先核对 BIOS/微码版本是否与厂商推荐一致；同一物理 CPU 重复报错才换 CPU。',
  power: '先确认供电侧（PDU/UPS、双路是否同源），再判定是否换电源模块；冗余未恢复前禁止单路维护。',
  thermal: '清灰、确认风扇满配与导风罩在位、核对进风温度（>27℃ 属机房制冷问题）。',
  storage: 'SMART/错误计数增长的盘安排更换；RAID 降级先做备份校验再插备盘，重建期间禁止重启与压测。',
  raid: '导出 RAID 卡 TTY/support bundle 与阵列配置，再升级固件或换卡；换卡前确认配置导入方式。',
  pcie: '按 BDF/插槽号定位卡与 riser：重插 → 换槽 → 升级卡固件/BIOS → 换卡 → 最后才主板。',
  network: '升级到厂商推荐的固件+驱动组合，再换槽验证；生产环境先切流量。',
  firmware: '导出 SEL/生命周期日志留证后，把 BMC/BIOS 刷到厂商推荐版本并复位。',
  board: '做最小化配置复测（1 CPU + 1 DIMM + 无插卡）留证后，再走换板流程。',
  security: '核对该时段机房维护记录与人员操作，按物理安全事件流程上报。',
  os: '与 BMC 侧事件做时间对齐；保留 kdump/vmcore，硬件定性必须有带外记录支撑。',
  other: '按厂商手册对应条目处置；反复出现则补成正式规则（带跨源关联）。',
};

/** 通用传感器断言（ipmitool sel / iBMC / 浪潮 / Supermicro 都会出现）。 */const SENSOR_ASSERT = {
  'upper non-recoverable': 'critical',
  'lower non-recoverable': 'critical',
  'upper critical': 'major',
  'lower critical': 'major',
  'upper non-critical': 'minor',
  'lower non-critical': 'minor',
};

export const RULES = [
  /* ───────────── 内存 ───────────── */
  {
    id: 'MEM_UCE',
    cat: 'memory',
    sev: 'critical',
    title: '内存不可纠正错误（多比特 ECC / UCE）',
    patterns: [
      /\bun-?correctable\s+(?:memory\s+)?(?:ecc\s+)?error/i,
      /\bun-?correctable\s+(?:ecc|dimm|memory)\b/i,
      /\buncorrected\s+(?:error|memory)/i,
      /\bmemory\s+(?:error|ecc)[^\n]{0,40}un-?correctable/i,
      /\bmulti-?bit\s+ecc\b/i,
      /\bUE\s+row\b/i,
      /\buncorrected\s+error\s+source/i,
      /\bUCE\b/,
      /\bmemory\s+(?:ue|uce)\b/i,
      /不可纠正(?:的)?(?:内存)?错误/,
      /内存[^\n]{0,16}(?:不可纠正|多比特|无法纠正)/,
    ],
    codes: {
      dell: ['MEM0001', 'MEM8000'],
      lenovo: ['FQXSPMA0011M', 'FQXSPMA0010M'],
      hpe: ['POST Error: 207', '207-Memory'],
      huawei: ['0x2F', 'MEM_UCE'],
      inspur: ['0x21', 'MEMUCE'],
    },
    advice: [
      '记录槽位后，用 BMC 的 DIMM 定位命令确认物理丝印（Dell: racadm hwinventory | grep -i dimm；华为: ipmcget -d dimm；浪潮: ipmitool fru / BMC 传感器页）。',
      '同一槽位 7 天内出现 ≥2 次 UCE，或出现 CE→UCE 转化，按"内存条劣化"走备件更换，不做 reset 复位了事。',
      'UCE 后必须整机重启才能清掉 MCE 熔断；重启前先导出 SEL/生命周期日志留证，并确认业务已切换。',
      '若多槽位同时 UCE，先查 CPU 内存控制器/主板 VR/内存供电电压，再考虑单条内存。',
    ],
  },
  {
    id: 'MEM_CE',
    cat: 'memory',
    sev: 'minor',
    title: '内存可纠正错误（CE / 单比特 ECC）',
    patterns: [
      /\bcorrectable\s+(?:memory\s+)?(?:ecc\s+)?error/i,
      /\bcorrectable\s+ecc\b/i,
      /\bcorrected\s+memory\s+errors?\b/i,
      /\bCE\s+row\b/i,
      /\bEDAC\s+MC\d+.*\bCE\b/i,
      /\b(?:single|1)-?bit\s+ecc\b/i,
      /\bmemory\s+ce\b/i,
      /可纠正(?:的)?(?:内存)?错误/,
      /内存[^\n]{0,16}可纠正[^\n]{0,8}错误/,
    ],
    codes: {
      dell: ['MEM0701', 'MEM0702', 'MEM0002'],
      lenovo: ['FQXSPMA0009I', 'FQXSPMA0012I'],
      huawei: ['MEM_CE'],
    },
    advice: [
      '看趋势不看单点：同一 DIMM 的 CE 速率（次/天）持续上升才需要换条，偶发个位数属正常纠错。',
      '开启/确认内存巡检与"CE 超阈值触发报警"的阈值设置（Dell: MEM0701 阈值，华为/浪潮: BMC 内存告警阈值）。',
      'CE 数量级达 10^3/天，或同一 rank/bank 集中出现，按劣化处理并安排计划性更换窗口。',
    ],
  },
  {
    id: 'MEM_TRAINING_FAIL',
    cat: 'memory',
    sev: 'critical',
    title: '内存训练/初始化失败（DIMM 被禁用或未识别）',
    patterns: [
      /\bmemory\s+training\s+(?:fail|error)/i,
      /\bDIMM[^.\n]{0,40}(?:failed|unable)\s+(?:memory\s+)?training/i,
      /\bDIMM[^.\n]{0,30}\b(?:disabled|not\s+(?:detected|present)|failed)\b/i,
      /\bmemory\s+(?:initiali[sz]ation|module)\s+fail/i,
      /内存.{0,6}(?:训练|初始化)失败/,
    ],
    codes: {
      dell: ['MEM0702', 'MEM1201', 'MEM0004'],
      lenovo: ['FQXSPMA0013N'],
      hpe: ['POST Error: 201', 'POST Error: 202', 'POST Error: 1785'],
      huawei: ['MEM_TRAINING'],
    },
    advice: [
      '先在 BMC 里看容量是否比配置少（少的那条就是被禁用/未识别的条）。',
      '拔插 + 重新做内存训练：清 CMOST/NVRAM 或执行 BMC 的"Memory Retraining"，再开机。',
      '换到已知良好槽位复测；若换槽仍失败，判内存条坏；若多槽位都失败，判主板/CPU 内存控制器。',
    ],
  },
  {
    id: 'MEM_ROW_SPARE',
    cat: 'memory',
    sev: 'major',
    title: '内存退化（行备用/冗余耗尽）',
    patterns: [
      /\brow\s+spar(?:e|ing)\b/i,
      /\bspare\s+channel\b/i,
      /\bmemory\s+(?:mirroring|redundanc)[^.\n]{0,20}(?:lost|disabled|fail)/i,
      /内存.{0,6}(?:降级|冗余失效)/,
    ],
    advice: [
      '行备用已消耗说明内存颗粒持续劣化，按计划更换该 DIMM。',
      '确认内存冗余模式（Mirroring/Lockstep）是否被关闭，关闭后不可再用冗余兜底。',
    ],
  },
  {
    id: 'MEM_CRC',
    cat: 'memory',
    sev: 'minor',
    title: '内存链路 CRC / 重试异常',
    patterns: [
      /\bmemory\s+(?:crc|link|retry)[^.\n]{0,30}(?:error|fail)/i,
      /\bDDR\d?\s+(?:crc|retry)\b/i,
    ],
    advice: ['链路 CRC 多与插槽接触/内存供电有关：重插内存、清洁插槽，必要时更新 BIOS/内存微码。'],
  },

  /* ───────────── 处理器 ───────────── */
  {
    id: 'CPU_MCE',
    cat: 'cpu',
    sev: 'critical',
    title: '处理器机器检查（MCE / IERR / CATERR）',
    patterns: [
      /\bmachine\s+check\b/i,
      /\bMachine\s+Check\s+Exception\b/i,
      /\bmce:\s*\[?Hardware\s+Error\]?/i,
      /\bHardware\s+Error\b[^\n]{0,60}\bMachine\s+Check\b/i,
      /\bCPU[^\n]{0,30}\b(?:IERR|CATERR|BIST)\b/,
      /\bInternal\s+(?:CPU\s+)?[Ee]rror\b/i,
      /\bMCE\b/,
      /\bmcelog\b/i,
      /处理器.{0,6}(?:内部错误|机器检查)/,
    ],
    codes: {
      dell: ['CPU0000', 'CPU0004', 'CPU0803'],
      lenovo: ['FQXSPCA0001M', 'FQXSPCA0010M'],
      hpe: ['Uncorrectable Machine Check', 'Processor Error'],
    },
    advice: [
      '先看 MCE 的 bank/槽位：bank 属于内存控制器 → 查内存；属于 cache/内核 → 查 CPU。',
      '同一物理 CPU 的 UCE 超过 2 次，安排更换 CPU；形成 IERR 整机复位时优先切业务再动手。',
      '升级 BIOS/BMC 到厂商当前推荐版本，部分 IERR 是微码问题。',
    ],
  },
  {
    id: 'CPU_CACHE_ERROR',
    cat: 'cpu',
    sev: 'major',
    title: '处理器缓存错误（L1/L2/L3）',
    patterns: [
      /\b(?:L1|L2|L3|LLC)\s*cache[^\n]{0,30}(?:error|ecc|fail|failure)/i,
      /\bcache\s+error\b/i,
      /缓存.{0,4}(?:错误|故障)/,
    ],
    advice: ['缓存可纠正错误可观察；不可纠正缓存错误等于 CPU 级故障，按 CPU 更换流程处理。'],
  },
  {
    id: 'CPU_THERMAL_THROTTLE',
    cat: 'cpu',
    sev: 'major',
    title: '处理器热降频（Throttle / PROCHOT）',
    patterns: [
      /\bCPU[^.\n]{0,40}throttl/i,
      /\bthrottl\w*[^.\n]{0,40}\bCPU\b/i,
      /\bPROCHOT\b/,
      /\bclock\s+modulation\b/i,
      /\bcpu\s+frequency\s+(?:reduced|limited)/i,
      /处理器降频|降频/,
    ],
    advice: [
      '看同时段是否伴随风扇转速偏低/进风口温度偏高，确认是散热通道问题而不是单 CPU 问题。',
      '清灰、检查导风罩与风扇是否满配、机房进风温度是否超过 27℃，再复测。',
      '用 `ipmitool sdr type Temperature` / BMC 传感器页拉取 CPU 与进风温度趋势。',
    ],
  },
  {
    id: 'CPU_OVER_TEMP',
    cat: 'cpu',
    sev: 'critical',
    title: '处理器过温（超过上限/触发保护）',
    patterns: [
      /\bCPU[^.\n]{0,30}(?:over\s*temperature|temperature[^.\n]{0,20}(?:critical|non-?recoverable|too\s+high))/i,
      /\bCPU\s*Thermal\s*Trip\b/i,
      /处理器过温|CPU过温/,
    ],
    advice: [
      '立即排查：散热器是否脱落/硅脂失效、风扇是否停转、导风罩是否缺失、机房空调是否故障。',
      '出现过温保护停机（Thermal Trip）的机器，必须更换散热器并复测满载温度后才允许回业务。',
    ],
  },
  {
    id: 'CPU_UPI_QPI',
    cat: 'cpu',
    sev: 'major',
    title: '多路互连链路异常（UPI/QPI）',
    patterns: [
      /\b(?:UPI|QPI|HyperTransport)\b[^.\n]{0,40}(?:error|fail|degrad|down)/i,
      /\binter-?socket\s+link[^.\n]{0,30}(?:error|down)/i,
    ],
    advice: ['UPI 报错先看 BIOS 是否做过降级配置/降速，再查 CPU 安装扭矩与插槽针脚；重复出现按主板/CPU 更换处理。'],
  },
  {
    id: 'CPU_THERMAL_SENSOR',
    cat: 'cpu',
    sev: 'minor',
    title: '处理器温度传感器/读数异常',
    patterns: [
      /\bCPU[^.\n]{0,30}sensor[^.\n]{0,30}(?:fail|invalid|no\s+reading|out\s+of\s+range)/i,
      /\bDTS\b[^.\n]{0,30}(?:error|invalid)/i,
    ],
    advice: ['传感器读数异常会让风扇失控（全速或怠速），按 BMC 固件/主板传感器通道处理。'],
  },

  /* ───────────── 电源 ───────────── */
  {
    id: 'PSU_FAIL',
    cat: 'power',
    sev: 'critical',
    title: '电源模块失效',
    patterns: [
      /\b(?:power\s*supply|PSU|power\s*unit)\b[^.\n]{0,40}\b(?:fail|fault|faulty|failure|error|dead|not\s+present|removed|absent)\b/i,
      /\b(?:fail|fault|failure)\b[^.\n]{0,20}\b(?:power\s*supply|PSU)\b/i,
      /\bPSU\d?\b[^.\n]{0,20}(?:fail|fault|not\s+present|removed)/i,
      /\bpower\s*supply\b[^.\n]{0,20}\binput\s+lost\b/i,
      /电源(?:模块|单元|供应器)?[^\n]{0,12}(?:失效|故障|不在位|损坏)/,
    ],
    codes: {
      dell: ['PWR0000', 'PWR0002', 'PWR1003'],
      lenovo: ['FQXSPPW0001M', 'FQXSPPW0002M'],
      huawei: ['PWR_SUPPLY_FAIL', '0x3A'],
      inspur: ['PSUFAIL', '0x31'],
      supermicro: ['Power Supply'],
    },
    advice: [
      '先确认严重度：单电源故障在双电冗余下属于"降级可运行"，需尽快换件但不必停机；单电源机型 = 业务中断风险最高级。',
      '换件前记录 PSU 槽位与型号/功率（BMC 电源信息页），避免换错功率或方向。',
      '换完确认 BMC 里"冗余状态 = 已恢复"，并复位 PSU 告警。',
    ],
  },
  {
    id: 'PSU_REDUNDANCY_LOST',
    cat: 'power',
    sev: 'major',
    title: '电源冗余丢失/降级运行',
    patterns: [
      /\bpower\s+(?:supply\s+)?redundanc\w*[^\n]{0,20}(?:lost|degrad|disabled|fail|off)/i,
      /\bredundanc\w*[^\n]{0,30}\b(?:lost|degraded|disabled)\b/i,
      /电源冗余(?:丢失|失效|降级)/,
    ],
    codes: {
      dell: ['PWR0004', 'PWR0005'],
      lenovo: ['FQXSPPW0003M'],
      huawei: ['PWR_REDUNDANCY_LOST'],
    },
    advice: [
      '冗余丢失期间该机器不得进行任何单路维护/插拔操作，先恢复冗余。',
      '确认两路 PDU/市电是否都带电：极端情况是机柜某一路空开跳闸，导致一批机器同时降级。',
    ],
  },
  {
    id: 'PSU_INPUT_LOST',
    cat: 'power',
    sev: 'critical',
    prio: 10,
    title: '电源输入丢失（AC 掉电/输入超范围）',
    patterns: [
      /\bA\/?C\s+(?:power\s+)?(?:lost|loss|fail|off|not\s+present)\b/i,
      /\bAC\s+(?:power\s+)?(?:lost|loss|fail|off|not\s+present)\b/i,
      /\binput\s+(?:power|voltage)[^.\n]{0,30}(?:lost|out\s+of\s+range|fail|absent)/i,
      /\bpower\s+input[^.\n]{0,30}(?:lost|out\s+of\s+range)/i,
      /\bmains\s+(?:lost|fail)/i,
      /(?:市电|电源输入|输入电源|供电)[^\n]{0,10}(?:丢失|掉电|断电|异常|中断)/,
    ],
    codes: {
      dell: ['PWR1000', 'PWR1006'],
      lenovo: ['FQXSPPW0100M', 'FQXSPPW0000M'],
      huawei: ['PWR_INPUT_LOST'],
    },
    advice: [
      '核对同时段是否有"非预期宕机/系统冷启动"事件：有则基本确认是市电/PDU/UPS 侧掉电，不是服务器本身故障。',
      '查该机柜/PDU 是否存在一路空开跳闸、UPS 切换失败或双路供电接反（同路双接）。',
      '多台设备同时出现输入丢失 → 按机房供电事件处理，先查配电而不是挨个换电源。',
    ],
  },
  {
    id: 'PSU_PREDICTIVE',
    cat: 'power',
    sev: 'major',
    title: '电源模块预警（寿命/风扇/降额）',
    patterns: [
      /\bpower\s*supply\b[^.\n]{0,40}predictive/i,
      /\bPSU\b[^.\n]{0,30}(?:degrad|predictive|fan\s+(?:fail|slow))/i,
      /\b(?:power\s*supply|PSU)\b[^.\n]{0,30}\btemperature\b[^.\n]{0,20}(?:high|critical)/i,
    ],
    advice: ['电源预警阶段就该报备件（电源风扇/电容老化不可逆），不要等到彻底失效。'],
  },
  {
    id: 'VOLT_OUT_OF_RANGE',
    cat: 'power',
    sev: 'major',
    title: '电压轨异常（供电电压越限）',
    patterns: [
      /\bvolt(?:age)?\b[^\n]{0,40}(?:out\s+of\s+range|upper\s+(?:non-?recoverable|non-?critical|critical)|lower\s+(?:non-?recoverable|non-?critical|critical)|fail|abnormal)/i,
      /\b(?:VCC|VDDCR|P12V|P5V|P3V3|VBAT|PSU\s*VOUT)\b[^\n]{0,30}(?:fail|out\s+of\s+range|critical)/i,
      /电压(?:异常|越限)/,
    ],
    codes: { dell: ['VLT0204', 'VLT0001'] },
    advice: [
      '电压轨越限常由 PSU 或主板 VRM 引起：先看同时段是否有电源/电流告警，再决定换电源还是换主板。',
      'VBAT/3.3V_STBY 异常会影响 BMC 与 RTC 稳定性，优先处理。',
    ],
  },
  {
    id: 'BATTERY',
    cat: 'power',
    sev: 'major',
    title: '电池类部件告警（RAID BBU / CMOS / 超级电容）',
    patterns: [
      /\b(?:battery|bbu|supercap|nvram\s+battery|cmos\s+battery|rtc\s+battery)\b[^.\n]{0,40}\b(?:fail|low|weak|degrad|not\s+present|recharge|learn)\b/i,
      /\b(?:fail|low|degrad)\b[^.\n]{0,25}\b(?:battery|bbu|supercap)\b/i,
      /电池(?:失效|电量低|需更换)/,
    ],
    codes: { dell: ['BAT0000', 'BAT0001', 'BAT0005'] },
    advice: [
      'RAID 卡电池失效会让写缓存从 WriteBack 掉到 WriteThrough，性能骤降（先确认缓存策略已自动降级保护数据）。',
      'CMOS/RTC 电池电压低会导致时间跳变、BIOS 配置丢失，换电池后必须校时并重导日志时间戳。',
    ],
  },
  {
    id: 'POWER_UNIT',
    cat: 'power',
    sev: 'critical',
    prio: 12,
    title: '机箱电源单元（Power Unit / 电源事件）',
    patterns: [
      /\bpower\s+unit\b[^\n]{0,40}(?:fail|fault|off|not\s+present|lost)/i,
      /\bsystem\s+power\s+(?:off|down|loss)\b/i,
      /\bunexpected\s+power\s+(?:loss|off)\b/i,
      /\bpower\s+off\s+reason\b/i,
      /非预期(?:掉电|关机)/,
    ],
    codes: { dell: ['PWR2000', 'PWR2001'], lenovo: ['FQXSPPW0101I'] },
    advice: ['这是"整机掉电"级事件：和 OS 侧重启时间对齐，判断是掉电重启还是主动维护重启。'],
  },

  /* ───────────── 散热与温度 ───────────── */
  {
    id: 'FAN_FAIL',
    cat: 'thermal',
    sev: 'critical',
    title: '风扇失效/停转/被拔出',
    patterns: [
      /\bfan\b[^\n]{0,40}\b(?:fail|failed|failure|fault|faulty|stopped|not\s+present|removed|missing|abnormal)\b/i,
      /\b(?:fail|failed|failure|fault|removed)\b[^\n]{0,20}\bfan\b/i,
      /\bfan\s*\d+\b[^\n]{0,20}\b(?:not\s+present|missing)/i,
      /风扇\s*\d*\s*(?:失效|故障|停转|不在位|异常|损坏)/,
    ],
    codes: {
      dell: ['FAN0000', 'FAN0001', 'FAN0003'],
      lenovo: ['FQXSPUN0005M', 'FQXSPUN0006M'],
      huawei: ['FAN_FAIL', '0x41'],
      inspur: ['FANFAIL'],
    },
    advice: [
      '双风扇机型掉一个风扇，剩余风扇会全速运行：短期可运行但必须尽快换件，否则其他风扇轴承会连锁老化。',
      '换风扇前记录 FAN 编号与是否为热插拔；不支持热插拔的必须在关机状态下更换。',
      '确认导风罩/风扇墙是否被人为拆走（搬迁/清灰后忘装是常见人为故障）。',
    ],
  },
  {
    id: 'FAN_LOW_SPEED',
    cat: 'thermal',
    sev: 'major',
    title: '风扇转速异常（低于/高于阈值）',
    patterns: [
      /\bfan\b[^\n]{0,40}(?:lower\s+(?:critical|non-?critical|non-?recoverable)|speed[^\n]{0,20}(?:low|below)|rpm[^\n]{0,20}(?:low|below))/i,
      /\bfan\s*speed\b[^\n]{0,30}\b(?:low|critical|abnormal)/i,
      /\bfan\s*\d+\b[^\n]{0,40}(?:lower|upper)\s+(?:non-?recoverable|critical|non-?critical)/i,
      /\bfan\b[^\n]{0,30}(?:lower|upper)\s+non-?recoverable/i,
    ],
    advice: ['转速偏低/越限一般是轴承磨损、进灰或转速被上限压制；同步确认进风口是否被线缆/防尘网堵住。'],
  },
  {
    id: 'FAN_REDUNDANCY_LOST',
    cat: 'thermal',
    sev: 'major',
    title: '风扇冗余丢失',
    patterns: [
      /\bfan\s+redundancy\b[^.\n]{0,20}(?:lost|degrad|disabled|fail)/i,
      /风扇冗余(?:丢失|降级)/,
    ],
    codes: { dell: ['FAN0004', 'RFM0005'] },
    advice: ['冗余丢失说明至少一个风扇不可用或占位被拆：恢复冗余前禁止长时间满载运行。'],
  },
  {
    id: 'THERMAL_TEMP_HIGH',
    cat: 'thermal',
    sev: 'critical',
    title: '温度越限（部件或进风温度过高）',
    patterns: [
      /\b(?:temperature|temp)\b[^.\n]{0,40}(?:upper\s+non-?recoverable|critical|over\s*temp(?:erature)?|too\s+high|exceed)/i,
      /\b(?:inlet|ambient|system|board|memory|chipset|VRM|HDD|M\.2)\s+temperature\b[^.\n]{0,30}(?:high|critical|exceed)/i,
      /\bthermal\s+(?:alarm|trip|shutdown|shutdown\s+protection)\b/i,
      /温度(?:过高|越限|超限)/,
    ],
    codes: { dell: ['TMP0100', 'TMP0104', 'TMP0118'], huawei: ['TEMP_HIGH'] },
    advice: [
      '分三类处理：① 进风/环境温度高 → 机房制冷问题；② 局部（内存/芯片组/M.2/HDD）高 → 导风与背板风道问题；③ 单点传感器高 → 传感器或部件本身。',
      '出现 thermal shutdown 的机器，回业务前做 30 分钟满载温度验证。',
    ],
  },
  {
    id: 'THERMAL_TEMP_WARN',
    cat: 'thermal',
    sev: 'minor',
    title: '温度预警（接近上限）',
    patterns: [
      /\b(?:temperature|temp)\b[^.\n]{0,40}(?:upper\s+(?:critical|non-?critical)|warning|high)/i,
      /\btemperature\b[^.\n]{0,20}\bthreshold\b/i,
    ],
    advice: ['预警阶段做预防性清灰/风道整理，不要在告警升级后才处理。'],
  },

  /* ───────────── 硬盘与存储 ───────────── */
  {
    id: 'DRIVE_FAIL',
    cat: 'storage',
    sev: 'critical',
    prio: 15,
    title: '硬盘失效/离线',
    patterns: [
      /\bSMART\s+overall-?health[^\n]{0,60}\bFAIL(?:ED|ING)?\b/i,
      /\b(?:drive|disk|hard\s+drive|HDD|SSD)\b[^\n]{0,40}\b(?:fail|failed|failure|fault|offline|dead)\b/i,
      /\b(?:fail|failed|offline)\b[^\n]{0,20}\b(?:drive|disk|HDD|SSD)\b/i,
      /\bdrive\s+slot\b[^\n]{0,40}\b(?:fault|fail)/i,
      /硬盘\s*\d*\s*(?:失效|故障|离线|掉盘)/,
    ],
    codes: {
      dell: ['DRV0002', 'DRV0003', 'DRV0012', 'PDR0003'],
      lenovo: ['FQXSPSD0001M', 'FQXSPSD0002M'],
      huawei: ['DISK_FAIL'],
      inspur: ['DISKFAIL'],
    },
    advice: [
      '先确认 RAID 是否仍在降级可读写：能用热备就直接换盘重建，不要先拔盘再找备件。',
      '换盘后确认重建完成（storcli: /cx/eall/sall show rebuild），重建期间避免剧烈 IO 与再次掉盘。',
      '同一机箱 3 个月内 ≥3 块盘失效，按批次质量问题上报并检查背板/电源 12V 稳定性。',
    ],
  },
  {
    id: 'DRIVE_PREDICTIVE',
    cat: 'storage',
    sev: 'major',
    title: '硬盘预警（SMART/预测性失效）',
    patterns: [
      /\bpredictive\s+failure\b/i,
      /\bsmart\b[^\n]{0,30}\b(?:fail|warning|threshold|prefail)/i,
      /\b(?:reallocated|pending|uncorrectable|media\s+wear|wear\s+leveling|read\s+error\s+rate)\w*[^\n]{0,30}(?:sector|count|error|exceed)/i,
      /\bcurrently\s+unreadable\s+(?:pending\s+)?sectors?\b/i,
      /\bFAILING_NOW\b/,
      /\bSSD\s+(?:life|wear|endurance)\b[^\n]{0,20}(?:low|exceed)/i,
      /硬盘预警|预测性(?:失效|故障)/,
    ],
    codes: { dell: ['DRV0001', 'PDR0001'], huawei: ['DISK_PREDICTIVE'] },
    advice: [
      '预警盘纳入计划更换清单（业务低峰换），避免在重建窗口里同时换两块。',
      'SSD 关注磨损百分比与备用块（smartctl -a /dev/sdX: Percentage_Used、Available_Spare），82% 以上准备换。',
    ],
  },
  {
    id: 'DRIVE_ATA_ERRORS',
    cat: 'storage',
    sev: 'minor',
    title: '硬盘 ATA/SMART 错误日志有记录',
    patterns: [
      /\bATA\s+Error\s+Count\s*[:：]\s*[1-9]\d*/i,
      /\bSMART\s+Error\s+Log\b/i,
      /\berror\s+\d+\s+occurred\s+at\s+disk\s+power-?on\s+lifetime/i,
      /\bdevice\s+log\s+contains\s+only\s+the\s+most\s+recent/i,
    ],
    advice: [
      'SMART/ATA 错误日志非空不等于要换盘：与 Reallocated/Pending 计数一起看，计数增长才换。',
      '偶发几条历史记录（一两年前）可以只记录不换件；近 30 天内新增就要安排更换窗口。',
    ],
  },
  {
    id: 'DRIVE_REMOVED',
    cat: 'storage',
    sev: 'major',
    title: '硬盘被拔出/未识别',
    patterns: [
      /\bdrive\s+(?:slot|bay)\b[^.\n]{0,40}\b(?:removed|absent|not\s+present|missing|empty)/i,
      /\b(?:drive|disk)\b[^.\n]{0,20}\b(?:removed|missing)\b/i,
      /硬盘(?:被拔出|不在位|未识别)/,
    ],
    advice: ['先判人为维护拔盘还是松动：松动的重插前先确认 RAID 层面已标记为 failed/offline，防止 hot-remove 触发二次降级。'],
  },
  {
    id: 'RAID_DEGRADED',
    cat: 'raid',
    sev: 'critical',
    prio: 25,
    title: 'RAID 阵列降级/失效',
    patterns: [
      // 注意 VD 后要允许紧跟编号（storcli 输出是 "VD0 Properties : State = Degraded"，\bVD\b 在 VD0 上不成立）
      /\b(?:virtual\s+drive|VD|volume|logical\s+drive|RAID\s*(?:group|set)?|array)\s*\d*\b[^\n]{0,40}\b(?:degraded|failed|offline|critical)\b/i,
      /\b(?:degraded|failed)\b[^\n]{0,30}\braid\b/i,
      /\bmd\d+[^\n]{0,80}(?:degraded|failed|inactive|not\s+active)/i,
      /\bmd\/?raid\d*\b[^\n]{0,120}(?:degraded|failure|failed|inactive)/i,
      /\braid\w*\b[^\n]{0,60}\b(?:degraded|failure)\b/i,
      /RAID\s*(?:阵列|组|卷)?\s*(?:降级|失效|掉盘|故障)/i,
    ],
    codes: {
      dell: ['STO0003', 'STO0005', 'STOR0009'],
      lenovo: ['FQXSPSD0010M'],
      huawei: ['RAID_DEGRADED'],
      inspur: ['RAIDDEGRADE'],
    },
    advice: [
      'RAID 降级 = 单点数据丢失风险，优先确认是否有热备在重建；没有热备的立刻插备盘。',
      '重建期间禁止重启、禁止批量 IO 压力测试；重建完成前不要拔任何盘。',
      '做一次备份校验（DB 级别一致性），降级期间发生的写错误不会被 RAID 自动修复。',
    ],
  },
  {
    id: 'RAID_REBUILD',
    cat: 'raid',
    sev: 'minor',
    title: 'RAID 重建/同步中',
    patterns: [
      /\brebuild(?:ing)?\b/i,
      /\bresync\b/i,
      /\bbackground\s+initiali[sz]ation\b/i,
      /重建中|同步中/,
    ],
    advice: ['重建期间不拔盘、不重启，并记录重建起始时间与速率（storcli /c0/eall/sall show rebuild）。'],
  },
  {
    id: 'RAID_PRESERVED_CACHE',
    cat: 'raid',
    sev: 'major',
    prio: 22,
    title: 'RAID 卡保留缓存（Preserved Cache）',
    patterns: [
      /\bpreserved\s+cache\b/i,
      /保留缓存/,
    ],
    advice: [
      '出现保留缓存 = RAID 组曾掉盘/掉电且缓存未落盘：先确认该 VD 是否仍在线，再决定"导入外部配置"还是"清除保留缓存"。',
      '清除前必须留证：清除保留缓存可能连带删除 RAID 组（华为 RAID 手册明确提示），先导出 Controller Events 与 TTY Log。',
      '命令：`storcli64 /c0 show preservedCache` 确认 → `storcli64 /call/vall delete preservedCache force` 清除。',
      '若属于人为在线拔盘导致的故障，可先插回盘再处理，避免删组。',
    ],
  },
  {
    id: 'RAID_FOREIGN_CONFIG',
    cat: 'raid',
    sev: 'major',
    title: 'RAID 卡外部配置（Foreign Config）',
    patterns: [
      /\bforeign\s+(?:config|configuration)\b/i,
      /外部配置/,
      /\bunconfig(?:ured)?\s+good\b/i,
    ],
    advice: [
      '换卡/换盘/换背板后出现外部配置属正常：确认这些盘确实属于本机阵列后，用 Import Foreign Configuration 导入，而不是 Clear。',
      '不确定时先 Save TTY Log + Controller Events 留证，再决定导入或清空（Clear 会丢数据）。',
      '人为拔盘恢复可用 Unconfigured Good → Import 的路径，无需换盘。',
    ],
  },
  {
    id: 'RAID_PATROL_READ',
    cat: 'raid',
    sev: 'info',
    title: 'RAID 卡后台巡检/一致性检查（Patrol Read / Consistency Check）',
    patterns: [
      /\bpatrol\s+read\b/i,
      /\bconsistency\s+check\b/i,
      /一致性检查/,
    ],
    advice: [
      '后台巡检期间 IO 性能下降属正常，不必干预。',
      '若巡检频繁报 media error / uncorrectable，说明有盘在劣化 → 转硬盘预测失效评估（本工具会给出 DRIVE_PREDICTIVE / DISK_IO_ERROR 关联）。',
    ],
  },
  {
    id: 'RAID_CONTROLLER',
    cat: 'raid',
    sev: 'major',
    title: 'RAID 卡/HBA 控制器异常',
    patterns: [
      /\b(?:RAID|storage|SAS)\s+controller\b[^\n]{0,40}\b(?:error|fail|failed|failure|fault|offline|degrad)/i,
      /\bcontroller\b[^\n]{0,30}\b(?:fault|error|not\s+responding)\b/i,
      /\bmpt3?sas\b[^\n]{0,40}\b(?:fault|error|reset)/i,
      /\bmegaraid\b[^\n]{0,30}\b(?:error|fault)/i,
    ],
    advice: ['控制器级故障先导出 TTY 日志（storcli /c0 show all / LSI 的 support bundle）再升级固件或换卡；换卡前确认阵列配置导入方法。'],
  },
  {
    id: 'HBA_PHY_ERROR',
    cat: 'raid',
    sev: 'major',
    prio: 15,
    title: 'SAS/PHY 链路错误（背板、线缆、硬盘）',
    patterns: [
      /\bPHY\b[^.\n]{0,40}\b(?:error|invalid|fault|reset|fail)/i,
      /\bSAS\s+(?:link|topology|domain)[^.\n]{0,30}(?:error|fail|invalid)/i,
      /\b(?:expander|enclosure|backplane|BP)\b[^.\n]{0,40}\b(?:error|fail|fault|degrad|removed)/i,
      /\binvalid\s+(?:DWORD|dword|SAS\s+address)\b/i,
    ],
    advice: [
      '先判断是"单个 PHY 反复报错"还是"整个背板/扩展柜报错"：前者换盘位/线缆，后者按背板更换。',
      '更换前记录 PHY 编号与背板型号（storcli /c0/eall/sall show all）。',
    ],
  },
  {
    id: 'DISK_IO_ERROR',
    cat: 'storage',
    sev: 'major',
    title: '存储 IO 错误/超时（内核视角）',
    patterns: [
      /\bI\/O\s+error\b/i,
      /\bblk_update_request\b/i,
      /\b(?:timed?\s*out|timeout)\b[^.\n]{0,30}\b(?:I\/O|command|cdb|qemu)/i,
      /\bata\d+[^.\n]{0,40}\b(?:failed\s+command|error|exception|hard\s+reset|link\s+is\s+slow)/i,
      /\bnvme\d+n\d+[^\n]{0,30}(?:I\/O\s+error|reset|media\s+error)/i,
      /\bnvme\w*[^\n]{0,40}\btimeout\b/i,
      /\bsd[a-z]\b[^\n]{0,40}\b(?:FAILED\s+Result|critical\s+(?:medium|target))/i,
      /\bi\/o\s+\d+[^\n]{0,40}\btimeout\b/i,
    ],
    advice: [
      '把内核 I/O 错误与 SMART 计数一起看：错误向上增长 + SMART 计数增长 → 换盘；仅一次超时 → 观察。',
      '多盘同时 I/O 超时优先怀疑背板/线缆/HBA，而不是同时坏多块盘。',
    ],
  },
  {
    id: 'FS_ERROR',
    cat: 'storage',
    sev: 'major',
    title: '文件系统错误/只读挂载',
    patterns: [
      /\bEXT4-fs\s+error\b/i,
      /\bXFS\b[^.\n]{0,30}\b(?:corrupt|error|shutdown)/i,
      /\bremounting\s+filesystem\s+read-?only\b/i,
      /\bmetadata\s+I\/O\s+error\b/i,
      /\b(superblock|journal)\b[^.\n]{0,20}(?:error|corrupt)/i,
    ],
    advice: ['文件系统报错先做备份再 fsck/repair，不要在业务读写中直接修复；确认底层盘是否已掉。'],
  },
  {
    id: 'BACKPLANE',
    cat: 'storage',
    sev: 'major',
    title: '硬盘背板/扩展柜异常',
    patterns: [
      /\bbackplane\b[^\n]{0,40}\b(?:error|fail|failed|failure|fault|degrad|not\s+present)/i,
      /\b(?:disk\s+)?enclosure\b[^\n]{0,40}\b(?:error|fail|failed|failure|fault|removed)/i,
      /背板(?:故障|异常)/,
    ],
    advice: ['背板故障常表现为多个盘位同时丢盘：先确认是否电源/线缆，再安排整机停机换背板。'],
  },

  /* ───────────── PCIe / 插槽 ───────────── */
  {
    id: 'PCIE_AER_UE',
    cat: 'pcie',
    sev: 'critical',
    title: 'PCIe 不可纠正错误（AER Uncorrectable/Fatal）',
    patterns: [
      /\bAER\b[^.\n]{0,60}\b(?:uncorrectable|fatal|non-?fatal)/i,
      /\bPCIe?\s+(?:error|fault)[^.\n]{0,30}\b(?:uncorrectable|fatal)\b/i,
      /\bpcieport\b[^.\n]{0,60}\b(?:Uncorrected|Fatal|AER)/i,
      /\bPCIe\s+Bus\s+Error\b[^\n]{0,40}\b(?:Uncorrected|Fatal)\b/i,
      /\bUncorrected\s*\(?(?:Fatal|Non-?fatal)\)?/i,
      /\bseverity\s*=\s*Uncorrected\b/i,
      /\bSurprise\s+Down\b/i,
    ],
    advice: [
      '记录 BDF（如 0000:65:00.0）定位到具体插槽与卡：`lspci -s 65:00.0` / BMC 的 PCIe 拓扑页。',
      '常见顺序：重插卡 → 换插槽 → 升级卡固件/BIOS → 换卡 → 换主板（保持同一 BDF 复现证据）。',
    ],
  },
  {
    id: 'PCIE_AER_CE',
    cat: 'pcie',
    sev: 'minor',
    title: 'PCIe 可纠正错误（AER Corrected）',
    patterns: [
      /\bAER\b[^\n]{0,60}\bordered?\s*correct(?:ed|able)\b/i,
      /\bAER\b[^\n]{0,60}\bcorrected\b/i,
      /\bpcieport\b[^\n]{0,60}\bcorrected\b/i,
      /\bCorrected\s+Error\b[^\n]{0,30}\bPCI/i,
      /\bPCIe?\s*AER\b/i,
      // 浪潮 IDL / 部分厂商写成 "Bus Correctable Error Occured"、"PCIe_Status ... Correctable Error"
      /\b(?:PCIe?|Bus|PCIE_Status)\b[^\n]{0,40}\bcorrectable\s+error\b/i,
    ],
    advice: ['偶发可纠正 AER 常见（尤其是 NVMe/网卡）；每秒级持续刷屏说明链路质量差，做重插/降速/换槽验证。'],
  },
  {
    id: 'PCIE_LINK_DEGRADE',
    cat: 'pcie',
    sev: 'major',
    title: 'PCIe 链路降速/降宽',
    patterns: [
      /\bPCIe?\b[^.\n]{0,40}\blink\b[^.\n]{0,20}\b(?:degrad|down|retrain|width)/i,
      /\blink\s+(?:speed|width)\b[^.\n]{0,20}\b(?:fail|degrad|down|reduce)/i,
      /\blegacy\s+speed\b/i,
    ],
    advice: ['链路降级会让性能腰斩（如 x16→x1）：先确认是否插槽共享/m.2 占用通道，再查卡与主板的协商能力。'],
  },
  {
    id: 'PCIE_DEVICE_ERROR',
    cat: 'pcie',
    sev: 'major',
    title: 'PCIe 设备/插槽错误',
    patterns: [
      /\bPCI[ eE]?[ -]?slot\b[^\n]{0,40}\b(?:error|fail|failed|failure|fault|not\s+present)/i,
      /\b(?:device|slot)\s+error\b/i,
      /\bGPU\b[^.\n]{0,30}\b(?:error|falling\s+off|xid|thermal)/i,
      /\bNVRM\b[^.\n]{0,30}Xid/i,
    ],
    advice: ['GPU/NVMe RAID 卡类插卡故障，先确认辅助供电线是否插到位（大功率卡最常见）。'],
  },

  /* ───────────── 网络 ───────────── */
  {
    id: 'NIC_LINK_FLAP',
    cat: 'network',
    sev: 'minor',
    title: '网卡链路抖动（Link Down/Up 反复）',
    patterns: [
      /\blink\s+is\s+down\b/i,
      /\bcarrier\s+(?:lost|off)\b/i,
      /\bnics?\b[^.\n]{0,30}\blink[^.\n]{0,20}\b(?:down|up)\b/i,
      /链路(?:抖动|反复)/,
    ],
    advice: ['统计单位时间内 down/up 次数：>5 次/小时按物理层处理（换线、换光模块、锁速），偶发 1 次可观察。'],
  },
  {
    id: 'NIC_HW_ERROR',
    cat: 'network',
    sev: 'major',
    title: '网卡硬件错误',
    patterns: [
      /\b(?:eth|eno|ens|enp)\w*\b[^\n]{0,40}\b(?:hardware\s+error|tx\s+timeout|reset|hang|fault|failed|failure)/i,
      /\bNIC\b[^.\n]{0,30}\b(?:error|fail|fault)/i,
      /\bfirmware\s+(?:hang|error)\b[^.\n]{0,20}\bnic\b/i,
    ],
    advice: ['网卡复位类错误先升级到厂商推荐固件+驱动，再换槽验证；生产环境提前切流量。'],
  },

  /* ───────────── 固件与 BMC ───────────── */
  {
    id: 'BMC_WATCHDOG',
    cat: 'firmware',
    sev: 'major',
    title: 'BMC/系统看门狗触发',
    patterns: [
      /\bwatchdog\b[^.\n]{0,40}\b(?:timeout|expired|reset|trigger|fired|stopped)\b/i,
      /\b(?:NMI|hard|soft)\s+lockup\b/i,
      /\bBUG:\s*soft\s+lockup\b/i,
      /\brcu\w*\s+detected\s+stall\b/i,
      /看门狗(?:触发|复位)/,
    ],
    codes: { dell: ['WDG0001', 'WDG0002'] },
    advice: [
      '区分 OS 看门狗（hang 检测）与 BMC 看门狗（固件自愈）：前者查系统 hang 原因，后者查 BMC 固件版本与 NVRAM。',
      'BMC 反复自愈重启会导致传感器/风扇控制异常，按 BMC 固件升级处理。',
    ],
  },
  {
    id: 'BMC_RESET',
    cat: 'firmware',
    sev: 'minor',
    title: 'BMC 复位/重启（含固件自愈）',
    patterns: [
      /\bBMC\b[^.\n]{0,30}\b(?:reset|reboot|restart|self-?test|sp\s+reset)\b/i,
      /\b(?:iDRAC|iLO|iBMC|XCC|IPMI)\b[^.\n]{0,30}\b(?:reset|reboot|restart)/i,
      /BMC重置|BMC重启/,
    ],
    advice: ['偶发 1 次可观察；与固件升级/掉电同时发生属正常。频繁复位说明 BMC 固件或 NVRAM 有问题。'],
  },
  {
    id: 'BMC_SEL_FULL',
    cat: 'firmware',
    sev: 'minor',
    title: '事件日志写满/溢出（SEL 已满）',
    patterns: [
      /\bSEL\b[^.\n]{0,30}\b(?:full|overflow|overwritten|cleared)\b/i,
      /\bevent\s+log\b[^.\n]{0,30}\b(?:full|overflow|cycled)/i,
      /(?:事件)?日志(?:已满|溢出)/,
    ],
    advice: [
      '日志写满说明长期存在未处理告警或日志无归档策略：先导出留档再清空（ipmitool -I lanplus -H BMC -U user -P pass sel save/sel clear）。',
      '清空前必须导出，否则历史硬件劣化趋势（CE 计数等）会丢失。',
    ],
  },
  {
    id: 'BIOS_POST_ERROR',
    cat: 'firmware',
    sev: 'major',
    title: 'BIOS/POST 报错或自检失败',
    patterns: [
      /\bPOST\s+(?:error|code|failure|message)\b/i,
      /\bBIOS\b[^.\n]{0,30}\b(?:error|fail|corrupt|recovery)\b/i,
      /\bboot\s+(?:error|failure|failed)\b/i,
      /\bCMOS\s+checksum\s+(?:error|invalid)/i,
      /自检失败|POST报错/,
    ],
    codes: { hpe: ['POST Error:', '1785-', '207-', '201-'], dell: ['BIOS0005', 'UEFI0006'] },
    advice: ['记录 POST 码/错误号再查厂商手册：内存/CPU/PCIe 自检失败会直接卡在开机阶段，先做最小配置（1 CPU 1 DIMM 无插卡）验证。'],
  },
  {
    id: 'FW_UPDATE',
    cat: 'firmware',
    sev: 'info',
    title: '固件/BIOS 更新事件',
    patterns: [
      /\b(?:firmware|BIOS|BMC|CPLD|PSU)\b[^.\n]{0,30}\b(?:update|upgrade|flash|version)\b/i,
      /固件(?:更新|升级)/,
    ],
    advice: ['确认更新后是否有配套的"配置重置"副作用（内存训练/风扇曲线/RAID 策略），并记录前后版本号。'],
  },
  {
    id: 'FW_MISMATCH',
    cat: 'firmware',
    sev: 'minor',
    title: '固件/部件版本不匹配',
    patterns: [
      /\b(?:firmware|version)\s+mismatch\b/i,
      /\bincompatible\s+(?:firmware|version|component)/i,
      /\bunsupported\s+(?:firmware|component|CPU)/i,
    ],
    advice: ['版本不匹配常见于备件更换后：按"整机固件基线"统一刷到同版本，避免混版导致的隐性兼容故障。'],
  },
  {
    id: 'FW_UPDATE_FAIL',
    cat: 'firmware',
    sev: 'major',
    title: '固件更新失败/中断',
    patterns: [
      /\b(?:firmware|BIOS|BMC)\s+(?:update|upgrade|flash)\b[^.\n]{0,30}\b(?:fail|abort|error|invalid)/i,
      /\brecovery\s+(?:mode|image)\b/i,
    ],
    advice: ['更新失败可能留下半刷新状态：按厂商恢复流程（BIOS recovery jumper / BMC recovery 固件）处理，不要反复断电重试。'],
  },
  {
    id: 'NVRAM_ERROR',
    cat: 'firmware',
    sev: 'major',
    title: 'NVRAM/CMOS 数据异常',
    patterns: [
      /\bNVRAM\b[^.\n]{0,30}\b(?:error|corrupt|fail|invalid)/i,
      /\bCMOS\b[^.\n]{0,20}\b(?:error|corrupt|invalid|reset)/i,
      /\bBIOS\s+settings?\s+(?:lost|reset|invalid)/i,
    ],
    advice: ['NVRAM 异常会导致配置丢失并伴随"每次重启都恢复默认"：换 NVRAM 芯片/主板，换前导出 BIOS 配置。'],
  },
  {
    id: 'LICENSE_CERT',
    cat: 'firmware',
    sev: 'minor',
    title: '许可/证书问题（BMC 或带外功能受限）',
    patterns: [
      /\b(?:license|licence)\b[^.\n]{0,30}\b(?:expire|expired|invalid|missing)/i,
      /\bcertificate\b[^.\n]{0,30}\b(?:expire|expired|invalid|reject)/i,
      /\bSSL\s+(?:handshake|certificate)\b[^.\n]{0,20}\b(?:fail|error)/i,
    ],
    advice: ['带外证书过期会导致浏览器/Redfish 客户端拒绝连接（表现为"BMC 打不开"），换证书与更新许可即可。'],
  },

  /* ───────────── 主板与机箱 ───────────── */
  {
    id: 'INTRUSION',
    cat: 'board',
    sev: 'major',
    title: '机箱开启检测（入侵告警）',
    patterns: [
      /\b(?:chassis|case|cover)\s+intrusion\b/i,
      /\bintrusion\s+(?:detected|assert)/i,
      /\b(?:top\s+cover|side\s+panel)\b[^.\n]{0,20}\b(?:open|removed)/i,
      /机箱(?:开启|入侵)/,
    ],
    codes: { dell: ['SEC0030', 'SEC0031'], lenovo: ['FQXSPBR0001M'] },
    advice: ['合法维护后要清理该状态；非维护时段出现必须按物理安全事件上报并核对机房出入记录。'],
  },
  {
    id: 'SENSOR_FAIL',
    cat: 'board',
    sev: 'major',
    title: '传感器失效/读数无效',
    patterns: [
      /\bsensor\b[^\n]{0,40}\b(?:fail|failed|failure|invalid|no\s+reading|unavailable|not\s+present|removed)\b/i,
      /\bunable\s+to\s+read\s+sensor\b/i,
      /传感器(?:失效|无读数)/,
    ],
    advice: ['传感器失效会让散热策略失去闭环（风扇失控）：优先恢复读数，再谈其它部件。'],
  },
  {
    id: 'BOARD_ERROR',
    cat: 'board',
    sev: 'major',
    title: '主板/芯片组异常',
    patterns: [
      /\b(?:system|main)\s+board\b[^.\n]{0,40}\b(?:error|fail|fault|replaced)/i,
      /\bchipset\b[^.\n]{0,30}\b(?:error|fail|fault)/i,
      /\b(?:PCH|PIIX|ICH)\b[^.\n]{0,30}(?:error|fail)/i,
      /\baer\b.*\broot\s+port\b/i,
    ],
    advice: ['主板级故障先把所有外设（RAID 卡/网卡/内存/CPU）的最小化复测证据留全，再走换板流程，避免备件误换。'],
  },
  {
    id: 'CPLD_ERROR',
    cat: 'board',
    sev: 'major',
    title: 'CPLD/电源时序异常',
    patterns: [
      /\bCPLD\b[^.\n]{0,30}\b(?:error|fail|fault|assert|not\s+ready)/i,
      /\bpower\s+(?:sequence|sequencing)\b[^.\n]{0,20}(?:fail|error)/i,
      /\bFPGA\b[^.\n]{0,30}\b(?:error|fail)/i,
    ],
    advice: ['CPLD 负责上电时序：异常常表现为"按电源键无反应"或随机自动上电，按 CPLD 固件/主板更换处理。'],
  },
  {
    id: 'OS_SHUTDOWN_UNEXPECTED',
    cat: 'os',
    sev: 'critical',
    title: '非预期重启/宕机（unclean shutdown）',
    patterns: [
      /\bunexpected\s+(?:reboot|shutdown|power\s+loss)\b/i,
      /\bprevious\s+boot\s+(?:incomplete|failed|did\s+not\s+shut\s+down)/i,
      /\bkernel\s+panic\b/i,
      /\bBUG:\s*unable\s+to\s+handle\b/i,
      /\bKernel\s+OOPS\b/i,
      /\bsudden\s+(?:power\s+loss|shutdown)\b/i,
      /(?:非预期|异常)(?:重启|宕机|掉电)/,
    ],
    advice: [
      '与 BMC 侧"AC 掉电/电源事件"时间对齐：对齐成功基本可判供电侧，未对齐则查 OS 崩溃（kdump）/硬件看门狗。',
      '保留 kdump/vmcore 与 BMC SEL 两份证据，硬件故障判定必须有 BMC 侧记录支撑。',
    ],
  },
  {
    id: 'OS_BOOT',
    cat: 'os',
    sev: 'info',
    title: '系统启动/关机记录（时间轴锚点）',
    patterns: [
      /\bOS\s+(?:boot|start|shutdown)\b/i,
      /\bsystem\s+(?:boot|started|shutdown|halt)\b/i,
      /\bkernel:\s*Linux\s+version\b/i,
      /\bsystemd\[1\]:\s*(?:Startup|Shutting\s+down)\b/i,
      /(?:系统|操作系统)(?:启动|开机|关机)/,
    ],
    advice: ['用来做时间轴锚点：把硬件告警挂到"哪一次开机周期"里，才能判断是偶发还是每次启动必现。'],
  },
  {
    id: 'OS_WATCHDOG',
    cat: 'os',
    sev: 'major',
    title: '操作系统硬锁定/看门狗复位',
    patterns: [
      /\bhard\s+lockup\b/i,
      /watchdog:\s*BUG/i,
      /\bkernel\s+watchdog\b[^.\n]{0,20}(?:reset|timeout)/i,
    ],
    advice: ['OS 层 hard lockup 常由硬件（内存/CPU/PCIe）引起：必须同时看 BMC SEL 有没有对应硬件事件。'],
  },

  /* ───────────── 其它 ───────────── */
  {
    id: 'SECURE_BOOT_TPM',
    cat: 'security',
    sev: 'minor',
    title: '安全启动/TPM 相关异常',
    patterns: [
      /\bsecure\s*boot\b[^.\n]{0,30}\b(?:fail|violation|denied|not\s+enabled)/i,
      /\bTPM\b[^.\n]{0,30}\b(?:error|fail|clear|lockout)/i,
      /\bmeasured\s+boot\b[^.\n]{0,20}(?:fail|error)/i,
    ],
    advice: ['换主板/清 TPM 会导致 BitLocker 进恢复模式：动手前确认密钥托管位置。'],
  },
  {
    id: 'FAN_TRAY_RISER',
    cat: 'board',
    sev: 'minor',
    title: '风扇背板/转接板（riser）异常',
    patterns: [
      /\briser\b[^.\n]{0,30}\b(?:error|fail|fault|not\s+present)/i,
      /\b(?:fan|PCIe)\s+(?:board|tray|module)\b[^.\n]{0,30}(?:fail|error|absent)/i,
    ],
    advice: ['转接卡异常会造成"整组 PCIe/风扇同时丢"的假象，先确认转接板与主板连接是否到位。'],
  },
];

const RULE_INDEX = new Map(RULES.map((rule) => [rule.id, rule]));

export function ruleById(id) {
  return RULE_INDEX.get(id) || {
    id: String(id || 'UNKNOWN'),
    cat: 'other',
    sev: 'info',
    title: '未分类事件',
    patterns: [],
    codes: {},
    advice: [],
  };
}

export function categoryLabel(cat) {
  return CATEGORY_LABELS[cat] || cat;
}

/** 品牌事件码别名表（只放"确定语义"的码；不确定的走前缀族兜底）。 */
export const CODE_ALIASES = {
  dell: {
    MEM0001: 'MEM_UCE',
    MEM0002: 'MEM_CE',
    MEM0701: 'MEM_CE',
    MEM0702: 'MEM_TRAINING_FAIL',
    MEM8000: 'MEM_UCE',
    MEM1201: 'MEM_TRAINING_FAIL',
    CPU0000: 'CPU_MCE',
    CPU0004: 'CPU_MCE',
    CPU0803: 'CPU_THERMAL_THROTTLE',
    PWR0000: 'PSU_FAIL',
    PWR0002: 'PSU_FAIL',
    PWR1003: 'PSU_FAIL',
    PWR0004: 'PSU_REDUNDANCY_LOST',
    PWR0005: 'PSU_REDUNDANCY_LOST',
    PWR1000: 'PSU_INPUT_LOST',
    PWR1006: 'PSU_INPUT_LOST',
    PWR2000: 'POWER_UNIT',
    VLT0204: 'VOLT_OUT_OF_RANGE',
    FAN0000: 'FAN_FAIL',
    FAN0001: 'FAN_FAIL',
    FAN0003: 'FAN_FAIL',
    FAN0004: 'FAN_REDUNDANCY_LOST',
    RFM0005: 'FAN_REDUNDANCY_LOST',
    TMP0100: 'THERMAL_TEMP_HIGH',
    TMP0104: 'THERMAL_TEMP_HIGH',
    TMP0118: 'THERMAL_TEMP_HIGH',
    DRV0001: 'DRIVE_PREDICTIVE',
    DRV0002: 'DRIVE_FAIL',
    DRV0003: 'DRIVE_FAIL',
    DRV0012: 'DRIVE_FAIL',
    PDR0001: 'DRIVE_PREDICTIVE',
    PDR0003: 'DRIVE_FAIL',
    STO0003: 'RAID_DEGRADED',
    STO0005: 'RAID_DEGRADED',
    STOR0009: 'RAID_DEGRADED',
    BAT0000: 'BATTERY',
    BAT0001: 'BATTERY',
    BAT0005: 'BATTERY',
    SEC0030: 'INTRUSION',
    SEC0031: 'INTRUSION',
    WDG0001: 'BMC_WATCHDOG',
    WDG0002: 'BMC_WATCHDOG',
  },
  lenovo: {
    // XCC 事件族前缀（族 > 单码：Lenovo 事件码语义随机型/固件变动，按族归类更稳）
    'FQXSPMA': 'MEM_UCE',
    'FQXSPCA': 'CPU_MCE',
    'FQXSPPW': 'PSU_FAIL',
    'FQXSPUN': 'FAN_FAIL',
    'FQXSPSD': 'DRIVE_FAIL',
    'FQXSPIO': 'PCIE_DEVICE_ERROR',
    'FQXSPBR': 'BOARD_ERROR',
    'FQXSPSE': 'SECURE_BOOT_TPM',
    'FQXSPSP': 'SENSOR_FAIL',
    'FQXSPSM': 'BMC_RESET',
    // 注意：FQXPM（LXPM = XClarity Provisioning Manager）**故意不映射** ——
    // 那一族多为部署/配置/信息类事件（如"开始安装操作系统"是 I 级），
    // 硬挂到 BIOS_POST_ERROR 会把 info 事件抬成 critical（实测踩过）。
    // 这类码交给厂商手册码表（含真实严重度）处理。
  },
  hpe: {
    '207-': 'MEM_UCE',
    '201-': 'MEM_TRAINING_FAIL',
    '202-': 'MEM_TRAINING_FAIL',
    '1785-': 'DRIVE_FAIL',
    '1720-': 'RAID_CONTROLLER',
    'POST Error: 304': 'CPU_MCE',
  },
  inspur: {
    '0x21': 'MEM_UCE',
    '0x31': 'PSU_FAIL',
    '0x41': 'FAN_FAIL',
  },
  huawei: {
    '0x2F': 'MEM_UCE',
    '0x3A': 'PSU_FAIL',
    '0x41': 'FAN_FAIL',
  },
};

/**
 * 从文本里找事件码：
 *   · Dell 风格 MEM0701 / PWR1004（3-6 字母 + 4-5 位数字）
 *   · Lenovo 风格 FQXSPCA0017M（FQXS + 3 字母域 + 4 位数字 + 严重度字母）
 *   · 华为 iBMC ALM-0x080000C1（0x + 8 位十六进制（告警码））
 *   · 浪潮/其它 0x2F 这类短十六进制
 * 边界用"前后非字母数字"而不是 \b —— CJK 在 Python/JS 里属于 \w，
 * `FQXSPCA0017M은` 这种中英韩混排会让 \b 失效（这是实测踩过的坑）。
 */
const CODE_RE = /(?<![A-Za-z0-9])(?:FQX[A-Z]{2,6}\d{4}[A-Z]?|[A-Z]{3,6}\d{4,5}|0x[0-9A-Fa-f]{2,8})(?![A-Za-z0-9])/g;

export function extractCodes(text) {
  const raw = String(text == null ? '' : text);
  const found = [];
  let m;
  CODE_RE.lastIndex = 0;
  while ((m = CODE_RE.exec(raw)) !== null) {
    found.push(m[0]);
    if (found.length >= 8) break;
  }
  return found;
}

function aliasMatch(code, vendor) {
  const table = CODE_ALIASES[vendor] || {};
  if (table[code]) return table[code];
  // 前缀族匹配（Lenovo XCC 等）
  for (const [key, ruleId] of Object.entries(table)) {
    if (key.endsWith('-') && code.startsWith(key)) return ruleId;
    if (code.startsWith(key)) return ruleId;
  }
  return null;
}

/**
 * 对一条记录做规则匹配。
 * @param {string} haystack - 原始文本（含解析出来的 desc）。
 * @param {string} vendor - 品牌（用于码表），可为 'generic'。
 * @returns {{ primary: object|null, secondary: object[], codes: string[] }}
 */
export function matchRules(haystack, vendor = 'generic') {
  const text = String(haystack == null ? '' : haystack);
  const hits = [];
  for (const rule of RULES) {
    for (const re of rule.patterns) {
      re.lastIndex = 0;
      if (re.test(text)) {
        hits.push(rule);
        break;
      }
    }
  }

  // 抽到的码全部保留（未映射到内置规则的码交给"外部码表/厂商手册"层处理，不能在这里丢掉）
  const allCodes = extractCodes(text);
  const matchedCodes = [];
  for (const code of allCodes) {
    const ruleId = aliasMatch(code, vendor) || aliasMatch(code, 'dell');
    if (!ruleId) continue;
    const rule = RULE_INDEX.get(ruleId);
    if (!rule) continue;
    matchedCodes.push(code);
    if (!hits.includes(rule)) hits.push(rule);
  }

  if (hits.length === 0) return { primary: null, secondary: [], codes: allCodes, mappedCodes: matchedCodes };

  hits.sort((a, b) => {
    const bySev = severityRank(b.sev) - severityRank(a.sev);
    if (bySev !== 0) return bySev;
    // 同等级时，越"具体"的规则优先（AC 掉电比"电源失效"更具体；单盘故障比阵列降级更具体）
    const byPrio = (a.prio == null ? 50 : a.prio) - (b.prio == null ? 50 : b.prio);
    if (byPrio !== 0) return byPrio;
    return RULES.indexOf(a) - RULES.indexOf(b);
  });

  return { primary: hits[0], secondary: hits.slice(1, 4), codes: allCodes, mappedCodes: matchedCodes };
}

/** 通用传感器断言 → 严重度（当规则没命中、但日志里有明确的断言级别时使用）。 */
export function assertionSeverity(text) {
  const raw = String(text == null ? '' : text).toLowerCase();
  for (const [phrase, sev] of Object.entries(SENSOR_ASSERT)) {
    if (raw.includes(phrase)) return sev;
  }
  if (/asserted|assert\b/.test(raw)) return 'major';
  if (/deasserted|deassert\b/.test(raw)) return 'info';
  return null;
}

export const RULE_STATS = {
  total: RULES.length,
  byCategory: RULES.reduce((acc, rule) => {
    acc[rule.cat] = (acc[rule.cat] || 0) + 1;
    return acc;
  }, {}),
};
