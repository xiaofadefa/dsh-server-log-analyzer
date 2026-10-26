#!/usr/bin/env python3
"""
厂商手册 → 码表候选（code, meaning, severity, action）抽取器。

用法：
    python scripts/extract-vendor-codes.py --pdf  <手册.pdf>  --brand dell   [--out manuals/out]
    python scripts/extract-vendor-codes.py --html <页面.html> --brand lenovo [--out manuals/out]
    python scripts/extract-vendor-codes.py --text <文本.txt>  --brand hpe    [--out manuals/out]

设计取舍：
  · 只做"机器抽取 + 抽样核查"，不做"全自动入库"：手册排版千差万别，
    抽取结果先落成 CSV 供人工/模型抽查，再进 data/vendor-codes（或 codes import）。
  · 支持两种排版：① 码独占一行（PDF 手册常见，码后跟 Message/Severity/Action 小节）
    ② 码与描述同行或同行分列（HTML/表格导出常见：`FQXSPSD2010I：已卸下...` / `MEM0701 | 描述 | Critical`）。
  · 输出长度做截断，避免把整本手册塞进上下文。
"""

import argparse
import csv
import json
import os
import re
import sys

BLOCK_CODE = re.compile(r'^[A-Z]{3,6}\d{4,5}$|^FQX[A-Z]{2,6}\d{4}[A-Z]?$|^0x[0-9A-Fa-f]{2,8}$')
# 注意：
#   ① 不能用 \b 收尾 —— 韩文/中文会紧贴事件码（FQXSPCA0017M은），CJK 属于 \w 会让 \b 失效；
#   ② Lenovo 事件码是 FQXS + 3 字母域 + 4 位数字 + 严重度字母（FQXSPCA0017M，12 字符），
#      写成 {2} 会全部漏掉（实测踩过）；字母数下限设 3 是为了不把型号 SR650 当事件码。
ANY_CODE = re.compile(r'(?<![A-Za-z0-9])(FQX[A-Z]{2,6}\d{4}[A-Z]?|0x[0-9A-Fa-f]{2,8}|[A-Z]{3,5}\d{4,5})(?![A-Za-z0-9])')

SEV_WORDS = {
    'critical': 'critical', 'fatal': 'critical', 'severe': 'critical', 'crit': 'critical',
    'error': 'major', 'major': 'major', 'warning': 'minor', 'warn': 'minor', 'caution': 'minor',
    'info': 'info', 'informational': 'info', 'notice': 'info',
    '紧急': 'critical', '严重': 'critical', '警告': 'minor', '轻微': 'minor', '提示': 'minor', '信息': 'info',
}
SECTION_WORDS = ('message', 'description', 'detailed description', 'action', 'resolution',
                 'suggestion', 'severity', '说明', '描述', '消息', '建议', '处理', '级别', '等级')


def is_block_code(line):
    text = line.strip()
    if not text or len(text) > 26:
        return False
    return bool(BLOCK_CODE.match(text))


def strip_sep(text):
    return re.sub(r'^[\s：:|—\-–>\*]+|[\s|]+$', '', text or '').strip()


# ── 华为 iBMC「ALM-0xXXXXXXXX 名称（部件，级别告警）」专用模式 ──
# 手册排版：`ALM-0x080000C1 PCIe卡CPU严重异常（PCIe Card，严重告警）。`
# PDF 抽取会把长名折行（`PCIe卡 | CPU严重异常（PCIe Card，严重告 | 警）`），必须先归一化再正则。
ALM_RE = re.compile(
    r'ALM-(0x[0-9A-Fa-f]{8})\s*([^（(]{1,90}?)\s*[（(]\s*([^，,）)]{1,40}?)\s*[，,]\s*'
    r'(紧急告警|严重告警|轻微告警|提示告警|重要告警|一般告警|紧急异常|严重异常|一般异常|轻微异常)'
)
ALM_LEVELS = {
    '紧急告警': 'critical', '严重告警': 'critical', '重要告警': 'major',
    '轻微告警': 'minor', '一般告警': 'minor', '提示告警': 'info',
    '紧急异常': 'critical', '严重异常': 'critical', '一般异常': 'minor', '轻微异常': 'minor',
}
ALM_COMPONENTS = {
    'CPU': 'cpu', 'Memory': 'memory', 'PCIe Card': 'pcie', 'PCIe Riser': 'pcie', 'PCIe': 'pcie',
    'Power': 'power', 'Power Supply': 'power', 'Fan': 'thermal', 'Chassis': 'board',
    'System': 'board', 'Mainboard': 'board', 'Disk': 'storage', 'HDD': 'storage', 'Drive': 'storage',
    'RAID': 'raid', 'BMC': 'firmware', 'Port': 'network', 'NIC': 'network', 'LAN': 'network',
    'Temperature': 'thermal', 'Battery': 'power', 'KVM': 'board',
}


