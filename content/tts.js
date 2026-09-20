/**
 * 语音播报。用浏览器内置的 speechSynthesis，不花钱、可离线。
 *
 * 关键点是「按句流式朗读」：AI 回复还在一个字一个字往外蹦的时候，
 * 一旦凑够一个完整句子就先读出来，不用等整段生成完 —— 这样才像对话。
 */
(function () {
  const NS = globalThis.MSY;

  const synth = window.speechSynthesis;
  const supported = Boolean(synth) && typeof SpeechSynthesisUtterance !== 'undefined';

  const config = { voiceURI: '', rate: 1.0, pitch: 1.0 };

  /* 中文发音人偏好：名字里带这些的优先。macOS 是 Tingting，Windows 是 Xiaoxiao/Huihui。 */
  const PREFERRED = ['xiaoxiao', 'xiaoyi', 'yunxi', 'tingting', 'ting-ting', 'meijia', 'huihui', 'yaoyao', 'kangkang', 'sinji', 'zh-cn'];

  function scoreVoice(v) {
    const name = `${v.name} ${v.voiceURI}`.toLowerCase();
    if (!/^zh|chinese|cmn/i.test(v.lang || '') && !/chinese|中文/.test(name)) return -1;
    let s = 1;
    if (/^zh[-_]cn/i.test(v.lang)) s += 3;
    if (v.localService) s += 1; // 本地合成的更稳、延迟低
    for (let i = 0; i < PREFERRED.length; i++) {
      if (name.includes(PREFERRED[i])) {
        s += 10 - i;
        break;
      }
    }
    return s;
  }

  let voiceCache = [];
  let voicesReady = null;

  function loadVoices() {
    if (!supported) return Promise.resolve([]);
    const now = synth.getVoices();
    if (now.length) {
      voiceCache = now;
      return Promise.resolve(now);
    }
    if (!voicesReady) {
      voicesReady = new Promise((resolve) => {
        const done = () => {
          voiceCache = synth.getVoices();
          if (voiceCache.length) {
            synth.removeEventListener('voiceschanged', done);
            resolve(voiceCache);
          }
        };
        synth.addEventListener('voiceschanged', done);
        // 有些环境不触发事件，兜个底
        setTimeout(() => resolve(synth.getVoices()), 1500);
      });
    }
    return voicesReady;
  }

  function pickVoice() {
    const list = voiceCache.length ? voiceCache : synth?.getVoices?.() || [];
    if (!list.length) return null;
    if (config.voiceURI) {
      const exact = list.find((v) => v.voiceURI === config.voiceURI);
      if (exact) return exact;
    }
    const scored = list.map((v) => ({ v, s: scoreVoice(v) })).filter((x) => x.s > 0);
    scored.sort((a, b) => b.s - a.s);
    return scored[0]?.v || null;
  }

  function zhVoices() {
    const list = voiceCache.length ? voiceCache : synth?.getVoices?.() || [];
    return list.filter((v) => scoreVoice(v) > 0).map((v) => ({ uri: v.voiceURI, name: v.name, lang: v.lang }));
  }

  /* ---------------- 队列 ---------------- */
  let queue = [];
  let speaking = false;
  let streamBuf = '';
  let generation = 0; // 用来作废「朗读到一半被取消」的残留回调

  function pump() {
    if (!supported || speaking) return;
    const next = queue.shift();
    if (next === undefined) return;

    const text = clean(next);
    if (!text) return pump();

    const u = new SpeechSynthesisUtterance(text);
    const v = pickVoice();
    if (v) {
      u.voice = v;
      u.lang = v.lang;
    } else {
      u.lang = 'zh-CN';
    }
    u.rate = config.rate;
    u.pitch = config.pitch;

    const myGen = generation;
    u.onend = () => {
      speaking = false;
      if (myGen === generation) pump();
    };
    u.onerror = (e) => {
      // interrupted / canceled 是我们自己取消导致的，不用报
      if (e?.error && !/interrupted|canceled/i.test(e.error)) {
        console.warn('[MSY] 朗读失败', e.error);
      }
      speaking = false;
      if (myGen === generation) pump();
    };

    speaking = true;
    try {
      synth.speak(u);
    } catch (e) {
      speaking = false;
      console.warn('[MSY] speak 抛错', e);
    }
  }

  /** 去掉 Markdown 标记和代码块 —— 没人想听 AI 念 `**` 和缩进。 */
  function clean(text) {
    return String(text ?? '')
      .replace(/```[\s\S]*?```/g, '（代码块）')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/^\s*\d+[.)]\s+/gm, '')
      .replace(/^\s*>\s?/gm, '')
      .replace(/\|/g, ' ')
      .replace(/^\s*[-:|\s]{4,}$/gm, '')
      .replace(/\*\*([^*]*)\*\*/g, '$1')
      .replace(/\*([^*]*)\*/g, '$1')
      .replace(/~~([^~]*)~~/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /* ---------------- 对外接口 ---------------- */

  /** 直接朗读一整段（点击某条消息的「朗读」）。 */
  function speak(text) {
    if (!supported) return;
    stop();
    queue = [String(text ?? '')];
    pump();
  }

  /**
   * 流式喂入增量文本。凑够一个完整句子就立刻入队朗读。
   * 句末标点包括中英文句号、问号、叹号、分号，以及换行。
   */
  function push(chunk) {
    if (!supported) return;
    streamBuf += chunk;
    // 代码块内容不念，直接吞掉
    streamBuf = streamBuf.replace(/```[\s\S]*?(```|$)/g, (m) => (m.endsWith('```') ? '（代码块）' : ''));

    // 中文句子可以很短（「明白了吗？」只有 5 个字），阈值定太高会让短句一直
    // 卡在缓冲里不念，所以放到 4 个字，宁可多切几次也别让朗读迟迟不出声。
    const re = /[^。！？!?；;\n]{4,}[。！？!?；;\n]/g;
    let m;
    let last = 0;
    while ((m = re.exec(streamBuf))) {
      const sentence = streamBuf.slice(last, m.index + m[0].length);
      last = m.index + m[0].length;
      const t = clean(sentence);
      if (t.length >= 4) queue.push(t);
    }
    if (last > 0) streamBuf = streamBuf.slice(last);
    // 缓冲太长还没断句就先读一截，避免一直不出声
    if (streamBuf.length > 90) {
      const cut = streamBuf.lastIndexOf('，');
      if (cut > 20) {
        queue.push(clean(streamBuf.slice(0, cut + 1)));
        streamBuf = streamBuf.slice(cut + 1);
      }
    }
    pump();
  }

  /** 流结束时把余下的短句读完。 */
  function flushStream() {
    if (!supported) return;
    const t = clean(streamBuf);
    streamBuf = '';
    if (t.length >= 1) queue.push(t);
    pump();
  }

  function stop() {
    if (!supported) return;
    generation++;
    queue = [];
    streamBuf = '';
    speaking = false;
    try {
      synth.cancel();
    } catch {
      /* 忽略 */
    }
  }

  const isSpeaking = () => supported && (speaking || queue.length > 0);

  /**
   * 念完了叫我。语音对话模式要在朗读结束后自动开始听，
   * 而 speechSynthesis 没有「队列排空」事件，只能轮询。
   * 返回取消函数。
   */
  function whenDone(cb, { timeout = 180000 } = {}) {
    if (!supported) {
      cb();
      return () => {};
    }
    const started = Date.now();
    let quiet = 0;
    const timer = setInterval(() => {
      if (Date.now() - started > timeout) {
        clearInterval(timer);
        cb();
        return;
      }
      if (isSpeaking()) {
        quiet = 0;
        return;
      }
      // 连续两次都是空的才认定念完了 —— 排队和播放之间有一瞬间的空档
      quiet += 1;
      if (quiet >= 2) {
        clearInterval(timer);
        cb();
      }
    }, 250);
    return () => clearInterval(timer);
  }

  function setConfig(cfg) {
    if (!cfg) return;
    if (typeof cfg.voiceURI === 'string') config.voiceURI = cfg.voiceURI;
    if (typeof cfg.rate === 'number') config.rate = Math.max(0.5, Math.min(2, cfg.rate));
    if (typeof cfg.pitch === 'number') config.pitch = Math.max(0, Math.min(2, cfg.pitch));
  }

  loadVoices();

  NS.tts = { supported, setConfig, speak, push, flushStream, stop, isSpeaking, whenDone, voices: zhVoices, loadVoices };
})();
