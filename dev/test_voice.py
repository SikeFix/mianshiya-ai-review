#!/usr/bin/env python3
"""
语音链路测试。

覆盖两块平时看不见、很容易悄悄坏掉的逻辑：

A. 云端录音转写整条链路
   点麦克风 → offscreen 文档开 getUserMedia → MediaRecorder 录音 + 音频线程音量检测
   → base64 经消息通道回传 → 后台拼 multipart 上传 → 拿回转写文本填进输入框。
   用 Chromium 的虚拟麦克风驱动，不需要真麦克风，也不需要真人说话。

B. 流式朗读的断句逻辑
   把 speechSynthesis 换成桩，验证「凑够一个完整句子就立刻排队」「代码块不念」
   「stop 清空队列」这些行为。headless 里没有语音引擎，必须打桩才能测。

C. 静音自动断句
   喂一段「2 秒说话 + 5 秒停顿」的音频，全程不点停止，看它会不会自己收尾。

跑之前先启动 mock 服务：
    node dev/mock-openai-server.js
然后：
    python3 dev/test_voice.py
"""
import asyncio
import array
import json
import math
import os
import shutil
import sys
import tempfile
import urllib.request
import wave
from urllib.parse import urlparse

from playwright.async_api import async_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
FIXTURES = os.path.join(ROOT, "dev", "fixtures")
MOCK = "http://localhost:8787"
ORIGIN = "http://localhost:8896"
Q_REDIS = "/question/1780933295660363778"

PASS, FAIL = [], []


def check(name, ok, detail=""):
    (PASS if ok else FAIL).append(name)
    mark = "\033[32m✓\033[0m" if ok else "\033[31m✗\033[0m"
    print(f"  {mark} {name}" + (f"\n      → {detail}" if detail and not ok else ""))


def stage(t):
    print(f"\n\033[1m{t}\033[0m")


async def install_router(context):
    async def handler(route):
        path = urlparse(route.request.url).path
        if path != Q_REDIS:
            await route.fulfill(status=404, body="not found", content_type="text/plain")
            return
        with open(os.path.join(FIXTURES, "question-redis-lock.html"), encoding="utf-8") as f:
            await route.fulfill(status=200, body=f.read(), content_type="text/html; charset=utf-8")

    await context.route(f"{ORIGIN}/**", handler)


# --------------------------------------------------------------------------- #
# 公共准备
# --------------------------------------------------------------------------- #

CLOUD_ASR = {
    "engine": "cloud",
    "autoSend": False,
    "silenceMs": 1200,
    "cloud": {
        "baseUrl": f"{MOCK}/v1",
        "apiKey": "test",
        "model": "FunAudioLLM/SenseVoiceSmall",
        "language": "zh",
        "reuseChatKey": True,
    },
}


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


async def prepare_context(p, ext, tag, extra_args=()):
    ctx = await p.chromium.launch_persistent_context(
        user_data_dir=os.path.join(ext, "..", f"profile-{tag}"),
        channel="chromium",
        headless=True,
        args=[
            f"--disable-extensions-except={ext}",
            f"--load-extension={ext}",
            "--no-first-run",
            "--use-fake-ui-for-media-stream",      # 自动同意麦克风授权
            "--use-fake-device-for-media-stream",  # 用虚拟设备代替真麦克风
            *extra_args,
        ],
    )
    sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event("serviceworker")
    await seed_settings(sw, {
        "enabled": True,
        "mode": "interview",
        "activeProfileId": "mock",
        "profiles": [
            {"id": "mock", "name": "本地Mock", "baseUrl": f"{MOCK}/v1",
             "apiKey": "test", "model": "mock-model"}
        ],
        "ui": {"collapsed": False},
        "asr": CLOUD_ASR,
    })
    await install_router(ctx)
    return ctx, sw


async def wait_reply(page, timeout_s=40):
    """等一轮 AI 回复结束"""
    for _ in range(40):
        if await page.locator("#msy-ai-host .msy-bubble.error").count():
            return "error"
        st = await page.locator("#msy-ai-host .msy-send").get_attribute("data-state")
        if st == "stop":
            break
        await page.wait_for_timeout(250)
    else:
        return "nostart"
    for _ in range(int(timeout_s * 4)):
        if await page.locator("#msy-ai-host .msy-send").get_attribute("data-state") == "send":
            return "done"
        await page.wait_for_timeout(250)
    return "timeout"


