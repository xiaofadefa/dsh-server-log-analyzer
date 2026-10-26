#!/usr/bin/env python3
"""
手册侦察器：抽文本 + 统计码形态 + 预览关键片段，用于在写抽取规则前判断"这本手册该怎么抽"。

用法：
    python scripts/inspect-manual.py --pdf <手册.pdf> [--dump out.txt] [--page 120] [--chars 600]

输出：
    · 页数 / 字符数 / 关键词出现次数（事件、告警、日志、码、传感器…）
    · 各种"码形态"的命中数（Dell 风格、Lenovo FQXS、0x 十六进制、纯数字 3-5 位…）
    · 若干片段预览（便于人眼确认排版：码是独占一行？跟描述同行？表格分列？）
"""

import argparse
import re
import sys

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

PATTERNS = {
    'Dell 风格 MEM0001': r'(?<![A-Za-z0-9])[A-Z]{3,6}\d{4,5}(?![A-Za-z0-9])',
    'Lenovo FQXS 码': r'FQXS[A-Z]{2,4}\d{4}[A-Z]?',
    '十六进制 0x..': r'0x[0-9A-Fa-f]{2,4}',
    '纯数字 3-4 位': r'(?m)^\d{3,4}$',
    '独立 5 位数字': r'(?m)^\d{5}$',
    '括号数字 (1234)': r'\(\d{3,5}\)',
}

KEYWORDS = ['事件', '告警', '日志', '事件码', '传感器', '严重', '建议', '处理', 'SEL', 'BMC 日志',
            'event', 'alarm', 'log', 'sensor', 'critical', 'major', 'minor']


def read_pdf(path, engine='auto'):
    if engine in ('auto', 'pymupdf'):
        try:
            import pymupdf
        except ImportError:
            pymupdf = None
        if pymupdf is not None:
            doc = pymupdf.open(path)
            pages = [doc[i].get_text() for i in range(len(doc))]
            return pages
    from pypdf import PdfReader
    reader = PdfReader(path)
    return [(page.extract_text() or '') for page in reader.pages]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--pdf', required=True)
    parser.add_argument('--dump', default='')
    parser.add_argument('--page', type=int, default=0, help='预览指定页（1 起）')
    parser.add_argument('--chars', type=int, default=700)
    parser.add_argument('--engine', default='auto', choices=['auto', 'pymupdf', 'pypdf'])
    args = parser.parse_args()

    pages = read_pdf(args.pdf, args.engine)
    text = '\n'.join(pages)
    print(f'页数 = {len(pages)}　字符数 = {len(text)}')
    if args.dump:
        with open(args.dump, 'w', encoding='utf-8') as handle:
            handle.write(text)
        print(f'文本已另存 = {args.dump}')

    print('--- 关键词出现次数 ---')
    for word in KEYWORDS:
        count = text.count(word)
        if count:
            print(f'  {word:12s} {count}')

    print('--- 码形态命中数 ---')
    for label, pattern in PATTERNS.items():
        print(f'  {label:20s} {len(re.findall(pattern, text))}')

    # 找出最像"事件/告警表"的页（关键词密度最高的几页）
    scored = []
    for index, page in enumerate(pages):
        score = sum(page.count(word) for word in ('事件', '告警', '码', '严重', '建议'))
        if score:
            scored.append((score, index + 1, page))
    scored.sort(reverse=True)
    print('--- 最像事件表的前 3 页（页码 : 关键词得分）---')
    for score, number, _ in scored[:3]:
        print(f'  第 {number} 页　得分 {score}')

    targets = [args.page] if args.page else [item[1] for item in scored[:2]]
    for number in targets:
        if not (1 <= number <= len(pages)):
            continue
        print(f'--- 第 {number} 页预览（{args.chars} 字符）---')
        print(pages[number - 1].replace('\n', ' | ')[:args.chars])


if __name__ == '__main__':
    main()
