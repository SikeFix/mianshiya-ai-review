/**
 * 后台服务线程。
 *
 * 1. AI 对话代理：所有大模型请求都在这里发。扩展的 fetch 不受页面 CORS 限制，
 *    所以才能做到「填谁的接口就调谁」，这是兼容多家模型的前提。
 *    SSE 流式增量通过长连接 Port 推给内容脚本，实现打字机效果。
 * 2. 语音转写：内容脚本不能可靠地拿麦克风（权限绑在站点域名上），
 *    所以录音放在 offscreen 文档里做，权限归属扩展自己。
 * 3. 快捷键转发。
 */
import './shared/config.js';
import './shared/store.js';
import './shared/notes.js';
import './shared/srs.js';
import './shared/report.js';

const OFFSCREEN_PATH = 'offscreen.html';

/* =================================================================== *
 * AI 对话
 * =================================================================== */

const ENDPOINT = (base) => `${base.replace(/\/+$/, '')}/chat/completions`;

/** 把各种失败翻译成人能看懂的中文。 */
function friendlyError(err) {
  if (!err) return '未知错误';
  if (typeof err === 'string') return err;

  const status = err.status;
  const raw = String(err.message || '');
  const body = String(err.body || '').slice(0, 400);

  if (status === 401 || status === 403) {
    return `API Key 被拒绝了（HTTP ${status}）。请到设置页检查 Key 是否填对、是否已过期或欠费。`;
  }
  if (status === 402) return '账户余额不足，请先充值。';
  if (status === 404) {
    return '接口地址（Base URL）不对，返回了 404。检查一下是不是少了或多了 /v1，例如 https://api.deepseek.com/v1';
  }
  if (status === 429) return '请求太频繁或额度已用完（HTTP 429），等一会儿再试。';
  if (status >= 500) return `服务端出错了（HTTP ${status}），通常等一会儿重试就好。${body ? '\n' + body : ''}`;

  if (/Failed to fetch|NetworkError|Load failed|ERR_/i.test(raw)) {
    return (
      '网络请求发不出去。常见原因：\n' +
      '1) 这个域名还没授权 —— 到设置页重新保存一次该方案并点「允许」；\n' +
      '2) 接口地址填错；\n' +
      '3) 该服务需要代理（比如 OpenAI、OpenRouter）。'
    );
  }
  if (/AbortError/.test(raw)) return '已中断。';
  return raw || '请求失败';
}

async function readError(res) {
  let body = '';
  try {
    body = await res.text();
  } catch {
    /* 忽略 */
  }
  const err = new Error(`HTTP ${res.status}`);
  err.status = res.status;
  err.body = body;
  return err;
}

/**
 * 深度合并两个普通对象（数组整体替换）。
 * 用来把用户填的自定义请求参数合进请求体。
 */
function mergeBody(base, extra) {
  if (!extra || typeof extra !== 'object') return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    const isPlain = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
    out[k] = isPlain(out[k]) && isPlain(v) ? mergeBody(out[k], v) : v;
  }
  return out;
}

/**
 * 发起一次对话。onDelta 会被流式调用。
 * @returns {Promise<{text:string, reasoning:string, usage:object|null}>}
 */
