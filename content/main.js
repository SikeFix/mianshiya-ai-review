/**
 * 编排层：把抽取、会话、语音、UI 串起来。
 *
 * 会话按「题目 + 模式」分别保存，所以在同一道题上切模式不会丢上下文，
 * 切到新题目时旧题的对话也还留着（同一个标签页生命周期内）。
 */
(function () {
  const NS = globalThis.MSY;
  if (!NS?.ui || !NS?.extract) return;

  const { log, warn, uid } = NS;

  const state = {
    settings: null,
    ui: null,
    question: null,
    convs: new Map(), // `${qid}::${mode}` -> [{role, content}]
    port: null,
    pending: null, // {id, handle, abortBtn}
    asr: null,
    asrBase: '',
    asrTakeover: false, // 录音中用户是否自己编辑过输入框
    personaPick: null,  // 「随机人设」在这道题上抽中的那个
    scopeBrief: '',     // 面试范围拼出来的提示词块
    hydrated: new Set(), // 已经从本地记录里回填过对话的题目
    lastScore: null,     // 最近一次从 AI 回复里解析出的自评分
    ttsWaitCancel: null, // 等朗读结束时挂的取消函数
    mounted: false,
    unlistenNav: null,
  };

  /** 复习的记录单位是「一道题」，不是「一道题+一个模式」 */
  const questionKey = () => state.question?.id || state.question?.url || 'page';
  const convKey = () => `${questionKey()}::${state.settings.mode}`;

  function conv() {
    const k = convKey();
    if (!state.convs.has(k)) state.convs.set(k, []);
    return state.convs.get(k);
  }

  /* ============================ 提示词 ============================ */

  /**
   * 面试官人设。只在面试/追问模式下生效 —— 讲题时换语气没意义。
   * 选了「随机」就在这道题上定死一个人设，不然每轮都换会让对话很跳。
   */
  function personaPrompt(mode) {
    const id = state.settings.persona;
    if (!id) return '';
    if (mode !== 'interview' && mode !== 'followup') return '';

    if (id === 'random') {
      const key = convKey();
      if (state.personaPick?.key !== key) {
        const pool = NS.PERSONAS.filter((p) => p.id !== 'random');
        state.personaPick = { key, prompt: pool[Math.floor(Math.random() * pool.length)].prompt };
      }
      return state.personaPick.prompt;
    }
    return NS.PERSONAS.find((p) => p.id === id)?.prompt || '';
  }

  function buildSystemPrompt(mode) {
    const s = state.settings;
    const tpl = s.modePrompts?.[mode] || NS.DEFAULT_PROMPTS[mode] || '';
    const q = state.question || {};
    const ref = NS.extract.referenceBlock(q, s);
    const body = tpl.replaceAll('{title}', q.title || '（未识别到题目）').replaceAll('{reference}', ref).trim();
    const persona = personaPrompt(mode);
    // 设了面试范围就只考范围内的题（只对面试/追问生效，讲题时不该受限）
    const scope =
      mode === 'interview' || mode === 'followup' ? state.scopeBrief || '' : '';
    const head = [persona, scope, NS.FORMAT_RULES].filter(Boolean).join('\n\n');
    return head ? `${head}\n\n${body}` : body;
  }

  /** 组装这次要发给模型的消息：系统提示词 + 最近若干轮历史 + 本次输入 */
  function buildMessages(userText) {
    const s = state.settings;
    const keep = Math.max(1, s.chat.historyTurns || 10) * 2;
    const history = conv().slice(-keep);
    return [
      { role: 'system', content: buildSystemPrompt(s.mode) },
      ...history,
      { role: 'user', content: userText },
    ];
  }

  /* ============================ 语音对话模式 ============================ */

  const voiceOn = () => Boolean(state.settings.asr.voiceMode);

  /**
   * 「听 → 答 → 念 → 再听」的自动循环是否生效。
   *
   * 由面板底部那个「语音对话」按钮直接控制，默认关闭 ——
   * 模拟面试和费曼最常用到，讲解/速记这类看着它讲的时候开着只会碍事，
   * 所以交给你自己按场景开关，而不是我猜。
   */
  const loopActive = () => voiceOn();

  /** 开始听用户说话 */
  function listenForAnswer() {
    if (state.pending || state.asr?.isActive()) return;
    state.asrTakeover = false;
    state.asrBase = state.ui.getInput().trim();
    if (state.asrBase) state.asrBase += ' ';
    state.asr.start({ voiceMode: true, barge: true });
  }

  /**
   * 一轮 AI 回复之后：把麦克风接回来，形成「它问 → 我答 → 它点评 → 再问」的循环。
   *
   * 云端引擎能一边念一边听 —— 有音频流就能做音量检测，用户一开口就把朗读掐掉；
   * 内置识别拿不到音频流，只能等念完再开始听，否则会把朗读声当成人声录进去。
   */
  function afterReply() {
    if (!loopActive() || !state.mounted) return;

    if (!state.settings.tts.autoSpeak) {
      listenForAnswer();
      return;
    }
    // 系统里没有中文发音人时朗读根本不会发生，等它就等于卡死循环
    const canSpeak = NS.tts.supported && NS.tts.voices().length > 0;
    const canBarge = state.settings.asr.engine === 'cloud' && state.settings.asr.bargeIn !== false;
    if (canBarge || !canSpeak) {
      listenForAnswer();
      return;
    }
    state.ttsWaitCancel?.();
    state.ttsWaitCancel = NS.tts.whenDone(() => {
      state.ttsWaitCancel = null;
      if (voiceOn()) listenForAnswer();
    });
  }

  /** 关掉语音对话模式时，把还在跑的朗读和录音都收干净 */
  function stopVoiceLoop() {
    state.ttsWaitCancel?.();
    state.ttsWaitCancel = null;
    NS.tts.stop();
    if (state.asr?.isActive()) state.asr.cancel();
  }

  /* ============================ 复习进度 ============================ */

  /** 汇总一遍本地记录，拿到进度、到期数、掌握分布 */
  async function loadStats() {
    try {
      return NS.srs.stats(await NS.notes.list());
    } catch (e) {
      warn('读取复习记录失败', e);
      return null;
    }
  }

  async function refreshDueBadge() {
    const stats = await loadStats();
    if (stats) state.ui?.setDueCount(stats.due);
    return stats;
  }

  /** 统一走这里渲染空状态，顺便把进度和复习入口带上去 */
  async function showEmptyState() {
    if (!state.ui || state.pending) return;
    const stats = await loadStats();
    state.ui.setDueCount(stats?.due || 0);
    state.ui.showEmpty({
      ...(state.question || {}),
      progress: { ...(stats || {}), persona: state.settings.persona },
      review: { due: stats?.due || 0, total: stats?.total || 0 },
    });
  }

  /* ============================ 对话 ============================ */

  function ensurePort() {
    if (state.port) return state.port;
    const port = chrome.runtime.connect({ name: 'msy-chat' });
    port.onMessage.addListener(onPortMessage);
    port.onDisconnect.addListener(() => {
      state.port = null;
      // 后台被回收会导致正在进行的回答断掉，把已收到的部分留下并说明
      if (state.pending) {
        const { handle } = state.pending;
        state.pending = null;
        state.ui.setStreaming(false);
        state.ui.setBusy(false);
        handle.finish();
        state.ui.addSystem('连接中断了，回答可能不完整。');
      }
    });
    state.port = port;
    return port;
  }

  function onPortMessage(msg) {
    const p = state.pending;
    if (!p || msg.id !== p.id) return;

    switch (msg.type) {
      case 'chat.delta':
        p.handle.append(msg.text);
        if (state.settings.tts.autoSpeak) NS.tts.push(msg.text);
        break;

      case 'chat.reasoning':
        p.handle.addThink(msg.text);
        break;

      case 'chat.done': {
        state.pending = null;
        const text = p.handle.finish(msg.text || undefined);
        conv().push({ role: 'assistant', content: text });
        if (state.settings.tts.autoSpeak) NS.tts.flushStream();
        finishStreaming();
        // 每轮答完落一次盘：auto 打开时写文件，否则至少存进本地记录，
        // 这样刷新页面不丢，也能在设置页整体导出
        // 顺手把 AI 给的自评分记下来，导出笔记时能看到模型的判断
        const sc = /评分\D{0,6}(\d{1,2})\s*\/\s*10/.exec(text);
        state.lastScore = sc ? Number(sc[1]) : state.lastScore;

        persistRecord().then(() => {
          refreshDueBadge();
          if (state.settings.save?.auto) saveNote({ silent: true });
        });
        // 费曼模式讲完了：AI 自己在最后一行打了标记，我们据此收尾
        if (state.settings.mode === 'feynman' && /🎉\s*讲解完成/.test(text)) {
          finishFeynman();
          return;
        }

        // 语音对话模式：这一轮念完就自动开始听下一句（只限面试/费曼）
        if (loopActive()) setTimeout(afterReply, 120);
        break;
      }

      case 'chat.aborted':
        state.pending = null;
        NS.tts.stop();
        p.handle.finish();
        if (p.handle.getText()) conv().push({ role: 'assistant', content: p.handle.getText() });
        state.ui.addSystem('已停止生成');
        finishStreaming();
        persistRecord();
        break;

      case 'chat.error':
        state.pending = null;
        NS.tts.stop();
        p.handle.row.remove();
        state.ui.addError(msg.error, () => send(p.retryText));
        finishStreaming();
        break;
    }
  }

  function finishStreaming() {
    state.ui.setStreaming(false);
    state.ui.setBusy(false);
    state.ui.setStatus('');
    state.ui.setClearEnabled(conv().length > 0);
  }

  function send(text, { silent = false } = {}) {
    const content = String(text ?? '').trim();
    if (!content) return;

    const profile = NS.store.activeProfile(state.settings);
    if (!profile?.baseUrl) {
      state.ui.addError('还没有配置 AI 接口。点右上角齿轮，在设置页填一个服务商的 API Key。');
      return;
    }
    if (!profile.apiKey && !NS.presetById(profile.id)?.noKey) {
      state.ui.addError(`「${profile.name}」还没有填 API Key。点右上角齿轮去设置页补上。`);
      return;
    }

    const messages = buildMessages(content);
    conv().push({ role: 'user', content });

    if (!silent) state.ui.addUser(content);

    const handle = state.ui.beginAssistant();
    const id = uid();
    state.pending = { id, handle, retryText: content };

    state.ui.setStreaming(true);
    state.ui.setBusy(true);
    state.ui.setClearEnabled(true);
    state.ui.setStatus(`正在等 ${profile.name || profile.model} 回复…`);

    if (state.settings.tts.autoSpeak) NS.tts.stop();

    ensurePort().postMessage({
      type: 'chat.start',
      id,
      messages,
      profile,
      stream: state.settings.chat.stream !== false,
    });
  }

  function stopStreaming() {
    if (!state.pending) return;
    state.port?.postMessage({ type: 'chat.abort', id: state.pending.id });
  }

  /**
   * 切换模式。已经聊过就把历史渲染回来，没聊过就显示空状态。
   * 只在模式真的变了才写 storage —— 否则会触发 onChange 再绕回来。
   */
  function startMode(mode) {
    if (state.settings.mode !== mode) {
      state.settings.mode = mode;
      NS.store.set({ mode });
    }
    state.ui.setMode(mode);
    // 切模式可能让「语音对话」生效或失效，提示要跟着变
    state.ui.setVoiceMode(loopActive());

    const c = conv();
    if (c.length) renderHistory();
    else showEmptyState();
  }

  function renderHistory() {
    // 正在等 AI 回复时不动 DOM —— 否则会把生成到一半的消息整个抹掉。
    // 典型触发路径：拖一下面板写入了位置 → storage 变化 → 走到这里。
    if (state.pending) return;

    state.ui.clear();
    const c = conv();
    if (!c.length) {
      showEmptyState();
      return;
    }
    for (const m of c) {
      if (m.role === 'user') state.ui.addUser(m.content);
      else if (m.role === 'assistant') state.ui.beginAssistant().finish(m.content);
      else state.ui.addSystem(m.content);
    }
    state.ui.setClearEnabled(true);
  }

  function clearConv() {
    // 生成到一半时清空，会让流式回调往一个已经被抹掉的节点上写，直接拦住
    if (state.pending) {
      state.ui.addSystem('等这轮回答结束再清空。');
      return;
    }
    NS.tts.stop();
    state.convs.delete(convKey());
    state.ui.clear();
    state.ui.setClearEnabled(false);
    showEmptyState();
  }

  function beginConversation() {
    const mode = state.settings.mode;
    const label = NS.modeById(mode).label;
    const c = conv();
    if (c.length) {
      renderHistory(); // 已经有对话就把旧的摆出来，别让界面空着
      return;
    }

    // 空状态卡片（模式说明 + 开始按钮）完成使命了，收掉 ——
    // 以前它会一直留在第一条消息上面，还能被再点一次「开始」
    state.ui.clear();

    // 界面上留一条分隔线，实际发给模型的是一条简短的「开始」指令
    const kick = mode === 'chat' ? '' : '开始';
    if (!kick) {
      state.ui.addSystem('直接提问吧，当前题目已经作为上下文提供给 AI。');
      return;
    }
    state.ui.addSystem(`${label}开始`); // 两侧的分隔线由样式画
    send(kick, { silent: true });
  }

  /* ============================ 题目 ============================ */

  function refreshQuestion({ manual = false } = {}) {
    const q = NS.extract.current();
    const prevKey = state.question ? questionKey() : null;
    state.question = q;
    state.ui.setQuestion(q);

    if (manual) {
      state.ui.setStatus('题目已重新抓取', 'ok');
      clearTimeout(refreshQuestion._t);
      refreshQuestion._t = setTimeout(() => state.ui.setStatus(''), 1400);
    }

    const key = questionKey();
    // key !== prevKey 在首次调用时也成立（prevKey 是 undefined），
    // 这时会把空状态渲染出来 —— 否则用户看到的是一片空白。
    if (key !== prevKey) {
      NS.tts.stop();
      // 先把本地记录里这道题的对话回填进来，再渲染
      hydrate(key).then(() => {
        renderHistory();
        refreshDueBadge();
      });
    }
    return q;
  }

  /* ============================ 语音 ============================ */

  // 程序化写入输入框时置位。setInput / insertAtCursor 会同步派发 input 事件，
  // 靠这个标志区分「我们写的」和「用户自己敲的」。
  let writingInput = false;

  function writeInput(value) {
    writingInput = true;
    try {
      state.ui.setInput(value);
    } finally {
      writingInput = false;
    }
  }

  function insertInput(text) {
    writingInput = true;
    try {
      state.ui.insertAtCursor(text);
    } finally {
      writingInput = false;
    }
  }

  /**
   * 录音过程中用户只要动过输入框，就交出控制权。
   *
   * 不这么做的话：识别结果每个字都在重写输入框，用户删掉的错字下一次
   * 识别事件又原样填回来 —— 表现就是「删了又自动出现」。
   */
  function onUserEditedInput() {
    if (writingInput) return;
    if (state.asr?.isActive()) state.asrTakeover = true;
  }

  function setupAsr() {
    state.asr?.destroy?.();
    state.asr = NS.asr.create(state.settings, {
      // 用户开口了 —— 正在朗读的话立刻闭嘴让位，麦克风继续录
      onBarge: () => {
        if (NS.tts.isSpeaking()) {
          NS.tts.stop();
          state.ui.setStatus('你说，我在听…', 'busy');
        }
      },

      onState: (s) => {
        state.ui.setMicState(s);
        if (s === 'recording') state.ui.setStatus('正在听…（再点一下麦克风可以立刻结束）', 'busy');
        else if (s === 'busy') state.ui.setStatus('正在识别…', 'busy');
        else state.ui.setStatus('');
      },
      onLevel: (v) => state.ui.setLevel(v),

      onPartial: (text) => {
        if (state.asrTakeover) return;
        writeInput(state.asrBase + text);
      },

      onFinal: (text) => {
        if (state.asrTakeover) {
          // 用户中途接管过，就把识别结果插到光标处，别覆盖他编辑的内容
          insertInput(text);
        } else {
          writeInput(state.asrBase + text);
        }
        // 语音对话模式下必须自动发出去，否则这个循环就断了
        if (state.settings.asr.autoSend || voiceOn()) {
          const t = state.ui.getInput();
          state.ui.setInput('');
          send(t);
        }
      },

      onError: (err) => {
        state.ui.setMicState('idle');
        state.ui.setLevel(0);
        state.ui.addError(err);
      },
    });

    // 把「说完会不会自动停、停多久」如实告诉用户，
    // 两种引擎的机制不一样，提示也不能一样
    state.ui.setAsrHint(
      state.settings.asr.autoStop === false ? '' : state.asr?.hint || ''
    );
  }

  function toggleMic() {
    if (!state.asr) return;
    if (state.asr.isActive()) {
      state.asr.stop();
      return;
    }
    if (state.pending) {
      state.ui.addSystem('等 AI 说完再说话。');
      return;
    }
    // 我要说话了，先让朗读闭嘴 —— 不能让它跟我的声音打架
    NS.tts.stop();

    state.asrTakeover = false;
    state.asrBase = state.ui.getInput().trim();
    if (state.asrBase) state.asrBase += ' ';
    state.asr.start();
  }

  /**
   * 费曼讲完的收尾。
   *
   * 关键是把「还在念」和「还在听」都停掉 —— 用户已经讲完了，
   * 麦克风继续开着一来没必要，二来会让人以为还在被监听。
   * 然后给几个明确的下一步，让用户自己挑，而不是自动往下跑。
   */
  function finishFeynman() {
    NS.tts.stop();
    state.ttsWaitCancel?.();
    state.ttsWaitCancel = null;
    if (state.asr?.isActive()) state.asr.cancel();
    state.ui.setStatus('');

    state.ui.showCelebration({
      title: '这题你讲明白了！',
      desc: '上面的总评就是这次的结果。想继续可以再来一遍，或者换个方式巩固。',
      actions: [
        { label: '再讲一遍', run: () => { state.ui.clear(); startMode('memorize'); beginConversation(); } },
        { label: '换自测考考我', run: () => { state.ui.clear(); startMode('quiz'); beginConversation(); } },
        { label: '继续追问', run: () => { state.ui.clear(); startMode('followup'); beginConversation(); } },
        { label: '就到这儿', weak: true, run: () => state.ui.addSystem('这次就到这里，下次继续。') },
      ],
    });
    refreshDueBadge();
  }

  /** 把「面试范围」设置算成提示词块，并在面板上显示出来 */
  async function refreshScope(settings) {
    const labels = settings.interviewScope?.labels || [];
    if (!labels.length) {
      state.scopeBrief = '';
      state.ui?.setScope('');
      return;
    }
    try {
      const list = await NS.notes.list();
      state.scopeBrief = NS.report.scopeBrief(labels, list, {
        useWeak: settings.interviewScope?.useWeak !== false,
      });
      const weak = list.filter((r) => {
        const own = [r.bank?.name, ...(r.tags || []), ...(r.custom || [])].filter(Boolean);
        return own.some((n) => labels.includes(n)) && ['again', 'hard'].includes(r.srs?.lastRating || 'new');
      }).length;
      state.ui?.setScope(`${labels.join('、')}${weak ? ` · 待加强 ${weak} 道` : ''}`);
    } catch (e) {
      warn('读取面试范围失败', e);
      state.scopeBrief = '';
    }
  }

  /* ============================ 本地笔记 ============================ */

  /** 把当前题目 + 各模式的对话打包成一条记录 */
  function recordPatch() {
    const q = state.question || {};
    const key = questionKey();

    const threads = {};
    for (const [k, msgs] of state.convs) {
      if (!msgs.length || !k.startsWith(`${key}::`)) continue;
      threads[k.slice(key.length + 2)] = msgs.slice();
    }

    return {
      questionId: q.id || '',
      url: q.url || location.href,
      title: q.title || '',
      num: q.num || '',
      difficulty: q.difficulty || '',
      bank: q.bank || null,
      tags: q.tags || [],
      answer: q.answer || '',
      answerSource: q.answerSource || 'none',
      // 页面上同时出现了答案和会员墙提示，说明看到的只是节选
      answerTruncated: Boolean(q.answer) && Boolean(q.paywalled),
      paywalled: Boolean(q.paywalled),
      threads,
      ...(typeof state.lastScore === 'number' ? { lastScore: state.lastScore } : {}),
    };
  }

  /** 存进 chrome.storage：刷新页面记录还在，也是间隔复习的数据来源 */
  async function persistRecord() {
    const q = state.question || {};
    if (!q.title && !q.answer) return;
    const patch = recordPatch();
    if (!Object.keys(patch.threads).length) return;
    try {
      await NS.notes.upsert(questionKey(), patch);
    } catch (e) {
      warn('写入复习记录失败', e);
    }
  }

  /** 从本地记录里把这道题之前各模式的对话回填进来 */
  async function hydrate(key) {
    if (state.hydrated.has(key)) return;
    state.hydrated.add(key);
    try {
      const rec = await NS.notes.get(key);
      if (!rec?.threads) return;
      for (const [mode, msgs] of Object.entries(rec.threads)) {
        const ck = `${key}::${mode}`;
        // 本次会话里已经有更新的对话，就别用旧的覆盖
        if (state.convs.has(ck)) continue;
        if (Array.isArray(msgs) && msgs.length) state.convs.set(ck, msgs.slice());
      }
      if (typeof rec.lastScore === 'number') state.lastScore = rec.lastScore;
    } catch (e) {
      warn('读取历史对话失败', e);
    }
  }

  /** 存成 Markdown 文件到本地文件夹 */
  async function saveNote({ silent = false } = {}) {
    const rec = recordPatch();
    if (!Object.keys(rec.threads).length && !rec.answer && !rec.title) {
      state.ui.addSystem('还没有可保存的内容。');
      return;
    }
    await persistRecord();
    let res;
    try {
      res = await chrome.runtime.sendMessage({ target: 'background', type: 'notes.save', record: rec });
    } catch (e) {
      res = { ok: false, error: String(e?.message || e) };
    }
    if (res?.ok) {
      if (!silent) state.ui.setStatus(`已保存到「${res.path}」`, 'ok');
    } else {
      state.ui.addError(`保存失败：${res?.error || '未知错误'}`);
      return;
    }
    clearTimeout(saveNote._t);
    if (!silent) saveNote._t = setTimeout(() => state.ui.setStatus(''), 3000);
  }

  /* ============================ 间隔复习 ============================ */

  const REVIEW_KEY = 'msy_review';

  /**
   * 开一次复习：挑最该复习的那道，跳过去继续。
   *
   * 记录里存的是题目的 URL，所以要跨页面跳转。跳转会把整个页面重载，
   * 意图没法带过去，于是先用 storage 留个标记，落地后由 runPendingReview 接手。
   */
  async function startReview() {
    const list = await NS.notes.list();
    const dueList = NS.srs
      .due(list)
      .filter((r) => r.url)
      .sort((a, b) => (a.srs?.due || 0) - (b.srs?.due || 0));

    const target = dueList[0];
    if (!target) {
      state.ui.addSystem('暂时没有到期的题。');
      return;
    }

    const mode = target.srs?.lapses > 0 ? 'quiz' : 'memorize';
    try {
      await chrome.storage.local.set({ [REVIEW_KEY]: { key: target.key, mode, at: Date.now() } });
    } catch {
      /* 存不下就退化成同页复习 */
    }
    if (target.url === location.href) {
      await runPendingReview();
      return;
    }
    state.ui.setStatus(`去复习：${target.title || target.key}`, 'ok');
    location.assign(target.url);
  }

  /** 页面加载后接手「去复习」的意图 */
  async function runPendingReview() {
    let pending;
    try {
      pending = (await chrome.storage.local.get(REVIEW_KEY))[REVIEW_KEY];
    } catch {
      return;
    }
    // 两分钟之外的就当过期了，免得下次随便打开一页就自动开始
    if (!pending || Date.now() - pending.at > 120000) return;
    if (pending.key !== questionKey()) return;
    await chrome.storage.local.remove(REVIEW_KEY).catch(() => {});

    state.settings.mode = pending.mode;
    state.ui.setMode(pending.mode);
    NS.store.set({ mode: pending.mode });

    state.ui.setStatus('复习模式，直接开始', 'ok');
    setTimeout(() => {
      state.ui.setStatus('');
      // 之前复习过这道题的话，这轮直接把旧对话摆出来；
      // 没有才开一轮新的。以前这里直接调 beginConversation，
      // 而有历史时它会提前返回，界面上就什么都不显示。
      if (conv().length) renderHistory();
      else beginConversation();
    }, 500);
  }

  /** 随机来一道：优先从当前页面的题目里抽，没有就从攒下的笔记里抽 */
  async function randomQuestion() {
    const links = NS.extract.pageQuestionLinks();
    if (links.length) {
      const pick = links[Math.floor(Math.random() * links.length)];
      state.ui.setStatus(`抽到：${pick.title.slice(0, 24)}`, 'ok');
      location.assign(pick.url);
      return;
    }
    const list = (await NS.notes.list()).filter((r) => r.url && r.url !== location.href);
    if (!list.length) {
      state.ui.addSystem('这个页面上没有别的题目，也还没攒下其它笔记。');
      return;
    }
    const pick = list[Math.floor(Math.random() * list.length)];
    state.ui.setStatus(`抽到：${(pick.title || '').slice(0, 24)}`, 'ok');
    location.assign(pick.url);
  }

  /* ============================ 挂载 ============================ */

  function mount() {
    if (state.mounted) return;
    state.ui = NS.ui.create();

    state.ui
      .on('submit', () => {
        if (state.pending) {
          stopStreaming();
          return;
        }
        const t = state.ui.getInput();
        if (!t.trim()) return;
        state.ui.setInput('');
        send(t);
      })
      .on('stop', stopStreaming)
      .on('micToggle', toggleMic)
      .on('quickAnswer', (text) => {
        if (state.pending) return;
        state.ui.setInput('');
        send(text);
      })
      .on('clear', clearConv)
      .on('saveNote', () => saveNote())
      .on('rate', async (rating) => {
        const key = questionKey();
        await persistRecord();
        try {
          const rec = await NS.notes.get(key);
          const next = NS.srs.apply(rec?.srs, rating);
          await NS.notes.setSrs(key, next);
          state.ui.setStatus(`已记录，${NS.srs.dueLabel(next)}再来`, 'ok');
          clearTimeout(state.ui._rateT);
          state.ui._rateT = setTimeout(() => state.ui.setStatus(''), 3200);
          refreshDueBadge();
        } catch (e) {
          state.ui.addError(`记录复习进度失败：${e?.message || e}`);
        }
      })
      .on('review', () => startReview())
      .on('random', () => randomQuestion())
      .on('clearScope', async () => {
        await NS.store.set({ interviewScope: { labels: [], useWeak: true } });
        state.scopeBrief = '';
        state.ui.setScope('');
        state.ui.setStatus('已取消面试范围', 'ok');
        setTimeout(() => state.ui.setStatus(''), 2200);
      })
      .on('toggleVoice', async () => {
        const next = !state.settings.asr.voiceMode;
        state.settings.asr.voiceMode = next;
        state.ui.setVoiceMode(next);
        await NS.store.set({ asr: { voiceMode: next } });
        if (next) {
          state.ui.setStatus('语音对话已开启：它念完就会开始听你说', 'ok');
          setTimeout(() => state.ui.setStatus(''), 3000);
          // 已经从上一轮结束了，那就现在就开始听
          if (!state.pending && !state.asr?.isActive()) afterReply();
        } else {
          stopVoiceLoop();
          state.ui.setStatus('语音对话已关闭', 'ok');
          setTimeout(() => state.ui.setStatus(''), 2200);
        }
      })
      .on('report', () =>
        chrome.runtime
          .sendMessage({ target: 'background', type: 'open.options', hash: 'report' })
          .catch(() => {})
      )
      .on('start', () => beginConversation())
      .on('modeChange', (m) => startMode(m))
      .on('refreshQuestion', () => {
        refreshQuestion({ manual: true });
        showEmptyState();
      })
      .on('personaChange', (id) => {
        state.settings.persona = id;
        state.personaPick = null; // 换人设就让随机重新抽
        NS.store.set({ persona: id });
        showEmptyState();
      })
      .on('openOptions', () =>
        chrome.runtime.sendMessage({ target: 'background', type: 'open.options' }).catch(() => {})
      )
      .on('speak', (text) => {
        NS.tts.setConfig(state.settings.tts);
        NS.tts.speak(text);
      })
      .on('ttsChange', (v) => {
        state.settings.tts.autoSpeak = v;
        NS.store.set({ tts: { autoSpeak: v } });
        if (!v) NS.tts.stop();
      })
      .on('toggleCollapse', (collapsed) => {
        state.ui.setCollapsed(collapsed);
        NS.store.set({ ui: { collapsed } });
      })
      .on('persistPosition', (pos) => NS.store.set({ ui: { position: pos } }))
      .on('persistSize', (size) => NS.store.set({ ui: { width: size.width, height: size.height } }));

    (document.body || document.documentElement).append(state.ui.host);
    state.mounted = true;

    // 用户手动编辑输入框时，把录音的写入权交出去（见 onUserEditedInput）
    state.ui.el.input.addEventListener('input', onUserEditedInput);

    state.unlistenNav = NS.extract.onNavigate(() => {
      if (!state.settings.extract.autoRefreshOnNav) return;
      setTimeout(() => refreshQuestion(), 260);
    });
  }

  function unmount() {
    NS.tts.stop();
    state.asr?.cancel?.();
    state.port?.disconnect();
    state.port = null;
    state.unlistenNav?.();
    state.unlistenNav = null;
    state.ui?.host.remove();
    state.ui = null;
    state.mounted = false;
  }

  /* ============================ 启动 ============================ */

  async function applySettings(settings) {
    const prev = state.settings;
    state.settings = settings;

    if (!settings.enabled) {
      unmount();
      return;
    }
    if (!state.mounted) mount();

    const ui = state.ui;
    ui.applyLayout(settings.ui);
    ui.setTheme(settings.ui.theme);
    ui.setTtsEnabled(settings.tts.autoSpeak);
    ui.setSendWithEnter(settings.chat.sendWithEnter);
    ui.setMode(settings.mode);
    ui.setCollapsed(settings.ui.collapsed);
    ui.setClearEnabled(conv().length > 0);
    NS.tts.setConfig(settings.tts);

    // 方案是否真的可用：本地模型不需要 Key，云端服务必须填
    const profile = NS.store.activeProfile(settings);
    const needsNoKey = Boolean(NS.presetById(profile?.id)?.noKey);
    ui.setProfile(
      profile?.name || '未配置',
      Boolean(profile?.baseUrl && profile?.model && (profile.apiKey || needsNoKey))
    );

    // 语音对话模式的标记要每次都同步（首次加载时 prev 是空的，
    // 放在「变化时」的分支里会导致刚打开页面不显示标记）
    ui.setVoiceMode(loopActive());
    if (prev && (prev.asr.voiceMode !== settings.asr.voiceMode || prev.asr.engine !== settings.asr.engine)) {
      if (prev.asr.voiceMode && !settings.asr.voiceMode) stopVoiceLoop();
    }

    // 语音引擎或断句参数变了都要重建控制器（内置识别把静音时长固化在实例里）
    if (
      !prev ||
      prev.asr.engine !== settings.asr.engine ||
      prev.asr.silenceMs !== settings.asr.silenceMs ||
      prev.asr.autoStop !== settings.asr.autoStop
    ) {
      setupAsr();
    }

    // 提示词被改过，之前的对话上下文就对不上了，清掉重来
    const promptsChanged =
      prev && JSON.stringify(prev.modePrompts) !== JSON.stringify(settings.modePrompts);
    if (promptsChanged) state.convs.clear();

    await refreshScope(settings);

    if (!prev) {
      // 首次启动：抓题，顺带把空状态渲染出来
      ui.setMode(settings.mode);
      refreshQuestion();
    } else if (prev.mode !== settings.mode || promptsChanged) {
      // 模式是在别处（设置页）改的，同步过来
      startMode(settings.mode);
    }
    // 其余情况（拖拽写入位置、切方案等）不需要重绘消息区 ——
    // 每次都重绘会在流式输出到一半时把回答抹掉。
  }

  async function boot() {
    try {
      const settings = await NS.store.get();
      await applySettings(settings);

      NS.store.onChange((next) => {
        applySettings(next).catch((e) => warn('应用配置失败', e));
      });

      // M 键 = 开/关录音。
      // 只在光标不在输入框里时生效 —— 否则用户在任何地方打字都会误触发。
      // 想全局生效（切到别的标签页也行）用 Alt+Shift+V，那个走 chrome.commands。
      document.addEventListener(
        'keydown',
        (e) => {
          if (e.key !== 'm' && e.key !== 'M') return;
          if (e.ctrlKey || e.metaKey || e.altKey) return; // 别抢 Ctrl+M 这类组合
          // 必须用 composedPath 取真实目标：事件穿过 Shadow DOM 边界时
          // e.target 会被重定向成宿主元素，直接看它会以为光标不在输入框里，
          // 结果就是「在输入框里按 M 打不出字」。
          const el = e.composedPath?.()[0] || e.target;
          if (
            el &&
            (el.tagName === 'INPUT' ||
              el.tagName === 'TEXTAREA' ||
              el.tagName === 'SELECT' ||
              el.isContentEditable)
          ) {
            return;
          }
          e.preventDefault();
          toggleMic();
        },
        true
      );

      chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg?.type === 'panel.toggle') {
          if (!state.mounted) return;
          state.ui.setCollapsed(!state.ui.isCollapsed());
          NS.store.set({ ui: { collapsed: state.ui.isCollapsed() } });
        } else if (msg?.type === 'app.random') {
          randomQuestion();
        } else if (msg?.type === 'mic.toggle') {
          toggleMic();
        } else if (msg?.type === 'panel.expand') {
          state.ui?.setCollapsed(false);
          NS.store.set({ ui: { collapsed: false } });
        } else if (msg?.type === 'popup.state') {
          // popup 打开时问一下当前状态，同步返回
          sendResponse({
            mounted: state.mounted,
            collapsed: state.ui ? state.ui.isCollapsed() : true,
            busy: Boolean(state.pending),
            question: state.question
              ? { title: state.question.title, hasAnswer: Boolean(state.question.answer), paywalled: state.question.paywalled }
              : null,
            mode: state.settings?.mode || 'interview',
          });
        }
      });

      log('已就绪。题目：', state.question?.title || '(未识别)');
      // 如果是从上一次的「开始复习」跳过来的，落地后自动开始
      runPendingReview().catch(() => {});
    } catch (e) {
      console.error('[面试鸭AI] 启动失败', e);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
