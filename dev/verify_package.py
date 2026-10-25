#!/usr/bin/env python3
"""
验证打包产物本身可用。

前面的测试跑的是源码目录（还会给测试专用地打补丁加 localhost 权限），
这个脚本不一样：它先执行打包脚本，然后**原封不动**地加载 dist/ 里那份产物，
直接连真实站点确认能装上、能注入、能抓到题。

这是给「用户真正拿到手的那个东西」做的最后一道关卡。

    python3 dev/verify_package.py
"""
import asyncio
import os
import re
import subprocess
import sys

from playwright.async_api import async_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
LIVE_URL = "https://www.mianshiya.com/question/1780933295660363778"
DIST = os.path.join(ROOT, "dist", "面试鸭AI复习助手")

PASS, FAIL = [], []


def check(name, ok, detail=""):
    (PASS if ok else FAIL).append(name)
    mark = "\033[32m✓\033[0m" if ok else "\033[31m✗\033[0m"
    print(f"  {mark} {name}" + (f"\n      → {detail}" if detail and not ok else ""))


async def main():
    print("\033[1m0. 执行打包\033[0m")
    r = subprocess.run(["bash", "打包.command"], cwd=ROOT, capture_output=True, text=True)
    check("打包脚本执行成功", r.returncode == 0, r.stderr[-300:])
    check("产物文件夹已生成", os.path.isdir(DIST), DIST)
    if not os.path.isdir(DIST):
        return 1

    # 产物里必须只有运行时文件，不能混进开发工具
    entries = sorted(os.listdir(DIST))
    print(f"     产物内容：{entries}")
    for must in ("manifest.json", "background.js", "content", "shared", "icons"):
        check(f"包含 {must}", must in entries)
    for must_not in ("dev", "README.md", "docs", ".gitignore"):
        check(f"不含开发文件 {must_not}", must_not not in entries)

    # manifest 里引用的文件在产物里都存在
    import json

    with open(os.path.join(DIST, "manifest.json"), encoding="utf-8") as f:
        mf = json.load(f)
    refs = [js for cs in mf["content_scripts"] for js in cs["js"]] + [
        mf["background"]["service_worker"],
        mf["action"]["default_popup"],
        mf["options_ui"]["page"],
        "offscreen.html",
        *mf["icons"].values(),
    ]
    missing = [p for p in refs if not os.path.exists(os.path.join(DIST, p))]
    check("manifest 引用的文件齐全", not missing, f"缺：{missing}")

    print("\n\033[1m1. 加载产物\033[0m")
    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(
            user_data_dir=os.path.join(ROOT, "dist", ".verify-profile"),
            channel="chromium",
            headless=True,
            args=[
                f"--disable-extensions-except={DIST}",
                f"--load-extension={DIST}",
                "--no-first-run",
            ],
        )
        try:
            sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event("serviceworker")
            check("服务工作线程启动（manifest 与 background 没问题）", bool(sw))
            ext_id = re.search(r"chrome-extension://([a-p]+)", sw.url).group(1)

            # 设置页
            opt = await ctx.new_page()
            errs = []
            opt.on("pageerror", lambda e: errs.append(str(e)))
            await opt.goto(f"chrome-extension://{ext_id}/options.html", wait_until="domcontentloaded")
            await opt.wait_for_timeout(700)
            check("设置页能打开", "面试鸭" in await opt.title())
            check("方案预设已加载", await opt.locator("#pPreset option").count() >= 12)
            check("设置页无报错", not errs, "; ".join(errs[:2]))

            # 弹窗
            pop = await ctx.new_page()
            await pop.goto(f"chrome-extension://{ext_id}/popup.html", wait_until="domcontentloaded")
            await pop.wait_for_timeout(400)
            check("工具栏弹窗能打开", (await pop.locator("#stateText").inner_text()) != "出错了")

            # 真实站点冒烟（2 秒内，避开站点的反调试脚本）
            print("\n\033[1m2. 真实站点冒烟\033[0m")
            page = await ctx.new_page()
            await page.goto(LIVE_URL, wait_until="commit", timeout=30000)
            await page.wait_for_selector("#msy-ai-host", state="attached", timeout=5000)
            check("面板注入成功", True)
            title = await page.locator("#msy-ai-host .msy-q-name").inner_text()
            check("抓到题目", "分布式锁" in title, title)
            print(f"     题目：{title}")
            modes = await page.locator("#msy-ai-host .msy-mode").count()
            check("七个模式都在", modes == 7, str(modes))
        except Exception as e:
            check("运行产物", False, str(e)[:200])
        finally:
            await ctx.close()

    # 清掉验证用的临时 profile
    import shutil

    shutil.rmtree(os.path.join(ROOT, "dist", ".verify-profile"), ignore_errors=True)

    print("\n" + "=" * 60)
    print(f"\033[1m结果：{len(PASS)} 通过 / {len(FAIL)} 失败\033[0m")
    print(f"\n可直接加载的文件夹：{DIST}")
    if FAIL:
        for f in FAIL:
            print(f"  ✗ {f}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