async function chatCompletion({ profile, messages, stream = true, signal, onDelta }) {
  if (!profile?.baseUrl) throw new Error('还没有配置 AI 接口，请点右上角齿轮进设置页填一个。');
  if (!profile.model) throw new Error('还没有填模型名，请到设置页补上（例如 deepseek-chat）。');

  const headers = { 'Content-Type': 'application/json' };
  if (profile.apiKey) headers.Authorization = `Bearer ${profile.apiKey}`;

  let payload = {
    model: profile.model,
    messages,
    temperature: profile.temperature ?? 0.6,
    max_tokens: profile.maxTokens || 2048,
    stream: Boolean(stream),
    // 有些服务商要求显式关掉思考链，或者要传 top_p 之类，统一从这里透传
    ...(profile.extraBody || {}),
  };
  // 这三项关系到我们自己能不能正常工作，不允许被自定义参数覆盖掉
  payload = mergeBody(payload, { model: profile.model, messages, stream: Boolean(stream) });

  let res;
  try {
    res = await fetch(ENDPOINT(profile.baseUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal,
    });
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    throw new Error(friendlyError(e));
  }

  if (!res.ok) throw new Error(friendlyError(await readError(res)));

  // 非流式：一次拿完
  if (!stream) {
    const json = await res.json();
    const msg = json.choices?.[0]?.message || {};
    return {
      text: msg.content || '',
      // 思考链的字段名各家不一样，能认的都认上
      reasoning: msg.reasoning_content || msg.reasoning || '',
      usage: json.usage || null,
    };
  }

  if (!res.body) throw new Error('这个接口没有返回流式内容，去设置页把「流式输出」关掉再试。');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let text = '';
  let reasoning = '';
  let usage = null;

  const handleLine = (line) => {
    const s = line.trim();
    if (!s || s.startsWith(':')) return;
    if (!s.startsWith('data:')) return;
    const data = s.slice(5).trim();
    if (data === '[DONE]') return;
    let json;
    try {
      json = JSON.parse(data);
    } catch {
      return; // 半行，丢掉
    }
    if (json.usage) usage = json.usage;
    const delta = json.choices?.[0]?.delta;
    if (!delta) return;
    // 思考链字段名没有统一标准：DeepSeek 用 reasoning_content，
    // vLLM 部署的 Qwen3 用 reasoning。两个都认，否则思考过程会被静默丢掉。
    const think = delta.reasoning_content || delta.reasoning;
    if (think) {
      reasoning += think;
      onDelta?.({ reasoning: think });
    }
    if (delta.content) {
      text += delta.content;
      onDelta?.({ text: delta.content });
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) handleLine(line);
  }
  if (buf) handleLine(buf);

  return { text, reasoning, usage };
}

/** 内容脚本通过这个 Port 发起对话并接收流式增量。 */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'msy-chat') return;

  const inflight = new Map(); // id -> AbortController

  port.onMessage.addListener(async (msg) => {
    if (msg?.type === 'chat.abort') {
      inflight.get(msg.id)?.abort();
      return;
    }
    if (msg?.type !== 'chat.start') return;

    const { id } = msg;
    const controller = new AbortController();
    inflight.set(id, controller);

    const post = (m) => {
      try {
        port.postMessage(m);
      } catch {
        /* Port 已断开 */
      }
    };

    try {
      const result = await chatCompletion({
        profile: msg.profile,
        messages: msg.messages,
        stream: msg.stream !== false,
        signal: controller.signal,
        onDelta: (d) => {
          if (d.text) post({ type: 'chat.delta', id, text: d.text });
          if (d.reasoning) post({ type: 'chat.reasoning', id, text: d.reasoning });
        },
      });
      post({ type: 'chat.done', id, ...result });
    } catch (e) {
      if (e?.name === 'AbortError') post({ type: 'chat.aborted', id });
      else post({ type: 'chat.error', id, error: friendlyError(e) });
    } finally {
      inflight.delete(id);
    }
  });

  port.onDisconnect.addListener(() => {
    for (const c of inflight.values()) c.abort();
    inflight.clear();
  });
});

/* =================================================================== *
 * 语音转写
 * =================================================================== */

async function ensureOffscreen() {
  if (chrome.offscreen.hasDocument && (await chrome.offscreen.hasDocument())) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['USER_MEDIA'],
    justification: '录制麦克风音频，用于把口语回答转成文字',
  });
}

async function closeOffscreen() {
  if (chrome.offscreen.hasDocument && (await chrome.offscreen.hasDocument())) {
    await chrome.offscreen.closeDocument();
  }
}

function base64ToBlob(base64, mimeType) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mimeType || 'audio/webm' });
}

