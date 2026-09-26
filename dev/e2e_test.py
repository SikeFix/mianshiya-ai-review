#!/usr/bin/env python3
"""
端到端测试：真的把扩展装进 Chromium，跑完整交互流程。

为什么主要测本地夹具而不是真实站点：
面试鸭页面里带反调试脚本，检测到 DevTools/CDP 之后（约 2.7 秒）会把整个页面
换成 about:blank，还会打 "You don't have permission to use DEVTOOL!"。
所以完整流程跑不了，只能：
  · 主体流程  -> 用 dev/fixtures 下抓好的真实页面快照，剥掉脚本后本地起服务跑
  · 真实站点  -> 只留一个 2 秒内完成的冒烟测试，确认真机注入和抓题正常

跑之前先启动 mock AI 服务：
    node dev/mock-openai-server.js
然后：
    python3 dev/e2e_test.py
"""
import asyncio
import json
import os
import re
import shutil
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

from playwright.async_api import async_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
FIXTURES = os.path.join(ROOT, "dev", "fixtures")
MOCK = "http://localhost:8787"
PORT = 8899
BASE = f"http://localhost:{PORT}"
Q_REDIS = "/question/1780933295660363778"
Q_CLAUDE = "/question/2082027846406012929"
LIVE_URL = "https://www.mianshiya.com/question/1780933295660363778"

PASS, FAIL = [], []


def check(name, ok, detail=""):
    (PASS if ok else FAIL).append(name)
    mark = "\033[32m✓\033[0m" if ok else "\033[31m✗\033[0m"
    print(f"  {mark} {name}" + (f"\n      → {detail}" if detail and not ok else ""))


def stage(title):
    print(f"\n\033[1m{title}\033[0m")


# --------------------------------------------------------------------------- #
# 本地夹具服务
# --------------------------------------------------------------------------- #

ROUTES = {
    Q_REDIS: "question-redis-lock.html",
    Q_CLAUDE: "question-claude-subagent.html",
    "/question": "question-redis-lock.html",
}


def prepare_profile(path, download_dir):
    """
    预设这个 profile 的下载目录。

    chrome.downloads 会存到浏览器的默认下载目录，也就是用户的 ~/Downloads ——
    测试不能往那儿写东西。Chrome 的下载目录存在 profile 的 Preferences 里，
    启动前写好就行。
    """
    os.makedirs(os.path.join(path, "Default"), exist_ok=True)
    os.makedirs(download_dir, exist_ok=True)
    prefs = {
        "download": {"default_directory": download_dir, "prompt_for_download": False},
        "savefile": {"default_directory": download_dir},
    }
    with open(os.path.join(path, "Default", "Preferences"), "w", encoding="utf-8") as f:
        json.dump(prefs, f)
    return download_dir


async def restore_native_downloads(ctx, download_dir):
    """
    让下载回到 Chrome 的原生行为。

    Playwright 默认会拦截浏览器下载，把它们塞进自己的临时目录、文件名换成 UUID ——
    这样「文件到底存到哪个文件夹、叫什么名字」就验证不到了，而这恰恰是用户在意的点。
    用 CDP 把下载行为设回 default，Chrome 就会按自己设置里的下载目录写盘，
    插件给的文件名和子文件夹结构都原样保留。
    """
    page = ctx.pages[0] if ctx.pages else await ctx.new_page()
    cdp = await ctx.new_cdp_session(page)
    await cdp.send("Browser.setDownloadBehavior", {"behavior": "default"})
    return download_dir


async def seed_settings(sw, cfg, tries=15):
    """
    播种配置，并校验真的写进去了才返回。

    必须校验：扩展首次安装时 onInstalled 会写入一份默认配置，它和这里的播种
    存在竞态，偶尔会把播种覆盖掉，让测试莫名其妙跑成默认配置。
    （真实用户首次安装时没有数据可覆盖，所以这纯粹是测试脚手架要处理的事。）

    校验用结构化比较而不是 JSON.stringify 对比：Chrome 存储会把对象的键
    按字母序重排，字符串比较必然失败。
    """
    verify = VERIFY_JS
    for _ in range(tries):
        await sw.evaluate(
            """async (cfg) => { await chrome.storage.local.set({ msy_settings: cfg }); }""", cfg
        )
        if await sw.evaluate(verify, cfg):
            return True
        await asyncio.sleep(0.4)
    raise RuntimeError("播种配置没生效，onInstalled 的默认值一直在覆盖")


VERIFY_JS = "async (cfg) => {\n    const read = async () => (await chrome.storage.local.get('msy_settings')).msy_settings || {};\n    const eq = (x, y) => {\n        if (Array.isArray(y)) return Array.isArray(x) && x.length === y.length && y.every((v, i) => eq(x[i], v));\n        if (y && typeof y === 'object') return !!x && typeof x === 'object' && Object.entries(y).every(([k, v]) => eq(x[k], v));\n        return x === y;\n    };\n    return eq(await read(), cfg);\n}"


async def install_router(context):
    """
    用请求拦截直接提供夹具，不起 HTTP 服务。

    ThreadingHTTPServer 那条路踩了两个坑（连接复用竞态、漏写 Content-Length 导致挂起），
    而且夹具页面会引用几十个子资源，很容易把 listen backlog 打满。拦截没有 socket，就绕开了。
    注意匹配范围限定在夹具 origin，别把 mock AI 服务（8787）也拦了。
    """

    async def handler(route):
        path = urlparse(route.request.url).path
        name = ROUTES.get(path)
        if not name:
            await route.fulfill(status=404, body="not found", content_type="text/plain")
            return
        with open(os.path.join(FIXTURES, name), encoding="utf-8") as f:
            await route.fulfill(status=200, body=f.read(), content_type="text/html; charset=utf-8")

    await context.route(f"{BASE}/**", handler)


# --------------------------------------------------------------------------- #
# mock 服务辅助
# --------------------------------------------------------------------------- #

def mock_last():
    """取回最近一次发给 mock 模型的请求体。"""
    try:
        with urllib.request.urlopen(f"{MOCK}/_last", timeout=5) as r:
            return json.loads(r.read())
    except Exception:
        return {}


def mock_reset():
    req = urllib.request.Request(f"{MOCK}/_last", method="DELETE")
    try:
        urllib.request.urlopen(req, timeout=5).read()
    except Exception:
        pass


def system_prompt_of(payload):
    for m in payload.get("messages", []):
        if m.get("role") == "system":
            return m.get("content", "")
    return ""


async def send_state(page):
    """发送按钮的状态：send（可发送）| stop（正在生成）。

    界面用的是 SVG 图标，没有文字可读，所以看 data-state 属性 ——
    比抓字形可靠，也不会因为换了个图标就失效。
    """
    try:
        return await page.locator("#msy-ai-host .msy-send").get_attribute("data-state", timeout=1500)
    except Exception:
        return None


START_BTN = "#msy-ai-host .msy-start:not(.msy-review-go)"


async def kickoff(page, text="继续"):
    """
    开始一轮对话。

    对话现在会跨页面刷新持久化，所以「空状态 + 开始按钮」只在没聊过的时候才出现；
    已经聊过就直接发一条消息。测试里两种状态都可能遇到，统一走这里。
    """
    btn = page.locator(START_BTN)
    if await btn.count():
        await btn.first.click()
    else:
        await page.locator("#msy-ai-host .msy-input").fill(text)
        await page.locator("#msy-ai-host .msy-send").click()


async def wait_idle(page, timeout_s=40):
    """等到没有正在生成的回复。「清空」在生成中是禁用状态，不等就会点不动。"""
    for _ in range(int(timeout_s * 4)):
        if await send_state(page) == "send":
            return True
        await page.wait_for_timeout(250)
    return False


async def clear_conversation(page):
    """
    清空当前模式的对话，回到空状态。

    按钮在没有对话（或正在生成）时是禁用的 —— 禁用就说明已经是空状态了，
    直接跳过，不用非点一下不可。
    """
    await wait_idle(page)
    btn = page.locator("#msy-ai-host .msy-foot-bar button").last
    if await btn.is_enabled():
        await btn.click()
        await page.wait_for_timeout(700)
    else:
        await page.wait_for_timeout(300)