async def kickoff(page, text="继续"):
    """开始一轮：有空状态就点开始，已经有对话就直接发一条。"""
    btn = page.locator("#msy-ai-host .msy-start:not(.msy-review-go)")
    if await btn.count():
        await btn.first.click()
    else:
        await page.locator("#msy-ai-host .msy-input").fill(text)
        await page.locator("#msy-ai-host .msy-send").click()


async def open_panel(ctx):
    page = await ctx.new_page()
    await page.goto(f"{ORIGIN}{Q_REDIS}", wait_until="domcontentloaded")
    await page.wait_for_selector("#msy-ai-host", state="attached", timeout=15000)
    await page.wait_for_timeout(700)
    return page


INPUT_FILLED = """() => (document.getElementById('msy-ai-host').shadowRoot
                            .querySelector('.msy-input').value || '').length > 5"""

# 等「转写真的回来了」。不能只等输入框非空 —— 输入框里本来就有草稿时，
# 那个条件立刻就成立，测试会跑在识别结果到达之前。
TRANSCRIPT_ARRIVED = """() => (document.getElementById('msy-ai-host').shadowRoot
                                   .querySelector('.msy-input').value || '').includes('分布式锁')"""


async def read_error(page):
    if await page.locator("#msy-ai-host .msy-bubble.error").count():
        return (await page.locator("#msy-ai-host .msy-bubble.error").last.inner_text())[:200]
    return ""


async def diagnose(page, ctx):
    """失败时把现场捞出来，不然只能靠猜。"""
    try:
        st = await page.evaluate("""() => {
            const sr = document.getElementById('msy-ai-host').shadowRoot;
            const status = sr.querySelector('.msy-status');
            return {
                mic: sr.querySelector('.msy-mic').dataset.state || '-',
                status: status ? status.textContent.trim().slice(0, 60) : '',
                input: (sr.querySelector('.msy-input').value || '').slice(0, 40),
            };
        }""")
    except Exception as e:
        st = {"evalErr": str(e)[:80]}
    try:
        sw = ctx.service_workers[0]
        st["offscreen"] = await sw.evaluate("() => chrome.offscreen.hasDocument()")
    except Exception as e:
        st["offscreen"] = f"err {str(e)[:40]}"
    st["error"] = await read_error(page)
    return st


def make_wav(path, cycles=10):
    """
    造一段「说话 + 停顿」交替的音频当虚拟麦克风输入：2 秒 440Hz 正弦 + 3 秒静音，重复多轮。

    为什么不用单轮：虚拟音频文件只在设备被使用的时候播放，而等扩展和页面都准备好
    往往已经过去好几秒 —— 单轮的话文件早就放完了，剩下的全是静音，
    测试就变成了「碰运气看点击时文件播到哪儿」。多轮循环才能真正与启动时机无关。

    必须用真实波形（而不是默认的测试音），才能验证静音自动断句确实会触发。
    """
    sr = 48000
    tone = array.array("h")
    for i in range(int(sr * 2)):
        tone.append(int(12000 * math.sin(2 * math.pi * 440 * i / sr)))
    gap = array.array("h", [0] * int(sr * 3))

    frames = array.array("h")
    for _ in range(cycles):
        frames.extend(tone)
        frames.extend(gap)

    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(frames.tobytes())
    return path


# --------------------------------------------------------------------------- #
# F. 语音对话模式
# --------------------------------------------------------------------------- #