const EXT_BY_MIME = (mime) => {
  const m = String(mime || '');
  if (m.includes('mp4') || m.includes('aac')) return 'm4a';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('wav')) return 'wav';
  if (m.includes('mpeg')) return 'mp3';
  return 'webm';
};

async function transcribe(base64, mimeType, cfg, profile) {
  // 允许「复用对话方案的 Key」——多数服务商同一个 Key 就能做语音转写
  const baseUrl = (cfg.reuseChatKey && profile?.baseUrl) || cfg.baseUrl;
  const apiKey = (cfg.reuseChatKey && profile?.apiKey) || cfg.apiKey;
  const model = cfg.model || 'whisper-1';

  if (!baseUrl) throw new Error('还没配置语音转写服务，去设置页填一个。');

  const form = new FormData();
  form.append('file', base64ToBlob(base64, mimeType), `audio.${EXT_BY_MIME(mimeType)}`);
  form.append('model', model);
  if (cfg.language) form.append('language', cfg.language);

  const headers = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  let res;
  try {
    res = await fetch(`${baseUrl.replace(/\/+$/, '')}/audio/transcriptions`, {
      method: 'POST',
      headers,
      body: form,
    });
  } catch (e) {
    throw new Error(friendlyError(e));
  }
  if (!res.ok) throw new Error(friendlyError(await readError(res)));

  const json = await res.json().catch(() => null);
  const text = (json?.text || '').trim();
  if (!text) throw new Error('语音识别返回了空结果，可能没录到声音。');
  return text;
}

