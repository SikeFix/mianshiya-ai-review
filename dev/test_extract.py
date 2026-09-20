#!/usr/bin/env python3
"""
抽取器专项测试。

抽取是最容易随站点改版而失效的一环，所以单独测，并且断言的是「输出质量」
而不只是「有没有输出」—— 比如答案里不能混进标签栏的文案。

不需要扩展、不需要 mock 服务，跑得很快：
    python3 dev/test_extract.py
"""
import asyncio
import os
import sys
from urllib.parse import urlparse

from playwright.async_api import async_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
FIXTURES = os.path.join(ROOT, "dev", "fixtures")
ORIGIN = "http://127.0.0.1:8897"

# 路径 -> (夹具文件, 题目关键字, 答案里必须出现的关键字, 期望标签)
ROUTES = {
    "/question/1780933295660363778": (
        "question-redis-lock.html",
        "Redis 中如何实现分布式锁？",
        ["SET", "Lua", "Redis"],
        "Redis",
    ),
    "/question/2082027846406012929": (
        "question-claude-subagent.html",
        "subagent",
        ["subagent"],
        None,
    ),
}

# 页面杂讯的判据分两种：
#   LINES   —— 这些是标签栏/按钮文案，出现时一定是独占一行
#   SUBSTR  —— 这些词组与面试答案内容无关，出现在任何位置都算泄漏
# 像「目录」「展开」这种词在正常技术表述里也会出现
# （比如这题的「项目根目录」「嵌套目录扫描」），所以只按整行判断。
NOISE_LINES = ["推荐答案", "视频讲解", "开始面试", "隐藏答案", "测试一下", "面试问答", "展开", "目录"]
NOISE_SUBSTR = ["推荐答案", "视频讲解", "隐藏答案", "测试一下", "面试问答"]

# 这些是答案正文里的结构性内容，应该保留下来
KEEP = ["回答重点"]

PASS, FAIL = [], []


def check(name, ok, detail=""):
    (PASS if ok else FAIL).append(name)
    mark = "\033[32m✓\033[0m" if ok else "\033[31m✗\033[0m"
    print(f"  {mark} {name}" + (f"\n      → {detail}" if detail and not ok else ""))


async def install_router(page):
    """
    用 Playwright 的请求拦截直接提供夹具，不起 HTTP 服务。

    之前用 ThreadingHTTPServer 踩了两个坑（连接复用竞态、404 漏写
    Content-Length 导致挂起），而且夹具页面会引用几十个 /_next/static/*
    子资源，很容易把 listen backlog 打满。拦截没有 socket，就没这些问题。
    """

    async def handler(route):
        path = urlparse(route.request.url).path
        entry = ROUTES.get(path)
        if not entry:
            await route.fulfill(status=404, body="not found", content_type="text/plain")
            return
        with open(os.path.join(FIXTURES, entry[0]), encoding="utf-8") as f:
            await route.fulfill(status=200, body=f.read(), content_type="text/html; charset=utf-8")

    await page.route(f"{ORIGIN}/**", handler)


async def load_extractor(page):
    for f in ("content/util.js", "content/extract.js"):
        await page.add_script_tag(path=os.path.join(ROOT, f))