async def test_voice_mode(ctx, sw):
    """
    语音对话模式：一轮答完之后自动把麦克风接回来，形成循环。

    headless 里没有中文发音人，speak 不会真的出声，所以代码里有一条兜底：
    没有发音人就别等朗读结束，直接开始听 —— 否则循环会永远卡在「等朗读」。
    这条兜底也正是这里能自动测到循环的原因。
    """
    stage("F. 语音对话模式自动循环")
    await sw.evaluate(
        """async () => {
            const { msy_settings } = await chrome.storage.local.get('msy_settings');
            msy_settings.asr = Object.assign({}, msy_settings.asr, {
                engine: 'cloud', voiceMode: true, autoSend: false, bargeIn: true, silenceMs: 1000,
            });
            msy_settings.tts = Object.assign({}, msy_settings.tts, { autoSpeak: true });
            await chrome.storage.local.set({ msy_settings });
        }"""
    )
    await page_wait_sw(sw)

    page = await open_panel(ctx)
    check("面板上显示了语音对话中的标记",
          await page.locator("#msy-ai-host .msy-panel").get_attribute("data-voice") == "1",
          str(await page.locator("#msy-ai-host .msy-panel").get_attribute("data-voice")))

    # 先让 AI 答一轮，语音模式会在答完后自动开始听
    await kickoff(page)
    r = await wait_reply(page)
    check("面试模式能出结果", r == "done", r)

    try:
        await page.wait_for_function(
            """() => document.getElementById('msy-ai-host').shadowRoot
                     .querySelector('.msy-mic').dataset.state === 'recording'""",
            timeout=8000,
        )
        check("AI 答完后自动开始听下一句", True)
    except Exception:
        check("AI 答完后自动开始听下一句", False, "8 秒内没有自动开始录音")

    # 说完自动发送 → 又一轮 AI 回复 → 又自动回来听
    try:
        await page.wait_for_function(
            """() => document.getElementById('msy-ai-host').shadowRoot
                     .querySelectorAll('.msy-row.assistant').length >= 3""",
            timeout=70000,
        )
        check("循环转起来了（自动发送 + 新回复）", True)
    except Exception:
        check("循环转起来了（自动发送 + 新回复）", False,
              f"当前 AI 消息数 {await page.locator('#msy-ai-host .msy-row.assistant').count()}")

    # 关掉语音模式应该把麦克风也收掉
    await sw.evaluate(
        """async () => {
            const { msy_settings } = await chrome.storage.local.get('msy_settings');
            msy_settings.asr.voiceMode = false;
            await chrome.storage.local.set({ msy_settings });
        }"""
    )
    await page.wait_for_timeout(1500)
    check("关掉语音模式后按钮回到空闲态",
          await page.locator("#msy-ai-host .msy-mic").get_attribute("data-state") == "idle")
    check("面板上的语音标记也消失了",
          await page.locator("#msy-ai-host .msy-panel").get_attribute("data-voice") == "0")
    await page.close()


async def page_wait_sw(sw):
    """配置写完之后给它一点时间生效（storage.onChanged 是异步的）"""
    await asyncio.sleep(0.6)


# --------------------------------------------------------------------------- #
# A. 云端录音转写
# --------------------------------------------------------------------------- #

async def test_cloud_asr(ctx, sw):
    stage("A. 云端录音转写全链路（虚拟麦克风，手动停止）")
    page = await open_panel(ctx)
    mic = page.locator("#msy-ai-host .msy-mic")
    await mic.click()

    try:
        await page.wait_for_function(
            """() => document.getElementById('msy-ai-host').shadowRoot
                     .querySelector('.msy-mic').dataset.state === 'recording'""",
            timeout=8000,
        )
        check("进入录音状态", True)
    except Exception as e:
        check("进入录音状态", False, f"{str(e)[:80]} {await read_error(page)}")
        return

    levels = []
    for _ in range(10):
        levels.append(await page.evaluate(
            """() => {
                const ring = document.getElementById('msy-ai-host').shadowRoot.querySelector('.msy-level');
                const m = /scale\\(([\\d.]+)\\)/.exec(ring.style.transform || '');
                return m ? Number(m[1]) : 1;
            }"""
        ))
        await page.wait_for_timeout(110)
    check("音量电平有波动（说明 VAD 在跑）", max(levels) > 1.01, f"最大 {max(levels):.3f}")

    await page.wait_for_timeout(900)  # 录够时长，太短会被「录音太短」拦住
    await mic.click()

    try:
        await page.wait_for_function(INPUT_FILLED, timeout=20000)
    except Exception:
        check("转写结果回填到输入框", False, await read_error(page))
        return

    text = await page.locator("#msy-ai-host .msy-input").input_value()
    check("转写结果回填到输入框", len(text) > 5, text[:80])
    check("拿到的是 mock 返回的文本", "分布式锁" in text and "Lua" in text, text[:120])
    print(f"     转写结果：{text[:64]}")

    check("转写完成后回到空闲态",
          await page.locator("#msy-ai-host .msy-mic").get_attribute("data-state") == "idle")
    check("转写结束后 offscreen 已关闭",
          await sw.evaluate("() => chrome.offscreen.hasDocument()") is False)
    await page.close()