/** 把状态推给指定标签页的内容脚本 */
function pushToTab(tabId, payload) {
  if (tabId === undefined || tabId === null) return;
  chrome.tabs.sendMessage(tabId, payload).catch(() => {
    /* 页面可能已经跳走或关闭 */
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'background') return undefined;

  // 内容脚本不知道自己的标签页 id，所以从 sender 里取；offscreen 回调里则带着显式 tabId
  const fromTab = sender?.tab?.id ?? msg.tabId;

  (async () => {
    try {
      switch (msg.type) {
        case 'offscreen.ready':
          return; // 通知，不用回

        case 'asr.start': {
          await ensureOffscreen();
          const settings = await MSY.store.get();
          if (!settings.asr.cloud.reuseChatKey && !settings.asr.cloud.apiKey) {
            throw new Error('云端语音需要填一个语音转写服务的 Key，去设置页配置，或者切回「浏览器内置」识别。');
          }
          chrome.runtime.sendMessage({
            target: 'offscreen',
            type: 'offscreen.start',
            tabId: fromTab,
            silenceMs: settings.asr.silenceMs,
            autoStop: settings.asr.autoStop !== false,
            // 内置识别拿不到音频流，做不了打断；云端有音量检测才行
            bargeMode: msg.barge !== false && settings.asr.bargeIn !== false,
            noSpeechMs: msg.voiceMode ? 60000 : 20000,
          });
          return;
        }

        case 'asr.stop':
          chrome.runtime.sendMessage({ target: 'offscreen', type: 'offscreen.stop', tabId: fromTab });
          return;

        case 'asr.cancel':
          chrome.runtime.sendMessage({ target: 'offscreen', type: 'offscreen.cancel', tabId: fromTab });
          await closeOffscreen();
          return;

        case 'asr.level':
          pushToTab(msg.tabId, { type: 'asr.level', level: msg.level });
          return;

        // 用户开口了，正在朗读的话就该让位
        case 'asr.barge':
          pushToTab(msg.tabId, { type: 'asr.barge' });
          return;

        case 'asr.recorded': {
          const settings = await MSY.store.get();
          const profile = MSY.store.activeProfile(settings);
          try {
            const text = await transcribe(msg.base64, msg.mimeType, settings.asr.cloud, profile);
            pushToTab(msg.tabId, { type: 'asr.transcript', text });
          } catch (e) {
            pushToTab(msg.tabId, { type: 'asr.error', error: friendlyError(e) });
          } finally {
            await closeOffscreen();
          }
          return;
        }

        case 'asr.failed':
          pushToTab(msg.tabId, { type: 'asr.error', error: msg.error || '录音失败' });
          await closeOffscreen();
          return;

        case 'open.options':
          // 带 hash 时要落到具体标签页，openOptionsPage 不支持 hash，只能自己开
          if (msg.hash) {
            chrome.tabs.create({ url: chrome.runtime.getURL(`options.html#${msg.hash}`) });
          } else {
            chrome.runtime.openOptionsPage();
          }
          return;

        // 设置页的「测试连接」：发一条最小请求，确认地址、Key、模型名都对
        case 'ai.test': {
          const started = Date.now();
          const r = await chatCompletion({
            profile: msg.profile,
            messages: [{ role: 'user', content: '回复两个字：可用' }],
            stream: false,
            signal: AbortSignal.timeout(25000),
          });
          sendResponse({
            ok: true,
            ms: Date.now() - started,
            text: String(r.text || '').slice(0, 40),
          });
          return;
        }

        // 保存单条笔记
        case 'notes.save': {
          const settings = await MSY.store.get();
          const rec = msg.record || {};
          const md = MSY.notes.toMarkdown(rec, { includeChat: settings.save.includeChat !== false });
          const dir = msg.folder || MSY.notes.folderFor(rec, settings);
          const path = `${dir}/${MSY.notes.fileNameFor(rec)}.md`;
          await downloadMarkdown(path, md);
          sendResponse({ ok: true, path });
          return;
        }

        // 让 AI 基于统计数据分析薄弱点，给学习建议
        case 'ai.analyze': {
          const settings = await MSY.store.get();
          const profile = MSY.store.activeProfile(settings);
          if (!profile?.baseUrl) throw new Error('还没有配置 AI 接口。');
          const list = await MSY.notes.list();
          const agg = MSY.report.aggregate(list);
          if (!agg.total) {
            sendResponse({ ok: false, error: '还没有复习记录，先去刷几道题。' });
            return;
          }
          const r = await chatCompletion({
            profile,
            stream: false,
            signal: AbortSignal.timeout(90000),
            messages: [
              {
                role: 'system',
                content:
                  '你是一位技术面试教练。学生把最近的复习数据给你，你要诊断他的薄弱环节并给出可执行的复习计划。\n' +
                  '要求：\n' +
                  '1. 先用两三句话点出最关键的结论，不要复述数据。\n' +
                  '2. 指出 2-3 个最该补的方向，说明为什么判断它们最弱。\n' +
                  '3. 给出接下来 3 天的具体安排，每天做什么、做多少道。\n' +
                  '4. 中文，Markdown，全文控制在 400 字以内。不要客套话。',
              },
              { role: 'user', content: MSY.report.briefForAI(agg) },
            ],
          });
          sendResponse({ ok: true, text: r.text || '' });
          return;
        }

        // 生成知识反馈网页（自包含 HTML，双击就能看）
        case 'notes.report': {
          const settings = await MSY.store.get();
          const list = await MSY.notes.list();
          const agg = MSY.report.aggregate(list);
          const html = MSY.report.toHtml(agg);
          const d = new Date();
          const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          const path = buildPath(settings.save.folder, `学习报告-${day}`, '.html');
          await downloadFile(path, html, 'text/html');
          sendResponse({ ok: true, path, total: agg.total, weak: agg.weak.map((w) => w.name) });
          return;
        }

        // 导出一段现成的 markdown（比如「待复习清单」）
        case 'notes.saveRaw': {
          const settings = await MSY.store.get();
          const path = buildPath(msg.folder || settings.save.folder, msg.filename || '导出');
          await downloadMarkdown(path, String(msg.markdown || ''));
          sendResponse({ ok: true, path });
          return;
        }

        // 导出复习记录。dim 有值时按分类分开导，每个分类一份
        case 'notes.exportAll': {
          const settings = await MSY.store.get();
          const list = await MSY.notes.list();
          if (!list.length) {
            sendResponse({ ok: false, error: '还没有任何复习记录。' });
            return;
          }
          const includeChat = settings.save.includeChat !== false;
          const folder = MSY.notes.safeFolder(settings.save.folder);
          // 用本地日期，别用 toISOString —— 那是 UTC，东八区凌晨会差一天
          const d = new Date();
          const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

          if (!msg.dim) {
            const md = MSY.notes.allToMarkdown(list, { includeChat });
            const path = `${folder}/全部复习笔记-${day}.md`;
            await downloadMarkdown(path, md);
            sendResponse({ ok: true, path, count: list.length, files: 1 });
            return;
          }

          // 分类导出：一类一个文件，各自放在同名子文件夹里，方便整包拖进笔记库
          const groups = MSY.notes.groupBy(list, msg.dim);
          const paths = [];
          for (const g of groups) {
            const sub = MSY.notes.safeFolder(g.name);
            const md = MSY.notes.groupToMarkdown(g.name, g.items, { includeChat });
            const path = `${folder}/${sub}/${sub}-${day}.md`;
            await downloadMarkdown(path, md);
            paths.push(path);
          }
          sendResponse({ ok: true, paths, files: paths.length, count: list.length });
          return;
        }

        // 设置页要显示「已经存了多少条」
        case 'notes.stats': {
          const list = await MSY.notes.list();
          sendResponse({
            count: list.length,
            latest: list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 5)
              .map((r) => ({ title: r.title, updatedAt: r.updatedAt })),
          });
          return;
        }
      }
    } catch (e) {
      const message = friendlyError(e);
      if (msg.type === 'ai.test' || msg.type?.startsWith('notes.')) {
        sendResponse({ ok: false, error: message });
      } else {
        pushToTab(fromTab, { type: 'asr.error', error: message });
      }
      if (msg.type?.startsWith('asr.')) await closeOffscreen().catch(() => {});
    }
  })();

  // 异步处理，先占住返回通道
  return true;
});

