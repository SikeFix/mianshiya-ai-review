/**
 * 设置页逻辑。
 *
 * 约定：开关类设置改动即存；方案和提示词要点「保存」才落盘，
 * 避免边填边存把半截配置写进去。
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const S = MSY.store;
  const P = MSY.PROVIDER_PRESETS;
  const A = MSY.ASR_PRESETS;

  let settings = null;
  let editingId = null; // 当前正在编辑的方案 id

  /* ------------------------------ 小工具 ------------------------------ */

  let toastTimer;
  function toast(text, kind = '') {
    const el = $('toast');
    el.textContent = text;
    el.className = `show ${kind}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.className = ''), 2600);
  }

  function note(el, text, kind = 'info') {
    el.className = `note ${kind}`;
    el.textContent = text;
  }

  function hideNote(el) {
    el.className = 'note hidden';
    el.textContent = '';
  }

  const profileById = (id) => settings.profiles.find((p) => p.id === id) || null;

  /* ------------------------------ 标签页 ------------------------------ */

  $('tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-tab]');
    if (!btn) return;
    for (const b of $('tabs').children) b.classList.toggle('active', b === btn);
    for (const p of document.querySelectorAll('.panel')) {
      p.classList.toggle('active', p.dataset.panel === btn.dataset.tab);
    }
    if (btn.dataset.tab === 'voice') refreshVoices();
    if (btn.dataset.tab === 'notes') renderNotesList();
    if (btn.dataset.tab === 'report') renderReport();
  });

  /* ============================ AI 方案 ============================ */

  function renderPresetOptions() {
    const sel = $('pPreset');
    sel.innerHTML = '';
    for (const p of P) {
      sel.append(new Option(p.label, p.id));
    }
    sel.append(new Option('（不套用预设，手动填）', ''));
  }

  function fillPresetHint(preset) {
    const hint = $('presetHint');
    hint.textContent = preset?.note || '';
    const keyHint = $('keyHint');
    if (preset?.keyUrl) {
      keyHint.innerHTML = `还没 Key？去 <a href="${preset.keyUrl}" target="_blank" rel="noreferrer">${preset.keyUrl}</a> 免费注册后复制。`;
    } else if (preset?.noKey) {
      keyHint.textContent = '本地服务不需要 Key，留空即可。';
    } else {
      keyHint.textContent = '';
    }
  }

  function renderModelList(preset) {
    const dl = $('modelList');
    dl.innerHTML = '';
    for (const m of preset?.models || []) dl.append(new Option('', m));
  }

  function renderProfileList() {
    const list = $('plist');
    list.innerHTML = '';
    for (const p of settings.profiles) {
      const active = p.id === settings.activeProfileId;
      const item = document.createElement('div');
      item.className = `pitem${p.id === editingId ? ' active' : ''}`;
      item.innerHTML = `
        <span class="dot${active ? ' on' : ''}" title="${active ? '当前正在使用' : ''}"></span>
        <span class="info">
          <span class="nm"></span>
          <span class="md"></span>
        </span>`;
      item.querySelector('.nm').textContent = p.name || '未命名';
      item.querySelector('.md').textContent = `${p.model || '未填模型'}`;
      item.addEventListener('click', () => selectProfile(p.id));
      item.addEventListener('dblclick', () => setActive(p.id));
      list.append(item);
    }
  }

  function selectProfile(id) {
    const p = profileById(id);
    if (!p) return;
    editingId = id;
    $('pName').value = p.name || '';
    $('pBaseUrl').value = p.baseUrl || '';
    $('pApiKey').value = p.apiKey || '';
    $('pModel').value = p.model || '';
    $('pTemp').value = p.temperature ?? 0.6;
    $('pMaxTokens').value = p.maxTokens ?? 2048;
    $('pExtra').value = p.extraBody && Object.keys(p.extraBody).length
      ? JSON.stringify(p.extraBody, null, 2)
      : '';

    // 反查预设：baseUrl 对得上就选它，否则留手动
    const matched = P.find((x) => x.baseUrl && x.baseUrl === S.normalizeBaseUrl(p.baseUrl));
    $('pPreset').value = matched?.id || '';
    fillPresetHint(matched);
    renderModelList(matched);
    renderProfileList();
    hideNote($('testResult'));
  }

  async function setActive(id) {
    settings = await S.set({ activeProfileId: id });
    renderProfileList();
    toast(`已切换到「${profileById(id)?.name}」`, 'ok');
  }

  function readForm() {
    return {
      name: $('pName').value.trim() || '未命名',
      baseUrl: S.normalizeBaseUrl($('pBaseUrl').value),
      apiKey: $('pApiKey').value.trim(),
      model: $('pModel').value.trim(),
      temperature: Number($('pTemp').value) || 0.6,
      maxTokens: Number($('pMaxTokens').value) || 2048,
      extraBody: parseExtra(),
    };
  }

  /** 解析自定义请求参数。留空就是 {}，填错必须当场拦住，不然请求会一直失败。 */
  function parseExtra({ strict = false } = {}) {
    const raw = $('pExtra').value.trim();
    if (!raw) return {};
    try {
      const v = JSON.parse(raw);
      if (v === null || typeof v !== 'object' || Array.isArray(v)) {
        throw new Error('必须是一个 JSON 对象');
      }
      return v;
    } catch (e) {
      const msg = `自定义请求参数不是合法的 JSON：${e.message}`;
      if (strict) note($('testResult'), `✗ ${msg}`, 'err');
      else toast(msg, 'err');
      $('pExtra').focus();
      return null;
    }
  }

  async function saveProfile({ silent = false } = {}) {
    const data = readForm();
    if (data.extraBody === null) return false;
    if (!data.baseUrl) {
      toast('接口地址不能为空', 'err');
      $('pBaseUrl').focus();
      return false;
    }
    if (!data.model) {
      toast('模型名不能为空', 'err');
      $('pModel').focus();
      return false;
    }

    // 申请访问该域名的权限。必须在用户点击的回调里调用，
    // 所以这里放在最前面，不做多余的 await。
    const perm = await S.ensureHostPermission(data.baseUrl);
    if (!perm.ok) {
      note($('testResult'), perm.error, 'err');
      toast('没有获得域名授权', 'err');
      return false;
    }

    settings = await S.set({
      profiles: settings.profiles.map((p) => (p.id === editingId ? { ...p, ...data } : p)),
    });
    renderProfileList();
    if (!silent) toast('已保存', 'ok');
    return true;
  }

  $('pPreset').addEventListener('change', () => {
    const preset = P.find((x) => x.id === $('pPreset').value);
    if (!preset) {
      fillPresetHint(null);
      renderModelList(null);
      return;
    }
    $('pBaseUrl').value = preset.baseUrl;
    $('pModel').value = preset.model;
    $('pExtra').value = preset.extraBody && Object.keys(preset.extraBody).length
      ? JSON.stringify(preset.extraBody, null, 2)
      : '';
    if (!$('pName').value.trim() || P.some((x) => x.label === $('pName').value.trim())) {
      $('pName').value = preset.label;
    }
    fillPresetHint(preset);
    renderModelList(preset);
  });

  $('btnShowKey').addEventListener('click', () => {
    const el = $('pApiKey');
    const show = el.type === 'password';
    el.type = show ? 'text' : 'password';
    $('btnShowKey').textContent = show ? '隐藏' : '显示';
  });

  $('btnSaveProfile').addEventListener('click', () => saveProfile());

  $('btnAddProfile').addEventListener('click', async () => {
    const id = MSY.uid();
    const preset = P[0];
    settings = await S.set({
      profiles: [
        ...settings.profiles,
        {
          id,
          name: '新方案',
          baseUrl: preset.baseUrl,
          apiKey: '',
          model: preset.model,
          temperature: 0.6,
          maxTokens: 2048,
        },
      ],
    });
    selectProfile(id);
    $('pApiKey').focus();
    toast('已新增，填好 Key 后点「保存」');
  });

  $('btnDupProfile').addEventListener('click', async () => {
    const src = profileById(editingId);
    if (!src) return;
    const id = MSY.uid();
    settings = await S.set({
      profiles: [...settings.profiles, { ...src, id, name: `${src.name} 副本` }],
    });
    selectProfile(id);
    toast('已复制一份');
  });

  $('btnDelProfile').addEventListener('click', async () => {
    if (settings.profiles.length <= 1) {
      toast('至少要留一个方案', 'err');
      return;
    }
    const p = profileById(editingId);
    if (!p || !confirm(`确定删除方案「${p.name}」？`)) return;

    const profiles = settings.profiles.filter((x) => x.id !== editingId);
    const activeProfileId =
      settings.activeProfileId === editingId ? profiles[0].id : settings.activeProfileId;
    settings = await S.set({ profiles, activeProfileId });
    selectProfile(profiles[0].id);
    toast('已删除');
  });

  $('btnTestProfile').addEventListener('click', async () => {
    const out = $('testResult');
    const data = readForm();
    if (data.extraBody === null) return;
    if (!data.baseUrl || !data.model) {
      note(out, '先把接口地址和模型名填上。', 'warn');
      return;
    }
    const perm = await S.ensureHostPermission(data.baseUrl);
    if (!perm.ok) {
      note(out, perm.error, 'err');
      return;
    }

    const btn = $('btnTestProfile');
    btn.disabled = true;
    btn.textContent = '测试中…';
    note(out, '正在请求，请稍等…', 'info');

    try {
      const res = await chrome.runtime.sendMessage({
        target: 'background',
        type: 'ai.test',
        profile: { ...data, id: editingId },
      });
      if (res?.ok) {
        note(out, `✓ 连接成功，用了 ${res.ms} 毫秒。模型回应：${res.text || '(空)'}`, 'ok');
      } else {
        note(out, `✗ ${res?.error || '测试失败'}`, 'err');
      }
    } catch (e) {
      note(out, `✗ ${e?.message || e}`, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = '测试连接';
    }
  });

  /* ============================ 语音 ============================ */

  function renderAsrPresets() {
    const sel = $('asrPreset');
    sel.innerHTML = '';
    for (const a of A) sel.append(new Option(a.label, a.id));
  }

  function renderAsrEngine() {
    const engine = settings.asr.engine;
    for (const card of document.querySelectorAll('#asrEngines .radio-card')) {
      card.classList.toggle('sel', card.dataset.engine === engine);
      card.onclick = async () => {
        settings = await S.set({ asr: { engine: card.dataset.engine } });
        renderAsrEngine();
      };
    }
    $('cloudBox').style.display = engine === 'cloud' ? '' : 'none';

    const supported = typeof window.SpeechRecognition !== 'undefined' || typeof window.webkitSpeechRecognition !== 'undefined';
    const noteEl = $('builtinNote');
    if (!supported) {
      note(noteEl, '当前浏览器不支持内置语音识别，请改用「云端转写」。', 'warn');
    } else {
      note(
        noteEl,
        '提示：Chrome 的内置识别走 Google 服务器，国内通常连不上（会提示 network 错误）；' +
          'Edge 走微软服务器，国内可以直连。如果用的是 Chrome，建议选「云端转写」。',
        'info'
      );
    }
  }

  function renderAsrFields() {
    const c = settings.asr.cloud;
    // 这个判断必须在用到它之前声明 —— 放在后面会踩 const 的暂时性死区，
    // 整个 renderAll 会在这里中断，后面的界面全部渲染不出来
    const builtin = settings.asr.engine !== 'cloud';
    $('asrBaseUrl').value = c.baseUrl || '';
    $('asrModel').value = c.model || '';
    $('asrApiKey').value = c.apiKey || '';
    $('asrReuse').checked = Boolean(c.reuseChatKey);
    $('asrKeyField').style.display = c.reuseChatKey ? 'none' : '';
    $('asrSilence').value = settings.asr.silenceMs;
    $('asrAutoStop').checked = settings.asr.autoStop !== false;
    $('asrVoiceMode').checked = Boolean(settings.asr.voiceMode);
    $('asrBarge').checked = settings.asr.bargeIn !== false;
    // 内置识别做不了打断检测，这一项直接置灰说明原因
    $('bargeRow').style.opacity = builtin ? '.5' : '1';
    $('asrBarge').disabled = builtin;
    $('asrAutoSend').checked = Boolean(settings.asr.autoSend);
    $('asrSilence').disabled = settings.asr.autoStop === false;
    $('silenceHint').textContent = builtin
      ? `内置识别至少要 1.5 秒 —— 说话中间的正常停顿不能被当成说完了，所以填小于 1500 也按 1500 走。`
      : `默认 1200 毫秒。说完停顿一下自动收尾，不用手动按停。`;

    const matched = A.find((x) => x.baseUrl && x.baseUrl === S.normalizeBaseUrl(c.baseUrl));
    $('asrPreset').value = matched?.id || '';
    $('asrPresetHint').textContent = matched?.note || '';
  }

  $('asrPreset').addEventListener('change', async () => {
    const preset = A.find((x) => x.id === $('asrPreset').value);
    if (!preset) return;
    $('asrBaseUrl').value = preset.baseUrl;
    $('asrModel').value = preset.model;
    $('asrPresetHint').textContent = preset.note || '';
    settings = await S.set({
      asr: { cloud: { baseUrl: preset.baseUrl, model: preset.model } },
    });
  });

  for (const [id, patch] of [
    ['asrBaseUrl', (v) => ({ asr: { cloud: { baseUrl: S.normalizeBaseUrl(v) } } })],
    ['asrModel', (v) => ({ asr: { cloud: { model: v } } })],
    ['asrApiKey', (v) => ({ asr: { cloud: { apiKey: v } } })],
    ['asrSilence', (v) => ({ asr: { silenceMs: Math.max(400, Math.min(5000, Number(v) || 1200)) } })],
  ]) {
    $(id).addEventListener('change', async () => {
      settings = await S.set(patch($(id).value));
    });
  }

  $('asrReuse').addEventListener('change', async () => {
    settings = await S.set({ asr: { cloud: { reuseChatKey: $('asrReuse').checked } } });
    $('asrKeyField').style.display = $('asrReuse').checked ? 'none' : '';
  });

  $('asrAutoSend').addEventListener('change', async () => {
    settings = await S.set({ asr: { autoSend: $('asrAutoSend').checked } });
  });

  $('asrVoiceMode').addEventListener('change', async () => {
    settings = await S.set({ asr: { voiceMode: $('asrVoiceMode').checked } });
    toast($('asrVoiceMode').checked ? '语音对话模式已开启，回到页面上点麦克风开始' : '已关闭语音对话模式', 'ok');
  });

  $('asrBarge').addEventListener('change', async () => {
    settings = await S.set({ asr: { bargeIn: $('asrBarge').checked } });
  });

  $('asrAutoStop').addEventListener('change', async () => {
    settings = await S.set({ asr: { autoStop: $('asrAutoStop').checked } });
    renderAsrFields();
  });

  $('btnMicAuth').addEventListener('click', async () => {
    const out = $('micResult');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      note(out, '✓ 麦克风已授权。之后在页面上录音不会再弹窗。', 'ok');
    } catch (e) {
      const name = e?.name || '';
      note(
        out,
        name === 'NotAllowedError'
          ? '✗ 你拒绝了麦克风权限。请点地址栏左侧的图标，把麦克风改回「允许」再试一次。'
          : `✗ 授权失败：${e?.message || name}`,
        'err'
      );
    }
  });

  /* ============================ 语音播报 ============================ */

  function refreshVoices() {
    const synth = window.speechSynthesis;
    if (!synth) return;
    const sel = $('ttsVoice');
    const fill = () => {
      const voices = synth.getVoices().filter((v) => /^zh|chinese|cmn/i.test(v.lang || '') || /Chinese|中文/.test(v.name));
      sel.innerHTML = '';
      sel.append(new Option('自动选择（推荐）', ''));
      for (const v of voices) sel.append(new Option(`${v.name}（${v.lang}）`, v.voiceURI));
      sel.value = settings.tts.voiceURI || '';
    };
    fill();
    synth.addEventListener('voiceschanged', fill, { once: true });
  }

  $('ttsVoice').addEventListener('change', async () => {
    settings = await S.set({ tts: { voiceURI: $('ttsVoice').value } });
  });

  $('ttsRate').addEventListener('input', () => {
    $('rateLabel').textContent = `${Number($('ttsRate').value).toFixed(2)}×`;
  });

  $('ttsRate').addEventListener('change', async () => {
    settings = await S.set({ tts: { rate: Number($('ttsRate').value) } });
  });

  $('ttsAuto').addEventListener('change', async () => {
    settings = await S.set({ tts: { autoSpeak: $('ttsAuto').checked } });
  });

  $('btnTtsTest').addEventListener('click', () => {
    const synth = window.speechSynthesis;
    if (!synth) return toast('当前浏览器不支持语音播报', 'err');
    synth.cancel();
    const u = new SpeechSynthesisUtterance('你好，我是你的面试复习助手。这是一段试听。');
    const uri = $('ttsVoice').value;
    const v = uri ? synth.getVoices().find((x) => x.voiceURI === uri) : null;
    if (v) {
      u.voice = v;
      u.lang = v.lang;
    } else {
      u.lang = 'zh-CN';
    }
    u.rate = Number($('ttsRate').value);
    synth.speak(u);
  });

  /* ============================ 对话设置 ============================ */

  const chatBindings = [
    ['chatStream', 'stream', (el) => el.checked],
    ['chatSendEnter', 'sendWithEnter', (el) => el.checked],
    ['chatTurns', 'historyTurns', (el) => Math.max(1, Math.min(50, Number(el.value) || 10))],
    ['chatAnswerChars', 'maxAnswerChars', (el) => Math.max(500, Math.min(20000, Number(el.value) || 6000))],
  ];

  function renderPersona() {
    const sel = $('personaSel');
    sel.innerHTML = '';
    sel.append(new Option('不设人设（保持提示词原样）', ''));
    for (const p of MSY.PERSONAS) sel.append(new Option(`${p.label} —— ${p.desc}`, p.id));
    sel.value = settings.persona || '';
  }

  function renderChat() {
    renderPersona();
    $('chatStream').checked = settings.chat.stream !== false;
    $('chatSendEnter').checked = settings.chat.sendWithEnter !== false;
    $('chatTurns').value = settings.chat.historyTurns;
    $('chatAnswerChars').value = settings.chat.maxAnswerChars;
    $('chatIncludeRef').checked = settings.extract.includeReference !== false;
  }

  for (const [id, key, read] of chatBindings) {
    $(id).addEventListener('change', async () => {
      settings = await S.set({ chat: { [key]: read($(id)) } });
      toast('已保存', 'ok');
    });
  }

  $('personaSel').addEventListener('change', async () => {
    settings = await S.set({ persona: $('personaSel').value });
    toast('已保存', 'ok');
  });

  $('chatIncludeRef').addEventListener('change', async () => {
    settings = await S.set({ extract: { includeReference: $('chatIncludeRef').checked } });
  });

  /* ============================ 提示词 ============================ */

  let promptMode = 'interview';
  let promptDirty = false;

  function renderPromptTabs() {
    const wrap = $('promptTabs');
    wrap.innerHTML = '';
    for (const m of MSY.MODES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.mode = m.id;
      b.className = m.id === promptMode ? 'active' : '';
      // 图标用和面板同一套 SVG，避免 emoji 在不同系统上长得不一样
      b.innerHTML = `<span class="msy-i">${MSY.ICONS[m.icon] || ''}</span><span>${m.label}</span>`;
      b.addEventListener('click', () => {
        if (promptDirty && !confirm('当前提示词还没保存，确定要切换吗？')) return;
        promptMode = m.id;
        promptDirty = false;
        renderPromptTabs();
        $('promptText').value = settings.modePrompts[m.id] || '';
      });
      wrap.append(b);
    }
  }

  $('promptText').addEventListener('input', () => {
    promptDirty = true;
  });

  $('btnSavePrompt').addEventListener('click', async () => {
    const v = $('promptText').value.trim();
    if (!v) return toast('提示词不能为空', 'err');
    settings = await S.set({ modePrompts: { [promptMode]: v } });
    promptDirty = false;
    toast('提示词已保存', 'ok');
  });

  $('btnResetPrompt').addEventListener('click', async () => {
    const def = MSY.DEFAULT_PROMPTS[promptMode];
    if (!confirm(`恢复「${MSY.modeById(promptMode).label}」的默认提示词？`)) return;
    $('promptText').value = def;
    settings = await S.set({ modePrompts: { [promptMode]: def } });
    promptDirty = false;
    toast('已恢复默认', 'ok');
  });

  $('btnResetAllPrompts').addEventListener('click', async () => {
    if (!confirm('全部恢复默认提示词？你自己改过的内容会丢失。')) return;
    settings = await S.set({ modePrompts: { ...MSY.DEFAULT_PROMPTS } });
    $('promptText').value = settings.modePrompts[promptMode];
    promptDirty = false;
    toast('已全部恢复默认', 'ok');
  });

  /* ============================ 本地笔记 ============================ */

  function renderSave() {
    const s = settings.save || {};
    $('saveAuto').checked = Boolean(s.auto);
    $('saveChat').checked = s.includeChat !== false;
    $('saveFolder').value = s.folder || '面试鸭笔记';
    note(
      $('saveWhere'),
      `存到哪里：浏览器下载目录 / ${MSY.notes.safeFolder(s.folder)} / 题目名.md
在页面上点「存笔记」立刻写一次；打开「自动更新」后每轮 AI 回答都会刷新同一份文件。`,
      'info'
    );
  }

  async function renderSrsStats() {
    const list = await MSY.notes.list();
    const st = MSY.srs.stats(list);
    const box = $('srsStats');
    box.innerHTML = '';

    const tile = (n, k, cls = '') =>
      NS_h('div', { class: `srs-stat ${cls}` }, [
        NS_h('div', { class: 'n', text: String(n) }),
        NS_h('div', { class: 'k', text: k }),
      ]);

    const b = st.buckets;
    box.append(
      tile(st.due, '待复习', st.due ? 'due' : ''),
      tile(st.total, '攒下的题'),
      tile(st.streak, '连续天数', st.streak > 1 ? 'ok' : ''),
      tile(b.good + b.easy, '已掌握', 'ok'),
      tile(b.hard, '有点模糊', b.hard ? 'warn' : ''),
      tile(b.again + st.lapses, '忘过的次数', b.again ? 'due' : '')
    );
  }

  const MSY_DEBOUNCE = (fn, ms) => {
    let t;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
  };

  let noteQuery = '';
  let noteStatus = '';
  let openNoteKey = null;

  /** 过滤 + 排序，供列表和计数共用 */
  async function filteredNotes() {
    const list = await MSY.notes.list();
    const q = noteQuery.trim().toLowerCase();
    const now = Date.now();

    return list
      .filter((r) => {
        if (q) {
          const hay = `${r.title || ''} ${(r.tags || []).join(' ')} ${(r.custom || []).join(' ')} ${r.bank?.name || ''} ${r.difficulty || ''} ${r.num || ''}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        if (!noteStatus) return true;
        if (noteStatus === 'due') return !r.srs?.due || r.srs.due <= now;
        const st = r.srs?.lastRating || 'new';
        if (noteStatus === 'good') return st === 'good' || st === 'easy';
        return st === noteStatus;
      })
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  /** 展开一条记录：答案 + 各模式的完整对话 */
  function noteDetail(rec) {
    const box = NS_h('div', { class: 'note-detail' });
    const threads = MSY.notes.threadsOf(rec);
    const modes = Object.keys(threads).filter((m) => threads[m]?.length);

    box.append(NS_h('h4', { text: '本站参考答案' }));
    const ref = NS_h('div', { class: 'ref' });
    ref.textContent = rec.answer
      ? rec.answer
      : rec.paywalled
        ? '（需要会员，插件不绕过会员墙，所以没抓到）'
        : '（页面上没有找到答案）';
    box.append(ref);

    if (!modes.length) {
      box.append(NS_h('h4', { text: '回答记录' }));
      box.append(NS_h('div', { class: 'hint', text: '这道题还没有对话记录。' }));
      return box;
    }

    box.append(NS_h('h4', { text: `回答记录（${modes.length} 个模式）` }));
    const tabs = NS_h('div', { class: 'mode-tabs' });
    const pane = NS_h('div');
    box.append(tabs, pane);

    const renderMode = (mode) => {
      pane.textContent = '';
      for (const m of threads[mode] || []) {
        const turn = NS_h('div', { class: `turn ${m.role === 'user' ? 'me' : ''}` });
        turn.append(NS_h('div', { class: 'who', text: m.role === 'user' ? '我' : m.role === 'assistant' ? 'AI' : '提示' }));
        const pre = NS_h('pre');
        pre.textContent = m.content;
        turn.append(pre);
        pane.append(turn);
      }
    };

    for (const [i, mode] of modes.entries()) {
      const label = mode ? MSY.modeById(mode)?.label || mode : '对话';
      const btn = NS_h('button', { type: 'button', text: `${label}（${threads[mode].length}）` });
      btn.addEventListener('click', () => {
        openNoteKey = rec.key;
        for (const b of tabs.children) b.className = b === btn ? 'on' : '';
        renderMode(mode);
      });
      if (i === 0) btn.className = 'on';
      tabs.append(btn);
    }
    renderMode(modes[0]);
    return box;
  }

  /** 待复习清单：哪几道该复习了，点一下直接打开原题 */
  async function renderDueList() {
    const box = $('dueList');
    if (!box) return;
    box.innerHTML = '';

    const list = await MSY.notes.list();
    const dueList = MSY.srs
      .due(list)
      .filter((r) => r.url)
      .sort((a, b) => (a.srs?.due || 0) - (b.srs?.due || 0));

    if (!dueList.length) {
      box.append(
        NS_h('div', { class: 'nempty', text: '现在没有到期的题。想加练的话，去题目页和 AI 聊几句就行。' })
      );
      return;
    }

    for (const rec of dueList.slice(0, 12)) {
      const state = rec.srs?.lastRating ? MSY.srs.ratingById(rec.srs.lastRating) : null;
      const item = NS_h('div', { class: 'nitem' });
      item.style.cursor = 'pointer';
      const body = NS_h('div', { class: 'nbody' });
      body.append(
        NS_h('div', {
          class: 'nt',
          text: rec.num ? `${rec.num}. ${rec.title || '未命名题目'}` : rec.title || '未命名题目',
        })
      );
      const meta = NS_h('div', { class: 'nmeta' });
      meta.append(
        NS_h('span', {
          class: 'rpt-pill',
          text: state ? state.label : '未自评',
          style: `background:${MSY.report.STATE_COLOR[rec.srs?.lastRating || 'new']}1f;color:${MSY.report.STATE_COLOR[rec.srs?.lastRating || 'new']}`,
        })
      );
      meta.append(NS_h('span', { text: MSY.srs.dueLabel(rec.srs) }));
      if (rec.srs?.lapses) meta.append(NS_h('span', { text: `忘过 ${rec.srs.lapses} 次` }));
      if (rec.bank?.name) meta.append(NS_h('span', { text: rec.bank.name }));
      body.append(meta);
      item.append(body);
      item.addEventListener('click', () => chrome.tabs.create({ url: rec.url }));
      box.append(item);
    }
    if (dueList.length > 12) {
      box.append(NS_h('div', { class: 'nmore', text: `…… 还有 ${dueList.length - 12} 道` }));
    }
  }

  async function renderNotesList() {
    const list = await filteredNotes();
    const all = await MSY.notes.list();

    $('notesCount').textContent = all.length ? `共 ${all.length} 道题` : '';
    $('notesFiltered').textContent =
      list.length === all.length ? '' : `筛出 ${list.length} 道`;
    await renderSrsStats(all);
    await renderDueList();

    const box = $('notesList');
    box.innerHTML = '';
    if (!list.length) {
      box.append(
        NS_h('div', {
          class: 'nempty',
          text: all.length ? '没有匹配的记录，换个关键词试试。' : '还没有记录。到题目页和 AI 聊两句，这里就会出现。',
        })
      );
      return;
    }

    for (const rec of list) {
      const state = rec.srs?.lastRating ? MSY.srs.ratingById(rec.srs.lastRating) : null;
      const threadCount = Object.values(MSY.notes.threadsOf(rec)).reduce((n, t) => n + (t?.length || 0), 0);

      // 左侧色条：一眼看出这题是答错、模糊还是已经掌握
      const weakMark = state ? { again: '1', hard: '2', good: '3', easy: '3' }[state.id] || '0' : '0';
      const item = NS_h('div', { class: 'nitem', dataset: { weak: weakMark } });
      const body = NS_h('div', { class: 'nbody' });
      const titleText = rec.num ? `${rec.num}. ${rec.title || '未命名题目'}` : rec.title || '未命名题目';
      body.append(NS_h('div', { class: 'nt', text: titleText, title: titleText }));

      const meta = NS_h('div', { class: 'nmeta' });
      meta.append(
        NS_h('span', {
          class: 'rpt-pill',
          text: state ? state.label : '未自评',
          style: `background:${MSY.report.STATE_COLOR[rec.srs?.lastRating || 'new']}1f;color:${MSY.report.STATE_COLOR[rec.srs?.lastRating || 'new']}`,
        })
      );
      meta.append(NS_h('span', { text: MSY.srs.dueLabel(rec.srs) }));
      meta.append(NS_h('span', { text: `对话 ${threadCount} 条` }));
      if (rec.difficulty) meta.append(NS_h('span', { text: rec.difficulty }));
      if (rec.bank?.name) meta.append(NS_h('span', { text: rec.bank.name }));
      if (rec.tags?.length) meta.append(NS_h('span', { class: 'ntags', text: rec.tags.join('、') }));
      meta.append(NS_h('span', { class: 'scene', text: MSY.notes.stamp(rec.updatedAt) }));
      body.append(meta);

      if (rec.key === openNoteKey) body.append(noteDetail(rec));

      if (rec.custom?.length) {
        meta.append(NS_h('span', { class: 'ntags', text: `我的分类：${rec.custom.join('、')}` }));
      }

      if (rec.key === openNoteKey) {
        const acts = NS_h('div', { class: 'nacts' });
        const editCat = NS_h('button', { type: 'button', text: '编辑分类' });
        editCat.addEventListener('click', async (e) => {
          e.stopPropagation();
          const cur = (rec.custom || []).join('、');
          const input = prompt('给这道题打分类（用顿号或逗号分隔，留空则清除）：', cur);
          if (input === null) return;
          await MSY.notes.setCustom(rec.key, input.split(/[、,，]/));
          renderNotesList();
          toast('分类已更新', 'ok');
        });
        acts.append(editCat);

        const del = NS_h('button', { class: 'danger', type: 'button', text: '删除这条记录' });
        del.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (!confirm(`删除「${rec.title || '未命名题目'}」的复习记录？（磁盘上的 .md 文件不会动）`)) return;
          await MSY.notes.remove(rec.key);
          openNoteKey = null;
          renderNotesList();
        });
        acts.append(del);
        body.append(acts);
      }

      const chev = NS_h('span', { class: 'chev', text: rec.key === openNoteKey ? '▾' : '▸' });
      item.className = rec.key === openNoteKey ? 'nitem open' : 'nitem';
      item.append(body, chev);
      item.addEventListener('click', () => {
        openNoteKey = openNoteKey === rec.key ? null : rec.key;
        renderNotesList();
      });
      box.append(item);
    }
  }

  /** 建元素的小工具（options 页不加载 content/util.js，这里只需要最简单的） */
  function NS_h(tag, props, children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else el.setAttribute(k, v);
    }
    for (const c of [].concat(children || [])) {
      if (c) el.append(c);
    }
    return el;
  }

  $('saveAuto').addEventListener('change', async () => {
    settings = await S.set({ save: { auto: $('saveAuto').checked } });
    toast($('saveAuto').checked ? '已开启自动更新' : '已关闭自动更新', 'ok');
  });

  $('saveFolderBy').addEventListener('change', async () => {
    settings = await S.set({ save: { folderBy: $('saveFolderBy').value } });
    renderSave();
  });

  $('saveChat').addEventListener('change', async () => {
    settings = await S.set({ save: { includeChat: $('saveChat').checked } });
  });

  $('saveFolder').addEventListener('change', async () => {
    const folder = MSY.notes.safeFolder($('saveFolder').value);
    settings = await S.set({ save: { folder } });
    $('saveFolder').value = folder;
    renderSave();
  });

  $('noteSearch').addEventListener('input', MSY_DEBOUNCE(() => {
    noteQuery = $('noteSearch').value;
    renderNotesList();
  }, 200));

  $('noteFilter').addEventListener('change', () => {
    noteStatus = $('noteFilter').value;
    renderNotesList();
  });

  $('btnExportAll').addEventListener('click', async () => {
    const msg = $('notesMsg');
    const btn = $('btnExportAll');
    btn.disabled = true;
    try {
      const dim = $('exportDim').value;
      const res = await chrome.runtime.sendMessage({ target: 'background', type: 'notes.exportAll', dim });
      if (res?.ok) {
        const where = res.files > 1 ? `${res.files} 个分类文件` : `「${res.path}」`;
        note(msg, `✓ 已导出 ${res.count} 道题，生成 ${where}。`, 'ok');
      } else {
        note(msg, `✗ ${res?.error || '导出失败'}`, 'err');
      }
    } catch (e) {
      note(msg, `✗ ${e?.message || e}`, 'err');
    } finally {
      btn.disabled = false;
    }
  });

  $('btnStartReview').addEventListener('click', async () => {
    const list = await MSY.notes.list();
    const dueList = MSY.srs
      .due(list)
      .filter((r) => r.url)
      .sort((a, b) => (a.srs?.due || 0) - (b.srs?.due || 0));
    if (!dueList.length) {
      toast('现在没有到期的题', 'ok');
      return;
    }
    // 打开最该复习的那道，剩下的回面板里按间隔继续
    chrome.tabs.create({ url: dueList[0].url });
    toast(`已打开：${dueList[0].title || '第一道待复习的题'}`, 'ok');
  });

  $('btnExportDue').addEventListener('click', async () => {
    const msg = $('notesMsg');
    const list = await MSY.notes.list();
    const dueList = MSY.srs.due(list).sort((a, b) => (a.srs?.due || 0) - (b.srs?.due || 0));
    if (!dueList.length) {
      note(msg, '现在没有到期的题。', 'info');
      return;
    }
    const md = [
      `# 待复习清单（${dueList.length} 道）`,
      '',
      `导出时间 ${MSY.notes.stamp()}`,
      '',
      '| # | 题目 | 掌握情况 | 到期 | 链接 |',
      '| --- | --- | --- | --- | --- |',
      ...dueList.map((r, i) => {
        const state = r.srs?.lastRating ? MSY.srs.ratingById(r.srs.lastRating).label : '未自评';
        return `| ${i + 1} | ${r.title || '未命名'} | ${state} | ${MSY.srs.dueLabel(r.srs)} | ${r.url || ''} |`;
      }),
      '',
    ].join('\n');

    const settingsNow = await S.get();
    const folder = MSY.notes.safeFolder(settingsNow.save?.folder);
    try {
      const res = await chrome.runtime.sendMessage({
        target: 'background',
        type: 'notes.saveRaw',
        folder,
        filename: `待复习清单-${new Date().toISOString().slice(0, 10)}`,
        markdown: md,
      });
      if (res?.ok) note(msg, `✓ 已导出 ${dueList.length} 道到「${res.path}」`, 'ok');
      else note(msg, `✗ ${res?.error || '导出失败'}`, 'err');
    } catch (e) {
      note(msg, `✗ ${e?.message || e}`, 'err');
    }
  });

  // 兜底：任何没被 catch 的异步错误都弹出来，别让界面无声地少一块
  window.addEventListener('unhandledrejection', (e) => {
    console.error('[面试鸭AI] 未处理的异步错误', e.reason);
    toast(`出错了：${e.reason?.message || e.reason}`, 'err');
  });

  /** 面试范围的当前状态 + 一键清空 */
  function renderScopeBar() {
    const card = $('scopeCard');
    if (!card) return;
    card.textContent = '';
    const labels = settings.interviewScope?.labels || [];

    card.append(NS_h('h2', { text: '模拟面试范围' }));
    if (!labels.length) {
      card.append(
        NS_h('p', {
          class: 'sub',
          text: '没有限制，AI 会考当前这道题相关的任何方向。想集中突击某一块，就到下面的「薄弱的知识点」里点「针对它出题」。',
        })
      );
      return;
    }
    card.append(
      NS_h('p', {
        class: 'sub',
        text: '开始模拟面试时会只考这些方向，并优先考你还没掌握的题。',
      })
    );
    const chips = NS_h('div', { class: 'scope-chips' });
    for (const name of labels) {
      const chip = NS_h('span', { class: 'scope-chip' });
      chip.append(NS_h('span', { text: name }));
      const x = NS_h('button', { type: 'button', text: '×', title: '移除' });
      x.addEventListener('click', async () => {
        settings = await S.set({
          interviewScope: { labels: labels.filter((n) => n !== name), useWeak: true },
        });
        renderReport();
      });
      chip.append(x);
      chips.append(chip);
    }
    const clear = NS_h('button', { class: 'btn danger', type: 'button', text: '全部取消' });
    clear.addEventListener('click', async () => {
      settings = await S.set({ interviewScope: { labels: [], useWeak: true } });
      renderReport();
    });
    card.append(chips, NS_h('div', { class: 'btn-row' }, [clear]));
  }

  $('btnAiAnalyze').addEventListener('click', async () => {
    const msg = $('aiAnalyzeMsg');
    const out = $('aiReport');
    const btn = $('btnAiAnalyze');
    btn.disabled = true;
    note(msg, '正在让 AI 分析，可能要十几秒…', 'info');
    out.classList.add('hidden');
    try {
      const res = await chrome.runtime.sendMessage({ target: 'background', type: 'ai.analyze' });
      if (res?.ok) {
        msg.className = 'note hidden';
        out.textContent = res.text;
        out.classList.remove('hidden');
      } else {
        note(msg, `✗ ${res?.error || '分析失败'}`, 'err');
      }
    } catch (e) {
      note(msg, `✗ ${e?.message || e}`, 'err');
    } finally {
      btn.disabled = false;
    }
  });

  $('btnExportReport').addEventListener('click', async () => {
    const msg = $('reportMsg');
    const btn = $('btnExportReport');
    btn.disabled = true;
    try {
      const res = await chrome.runtime.sendMessage({ target: 'background', type: 'notes.report' });
      if (res?.ok) {
        note(msg, `✓ 已生成「${res.path}」，双击那个文件就能在浏览器里打开。共 ${res.total} 道题。`, 'ok');
      } else {
        note(msg, `✗ ${res?.error || '生成失败'}`, 'err');
      }
    } catch (e) {
      note(msg, `✗ ${e?.message || e}`, 'err');
    } finally {
      btn.disabled = false;
    }
  });

  $('btnRefreshReport').addEventListener('click', () => {
    renderReport();
    toast('已刷新', 'ok');
  });

  $('btnClearNotes').addEventListener('click', async () => {
    if (!confirm('清空浏览器里保存的复习记录？已经存到磁盘上的 .md 文件不会被删除。')) return;
    await MSY.notes.clear();
    note($('notesMsg'), '已清空本地记录（磁盘上的文件还在）。', 'info');
    renderNotesList();
  });

  /* ============================ 学习报告 ============================ */

  function rptTable(headers, rows) {
    const table = NS_h('table', { class: 'rpt-table' });
    const thead = NS_h('thead');
    const htr = NS_h('tr');
    for (const h of headers) htr.append(NS_h('th', { text: h }));
    thead.append(htr);
    const tbody = NS_h('tbody');
    for (const r of rows) tbody.append(r);
    table.append(thead, tbody);
    return table;
  }

  function rptBar(counts, total) {
    const seg = (n, c) =>
      n
        ? NS_h('span', { style: `width:${(n / total) * 100}%;background:${c}` })
        : null;
    const bar = NS_h('div', { class: 'rpt-bar' });
    bar.append(
      seg(counts.good + counts.easy, MSY.report.STATE_COLOR.good),
      seg(counts.hard, MSY.report.STATE_COLOR.hard),
      seg(counts.again, MSY.report.STATE_COLOR.again),
      seg(counts.new, MSY.report.STATE_COLOR.new)
    );
    return bar;
  }

  async function renderReport() {
    const box = $('reportBody');
    box.innerHTML = '';
    const agg = MSY.report.aggregate(await MSY.notes.list());

    if (!agg.total) {
      box.append(
        NS_h('div', { class: 'card' }, [
          NS_h('div', { class: 'rpt-empty', text: '还没有任何复习记录。去题目页和 AI 聊几句，再回来看这里。' }),
        ])
      );
      return;
    }

    // --- 总览 ---
    const tiles = NS_h('div', { class: 'srs-stats' });
    const tile = (n, k, color) => {
      const el = NS_h('div', { class: 'srs-stat' });
      el.append(NS_h('div', { class: 'n', text: String(n), style: color ? `color:${color}` : '' }));
      el.append(NS_h('div', { class: 'k', text: k }));
      return el;
    };
    const goodCount = agg.questions.filter((q) => q.state === 'good' || q.state === 'easy').length;
    tiles.append(
      tile(agg.todayCount, '今日刷题', agg.todayCount ? MSY.report.STATE_COLOR.good : ''),
      tile(agg.total, '累计刷题'),
      tile(agg.stats.due, '待复习', agg.stats.due ? MSY.report.STATE_COLOR.again : ''),
      tile(`${agg.masteryRate}%`, '掌握率', agg.masteryRate >= 70 ? MSY.report.STATE_COLOR.good : MSY.report.STATE_COLOR.hard),
      tile(agg.stats.streak, '连续天数'),
      tile(agg.stats.lapses, '累计遗忘'),
      tile(agg.points.length, '涉及知识点')
    );
    box.append(NS_h('div', { class: 'card', id: 'scopeCard' }));
    renderScopeBar();

    box.append(
      NS_h('div', { class: 'card' }, [
        NS_h('h2', { text: '总览' }),
        NS_h('p', { class: 'sub', text: '掌握率 = 被评为「记住了 / 太简单」的比例' }),
        tiles,
      ])
    );

    // --- 掌握度分布 ---
    const dist = {
      good: agg.questions.filter((q) => q.state === 'good').length,
      easy: agg.questions.filter((q) => q.state === 'easy').length,
      hard: agg.questions.filter((q) => q.state === 'hard').length,
      again: agg.questions.filter((q) => q.state === 'again').length,
      new: agg.questions.filter((q) => q.state === 'new').length,
    };
    // 最近两周的刷题量
    const maxDaily = Math.max(1, ...agg.daily.map((d) => d.count));
    const chart = NS_h('div', { class: 'rpt-chart' });
    const axis = NS_h('div', { class: 'rpt-axis' });
    for (const d of agg.daily) {
      const col = NS_h('div', { class: 'rpt-col', title: `${d.label}：${d.count} 道` });
      col.append(NS_h('div', { class: 'rpt-cnum', text: d.count ? String(d.count) : '' }));
      col.append(NS_h('div', { class: 'rpt-cbar', style: `height:${Math.round((d.count / maxDaily) * 100)}%` }));
      chart.append(col);
      axis.append(NS_h('span', { text: d.label }));
    }
    box.append(
      NS_h('div', { class: 'card' }, [
        NS_h('h2', { text: '最近两周的刷题量' }),
        NS_h('p', { class: 'sub', text: '柱子上方是当天的题数，最高的一天撑满整格' }),
        chart,
        axis,
      ])
    );

    const distCard = NS_h('div', { class: 'card' }, [
      NS_h('h2', { text: '掌握度分布' }),
      NS_h('p', { class: 'sub', text: '绿=记住了/太简单　橙=有点模糊　红=完全不会　灰=还没自评' }),
      rptBar(dist, agg.total),
      NS_h('p', {
        class: 'sub',
        style: 'margin-top:10px',
        text: `已掌握 ${goodCount} 道 · 模糊 ${dist.hard} 道 · 完全不会 ${dist.again} 道 · 未自评 ${dist.new} 道`,
      }),
    ]);
    box.append(distCard);

    // --- 薄弱知识点 ---
    // 数字为 0 时用弱化样式，别一排 0 还五颜六色
    const numCell = (n, color) => {
      const cls = 'num' + (n ? '' : ' zero');
      return NS_h('td', { class: cls, text: String(n), style: color && n ? `color:${color}` : '' });
    };

    const rows = agg.points.slice(0, 30).map((p) => {
      const tr = NS_h('tr', { class: p.counts.again || p.counts.hard ? 'is-weak' : '' });
      const td1 = NS_h('td');
      td1.append(NS_h('span', { class: 'rpt-kind', text: MSY.report.KIND_LABEL[p.kind] || '标签' }));
      td1.append(document.createTextNode(p.name));
      tr.append(td1);
      tr.append(numCell(p.count));
      tr.append(numCell(p.mastered, MSY.report.STATE_COLOR.good));
      tr.append(numCell(p.counts.hard, MSY.report.STATE_COLOR.hard));
      tr.append(numCell(p.counts.again, MSY.report.STATE_COLOR.again));
      tr.append(numCell(p.lapses));
      tr.append(numCell(p.counts.new));
      const td7 = NS_h('td', { style: 'width:150px' });
      td7.append(rptBar(p.counts, p.count));
      td7.append(NS_h('div', { class: 'w', text: `薄弱分 ${p.weakness}` }));
      tr.append(td7);

      // 一键把这个板块设成模拟面试的范围
      const td8 = NS_h('td', { style: 'width:96px' });
      const btn = NS_h('button', { class: 'btn', type: 'button', text: '针对它出题' });
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const cur = settings.interviewScope?.labels || [];
        const next = cur.includes(p.name) ? cur.filter((x) => x !== p.name) : [...cur, p.name];
        settings = await S.set({ interviewScope: { labels: next, useWeak: true } });
        // 同步勾选状态，让人看得见自己选了哪些
        for (const b of document.querySelectorAll('.scope-pick')) {
          b.classList.toggle('on', next.includes(b.dataset.label));
        }
        toast(
          next.length
            ? `面试范围：${next.join('、')}（回题目页开始模拟面试即可）`
            : '已取消面试范围',
          'ok'
        );
        renderScopeBar();
      });
      btn.dataset.label = p.name;
      btn.classList.add('scope-pick');
      if ((settings.interviewScope?.labels || []).includes(p.name)) btn.classList.add('on');
      td8.append(btn);
      tr.append(td8);
      return tr;
    });
    box.append(
      NS_h('div', { class: 'card' }, [
        NS_h('h2', { text: '薄弱的知识点' }),
        NS_h('p', {
          class: 'sub',
          text: '答错过的排在最前面 —— 排序先看「完全不会 / 有点模糊」的题数，再看加权薄弱分'
            + (agg.unrated > agg.mastered ? `。注意：现在有 ${agg.unrated} 道题还没自评过，先做几道并自评，这张表才准` : ''),
        }),
        rows.length ? rptTable(['知识点', '题数', '已掌握', '模糊', '不会', '忘过', '未自评', '分布', '出题'], rows)
                    : NS_h('div', { class: 'rpt-empty', text: '还没有可统计的知识点。' }),
      ])
    );

    // --- 建议 ---
    const advice = [];
    if (agg.stats.due) advice.push(`有 ${agg.stats.due} 道题到了该复习的时间，先过一遍。`);
    for (const w of agg.weak) {
      advice.push(
        `「${w.name}」偏弱：${w.count} 道题里有 ${w.counts.again} 道选了「完全不会」，累计忘过 ${w.lapses} 次 —— 建议用「速记」模式过一遍。`
      );
    }
    if (!agg.weak.length) advice.push('目前没有明显薄弱的知识点，保持节奏就行。');
    if (agg.strong.length) advice.push(`已经比较稳的是：${agg.strong.map((x) => x.name).join('、')}。`);

    const ol = NS_h('ol', { class: 'rpt-advice' });
    for (const a of advice) ol.append(NS_h('li', { text: a }));
    box.append(NS_h('div', { class: 'card' }, [NS_h('h2', { text: '该怎么做' }), ol]));

    // --- 思维导图（复用报告模块生成的 HTML，details 自带折叠交互） ---
    $('mindMap').innerHTML = MSY.report.mindMapHtml(agg);

    // --- 全部题目 ---
    const qrows = agg.questions.map((q) => {
      const tr = NS_h('tr');
      const td1 = NS_h('td');
      if (q.url) {
        const a = NS_h('a', { href: q.url, target: '_blank', rel: 'noreferrer', text: q.title });
        td1.append(a);
      } else td1.append(document.createTextNode(q.title));
      tr.append(td1);

      const td2 = NS_h('td');
      td2.append(
        NS_h('span', {
          class: 'rpt-pill',
          text: q.label,
          style: `background:${MSY.report.STATE_COLOR[q.state]}1f;color:${MSY.report.STATE_COLOR[q.state]}`,
        })
      );
      tr.append(td2);
      tr.append(NS_h('td', { class: 'num', text: q.lapses ? String(q.lapses) : '' }));
      tr.append(NS_h('td', { class: 'num', text: q.score === null ? '' : `${q.score}/10` }));
      tr.append(NS_h('td', { class: 'dim', text: q.dueLabel }));
      tr.append(NS_h('td', { class: 'dim', text: (q.tags || []).join('、') }));
      return tr;
    });
    box.append(
      NS_h('div', { class: 'card' }, [
        NS_h('h2', { text: '全部题目' }),
        NS_h('p', { class: 'sub', text: '最近复习的排在前面' }),
        rptTable(['题目', '掌握', '忘过', 'AI 评分', '下次复习', '标签'], qrows),
      ])
    );
  }

  /* ============================ 界面 ============================ */

  function renderUi() {
    $('uiTheme').value = settings.ui.theme;
    $('uiWidth').value = settings.ui.width;
    $('uiHeight').value = settings.ui.height;
    $('globalEnabled').checked = Boolean(settings.enabled);
    $('unlockCopy').checked = settings.unlockCopy !== false;
  }

  $('uiTheme').addEventListener('change', async () => {
    settings = await S.set({ ui: { theme: $('uiTheme').value } });
  });

  for (const [id, key] of [['uiWidth', 'width'], ['uiHeight', 'height']]) {
    $(id).addEventListener('change', async () => {
      const v = Math.max(320, Math.min(1200, Number($(id).value) || 400));
      $(id).value = v;
      settings = await S.set({ ui: { [key]: v } });
    });
  }

  $('btnResetLayout').addEventListener('click', async () => {
    settings = await S.set({
      ui: { width: 400, height: 640, position: null, collapsed: false },
    });
    renderUi();
    toast('已恢复默认', 'ok');
  });

  $('globalEnabled').addEventListener('change', async () => {
    settings = await S.set({ enabled: $('globalEnabled').checked });
  });

  $('unlockCopy').addEventListener('change', async () => {
    settings = await S.set({ unlockCopy: $('unlockCopy').checked });
  });

  /* ============================ 导入导出 ============================ */

  $('btnExport').addEventListener('click', () => {
    // 导出时带上 Key，方便换电脑直接导入；但会提示用户注意保管
    const data = JSON.stringify(settings, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `面试鸭AI助手配置-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast('已导出（文件里含 API Key，注意保管）', 'ok');
  });

  $('btnImport').addEventListener('click', () => $('fileImport').click());

  $('fileImport').addEventListener('change', async () => {
    const file = $('fileImport').files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (typeof data !== 'object' || !data) throw new Error('不是合法的配置对象');
      settings = await S.set(data);
      renderAll();
      toast('配置已导入', 'ok');
    } catch (e) {
      toast(`导入失败：${e.message}`, 'err');
    } finally {
      $('fileImport').value = '';
    }
  });

  /* ============================ 初始化 ============================ */

  function renderAll() {
    renderProfileList();
    selectProfile(settings.activeProfileId || settings.profiles[0]?.id);
    renderAsrEngine();
    renderAsrFields();
    renderChat();
    renderSave();
    renderUi();
    renderPromptTabs();
    $('promptText').value = settings.modePrompts[promptMode] || '';
    $('ttsAuto').checked = Boolean(settings.tts.autoSpeak);
    $('ttsRate').value = settings.tts.rate;
    $('rateLabel').textContent = `${Number(settings.tts.rate).toFixed(2)}×`;
    refreshVoices();
  }

  /** 从「学习报告」入口点进来时带 #report，直接切到那一页 */
  function applyHashTab() {
    const want = (location.hash || '').replace('#', '');
    if (!want) return;
    const btn = document.querySelector(`#tabs button[data-tab="${want}"]`);
    if (btn) btn.click();
  }

  async function init() {
    settings = await S.get();
    renderPresetOptions();
    renderAsrPresets();
    renderAll();

    // 选中的方案被外部改动时同步过来
    S.onChange((next) => {
      const activeChanged = next.activeProfileId !== settings.activeProfileId;
      settings = next;
      if (activeChanged) renderProfileList();
    });

    applyHashTab();

    window.addEventListener('beforeunload', (e) => {
      if (promptDirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  }

  init().catch((e) => {
    console.error(e);
    toast(`初始化失败：${e.message}`, 'err');
  });
})();
