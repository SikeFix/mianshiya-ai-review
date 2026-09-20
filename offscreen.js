/**
 * 录音 + 静音自动断句（VAD）。
 *
 * 为什么放在 offscreen 文档里：内容脚本调 getUserMedia 时，权限是绑在
 * 面试鸭这个域名上的，还可能被站点的 Permissions-Policy 拦掉。offscreen
 * 文档是扩展自己的页面，麦克风权限归属扩展，用户在设置页授权一次就够。
 *
 * 静音断句：对着麦克风说话，说完停顿约 1.2 秒自动结束录音 —— 模拟面试时
 * 不用手动按停，体验接近真人对话。
 */

const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
];

function pickMime() {
  for (const m of MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m;
    } catch {
      /* 忽略 */
    }
  }
  return '';
}

let session = null;

const toBackground = (msg) => chrome.runtime.sendMessage({ target: 'background', ...msg });

function cleanup() {
  if (!session) return;
  const s = session;
  session = null;

  clearTimeout(s.maxTimer);
  clearTimeout(s.noSpeechTimer);
  if (s.ctxRef) {
    s.ctxRef.processor.onaudioprocess = null;
    for (const n of [s.ctxRef.source, s.ctxRef.processor, s.ctxRef.mute]) {
      try {
        n.disconnect();
      } catch {
        /* 忽略 */
      }
    }
    s.ctxRef.audioCtx.close().catch(() => {});
  }
  s.stream?.getTracks().forEach((t) => t.stop());
}

function fail(tabId, error) {
  cleanup();
  toBackground({ type: 'asr.failed', tabId, error });
}

/** 把 Blob 转成 base64 —— runtime 消息走 JSON 序列化，二进制传不过去。 */
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
    fr.onerror = () => reject(new Error('读取录音数据失败'));
    fr.readAsDataURL(blob);
  });
}

