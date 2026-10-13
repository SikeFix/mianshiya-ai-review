/**
 * 全局默认配置、服务商预设、模式提示词。
 * 这份文件被四个上下文共用：content script（manifest 注入）、background（import）、
 * options 页、popup 页（script 标签）。所以只挂到 globalThis，不用模块语法。
 */
globalThis.MSY = globalThis.MSY || {};

/* ------------------------------------------------------------------ *
 * AI 对话服务商预设
 * 全部走 OpenAI 兼容的 /chat/completions，因此只需要 baseUrl + model。
 * ------------------------------------------------------------------ */
MSY.PROVIDER_PRESETS = [
  {
    id: 'deepseek',
    label: 'DeepSeek 深度求索',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    keyUrl: 'https://platform.deepseek.com/api_keys',
    note: '中文强、价格便宜，充 10 块钱能用很久。新用户一般有额度。',
  },
  {
    id: 'siliconflow',
    label: '硅基流动 SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'deepseek-ai/DeepSeek-V3',
    models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen3-32B', 'zai-org/GLM-4.5'],
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    note: '有免费额度。同一个 Key 还能用来做语音转写（SenseVoice），最省事。',
  },
  {
    id: 'dashscope',
    label: '阿里云百炼（通义千问）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    models: ['qwen-plus', 'qwen-max', 'qwen-turbo'],
    keyUrl: 'https://bailian.console.aliyun.com/',
    note: '新用户有免费 token 额度。',
  },
  {
    id: 'moonshot',
    label: '月之暗面 Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'kimi-latest',
    models: ['kimi-latest', 'kimi-k2-0905-preview'],
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    note: '长上下文见长。',
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-plus',
    models: ['glm-4-plus', 'glm-4-air', 'glm-4-flash'],
    keyUrl: 'https://bigmodel.cn/usercenter/apikeys',
    note: 'glm-4-flash 有免费版本。',
  },
  {
    id: 'ark',
    label: '火山方舟（豆包）',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-pro-32k',
    models: ['doubao-pro-32k', 'doubao-lite-32k'],
    keyUrl: 'https://console.volcengine.com/ark',
    note: '模型名要填「接入点 ID」（形如 ep-xxxxxxxx）或模型名。',
  },
  {
    id: 'hunyuan',
    label: '腾讯混元',
    baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    model: 'hunyuan-turbos-latest',
    models: ['hunyuan-turbos-latest', 'hunyuan-lite'],
    keyUrl: 'https://console.cloud.tencent.com/hunyuan/api-key',
    note: '',
  },
  {
    id: 'qianfan',
    label: '百度千帆（文心一言）',
    baseUrl: 'https://qianfan.baidubce.com/v2',
    model: 'ernie-4.0-turbo-8k',
    models: ['ernie-4.0-turbo-8k', 'ernie-speed-128k'],
    keyUrl: 'https://console.bce.baidu.com/iam/#/iam/apikey/list',
    note: '',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'],
    keyUrl: 'https://platform.openai.com/api-keys',
    note: '国内需要代理才能访问。',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter（聚合）',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'deepseek/deepseek-chat',
    models: ['deepseek/deepseek-chat', 'anthropic/claude-3.5-sonnet', 'google/gemini-flash-1.5'],
    keyUrl: 'https://openrouter.ai/keys',
    note: '一个 Key 用多家模型，国内需要代理。',
  },
  {
    id: 'ollama',
    label: 'Ollama（本地）',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5:7b',
    models: ['qwen2.5:7b', 'qwen2.5:14b', 'llama3.1:8b'],
    keyUrl: '',
    note: '完全免费离线。需先 `ollama pull qwen2.5:7b`，装完模型约 4-5GB。',
    noKey: true,
  },
  {
    id: 'lmstudio',
    label: 'LM Studio（本地）',
    baseUrl: 'http://localhost:1234/v1',
    model: 'local-model',
    models: [],
    keyUrl: '',
    note: '在 LM Studio 里启动 Local Server 后可用。',
    noKey: true,
  },
  {
    id: 'ssnh',
    label: 'SSNH 中转（Qwen3-27B）',
    baseUrl: 'https://www.ssnh.top/v1',
    // 注意大小写：这个中转站对模型名是大小写敏感的，
    // 写成 qwen3.8-27B 会返回 404 model_not_found
    model: 'qwen3.8-27b',
    models: ['qwen3.8-27b'],
    keyUrl: '',
    note:
      '你自己配的中转站。这个模型默认会先「想」一大段再回答，既慢又费 token，' +
      '所以预设里已经帮你关掉思考链（chat_template_kwargs.enable_thinking=false）。' +
      '想让它深度思考，就把下面「自定义请求参数」清空。\n' +
      '注意模型名大小写敏感，要用小写的 qwen3.8-27b。',
    extraBody: { chat_template_kwargs: { enable_thinking: false } },
  },
  {
    id: 'custom',
    label: '自定义 / 中转站',
    baseUrl: '',
    model: '',
    models: [],
    keyUrl: '',
    note: '填任何 OpenAI 兼容接口的地址，末尾通常要带 /v1。',
  },
];