# Lenovo 事件码尾字母 = 严重度（I 参考 / N,W 警告 / M 错误 / S 严重）
LENOVO_TAIL_SEVERITY = {'I': 'info', 'N': 'minor', 'W': 'minor', 'M': 'critical', 'S': 'major'}


def normalize_alm_text(lines):
    """收拾 PDF 折行与中文字间空格，让"码 + 名称 + （部件，级别告警）"落回同一段。"""
    text = '\n'.join(lines)
    text = text.replace('|', ' ')
    text = re.sub(r'\s+', ' ', text)
    # 中文与中文之间的空格是折行造成的（"严重告 警" → "严重告警"）；中英之间的空格保留
    text = re.sub(r'(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])', '', text)
    return text


def extract_alm(lines):
    text = normalize_alm_text(lines)
    rows = []
    for match in ALM_RE.finditer(text):
        component = match.group(3).strip()
        rows.append({
            'code': match.group(1),
            'meaning': re.sub(r'\s+', '', strip_sep(match.group(2)))[:200],
            'severity': ALM_LEVELS.get(match.group(4), ''),
            'component': component,
            'category': ALM_COMPONENTS.get(component, ''),
            'action': '',
            'raw_block': match.group(0)[:200],
        })
    best = {}
    for row in rows:
        score = len(row['meaning']) + (60 if row['severity'] else 0) + (30 if row['component'] else 0)
        if row['code'] not in best or score > best[row['code']][0]:
            best[row['code']] = (score, row)
    return [item[1] for item in best.values()]


def detect_severity(*texts):
    for text in texts:
        low = (text or '').lower()
        for word, mapped in SEV_WORDS.items():
            if not word:
                continue
            if re.search(rf'(^|[^a-z]){re.escape(word)}([^a-z]|$)', low):
                return mapped
    return ''


def first_nonempty(lines, start, limit):
    for line in lines[start:start + limit]:
        text = (line or '').strip()
        if text:
            return text
    return ''


def read_pdf_lines(path, engine='auto'):
    """抽取 PDF 文本。默认优先 PyMuPDF（快，大手册才跑得动），失败回退 pypdf。"""
    if engine in ('auto', 'pymupdf'):
        try:
            import pymupdf  # PyMuPDF 1.24+ 的新模块名
        except ImportError:
            pymupdf = None
        if pymupdf is not None:
            doc = pymupdf.open(path)
            total = len(doc)
            out = []
            for index in range(total):
                try:
                    out.append(doc[index].get_text())
                except Exception:
                    out.append('')
                if index % 500 == 0:
                    print(f'  ... 已读 {index}/{total} 页 (pymupdf)', file=sys.stderr)
            return '\n'.join(out).split('\n')
        if engine == 'pymupdf':
            raise RuntimeError('未安装 pymupdf')

    from pypdf import PdfReader
    reader = PdfReader(path)
    out = []
    total = len(reader.pages)
    for index, page in enumerate(reader.pages):
        try:
            text = page.extract_text() or ''
        except Exception:
            text = ''
        out.append(text)
        if index % 200 == 0:
            print(f'  ... 已读 {index}/{total} 页 (pypdf)', file=sys.stderr)
    return '\n'.join(out).split('\n')


