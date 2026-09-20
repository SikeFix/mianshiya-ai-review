/**
 * 间隔重复（spaced repetition）。
 *
 * 算法是 SM-2 的简化版：每道题有自己的「难度因子」和「当前间隔」，
 * 你每次自评一次，间隔就按因子放大或缩小，到期的题会重新冒出来。
 *
 * 为什么以自评为主而不是解析 AI 的打分：模型给的 7/10 到底算好还是不好，
 * 跨模型、跨题目都不一致；而「记住了 / 有点模糊 / 完全不会」是你自己的判断，
 * 也正好是 Anki 这类工具一直用的信号。AI 的评分仍然会存下来做参考。
 */
(function () {
  const NS = globalThis.MSY;

  const MIN_EASE = 1.3;
  const MAX_EASE = 2.8;
  const MAX_INTERVAL_DAYS = 180;
  const AGAIN_DELAY_MS = 10 * 60 * 1000; // 「完全不会」10 分钟后再来
  const HISTORY_MAX = 30;

  const DAY = 86400000;

  /** 四种自评。id 会存进记录，改动要保持向后兼容。 */
  const RATINGS = [
    { id: 'again', label: '完全不会', icon: 'alert', hint: '10 分钟后再来', tone: 'bad' },
    { id: 'hard', label: '有点模糊', icon: 'question', hint: '明天再来', tone: 'warn' },
    { id: 'good', label: '记住了', icon: 'check', hint: '间隔递增', tone: 'ok' },
    { id: 'easy', label: '太简单', icon: 'memorize', hint: '拉长间隔', tone: 'flat' },
  ];

  const ratingById = (id) => RATINGS.find((r) => r.id === id) || RATINGS[2];

  /** 第一次学完一道题时的初始状态：明天再来。 */
  function initial(now = Date.now()) {
    return {
      ease: 2.5,
      interval: 1,
      due: now + DAY,
      reps: 1,
      lapses: 0,
      lastRating: '',
      lastAt: now,
      history: [],
    };
  }

  const clampEase = (e) => Math.min(MAX_EASE, Math.max(MIN_EASE, e));

  /**
   * 按一次自评推进状态，返回新的 srs（不改原对象）。
   * @param {object} srs 旧状态，可为空
   * @param {string} rating again | hard | good | easy
   */
  function apply(srs, rating, now = Date.now()) {
    const s = { ease: 2.5, interval: 0, reps: 0, lapses: 0, history: [], ...(srs || {}) };
    let ease = s.ease;
    let interval = s.interval;
    let lapses = s.lapses;

    switch (rating) {
      case 'again':
        // 忘了要同时降难度因子、重置间隔 —— 只重置间隔的话下次又会很快拉长
        ease = clampEase(ease - 0.25);
        interval = 0;
        lapses += 1;
        break;
      case 'hard':
        ease = clampEase(ease - 0.15);
        interval = Math.max(1, interval * 1.2);
        break;
      case 'easy':
        ease = clampEase(ease + 0.1);
        interval = interval < 1 ? 3 : interval * ease * 1.3;
        break;
      case 'good':
      default:
        interval = interval < 1 ? 1 : interval * ease;
        break;
    }

    interval = Math.min(MAX_INTERVAL_DAYS, Math.round(interval * 10) / 10);
    const due = now + (rating === 'again' ? AGAIN_DELAY_MS : interval * DAY);

    const history = [...(s.history || []), { at: now, rating }].slice(-HISTORY_MAX);

    return {
      ease,
      interval,
      due,
      reps: (s.reps || 0) + 1,
      lapses,
      lastRating: rating,
      lastAt: now,
      history,
    };
  }

  /** 到期的记录（没复习过的也算到期） */
  function due(list, now = Date.now()) {
    return list.filter((r) => {
      const d = r.srs?.due;
      return !d || d <= now;
    });
  }

  /** 还有多久到期，给人看的一句话 */
  function dueLabel(srs, now = Date.now()) {
    if (!srs?.due) return '还没复习过';
    const diff = srs.due - now;
    if (diff <= 0) return '现在就该复习';
    const mins = Math.round(diff / 60000);
    if (mins < 60) return `${mins} 分钟后`;
    const hours = Math.round(diff / 3600000);
    if (hours < 24) return `${hours} 小时后`;
    const days = Math.round(diff / DAY);
    if (days < 30) return `${days} 天后`;
    return `${Math.round(days / 30)} 个月后`;
  }

  /**
   * 总览：攒了多少、多少到期、掌握程度分布、连续天数。
   */
  function stats(list, now = Date.now()) {
    const studied = list.filter((r) => r.srs);
    const dueList = due(list, now);

    const buckets = { again: 0, hard: 0, good: 0, easy: 0, new: 0 };
    for (const r of list) {
      if (!r.srs?.lastRating) buckets.new += 1;
      else buckets[r.srs.lastRating] = (buckets[r.srs.lastRating] || 0) + 1;
    }

    const dayOf = (ms) => new Date(ms || 0).toDateString();
    const days = new Set(list.map((r) => dayOf(r.updatedAt)));
    let streak = 0;
    const d = new Date();
    if (!days.has(d.toDateString())) d.setDate(d.getDate() - 1); // 今天还没练也不清零
    while (days.has(d.toDateString())) {
      streak++;
      d.setDate(d.getDate() - 1);
    }

    return {
      total: list.length,
      studied: studied.length,
      due: dueList.length,
      today: list.filter((r) => dayOf(r.updatedAt) === new Date().toDateString()).length,
      streak,
      buckets,
      lapses: list.reduce((n, r) => n + (r.srs?.lapses || 0), 0),
    };
  }

  NS.srs = { RATINGS, ratingById, initial, apply, due, dueLabel, stats, AGAIN_DELAY_MS, MAX_INTERVAL_DAYS };
})();