/* ------------------------------------------------------------------ *
 * 语音转写（ASR）预设，同样是 OpenAI 兼容的 /audio/transcriptions
 * ------------------------------------------------------------------ */
MSY.ASR_PRESETS = [
  {
    id: 'siliconflow',
    label: '硅基流动 SenseVoice',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'FunAudioLLM/SenseVoiceSmall',
    note: '中文识别效果好，自带标点，价格便宜（约 ¥0.014/分钟）。推荐。',
  },
  {
    id: 'groq',
    label: 'Groq Whisper',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'whisper-large-v3-turbo',
    note: '速度极快，有免费额度，国内需代理。',
  },
  {
    id: 'openai',
    label: 'OpenAI Whisper',
    baseUrl: 'https://api.openai.com/v1',
    model: 'whisper-1',
    note: '国内需代理。',
  },
  {
    id: 'local',
    label: '本地 faster-whisper / whisper.cpp',
    baseUrl: 'http://localhost:8000/v1',
    model: 'whisper-1',
    note: '完全离线免费。任何提供 OpenAI 兼容 /v1/audio/transcriptions 的本地服务都行。',
  },
  {
    id: 'custom',
    label: '自定义',
    baseUrl: '',
    model: '',
    note: '',
  },
];

/* ------------------------------------------------------------------ *
 * 图标
 *
 * 用内联 SVG 而不是 emoji：emoji 在不同系统上字体不同、大小不一，
 * 在 Windows/Edge 上还会渲染成单色小方块，和界面风格对不上。
 * 统一用 currentColor 描边，跟着文字颜色走。
 * ------------------------------------------------------------------ */