# --------------------------------------------------------------------------- #
# C. 静音自动断句
# --------------------------------------------------------------------------- #

LEVEL_OF = """() => {
    const ring = document.getElementById('msy-ai-host').shadowRoot.querySelector('.msy-level');
    const m = /scale\\(([\\d.]+)\\)/.exec(ring.style.transform || '');
    return m ? Number(m[1]) : 1;
}"""


async def test_auto_stop(ctx):
    stage("C. 静音自动断句（输入音频：2 秒说话 + 3 秒停顿，循环）")
    page = await open_panel(ctx)
    await page.locator("#msy-ai-host .msy-mic").click()

    # 虚拟音频文件是循环播放的，点击时可能正好落在静音段，
    # 所以不能按「从点击开始的绝对时间」断言，那样会随机失败。
    # 改成测「静音出现 → 自动收尾」的延迟，与相位无关。
    loop = asyncio.get_event_loop()

    async def wait_level(pred, timeout_s):
        end = loop.time() + timeout_s
        while loop.time() < end:
            if pred(await page.evaluate(LEVEL_OF)):
                return True
            await page.wait_for_timeout(80)
        return False

    if not await wait_level(lambda v: v > 1.01, 12):
        check("检测到了声音", False, f"12 秒内电平一直是 0｜现场：{await diagnose(page, ctx)}")
        return
    check("检测到了声音", True)

    if not await wait_level(lambda v: v <= 1.001, 12):
        check("检测到了停顿", False, f"电平一直没落回静音｜现场：{await diagnose(page, ctx)}")
        return
    check("检测到了停顿", True)
    t_silence = loop.time()

    try:
        await page.wait_for_function(INPUT_FILLED, timeout=9000)
    except Exception:
        detail = await read_error(page) or f"静音后 9 秒仍未自动结束｜现场：{await diagnose(page, ctx)}"
        check("停顿后自动结束录音", False, detail)
        return

    latency = loop.time() - t_silence
    check("停顿后自动结束录音（没点过停止）", True)
    # 配置的静音阈值是 1200ms，允许 ±700ms 的采样与轮询误差
    check("收尾延迟符合配置（0.5~2.5 秒）", 0.5 < latency < 2.5, f"实际 {latency:.2f} 秒")
    print(f"     静音后自动收尾延迟：{latency:.2f} 秒")

    text = await page.locator("#msy-ai-host .msy-input").input_value()
    check("自动结束后也拿到了转写", "分布式锁" in text, text[:80])
    await page.close()


# --------------------------------------------------------------------------- #
# D. 录音与输入框的相处方式
# --------------------------------------------------------------------------- #

async def test_draft_not_clobbered(ctx):
    """
    录音期间用户自己动过输入框，识别结果就不能再覆盖它。

    这条是用户报的 bug：「删掉了又会自动出现」。根因是识别结果每个字都在
    重写整个输入框，用户删掉的内容下一次事件又原样填回来。
    """
    stage("D. 录音时自己编辑输入框，草稿不会被覆盖")
    page = await open_panel(ctx)
    mic = page.locator("#msy-ai-host .msy-mic")

    await mic.click()
    await page.wait_for_function(
        """() => document.getElementById('msy-ai-host').shadowRoot
                 .querySelector('.msy-mic').dataset.state === 'recording'""",
        timeout=8000,
    )
    # 录音进行中，用户自己敲了东西
    await page.locator("#msy-ai-host .msy-input").fill("我的草稿：先别覆盖我")
    # 录够时长再停，否则会被录音模块的「录音太短」挡住
    await page.wait_for_timeout(2400)
    await mic.click()

    try:
        await page.wait_for_function(TRANSCRIPT_ARRIVED, timeout=20000)
    except Exception:
        check("识别结果插进来了", False, await read_error(page) or "20 秒内没等到转写")
        return
    text = await page.locator("#msy-ai-host .msy-input").input_value()
    check("识别结果插进来了", True)
    check("用户自己的草稿也还在", "我的草稿：先别覆盖我" in text, text[:100])
    print(f"     最终输入框内容：{text[:70]}")

    # 录完再删掉，不应该又冒出来
    await page.locator("#msy-ai-host .msy-input").fill("")
    await page.wait_for_timeout(1500)
    after = await page.locator("#msy-ai-host .msy-input").input_value()
    check("删掉之后不会被重新填回来", after == "", repr(after))

    await page.close()