def read_html_lines(path):
    raw = open(path, 'r', encoding='utf-8', errors='replace').read()
    raw = re.sub(r'<!--.*?-->', ' ', raw, flags=re.S)
    raw = re.sub(r'<(script|style)\b.*?</\1>', ' ', raw, flags=re.S | re.I)
    raw = re.sub(r'<\s*/\s*(td|th)\s*>', ' | ', raw, flags=re.I)
    raw = re.sub(r'<\s*(br|/tr|/p|/div|/li|/h[1-6])[^>]*>', '\n', raw, flags=re.I)
    raw = re.sub(r'<[^>]+>', ' ', raw)
    for key, value in {'&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'"}.items():
        raw = raw.replace(key, value)
    return [line.strip() for line in raw.split('\n')]


def extract_block(lines, start):
    """码独占一行：抓 Message / Severity / Action 小节。"""
    # 块长度取 80 行：Dell 手册每条消息含 Message / Detailed Description / Action / Severity，
    # 描述较长时 Action 会落在 40 行之后（实测用 40 时 action 只抽到 2%，80 行后显著提升）。
    raw = [l.strip() for l in lines[start + 1:start + 80] if l.strip()]
    stop = 0
    for index, item in enumerate(raw):
        if is_block_code(item) or ANY_CODE.fullmatch(item or ''):
            stop = index
            break
    block = raw[:stop] if stop else raw
    meaning = severity = action = ''
    lowered = [b.lower() for b in block]
    for index, low in enumerate(lowered):
        if not meaning and (low.startswith('message') or low.startswith('description') or low.startswith('说明') or low.startswith('描述')):
            candidate = first_nonempty(block, index + 1, 3)
            if candidate and not is_block_code(candidate):
                meaning = candidate
        if not severity:
            severity = detect_severity(low)
        if not action and (low.startswith('action') or low.startswith('resolution')
                           or low.startswith('suggestion') or low.startswith('建议') or low.startswith('处理')):
            candidate = first_nonempty(block, index + 1, 3)
            if candidate:
                action = candidate
    if not meaning:
        for item in block:
            low = item.lower()
            if any(low.startswith(word) for word in SECTION_WORDS):
                continue
            if len(item) > 12:
                meaning = item
                break
    if not severity:
        severity = detect_severity(' '.join(block[:6]))
    return meaning, severity, action, block


def extract_inline(line, lines, index):
    """码与描述同行/同表格行。"""
    rows = []
    cells = [strip_sep(cell) for cell in line.split('|')] if '|' in line else None
    for match in ANY_CODE.finditer(line):
        code = match.group(1)
        tail = strip_sep(line[match.end():])
        meaning = tail
        next_line = first_nonempty(lines, index + 1, 2)
        if len(meaning) < 6 and next_line and not ANY_CODE.search(next_line):
            meaning = next_line
        if cells:
            for position, cell in enumerate(cells):
                if code in cell:
                    following = [c for c in cells[position + 1:] if c]
                    if following:
                        if len(meaning) < 6 or len(following[0]) > len(meaning):
                            meaning = following[0]
                        severity_cell = next((c for c in following if detect_severity(c)), '')
                        action_cell = next((c for c in following if re.match(r'^[0-9]+[\.、]\s*\S', c) or len(c) > 60), '')
                        rows.append({
                            'code': code,
                            'meaning': meaning[:400],
                            'severity': detect_severity(*following) or detect_severity(cells[position]),
                            'action': (action_cell or '')[:400],
                            'raw_block': line[:300],
                        })
                    break
            else:
                rows.append({'code': code, 'meaning': meaning[:400], 'severity': detect_severity(tail, next_line),
                             'action': '', 'raw_block': line[:300]})
            continue
        if not meaning:
            continue
        rows.append({
            'code': code,
            'meaning': meaning[:400],
            'severity': detect_severity(tail, next_line),
            'action': '',
            'raw_block': line[:300],
        })
    return rows


def extract(lines, brand):
    rows = []
    for index, line in enumerate(lines):
        text = (line or '').strip()
        if not text or len(text) > 4000:
            continue
        if is_block_code(text):
            meaning, severity, action, block = extract_block(lines, index)
            rows.append({'code': text, 'meaning': meaning[:400], 'severity': severity,
                         'action': action[:400], 'raw_block': ' / '.join(block[:4])[:300]})
            continue
        if not ANY_CODE.search(text):
            continue
        rows.extend(extract_inline(text, lines, index))

    best = {}
    for row in rows:
        if not row['code']:
            continue
        score = len(row['meaning']) + len(row['action']) * 2 + (60 if row['severity'] else 0)
        if row['code'] not in best or score > best[row['code']][0]:
            best[row['code']] = (score, row)
    return [item[1] for item in best.values()]


def main():
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass
    parser = argparse.ArgumentParser()
    parser.add_argument('--pdf')
    parser.add_argument('--html')
    parser.add_argument('--text')
    parser.add_argument('--brand', required=True)
    parser.add_argument('--source', default='')
    parser.add_argument('--version', default='')
    parser.add_argument('--out', default='manuals/out')
    parser.add_argument('--limit', type=int, default=0, help='只输出前 N 条（调试用）')
    parser.add_argument('--mode', default='auto', choices=['auto', 'alm'], help='alm = 华为「ALM-0x… 名称（部件，级别告警）」专用模式')
    parser.add_argument('--engine', default='auto', choices=['auto', 'pymupdf', 'pypdf'], help='PDF 文本抽取引擎')
    parser.add_argument('--dump-text', default='', help='把抽取出的文本另存一份（便于复用/复核）')
    parser.add_argument('--only-prefix', default='', help='只保留以该前缀开头的码（如 MEM）')
    args = parser.parse_args()

    if args.pdf:
        print(f'读取 PDF：{args.pdf}（engine={args.engine}）', file=sys.stderr)
        lines = read_pdf_lines(args.pdf, args.engine)
    elif args.html:
        print(f'读取 HTML：{args.html}', file=sys.stderr)
        lines = read_html_lines(args.html)
    elif args.text:
        print(f'读取文本：{args.text}', file=sys.stderr)
        lines = open(args.text, 'r', encoding='utf-8', errors='replace').read().split('\n')
    else:
        parser.error('需要 --pdf / --html / --text')

    print(f'  行数 = {len(lines)}', file=sys.stderr)
    if args.dump_text:
        os.makedirs(os.path.dirname(args.dump_text) or '.', exist_ok=True)
        with open(args.dump_text, 'w', encoding='utf-8') as handle:
            handle.write('\n'.join(lines))
        print(f'  文本已另存：{args.dump_text}', file=sys.stderr)

    if args.mode == 'alm':
        rows = extract_alm(lines)
    else:
        rows = extract(lines, args.brand)

    # Lenovo：尾字母就是严重度，比在文本窗口里扫严重度词可靠得多（实测会被邻近行的 Critical 带偏）
    if args.brand == 'lenovo':
        for row in rows:
            tail = re.match(r'^FQX[A-Z]{2,6}\d{4}([A-Z])$', row.get('code', '') or '')
            if tail and LENOVO_TAIL_SEVERITY.get(tail.group(1)):
                row['severity'] = LENOVO_TAIL_SEVERITY[tail.group(1)]
    if args.only_prefix:
        prefixes = [p.strip().upper() for p in args.only_prefix.split(',') if p.strip()]
        rows = [r for r in rows if any(r['code'].upper().startswith(p) for p in prefixes)]
    if args.limit:
        rows = rows[:args.limit]

    os.makedirs(args.out, exist_ok=True)
    csv_path = os.path.join(args.out, f'{args.brand}-codes.csv')
    fieldnames = ['code', 'meaning', 'severity', 'component', 'category', 'action', 'raw_block']
    with open(csv_path, 'w', encoding='utf-8-sig', newline='') as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames, extrasaction='ignore')
        writer.writeheader()
        writer.writerows(rows)

    stats = {
        'brand': args.brand,
        'source': args.source,
        'version': args.version,
        'mode': args.mode,
        'codes': len(rows),
        'with_meaning': sum(1 for r in rows if r.get('meaning')),
        'with_severity': sum(1 for r in rows if r.get('severity')),
        'with_component': sum(1 for r in rows if r.get('component')),
        'with_action': sum(1 for r in rows if r.get('action')),
        'csv': csv_path,
    }
    stats_path = os.path.join(args.out, f'{args.brand}-codes.stats.json')
    with open(stats_path, 'w', encoding='utf-8') as handle:
        json.dump(stats, handle, ensure_ascii=False, indent=2)

    print(json.dumps(stats, ensure_ascii=False, indent=2))
    print('--- 前 8 条抽样 ---')
    for row in rows[:8]:
        print(f"{row['code']} | {row['severity'] or '-'} | {row['meaning'][:110]}")


if __name__ == '__main__':
    main()