const svg = (paths, extra = '') =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ` +
  `stroke-linecap="round" stroke-linejoin="round" ${extra}>${paths}</svg>`;

MSY.ICONS = {
  /* 复习模式 */
  memorize: svg('<path d="M13 2 4.2 13.2H10l-1 8.8 8.8-11.2H12l1-8.8Z"/>'),
  interview: svg(
    '<rect x="9" y="2" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/>' +
      '<path d="M12 18v4M8.5 22h7"/>'
  ),
  explain: svg(
    '<path d="M3 4.5h6.5A3.5 3.5 0 0 1 13 8v12a2.6 2.6 0 0 0-2.6-2.6H3z"/>' +
      '<path d="M21 4.5h-6.5A3.5 3.5 0 0 0 11 8v12a2.6 2.6 0 0 1 2.6-2.6H21z"/>'
  ),
  followup: svg('<circle cx="11" cy="11" r="7"/><path d="M16.3 16.3 21 21"/><path d="M11 8v6M8 11h6"/>'),
  quiz: svg('<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M8 12.5l2.6 2.6L16 9.7"/>'),
  chat: svg('<path d="M20.5 14.5a2.5 2.5 0 0 1-2.5 2.5H8l-4.5 4V6A2.5 2.5 0 0 1 6 3.5h12A2.5 2.5 0 0 1 20.5 6z"/>'),

  /* 界面 */
  settings: svg(
    '<circle cx="12" cy="12" r="3.2"/>' +
      '<path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3' +
      'M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1"/>'
  ),
  minimize: svg('<path d="M5 12h14"/>'),
  close: svg('<path d="M6 6 18 18M18 6 6 18"/>'),
  refresh: svg('<path d="M20.5 12a8.5 8.5 0 1 1-2.4-5.9"/><path d="M20.5 4v5h-5"/>'),
  send: svg('<path d="M21.5 2.5 10.8 13.2"/><path d="M21.5 2.5 14.7 21.5l-3.9-8.3-8.3-3.9z"/>'),
  logo: svg(
    '<path d="M11 3.5 12.9 9l5.6 1.9-5.6 1.9L11 18.4l-1.9-5.6L3.5 10.9 9.1 9z"/>' +
      '<path d="M18.5 14.5l.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9z"/>'
  ),
  down: svg('<path d="M12 5v14"/><path d="M6 13l6 6 6-6"/>'),
  stop: svg('<rect x="6.5" y="6.5" width="11" height="11" rx="2.5"/>'),
  copy: svg('<rect x="9" y="9" width="12" height="12" rx="2.5"/><path d="M5 15.5V5.5A2.5 2.5 0 0 1 7.5 3h10"/>'),
  save: svg('<path d="M12 3v12"/><path d="M7.5 10.5 12 15l4.5-4.5"/><path d="M4 16v2.5A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5V16"/>'),
  trash: svg('<path d="M4 6.5h16"/><path d="M9.5 6.5V4.8A1.8 1.8 0 0 1 11.3 3h1.4a1.8 1.8 0 0 1 1.8 1.8v1.7"/><path d="M6.5 6.5 7.4 19a2 2 0 0 0 2 1.9h5.2a2 2 0 0 0 2-1.9l.9-12.5"/>'),
  speak: svg('<path d="M11 5 6.5 9H3v6h3.5L11 19z"/><path d="M15 9a4.5 4.5 0 0 1 0 6"/><path d="M18 6.5a8.5 8.5 0 0 1 0 11"/>'),
  check: svg('<path d="M4.5 12.5 9.5 17.5 19.5 6.5"/>', 'stroke-width="2.4"'),
  teach: svg('<path d="M12 3 3 7.5 12 12l9-4.5z"/><path d="M6.5 10.2V15c0 1.7 2.5 3 5.5 3s5.5-1.3 5.5-3v-4.8"/>'),
  alert: svg('<path d="M12 3.5 22 20H2z"/><path d="M12 10v4M12 17.2v.1"/>'),
  question: svg('<circle cx="12" cy="12" r="9.5"/><path d="M9.2 9.3a2.9 2.9 0 0 1 5.7.9c0 2-2.9 2.4-2.9 4"/><path d="M12 17.4v.1"/>'),
  empty: svg('<path d="M12 3 3 8v8l9 5 9-5V8z"/><path d="M3 8l9 5 9-5M12 13v8"/>'),
};

/* ------------------------------------------------------------------ *
 * 复习模式。prompt 里的占位符在 content/main.js 里替换：
 *   {title} {reference} {tags} {url}
 *
 * icon 字段是 MSY.ICONS 里的键名，面板和设置页都据此渲染 SVG。
 * ------------------------------------------------------------------ */
MSY.MODES = [
  {
    id: 'interview',
    label: '模拟面试',
    icon: 'interview',
    hint: '它当面试官提问，你开口答，答完给你打分并追问',
  },
  {
    id: 'memorize',
    label: '速记',
    icon: 'memorize',
    hint: '用最短的话讲明白，配一个记得住的类比，30 秒记下这题',
  },
  {
    id: 'feynman',
    label: '费曼',
    icon: 'teach',
    hint: '它只提问不替你讲，一步步逼你自己把知识点讲出来',
  },
  { id: 'explain', label: '讲解', icon: 'explain', hint: '把这题讲透，列出面试得分点' },
  { id: 'followup', label: '追问', icon: 'followup', hint: '像面试官一样层层追问，逼出盲区' },
  { id: 'quiz', label: '自测', icon: 'quiz', hint: '出题考你，选择题可以直接点选项' },
  { id: 'chat', label: '自由对话', icon: 'chat', hint: '把当前题当上下文的普通聊天' },
];

/* 所有模式共用的格式要求，拼在系统提示词最后。
   面试刷题场景里 ASCII 写法比 LaTeX 更实用：公式照样看得懂，还不会被渲染问题坑到。 */
MSY.FORMAT_RULES = `【输出格式】
- 数学公式请用纯文本或代码块写，例如 y = W_0 x + BA、ΔW = B·A，不要用 LaTeX（$...$、\\frac、\\times 这类）。
- 代码一律用 Markdown 代码块，并标上语言。`;

MSY.DEFAULT_PROMPTS = {
  memorize: `你是一位擅长把技术知识压缩成「一句话」的老师。学生没时间看长文，要在最短时间内记住这道题，而且要记得牢。