async function start({ tabId, silenceMs = 1200, autoStop = true, bargeMode = false, noSpeechMs = 20000 }) {
  cleanup();

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
  } catch (e) {
    const name = e?.name || '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return fail(
        tabId,
        '麦克风没有授权。请打开扩展的设置页，点「授权麦克风」并选择允许，之后再回来用云端语音。'
      );
    }
    if (name === 'NotFoundError') return fail(tabId, '没有找到麦克风设备。');
    return fail(tabId, `打开麦克风失败：${e?.message || name}`);
  }

  const mimeType = pickMime();
  let recorder;
  try {
    recorder = new MediaRecorder(stream, {
      ...(mimeType ? { mimeType } : {}),
      audioBitsPerSecond: 32000, // 语音够用了，能把文件压得很小
    });
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop());
    return fail(tabId, `当前浏览器不支持录音：${e?.message || e}`);
  }

  const chunks = [];

  /* ------------------------------------------------------------------ *
   * 音量检测（静音断句 + 界面电平条）
   *
   * 节拍器必须由音频线程驱动，不能用 requestAnimationFrame：
   * offscreen 文档是不渲染的，rAF 根本不会触发 —— 实测就是这个下场，
   * VAD 从头到尾一次都没跑过，静音断句永远不生效，12 秒后还会误报
   * 「没有检测到说话声」。ScriptProcessorNode 的回调跟着音频块走，
   * 既不受页面可见性影响，也不受定时器节流影响。
   * ------------------------------------------------------------------ */
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') {
    // offscreen 文档没有用户手势，AudioContext 会以 suspended 状态创建，
    // 不 resume 的话音频图不跑，输入缓冲区永远是静音
    try {
      await audioCtx.resume();
    } catch (e) {
      console.warn('[MSY] AudioContext 恢复失败，静音断句可能不可用', e);
    }
  }

  const source = audioCtx.createMediaStreamSource(stream);
  const processor = audioCtx.createScriptProcessor(2048, 1, 1);
  const mute = audioCtx.createGain();
  mute.gain.value = 0; // 节点要连到 destination 才会被驱动，用零增益避免真的外放
  source.connect(processor);
  processor.connect(mute);
  mute.connect(audioCtx.destination);

  session = {
    recorder,
    stream,
    ctxRef: { audioCtx, source, processor, mute },
    chunks,
    tabId,
    maxTimer: 0,
    noSpeechTimer: 0,
    stopping: false,
  };

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  recorder.onstop = async () => {
    const activeTab = session?.tabId ?? tabId;
    const parts = session?.chunks ?? chunks;
    const type = recorder.mimeType || mimeType || 'audio/webm';
    cleanup();
    const blob = new Blob(parts, { type });
    if (blob.size < 1200) {
      return toBackground({ type: 'asr.failed', tabId: activeTab, error: '录音太短了，没听到内容。' });
    }
    try {
      const base64 = await blobToBase64(blob);
      toBackground({ type: 'asr.recorded', tabId: activeTab, base64, mimeType: type });
    } catch (e) {
      toBackground({ type: 'asr.failed', tabId: activeTab, error: String(e?.message || e) });
    }
  };

  recorder.onerror = (e) => fail(tabId, `录音出错：${e?.error?.message || '未知错误'}`);

  /* ------------------------------ VAD ------------------------------ */

  let speechStarted = false;
  let silenceSince = 0;
  let noiseFloor = 0.006;
  let lastLevelSent = 0;
  let peak = 0;

  processor.onaudioprocess = (e) => {
    // stopping 时录音已经收尾，但节点还没断，这里再算一次就会踩到 session=null
    if (!session || session.stopping) return;

    const data = e.inputBuffer.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / data.length);

    // 自适应本底噪声：缓慢抬升下界，避免空调声、风扇声被当成说话
    noiseFloor = rms < noiseFloor ? rms * 0.85 + noiseFloor * 0.15 : noiseFloor * 0.999 + rms * 0.001;
    const threshold = Math.max(0.012, noiseFloor * 3.2);

    const now = performance.now();
    if (rms > threshold) {
      // 语音对话模式：正在朗读时用户开口了 —— 通知上层把朗读掐掉
      if (bargeMode && !speechStarted) toBackground({ type: 'asr.barge', tabId });
      speechStarted = true;
      silenceSince = 0;
    } else if (speechStarted && !silenceSince) {
      silenceSince = now;
    }

    if (rms > peak) peak = rms;

    // 电平推给界面，约每 90ms 一次
    if (now - lastLevelSent > 90) {
      lastLevelSent = now;
      toBackground({ type: 'asr.level', tabId, level: Math.min(1, rms / 0.18), rms, peak });
    }

    if (autoStop && speechStarted && silenceSince && now - silenceSince > silenceMs) {
      stop();
    }
  };

  recorder.start();
  toBackground({ type: 'asr.level', tabId, level: 0, rms: 0, peak: 0 });

  // 一直没说话就别干等着。语音对话模式下用户在思考，给他更久
  session.noSpeechTimer = setTimeout(() => {
    if (!speechStarted) fail(tabId, '没有检测到说话声，麦克风可能没选对。');
  }, Math.max(5000, noSpeechMs));

  // 保险丝：最多录 3 分钟
  session.maxTimer = setTimeout(() => {
    if (session && !session.stopping) stop();
  }, 180000);
}

function stop() {
  if (!session || session.stopping) return;
  session.stopping = true;
  clearTimeout(session.maxTimer);
  clearTimeout(session.noSpeechTimer);
  try {
    session.recorder.stop();
  } catch (e) {
    fail(session.tabId, `停止录音失败：${e?.message || e}`);
  }
}

function cancel() {
  if (!session) return;
  const tabId = session.tabId;
  session.stopping = true;
  session.recorder.onstop = null;
  try {
    session.recorder.stop();
  } catch {
    /* 忽略 */
  }
  cleanup();
  toBackground({ type: 'asr.level', tabId, level: 0 });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.target !== 'offscreen') return;
  if (msg.type === 'offscreen.start') start(msg);
  else if (msg.type === 'offscreen.stop') stop();
  else if (msg.type === 'offscreen.cancel') cancel();
});

// 让后台知道文档已经就绪（后台不依赖它，但便于排查）
toBackground({ type: 'offscreen.ready' });