async def test_draft_prefix_kept(ctx):
    """没动过输入框时：录音前已有的内容当前缀保留，识别结果接在后面。"""
    stage("E. 录音前已输入的内容会作为前缀保留")
    page = await open_panel(ctx)
    await page.locator("#msy-ai-host .msy-input").fill("我觉得答案是：")
    await page.wait_for_timeout(150)

    await page.locator("#msy-ai-host .msy-mic").click()
    await page.wait_for_timeout(2600)
    await page.locator("#msy-ai-host .msy-mic").click()

    try:
        await page.wait_for_function(TRANSCRIPT_ARRIVED, timeout=20000)
    except Exception:
        check("识别结果接在后面", False, await read_error(page) or "20 秒内没等到转写")
        return
    text = await page.locator("#msy-ai-host .msy-input").input_value()
    check("前缀还在", text.startswith("我觉得答案是："), text[:60])
    check("识别结果接在后面", True)
    await page.close()


# --------------------------------------------------------------------------- #
# B. 流式朗读断句
# --------------------------------------------------------------------------- #

TTS_STUB = """
() => {
    window.__spoken = [];
    window.__last = null;
    const voices = [{ name: 'Tingting', lang: 'zh-CN', voiceURI: 'zh-tt', localService: true }];
    const stub = {
        getVoices: () => voices,
        speak: (u) => { window.__spoken.push(u.text); window.__last = u; },
        cancel: () => { window.__spoken.push('<<取消>>'); window.__last = null; },
        pause: () => {}, resume: () => {},
        addEventListener: () => {}, removeEventListener: () => {},
    };
    Object.defineProperty(window, 'speechSynthesis', { value: stub, configurable: true });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', {
        value: function (t) { this.text = t; }, configurable: true,
    });
}
"""


async def drain(page, times=10):
    """桩里的 speak 不会自己结束，得手动把队列推完。"""
    for _ in range(times):
        await page.evaluate("() => window.__last && window.__last.onend && window.__last.onend()")
        await page.wait_for_timeout(35)


async def spoken(page):
    return await page.evaluate("() => window.__spoken")


async def test_tts(page):
    stage("B. 流式朗读的断句逻辑（speechSynthesis 打桩）")
    await page.goto(f"{ORIGIN}{Q_REDIS}", wait_until="domcontentloaded")
    await page.evaluate(TTS_STUB)
    for f in ("content/util.js", "content/tts.js"):
        await page.add_script_tag(path=os.path.join(ROOT, f))
    await page.wait_for_timeout(200)

    check("TTS 识别到可用语音", await page.evaluate("() => MSY.tts.supported"))
    check("能挑出中文发音人", len(await page.evaluate("() => MSY.tts.voices()")) >= 1)

    await page.evaluate("() => MSY.tts.push('Redis 分布式锁的核心是')")
    check("没有句末标点时先不念", await spoken(page) == [])

    await page.evaluate("() => MSY.tts.push('原子操作。接着是第二句')")
    check("凑够一句就立刻念",
          await spoken(page) == ["Redis 分布式锁的核心是原子操作。"], str(await spoken(page)))

    await page.evaluate("() => MSY.tts.push('，还没结束。')")
    check("上一句没念完时排队等待", len(await spoken(page)) == 1)

    await drain(page, 2)
    check("上一句结束后自动念下一句", len(await spoken(page)) == 2, str(await spoken(page)))

    async def reset():
        await page.evaluate("() => { window.__spoken.length = 0; MSY.tts.stop(); }")

    # 代码块不念
    await reset()
    await page.evaluate(
        """() => MSY.tts.push('看这段代码：\\n```java\\nSystem.out.println(1);\\n```\\n明白了吗？')"""
    )
    await page.evaluate("() => MSY.tts.flushStream()")
    await drain(page)
    joined = " ".join(await spoken(page))
    check("代码块被替换成提示语", "（代码块）" in joined, joined)
    check("代码内容没有被念出来", "System.out.println" not in joined, joined)
    check("短句也能念出来", "明白了吗" in joined, joined)

    # Markdown 标记不念
    await reset()
    await page.evaluate(
        """() => MSY.tts.push('**重点**：这是 `inline code`，还有 [链接](https://x.com)。')"""
    )
    await drain(page)
    joined = " ".join(await spoken(page))
    check("去掉加粗星号", "**" not in joined, joined)
    check("去掉反引号", "`" not in joined, joined)
    check("链接只留文字", "https://" not in joined and "链接" in joined, joined)

    # stop 清空队列
    await page.evaluate("() => { window.__spoken.length = 0; }")
    await page.evaluate("() => MSY.tts.push('第一句。第二句。第三句。')")
    await drain(page, 1)
    await page.evaluate("() => MSY.tts.stop()")
    await page.wait_for_timeout(100)
    words = await spoken(page)
    check("stop 会取消朗读", "<<取消>>" in words, str(words))
    check("stop 后不再有新的朗读", words[-1] == "<<取消>>", str(words))