当前题目：{title}
{reference}

严格按下面五个标题输出。不要开场白，不要总结，不要任何多余的话：

**一句话**
不超过 30 字，是能在面试里直接说出口的定义。不要用「是指」「是一种」这种废话开头。

**记住它**
给一个具体、有画面感的类比或口诀，让人一看就能想起来。禁止抽象表述。
反例：它提高了系统的可用性。
正例：锁就像厕所门上的红绿牌 —— 进去先挂牌，出来摘牌。
能编成顺口的口诀就优先用口诀。

**关键词**
三个词，用 \`、\` 分隔，每个不超过 5 个字。这是回忆时的抓手。

**最容易错**
这道题最多人答错或漏掉的那一个点，一句话说清。

**面试就说这句**
一段可以直接背下来的标准回答，不超过 60 字，口语化。

全部用中文 Markdown，全文控制在 250 字以内。宁可少写，也不要写长。`,

  feynman: `你现在用费曼学习法带学生复习这道题：让他自己一步一步把知识点讲出来，你只负责引导和挑错。

当前题目：{title}
{reference}

规则（严格遵守）：
1. 先把这道题拆成 3-5 个必须讲到的知识点，作为一份「讲解清单」列出来，每条不超过 15 字。
2. 然后从第一个知识点开始，只问一个问题，让学生用自己的话讲一遍。
3. 学生讲完，你只做两件事：
   - 判断：讲对了 / 漏了什么 / 哪里讲错了（尽量短）
   - 如果讲得含糊，明确指出是哪个词含糊，让他换个说法再讲一遍
4. 讲清楚了才进入下一个知识点。每轮回复不超过 200 字。
5. 全部讲完后，给一句总评，并指出最薄弱的那一个知识点。
6. 最后单独一行写上「🎉 讲解完成」，不要写别的字。界面靠这一行判断讲完了。

最重要的一条：不要替学生讲。你的任务是逼他自己讲出来。
他讲不出来时，给一个引导性的问题，而不是直接给答案。
只有他反复讲不对，才允许给出一句话的提示。

现在开始，先列出讲解清单，再问第一个问题。`,

  interview: `你是一位资深的技术面试官，正在对候选人进行模拟面试。

当前题目：{title}
{reference}

规则：
1. 由你提出问题（可以基于题目原文稍作改写，像真人面试官那样口语化地发问）。一次只问一个问题。
2. 候选人回答后，给出简短点评，格式固定为：
   **评分**：x/10
   **答对的点**：…
   **漏掉或答错的地方**：…
   **更好的答法**：…（一两句点出关键即可）
3. 点评完紧接着提出下一道追问，继续面试，不要等候选人说"继续"。
4. 追问要层层深入：概念 → 原理 → 实践 → 踩坑 → 场景设计。
5. 语气专业但不刻薄。每次回复控制在 300 字以内，不要长篇大论。
6. 如果候选人完全跑题或说"不会"，就直接给出要点讲解，再换个角度问一道。

现在开始，先问第一道题。`,

  explain: `你是一位擅长把复杂技术讲明白的老师，学生正在复习这道面试题。

当前题目：{title}
{reference}

要求：
1. 先用一句话给出核心结论 —— 面试时能脱口而出的那一句。
2. 再分层次展开：为什么这么设计 / 底层原理 / 关键细节。
3. 列出面试官最想听到的 3-5 个得分点。
4. 单独指出常见误区或容易答错的地方。
5. 涉及代码时给出简短可运行的示例。
6. 用 Markdown 组织，中文回答。

不要写"好的，我来讲解"这类客套话，直接开始。`,

  followup: `你是一位面试官，正在就下面这道题对学生进行追问。

当前题目：{title}

要求：
1. 一次只问一个问题，从浅到深，逐步逼近原理和边界情况。
2. 学生回答后，先判断对错并补上正确答案的关键点（两三句话），再问下一个。
3. 追问方向参考：为什么不用别的方案 / 底层怎么实现的 / 生产环境有什么坑 / 规模扩大十倍怎么办 / 和相似的 X 有什么区别。
4. 中文，简洁，每次回复不超过 250 字。

现在问第一个追问。`,

  quiz: `你是一位出题老师，请基于下面这道面试题出题考学生。

当前题目：{title}
{reference}

要求：
1. 总共出 3 道题，混合题型：选择题（4 个选项）、判断题、填空或简答。
2. 一次只出一题，等学生回答后再出下一题。
3. 学生每答一题，立刻判定对错、给出正确答案和一句话解释，然后再出下一题。
4. 三题出完后给总评：掌握程度（很好 / 一般 / 需要复习）+ 需要重点补的知识点。
5. 中文，用 Markdown。

出选择题时必须严格遵守格式，界面要靠它把选项渲染成可点的按钮：
- 四个选项各占一行；
- 每行以「字母 + 英文句点 + 空格」开头，也就是 \`A. \` \`B. \` \`C. \` \`D. \`；
- 选项文字里不要再出现别的字母加点号的写法。

判断题请直接问「这题对不对」，不要给选项。

现在出第一题。`,

  chat: `你是一位技术学习助手，正在帮助学生复习面试题。

当前题目：{title}
{reference}

用中文回答，简洁、准确、口语化。涉及代码时用 Markdown 代码块。不确定的地方要说不确定，不要编造。`,
};

