#!/usr/bin/env python3
"""
厂商手册 → 运维操作条目（runbook）：命令 / 界面路径 / 检查项。

与 extract-vendor-codes.py 的分工：
  · 那个抽"事件码 → 语义"
  · 这个抽"故障/任务 → 该敲什么命令、点哪个菜单"

用法：
    python scripts/extract-vendor-ops.py --pdf <手册.pdf> --brand huawei  --source "..." --version "35"
    python scripts/extract-vendor-ops.py --text <文本.txt> --brand inspur --source "..." --version "V2.7"
    python scripts/extract-vendor-ops.py ... --out data/ops-runbooks --sample 8

输出 JSON（写入 --out 目录；也可 `dsh-hwlog ops import <file>` 入库到 $DSH_HOME）：
    {brand, product, source, version, entries:[{id, kind, title, category, symptoms, commands, steps, notes}]}
"""

import argparse
import hashlib
import json
import os
import re
import sys

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

# 常见厂商/系统命令行工具（顺序无关，匹配行首）
CLI_TOOLS = (
    'storcli64', 'storcli', 'MegaCli64', 'MegaCli', 'perccli64', 'perccli', 'ssacli', 'hpssacli', 'arcconf',
    'ipmitool', 'ipmiutil', 'racadm', 'ipmcget', 'ipmcset', 'hprest', 'ilorest', 'hponcfg', 'hplog', 'hpasmcli',
    'sas2ircu', 'sas3ircu', 'smartctl', 'nvme', 'mdadm', 'lsblk', 'blkid', 'dmidecode', 'lspci', 'lsusb', 'lsscsi',
    'ethtool', 'ip', 'ifconfig', 'dmesg', 'journalctl', 'systemctl', 'sos', 'sosreport', 'omreport', 'omconfig',
    'esxcli', 'megacli', 'smartctl', 'yum', 'dnf', 'rpm', 'uname', 'cat', 'grep', 'tail', 'head', 'watch', 'date',
)
PROMPT_RE = re.compile(r'^\s*(?:\[?[\w.-]+@[\w.-]+\]?|#|\$|>)\s*[#$>]?\s*')
CMD_RE = re.compile(
    r'^(?:\[?[\w.-]+@[\w.-]+\]?\s*[#$>]\s*)?(' + '|'.join(re.escape(tool) for tool in CLI_TOOLS) + r')\b[^\n]{0,200}'
)
SHELL_CMD_RE = re.compile(r'^\s*(?:#|\$)\s+([A-Za-z][\w./-]{1,40}(?:\s+[^\n]{0,160})?)$')
UI_PATH_RE = re.compile(r'[“"]([^”"]{1,60}(?:[>→]| -&gt; )[^”"]{1,80})[”"]')
NOISE_RE = re.compile(r'文档版本|版权所有|保留一切权利|未经.*许可|符号约定|变更记录|^目\s*录$|^\.{5,}|^\d+\s*$|^图\d|^表\d')
HEADER_RE = re.compile(r'^(?:用户指南|前言|目录|华为|浪潮|联想|戴尔|新华三|中科曙光|HPE|Dell|Lenovo|Inspur|TaiShan|FusionServer|ThinkSystem|PowerEdge)\b[^\n]{0,40}$|^\d+\s+\d{4}-\d{2}-\d{2}$')
BULLET_RE = re.compile(r'^(?:[l•·o]\s+|[-–—]\s+|\d+[.、)]\s*|步骤\s*\d+[:：]?\s*)')
SECTION_RE = re.compile(r'^\s*(\d+(?:\.\d+)*)\s+([^\n]{2,60})$')
ACTION_WORD_RE = re.compile(r'(更换|检查|确认|清理|升级|导出|重启|登录|选择|点击|输入|执行|查看|配置|删除|导入|重建|设置|联系|更换|安装|重启|拔出|插回|备份|恢复|记录|核对)')


def build_noise_set(lines):
    """页眉/页脚/书名识别：整本手册里反复出现的**且不像动作句**的短行。
    注意：厂商手册里"请联系技术支持"这类处置句会重复出现上百次，它们**不是**页眉 —— 必须排除，
    否则步骤会被大量误删（这是实测踩过的坑：iBMC 201 条被压到 29 条）。"""
    counts = {}
    for raw in lines:
        line = (raw or '').strip()
        if 3 <= len(line) <= 70:
            counts[line] = counts.get(line, 0) + 1
    noise = set()
    for line, count in counts.items():
        if count < 15:
            continue
        if ACTION_WORD_RE.search(line):
            continue
        if len(line) <= 30 or re.search(r'(用户指南|手册|参考|版权所有|文档版本|目录|前言|Guide|Manual|Reference|Installation)', line):
            noise.add(line)
    return noise


def clean_step(text):
    step = BULLET_RE.sub('', (text or '').strip()).strip()
    step = re.sub(r'\s{2,}', ' ', step)
    return step.strip('。；;,，').strip() if len(step) <= 4 else step


