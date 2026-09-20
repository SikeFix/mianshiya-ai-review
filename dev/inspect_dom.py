#!/usr/bin/env python3
"""检查夹具里各个候选答案容器的真实结构和文本，用来校准抽取选择器。"""
import asyncio
import os

from playwright.async_api import async_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
FIX = os.path.join(ROOT, "dev", "fixtures", "question-redis-lock.html")

SELECTORS = [
    ".best-answer-view",
    ".best-answer-container",
    ".best-answer-view .markdown-body",
    ".best-answer-container .markdown-body",
    '[role="tabpanel"]',
    ".markdown-body",
    "#answer-comment-card",
    ".question-title",
]

JS = """
(sels) => sels.map(sel => {
    const els = [...document.querySelectorAll(sel)];
    return {
        sel,
        count: els.length,
        items: els.slice(0, 3).map(el => ({
            tag: el.tagName.toLowerCase(),
            cls: (el.className || '').toString().slice(0, 110),
            len: (el.innerText || '').length,
            head: (el.innerText || '').replace(/\\s+/g, ' ').slice(0, 150),
            kids: [...el.children].slice(0, 8).map(c => c.tagName.toLowerCase() + '.' + (c.className||'').toString().split(' ')[0]),
        })),
    };
})
"""


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        page = await b.new_page()
        await page.goto("file://" + FIX, wait_until="domcontentloaded")
        data = await page.evaluate(JS, SELECTORS)
        for d in data:
            print(f"\n\033[1m{d['sel']}\033[0m  命中 {d['count']} 个")
            for it in d["items"]:
                print(f"   <{it['tag']}> class={it['cls']!r}")
                print(f"      长度={it['len']}")
                print(f"      开头={it['head']!r}")
                print(f"      子元素={it['kids']}")
        await b.close()


asyncio.run(main())