/* ------------------------------------------------------------------ *
 * 默认配置
 * ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ *
 * 面试官人设
 *
 * 加在系统提示词最前面。同一个模型换个语气，复习的体感完全不一样 ——
 * 严厉的会把你追问到答不上来，温和的会先肯定你再补漏。
 * ------------------------------------------------------------------ */
MSY.PERSONAS = [
  {
    id: 'strict',
    icon: 'alert',
    label: '严厉大厂面试官',
    desc: '答得含糊会当场打断，追问到底，不允许「大概」「应该」',
    prompt:
      '你是一位以严苛出名的大厂面试官。候选人答得含糊时你会当场打断，要求他说明确，' +
      '不接受「大概」「应该」「差不多」这类词。你会一直往下追问，直到确认他是真的懂，' +
      '而不是背下来的。语气克制但不留情面。',
  },
  {
    id: 'warm',
    icon: 'check',
    label: '温和面试官',
    desc: '先肯定答对的地方，再引导你补上遗漏',
    prompt:
      '你是一位温和的面试官。候选人答对的地方你会明确肯定，然后再补充遗漏；' +
      '答错也不打击，而是给一点提示引导他自己想起来。你的目标是让他敢说、愿意说。',
  },
  {
    id: 'architect',
    icon: 'settings',
    label: '较真的架构师',
    desc: '只关心边界、规模和线上踩过的坑',
    prompt:
      '你是一位特别较真的架构师。你不关心背书式的定义，只关心边界情况、极端规模和生产事故：' +
      '「流量放大一百倍会怎样」「机器挂了一半怎么办」「这个参数线上真能这么配吗」。' +
      '你喜欢用具体场景把人问住。',
  },
  { id: 'random', icon: 'refresh', label: '换个随机的', desc: '每道题随机换一种风格', prompt: '' },
];