/* =================================================================== *
 * 本地笔记
 * =================================================================== */

/**
 * 触发一次下载。
 *
 * 用 data: URL 而不是 Blob URL —— MV3 的服务线程里没有 URL.createObjectURL
 * （那是 DOM 才有的东西）。笔记是纯文本，体积很小，data URL 完全够用。
 */
async function downloadFile(filename, content, mime = 'text/markdown') {
  if (!filename) throw new Error('文件名为空');
  const url = `data:${mime};charset=utf-8,${encodeURIComponent(content)}`;
  const id = await chrome.downloads.download({
    url,
    filename,
    conflictAction: 'overwrite', // 同一道题反复存就更新同一份，不堆副本
    saveAs: false,
  });
  return id;
}

const downloadMarkdown = (filename, text) => downloadFile(filename, text, 'text/markdown');

/** 拼接「文件夹/文件名.md」，并保证路径是相对的、不越界 */
function buildPath(folder, name, ext = '.md') {
  const dir = MSY.notes.safeFolder(folder);
  const file = MSY.notes.safeName(name, '未命名', 60);
  return `${dir}/${file}${ext}`;
}

/* =================================================================== *
 * 快捷键
 * =================================================================== */

chrome.commands?.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  if (!/^https:\/\/(www\.)?mianshiya\.com\//.test(tab.url || '')) return;

  if (command === 'toggle-panel') pushToTab(tab.id, { type: 'panel.toggle' });
  if (command === 'toggle-mic') pushToTab(tab.id, { type: 'mic.toggle' });
});

/* =================================================================== *
 * 安装
 * =================================================================== */

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    await MSY.store.set({});
    chrome.runtime.openOptionsPage();
  }
});
