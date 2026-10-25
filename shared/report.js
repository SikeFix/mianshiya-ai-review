/**
 * 学习报告：把攒下的复习记录聚合成「哪块行、哪块不行」。
 *
 * 两个维度看知识点：
 *   1. 站点给的标签（Redis、后端、大模型…）—— 每道题都有，最可靠
 *   2. 速记模式产出的「关键词」—— 更细，但只有用过速记模式的题才有
 *
 * 薄弱分是加权出来的：完全不会最重，其次模糊，「还没自评」也算偏弱，
 * 因为那意味着你没验证过自己会不会。
 */
(function () {
  const NS = globalThis.MSY;

  /* ------------------------------ 工具 ------------------------------ */

  const esc = (s) =>
    String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  // 每种自评对应的「薄弱权重」，数字越大说明越没掌握
  const WEIGHT = { again: 3, hard: 2.2, new: 1.5, good: 0.5, easy: 0 };

  const stateOf = (rec) => rec.srs?.lastRating || 'new';
  const stateLabel = (s) => (s === 'new' ? '未自评' : NS.srs.ratingById(s).label);

  /**
   * 从速记模式的回复里抠出「关键词」那一段。
   * 提示词里要求用 `、` 分隔，所以按顿号切最稳。
   */
  function keywordsOf(rec) {
    const threads = NS.notes.threadsOf(rec);
    const text = (threads.memorize || [])
      .filter((m) => m.role === 'assistant')
      .map((m) => m.content)
      .join('\n');
    if (!text) return [];
    const m = /\*\*\s*关键词\s*\*\*[^\n]*\n+\s*([^\n]+)/.exec(text);
    if (!m) return [];
    return m[1]
      .split(/[、,，/|]/)
      .map((s) => s.replace(/[`*：:\s（）()]/g, ''))
      // 中文关键词可以只有一个字（「锁」「栈」「索引」），门槛放到 1
      .filter((s) => s.length >= 1 && s.length <= 12);
  }

  /* ---------------------------- 聚合 ---------------------------- */

  /**
   * @param {Array} list notes.list() 的结果
   * @returns 结构化报告数据
   */
  function aggregate(list) {
    const now = Date.now();
    const stats = NS.srs.stats(list, now);

    // --- 按知识点（标签 + 关键词）分组 ---
    const groups = new Map();
    const addTo = (name, kind, rec) => {
      if (!name) return;
      const key = `${kind}:${name}`;
      if (!groups.has(key)) groups.set(key, { name, kind, items: [] });
      groups.get(key).items.push(rec);
    };

    for (const rec of list) {
      addTo(rec.bank?.name, 'bank', rec);
      for (const c of rec.custom || []) addTo(c, 'custom', rec);
      for (const t of rec.tags || []) addTo(t, 'tag', rec);
      for (const k of keywordsOf(rec)) addTo(k, 'keyword', rec);
    }

    const points = [...groups.values()].map((g) => {
      const counts = { again: 0, hard: 0, good: 0, easy: 0, new: 0 };
      let lapses = 0;
      let due = 0;
      for (const r of g.items) {
        counts[stateOf(r)] += 1;
        lapses += r.srs?.lapses || 0;
        if (!r.srs?.due || r.srs.due <= now) due += 1;
      }
      const n = g.items.length;
      const weakness = g.items.reduce((s, r) => s + WEIGHT[stateOf(r)], 0) / n;
      return {
        name: g.name,
        kind: g.kind,
        count: n,
        counts,
        lapses,
        due,
        weakness: Math.round(weakness * 100) / 100,
        mastered: counts.good + counts.easy,
      };
    });

    // 排序要先看「有没有真的答错」再看薄弱分。
    // 只按薄弱分排的话，一堆「还没自评」的新题（1.5 分）会把真正答错的顶下去，
    // 那张表就变成了「列出所有没开始的题」，等于没说。
    points.sort(
      (a, b) =>
        b.counts.again * 3 + b.counts.hard * 2 - (a.counts.again * 3 + a.counts.hard * 2) ||
        b.weakness - a.weakness ||
        b.count - a.count
    );

    // --- 逐题明细 ---
    const questions = list
      .map((r) => ({
        title: r.title || '未命名题目',
        url: r.url || '',
        tags: r.tags || [],
        state: stateOf(r),
        label: stateLabel(stateOf(r)),
        due: r.srs?.due || 0,
        dueLabel: NS.srs.dueLabel(r.srs, now),
        reps: r.srs?.reps || 0,
        lapses: r.srs?.lapses || 0,
        score: typeof r.lastScore === 'number' ? r.lastScore : null,
        updatedAt: r.updatedAt || 0,
      }))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    // --- 建议 ---
    // 「薄弱」必须有点的真实负面信号（答错过或评为模糊）。
    // 只按薄弱分排的话，一堆「还没自评」的新题会把真正答错的淹掉 ——
    // 没学过和学不会不是一回事，分开说更诚实。
    const weak = points.filter((p) => p.counts.again > 0 || p.counts.hard > 0).slice(0, 5);
    const strong = points
      .filter((p) => p.count >= 2 && p.mastered / p.count >= 0.8)
      .slice(0, 5);
    const unrated = questions.filter((q) => q.state === 'new').length;

    // 最近 14 天每天复习了多少道，用来画趋势图
    const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const daily = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now - i * 86400000);
      const key = dayKey(d);
      daily.push({
        key,
        label: `${d.getMonth() + 1}/${d.getDate()}`,
        count: list.filter((r) => dayKey(new Date(r.updatedAt || 0)) === key).length,
      });
    }
    const todayCount = daily[daily.length - 1].count;

    const mastered = questions.filter((q) => q.state === 'good' || q.state === 'easy').length;
    const masteryRate = stats.total ? Math.round((mastered / stats.total) * 100) : 0;

    return {
      generatedAt: now, stats, points, questions, weak, strong,
      masteryRate, mastered, unrated, total: stats.total,
      daily, todayCount,
      records: list,
    };
  }

  /* ---------------------------- AI 简报 ---------------------------- */

  /**
   * 把统计压缩成一段给模型看的简报。
   *
   * 只给结论性数字和薄弱清单，不要把几十道题的原文都塞进去 ——
   * 分析薄弱点靠的是分布和遗忘次数，不是逐题复述。
   */
  function briefForAI(agg) {
    const L = [];
    L.push(`我一共复习了 ${agg.total} 道面试题。`);
    L.push(`其中已掌握 ${agg.mastered} 道，掌握率 ${agg.masteryRate}%。`);
    L.push(`还有 ${agg.unrated} 道聊过但没自评，${agg.stats.due} 道到了该复习的时间。`);
    L.push(`累计遗忘 ${agg.stats.lapses} 次。`);

    if (agg.weak.length) {
      L.push('', '偏弱的知识点：');
      for (const w of agg.weak) {
        L.push(
          `- ${w.name}：${w.count} 道题，其中「完全不会」${w.counts.again} 道、「有点模糊」${w.counts.hard} 道，累计忘过 ${w.lapses} 次`
        );
      }
    } else {
      L.push('目前没有明显薄弱的知识点。');
    }
    if (agg.strong.length) {
      L.push('', `比较稳的：${agg.strong.map((x) => x.name).join('、')}`);
    }

    const pending = agg.questions.filter((q) => q.state === 'again' || q.state === 'hard').slice(0, 12);
    if (pending.length) {
      L.push('', '这些题我没掌握，标题供你参考：');
      for (const q of pending) L.push(`- ${q.title}`);
    }
    return L.join('\n');
  }

  /* -------------------------- 面试范围 -------------------------- */

  /**
   * 把「只考这些方向」拼成一段给模型的指令。
   *
   * 顺带把范围内没掌握的那些题的标题给它 —— 模型看不到题库，
   * 但知道具体题目之后就能围绕它们出题、追问，比只说「考 Redis」精准得多。
   */
  function scopeBrief(labels, list, { useWeak = true } = {}) {
    const names = (labels || []).filter(Boolean);
    if (!names.length) return '';

    const inScope = list.filter((r) => {
      const own = [r.bank?.name, ...(r.tags || []), ...(r.custom || [])].filter(Boolean);
      return own.some((n) => names.includes(n));
    });

    const L = ['【本次面试范围】'];
    L.push(`只考这些方向：${names.join('、')}。不要问范围之外的题目。`);

    if (useWeak && inScope.length) {
      const weak = inScope
        .filter((r) => ['again', 'hard'].includes(r.srs?.lastRating || 'new'))
        .sort((a, b) => (b.srs?.lapses || 0) - (a.srs?.lapses || 0))
        .slice(0, 10);
      if (weak.length) {
        L.push('', '这些题我在范围内还没掌握，优先考它们：');
        for (const r of weak) {
          const how = r.srs?.lastRating === 'again' ? '完全不会' : r.srs?.lastRating === 'hard' ? '有点模糊' : '没自评过';
          L.push(`- ${r.title}（${how}${r.srs?.lapses ? `，忘过 ${r.srs.lapses} 次` : ''}）`);
        }
      }
    }
    L.push('', `范围内我一共学过 ${inScope.length} 道题，可以据此判断我的水平。`);
    return L.join('\n');
  }

  /** 某个分类下有多少题、多少没掌握，给界面上的按钮用 */
  function scopeStats(label, list) {
    const inScope = list.filter((r) =>
      [r.bank?.name, ...(r.tags || []), ...(r.custom || [])].filter(Boolean).includes(label)
    );
    return {
      total: inScope.length,
      weak: inScope.filter((r) => ['again', 'hard'].includes(r.srs?.lastRating || 'new')).length,
    };
  }

  /* ---------------------------- 思维导图 ---------------------------- */

  /**
   * 用嵌套的 <details> 拼一张可折叠的思维导图。
   *
   * 选 <details> 而不是画布或自研交互，是因为它天生可点、可折叠，
   * 而且**不需要一行 JavaScript** —— 导出的 HTML 文件离线打开也一样能点。
   */
  function treeNode(name, meta, children, opts = {}) {
    const inner = children?.length
      ? children.join('')
      : '';
    const badge = meta ? `<span class="mmeta">${esc(meta)}</span>` : '';
    if (!children?.length && opts.link) {
      return `<li class="mleaf"><a href="${esc(opts.link)}" target="_blank" rel="noreferrer">${esc(name)}</a>${badge}</li>`;
    }
    return `<li><details${opts.open ? ' open' : ''}>
      <summary>${esc(name)}${badge}</summary>
      <ul>${inner}</ul>
    </details></li>`;
  }

  function questionLeaf(q) {
    const meta = [q.label, q.difficulty, q.lapses ? `忘过 ${q.lapses} 次` : ''].filter(Boolean).join(' · ');
    return `<li class="mleaf" data-state="${q.state}">
      ${q.url ? `<a href="${esc(q.url)}" target="_blank" rel="noreferrer">${esc(q.title)}</a>` : esc(q.title)}
      <span class="mmeta">${esc(meta)}</span></li>`;
  }

  /** 按某个维度生成一棵树 */
  function dimensionTree(list, dim) {
    const groups = new Map();
    for (const rec of list) {
      const keys =
        dim === 'bank' ? [rec.bank?.name || '未归入题库']
        : dim === 'tag' ? (rec.tags?.length ? rec.tags : ['无标签'])
        : (rec.custom?.length ? rec.custom : ['未分类']);
      for (const k of keys) {
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(rec);
      }
    }
    const items = [...groups.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([name, recs]) => {
        const weak = recs.filter((r) => ['again', 'hard'].includes(r.srs?.lastRating || 'new')).length;
        const meta = `${recs.length} 道${weak ? ` · 待加强 ${weak}` : ''}`;
        const qs = recs
          .slice()
          .sort((a, b) => (b.srs?.lastRating === 'again' ? 1 : 0) - (a.srs?.lastRating === 'again' ? 1 : 0))
          .map((r) =>
            questionLeaf({
              title: r.title || '未命名题目',
              url: r.url,
              state: r.srs?.lastRating || 'new',
              label: r.srs?.lastRating ? NS.srs.ratingById(r.srs.lastRating).label : '未自评',
              difficulty: r.difficulty,
              lapses: r.srs?.lapses,
            })
          );
        return treeNode(name, meta, qs, { open: groups.size <= 6 });
      });
    return `<ul class="mtree">${items.join('')}</ul>`;
  }

  function mindMapHtml(agg) {
    if (!agg.total) return '<div class="empty">还没有记录。</div>';
    return `<ul class="mtree mroot">
      ${treeNode('按题库', `${agg.points.filter((p) => p.kind === 'bank').length} 个`, [dimensionTree(agg.records, 'bank')], { open: true })}
      ${treeNode('按标签', '', [dimensionTree(agg.records, 'tag')])}
      ${treeNode('按我的分类', '', [dimensionTree(agg.records, 'custom')])}
    </ul>`;
  }

  /* -------------------------- HTML 报告 -------------------------- */

  /** 最近 14 天的柱状图。纯 div 拼的，不需要图表库 */
  function dailyChart(daily) {
    const max = Math.max(1, ...daily.map((d) => d.count));
    const bars = daily
      .map(
        (d) => `<div class="dcol" title="${d.label}：${d.count} 道">
          <div class="dnum">${d.count || ''}</div>
          <div class="dbar" style="height:${Math.round((d.count / max) * 100)}%"></div>
        </div>`
      )
      .join('');
    return `<div class="dchart">${bars}</div>
      <div class="daxis">${daily.map((d) => `<span>${d.label}</span>`).join('')}</div>`;
  }

  const KIND_LABEL = { tag: '标签', keyword: '关键词', bank: '题库', custom: '我的分类' };

  const STATE_COLOR = {
    again: '#d4380d',
    hard: '#d99a1e',
    good: '#2f7d32',
    easy: '#0f766e',
    new: '#9aa1ad',
  };

  /**
   * 生成一份完全自包含的 HTML（内联样式，无外部依赖、无脚本），
   * 双击就能在任何浏览器里打开，也方便丢进笔记库。
   */
  function toHtml(agg, opts = {}) {
    const title = opts.title || '面试鸭学习报告';
    const t = new Date(agg.generatedAt);
    const stamp = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')} ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;

    const tile = (n, k, color = '') =>
      `<div class="tile"><div class="n"${color ? ` style="color:${color}"` : ''}>${n}</div><div class="k">${esc(k)}</div></div>`;

    const bar = (parts, total) => {
      const seg = (n, c) => (n ? `<span style="width:${(n / total) * 100}%;background:${c}"></span>` : '');
      return `<div class="bar">${seg(parts.good + parts.easy, STATE_COLOR.good)}${seg(parts.hard, STATE_COLOR.hard)}${seg(parts.again, STATE_COLOR.again)}${seg(parts.new, STATE_COLOR.new)}</div>`;
    };

    const num = (n, color) =>
      n ? `<td class="num"${color ? ` style="color:${color}"` : ''}>${n}</td>` : '<td class="num zero">0</td>';

    const pointRows = agg.points
      .slice(0, 40)
      .map(
        (p) => `<tr${p.counts.again || p.counts.hard ? ' class="is-weak"' : ''}>
        <td><span class="kind">${KIND_LABEL[p.kind] || '标签'}</span> ${esc(p.name)}</td>
        ${num(p.count)}
        ${num(p.mastered, STATE_COLOR.good)}
        ${num(p.counts.hard, STATE_COLOR.hard)}
        ${num(p.counts.again, STATE_COLOR.again)}
        ${num(p.lapses)}
        ${num(p.counts.new)}
        <td style="width:170px">${bar(p.counts, p.count)}
          <div class="w">薄弱分 ${p.weakness}</div></td>
      </tr>`
      )
      .join('');

    const qRows = agg.questions
      .map(
        (q) => `<tr>
        <td>${q.url ? `<a href="${esc(q.url)}" target="_blank" rel="noreferrer">${esc(q.title)}</a>` : esc(q.title)}</td>
        <td><span class="pill" style="background:${STATE_COLOR[q.state]}1f;color:${STATE_COLOR[q.state]}">${esc(q.label)}</span></td>
        <td class="num">${q.lapses || ''}</td>
        <td class="num">${q.score === null ? '' : q.score + '/10'}</td>
        <td class="dim">${esc(q.dueLabel)}</td>
        <td class="dim">${esc((q.tags || []).join('、'))}</td>
      </tr>`
      )
      .join('');

    const advice = [];
    if (!agg.total) {
      advice.push('还没有任何复习记录。去题目页和 AI 聊几句，这里就会长出来。');
    } else {
      if (agg.stats.due) advice.push(`有 <b>${agg.stats.due}</b> 道题到了该复习的时间，先去把它们过一遍。`);
      if (agg.unrated) advice.push(`还有 <b>${agg.unrated}</b> 道题聊过但没自评过 —— 自评一次才会进入复习排期。`);
      for (const w of agg.weak) {
        advice.push(
          `<b>${esc(w.name)}</b> 这块偏弱（${w.count} 道题里有 ${w.counts.again} 道选了「完全不会」，累计忘过 ${w.lapses} 次），建议先用「速记」模式过一遍。`
        );
      }
      if (!agg.weak.length) advice.push('目前没有明显薄弱的知识点，保持节奏就行。');
      if (agg.strong.length) {
        advice.push(`已经比较稳的是：${agg.strong.map((s) => esc(s.name)).join('、')}。`);
      }
    }

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)} · ${stamp}</title>
<style>
  :root { --bg:#f5f5f3; --card:#fff; --border:#e7e5e2; --text:#1c1a17; --dim:#5c5751; --faint:#8f8982; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); line-height:1.7;
         font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei","Segoe UI",Roboto,sans-serif; }
  .wrap { max-width:1000px; margin:0 auto; padding:28px 22px 70px; }
  header { background:#0f766e; color:#fff; padding:26px 0 22px; margin-bottom:22px; }
  header .wrap { padding-top:0; padding-bottom:0; }
  h1 { margin:0; font-size:21px; font-weight:600; }
  header p { margin:5px 0 0; font-size:13px; opacity:.9; }
  h2 { font-size:15px; margin:0 0 4px; }
  .sub { color:var(--dim); font-size:12.5px; margin:0 0 14px; }
  .card { background:var(--card); border:1px solid var(--border); border-radius:13px; padding:18px 20px; margin-bottom:16px; }
  .tiles { display:flex; flex-wrap:wrap; gap:10px; }
  .tile { flex:1; min-width:118px; background:var(--bg); border:1px solid var(--border); border-radius:11px; padding:13px 15px; }
  .tile .n { font-size:26px; font-weight:700; line-height:1.15; }
  .tile .k { font-size:12px; color:var(--dim); margin-top:3px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th,td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--border); vertical-align:middle; }
  th { font-size:12px; color:var(--dim); font-weight:600; background:var(--bg); }
  tr:last-child td { border-bottom:none; }
  td.num { text-align:right; font-variant-numeric:tabular-nums; }
  td.num.zero { color:var(--border); }
  tbody tr:hover { background:var(--bg); }
  tr.is-weak { box-shadow:inset 3px 0 0 var(--danger); }
  tr.is-weak td:first-child { font-weight:600; }
  td.dim { color:var(--faint); font-size:12px; }
  a { color:#0f766e; text-decoration:none; }
  a:hover { text-decoration:underline; }
  .bar { display:flex; height:8px; border-radius:4px; overflow:hidden; background:var(--border); }
  .bar span { display:block; height:100%; }
  .w { font-size:11px; color:var(--faint); margin-top:3px; }
  .kind { font-size:10.5px; color:var(--faint); border:1px solid var(--border); border-radius:4px; padding:0 4px; margin-right:4px; }
  .pill { display:inline-block; padding:1px 9px; border-radius:999px; font-size:12px; font-weight:600; }
  ol.advice { margin:0; padding-left:20px; }
  ol.advice li { margin:6px 0; font-size:13.5px; }
  .empty { text-align:center; color:var(--dim); padding:36px 0; font-size:13.5px; }
  .dchart { display:flex; align-items:flex-end; gap:4px; height:120px; margin-top:6px; }
  .dcol { flex:1; display:flex; flex-direction:column; justify-content:flex-end; align-items:center; height:100%; }
  .dnum { font-size:10.5px; color:var(--faint); height:14px; }
  .dbar { width:100%; min-height:2px; border-radius:4px 4px 0 0;
          background:#0f766e; }
  .daxis { display:flex; gap:4px; margin-top:4px; }
  .daxis span { flex:1; text-align:center; font-size:10px; color:var(--faint); }
  footer { text-align:center; color:var(--faint); font-size:12px; margin-top:26px; }
  /* 思维导图：用原生 details 做折叠，导出后离线打开也能点 */
  .mtree { list-style:none; margin:0; padding-left:0; }
  .mtree ul { list-style:none; margin:0; padding-left:18px; border-left:1px dashed var(--border); }
  .mtree li { margin:3px 0; position:relative; }
  .mtree li::before {
    content:""; position:absolute; left:-18px; top:14px;
    width:12px; height:1px; background:var(--border);
  }
  .mroot > li::before { display:none; }
  .mtree summary {
    cursor:pointer; padding:3px 6px; border-radius:6px;
    font-size:13.5px; font-weight:600; list-style:none;
  }
  .mtree summary::-webkit-details-marker { display:none; }
  .mtree summary::before { content:"▸ "; color:var(--faint); }
  .mtree details[open] > summary::before { content:"▾ "; }
  .mtree summary:hover { background:var(--bg); }
  .mtree .mleaf { font-size:13px; padding:2px 0 2px 16px; }
  .mtree .mleaf a { color:var(--text); }
  .mtree .mleaf a:hover { color:#0f766e; }
  .mtree .mmeta { color:var(--faint); font-size:11.5px; margin-left:7px; }
  .mtree .mleaf[data-state="again"] a { color:#d4380d; }
  .mtree .mleaf[data-state="hard"] a { color:#b45309; }
  .mtree .mleaf[data-state="good"] a, .mtree .mleaf[data-state="easy"] a { color:#2f7d32; }
</style>
</head>
<body>
<header>
  <div class="wrap">
    <h1>${esc(title)}</h1>
    <p>生成于 ${stamp} · 共 ${agg.total} 道题 · 数据来自本机浏览器的复习记录</p>
  </div>
</header>

<div class="wrap">
  ${
    agg.total
      ? `
  <div class="card">
    <h2>总览</h2>
    <p class="sub">掌握率指被评为「记住了 / 太简单」的比例</p>
    <div class="tiles">
      ${tile(agg.todayCount, '今日刷题', agg.todayCount ? STATE_COLOR.good : '')}
      ${tile(agg.total, '累计刷题')}
      ${tile(agg.stats.due, '待复习', agg.stats.due ? STATE_COLOR.again : '')}
      ${tile(agg.masteryRate + '%', '掌握率', agg.masteryRate >= 70 ? STATE_COLOR.good : STATE_COLOR.hard)}
      ${tile(agg.stats.streak, '连续天数')}
      ${tile(agg.stats.lapses, '累计遗忘次数')}
      ${tile(agg.points.length, '涉及知识点')}
    </div>
  </div>

  <div class="card">
    <h2>最近两周的刷题量</h2>
    <p class="sub">柱子上方是当天的题数，最高的一天撑满整格</p>
    ${dailyChart(agg.daily)}
  </div>

  <div class="card">
    <h2>掌握度分布</h2>
    <p class="sub">绿=记住了/太简单　橙=有点模糊　红=完全不会　灰=还没自评</p>
    ${bar(
      {
        good: agg.questions.filter((q) => q.state === 'good').length +
              agg.questions.filter((q) => q.state === 'easy').length,
        hard: agg.questions.filter((q) => q.state === 'hard').length,
        again: agg.questions.filter((q) => q.state === 'again').length,
        new: agg.questions.filter((q) => q.state === 'new').length,
      },
      agg.total
    )}
  </div>

  <div class="card">
    <h2>薄弱的知识点</h2>
    <p class="sub">
      答错过的排在最前面 —— 排序先看「完全不会 / 有点模糊」的题数，再看加权薄弱分。
      ${agg.unrated > agg.mastered ? `注意：现在有 ${agg.unrated} 道题还没自评过，先做几道并自评，这张表才准。` : ''}
    </p>
    ${agg.points.length ? `<table>
      <thead><tr><th>知识点</th><th class="num">题数</th><th class="num">已掌握</th><th class="num">模糊</th><th class="num">不会</th><th class="num">忘过</th><th class="num">未自评</th><th>分布</th></tr></thead>
      <tbody>${pointRows}</tbody>
    </table>` : '<div class="empty">还没有可统计的知识点。</div>'}
  </div>

  <div class="card">
    <h2>思维导图</h2>
    <p class="sub">点标题展开或收起，点题目直接打开原题</p>
    ${mindMapHtml(agg)}
  </div>

  <div class="card">
    <h2>该怎么做</h2>
    <ol class="advice">${advice.map((a) => `<li>${a}</li>`).join('')}</ol>
  </div>

  <div class="card">
    <h2>全部题目</h2>
    <p class="sub">最近复习的排在前面</p>
    <table>
      <thead><tr><th>题目</th><th>掌握</th><th class="num">忘过</th><th class="num">AI 评分</th><th>下次复习</th><th>标签</th></tr></thead>
      <tbody>${qRows}</tbody>
    </table>
  </div>`
      : `<div class="card"><div class="empty">还没有任何复习记录。<br>去面试鸭的题目页和 AI 聊几句，再回来看看。</div></div>`
  }

  <footer>由「面试鸭 AI 复习助手」生成 · 数据只存在你自己的电脑上</footer>
</div>
</body>
</html>`;
  }

  NS.report = {
    aggregate, toHtml, keywordsOf, briefForAI, mindMapHtml, dimensionTree,
    scopeBrief, scopeStats,
    WEIGHT, STATE_COLOR, KIND_LABEL, esc,
  };
})();
