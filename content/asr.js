/**
 * 语音输入。两种引擎，在设置页切换：
 *
 * 1. builtin —— 浏览器内置 Web Speech API。零配置、零成本、立刻出字。
 *    Chrome 走 Google 后端（国内通常连不上），Edge 走微软 Azure（国内可直连）。
 *
 * 2. cloud —— 整段录下来再发给语音转写接口（whisper / SenseVoice 之类）。
 *    准确率更高、自带标点、长句更稳，代价是要配一个 ASR 服务。
 *
 * 两个引擎的「说完自动停」是两套机制：云端有真实音频，可以做音量检测；
 * 内置识别拿不到音频流，只能盯着「多久没有新的识别结果」，用浏览器自己的
 * 断句结果当信号。以前这段逻辑只做在云端，内置识别点了就永远不停 ——
 * 界面还写着「说完会自动停」，属于实打实的坑。
 */
(function () {
  const NS = globalThis.MSY;

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const builtinSupported = Boolean(SR);

  // 内置识别至少要留这么久，否则说话中间的正常停顿会被当成说完了
  const BUILTIN_MIN_SILENCE = 1500;
  const BUILTIN_NO_SPEECH_MS = 20000; // 一直没听到声音就别干等
  const BUILTIN_MAX_MS = 120000; // 单次最长录制

  function builtinErrorText(code) {
    switch (code) {
      case 'not-allowed':
      case 'service-not-allowed':
        return '麦克风或语音识别服务没有授权。请检查浏览器地址栏左侧的权限图标，允许本站使用麦克风。';
      case 'network':
        return (
          '连不上浏览器的语音识别服务。国内 Chrome 的内置识别走 Google 服务器，通常连不上。\n' +
          '两个办法：① 换 Edge 浏览器（走微软服务器，国内可直连）；② 在设置里把语音引擎改成「云端转写」。'
        );
      case 'audio-capture':
        return '没有找到可用的麦克风设备。';
      case 'no-speech':
        return ''; // 不是错误，onend 会处理
      case 'aborted':
        return '';
      default:
        return `语音识别出错：${code || '未知错误'}`;
    }
  }

  /* ============================ 内置识别 ============================ */

  function createBuiltin(hooks, cfg) {
    if (!builtinSupported) {
      return {
        engine: 'builtin',
        supported: false,
        hint: '当前浏览器不支持内置识别',
        start() {
          hooks.onError(
            '这个浏览器不支持内置语音识别。请换 Chrome 或 Edge，或在设置里改用「云端转写」。'
          );
        },
        stop() {},
        cancel() {},
        isActive: () => false,
      };
    }

    let rec = null;
    let active = false;
    let stopping = false;
    let finalText = '';
    let interimText = '';
    let errorStreak = 0;
    let gotAnyResult = false;

    let idleTimer = 0;
    let noSpeechTimer = 0;
    let maxTimer = 0;

    const autoStop = cfg.autoStop !== false;
    const silenceMs = Math.max(BUILTIN_MIN_SILENCE, cfg.silenceMs || 0);

    function clearTimers() {
      clearTimeout(idleTimer);
      clearTimeout(noSpeechTimer);
      clearTimeout(maxTimer);
      idleTimer = noSpeechTimer = maxTimer = 0;
    }

    /**
     * 说完了吗？
     *
     * 内置识别拿不到音频流，做不了音量检测，但 result 事件本身就是很好的信号：
     * 在说话时它持续地来，停下来就不再来了。所以「多久没有新结果」等价于
     * 「停顿了多久」—— 用它来触发自动收尾。
     */
    function scheduleIdle() {
      clearTimeout(idleTimer);
      if (!active || !autoStop) return;
      idleTimer = setTimeout(() => {
        if (active && finalText.trim()) finish();
      }, silenceMs);
    }

    function build() {
      const r = new SR();
      r.lang = 'zh-CN';
      r.continuous = true;
      r.interimResults = true;
      r.maxAlternatives = 1;

      r.onstart = () => {
        errorStreak = 0;
        if (active) hooks.onState('recording');
      };

      r.onresult = (e) => {
        gotAnyResult = true;
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const res = e.results[i];
          const txt = res[0]?.transcript ?? '';
          if (res.isFinal) finalText += txt;
          else interim += txt;
        }
        interimText = interim;
        hooks.onPartial(finalText + interim);
        scheduleIdle(); // 有新结果就重新计时
      };

      r.onerror = (e) => {
        const code = e?.error || '';
        if (code === 'aborted' || code === 'no-speech') return; // 我们自己停的 / 正常现象

        errorStreak++;
        // network / not-allowed 这类重试没意义，直接报给用户
        if (code === 'network' || code === 'not-allowed' || code === 'service-not-allowed' || errorStreak >= 3) {
          active = false;
          stopping = true;
          clearTimers();
          const text = builtinErrorText(code);
          if (text) hooks.onError(text);
          hooks.onState('idle');
        }
      };

      r.onend = () => {
        if (active && !stopping) {
          // 浏览器自己会在静音一段时间后结束会话，这里无缝续上，
          // 否则用户会遇到「说着说着突然不识别了」
          setTimeout(() => {
            if (!active || stopping) return;
            try {
              r.start();
            } catch {
              // 续不上就把已经听到的内容交出去，别让状态卡在「录音中」
              active = false;
              clearTimers();
              finish();
            }
          }, 120);
        } else if (!stopping) {
          hooks.onState('idle');
        }
      };

      return r;
    }

    /** 收尾：把拿到的文字交出去。stop() 和自动断句都走这里 */
    function finish() {
      if (!active && stopping) return;
      active = false;
      stopping = true;
      clearTimers();
      try {
        rec?.stop();
      } catch {
        /* 忽略 */
      }
      hooks.onState('idle');
      const text = (finalText + interimText).trim();
      finalText = '';
      interimText = '';
      if (text) hooks.onFinal(text);
    }

    return {
      engine: 'builtin',
      supported: true,
      hint: `说完停顿约 ${(silenceMs / 1000).toFixed(1)} 秒自动结束`,

      start() {
        if (active) return;
        finalText = '';
        interimText = '';
        gotAnyResult = false;
        errorStreak = 0;
        stopping = false;
        active = true;
        rec = build();
        try {
          rec.start();
          hooks.onState('recording');
        } catch (e) {
          active = false;
          hooks.onError(`启动语音识别失败：${e?.message || e}`);
          hooks.onState('idle');
          return;
        }

        clearTimers();
        // 一直没出声就别傻等
        noSpeechTimer = setTimeout(() => {
          if (active && !gotAnyResult) {
            active = false;
            stopping = true;
            clearTimers();
            try {
              rec?.abort();
            } catch {
              /* 忽略 */
            }
            hooks.onState('idle');
            hooks.onError('没有听到说话声，麦克风可能没选对，或者离得太远。');
          }
        }, BUILTIN_NO_SPEECH_MS);

        // 保险丝
        maxTimer = setTimeout(() => {
          if (active) finish();
        }, BUILTIN_MAX_MS);
      },

      stop: finish,
      finish,

      cancel() {
        active = false;
        stopping = true;
        finalText = '';
        interimText = '';
        clearTimers();
        try {
          rec?.abort();
        } catch {
          /* 忽略 */
        }
        hooks.onState('idle');
      },

      isActive: () => active,
    };
  }

  /* ============================ 云端转写 ============================ */

  function createCloud(hooks, cfg) {
    let active = false;

    const onMessage = (msg) => {
      if (!msg || !active) return;
      if (msg.type === 'asr.level') hooks.onLevel(msg.level ?? 0);
      else if (msg.type === 'asr.barge') hooks.onBarge?.();
      else if (msg.type === 'asr.transcript') {
        active = false;
        hooks.onState('idle');
        hooks.onLevel(0);
        if (msg.text) hooks.onFinal(msg.text);
      } else if (msg.type === 'asr.error') {
        active = false;
        hooks.onState('idle');
        hooks.onLevel(0);
        hooks.onError(msg.error || '语音识别失败');
      }
    };

    chrome.runtime.onMessage.addListener(onMessage);

    const send = (type, extra = {}) =>
      chrome.runtime.sendMessage({ target: 'background', type, ...extra }).catch((e) => {
        active = false;
        hooks.onState('idle');
        hooks.onError(`语音服务没响应：${e?.message || e}`);
      });

    return {
      engine: 'cloud',
      supported: true,
      hint: `说完停顿约 ${((cfg.silenceMs || 1200) / 1000).toFixed(1)} 秒自动结束`,

      start(opts = {}) {
        if (active) return;
        active = true;
        hooks.onState('recording');
        send('asr.start', { barge: opts.barge !== false, voiceMode: Boolean(opts.voiceMode) });
      },

      stop() {
        if (!active) return;
        hooks.onState('busy'); // 正在转写
        send('asr.stop');
      },

      cancel() {
        active = false;
        hooks.onLevel(0);
        hooks.onState('idle');
        send('asr.cancel');
      },

      isActive: () => active,

      destroy() {
        chrome.runtime.onMessage.removeListener(onMessage);
      },
    };
  }

  /**
   * 按设置创建语音控制器。切换引擎时重新 create 即可。
   * hooks: { onPartial, onFinal, onState, onError, onLevel }
   */
  function create(settings, hooks) {
    const asr = settings?.asr || {};
    const full = {
      onBarge: hooks.onBarge,
      onPartial: hooks.onPartial || (() => {}),
      onFinal: hooks.onFinal || (() => {}),
      onState: hooks.onState || (() => {}),
      onError: hooks.onError || (() => {}),
      onLevel: hooks.onLevel || (() => {}),
    };
    const cfg = {
      silenceMs: asr.silenceMs,
      autoStop: asr.autoStop !== false,
    };
    return asr.engine === 'cloud' ? createCloud(full, cfg) : createBuiltin(full, cfg);
  }

  NS.asr = { create, builtinSupported, builtinErrorText };
})();