# --------------------------------------------------------------------------- #

async def main():
    try:
        with urllib.request.urlopen(f"{MOCK}/v1/models", timeout=3):
            pass
    except Exception:
        print("mock AI 服务没起来，请先运行：node dev/mock-openai-server.js")
        return 1

    wd = tempfile.mkdtemp(prefix="msy-voice-")
    ext = os.path.join(wd, "ext")
    shutil.copytree(ROOT, ext, ignore=shutil.ignore_patterns("node_modules", ".git", "*.zip", "fixtures"))

    with open(os.path.join(ext, "manifest.json"), encoding="utf-8") as f:
        mf = json.load(f)
    mf["host_permissions"] = ["http://localhost/*", "http://127.0.0.1/*"]
    mf["content_scripts"][0]["matches"] += ["http://localhost/*", "http://127.0.0.1/*"]
    with open(os.path.join(ext, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(mf, f, ensure_ascii=False, indent=2)

    wav = make_wav(os.path.join(wd, "speech-then-silence.wav"))
    print(f"夹具音频：{wav}（{os.path.getsize(wav) // 1024} KB）")

    async with async_playwright() as p:
        # 第一轮：虚拟设备输出连续音，用来测手动停止的路径
        ctx1, sw1 = await prepare_context(p, ext, "manual")
        await test_cloud_asr(ctx1, sw1)
        await ctx1.close()

        # 第二轮：虚拟设备播放「说话+停顿」的音频，用来测静音自动断句
        ctx2, _sw2 = await prepare_context(
            p, ext, "autostop", [f"--use-file-for-fake-audio-capture={wav}"]
        )
        await test_auto_stop(ctx2)
        await ctx2.close()

        # 第四轮：录音与输入框的相处方式（不需要音频文件，用默认虚拟设备即可）
        ctx4, _sw4 = await prepare_context(p, ext, "draft")
        await test_draft_not_clobbered(ctx4)
        await test_draft_prefix_kept(ctx4)
        await ctx4.close()

        # 第五轮：语音对话模式。
        # 必须用带停顿的音频 —— 默认虚拟设备是连续音，VAD 永远等不到静音，
        # 也就永远不会自动结束（那反倒说明「你一直没说完」这个判断是对的）。
        ctx5, sw5 = await prepare_context(
            p, ext, "voicemode", [f"--use-file-for-fake-audio-capture={wav}"]
        )
        await test_voice_mode(ctx5, sw5)
        await ctx5.close()

        # 第三轮：不需要扩展，单纯测 TTS 断句
        ctx3 = await p.chromium.launch_persistent_context(
            user_data_dir=os.path.join(wd, "profile-tts"), channel="chromium", headless=True
        )
        page = await ctx3.new_page()
        await install_router(ctx3)
        await test_tts(page)
        await page.close()
        await ctx3.close()

    print("\n" + "=" * 60)
    print(f"\033[1m结果：{len(PASS)} 通过 / {len(FAIL)} 失败\033[0m")
    if FAIL:
        for f in FAIL:
            print(f"  ✗ {f}")
    shutil.rmtree(wd, ignore_errors=True)
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
