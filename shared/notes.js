/**
 * 本地笔记：把识别到的题目、答案和 AI 复习记录整理成 Markdown 存到本地。
 *
 * 两份数据：
 *   1. chrome.storage.local 里的记录（msy_notes）—— 让复习记录跨页面刷新还在，
 *      也是「导出全部」的数据来源
 *   2. 下载目录里的 .md 文件 —— 真正落到你磁盘上的资料
 *
 * 文件名和下载路径都要消毒：题目里什么字符都有（斜杠、问号、引号、
 * Windows 保留名…），直接拿去当文件名会失败或者落到奇怪的路径去。
 */
(function () {
  const NS = globalThis.MSY;
  const KEY = 'msy_notes';
  const MAX_RECORDS = 500; // 超出后按更新时间淘汰最旧的

  /* ----------------------------- 文件名消毒 ----------------------------- */

  // Windows 不允许的字符 + 控制字符
  const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g;
  const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

  /**
   * 把任意文字变成安全的文件名（不含扩展名）。
   * @param {string} text 原始文字
   * @param {string} fallback 文字被清空时用
   * @param {number} max 最大长度（按字符数，中文一个字算一个）
   */
  function safeName(text, fallback = '未命名', max = 60) {
    let s = String(text ?? '')
      .replace(ILLEGAL, ' ') // 不允许的字符换成空格，避免两个词粘一起
      .replace(/\s+/g, ' ')
      .replace(/^[\s.]+|[\s.]+$/g, '') // 首尾的空格和点（Windows 会去掉，自己先处理）
      .trim();

    if (s.length > max) s = s.slice(0, max).trim();
    if (!s) s = fallback;
    // Windows 的保留设备名
    if (RESERVED.test(s)) s = `_${s}`;
    return s;
  }

  /** 文件夹名同样要消毒，并且不能是空、不能带路径分隔符 */
  const safeFolder = (text) => safeName(text, '面试鸭笔记', 40).replace(/[.]+$/g, '') || '面试鸭笔记';

  /* ------------------------------ 记录读写 ------------------------------ */

  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

  async function all() {
    try {
      const raw = (await chrome.storage.local.get(KEY))[KEY];
      return isObj(raw) ? raw : {};
    } catch {
      return {};
    }
  }

  /**
   * 写入一条记录。同名 key 直接覆盖（同一道题同一模式只留最新的一份）。
   */
  async function upsert(key, record) {
    if (!key) return;
    const db = await all();
    const prev = db[key] || {};
    db[key] = { ...prev, ...record, createdAt: prev.createdAt || Date.now(), updatedAt: Date.now() };
    // 新题第一次记录下来就排进复习队列（默认明天），
    // 否则没有 srs 的记录永远不会到期，也就永远轮不到它
    if (!db[key].srs) db[key].srs = NS.srs.initial();

    const keys = Object.keys(db);
    if (keys.length > MAX_RECORDS) {
      keys
        .sort((a, b) => (db[a].updatedAt || 0) - (db[b].updatedAt || 0))
        .slice(0, keys.length - MAX_RECORDS)
        .forEach((k) => delete db[k]);
    }
    await chrome.storage.local.set({ [KEY]: db });
  }

  async function remove(key) {
    const db = await all();
    delete db[key];
    await chrome.storage.local.set({ [KEY]: db });
  }

  const clear = () => chrome.storage.local.set({ [KEY]: {} });

  const list = async () => Object.entries(await all()).map(([key, r]) => ({ key, ...r }));

  async function get(key) {
    const db = await all();
    return db[key] ? { key, ...db[key] } : null;
  }

  /**
   * 只更新复习状态，不动别的内容。
   * 单独开一个方法是为了避免把整条记录读出来再写回去时，
   * 不小心用旧快照覆盖了刚发生的对话。
   */
  /** 只改自定义分类，不碰别的（和 setSrs 一样，避免用旧快照覆盖刚发生的对话） */
  async function setCustom(key, labels) {
    const db = await all();
    if (!db[key]) return;
    const clean = [...new Set((labels || []).map((t) => String(t).trim()).filter(Boolean))].slice(0, 12);
    db[key] = { ...db[key], custom: clean, updatedAt: Date.now() };
    await chrome.storage.local.set({ [KEY]: db });
    return clean;
  }

  async function setSrs(key, srs) {
    const db = await all();
    if (!db[key]) return;
    db[key] = { ...db[key], srs, updatedAt: Date.now() };
    await chrome.storage.local.set({ [KEY]: db });
  }

  /** 把记录里的对话按模式摊平。兼容只有 messages 的旧记录。 */
  function threadsOf(rec) {
    if (rec.threads && typeof rec.threads === 'object') return rec.threads;
    if (Array.isArray(rec.messages) && rec.messages.length) return { '': rec.messages };
    return {};
  }

  /* ---------------------------- Markdown 生成 ---------------------------- */

  const two = (n) => String(n).padStart(2, '0');
  function stamp(ms) {
    const d = new Date(ms || Date.now());
    return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
  }

  const SOURCE_LABEL = {
    dom: '本站参考答案',
    teaser: '仅拿到摘要（完整答案需会员）',
    none: '页面未提供，由 AI 自身知识作答',
  };

  /**
   * 把一条记录渲染成 Markdown。
   * @param {object} rec
   * @param {object} opts { includeChat }
   */
  function toMarkdown(rec, opts = {}) {
    const includeChat = opts.includeChat !== false;
    const L = [];

    L.push(`# ${rec.title || '未命名题目'}`, '');

    const meta = [];
    if (rec.num) meta.push(`- **题号**：${rec.num}`);
    if (rec.custom?.length) meta.push(`- **我的分类**：${rec.custom.join('、')}`);
    if (rec.bank?.name) meta.push(`- **所属题库**：${rec.bank.name}`);
    if (rec.difficulty) meta.push(`- **难度**：${rec.difficulty}`);
    if (rec.tags?.length) meta.push(`- **标签**：${rec.tags.join('、')}`);
    if (rec.url) meta.push(`- **来源**：${rec.url}`);
    meta.push(`- **答案来源**：${SOURCE_LABEL[rec.answerSource] || '未知'}`);
    meta.push(`- **更新时间**：${stamp(rec.updatedAt)}`);

    // 复习状态：自己翻笔记的时候一眼能看出这题掌握得怎么样
    if (typeof rec.lastScore === 'number') {
      meta.push(`- **AI 自评分**：${rec.lastScore}/10`);
    }

    const srs = rec.srs;
    if (srs) {
      const last = srs.lastRating ? NS.srs.ratingById(srs.lastRating).label : '还没自评';
      meta.push(`- **掌握情况**：${last}（复习 ${srs.reps || 0} 次，忘过 ${srs.lapses || 0} 次）`);
      if (srs.due) meta.push(`- **下次复习**：${stamp(srs.due)}`);
    }
    L.push(...meta, '');

    L.push('## 题目', '', rec.title || '（未识别到题目）', '');

    L.push('## 本站参考答案', '');
    if (rec.answer) {
      L.push(rec.answer, '');
      if (rec.answerTruncated) {
        L.push('> 站点对非会员只展示部分内容，以上是页面上能读到的全部。', '');
      }
    } else if (rec.paywalled) {
      L.push('> 这道题的答案需要会员，插件不会绕过会员墙，所以没有抓到。', '');
      L.push('> 下面的内容由 AI 基于自身知识给出，仅供参考。', '');
    } else {
      L.push('> 页面上没有找到答案。', '');
    }

    if (includeChat) {
      const threads = threadsOf(rec);
      for (const [mode, msgs] of Object.entries(threads)) {
        if (!msgs?.length) continue;
        const label = mode ? (NS.modeById(mode)?.label || mode) : '';
        L.push(`## AI 复习记录${label ? `（${label}）` : ''}`, '');
        for (const m of msgs) {
          if (m.role === 'user') L.push('### 我', '', m.content, '');
          else if (m.role === 'assistant') L.push('### AI', '', m.content, '');
          else L.push(`> ${m.content}`, '');
        }
      }
    }

    L.push('---', '', `> 由「面试鸭 AI 复习助手」导出于 ${stamp()}`, '');
    return L.join('\n');
  }

  /**
   * 按某个维度把记录分组，用来做分类导出。
   * dim: bank 题库 | tag 标签 | difficulty 难度
   */
  function groupBy(list, dim) {
    const groups = new Map();
    const put = (name, rec) => {
      const key = name || '未分类';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(rec);
    };
    for (const r of list) {
      if (dim === 'bank') put(r.bank?.name, r);
      else if (dim === 'difficulty') put(r.difficulty, r);
      else if (dim === 'custom') {
        // 自己打的分类，一道题可能有多个
        if (r.custom?.length) for (const t of r.custom) put(t, r);
        else put('未分类', r);
      }
      else if (dim === 'tag') {
        // 一道题有多个标签，就分别进各自的分类
        if (r.tags?.length) for (const t of r.tags) put(t, r);
        else put('', r);
      } else put('', r);
    }
    return [...groups.entries()]
      .map(([name, items]) => ({ name, items }))
      .sort((a, b) => b.items.length - a.items.length);
  }

  /** 单个分类的汇总文件内容 */
  function groupToMarkdown(name, items, opts = {}) {
    const head = [
      `# ${name}`,
      '',
      `共 ${items.length} 道题，导出时间 ${stamp()}`,
      '',
      '## 目录',
      '',
      ...items.map((r, i) => {
        const state = r.srs?.lastRating ? NS.srs.ratingById(r.srs.lastRating).label : '未自评';
        const extra = [r.difficulty, (r.tags || []).join('、')].filter(Boolean).join(' · ');
        return `${i + 1}. ${r.title || '未命名题目'}${extra ? `（${extra}）` : ''} —— ${state}`;
      }),
      '',
      '---',
      '',
    ].join('\n');
    return head + items.map((r) => toMarkdown(r, opts)).join('\n---\n\n');
  }

  /** 全部记录合成一份，按更新时间倒序 */
  function allToMarkdown(records, opts = {}) {
    if (!records.length) return '';
    const sorted = [...records].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const head = [
      '# 面试鸭复习笔记',
      '',
      `共 ${sorted.length} 道题，导出时间 ${stamp()}`,
      '',
      '## 目录',
      '',
      ...sorted.map((r, i) => {
        const state = r.srs?.lastRating ? NS.srs.ratingById(r.srs.lastRating).label : '未自评';
        const tag = r.tags?.length ? `（${r.tags.join('、')}）` : '';
        return `${i + 1}. ${r.title || '未命名题目'}${tag} —— ${state}`;
      }),
      '',
      '---',
      '',
    ];
    return head.join('\n') + sorted.map((r) => toMarkdown(r, opts)).join('\n---\n\n');
  }

  /**
   * 该存到哪个文件夹。按题库或标签分子目录，方便按分类整理。
   * 路径是相对的（落在浏览器下载目录下），每一段都消过毒。
   */
  function folderFor(rec, settings) {
    const base = safeFolder(settings?.save?.folder);
    const by = settings?.save?.folderBy || 'flat';
    if (by === 'bank' && rec.bank?.name) return `${base}/${safeFolder(rec.bank.name)}`;
    if (by === 'tag' && rec.tags?.length) return `${base}/${safeFolder(rec.tags[0])}`;
    return base;
  }

  /** 由题目信息生成文件名（不含扩展名） */
  function fileNameFor(rec) {
    const base = rec.title || (rec.questionId ? `题目-${rec.questionId}` : '未命名题目');
    const name = safeName(base, '未命名题目', 60);
    // 带上题号，文件夹里按名称排序时和站点的题目顺序一致
    return rec.num ? `${rec.num}. ${name}` : name;
  }

  NS.notes = {
    KEY, all, list, get, upsert, remove, clear, setSrs, setCustom,
    threadsOf, toMarkdown, allToMarkdown, groupBy, groupToMarkdown,
    fileNameFor, folderFor, safeName, safeFolder, stamp,
  };
})();