def merge_steps(items):
    """PDF 折行会把一句话拆成多段：上一段没结束且下一段很短时拼回去。"""
    merged = []
    for item in items:
        if merged and len(item) < 45 and len(merged[-1]) < 60 and len(merged[-1]) + len(item) <= 170 \
                and not re.search(r'[。；;：:）)]$', merged[-1]) and not re.match(r'^[。；;：:]', item):
            merged[-1] = f'{merged[-1]}{item}'
        else:
            merged.append(item)
    return [item for item in merged if 3 <= len(item) <= 170]

CATEGORY_HINTS = [
    ('raid', ['raid', '阵列', 'storcli', 'megacli', 'perccli', 'ssacli', 'arcconf', 'virtual drive', 'preserved cache', 'foreign', '热备', '重建', '校验']),
    ('storage', ['硬盘', '磁盘', 'smartctl', 'disk', 'drive', 'nvme', 'sas', 'ssd', '槽位']),
    ('memory', ['内存', 'dimm', 'memory']),
    ('power', ['电源', 'psu', 'power supply', '供电']),
    ('thermal', ['风扇', '温度', 'fan', 'temp', '散热']),
    ('firmware', ['固件', 'bios', 'bmc', 'ibmc', 'idrac', 'ilo', 'xcc', '升级', 'firmware', 'cpld']),
    ('network', ['网卡', '网口', 'ethtool', 'nic', 'lan', '光模块']),
    ('os', ['日志', 'journalctl', 'dmesg', '系统', 'kexec', '内核']),
]


def read_pdf(path, engine='auto'):
    if engine in ('auto', 'pymupdf'):
        try:
            import pymupdf
        except ImportError:
            pymupdf = None
        if pymupdf is not None:
            doc = pymupdf.open(path)
            return '\n'.join(doc[i].get_text() for i in range(len(doc))).split('\n')
        if engine == 'pymupdf':
            raise
    from pypdf import PdfReader
    reader = PdfReader(path)
    return '\n'.join((page.extract_text() or '') for page in reader.pages).split('\n')


def classify(text):
    low = text.lower()
    for category, hints in CATEGORY_HINTS:
        if any(hint in low for hint in hints):
            return category
    return 'other'


def make_id(brand, kind, key):
    digest = hashlib.sha1(f'{brand}|{kind}|{key}'.encode('utf-8')).hexdigest()[:10]
    return f'{kind}-{digest}'


def clean_command(text):
    cmd = PROMPT_RE.sub('', text.strip())
    cmd = re.sub(r'\s{2,}', ' ', cmd)
    return cmd.strip('`').strip()


