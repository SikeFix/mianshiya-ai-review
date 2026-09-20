#!/usr/bin/env python3
"""
诊断：面板注入后为什么会从 DOM 里消失。
怀疑是 Next.js 的 React hydration 在挂载完成后重写了 body 的子节点，
把我们的宿主元素一起清掉了。这里放几个探针来确认。
"""
import asyncio
import json
import os
import shutil
import tempfile

from playwright.async_api import async_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
URL = "https://www.mianshiya.com/question/1780933295660363778"


async def main():
    workdir = tempfile.mkdtemp(prefix="msy-dbg-")
    ext = os.path.join(workdir, "ext")
    shutil.copytree(ROOT, ext, ignore=shutil.ignore_patterns("node_modules", ".git", "*.zip"))

    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(
            user_data_dir=os.path.join(workdir, "profile"),
            channel="chromium",
            headless=True,
            args=[f"--disable-extensions-except={ext}", f"--load-extension={ext}", "--no-first-run"],
        )
        page = await ctx.new_page()
        logs = []
        page.on("console", lambda m: logs.append(f"[{m.type}] {m.text[:160]}"))
        page.on("pageerror", lambda e: logs.append(f"[pageerror] {str(e)[:200]}"))

        await page.goto(URL, wait_until="commit", timeout=60000)

        # 尽早埋探针：记录 body 的引用，并塞一个自己的标记节点
        try:
            await page.wait_for_function("() => document.body !== null", timeout=30000)
            await page.evaluate(
                """() => {
                    window.__msyBodyRef = document.body;
                    const probe = document.createElement('div');
                    probe.id = '__msy_probe';
                    probe.textContent = 'probe';
                    document.body.append(probe);
                    window.__msyProbe = probe;
                }"""
            )
        except Exception as e:
            print("埋探针失败：", e)

        print("t(s)  host  probe  bodySame  bodyKids  htmlKids  url")
        for i in range(48):
            try:
                st = await page.evaluate(
                    """() => {
                        const host = document.getElementById('msy-ai-host');
                        const probe = window.__msyProbe;
                        return {
                            host: !!host && host.isConnected,
                            hostIn: host ? (host.parentElement === document.body ? 'body'
                                     : host.parentElement === document.documentElement ? 'html' : 'other') : '-',
                            probe: !!probe && probe.isConnected,
                            bodySame: window.__msyBodyRef === document.body,
                            bodyKids: document.body ? document.body.children.length : -1,
                            htmlKids: document.documentElement.children.length,
                            url: location.pathname,
                        };
                    }"""
                )
            except Exception as e:
                st = {"err": str(e)[:60]}
            print(
                f"{i*0.25:5.2f}  {str(st.get('host')):5} {str(st.get('probe')):6} "
                f"{str(st.get('bodySame')):8} {str(st.get('bodyKids')):8} {str(st.get('htmlKids')):8} "
                f"{st.get('hostIn','')} {st.get('url','')}"
            )
            if i > 6 and st.get("host") is False and st.get("probe") is False:
                print("→ host 和 probe 同时消失，说明 body 的子树被整体替换了")
                break
            await page.wait_for_timeout(250)

        print("\n--- 页面控制台（后 25 条）---")
        for line in logs[-25:]:
            print(" ", line)

        await ctx.close()
    shutil.rmtree(workdir, ignore_errors=True)


asyncio.run(main())
