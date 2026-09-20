/**
 * 从面试鸭页面里抓取「当前题目 + 参考答案」。
 *
 * 站点是 Next.js SSR + Ant Design v5。抽取策略分三层降级，从最可靠到最兜底：
 *   1. JSON-LD（schema.org QAPage）—— SS(R)渲染进 HTML 的结构化数据，最稳
 *   2. 语义化类名 —— .best-answer-view / [data-node-key="bestAnswer"] 等手写类名
 *   3. 正文启发式 —— 从主内容区取文本
 *
 * 明确不做的事：不去调站点的付费接口绕过会员墙。只读用户自己浏览器里
 * 已经渲染出来的内容；读不到就如实标记 paywalled，交给 AI 用自己的知识回答。
 */
(function () {
  const NS = globalThis.MSY;

  /* antd 的 css-xxxxx 类是编译产物哈希，每次部署都变，绝不能作为锚点。
     下面只用站点手写的语义类名。

     结构（照真实页面校准过）：
       .best-answer-container > .best-answer-view(ant-card)
         ├─ .ant-card-head      ← 标签栏：推荐答案 / 视频讲解 / 开始面试 …
         ├─ .ant-card-body > .markdown-body   ← 真正的答案在这里
         └ ul.ant-card-actions  ← 操作栏：隐藏答案 等
     所以优先取里面的 .markdown-body；取不到才退而取整张卡片，并把头和操作栏剥掉。
     注意 [data-node-key="xxx"] 是 antd 的标签按钮，不是面板，不能当容器用。 */
  const ANSWER_BODY_SELECTORS = [
    '.best-answer-view .markdown-body',
    '.best-answer-container .markdown-body',
    '.question-answer-view .markdown-body',
    '.best-answer-view',
    '.best-answer-container',
    '.question-answer-view',
  ];

  // 这些是答案容器里的噪音：标签栏、操作栏、右侧目录、评论、广告
  const NOISE_SELECTORS = [
    '.ant-card-head',
    'ul.ant-card-actions',
    '.ant-tabs-nav',
    '[role="tablist"]',
    '.toc-card',
    '.markdown-navigation',
    '#answer-comment-card',
    '.comment-list-card',
    '.ant-affix',
    '.ant-back-top',
    'button',
    'script',
    'style',
    'noscript',
    'svg',
    '.ant-btn',
    '.ant-tag',
  ];

  const MIN_ANSWER_LEN = 80;

  const PAYWALL_PATTERNS = [
    '开通会员查看完整内容',
    '该题目答案仅限会员查看',
    '仅限会员查看',
    '开通会员后查看',
    '会员可查看完整答案',
    '登录后查看完整内容',
  ];

  /* ------------------------------- 标题 ------------------------------- */

  /** 从 JSON-LD 里取结构化数据。面试鸭题目页会输出 schema.org 的 QAPage。 */
  function jsonLdBlocks() {
    const out = [];
    for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(el.textContent);
        if (Array.isArray(data)) out.push(...data);
        else out.push(data);
      } catch {
        /* 忽略解析不了的块 */
      }
    }
    return out;
  }

  function titleFromJsonLd() {
    for (const block of jsonLdBlocks()) {
      const type = block?.['@type'];
      const isQA = type === 'QAPage' || type === 'Question' || (Array.isArray(type) && type.includes('QAPage'));
      const entity = isQA ? block.mainEntity || block : null;
      const name = entity?.name || entity?.title;
      if (typeof name === 'string' && name.trim()) return name.trim();
    }
    return '';
  }

  const BAD_ANCESTOR = 'header, nav, footer, aside, .ant-layout-header, .ant-pro-layout-header, .ant-layout-sider';

  function titleFromDom() {
    // 优先带语义类名的标题，其次正文里最长的 h1/h2
    const explicit = document.querySelector('.question-title, .question-detail-title, [class*="questionTitle"]');
    if (explicit?.textContent?.trim()) return stripNum(explicit.textContent);

    const heads = [...document.querySelectorAll('h1, h2')].filter((el) => {
      if (el.closest(BAD_ANCESTOR)) return false;
      const t = el.textContent.trim();
      return t.length >= 4 && t.length <= 120;
    });
    if (!heads.length) return '';
    // 标题通常在页面靠前的位置，且不会太短
    heads.sort((a, b) => {
      const pa = a.compareDocumentPosition(b);
      const earlier = pa & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      return b.textContent.trim().length - a.textContent.trim().length || earlier;
    });
    return stripNum(heads[0].textContent);
  }

  function titleFromDocumentTitle() {
    const raw = document.title || '';
    return stripNum(
      raw
        .replace(/\s*[-_|｜]\s*面试鸭.*$/, '')
        .replace(/\s*[-_|｜]\s*MianShiYa.*$/i, '')
        .trim()
    );
  }

  /* ------------------------------ 参考答案 ------------------------------ */

  function cleanClone(el) {
    const clone = el.cloneNode(true);
    for (const sel of NOISE_SELECTORS) {
      clone.querySelectorAll(sel).forEach((n) => n.remove());
    }
    // 去掉「开通会员」这类遮罩层残留
    clone.querySelectorAll('[class*="mask"], [class*="pay"], [class*="vip"]').forEach((n) => {
      if (PAYWALL_PATTERNS.some((p) => n.textContent.includes(p))) n.remove();
    });
    return clone;
  }

  function textOf(el) {
    return (el.innerText || el.textContent || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function findAnswer() {
    for (const sel of ANSWER_BODY_SELECTORS) {
      for (const el of document.querySelectorAll(sel)) {
        const txt = textOf(cleanClone(el));
        if (txt.length >= MIN_ANSWER_LEN) return { text: txt, selector: sel };
      }
    }
    return { text: '', selector: '' };
  }

  /** JSON-LD 里有一段约 230 字的答案摘要（SEO 用），会员墙挡住时仍有参考价值。 */
  function answerTeaser() {
    for (const block of jsonLdBlocks()) {
      const entity = block?.mainEntity || block;
      const text = entity?.acceptedAnswer?.text;
      if (typeof text === 'string' && text.trim().length > 40) return text.trim();
    }
    return '';
  }

  const looksPaywalled = (text) => PAYWALL_PATTERNS.some((p) => text.includes(p));

  /** 整页文本里是否出现了会员墙提示语 */
  function paywallVisible() {
    const main = document.querySelector('main, article, .ant-layout-content') || document.body;
    if (!main) return false;
    return looksPaywalled(main.innerText || '');
  }

  /* -------------------------------- 其它 -------------------------------- */

  function pageId() {
    const m = location.pathname.match(/\/question\/(\d+)/);
    return m ? m[1] : '';
  }

  function tags() {
    const out = new Set();
    for (const a of document.querySelectorAll('a[href^="/tag/"]')) {
      const t = a.textContent.trim();
      if (t && t.length <= 20) out.add(t);
    }
    return [...out].slice(0, 12);
  }

  /**
   * 难度。页面上是 Ant Design 的标签（简单 / 中等 / 困难），
   * 它不是 /tag/ 链接，所以不会被 tags() 混进去。
   */
  function difficulty() {
    for (const el of document.querySelectorAll('.ant-tag, span, div')) {
      const t = (el.textContent || '').trim();
      if (t === '简单' || t === '中等' || t === '困难') {
        // 只认没有子元素的叶子节点，避免把整段包含这两个字的正文也匹配上
        if (!el.children.length) return t;
      }
    }
    return '';
  }

  /** 题号：标题形如「13567. 什么是 AI Agent 中的工具调用？」 */
  function questionNum() {
    const src = [
      document.querySelector('h1')?.textContent || '',
      document.title || '',
      document.querySelector('.question-title')?.textContent || '',
    ];
    for (const t of src) {
      const m = /^\s*(\d{1,7})\s*[.、]\s*\S/.exec(t);
      if (m) return m[1];
    }
    return '';
  }

  /**
   * 所属题库（也就是「分类」）。
   *
   * 只取第一个 /bank/ 链接 —— 题目页下面会挂一长串「相关题库」推荐，
   * 全收进来就变成了二十几个题库都属于这道题。
   */
  function bank() {
    const a = document.querySelector('a[href^="/bank/"]');
    if (!a) return null;
    const href = a.getAttribute('href') || '';
    const m = /\/bank\/(\d+)/.exec(href);
    const name = (a.textContent || '').trim().slice(0, 40);
    if (!name && !m) return null;
    return { id: m ? m[1] : '', name };
  }

  /** 标题如果带着「655. 」这种题号前缀，去掉它 */
  const stripNum = (t) => String(t || '').replace(/^\s*\d{1,7}\s*[.、]\s*/, '').trim();

  const isQuestionPage = () => Boolean(pageId()) || location.pathname.startsWith('/question/');

  /* ------------------------------- 对外接口 ------------------------------- */

  /**
   * 抓取当前页面的题目信息。
   * @returns {{id,url,title,titleSource,tags,answer,answerSource,paywalled,teaser,ok}}
   */
  function current() {
    const id = pageId();
    const url = location.href;

    let title = '';
    let titleSource = '';
    if (isQuestionPage()) {
      title = titleFromJsonLd();
      if (title) titleSource = 'json-ld';
      if (!title) {
        title = titleFromDom();
        if (title) titleSource = 'dom';
      }
    }
    if (!title) {
      title = titleFromDocumentTitle();
      titleSource = title ? 'document-title' : '';
    }

    const found = findAnswer();
    const teaser = answerTeaser();
    const paywalled = paywallVisible() || (!found.text && !!title && isQuestionPage());

    return {
      id,
      url,
      title: title || '',
      titleSource,
      num: questionNum(),
      difficulty: difficulty(),
      bank: bank(),
      tags: tags(),
      answer: found.text,
      answerSelector: found.selector,
      answerSource: found.text ? 'dom' : teaser ? 'teaser' : 'none',
      teaser,
      paywalled,
      isQuestion: isQuestionPage(),
      ok: Boolean(title),
    };
  }

  /**
   * 收集当前页面上指向其它题目的链接。
   * 在标签页、题库页、题目页的「相关题目」里都能用，用来随机抽一道。
   */
  function pageQuestionLinks() {
    const self = pageId();
    const out = new Map();
    for (const a of document.querySelectorAll('a[href*="/question/"]')) {
      const m = (a.getAttribute('href') || '').match(/\/question\/(\d+)/);
      if (!m || m[1] === self) continue;
      const title = (a.textContent || '').trim();
      // 只要看起来像题目标题的，过滤掉「上一题 / 下一题」这种导航
      if (title.length < 6 || title.length > 120) continue;
      out.set(m[1], { id: m[1], title, url: `/question/${m[1]}` });
    }
    return [...out.values()];
  }

  /** 用户手动选中的文字，作为题目/补充材料。 */
  function selection() {
    const s = String(window.getSelection?.() ?? '').trim();
    return s.length >= 2 ? s : '';
  }

  /**
   * 只产出「参考答案」这一段，供模式提示词里的 {reference} 占位符替换。
   * 会员墙挡住时要如实说明，并明确告诉 AI 可以用自己的知识补全。
   */
  function referenceBlock(q, settings) {
    if (settings?.extract?.includeReference === false) return '';
    const limit = settings?.chat?.maxAnswerChars ?? 6000;

    if (q.answer) {
      return `【本站参考答案（供你参考，可能有删减）】\n${NS.truncate(q.answer, limit)}`;
    }
    if (q.teaser) {
      return (
        `【本站答案摘要（完整答案被会员墙挡住，只有这点摘要）】\n${NS.truncate(q.teaser, 800)}\n\n` +
        '注意：完整答案用户没有权限查看，请基于你自己的知识完整作答，不要受这段摘要限制。'
      );
    }
    if (q.paywalled) {
      return '注意：本题答案被会员墙挡住，用户没有权限查看，请基于你自己的知识完整作答。';
    }
    return '';
  }

  /**
   * 渲染成给 AI 的上下文块（自由对话模式用）。
   */
  function toPromptBlock(q, settings) {
    const lines = [`【题目】${q.title || '（未识别到题目，请让用户补充）'}`];
    if (q.bank?.name) lines.push(`【所属题库】${q.bank.name}`);
    if (q.tags?.length) lines.push(`【标签】${q.tags.join('、')}`);
    if (q.difficulty) lines.push(`【难度】${q.difficulty}`);
    if (q.url) lines.push(`【来源】${q.url}`);

    const ref = referenceBlock(q, settings);
    if (ref) lines.push('', ref);
    return lines.join('\n');
  }

  /**
   * 监听 Next.js 的客户端路由切换。
   * 内容脚本跑在隔离世界里，改写 history.pushState 是改不到页面自己那份的，
   * 所以走「popstate + 轮询 href + 观察 <title>」三条路。
   */
  function onNavigate(cb) {
    let last = location.href;
    const fire = () => {
      if (location.href === last) return;
      last = location.href;
      cb(location.href);
    };
    window.addEventListener('popstate', fire);
    const timer = setInterval(fire, 500);

    let titleTimer;
    const titleEl = document.querySelector('title');
    const mo = titleEl ? new MutationObserver(() => {
      clearTimeout(titleTimer);
      titleTimer = setTimeout(fire, 150);
    }) : null;
    mo?.observe(titleEl, { childList: true, characterData: true, subtree: true });

    return () => {
      window.removeEventListener('popstate', fire);
      clearInterval(timer);
      clearTimeout(titleTimer);
      mo?.disconnect();
    };
  }

  NS.extract = {
    current,
    selection,
    questionNum,
    difficulty,
    bank,
    pageQuestionLinks,
    toPromptBlock,
    referenceBlock,
    onNavigate,
    isQuestionPage,
    pageId,
  };
})();