def extract(lines, brand, product):
    entries = {}
    section_title = ''
    section_number = ''
    noise_lines = build_noise_set(lines)
    for index, raw in enumerate(lines):
        line = (raw or '').strip()
        if not line:
            continue
        if (NOISE_RE.search(line) and len(line) < 60) or line in noise_lines or HEADER_RE.match(line):
            continue
        section_match = SECTION_RE.match(line)
        if section_match and len(line) < 80:
            section_title = section_match.group(2).strip()
            section_number = section_match.group(1)
            continue

        # 「处理步骤 / 解决方法 / 操作步骤」章节：把其后的编号行收成一条 step 条目
        # （厂商告警手册的价值往往就在这里：告警 → 该按什么顺序做什么）
        if re.search(r'(处理步骤|解决方法|操作步骤|处理建议|故障处理|处理过程|用户操作|修复方法)', line):
            raw_steps = []
            for forward in range(index + 1, min(len(lines), index + 22)):
                candidate = (lines[forward] or '').strip()
                if not candidate:
                    if raw_steps:
                        break
                    continue
                if (NOISE_RE.search(candidate) and len(candidate) < 60) or candidate in noise_lines or HEADER_RE.match(candidate):
                    continue
                if CMD_RE.match(candidate) or UI_PATH_RE.search(candidate):
                    break
                if 3 <= len(candidate) <= 170:
                    raw_steps.append(candidate)
                if len(raw_steps) >= 14:
                    break
            steps = merge_steps(clean_step(item) for item in raw_steps)
            # 标题回溯：本节的告警/事件名（如 "4.10 ALM-0x00000027 电源模块故障（PSU，严重告警）"）
            title = section_title
            if not title or title in ('操作步骤', '处理步骤'):
                for back in range(index - 1, max(-1, index - 12), -1):
                    candidate = (lines[back] or '').strip()
                    if HEADER_RE.match(candidate) or candidate in noise_lines:
                        continue
                    if re.search(r'ALM-0x|告警|故障|异常|失效|超限|错误|不足', candidate) and 4 <= len(candidate) <= 90:
                        title = candidate
                        break
            # 只含 1 步的条目也保留 —— 厂商手册里很多告警的处置就是"更换部件后确认"或"请联系技术支持"一句；
            # 但要求标题确实指向某个告警，避免把"说明"类小节收进来。
            keep_single = bool(steps) and bool(re.search(r'ALM-0x|告警|故障|异常|失效|不足|错误|超限', title or ''))
            if steps and (len(steps) >= 2 or keep_single):
                title = title or '操作步骤'
                key = f'step::{title}::{steps[0][:30]}'
                if key not in entries:
                    entries[key] = {
                        'id': make_id(brand, 'step', key),
                        'kind': 'step',
                        'title': title[:120],
                        'category': classify(f'{title} {" ".join(steps)}'),
                        'symptoms': [title[:120]],
                        'commands': [],
                        'steps': steps,
                        'notes': f'章节 {section_number} {section_title}'.strip(),
                    }
            continue

        command = None
        kind = None
        cmd_match = CMD_RE.match(line)
        if cmd_match:
            command = clean_command(line)
            kind = 'command'
        else:
            shell_match = SHELL_CMD_RE.match(line)
            if shell_match and re.search(r'\s-|/|\.sh|show|list|get', shell_match.group(1)):
                command = clean_command(shell_match.group(1))
                kind = 'command'

        if command:
            if len(command) < 6 or len(command) > 220:
                continue
            # 上下文：往上找两行有意义的中文/英文描述作为"症状/用途"
            context = []
            for back in range(index - 1, max(-1, index - 4), -1):
                candidate = (lines[back] or '').strip()
                if not candidate or NOISE_RE.search(candidate) or CMD_RE.match(candidate):
                    continue
                context.append(candidate)
                if len(context) >= 2:
                    break
            symptoms = [text for text in reversed(context) if len(text) <= 120]
            title = section_title or (symptoms[0] if symptoms else command[:40])
            category = classify(' '.join([title, command] + symptoms))
            key = command.lower()
            if key in entries:
                continue
            entries[key] = {
                'id': make_id(brand, 'command', key),
                'kind': 'command',
                'title': title[:120],
                'category': category,
                'symptoms': symptoms[:2],
                'commands': [command],
                'steps': [],
                'notes': f'章节 {section_number} {section_title}'.strip(),
            }
            continue

        for match in UI_PATH_RE.finditer(line):
            path_text = match.group(1).strip()
            if '>' not in path_text and '→' not in path_text:
                continue
            title = section_title or line.strip()[:60]
            category = classify(f'{title} {path_text}')
            key = f'ui::{path_text}'
            if key in entries:
                continue
            entries[key] = {
                'id': make_id(brand, 'ui', key),
                'kind': 'ui',
                'title': title[:120],
                'category': category,
                'symptoms': [line.strip()[:120]],
                'commands': [],
                'steps': [path_text],
                'notes': f'章节 {section_number} {section_title}'.strip(),
            }

    return list(entries.values())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--pdf')
    parser.add_argument('--text')
    parser.add_argument('--brand', required=True)
    parser.add_argument('--product', default='')
    parser.add_argument('--source', default='')
    parser.add_argument('--version', default='')
    parser.add_argument('--out', default='')
    parser.add_argument('--engine', default='auto', choices=['auto', 'pymupdf', 'pypdf'])
    parser.add_argument('--sample', type=int, default=8)
    args = parser.parse_args()

    if args.pdf:
        print(f'读取 PDF：{args.pdf}', file=sys.stderr)
        lines = read_pdf(args.pdf, args.engine)
    elif args.text:
        print(f'读取文本：{args.text}', file=sys.stderr)
        lines = open(args.text, encoding='utf-8', errors='replace').read().split('\n')
    else:
        parser.error('需要 --pdf 或 --text')

    entries = extract(lines, args.brand, args.product)
    commands = [item for item in entries if item['kind'] == 'command']
    uis = [item for item in entries if item['kind'] == 'ui']
    table = {
        'brand': args.brand,
        'product': args.product,
        'source': args.source,
        'version': args.version,
        'entries': entries,
    }

    stats = {
        'brand': args.brand,
        'total': len(entries),
        'commands': len(commands),
        'ui_paths': len(uis),
    }
    if args.out:
        os.makedirs(args.out, exist_ok=True)
        stamp = (args.version or 'imported').replace('/', '-')
        file = os.path.join(args.out, f'{args.brand}-ops-{stamp}.json')
        with open(file, 'w', encoding='utf-8') as handle:
            json.dump(table, handle, ensure_ascii=False, indent=2)
        stats['file'] = file

    print(json.dumps(stats, ensure_ascii=False, indent=2))
    print('--- 命令抽样 ---')
    for item in commands[:args.sample]:
        print(f"[{item['category']}] {item['title'][:40]} :: {item['commands'][0][:100]}")
    print('--- 界面路径抽样 ---')
    for item in uis[:max(3, args.sample // 2)]:
        print(f"[{item['category']}] {item['steps'][0][:110]}")


if __name__ == '__main__':
    main()