async def main():
    if not os.path.isdir(FIXTURES) or not os.listdir(FIXTURES):
        print("缺少夹具，请先运行：python3 dev/capture_fixture.py")
        return 1

    async with async_playwright() as p:
        b = await p.chromium.launch()
        page = await b.new_page()
        await install_router(page)

        for path, (fname, expect_title, must_have, expect_tag) in ROUTES.items():
            print(f"\n\033[1m{path}\033[0m")
            await page.goto(f"{ORIGIN}{path}", wait_until="domcontentloaded")
            await load_extractor(page)

            q = await page.evaluate("() => MSY.extract.current()")

            check("识别为题目页", q["isQuestion"])
            check("抓到题目", expect_title in (q["title"] or ""), repr(q["title"]))
            check("标题来自 JSON-LD", q["titleSource"] == "json-ld", q["titleSource"])
            check("抓到了参考答案", len(q["answer"]) >= 100, f"{len(q['answer'])} 字")
            check("没被误判成会员墙", q["paywalled"] is False)

            # 题号 / 难度 / 所属题库（分类）—— 导出的分类都靠这几个字段
            check("抓到了题号", q["num"].isdigit(), repr(q["num"]))
            check("抓到了难度", q["difficulty"] in ("简单", "中等", "困难"), repr(q["difficulty"]))
            check("抓到了所属题库", bool(q["bank"] and q["bank"]["name"]), str(q["bank"]))
            check("题库链接带了 id", bool(q["bank"] and q["bank"]["id"].isdigit()), str(q["bank"]))
            # 题目页下面挂着一长串「相关题库」推荐，分类只能取第一个
            check("题库只取一个，不是把推荐列表全收进来",
                  len([q["bank"]]) == 1 and len(q["bank"]["name"]) < 40, str(q["bank"]))
            check("标题里的题号前缀被去掉了",
                  not q["title"].lstrip().split(" ")[0].rstrip(".").isdigit(), repr(q["title"][:30]))

            for kw in must_have:
                check(f"答案含关键字 {kw}", kw in q["answer"])

            lines = {l.strip() for l in q["answer"].split("\n")}
            leaked_lines = [n for n in NOISE_LINES if n in lines]
            leaked_sub = [n for n in NOISE_SUBSTR if n in q["answer"]]
            check("答案里没有独占一行的杂讯", not leaked_lines, f"混进了：{leaked_lines}")
            check("答案里没有标签栏文案", not leaked_sub, f"混进了：{leaked_sub}")
            check("保留了答案的正文结构", any(k in q["answer"] for k in KEEP))
            check("答案没有多余空行", "\n\n\n" not in q["answer"])
            check("答案不以标点或空格开头", q["answer"][:1] not in ("，", "。", "、", " "))

            if expect_tag:
                check(f"抓到标签 {expect_tag}", expect_tag in q["tags"], str(q["tags"]))

            print(f"     题目：{q['title']}")
            print(f"     答案 {len(q['answer'])} 字，开头：{q['answer'][:66]!r}")
            print(f"     标签：{q['tags']}")
            print(f"     命中锚点：{q['answerSelector']}")

            # ---------------- 会员墙 ----------------
            await page.evaluate(
                """() => {
                    document.querySelectorAll('.best-answer-view, .best-answer-container, .markdown-body')
                        .forEach(n => n.remove());
                    const box = document.createElement('div');
                    box.textContent = '该题目答案仅限会员查看，请先开通会员';
                    (document.querySelector('main') || document.body).appendChild(box);
                }"""
            )
            q2 = await page.evaluate("() => MSY.extract.current()")
            check("会员墙能被识别", q2["paywalled"] is True)
            check("会员墙时参考答案为空", q2["answer"] == "", repr(q2["answer"][:60]))

            ref = await page.evaluate("() => MSY.extract.referenceBlock(MSY.extract.current(), {})")
            check("会员墙说明写进了上下文", "会员墙" in ref, ref[:130])
            check("会员墙时提示用自身知识作答", "自己的知识" in ref, ref[:130])

            # ---------------- 截断与开关 ----------------
            await page.goto(f"{ORIGIN}{path}", wait_until="domcontentloaded")
            await load_extractor(page)

            ref2 = await page.evaluate(
                """() => MSY.extract.referenceBlock(MSY.extract.current(),
                       { chat: { maxAnswerChars: 120 }, extract: {} })"""
            )
            check("超长答案会被截断", "截断" in ref2, ref2[-70:])

            ref3 = await page.evaluate(
                "() => MSY.extract.referenceBlock(MSY.extract.current(), { extract: { includeReference: false } })"
            )
            check("可以关闭参考答案注入", ref3 == "", repr(ref3))

            # ---------------- 非题目页 ----------------
            await page.evaluate("() => history.pushState({}, '', '/banks')")
            q3 = await page.evaluate("() => MSY.extract.current()")
            check("非题目页不会被误判", q3["isQuestion"] is False)
            await page.evaluate(f"() => history.pushState({{}}, '', '{path}')")

        await b.close()

    print("\n" + "=" * 60)
    print(f"\033[1m结果：{len(PASS)} 通过 / {len(FAIL)} 失败\033[0m")
    if FAIL:
        for f in FAIL:
            print(f"  ✗ {f}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
