#!/usr/bin/env python3
"""
抓取面试鸭题目页的快照，作为自动化测试的本地夹具。

为什么要这么做：站点带反调试脚本，检测到 DevTools/CDP 会在约 2.7 秒后把页面
整个换成 about:blank（控制台会打 "You don't have permission to use DEVTOOL!"）。
所以自动化测试不能在真实站点上跑完整流程。

做法：在页面被清掉之前把已经水合（hydration）完的 DOM 抓下来，剥掉所有可执行
脚本（反调试逻辑就在里面），只保留 JSON-LD —— 抽取逻辑依赖它拿结构化标题。

    python3 dev/capture_fixture.py
"""
import asyncio
import os
import re
import shutil
import tempfile

from playwright.async_api import async_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.join(ROOT, "dev", "fixtures")

# 抓两个题目页：一个用来跑主流程，一个用来验证切换题目后重新抓取
PAGES = [
    ("question-redis-lock.html", "https://www.mianshiya.com/question/1780933295660363778"),
    ("question-claude-subagent.html", "https://www.mianshiya.com/question/2082027846406012929"),
]

# 抓取时机：要早于反调试脚本动手（约 2.7 秒），又要晚于 React 水合
CAPTURE_AT_MS = 2100


LD_JSON_RE = re.compile(r'type\s*=\s*["\']application/ld\+json["\']', re.I)


def strip_scripts(html: str) -> str:
    """
    让夹具变成完全自包含的静态文档。

    去掉：
      · 所有可执行脚本 —— 反调试逻辑就在里面
      · 所有 <link>（样式表 / 字体 / preload）—— 指向站点 CDN，测试时请求不到，
        而且样式表会阻塞 DOMContentLoaded，导致页面导航一直挂起

    保留：
      · JSON-LD 结构化数据 —— 抽取逻辑第一层就是读它的 QAPage.mainEntity.name，
        夹具里没有它就没法覆盖那条路径
    """
    kept = []

    def repl(m):
        tag = m.group(0)
        if LD_JSON_RE.search(tag):
            kept.append(tag)
            return ""
        return ""

    out = re.sub(r"<script\b[^>]*>[\s\S]*?</script>", repl, html, flags=re.I)
    out = re.sub(r"<script\b[^>]*/>", "", out, flags=re.I)
    out = re.sub(r"<link\b[^>]*>", "", out, flags=re.I)
    out = re.sub(r"<link\b[^>]*/>", "", out, flags=re.I)
    out = re.sub(r"</head>", "".join(kept) + "</head>", out, count=1)
    return out


async def main():
    os.makedirs(OUT, exist_ok=True)
    workdir = tempfile.mkdtemp(prefix="msy-cap-")

    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(
            user_data_dir=os.path.join(workdir, "profile"),
            channel="chromium",
            headless=True,
            args=["--no-first-run"],
        )
        for name, url in PAGES:
            page = await ctx.new_page()
            await page.goto(url, wait_until="commit", timeout=60000)
            await page.wait_for_timeout(CAPTURE_AT_MS)

            try:
                html = await page.content()
                ld = len(re.findall(r"application/ld\+json", html))
                title = await page.title()
            except Exception as e:
                print(f"  ✗ {name} 抓取失败：{e}")
                await page.close()
                continue

            cleaned = strip_scripts(html)
            path = os.path.join(OUT, name)
            with open(path, "w", encoding="utf-8") as f:
                f.write(cleaned)

            size = len(cleaned) / 1024
            print(f"  ✓ {name}")
            print(f"      页面标题: {title}")
            print(f"      体积: {size:.0f} KB，JSON-LD: {ld} 处，脚本已剥离")
            await page.close()

        await ctx.close()

    shutil.rmtree(workdir, ignore_errors=True)


asyncio.run(main())
