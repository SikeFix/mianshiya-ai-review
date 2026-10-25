#!/usr/bin/env python3
"""
纯逻辑单元测试：间隔重复调度、文件名消毒、选择题解析、Markdown 生成。

这些函数不依赖页面、不依赖网络，是最容易写错也最值得精确验证的部分 ——
比如「评为完全不会之后间隔必须清零」「文件名不能被杀出目录」，
靠端到端测试很难覆盖到所有边界。

    python3 dev/test_srs.py
"""
import asyncio
import os
import sys

from playwright.async_api import async_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SCRIPTS = [
    "shared/config.js",
    "shared/srs.js",
    "shared/notes.js",
    "content/util.js",
    "content/md.js",
    "shared/report.js",
]

PASS, FAIL = [], []


def check(name, ok, detail=""):
    (PASS if ok else FAIL).append(name)
    mark = "\033[32m✓\033[0m" if ok else "\033[31m✗\033[0m"
    print(f"  {mark} {name}" + (f"\n      → {detail}" if detail and not ok else ""))


def stage(t):
    print(f"\n\033[1m{t}\033[0m")


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        page = await b.new_page()
        for f in SCRIPTS:
            await page.add_script_tag(path=os.path.join(ROOT, f))

        ok = await page.evaluate("() => !!(MSY.srs && MSY.notes && MSY.md && MSY.report)")
        check("脚本加载完成（含报告模块）", ok)
        if not ok:
            return 1

        # ===================== 间隔重复 =====================
        stage("间隔重复调度")
        r = await page.evaluate("""() => {
            const DAY = 86400000;
            const now = 1700000000000;
            const out = {};

            // 新题：明天到期
            const init = MSY.srs.initial(now);
            out.initInterval = init.interval;
            out.initDueDays = Math.round((init.due - now) / DAY);

            // 连续评「记住了」，间隔应该越拉越长
            let s = init;
            const goods = [];
            for (let i = 0; i < 5; i++) { s = MSY.srs.apply(s, 'good', now); goods.push(s.interval); }
            out.goods = goods;

            // 「完全不会」：间隔清零、10 分钟后再来、难度因子下降、记一次遗忘
            const before = MSY.srs.apply(init, 'good', now);
            const again = MSY.srs.apply(before, 'again', now);
            out.againInterval = again.interval;
            out.againDueMin = Math.round((again.due - now) / 60000);
            out.againEaseDown = again.ease < before.ease;
            out.againLapses = again.lapses;

            // 四种评分的间隔排序：again < hard < good < easy
            let base = MSY.srs.apply(MSY.srs.apply(init, 'good', now), 'good', now);
            out.order = ['again','hard','good','easy'].map(k => MSY.srs.apply(base, k, now).interval);

            // 难度因子有上下界
            let e = init;
            for (let i = 0; i < 20; i++) e = MSY.srs.apply(e, 'again', now);
            out.easeMin = e.ease;
            let e2 = init;
            for (let i = 0; i < 20; i++) e2 = MSY.srs.apply(e2, 'easy', now);
            out.easeMax = e2.ease;

            // 最长间隔封顶
            let big = { ease: 2.5, interval: 170, reps: 9, lapses: 0, history: [] };
            out.capped = MSY.srs.apply(big, 'good', now).interval;

            // 历史不会无限增长
            let h = init;
            for (let i = 0; i < 60; i++) h = MSY.srs.apply(h, 'good', now);
            out.historyLen = h.history.length;

            // 不改原对象
            const orig = { ease: 2.5, interval: 3, reps: 2, lapses: 0, history: [] };
            const snapshot = JSON.stringify(orig);
            MSY.srs.apply(orig, 'good', now);
            out.immutable = JSON.stringify(orig) === snapshot;

            return out;
        }""")

        check("新题默认明天到期", r["initInterval"] == 1 and r["initDueDays"] == 1,
              f"interval={r['initInterval']} dueDays={r['initDueDays']}")
        g = r["goods"]
        check("连续评「记住了」间隔递增", all(g[i] < g[i + 1] for i in range(len(g) - 1)), str(g))
        # initial() 已经代表「刚学完、明天复习」，所以第一次评「记住了」应该跳到 2.5 天
        check("第一次复习后间隔从 1 天涨到 2.5 天", g[0] == 2.5, str(g))
        check("「完全不会」把间隔清零", r["againInterval"] == 0, str(r["againInterval"]))
        check("「完全不会」10 分钟后再来", r["againDueMin"] == 10, str(r["againDueMin"]))
        check("「完全不会」会降低难度因子", r["againEaseDown"])
        check("「完全不会」记一次遗忘", r["againLapses"] == 1)
        o = r["order"]
        check("四种评分的间隔排序正确", o[0] < o[1] < o[2] < o[3], f"again/hard/good/easy = {o}")
        check("难度因子有下界 1.3", abs(r["easeMin"] - 1.3) < 1e-9, str(r["easeMin"]))
        check("难度因子有上界 2.8", abs(r["easeMax"] - 2.8) < 1e-9, str(r["easeMax"]))
        check("单题最长间隔封顶 180 天", r["capped"] == 180, str(r["capped"]))
        check("复习历史不会无限增长", r["historyLen"] == 30, str(r["historyLen"]))
        check("apply 不修改传入的对象", r["immutable"])

        # ===================== 到期与统计 =====================
        stage("到期筛选与统计")
        r2 = await page.evaluate("""() => {
            const NOW = 1700000000000;
            const rec = (over) => ({ updatedAt: NOW, srs: over });
            const list = [
                { ...rec({ due: NOW - 1000, lastRating: 'again' }) },              // 已到期
                { ...rec({ due: NOW + 86400000, lastRating: 'good' }) },          // 明天
                { ...rec({ due: NOW + 5 * 86400000, lastRating: 'easy' }) },      // 5 天后
                { updatedAt: NOW, srs: null },                                    // 没复习状态
                { ...rec({ due: NOW - 500, lastRating: 'hard' }) },               // 已到期
            ];
            const st = MSY.srs.stats(list, NOW);
            return {
                due: MSY.srs.due(list, NOW).length,
                total: st.total,
                dueCount: st.due,
                buckets: st.buckets,
            };
        }""")
        check("到期筛选正确（含没有复习状态的）", r2["due"] == 3, f"{r2['due']} 个")
        check("统计里的总数正确", r2["total"] == 5)
        check("统计里的到期数正确", r2["dueCount"] == 3)
        check("掌握程度分布正确",
              r2["buckets"] == {"again": 1, "hard": 1, "good": 1, "easy": 1, "new": 1},
              str(r2["buckets"]))

        labels = await page.evaluate("""() => {
            const NOW = 1700000000000;
            return [
                MSY.srs.dueLabel({ due: NOW - 1000 }, NOW),
                MSY.srs.dueLabel({ due: NOW + 30 * 60000 }, NOW),
                MSY.srs.dueLabel({ due: NOW + 5 * 3600000 }, NOW),
                MSY.srs.dueLabel({ due: NOW + 3 * 86400000 }, NOW),
                MSY.srs.dueLabel(null, NOW),
            ];
        }""")
        check("到期文案：现在就该复习", "现在" in labels[0], labels[0])
        check("到期文案：分钟", "分钟" in labels[1], labels[1])
        check("到期文案：小时", "小时" in labels[2], labels[2])
        check("到期文案：天", "天" in labels[3], labels[3])
        check("没复习过的文案", "没" in labels[4], labels[4])

        # ===================== 文件名消毒 =====================
        stage("文件名与文件夹名消毒")
        r3 = await page.evaluate("""() => ({
            // 路径穿越必须被干掉
            traversal: MSY.notes.safeName('../../etc/passwd'),
            traversal2: MSY.notes.safeName('..\\\\..\\\\windows\\\\system32'),
            slash: MSY.notes.safeName('a/b/c'),
            illegal: MSY.notes.safeName('题目：如何实现<锁>？"引号"|管道*星号'),
            empty: MSY.notes.safeName('   '),
            dots: MSY.notes.safeName('...题目...'),
            reserved: MSY.notes.safeName('CON'),
            reserved2: MSY.notes.safeName('nul'),
            long: MSY.notes.safeName('题'.repeat(200)).length,
            normal: MSY.notes.safeName('Redis 中如何实现分布式锁？'),
            folder: MSY.notes.safeFolder('面试鸭笔记'),
            folderEmpty: MSY.notes.safeFolder('   '),
            folderSlash: MSY.notes.safeFolder('a/b'),
        })""")
        check("路径穿越被清除", ".." not in r3["traversal"] and "/" not in r3["traversal"], r3["traversal"])
        check("反斜杠路径穿越被清除",
              "\\" not in r3["traversal2"] and ".." not in r3["traversal2"], r3["traversal2"])
        check("斜杠不会留在文件名里", "/" not in r3["slash"], r3["slash"])
        check("Windows 非法字符被清掉",
              not any(c in r3["illegal"] for c in ':*?"<>|'), r3["illegal"])
        check("空标题有兜底名", bool(r3["empty"]) and r3["empty"] != "", r3["empty"])
        check("首尾的点被去掉", not r3["dots"].startswith(".") and not r3["dots"].endswith("."), r3["dots"])
        check("Windows 保留名被处理", r3["reserved"].lower() != "con", r3["reserved"])
        check("Windows 保留名（小写）被处理", r3["reserved2"].lower() != "nul", r3["reserved2"])
        check("超长标题被截断到 60 字以内", r3["long"] <= 60, str(r3["long"]))
        check("正常中文标题原样保留", r3["normal"] == "Redis 中如何实现分布式锁？", r3["normal"])
        check("文件夹名正常", r3["folder"] == "面试鸭笔记", r3["folder"])
        check("空文件夹名有兜底", r3["folderEmpty"] == "面试鸭笔记", r3["folderEmpty"])
        check("文件夹名不含斜杠", "/" not in r3["folderSlash"], r3["folderSlash"])

        # ===================== 选择题解析 =====================
        stage("选择题与判断题解析")
        r4 = await page.evaluate("""() => ({
            plain: MSY.md.extractOptions('选哪个？\\nA. 第一个\\nB. 第二个\\nC. 第三个\\nD. 第四个'),
            chinese: MSY.md.extractOptions('A、甲\\nB、乙\\nC、丙'),
            broken: MSY.md.extractOptions('A. 只有一个'),
            gap: MSY.md.extractOptions('A. 甲\\nC. 丙'),
            inline: MSY.md.extractOptions('这段话里提到 A. 某种东西，但没有真的在出选择题。还有 B. 另一个。'),
            tf: MSY.md.looksLikeTrueFalse('这题的说法对吗？'),
            tf2: MSY.md.looksLikeTrueFalse('判断：Redis 的 SET NX 是原子操作。对吗？'),
            tfWithOptions: MSY.md.looksLikeTrueFalse('下列说法正确的是？\\nA. 甲\\nB. 乙'),
            tfNoQuestion: MSY.md.looksLikeTrueFalse('这个说法是对的。'),
            numbered: MSY.md.extractOptions('1. 甲\\n2. 乙'),
        })""")
        check("标准 A/B/C/D 能解析", len(r4["plain"]) == 4 and r4["plain"][0]["letter"] == "A",
              str(r4["plain"]))
        check("顿号分隔的选项能解析", len(r4["chinese"]) == 3, str(r4["chinese"]))
        check("选项文字被正确取出", r4["plain"][0]["text"] == "第一个", str(r4["plain"][0]))
        check("只有一个选项不算", r4["broken"] == [], str(r4["broken"]))
        check("字母不连续不算", r4["gap"] == [], str(r4["gap"]))
        check("行内的 A. 不算选项", r4["inline"] == [], str(r4["inline"]))
        check("数字编号不算选项", r4["numbered"] == [], str(r4["numbered"]))
        check("判断题能被识别", r4["tf"] is True)
        check("「判断：…对吗？」能被识别", r4["tf2"] is True)
        check("有选项时不当判断题", r4["tfWithOptions"] is False)
        check("没有问号的陈述不当判断题", r4["tfNoQuestion"] is False)

        # ===================== Markdown 生成 =====================
        stage("笔记 Markdown 生成")
        md = await page.evaluate("""() => MSY.notes.toMarkdown({
            title: 'Redis 中如何实现分布式锁？',
            url: 'https://www.mianshiya.com/question/123',
            tags: ['Redis', '后端'],
            answer: ' 用 SET NX PX。',
            answerSource: 'dom',
            paywalled: false,
            lastScore: 7,
            srs: { ease: 2.5, interval: 3, reps: 4, lapses: 1, lastRating: 'good', due: Date.now() + 3*86400000, history: [] },
            threads: {
                interview: [{ role: 'user', content: '我的回答' }, { role: 'assistant', content: '### 点评' }],
                quiz: [{ role: 'user', content: '我选 A' }],
            },
            updatedAt: Date.now(),
        }, { includeChat: true })""")
        for label, needle in [
            ("含标题", "# Redis 中如何实现分布式锁？"),
            ("含来源", "**来源**"),
            ("含标签", "Redis、后端"),
            ("含参考答案段落", "## 本站参考答案"),
            ("含答案正文", "SET NX PX"),
            ("含 AI 评分", "7/10"),
            ("含掌握情况", "**掌握情况**"),
            ("含下次复习时间", "**下次复习**"),
            ("按模式分段", "AI 复习记录（模拟面试）"),
            ("第二个模式也在", "AI 复习记录（自测）"),
            ("用户发言标成「我」", "### 我"),
            ("AI 发言标成「AI」", "### AI"),
            ("含导出标记", "由「面试鸭 AI 复习助手」导出"),
        ]:
            check(label, needle in md, md[:200] if needle not in md else "")

        md2 = await page.evaluate("""() => MSY.notes.toMarkdown({
            title: '会员题', url: 'u', answer: '', paywalled: true, answerSource: 'none',
            srs: null, threads: { chat: [{ role: 'user', content: 'hi' }] }, updatedAt: Date.now(),
        }, { includeChat: false })""")
        check("会员墙时说明没有答案", "需要会员" in md2, md2[:200])
        check("关掉对话后不写对话段", "AI 复习记录" not in md2, md2[:200])

        # 汇总文件
        allmd = await page.evaluate("""() => MSY.notes.allToMarkdown([
            { title: '题一', srs: { lastRating: 'good' }, updatedAt: Date.now(), threads: {} },
            { title: '题二', srs: null, updatedAt: Date.now() - 1000, threads: {} },
        ], {})""")
        check("汇总带目录", "## 目录" in allmd)
        check("目录里标了掌握情况", "记住了" in allmd and "未自评" in allmd, allmd[:400])
        check("汇总含全部题目", "题一" in allmd and "题二" in allmd)

        # ===================== 代码高亮 =====================
        stage("代码语法高亮")
        # 代码样本从 Python 侧传进去，避免在 JS 字面量里堆转义
        samples = {
            "go": "package main\n\n// 注释\nfunc main() {\n\ts := Secret{data: \"x\"}\n\tfmt.Println(1.5)\n}",
            "py": "def f(x):\n    # 注释\n    return x + 1",
            "sql": "SELECT id FROM t WHERE a = 1 -- 注释",
            "sh": "if [ -f x ]; then\n  echo \"hi\"\nfi",
            "unknown": 'some code with "a string"',
            "plain": "just text 123",
            "evil": "<script>alert(1)</script>",
        }
        r7 = await page.evaluate(
            """(samples) => {
                const out = {};
                for (const [k, v] of Object.entries(samples)) out[k] = MSY.md.highlight(v, k);
                out.inRender = MSY.md.render('```go' + String.fromCharCode(10) + 'func main() {}' + String.fromCharCode(10) + '```');
                return out;
            }""",
            samples,
        )
        check("关键字着色", "msy-tok-k" in r7["go"] and ">package<" in r7["go"], r7["go"][:80])
        check("字符串着色", "msy-tok-s" in r7["go"])
        check("注释着色", "msy-tok-c" in r7["go"])
        check("数字着色", "msy-tok-n" in r7["go"])
        check("函数名着色", "msy-tok-f" in r7["go"])
        check("类型名着色", "msy-tok-t" in r7["go"])
        check("Python 走 # 注释", "msy-tok-c" in r7["py"] and ">def<" in r7["py"], r7["py"][:90])
        check("SQL 走 -- 注释", "msy-tok-c" in r7["sql"], r7["sql"][:90])
        check("Shell 能识别", "msy-tok-k" in r7["sh"], r7["sh"][:90])
        check("认不出的语言也不崩", "msy-tok-s" in r7["unknown"], r7["unknown"][:80])
        check("纯文本不做高亮", "msy-tok-k" not in r7["plain"], r7["plain"])
        check("高亮里的 HTML 被转义",
              "&lt;script&gt;" in r7["evil"] and "<script>" not in r7["evil"], r7["evil"][:80])
        check("渲染代码块时自动套用高亮", "msy-tok-k" in r7["inRender"], r7["inRender"][:90])

        # ===================== 数学公式渲染 =====================
        stage("数学公式渲染")
        r6 = await page.evaluate(r"""() => {
            const R = (t) => MSY.md.render(t);
            return {
                sub: R('$y = W_0 x$'),
                set: R('$W_0 \\in \\mathbb{R}^{d \\times k}$'),
                frac: R('$\\frac{a+b}{c}$'),
                sqrt: R('$\\sqrt{x^2+y^2}$'),
                display: R('$$\\Delta W = B A$$'),
                ll: R('$r \\ll \\min(d, k)$'),
                // 公式里的星号不能被当成斜体
                star: R('$a_i * b_j$'),
                // 公式里的下划线不能被当成强调
                under: R('$W_0 x$'),
                // 货币符号不能误判成公式
                money: R('价格是 100$ 到 200$ 之间'),
            };
        }""")
        check("下标正确渲染", "<sub>0</sub>" in r6["sub"], r6["sub"])
        check("集合符号与上标正确渲染",
              "ℝ" in r6["set"] and "<sup>" in r6["set"] and "×" in r6["set"], r6["set"])
        check("分数渲染成分式结构", "msy-frac" in r6["frac"] and "a+b" in r6["frac"], r6["frac"])
        check("根号渲染为带顶线的结构", "msy-rad" in r6["sqrt"], r6["sqrt"])
        check("块级公式渲染",
              "msy-math-block" in r6["display"] or "msy-math-display" in r6["display"],
              r6["display"])
        check("块级公式不残留 $$", "$$" not in r6["display"], r6["display"])
        check("≪ 这类符号有映射", "≪" in r6["ll"], r6["ll"])
        check("公式里的星号不会被当成斜体", "<em>" not in r6["star"], r6["star"])
        check("公式里不残留反斜杠命令", "\\" not in r6["sub"] + r6["set"] + r6["ll"],
              r6["sub"] + r6["set"] + r6["ll"])

        # ===================== 自定义分类 / 简报 / 导图 / 范围 =====================
        stage("自定义分类、AI 简报、思维导图、面试范围")
        r8 = await page.evaluate("""() => {
            const NOW = Date.now();
            const mk = (title, bank, tags, custom, rating, lapses) => ({
                key: title, title, url: 'https://x/' + encodeURIComponent(title),
                bank: bank ? { id: '1', name: bank } : null,
                tags: tags || [], custom: custom || [], difficulty: '中等', num: '1',
                updatedAt: NOW, lastScore: 6,
                srs: rating ? { ease: 2.5, interval: 2, due: NOW - 1000, reps: 3,
                                lapses: lapses || 0, lastRating: rating, history: [] } : null,
                threads: {},
            });
            const list = [
                mk('锁', 'Redis 面试题', ['Redis', '后端'], ['突击', '重点'], 'again', 3),
                mk('持久化', 'Redis 面试题', ['Redis'], ['重点'], 'good', 0),
                mk('线程池', 'Java 面试题', ['Java'], [], 'hard', 1),
                mk('索引', null, [], [], null, 0),
            ];
            const agg = MSY.report.aggregate(list);
            return {
                customGroup: MSY.notes.groupBy(list, 'custom').map(g => [g.name, g.items.length]),
                kindCustom: agg.points.filter(p => p.kind === 'custom').map(p => p.name),
                brief: MSY.report.briefForAI(agg),
                map: MSY.report.mindMapHtml(agg),
                scope: MSY.report.scopeBrief(['Redis', '突击'], list),
                scopeEmpty: MSY.report.scopeBrief([], list),
                scopeStats: MSY.report.scopeStats('Redis', list),
            };
        }""")
        cg = dict(r8["customGroup"])
        check("按自定义分类分组", cg.get("重点") == 2 and cg.get("突击") == 1, str(cg))
        check("没打分类的进「未分类」", cg.get("未分类") == 2, str(cg))
        check("自定义分类也算知识点维度",
              "突击" in r8["kindCustom"] and "重点" in r8["kindCustom"], str(r8["kindCustom"]))

        check("AI 简报含总量与掌握率", "4 道" in r8["brief"] and "掌握率" in r8["brief"], r8["brief"][:120])
        check("AI 简报列出薄弱知识点", "Redis 面试题" in r8["brief"], r8["brief"][:300])
        check("AI 简报带上没掌握的题目标题", "锁" in r8["brief"], r8["brief"][:400])

        check("思维导图用可折叠的 details", "<details" in r8["map"] and "<summary>" in r8["map"])
        check("导图含按题库分组", "按题库" in r8["map"] and "Redis 面试题" in r8["map"], r8["map"][:200])
        check("导图含题目链接", 'href="https://x/' in r8["map"])
        check("导图标注掌握状态", 'data-state="again"' in r8["map"])

        check("面试范围带上方向", "只考这些方向：Redis、突击" in r8["scope"], r8["scope"][:120])
        check("面试范围优先列没掌握的题", "锁" in r8["scope"] and "完全不会" in r8["scope"], r8["scope"][:300])
        check("范围里的题数被统计", "学过 2 道题" in r8["scope"], r8["scope"][-60:])
        check("没设范围时不产生任何限制", r8["scopeEmpty"] == "", repr(r8["scopeEmpty"][:40]))
        check("范围统计给出题数与薄弱数",
              r8["scopeStats"]["total"] == 2 and r8["scopeStats"]["weak"] == 1, str(r8["scopeStats"]))

        # ===================== 学习报告聚合 =====================
        stage("学习报告：知识点聚合与薄弱分")
        r5 = await page.evaluate("""() => {
            const DAY = 86400000, NOW = Date.now();
            const mk = (title, tags, rating, lapses, memorize) => ({
                title, tags: tags || [], url: 'https://x/' + encodeURIComponent(title),
                // 全部落在今天，才能断言「今日刷题量」
                updatedAt: NOW - Math.random() * 1000,
                srs: rating ? { ease: 2.5, interval: 2, due: NOW + DAY, reps: 3, lapses: lapses || 0,
                                lastRating: rating, history: [] } : null,
                threads: memorize ? { memorize: [{ role: 'assistant', content: memorize }] } : {},
            });
            const list = [
                mk('R1', ['Redis', '后端'], 'again', 3),
                mk('R2', ['Redis', '后端'], 'again', 2),
                mk('R3', ['Redis'], 'good', 0),
                mk('J1', ['Java'], 'good', 0),
                mk('J2', ['Java'], 'easy', 0),
                mk('M1', ['大模型'], null, 0,
                   ['**关键词**', '锁、过期时间、Lua 脚本', '', '**最容易错**', '忘了校验 value']
                       .join(String.fromCharCode(10))),
            ];
            const agg = MSY.report.aggregate(list);
            const by = (n) => agg.points.find(p => p.name === n);
            return {
                total: agg.total,
                pointCount: agg.points.length,
                redis: by('Redis'),
                java: by('Java'),
                first: agg.points[0] && agg.points[0].name,
                weakNames: agg.weak.map(w => w.name),
                unrated: agg.unrated,
                weakness: agg.points.map(p => p.weakness),
                strongNames: agg.strong.map(w => w.name),
                masteryRate: agg.masteryRate,
                todayCount: agg.todayCount,
                dailyLen: agg.daily.length,
                dailyLast: agg.daily[agg.daily.length - 1],
                states: agg.questions.map(q => q.label),
                keywords: MSY.report.keywordsOf(list[5]),
                qCount: agg.questions.length,
            };
        }""")
        check("统计了题目总数", r5["total"] == 6, str(r5["total"]))
        check("按标签聚合成知识点", r5["pointCount"] >= 3, str(r5["pointCount"]))
        # 关键词里的空白会被去掉（Lua 脚本 → Lua脚本），便于按词归并
        check("从速记回复里抽出了关键词",
              r5["keywords"] == ["锁", "过期时间", "Lua脚本"], str(r5["keywords"]))
        check("关键词也算作知识点", r5["pointCount"] >= 6, str(r5["pointCount"]))
        check("薄弱分：两块「不会」比一块「掌握」高",
              r5["redis"]["weakness"] > r5["java"]["weakness"],
              f"Redis={r5['redis']['weakness']} Java={r5['java']['weakness']}")
        check("薄弱清单按薄弱分从高到低排",
              all(r5["weakness"][i] >= r5["weakness"][i + 1] for i in range(len(r5["weakness"]) - 1)),
              str(r5["weakness"]))
        # 「后端」两道题都没掌握（3.0），Redis 里有一道记住了（2.17），所以后端更弱
        check("两条全军覆没的标签比一条掌握了的更弱", r5["first"] == "后端", str(r5["first"]))
        check("薄弱清单里有 Redis", "Redis" in r5["weakNames"], str(r5["weakNames"]))
        # 只有「没自评」的题不该被算成薄弱 —— 没学过和学不会是两回事
        check("没自评的题不算薄弱", "大模型" not in r5["weakNames"], str(r5["weakNames"]))
        check("单独统计了未自评的题数", r5["unrated"] == 1, str(r5["unrated"]))
        check("已掌握的不算薄弱", "Java" not in r5["weakNames"], str(r5["weakNames"]))
        check("统计了每块的题数", r5["redis"]["count"] == 3, str(r5["redis"]["count"]))
        check("统计了每块的遗忘次数", r5["redis"]["lapses"] == 5, str(r5["redis"]["lapses"]))
        # 6 道里 R3/J1/J2 三道已掌握（记住了×2 + 太简单×1）→ 50%
        check("掌握率算对了（6 道里 3 道已掌握）",
              r5["masteryRate"] == 50, f"{r5['masteryRate']}% 分布={r5['states']}")
        check("逐题明细齐全", r5["qCount"] == 6, str(r5["qCount"]))
        check("统计了今日刷题量", r5["todayCount"] == 6, str(r5["todayCount"]))
        check("生成了 14 天趋势数据", r5["dailyLen"] == 14, str(r5["dailyLen"]))
        check("趋势的最后一天就是今天", r5["dailyLast"]["count"] == 6, str(r5["dailyLast"]))

        # ===================== HTML 报告 =====================
        stage("知识反馈网页")
        html = await page.evaluate("""() => {
            const agg = MSY.report.aggregate([
                { title: 'Redis 分布式锁', tags: ['Redis'], url: 'https://www.mianshiya.com/question/1',
                  updatedAt: Date.now(), lastScore: 6,
                  srs: { ease: 2.5, interval: 1, due: Date.now() - 1000, reps: 3, lapses: 2, lastRating: 'again', history: [] },
                  threads: { interview: [{ role: 'user', content: '我的回答' }] } },
            ]);
            return MSY.report.toHtml(agg);
        }""")
        check("是完整的 HTML 文档", html.startswith("<!DOCTYPE html>") and html.rstrip().endswith("</html>"))
        check("有页面标题", "<title>" in html and "学习报告" in html)
        check("样式内联，不依赖外部资源",
              "<style>" in html and "http://" not in html.split("</style>")[0])
        check("没有外部脚本（离线也能看）", "<script" not in html)
        check("包含总览", "总览" in html and "掌握率" in html)
        check("包含今日刷题", "今日刷题" in html and "累计刷题" in html)
        check("包含趋势图", "dchart" in html and "最近两周" in html)
        check("包含薄弱知识点", "薄弱的知识点" in html)
        check("包含建议", "该怎么做" in html)
        check("包含题目链接", "mianshiya.com/question/1" in html)
        check("显示 AI 评分", "6/10" in html)
        check("按掌握状态着色", "#d4380d" in html or "#2f7d32" in html)
        # 空数据也不能崩
        emptyHtml = await page.evaluate(
            "() => MSY.report.toHtml(MSY.report.aggregate([]))"
        )
        check("没有记录时生成的是友好提示页",
              "<!DOCTYPE html>" in emptyHtml and "还没有任何复习记录" in emptyHtml)

        # 标题里的 HTML 必须被转义，否则导出的网页会执行任意脚本
        xss = await page.evaluate(
            """() => MSY.report.toHtml(MSY.report.aggregate([
                 { title: '<img src=x onerror=alert(1)>', tags: ['<b>粗</b>'], updatedAt: Date.now(), threads: {} }]))"""
        )
        # 转义后 onerror=alert(1) 作为纯文本留着是正常的，关键是标签本身被中和了
        check("题目里的 HTML 标签被转义", "&lt;img" in xss and "<img" not in xss)
        check("标签里的 HTML 被转义", "&lt;b&gt;" in xss)

        await b.close()

    print("\n" + "=" * 60)
    print(f"\033[1m结果：{len(PASS)} 通过 / {len(FAIL)} 失败\033[0m")
    if FAIL:
        for f in FAIL:
            print(f"  ✗ {f}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