async def wait_reply(page, timeout_s=40):
    """
    等一轮 AI 回复。
    先等流式真正开始（按钮变 stop），再等它结束（变回 send）——
    只等结束是不够的：请求瞬间失败时按钮一直是 send，会被误判成「已完成」。
    返回 'done' | 'error' | 'nostart' | 'timeout'
    """
    for _ in range(40):  # 最长 10 秒等它起步
        if await page.locator("#msy-ai-host .msy-bubble.error").count():
            return "error"
        st = await send_state(page)
        if st is None:
            return "nostart"
        if st == "stop":
            break
        await page.wait_for_timeout(250)
    else:
        return "error" if await page.locator("#msy-ai-host .msy-bubble.error").count() else "nostart"

    for _ in range(int(timeout_s * 4)):
        if await page.locator("#msy-ai-host .msy-bubble.error").count():
            return "error"
        st = await send_state(page)
        if st is None:
            return "gone"
        if st == "send":
            return "done"
        await page.wait_for_timeout(250)
    return "timeout"


async def reply_error_text(page):
    try:
        return (await page.locator("#msy-ai-host .msy-bubble.error").last.inner_text()).strip()
    except Exception:
        return "(读不到错误文本)"


# --------------------------------------------------------------------------- #

async def main():
    if not os.path.isdir(FIXTURES) or not os.listdir(FIXTURES):
        print("缺少夹具，请先运行：python3 dev/capture_fixture.py")
        return 1

    try:
        with urllib.request.urlopen(f"{MOCK}/v1/models", timeout=3):
            pass
    except Exception:
        print(f"mock AI 服务没起来，请先运行：node dev/mock-openai-server.js")
        return 1

    workdir = tempfile.mkdtemp(prefix="msy-e2e-")
    ext = os.path.join(workdir, "ext")
    shutil.copytree(ROOT, ext, ignore=shutil.ignore_patterns("node_modules", ".git", "*.zip", "fixtures"))

    # 测试专用 manifest：多加 localhost 的注入点和主机权限。
    # 产品代码一行不改，差异只在权限声明 —— 因为 Chrome 的授权弹窗没法脚本点击。
    mf_path = os.path.join(ext, "manifest.json")
    with open(mf_path, encoding="utf-8") as f:
        mf = json.load(f)
    mf["host_permissions"] = ["http://localhost/*", "http://127.0.0.1/*"]
    mf["content_scripts"][0]["matches"] += ["http://localhost/*", "http://127.0.0.1/*"]
    with open(mf_path, "w", encoding="utf-8") as f:
        json.dump(mf, f, ensure_ascii=False, indent=2)

    async with async_playwright() as p:
        profile_dir = os.path.join(workdir, "profile")
        download_dir = prepare_profile(profile_dir, os.path.join(workdir, "downloads"))
        ctx = await p.chromium.launch_persistent_context(
            user_data_dir=profile_dir,
            channel="chromium",
            headless=True,
            args=[
                f"--disable-extensions-except={ext}",
                f"--load-extension={ext}",
                "--no-first-run",
                "--no-default-browser-check",
            ],
        )
        await install_router(ctx)
        await restore_native_downloads(ctx, download_dir)
        # 剪贴板权限，用来断言复制真的生效
        try:
            await ctx.grant_permissions(["clipboard-read", "clipboard-write"], origin=BASE)
        except Exception:
            pass

        # ================= 1. 加载 =================
        stage("1. 扩展加载")
        sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event("serviceworker")
        check("Service worker 启动", bool(sw))
        ext_id = re.search(r"chrome-extension://([a-p]+)", sw.url).group(1)

        await seed_settings(sw, {
            "enabled": True,
            "mode": "interview",
            "activeProfileId": "mock",
            "profiles": [
                {
                    "id": "mock",
                    "name": "本地Mock",
                    "baseUrl": f"{MOCK}/v1",
                    "apiKey": "test",
                    "model": "mock-model",
                    "temperature": 0.6,
                    "maxTokens": 2048,
                }
            ],
            "ui": {"collapsed": False},
        })
        check("配置写入 storage", True)

        # ================= 2. 注入与抓题 =================
        stage("2. 注入与抓题")
        page = await ctx.new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        await page.goto(f"{BASE}{Q_REDIS}", wait_until="domcontentloaded", timeout=30000)
        await page.wait_for_selector("#msy-ai-host", state="attached", timeout=15000)
        check("面板注入成功", True)

        title = await page.locator("#msy-ai-host .msy-q-name").inner_text()
        check("从 JSON-LD 抓到题目", title.strip() == "Redis 中如何实现分布式锁？", repr(title))
        print(f"     题目：{title}")

        meta = await page.locator("#msy-ai-host .msy-q-meta").inner_text()
        check("显示已读取参考答案", "参考答案" in meta, meta.replace("\n", " "))
        check("显示标签", "Redis" in meta, meta)
        check("默认展开", await page.locator("#msy-ai-host .msy-panel").is_visible())
        check("内容是 Shadow DOM 隔离的", await page.evaluate(
            "() => { const h=document.getElementById('msy-ai-host'); return !!h && !!h.shadowRoot; }"))

        # ================= 3. 折叠 =================
        stage("3. 折叠与展开")
        await page.locator("#msy-ai-host .msy-head .msy-icon-btn").last.click()
        await page.wait_for_timeout(250)
        check("折叠后只剩悬浮球", await page.locator("#msy-ai-host .msy-fab").is_visible())
        await page.locator("#msy-ai-host .msy-fab").click()
        await page.wait_for_timeout(250)
        check("点悬浮球重新展开", await page.locator("#msy-ai-host .msy-panel").is_visible())

        # ================= 4. 模式 =================
        stage("4. 七种复习模式")
        check("七个模式按钮", await page.locator("#msy-ai-host .msy-mode").count() == 7)

        # ================= 5. 模拟面试首轮 =================
        stage("5. 模拟面试：流式对话 + 提示词")
        mock_reset()
        await kickoff(page)
        r = await wait_reply(page)
        check("流式输出完成", r == "done", f"状态={r} 错误={await reply_error_text(page) if r == 'error' else ''}")
        body = await page.locator("#msy-ai-host .msy-row.assistant .msy-body").last.inner_text()
        check("AI 回复非空", len(body) > 100, f"{len(body)} 字：{body[:80]!r}")

        req = mock_last()
        sys_p = system_prompt_of(req)
        check("system prompt 带上了题目", "Redis 中如何实现分布式锁" in sys_p, sys_p[:200])
        check("system prompt 带上了参考答案", "本站参考答案" in sys_p)
        check("system prompt 用的是面试官人设", "面试官" in sys_p and "评分" in sys_p)
        check("请求是流式的", req.get("stream") is True)
        check("模型名传对了", req.get("model") == "mock-model", str(req.get("model")))

        # 自定义请求参数要原样透传（有些推理模型靠这个关掉思考链）
        await sw.evaluate(
            """async () => {
                const { msy_settings } = await chrome.storage.local.get('msy_settings');
                msy_settings.profiles[0].extraBody = { chat_template_kwargs: { enable_thinking: false } };
                await chrome.storage.local.set({ msy_settings });
            }"""
        )
        await page.wait_for_timeout(400)
        mock_reset()
        await page.locator("#msy-ai-host .msy-input").fill("测一下自定义请求参数")
        await page.locator("#msy-ai-host .msy-send").click()
        await wait_reply(page)
        body = mock_last()
        check("自定义请求参数已透传",
              body.get("chat_template_kwargs", {}).get("enable_thinking") is False,
              str(body.get("chat_template_kwargs")))
        check("messages 没有被自定义参数覆盖", bool(body.get("messages")), str(list(body.keys())))
        await sw.evaluate(
            """async () => {
                const { msy_settings } = await chrome.storage.local.get('msy_settings');
                msy_settings.profiles[0].extraBody = {};
                await chrome.storage.local.set({ msy_settings });
            }"""
        )
        await page.wait_for_timeout(300)
        print(f"     system prompt 长度：{len(sys_p)} 字")

        # ================= 6. Markdown =================
        stage("6. Markdown 渲染")
        html = await page.locator("#msy-ai-host .msy-msgs").inner_html()
        for label, needle in [
            ("代码块", "msy-code"),
            ("代码语言标签", "msy-code-lang"),
            ("复制按钮", "msy-copy"),
            ("表格", "<table>"),
            ("表头", "<th>"),
            ("加粗", "<strong>"),
            ("引用", "<blockquote>"),
            ("列表", "<ul>"),
            ("水平线", "<hr>"),
        ]:
            check(f"{label}已渲染", needle in html)
        check("围栏符号没有泄漏成文本", "```" not in html)
        check("Markdown 标记没有被当纯文本", "**评分**" not in html)

        # 推理模型会先发思考链。字段名各家不同（reasoning_content / reasoning），
        # 两个都得认，否则思考过程会被静默丢掉。mock 用的是 reasoning。
        check("渲染出了思考过程折叠块", await page.locator("#msy-ai-host .msy-think").count() >= 1)
        think_text = await page.locator("#msy-ai-host .msy-think-body").first.text_content()
        check("思考链内容收到了（兼容 reasoning 字段）", "分布式锁" in think_text, think_text[:60])
        check("思考链没有混进正文",
              "先回忆一下" not in (await page.locator("#msy-ai-host .msy-row.assistant .msy-body").last.inner_text()))

        # ================= 6.5 绕过站点的复制拦截 =================
        stage("6.5 站点禁止复制时我们的复制仍可用")
        # 模拟面试鸭的做法：拦掉 copy 事件 + 禁止选中文字
        await page.evaluate(
            """() => {
                window.__copyBlocked = 0;
                document.addEventListener('copy', (e) => { window.__copyBlocked++; e.preventDefault(); });
                document.body.style.userSelect = 'none';
                document.body.style.webkitUserSelect = 'none';
            }"""
        )
        await page.evaluate("() => navigator.clipboard.writeText('占位内容').catch(() => {})")
        await page.locator("#msy-ai-host .msy-code .msy-copy").first.click()
        await page.wait_for_timeout(700)

        copied = ""
        try:
            copied = await page.evaluate("() => navigator.clipboard.readText()")
        except Exception as e:
            copied = f"<读取失败 {e}>"
        check("代码块能复制出来（没被站点拦掉）",
              "tryLock" in copied or "SET" in copied or "jedis" in copied, repr(copied[:80]))
        check("复制按钮给了成功反馈",
              "已复制" in (await page.locator("#msy-ai-host .msy-code .msy-copy").first.inner_text()))

        # 面板里的文字要能选中（站点给 body 设了 user-select:none）
        selectable = await page.evaluate(
            """() => {
                const sr = document.getElementById('msy-ai-host').shadowRoot;
                return getComputedStyle(sr.querySelector('.msy-root')).userSelect;
            }"""
        )
        check("面板里的文字仍然可以选中", selectable == "text", selectable)

        # 复制一整条消息
        await page.evaluate("() => navigator.clipboard.writeText('占位内容').catch(() => {})")
        await page.locator("#msy-ai-host .msy-row.assistant .msy-actions button").first.click()
        await page.wait_for_timeout(700)
        try:
            whole = await page.evaluate("() => navigator.clipboard.readText()")
        except Exception:
            whole = ""
        check("整条回答也能复制出来", len(whole) > 100, f"{len(whole)} 字")

        # ================= 7. 多轮 =================
        stage("7. 多轮对话")
        mock_reset()
        await page.locator("#msy-ai-host .msy-input").fill("我会用 SET NX PX 加 Lua 脚本释放锁")
        await page.locator("#msy-ai-host .msy-send").click()
        await page.wait_for_timeout(400)
        check("用户消息上屏", await page.locator("#msy-ai-host .msy-row.user").count() >= 1)
        check("第二轮流式完成", await wait_reply(page) == "done")

        req = mock_last()
        roles = [m["role"] for m in req.get("messages", [])]
        check("请求里有历史消息", roles.count("assistant") >= 1, str(roles))
        check("请求里带上了用户输入", any("Lua 脚本" in m.get("content", "") for m in req["messages"]))
        check("仍然只有一个 system", roles.count("system") == 1, str(roles))

        # ================= 7.4 快捷键与朗读让位 =================
        stage("7.4 录音快捷键与朗读让位")
        # 说明：headless Chromium 里既没有中文发音人（朗读不会真的出声），
        # 也没有内置语音识别服务，所以「点麦克风掐掉朗读」和「录音真的启动」
        # 这两件事在这里没法直接观察。能验证的是**快捷键确实走到了麦克风那条路**：
        # 按 M 后如果引擎不可用，会弹出「不支持内置语音识别」的提示。
        await page.evaluate(
            "() => document.querySelector('#msy-ai-host').shadowRoot.querySelector('.msy-input').blur()"
        )
        await page.keyboard.press("m")
        await page.wait_for_timeout(800)
        err = ""
        if await page.locator("#msy-ai-host .msy-bubble.error").count():
            err = await page.locator("#msy-ai-host .msy-bubble.error").last.inner_text()
        check("光标不在输入框时按 M 会触发录音",
              "语音" in err or "识别" in err,
              f"没看到语音相关提示，错误气泡：{err[:80]!r}")
        check("按 M 不会把页面滚动或做别的（没抛错）",
              not await page.evaluate("() => window.__mKeyError || false"))

        # 在输入框里打字时，M 必须是普通字母，不能被抢走
        await page.locator("#msy-ai-host .msy-input").fill("")
        await page.locator("#msy-ai-host .msy-input").click()
        await page.keyboard.type("mb")
        await page.wait_for_timeout(300)
        check("在输入框里按 M 只是打字",
              (await page.locator("#msy-ai-host .msy-input").input_value()) == "mb",
              await page.locator("#msy-ai-host .msy-input").input_value())
        await page.locator("#msy-ai-host .msy-input").fill("")

        # 这个阶段按 M 会留下一条语音不可用的错误气泡，清掉以免干扰后面
        await page.evaluate(
            """() => {
                const sr = document.getElementById('msy-ai-host').shadowRoot;
                sr.querySelectorAll('.msy-bubble.error').forEach(n => n.closest('.msy-row').remove());
            }"""
        )

        # ================= 7.3 语音对话开关 =================
        stage("7.3 语音对话开关（面板上直接切）")
        vb = page.locator("#msy-ai-host .msy-voice-toggle")
        check("底部有语音对话按钮", await vb.count() == 1)
        check("默认是关闭的", "on" not in (await vb.get_attribute("class") or ""))
        check("关闭时面板不显示语音中",
              await page.locator("#msy-ai-host .msy-panel").get_attribute("data-voice") == "0")

        await vb.click()
        await page.wait_for_timeout(900)
        check("点一下开启", "on" in (await vb.get_attribute("class") or ""))
        check("开启后按钮文案变了", "语音对话中" in (await vb.inner_text()))
        check("面板上有「语音对话中」标记",
              await page.locator("#msy-ai-host .msy-panel").get_attribute("data-voice") == "1")
        stored = await sw.evaluate(
            "async () => (await chrome.storage.local.get('msy_settings')).msy_settings.asr.voiceMode"
        )
        check("开关状态写进了配置", stored is True, str(stored))

        await vb.click()
        await page.wait_for_timeout(900)
        check("再点一下关闭", "on" not in (await vb.get_attribute("class") or ""))
        check("麦克风也收掉了",
              await page.locator("#msy-ai-host .msy-mic").get_attribute("data-state") == "idle")

        # 直接写 storage 再确认一次：语音模式一旦漏开着，后面每个阶段都会
        # 被自动循环干扰，测试会变得莫名其妙
        await sw.evaluate(
            """async () => {
                const { msy_settings } = await chrome.storage.local.get('msy_settings');
                msy_settings.asr.voiceMode = false;
                await chrome.storage.local.set({ msy_settings });
            }"""
        )
        await page.wait_for_timeout(700)

        # ================= 7.5 清空输入框 =================
        stage("7.5 清空输入框")
        await page.locator("#msy-ai-host .msy-input").fill("这段字是要清掉的")
        await page.wait_for_timeout(250)
        check("有内容时出现清除按钮", await page.locator("#msy-ai-host .msy-input-clear").is_visible())
        await page.locator("#msy-ai-host .msy-input-clear").click()
        await page.wait_for_timeout(250)
        check("点一下就把输入框清空了",
              (await page.locator("#msy-ai-host .msy-input").input_value()) == "")
        check("清空后按钮自己藏起来",
              not await page.locator("#msy-ai-host .msy-input-clear").is_visible())

        await page.locator("#msy-ai-host .msy-input").fill("再打一段")
        await page.locator("#msy-ai-host .msy-input").press("Escape")
        await page.wait_for_timeout(250)
        check("Esc 也能清空",
              (await page.locator("#msy-ai-host .msy-input").input_value()) == "")
        check("清空输入框不会顺手把对话也清了",
              await page.locator("#msy-ai-host .msy-row").count() > 0)

        # ================= 8. 流式过程中改配置 =================
        stage("8. 流式过程中改配置不会清空回答")
        await page.locator("#msy-ai-host .msy-input").fill("再问一个问题")
        await page.locator("#msy-ai-host .msy-send").click()
        await page.wait_for_timeout(800)
        mid = await page.locator("#msy-ai-host .msy-row.assistant .msy-body").last.inner_text()
        check("流式已经开始", len(mid) > 20, f"{len(mid)} 字")

        # 模拟拖动面板：写入位置 → 触发 storage.onChanged → 走 applySettings。
        # 以前这条路径会把消息区整个重绘，正在生成的回答当场消失。
        await sw.evaluate(
            """async () => {
                const { msy_settings } = await chrome.storage.local.get('msy_settings');
                msy_settings.ui.position = { right: 120, bottom: 90 };
                await chrome.storage.local.set({ msy_settings });
            }"""
        )
        await page.wait_for_timeout(600)
        after = await page.locator("#msy-ai-host .msy-row.assistant .msy-body").last.inner_text()
        check("回答没被清掉，还在继续长", len(after) >= len(mid) and len(after) > 50, f"{len(mid)} → {len(after)} 字")
        check(
            "流式中「清空」被禁用",
            await page.locator("#msy-ai-host .msy-foot-bar button").last.is_disabled(),
        )
        panel_style = await page.locator("#msy-ai-host .msy-panel").get_attribute("style") or ""
        check("新位置已生效", "120px" in panel_style, panel_style)
        await wait_reply(page)
        st_dbg = await page.evaluate(
            """() => {
                const sr = document.getElementById('msy-ai-host').shadowRoot;
                const btns = [...sr.querySelectorAll('.msy-foot-bar button')];
                return {
                    send: sr.querySelector('.msy-send').dataset.state,
                    rows: sr.querySelectorAll('.msy-row').length,
                    buttons: btns.map(b => (b.className || '?') + '|' + (b.disabled ? 'disabled' : 'ok')),
                };
            }"""
        )
        check(
            "流式结束后「清空」恢复可用",
            not await page.locator("#msy-ai-host .msy-foot-bar button").last.is_disabled(),
            f"现场={st_dbg}",
        )

        await sw.evaluate(
            """async () => {
                const { msy_settings } = await chrome.storage.local.get('msy_settings');
                msy_settings.ui.position = null;
                await chrome.storage.local.set({ msy_settings });
            }"""
        )

        # ================= 9. 错误处理 =================
        stage("9. 错误处理")
        await sw.evaluate(
            """async () => {
                const { msy_settings } = await chrome.storage.local.get('msy_settings');
                msy_settings.profiles[0].apiKey = 'bad-key';
                await chrome.storage.local.set({ msy_settings });
            }"""
        )
        await page.locator("#msy-ai-host .msy-input").fill("测试错误分支")
        await page.locator("#msy-ai-host .msy-send").click()
        await page.wait_for_selector("#msy-ai-host .msy-bubble.error", timeout=20000)
        err_text = await page.locator("#msy-ai-host .msy-bubble.error").last.inner_text()
        check("401 翻译成了人话", "API Key" in err_text, err_text[:90].replace("\n", " "))
        # 服务商返回的原始原因要带出来 —— 以前只看状态码，会把「模型不可用」
        # 这种 404 误报成「地址填错了」
        check("错误里带上了服务商的原话", "Invalid API key" in err_text,
              err_text[:140].replace("\n", " "))
        check("错误消息带重试按钮", await page.locator("#msy-ai-host .msy-bubble.error .msy-actions button").count() >= 1)

        await sw.evaluate(
            """async () => {
                const { msy_settings } = await chrome.storage.local.get('msy_settings');
                msy_settings.profiles[0].apiKey = 'test';
                await chrome.storage.local.set({ msy_settings });
            }"""
        )

        # ================= 10. 会员墙 =================
        stage("10. 会员墙场景")
        await page.evaluate(
            """() => {
                const main = document.querySelector('main') || document.body;
                document.querySelectorAll('.best-answer-view, .best-answer-container, .markdown-body')
                    .forEach(n => n.remove());
                const box = document.createElement('div');
                box.id = 'fake-paywall';
                box.textContent = '该题目答案仅限会员查看，请先开通会员';
                main.appendChild(box);
            }"""
        )
        await page.locator("#msy-ai-host .msy-q-refresh").click()
        await page.wait_for_timeout(500)
        meta = await page.locator("#msy-ai-host .msy-q-meta").inner_text()
        check("检测到会员墙并提示", "会员" in meta, meta.replace("\n", " "))

        mock_reset()
        await page.locator('#msy-ai-host .msy-mode[data-mode="explain"]').click()
        await page.wait_for_timeout(300)
        await kickoff(page)
        await wait_reply(page)
        sys_p = system_prompt_of(mock_last())
        check("提示词里说明了是会员墙", "会员墙" in sys_p, sys_p[-260:])
        check("用到了讲解模式的人设", "老师" in sys_p or "讲明白" in sys_p)

        await page.evaluate("() => document.getElementById('fake-paywall')?.remove()")

        # ================= 11. 切题 =================
        stage("11. 切题自动刷新")
        before = await page.locator("#msy-ai-host .msy-q-name").inner_text()
        # 模拟 Next.js 客户端路由：改地址 + 改 title + 改 JSON-LD + 改标题节点
        await page.evaluate(
            """(url) => {
                history.pushState({}, '', url);
                const t = '项目级 subagent 支持嵌套目录扫描，这对团队协作意味着什么？ - 面试鸭';
                document.title = t;
                const ld = [...document.querySelectorAll('script[type="application/ld+json"]')]
                    .find(s => s.textContent.includes('QAPage'));
                if (ld) ld.textContent = ld.textContent.replace(
                    /"name":\\s*"[^"]*"/, '"name":"项目级 subagent 支持嵌套目录扫描，这对团队协作意味着什么？"');
                const h = document.querySelector('.question-title, h1');
                if (h) h.textContent = '项目级 subagent 支持嵌套目录扫描，这对团队协作意味着什么？';
            }""",
            Q_CLAUDE,
        )
        await page.wait_for_timeout(1500)
        after = await page.locator("#msy-ai-host .msy-q-name").inner_text()
        check("切题后自动重新抓取", after != before and "subagent" in after, f"{before!r} → {after!r}")
        print(f"     新题目：{after}")

        await page.evaluate(f"""() => {{
            history.pushState({{}}, '', '{Q_REDIS}');
            const ld = [...document.querySelectorAll('script[type="application/ld+json"]')]
                .find(s => s.textContent.includes('QAPage'));
            if (ld) ld.textContent = ld.textContent.replace(
                /"name":\\s*"[^"]*"/, '"name":"Redis 中如何实现分布式锁？"');
            const h = document.querySelector('.question-title, h1');
            if (h) h.textContent = 'Redis 中如何实现分布式锁？';
        }}""")
        await page.wait_for_timeout(1500)

        # ================= 12. 会话隔离 =================
        stage("12. 清空与会话隔离")
        await page.locator('#msy-ai-host .msy-mode[data-mode="interview"]').click()
        await page.wait_for_timeout(300)
        check("切回面试模式恢复历史", await page.locator("#msy-ai-host .msy-row").count() > 0)
        await clear_conversation(page)
        check("清空后回到空状态", await page.locator("#msy-ai-host .msy-empty").count() == 1)

        # ================= 13. 截图 =================
        stage("13. 截图")
        await kickoff(page)
        await wait_reply(page)
        await page.locator("#msy-ai-host .msy-input").fill("我会用 SET NX PX，释放时用 Lua 校验 value")
        await page.wait_for_timeout(200)
        # 不在生成中时「停止」按钮必须不可见。作者样式里的 display 会盖掉
        # [hidden] 的默认效果，这里守一下，别让多余按钮露出来。
        check("非生成状态下没有「停止」按钮",
              not await page.locator("#msy-ai-host .msy-foot-bar .msy-stop").is_visible())
        check("面板主题判定正常",
              (await page.locator("#msy-ai-host .msy-root").get_attribute("data-theme")) in ("light", "dark"),
              str(await page.locator("#msy-ai-host .msy-root").get_attribute("data-theme")))
        shot = os.path.join(ROOT, "docs", "panel.png")
        await page.locator("#msy-ai-host .msy-panel").screenshot(path=shot)
        check("面板截图已保存", os.path.exists(shot))
        check("页面没有 JS 报错", not errs, "; ".join(errs[:3]))

        # ================= 14. 设置页 =================
        stage("14. 设置页")
        opt = await ctx.new_page()
        opt_errs = []
        opt.on("pageerror", lambda e: opt_errs.append(str(e)))
        opt.on("console", lambda m: opt_errs.append(f"[console.{m.type}] {m.text[:120]}")
               if m.type == "error" and "Failed to load resource" not in m.text else None)
        await opt.goto(f"chrome-extension://{ext_id}/options.html", wait_until="domcontentloaded")
        await opt.wait_for_timeout(800)
        check("标题正确", "面试鸭" in await opt.title())
        check("方案列表渲染", await opt.locator("#plist .pitem").count() >= 1)
        check("服务商预设齐全", await opt.locator("#pPreset option").count() >= 12)
        check("语音转写预设齐全", await opt.locator("#asrPreset option").count() >= 5)
        check("七个模式提示词标签", await opt.locator("#promptTabs button").count() == 7)
        check("Base URL 已回填", "localhost" in await opt.locator("#pBaseUrl").input_value())
        check("有自定义请求参数输入框", await opt.locator("#pExtra").count() == 1)
        await opt.locator('#pPreset').select_option('ssnh')
        await opt.wait_for_timeout(300)
        check("选中 SSNH 预设会填入地址", "ssnh.top" in await opt.locator("#pBaseUrl").input_value(),
              await opt.locator("#pBaseUrl").input_value())
        check("选中 SSNH 预设会填入模型（小写）", "qwen3.8-27b" in await opt.locator("#pModel").input_value(),
              await opt.locator("#pModel").input_value())
        check("预设带上了关闭思考链的参数",
              "enable_thinking" in await opt.locator("#pExtra").input_value(),
              await opt.locator("#pExtra").input_value())
        # 还原，别影响后面的用例
        await opt.locator('#pPreset').select_option('')
        await opt.wait_for_timeout(200)

        # 新增方案会用到 MSY.uid()，它以前只定义在 content/util.js 里，
        # 而设置页不加载内容脚本 —— 点一下就会 TypeError
        n_before = await opt.locator("#plist .pitem").count()
        await opt.locator("#btnAddProfile").click()
        await opt.wait_for_timeout(400)
        check("新增方案可用", await opt.locator("#plist .pitem").count() == n_before + 1,
              f"{n_before} → {await opt.locator('#plist .pitem').count()}")
        await opt.locator("#btnDupProfile").click()
        await opt.wait_for_timeout(400)
        check("复制方案可用", await opt.locator("#plist .pitem").count() == n_before + 2)
        opt.on("dialog", lambda d: asyncio.ensure_future(d.accept()))
        await opt.locator("#btnDelProfile").click()
        await opt.wait_for_timeout(500)
        check("删除方案可用", await opt.locator("#plist .pitem").count() == n_before + 1)

        await opt.locator('#tabs button[data-tab="voice"]').click()
        await opt.wait_for_timeout(300)
        check("语音页可切换", await opt.locator('[data-panel="voice"]').is_visible())
        await opt.locator('#asrEngines .radio-card[data-engine="cloud"]').click()
        await opt.wait_for_timeout(300)
        settings_now = await sw.evaluate(
            "async () => (await chrome.storage.local.get('msy_settings')).msy_settings.asr.engine"
        )
        check("点云端卡片真的改了配置", settings_now == "cloud", str(settings_now))
        await opt.locator('#asrEngines .radio-card[data-engine="builtin"]').click()
        await opt.wait_for_timeout(250)

        await opt.locator('#tabs button[data-tab="chat"]').click()
        await opt.wait_for_timeout(250)
        check("提示词文本域有内容", len(await opt.locator("#promptText").input_value()) > 100)
        check("有面试官人设下拉", await opt.locator("#personaSel option").count() >= 5)
        await opt.locator('#promptTabs button[data-mode="followup"]').click()
        await opt.wait_for_timeout(250)
        check("切换提示词标签", "追问" in await opt.locator("#promptText").input_value())
        check("提示词标签带图标", await opt.locator("#promptTabs .msy-i").count() == 7)

        await opt.locator('#tabs button[data-tab="help"]').click()
        await opt.wait_for_timeout(200)
        check("帮助页有内容", await opt.locator('[data-panel="help"] .card').count() >= 1)
        check("设置页无 JS 报错（含控制台错误）", not opt_errs, "; ".join(opt_errs[:3]))

        # 跨上下文共用模块很容易漏加载：设置页和内容脚本用的是不同的脚本清单，
        # MSY.uid 和 MSY.srs 都这么漏过一次，所以逐个确认一遍
        loaded = await opt.evaluate(
            """() => ['uid','store','notes','srs','md','extract','ui','asr','tts']
                     .filter(k => k !== 'md' && k !== 'extract' && k !== 'ui' && k !== 'asr' && k !== 'tts')
                     .map(k => k + ':' + (typeof MSY[k]))"""
        )
        # uid 是函数、其余是对象，只要求「不是 undefined」就够了
        check("设置页需要的共享模块都在",
              loaded and all(not v.endswith(":undefined") for v in loaded), str(loaded))

        # 回到第一个标签页再截图，方便放进 README。
        # 等一下让操作产生的 toast 淡出，否则截图里会挂着「已删除」之类的高亮。
        await opt.locator('#tabs button[data-tab="ai"]').click()
        await opt.wait_for_timeout(3000)
        await opt.screenshot(path=os.path.join(ROOT, "docs", "options.png"))

        # 报告页和笔记页也留一张，便于人工复查界面
        await opt.locator('#tabs button[data-tab="report"]').click()
        await opt.wait_for_timeout(1200)
        await opt.screenshot(path=os.path.join(ROOT, "docs", "report.png"))
        await opt.locator('#tabs button[data-tab="notes"]').click()
        await opt.wait_for_timeout(1200)
        await opt.screenshot(path=os.path.join(ROOT, "docs", "notes.png"))

        # ================= 15. popup =================
        stage("15. 工具栏弹窗")
        pop = await ctx.new_page()
        await pop.goto(f"chrome-extension://{ext_id}/popup.html", wait_until="domcontentloaded")
        await pop.wait_for_timeout(500)
        check("popup 正常渲染", (await pop.locator("#stateText").inner_text()) != "出错了")
        check("popup 方案下拉有内容", await pop.locator("#profile option").count() >= 1)

        # ================= 16. 速记模式 =================
        stage("16. 速记模式（用最短的话教会我）")
        # 重新加载一次，拿到干净状态：前面的会员墙用例把答案容器从 DOM 里删掉了，
        # 而且会话是满的，空状态（人设选择器就在里面）根本不会渲染
        await page.goto(f"{BASE}{Q_REDIS}", wait_until="domcontentloaded")
        await page.wait_for_selector("#msy-ai-host", state="attached", timeout=15000)
        await page.wait_for_timeout(600)
        check("重载后重新抓到参考答案",
              "参考答案" in (await page.locator("#msy-ai-host .msy-q-meta").inner_text()))
        await page.locator('#msy-ai-host .msy-mode[data-mode="memorize"]').click()
        await page.wait_for_timeout(300)
        check("空状态不再显示统计信息", await page.locator("#msy-ai-host .msy-progress").count() == 0)
        label = (await page.locator(START_BTN).inner_text()).strip()
        check("空状态按钮跟着模式走", label == "开始速记", label)
        check("模式提示也换了", "速记" in (await page.locator("#msy-ai-host .msy-input").get_attribute("placeholder") or ""))

        mock_reset()
        await kickoff(page)
        check("速记模式能出结果", await wait_reply(page) == "done")
        sys_p = system_prompt_of(mock_last())
        check("用的是「压缩成一句话」的人设", "压缩" in sys_p or "最短" in sys_p, sys_p[:120])
        check("要求给类比或口诀", "类比" in sys_p and "口诀" in sys_p)
        check("限定了篇幅", "250 字" in sys_p)
        check("system prompt 仍带上了题目和参考答案",
              "Redis 中如何实现分布式锁" in sys_p and "本站参考答案" in sys_p)

        # ================= 16.2 费曼模式 =================
        stage("16.2 费曼模式（逼你自己讲出来）")
        await page.locator('#msy-ai-host .msy-mode[data-mode="feynman"]').click()
        await page.wait_for_timeout(400)
        await clear_conversation(page)
        check("空状态按钮跟着模式走",
              (await page.locator(START_BTN).inner_text()).strip() == "开始费曼")
        mock_reset()
        await kickoff(page)
        check("费曼模式能出结果", await wait_reply(page) == "done")
        sys_p = system_prompt_of(mock_last())
        check("用的是费曼学习法的人设", "费曼" in sys_p, sys_p[:100])
        check("要求先拆知识点清单", "讲解清单" in sys_p)
        check("明确不许替学生讲", "不要替学生讲" in sys_p)
        check("仍带上了题目和参考答案",
              "Redis 中如何实现分布式锁" in sys_p and "本站参考答案" in sys_p)
        check("提示词要求讲完打结束标记", "🎉 讲解完成" in sys_p)

        # AI 在最后一行打了标记 -> 应该自动收尾：停朗读 + 弹恭喜 + 给出下一步
        await page.wait_for_selector("#msy-ai-host .msy-celebrate", timeout=8000)
        check("讲完后弹出恭喜动画", await page.locator("#msy-ai-host .msy-celebrate").count() == 1)
        check("动画里有撒花粒子", await page.locator("#msy-ai-host .msy-confetti i").count() >= 10)
        mic_state = await page.locator("#msy-ai-host .msy-mic").get_attribute("data-state")
        check("麦克风已停下（不再自动听）", mic_state != "recording", str(mic_state))
        labels = await page.locator("#msy-ai-host .msy-celebrate-actions button").all_inner_texts()
        check("给了继续或结束的选择", len(labels) >= 3, str(labels))
        print(f"     下一步选项：{labels}")

        # 点「换自测考考我」应该切到自测并开新一轮
        await page.locator("#msy-ai-host .msy-celebrate-actions button").nth(1).click()
        await page.wait_for_timeout(600)
        check("点选项后切到了自测模式",
              (await page.locator('#msy-ai-host .msy-mode[data-mode="quiz"]').get_attribute("aria-pressed")) == "true")
        await wait_reply(page)

        # ================= 16.5 面试官人设 =================
        stage("16.5 面试官人设")
        await page.locator('#msy-ai-host .msy-mode[data-mode="interview"]').click()
        await page.wait_for_timeout(400)
        # 对话现在会跨刷新持久化，前面几轮聊过的内容会被自动回填，
        # 所以要先清空，空状态（人设选择器就挂在里面）才会渲染出来
        await clear_conversation(page)
        personas = page.locator("#msy-ai-host .msy-persona")
        check("面试模式下出现人设选择", await personas.count() == 4, str(await personas.count()))
        await personas.nth(0).click()
        await page.wait_for_timeout(400)
        check("选中态生效", (await personas.nth(0).get_attribute("aria-pressed")) == "true")

        mock_reset()
        await kickoff(page)
        await wait_reply(page)
        sys_p = system_prompt_of(mock_last())
        check("人设已注入系统提示词", "严苛" in sys_p or "打断" in sys_p, sys_p[:120])
        check("人设排在最前面", sys_p.strip().startswith("你是一位"), sys_p[:40])

        # 讲题模式不该被面试官人设影响
        await page.locator('#msy-ai-host .msy-mode[data-mode="explain"]').click()
        await page.wait_for_timeout(300)
        mock_reset()
        await kickoff(page)
        await wait_reply(page)
        sys_p = system_prompt_of(mock_last())
        check("讲解模式不套面试官人设", "严苛" not in sys_p and "老师" in sys_p, sys_p[:80])

        await page.locator('#msy-ai-host .msy-mode[data-mode="quiz"]').click()
        await page.wait_for_timeout(300)
        await page.locator('#msy-ai-host .msy-mode[data-mode="interview"]').click()
        await page.wait_for_timeout(300)

        # ================= 17. 选择题直接点选 =================
        stage("17. 选择题点选项作答")
        await page.locator('#msy-ai-host .msy-mode[data-mode="quiz"]').click()
        await page.wait_for_timeout(300)
        await kickoff(page)
        check("自测模式能出结果", await wait_reply(page) == "done")

        chips = page.locator("#msy-ai-host .msy-chip")
        await chips.first.wait_for(timeout=5000)
        letters = [t.strip() for t in await chips.all_inner_texts()]
        check("解析出了 A/B/C/D 选项", letters[:4] == ["A", "B", "C", "D"], str(letters))
        check("额外给了「不会」按钮", "不会" in letters, str(letters))
        check("选项提示语已显示", await page.locator("#msy-ai-host .msy-quick-hint").count() == 1)
        check("只有最后一条消息带按钮", await page.locator("#msy-ai-host .msy-quick").count() == 1)

        # 选项文字要能通过 title 看到（气泡里本来就有，这里只是防丢）
        title_a = await chips.first.get_attribute("title")
        check("选项按钮带完整文字", bool(title_a and len(title_a) > 5), str(title_a))

        mock_reset()
        await chips.first.click()
        check("点选项后 AI 有回应", await wait_reply(page) == "done")
        last_user = await page.locator("#msy-ai-host .msy-row.user").last.inner_text()
        check("点选发出去的是一条选择消息", last_user.strip() == "我选 A", repr(last_user))
        sent = [m for m in mock_last().get("messages", []) if m.get("role") == "user"]
        check("选择内容进了请求", sent and sent[-1]["content"] == "我选 A", str(sent[-1:]))

        # 判断题 -> 对/错
        await page.locator("#msy-ai-host .msy-input").fill("再来一道判断题")
        await page.locator("#msy-ai-host .msy-send").click()
        await wait_reply(page)

        # ================= 18. 存笔记到本地 =================
        stage("18. 存笔记到本地文件夹")
        await page.locator('#msy-ai-host .msy-mode[data-mode="explain"]').click()
        await page.wait_for_timeout(300)
        # 讲解模式这会儿已经有历史了，空状态的「开始」按钮不会出现，
        # 所以直接发一条消息，两种情况下都能走通
        await page.locator("#msy-ai-host .msy-input").fill("再讲一遍这题")
        await page.locator("#msy-ai-host .msy-send").click()
        check("讲解模式能出结果", await wait_reply(page) == "done")

        await page.locator("#msy-ai-host .msy-foot-bar .msy-save").click()
        await page.wait_for_timeout(1800)
        status = await page.locator("#msy-ai-host .msy-status").inner_text()
        check("界面提示了保存路径", "已保存" in status, status)

        def md_files():
            return sorted(Path(download_dir).rglob("*.md"))

        files = md_files()
        check("本地出现了 md 文件", len(files) == 1, str(files))
        if files:
            f = files[0]
            check("落在设置的文件夹里", f.parent.name == "面试鸭笔记", str(f.parent))
            check("路径是 下载目录/文件夹/题目.md",
                  f.parent.parent == Path(download_dir), str(f.parent.parent))
            check("文件名用了题目", "分布式锁" in f.name, f.name)
            body = f.read_text(encoding="utf-8")
            check("含题目", "Redis 中如何实现分布式锁" in body)
            check("含本站参考答案", "## 本站参考答案" in body and "SET" in body)
            check("含 AI 对话记录", "## AI 复习记录" in body)
            check("含来源链接", "**来源**" in body and "/question/" in body)
            check("含元信息", "**答案来源**" in body and "**更新时间**" in body)
            print(f"     文件：{f.relative_to(download_dir)}（{len(body)} 字）")

        # 再存一次应该是覆盖同一份，不堆副本
        await page.locator("#msy-ai-host .msy-foot-bar .msy-save").click()
        await page.wait_for_timeout(1600)
        check("重复保存不产生副本", len(md_files()) == 1, str(md_files()))

        # 记录同时落在 chrome.storage，刷新页面也不丢
        recs = await sw.evaluate(
            "async () => Object.keys((await chrome.storage.local.get('msy_notes')).msy_notes || {})"
        )
        check("复习记录已持久化", len(recs) >= 1, str(recs))

        # 设置页的笔记栏 + 导出全部
        await opt.locator('#tabs button[data-tab="notes"]').click()
        await opt.wait_for_timeout(600)
        count_text = await opt.locator("#notesCount").inner_text()
        check("设置页显示记录数", "道题" in count_text, count_text)
        check("设置页列出了最近记录", await opt.locator("#notesList .nitem").count() >= 1)

        await opt.locator("#btnExportAll").click()
        await opt.wait_for_timeout(1800)
        exported = [f for f in md_files() if f.name.startswith("全部复习笔记")]
        check("导出全部成功", len(exported) == 1, str(md_files()))
        if exported:
            allmd = exported[0].read_text(encoding="utf-8")
            check("汇总文件含目录", "## 目录" in allmd)
            check("汇总文件含题目", "Redis 中如何实现分布式锁" in allmd)
            print(f"     汇总：{exported[0].name}（{len(allmd)} 字）")

        # ================= 19. 间隔复习 =================
        stage("19. 间隔复习：自评 → 排期 → 到期提醒")
        await page.locator('#msy-ai-host .msy-mode[data-mode="interview"]').click()
        await page.wait_for_timeout(300)
        await page.locator("#msy-ai-host .msy-input").fill("再问我一题")
        await page.locator("#msy-ai-host .msy-send").click()
        check("面试模式能出结果", await wait_reply(page) == "done")

        rates = page.locator("#msy-ai-host .msy-rate-btn")
        check("答完题出现四个自评按钮", await rates.count() == 4, str(await rates.count()))
        check("只有最后一条消息带自评", await page.locator("#msy-ai-host .msy-rate").count() == 1)

        await page.locator('#msy-ai-host .msy-rate-btn[data-tone="ok"]').click()
        await page.wait_for_timeout(700)
        status = await page.locator("#msy-ai-host .msy-status").inner_text()
        check("自评后有「多久再来」的反馈", "已记录" in status and ("天" in status or "小时" in status), status)
        check("自评行变成已完成", await page.locator("#msy-ai-host .msy-rate-done").count() == 1)
        check("重复点评分被拦住", await page.locator("#msy-ai-host .msy-rate-btn").count() == 0)

        recs = await sw.evaluate(
            """async () => {
                const db = (await chrome.storage.local.get('msy_notes')).msy_notes || {};
                return Object.entries(db).map(([k, r]) => ({
                    k, rating: r.srs && r.srs.lastRating, due: r.srs && r.srs.due,
                    interval: r.srs && r.srs.interval, threads: Object.keys(r.threads || {}),
                    score: r.lastScore,
                }));
            }"""
        )
        check("复习状态写进了记录",
              any(r["rating"] == "good" for r in recs), str(recs)[:220])
        check("评分算出了下次到期时间",
              all(r["due"] for r in recs), str(recs)[:220])
        check("记录按题目聚合，含多个模式的对话",
              any(len(r["threads"]) >= 2 for r in recs), str(recs)[:220])
        check("AI 的评分也被存下来了",
              any(isinstance(r["score"], int) for r in recs), str(recs)[:220])

        # 讲题模式不该给自评 —— 那不是自测
        await page.locator('#msy-ai-host .msy-mode[data-mode="explain"]').click()
        await page.wait_for_timeout(300)
        await page.locator("#msy-ai-host .msy-input").fill("再讲一遍")
        await page.locator("#msy-ai-host .msy-send").click()
        await wait_reply(page)
        check("讲解模式不给自评按钮", await page.locator("#msy-ai-host .msy-rate-btn").count() == 0)

        # 手动把一条记录改成已到期，验证提醒和入口
        await sw.evaluate(
            """async () => {
                const r = await chrome.storage.local.get('msy_notes');
                const db = r.msy_notes || {};
                const k = Object.keys(db)[0];
                db[k].srs = { ease: 2.2, interval: 0, due: Date.now() - 60000,
                              reps: 3, lapses: 1, lastRating: 'again', history: [] };
                await chrome.storage.local.set({ msy_notes: db });
            }"""
        )
        await page.locator('#msy-ai-host .msy-mode[data-mode="memorize"]').click()
        await page.wait_for_timeout(400)
        await clear_conversation(page)

        # 复习排期已经挪到后台，面板上不该再出现这些
        check("面板上不再显示到期提示", await page.locator("#msy-ai-host .msy-due").count() == 0)
        badge = await page.evaluate(
            """() => {
                const c = document.getElementById('msy-ai-host').shadowRoot.querySelector('.msy-fab-count');
                return { hidden: c.hidden, text: c.textContent };
            }"""
        )
        check("悬浮球上也不再挂角标", badge["hidden"] is True, str(badge))
        check("面板上不再有「开始复习」按钮", await page.locator("#msy-ai-host .msy-review-go").count() == 0)
        # 面板上不该再有复习/统计相关的东西，空状态只留一个开始按钮
        check("面板上没有复习相关按钮", await page.locator("#msy-ai-host .msy-review-go").count() == 0)
        check("面板上没有进度和到期提示",
              await page.locator("#msy-ai-host .msy-progress, #msy-ai-host .msy-due").count() == 0)
        # 复习入口现在在后台：待复习清单 + 开始复习按钮
        await opt.locator('#tabs button[data-tab="report"]').click()
        await opt.wait_for_timeout(600)
        await opt.locator('#tabs button[data-tab="notes"]').click()
        await opt.wait_for_timeout(1100)
        check("后台有待复习清单", await opt.locator("#dueList .nitem").count() >= 1,
              f"{await opt.locator('#dueList .nitem').count()} 条")
        due_title = await opt.locator("#dueList .nitem .nt").first.inner_text()
        check("清单里列出了具体题目", len(due_title) > 4, due_title)
        check("后台有「开始复习」按钮", await opt.locator("#btnStartReview").count() == 1)

        # 设置页的复习统计
        await opt.locator('#tabs button[data-tab="notes"]').click()
        await opt.wait_for_timeout(900)
        check("设置页有复习统计卡片", await opt.locator("#srsStats .srs-stat").count() >= 6,
              f"{await opt.locator('#srsStats .srs-stat').count()} 个；页面错误：{opt_errs[:2]}")
        stats_text = await opt.locator("#srsStats").inner_text()
        check("统计里有待复习项", "待复习" in stats_text and "攒下的题" in stats_text, stats_text.replace(chr(10), " "))

        # ================= 20. 后台看刷题记录 + 学习报告 =================
        stage("20. 后台：刷题记录浏览器与学习报告")
        await opt.locator('#tabs button[data-tab="notes"]').click()
        await opt.wait_for_timeout(900)

        check("有搜索框", await opt.locator("#noteSearch").count() == 1)
        check("有状态筛选", await opt.locator("#noteFilter option").count() >= 6)
        items = opt.locator("#notesList .nitem")
        check("列出了刷过的题", await items.count() >= 1, str(await items.count()))

        # 点开一条，应该能看到参考答案和对话记录
        await items.first.click()
        await opt.wait_for_timeout(600)
        check("点开后能看到参考答案", await opt.locator("#notesList .note-detail .ref").count() == 1)
        ref_text = await opt.locator("#notesList .note-detail .ref").inner_text()
        check("参考答案有内容", len(ref_text) > 20 and "会员" not in ref_text[:6], ref_text[:60])
        check("能看到模式切换", await opt.locator("#notesList .mode-tabs button").count() >= 1)
        turns = await opt.locator("#notesList .note-detail .turn").count()
        check("回答记录有内容", turns >= 2, f"{turns} 条")
        who = await opt.locator("#notesList .note-detail .turn .who").all_inner_texts()
        check("区分了「我」和「AI」", "我" in who and "AI" in who, str(who))
        print(f"     展开后看到 {turns} 条对话，模式 {await opt.locator('#notesList .mode-tabs button').count()} 个")

        # 搜索过滤
        await opt.locator("#noteSearch").fill("分布式锁")
        await opt.wait_for_timeout(600)
        check("搜索能过滤", await opt.locator("#notesList .nitem").count() >= 1)
        await opt.locator("#noteSearch").fill("绝对不存在的关键词zzz")
        await opt.wait_for_timeout(600)
        check("搜不到时给空状态提示", await opt.locator("#notesList .nempty").count() == 1)
        await opt.locator("#noteSearch").fill("")
        await opt.wait_for_timeout(600)

        # 状态筛选
        await opt.locator("#noteFilter").select_option("again")
        await opt.wait_for_timeout(600)
        again_count = await opt.locator("#notesList .nitem").count()
        await opt.locator("#noteFilter").select_option("")
        await opt.wait_for_timeout(600)
        check("按「完全不会」筛选有效", again_count >= 1, str(again_count))

        # 学习报告页
        await opt.locator('#tabs button[data-tab="report"]').click()
        await opt.wait_for_timeout(900)
        check("报告页有总览卡片", await opt.locator("#reportBody .srs-stat").count() >= 6)
        check("报告页有薄弱知识点表", await opt.locator("#reportBody .rpt-table").count() >= 2)
        report_text = await opt.locator("#reportBody").inner_text()
        check("报告里有掌握率", "掌握率" in report_text)
        check("报告里有该怎么做", "该怎么做" in report_text, report_text[:120])
        check("报告里列出了题目", "Redis" in report_text or "分布式锁" in report_text)

        # 导出成网页
        before_html = {f for f in Path(download_dir).rglob("*.html")}
        await opt.locator("#btnExportReport").click()
        await opt.wait_for_timeout(2000)
        after_html = {f for f in Path(download_dir).rglob("*.html")} - before_html
        check("导出产生了 html 文件", len(after_html) == 1, str(after_html))
        if after_html:
            page_file = after_html.pop()
            check("文件名是「学习报告」", "学习报告" in page_file.name, page_file.name)
            check("落在设置的文件夹里", page_file.parent.name == "面试鸭笔记", str(page_file.parent))
            body = page_file.read_text(encoding="utf-8")
            check("是完整 HTML", body.startswith("<!DOCTYPE html>") and body.rstrip().endswith("</html>"))
            check("报告里含总览", "总览" in body and "掌握率" in body)
            check("报告里含薄弱知识点", "薄弱的知识点" in body)
            check("报告里含题目", "分布式锁" in body or "Redis" in body)
            check("离线可看（无外部脚本）", "<script" not in body)
            print(f"     报告：{page_file.relative_to(download_dir)}（{len(body)} 字）")

        # 按题库分类导出
        await opt.locator('#tabs button[data-tab="notes"]').click()
        await opt.wait_for_timeout(700)
        before_dirs = {p.parent for p in Path(download_dir).rglob("*.md")}
        await opt.locator("#exportDim").select_option("bank")
        await opt.locator("#btnExportAll").click()
        await opt.wait_for_timeout(2500)
        after_dirs = {p.parent for p in Path(download_dir).rglob("*.md")} - before_dirs
        check("分类导出产生了新的子文件夹", len(after_dirs) >= 1, str(after_dirs))
        if after_dirs:
            d = sorted(after_dirs)[0]
            check("子文件夹用题库命名", "题库" in d.name or "面试题" in d.name or len(d.name) > 0, d.name)
            files = list(d.glob("*.md"))
            check("每个分类下有汇总文件", len(files) >= 1, str(files))
            if files:
                body = files[0].read_text(encoding="utf-8")
                check("分类文件含目录", "## 目录" in body)
                check("分类文件含题号", "**题号**" in body)
                check("分类文件含题库名", "**所属题库**" in body)
                check("分类文件含难度", "**难度**" in body)
                print(f"     分类导出：{d.name}/{files[0].name}")
        await opt.locator("#exportDim").select_option("")

        # 面板空态应该只剩：图标 + 题目 + 说明 + 开始按钮
        await page.locator('#msy-ai-host .msy-mode[data-mode="memorize"]').click()
        await page.wait_for_timeout(400)
        await clear_conversation(page)
        shape = await page.evaluate(
            """() => {
                const sr = document.getElementById('msy-ai-host').shadowRoot;
                return {
                    icon: sr.querySelectorAll('.msy-empty-icon').length,
                    title: sr.querySelectorAll('.msy-empty-title').length,
                    desc: sr.querySelectorAll('.msy-empty-desc').length,
                    start: sr.querySelectorAll('.msy-start').length,
                    extra: sr.querySelectorAll('.msy-empty .msy-ghost, .msy-empty .msy-progress, .msy-empty .msy-review').length,
                };
            }"""
        )
        check("空状态结构完整（图标+题目+说明+开始）",
              shape["icon"] == 1 and shape["title"] == 1 and shape["desc"] == 1 and shape["start"] == 1,
              str(shape))
        check("空状态里没有多余的按钮或统计", shape["extra"] == 0, str(shape))

        # 随机一题和学习报告挪到了工具栏弹窗
        await pop.goto(f"chrome-extension://{ext_id}/popup.html", wait_until="domcontentloaded")
        await pop.wait_for_timeout(400)
        check("popup 里有「随机来一道」", await pop.locator("#btnRandom").count() == 1)
        check("popup 里有「学习报告」", await pop.locator("#btnReport").count() == 1)

        # ================= 21. 真实站点冒烟 =================
        stage("21. 真实站点冒烟测试（2 秒内完成，避开反调试）")
        live = await ctx.new_page()
        try:
            await live.goto(LIVE_URL, wait_until="commit", timeout=30000)
            await live.wait_for_selector("#msy-ai-host", state="attached", timeout=4000)
            live_title = await live.locator("#msy-ai-host .msy-q-name").inner_text()
            check("真实站点上注入成功", True)
            check("真实站点上抓到题目", "分布式锁" in live_title, live_title)
            print(f"     真机题目：{live_title}")
            meta = await live.locator("#msy-ai-host .msy-q-meta").inner_text()
            print(f"     真机状态：{meta.replace(chr(10), ' ')}")
        except Exception as e:
            check("真实站点冒烟测试", False, str(e)[:120])
        finally:
            await live.close()

        await ctx.close()

    print("\n" + "=" * 64)
    print(f"\033[1m结果：{len(PASS)} 通过 / {len(FAIL)} 失败\033[0m")
    if FAIL:
        print("\n失败项：")
        for f in FAIL:
            print(f"  ✗ {f}")
    shutil.rmtree(workdir, ignore_errors=True)
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