MSY.DEFAULT_SETTINGS = {
  version: 1,
  enabled: true,

  ui: {
    collapsed: false,
    position: null,
    theme: 'auto',
    width: 400,
    height: 640,
  },

  profiles: [
    {
      id: 'deepseek',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: '',
      model: 'deepseek-chat',
      temperature: 0.6,
      maxTokens: 2048,
      // 额外透传给服务商的请求体字段，比如关闭思考链、指定 top_p。
      // 在设置页以 JSON 形式编辑，留空就完全不发。
      extraBody: {},
    },
  ],
  activeProfileId: 'deepseek',

  // 面试官人设，只在「模拟面试」和「追问」模式下生效
  persona: 'warm',
  // 限定模拟面试的范围：只在学过的这些板块里出题
  interviewScope: { labels: [], useWeak: true },

  chat: {
    stream: true,
    historyTurns: 10,
    maxAnswerChars: 6000,
    sendWithEnter: true,
  },

  mode: 'interview',
  modePrompts: { ...MSY.DEFAULT_PROMPTS },

  // 本地笔记：题目、答案、AI 复习记录存成 Markdown。
  // 文件落在浏览器下载目录下的 folder 子文件夹里。
  save: {
    auto: false,
    folder: '面试鸭笔记',
    includeChat: true,
    // flat 平铺 | bank 按题库分文件夹 | tag 按第一个标签分文件夹
    folderBy: 'flat',
  },

  tts: {
    autoSpeak: false,
    voiceURI: '',
    rate: 1.0,
    pitch: 1.0,
  },

  asr: {
    engine: 'builtin',
    silenceMs: 1200,
    autoStop: true, // 说完停顿自动结束；关掉就必须手动点停
    autoSend: false,
    // 语音对话模式：AI 念完自动开始听你说话，说完自动发送、自动念新回复，循环下去
    voiceMode: false,
    // 你开口时把朗读掐掉（只对云端引擎有效，内置识别拿不到音频流）
    bargeIn: true,
    cloud: {
      baseUrl: 'https://api.siliconflow.cn/v1',
      apiKey: '',
      model: 'FunAudioLLM/SenseVoiceSmall',
      language: 'zh',
      reuseChatKey: true,
    },
  },

  extract: {
    autoRefreshOnNav: true,
    includeReference: true,
  },
};

/* 服务商 id -> 预设，O(1) 查询 */
MSY.presetById = (id) => MSY.PROVIDER_PRESETS.find((p) => p.id === id) || null;
MSY.asrPresetById = (id) => MSY.ASR_PRESETS.find((p) => p.id === id) || null;
MSY.modeById = (id) => MSY.MODES.find((m) => m.id === id) || MSY.MODES[0];

/**
 * 生成短 id。
 * 放在这里而不是 content/util.js —— 设置页也要用（新增/复制方案），
 * 而设置页只加载 shared 下的文件，不加载 content 下的内容脚本。
 */
MSY.uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
