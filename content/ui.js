/**
 * 注入到面试鸭页面里的悬浮面板。
 *
 * 整个面板放在 Shadow DOM 里：站点的 antd v5 用的是 cssinjs，全局样式很容易
 * 影响外部元素，隔离掉最省心，我们的样式也不会漏出去污染站点。
 */
(function () {
  const NS = globalThis.MSY;

  const Z = 2147483000;

  const CSS = `
:host { all: initial; }
.msy-root, .msy-root * { box-sizing: border-box; }

/* 作者样式里的 display 会盖掉浏览器默认的 [hidden]{display:none}，
   所以必须自己兜住 —— 否则带 hidden 的按钮照样显示出来。 */
.msy-root [hidden] { display: none !important; }

.msy-root {
  /* ---- 浅色 ----
     主色从 #6366f1 压深到 #4f46e5：白字在旧主色上对比度只有 4.4，不到 WCAG AA；
     中性色换成偏冷的 slate 系，和靛蓝主色更搭；警告/成功色也压深一档，
     「完整答案需会员」这种小字以前在白底上几乎看不清。 */
  --bg: #ffffff;
  --bg-soft: #f8fafc;
  --bg-sunken: #f3f5f9;
  --bg-hover: #edf0f5;
  --border: #e2e7ef;
  --border-strong: #cdd5e0;
  --text: #111827;
  --text-dim: #566070;
  --text-faint: #8a93a3;
  --primary: #4f46e5;
  --primary-hover: #4338ca;
  --primary-fg: #ffffff;
  --primary-soft: #eef0ff;
  --primary-rgb: 79, 70, 229;
  --accent: #7c5cf0;
  --danger: #dc2626;
  --danger-soft: #fef2f2;
  --danger-rgb: 220, 38, 38;
  --ok: #059669;
  --ok-soft: #ecfdf5;
  --warn: #d97706;
  --warn-soft: #fffbeb;
  --shadow-sm: 0 1px 2px rgba(15, 23, 42, .05), 0 1px 3px rgba(15, 23, 42, .07);
  --shadow-lg: 0 18px 50px rgba(15, 23, 42, .18), 0 2px 8px rgba(15, 23, 42, .08);
  --focus: 0 0 0 2px var(--bg), 0 0 0 4px rgba(var(--primary-rgb), .55);
  --radius: 14px;

  position: fixed;
  z-index: ${Z};
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei",
               "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  font-size: 14px;
  line-height: 1.65;
  color: var(--text);
  -webkit-font-smoothing: antialiased;
  text-align: left;
  /* 站点常给 body 加 user-select:none 防复制，这个属性会被继承进 Shadow DOM，
     所以必须显式抢回来，否则面板里的文字也选不中 */
  user-select: text;
  -webkit-user-select: text;
}

.msy-root[data-theme="dark"] {
  --bg: #171a21;
  --bg-soft: #1e222b;
  --bg-sunken: #13151b;
  --bg-hover: #282d38;
  --border: #2b313c;
  --border-strong: #3b4250;
  --text: #e8eaf0;
  --text-dim: #a3aab7;
  --text-faint: #7d8594;
  --primary: #8b90f9;
  --primary-hover: #a1a5fb;
  --primary-fg: #10112a;
  --primary-soft: #262a4d;
  --primary-rgb: 139, 144, 249;
  --accent: #a78bfa;
  --danger: #f87171;
  --danger-soft: #3a1d22;
  --danger-rgb: 248, 113, 113;
  --ok: #34d399;
  --ok-soft: #12302a;
  --warn: #fbbf24;
  --warn-soft: #33290f;
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, .3);
  --shadow-lg: 0 18px 50px rgba(0, 0, 0, .6), 0 2px 8px rgba(0, 0, 0, .4);
}

/* ---------------- 图标 ---------------- */
.msy-i { display: inline-flex; align-items: center; justify-content: center; width: 15px; height: 15px; flex: none; }
.msy-i svg { width: 100%; height: 100%; display: block; }

/* ---------------- 悬浮球 ---------------- */
.msy-fab {
  position: fixed;
  width: 52px; height: 52px;
  border-radius: 50%;
  border: none;
  background: linear-gradient(135deg, var(--primary), var(--accent));
  color: #fff;
  cursor: pointer;
  box-shadow: 0 8px 24px rgba(var(--primary-rgb), .42), 0 2px 6px rgba(16, 24, 40, .12);
  display: flex; align-items: center; justify-content: center;
  transition: transform .2s cubic-bezier(.34,1.56,.64,1), box-shadow .2s ease;
  touch-action: none;
  user-select: none;
  padding: 0;
}
.msy-fab .msy-i { width: 22px; height: 22px; }
.msy-fab:hover { transform: scale(1.07); box-shadow: 0 10px 30px rgba(var(--primary-rgb), .55); }
.msy-fab:active { transform: scale(.95); }
.msy-fab .msy-fab-count {
  position: absolute; top: -4px; right: -4px;
  min-width: 19px; height: 19px; padding: 0 5px;
  border-radius: 999px; border: 2px solid #fff;
  background: var(--danger); color: #fff;
  font-size: 10.5px; font-weight: 700; line-height: 15px;
  text-align: center; font-family: -apple-system, BlinkMacSystemFont, sans-serif;
}
.msy-fab .msy-fab-count[hidden] { display: none; }
.msy-fab .msy-fab-dot {
  position: absolute; top: 3px; right: 3px;
  width: 11px; height: 11px; border-radius: 50%;
  background: var(--warn); border: 2px solid #fff;
}
.msy-fab[data-busy="1"]::after {
  content: ""; position: absolute; inset: -5px;
  border-radius: 50%; border: 2px solid rgba(var(--primary-rgb), .5);
  animation: msy-pulse 1.5s ease-out infinite;
}
@keyframes msy-pulse {
  0% { transform: scale(.88); opacity: .85; }
  100% { transform: scale(1.4); opacity: 0; }
}

/* ---------------- 面板外壳 ---------------- */
.msy-panel {
  position: fixed;
  display: flex; flex-direction: column;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
}
.msy-panel[hidden], .msy-fab[hidden] { display: none !important; }

/* 语音对话模式：面板描一圈，提醒你麦克风是开着的 */
.msy-panel[data-voice="1"] {
  box-shadow: var(--shadow-lg), 0 0 0 2px rgba(var(--danger-rgb), .55);
}
.msy-panel[data-voice="1"] .msy-brand::after {
  content: "语音对话中"; margin-left: 6px;
  font-size: 10.5px; font-weight: 500; opacity: .92;
  padding: 1px 6px; border-radius: 999px;
  background: rgba(255, 255, 255, .22);
}

.msy-resize {
  position: absolute; top: 0; left: 0;
  width: 18px; height: 18px;
  cursor: nwse-resize; z-index: 2;
  background: linear-gradient(135deg, var(--border-strong) 0 46%, transparent 46%);
  border-top-left-radius: var(--radius);
  opacity: 0; transition: opacity .15s;
}
.msy-panel:hover .msy-resize { opacity: .9; }

/* ---------------- 顶栏 ---------------- */
.msy-head {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 10px 10px 12px;
  background: linear-gradient(135deg, #4f46e5 0%, #6152ea 55%, #7c5cf0 100%);
  color: #fff;
  cursor: move;
  user-select: none;
  flex: none;
  position: relative;
}
.msy-root[data-theme="dark"] .msy-head {
  background: linear-gradient(135deg, #3f39c4 0%, #4f43cf 55%, #6447d6 100%);
}
.msy-head::after {
  content: ""; position: absolute; inset: 0;
  background: linear-gradient(180deg, rgba(255,255,255,.14), transparent 60%);
  pointer-events: none;
}
.msy-brand {
  display: flex; align-items: center; gap: 7px;
  font-weight: 600; font-size: 13px; letter-spacing: .2px;
  white-space: nowrap;
}
.msy-brand .msy-i { width: 16px; height: 16px; }
.msy-head .msy-spacer { flex: 1; }

.msy-profile {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 11.5px; padding: 3px 9px 3px 7px; border-radius: 999px;
  background: rgba(255,255,255,.2);
  border: 1px solid rgba(255,255,255,.22);
  white-space: nowrap; max-width: 132px;
  cursor: pointer; transition: background .15s;
  position: relative; z-index: 1;
}
.msy-profile:hover { background: rgba(255,255,255,.32); }
.msy-profile .msy-dot { width: 6px; height: 6px; border-radius: 50%; background: #6ee7b7; flex: none; }
.msy-profile[data-ok="0"] .msy-dot { background: #fcd34d; }
.msy-profile .msy-pname { overflow: hidden; text-overflow: ellipsis; }

.msy-icon-btn {
  width: 26px; height: 26px; flex: none;
  border: none; border-radius: 8px;
  background: transparent; color: rgba(255,255,255,.86);
  cursor: pointer; padding: 0;
  display: flex; align-items: center; justify-content: center;
  transition: background .15s, color .15s;
  position: relative; z-index: 1;
}
.msy-icon-btn:hover { background: rgba(255,255,255,.22); color: #fff; }

/* ---------------- 模式条 ---------------- */
.msy-modes-wrap { position: relative; flex: none; }
/* 模式按钮放不下时横向滚动；两侧的渐隐提示「那边还有」，
   否则「自测」「自由对话」藏在右边根本没人发现 */
.msy-modes-wrap::before, .msy-modes-wrap::after {
  content: ""; position: absolute; top: 0; bottom: 0; width: 28px;
  pointer-events: none; opacity: 0; transition: opacity .18s; z-index: 1;
}
.msy-modes-wrap::before { left: 0; background: linear-gradient(90deg, var(--bg), transparent); }
.msy-modes-wrap::after { right: 0; background: linear-gradient(270deg, var(--bg), transparent); }
.msy-modes-wrap[data-more-left="1"]::before,
.msy-modes-wrap[data-more-right="1"]::after { opacity: 1; }
.msy-modes {
  display: flex; gap: 5px;
  padding: 9px 10px 8px;
  overflow-x: auto; flex: none;
  background: var(--bg);
  scrollbar-width: none;
  scroll-behavior: smooth;
}
.msy-modes::-webkit-scrollbar { display: none; }
.msy-mode {
  flex: none;
  display: inline-flex; align-items: center; gap: 5px;
  padding: 5px 10px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text-dim);
  font-size: 12.5px; font-family: inherit; line-height: 1;
  cursor: pointer; white-space: nowrap;
  transition: background .14s, color .14s, border-color .14s;
}
.msy-mode .msy-i { width: 14px; height: 14px; }
.msy-mode:hover { background: var(--bg-hover); color: var(--text); }
.msy-mode[aria-pressed="true"] {
  background: var(--primary); border-color: var(--primary);
  color: var(--primary-fg); font-weight: 600;
  box-shadow: 0 2px 8px rgba(var(--primary-rgb), .28);
}

/* ---------------- 题目条 ---------------- */
.msy-scope {
  flex: none; display: flex; align-items: center; gap: 7px;
  margin: 0 10px 8px; padding: 6px 10px; border-radius: 9px;
  background: var(--primary-soft); border: 1px solid var(--primary);
  font-size: 11.5px; color: var(--primary);
}
.msy-scope[hidden] { display: none !important; }
.msy-scope-label { font-weight: 600; flex: none; }
.msy-scope-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.msy-scope-clear {
  flex: none; border: none; background: transparent; color: var(--primary);
  font-size: 11.5px; font-family: inherit; cursor: pointer; padding: 0 2px;
  text-decoration: underline;
}

.msy-qbar {
  flex: none;
  margin: 0 10px 9px;
  padding: 9px 10px;
  border-radius: 10px;
  background: var(--bg-soft);
  border: 1px solid var(--border);
  font-size: 12px;
}
.msy-qbar .msy-q-top { display: flex; align-items: flex-start; gap: 6px; }
.msy-qbar .msy-q-name {
  flex: 1; font-weight: 600; font-size: 12.5px; color: var(--text);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden; word-break: break-word; line-height: 1.5;
}
.msy-qbar .msy-q-refresh {
  flex: none; border: none; background: transparent; color: var(--text-faint);
  cursor: pointer; padding: 1px; border-radius: 6px; line-height: 0;
  transition: color .15s, background .15s, transform .3s;
}
.msy-qbar .msy-q-refresh:hover { color: var(--primary); background: var(--bg-hover); }
.msy-qbar .msy-q-refresh:active { transform: rotate(-180deg); }
.msy-qbar .msy-q-refresh .msy-i { width: 14px; height: 14px; }
.msy-qbar .msy-q-meta {
  margin-top: 5px; display: flex; flex-wrap: wrap; gap: 4px 10px;
  color: var(--text-dim); font-size: 11px;
}
.msy-qbar .msy-badge { display: inline-flex; align-items: center; gap: 3px; }
.msy-qbar .msy-badge .msy-i { width: 12px; height: 12px; }
.msy-qbar .msy-badge.ok, .msy-qbar .msy-badge.warn {
  padding: 1px 7px 1px 5px; border-radius: 999px; font-weight: 500;
}
.msy-qbar .msy-badge.ok { color: var(--ok); background: var(--ok-soft); }
.msy-qbar .msy-badge.warn { color: var(--warn); background: var(--warn-soft); }

/* ---------------- 消息区 ---------------- */
.msy-body-wrap { flex: 1; min-height: 0; position: relative; display: flex; flex-direction: column; }
.msy-msgs {
  flex: 1; min-height: 0;
  overflow-y: auto; overscroll-behavior: contain;
  padding: 6px 12px 12px;
  background: var(--bg-sunken);
  scrollbar-width: thin;
  scrollbar-color: var(--border-strong) transparent;
}
.msy-msgs::-webkit-scrollbar { width: 8px; }
.msy-msgs::-webkit-scrollbar-track { background: transparent; }
.msy-msgs::-webkit-scrollbar-thumb {
  background: var(--border-strong); border-radius: 4px;
  border: 2px solid var(--bg-sunken);
}
.msy-msgs::-webkit-scrollbar-thumb:hover { background: var(--text-faint); }

.msy-row { display: flex; margin-bottom: 12px; animation: msy-in .22s ease-out; }
.msy-row.user { justify-content: flex-end; }
.msy-row.sys { justify-content: center; }
@keyframes msy-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

.msy-bubble {
  max-width: 90%;
  padding: 10px 13px;
  border-radius: 14px;
  word-break: break-word;
  background: var(--bg);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-sm);
  line-height: 1.72;
}
.msy-row.user .msy-bubble {
  background: var(--primary); border-color: var(--primary);
  color: var(--primary-fg);
  border-bottom-right-radius: 5px;
  white-space: pre-wrap;
  box-shadow: 0 2px 8px rgba(var(--primary-rgb), .22);
}
.msy-row.assistant .msy-bubble { border-bottom-left-radius: 5px; }
.msy-row.sys .msy-bubble {
  background: transparent; border: none; box-shadow: none;
  color: var(--text-faint); font-size: 11.5px;
  max-width: 100%; text-align: center; padding: 2px 0;
}
.msy-row.assistant:last-child .msy-bubble { margin-bottom: 0; }

.msy-bubble.error {
  border-color: var(--danger); background: var(--danger-soft);
  color: var(--text); box-shadow: none;
}
.msy-bubble.error .msy-err-title {
  display: flex; align-items: center; gap: 5px;
  color: var(--danger); font-weight: 600; margin-bottom: 3px;
}
.msy-bubble.error .msy-err-title .msy-i { width: 14px; height: 14px; }
.msy-bubble.error pre {
  white-space: pre-wrap; font-family: inherit; margin: 0; font-size: 12.5px;
  line-height: 1.65; color: var(--text-dim);
}

/* 消息内的 markdown */
.msy-bubble p { margin: 0 0 8px; }
.msy-bubble p:last-child { margin-bottom: 0; }
.msy-bubble h3, .msy-bubble h4, .msy-bubble h5, .msy-bubble h6 {
  margin: 12px 0 6px; font-size: 13.5px; font-weight: 700; line-height: 1.45;
  color: var(--text);
}
.msy-bubble h3:first-child, .msy-bubble h4:first-child, .msy-bubble h5:first-child { margin-top: 0; }
.msy-bubble h3 {
  padding-left: 9px; border-left: 3px solid var(--primary);
}
.msy-bubble ul, .msy-bubble ol { margin: 6px 0 9px; padding-left: 21px; }
.msy-bubble li { margin: 3px 0; }
.msy-bubble li::marker { color: var(--text-faint); }
.msy-bubble blockquote {
  margin: 8px 0; padding: 7px 11px;
  border-left: 3px solid var(--primary);
  background: var(--primary-soft);
  border-radius: 0 8px 8px 0;
  color: var(--text-dim);
}
.msy-bubble hr { border: none; border-top: 1px solid var(--border); margin: 12px 0; }
.msy-bubble a { color: var(--primary); text-underline-offset: 2px; }
.msy-bubble code {
  font-family: "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 12.5px;
  background: var(--bg-hover);
  padding: 1.5px 5px; border-radius: 5px;
  word-break: break-word;
}
.msy-row.user .msy-bubble code { background: rgba(255,255,255,.22); }
.msy-bubble strong { font-weight: 700; }

/* 数学公式 */
.msy-math {
  font-family: "Times New Roman", "Songti SC", Georgia, serif;
  font-style: italic;
  white-space: nowrap;
}
.msy-math sub, .msy-math sup { font-style: normal; font-size: .72em; line-height: 0; }
.msy-math sup { vertical-align: super; }
.msy-math sub { vertical-align: sub; }
.msy-math-display {
  display: inline-block; margin: 4px 2px;
  padding: 2px 10px; border-radius: 7px;
  background: var(--bg-soft); border: 1px solid var(--border);
}
.msy-math-block {
  margin: 9px 0; padding: 11px 13px; border-radius: 9px;
  background: var(--bg-soft); border: 1px solid var(--border);
  overflow-x: auto; text-align: center;
}
.msy-frac {
  display: inline-flex; flex-direction: column; vertical-align: middle;
  text-align: center; margin: 0 3px; font-size: .92em;
}
.msy-frac .msy-num { border-bottom: 1px solid currentColor; padding: 0 3px 1px; }
.msy-frac .msy-den { padding: 1px 3px 0; }
.msy-rad { border-top: 1px solid currentColor; padding: 0 2px; }

.msy-table-wrap {
  overflow-x: auto; margin: 8px 0; border-radius: 8px;
  border: 1px solid var(--border);
}
.msy-bubble table { border-collapse: collapse; font-size: 12.5px; width: 100%; }
.msy-bubble th, .msy-bubble td {
  border-bottom: 1px solid var(--border); padding: 6px 10px; text-align: left;
}
.msy-bubble th { background: var(--bg-hover); font-weight: 600; }
.msy-bubble tr:last-child td { border-bottom: none; }

/* 代码块 */
.msy-code {
  margin: 8px 0; border-radius: 9px; overflow: hidden;
  border: 1px solid var(--border); background: var(--bg-soft);
}
.msy-code-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 4px 9px; background: var(--bg-hover);
  font-size: 11px; color: var(--text-dim);
}
.msy-code-lang { font-weight: 600; letter-spacing: .3px; }
.msy-copy {
  display: inline-flex; align-items: center; gap: 4px;
  border: none; background: transparent; color: var(--text-dim);
  cursor: pointer; font-size: 11px; font-family: inherit;
  padding: 2px 6px; border-radius: 5px;
  transition: background .15s, color .15s;
}
.msy-copy .msy-i { width: 12px; height: 12px; }
.msy-copy:hover { background: var(--bg); color: var(--text); }
.msy-copy.msy-ok { color: var(--ok); }
.msy-code pre { margin: 0; padding: 10px 11px; overflow-x: auto; }
/* 代码高亮配色，跟着主题走 */
.msy-root {
  --tok-k: #a626a4; --tok-s: #50a14f; --tok-c: #a0a1a7;
  --tok-n: #986801; --tok-t: #c18401; --tok-f: #4078f2;
}
.msy-root[data-theme="dark"] {
  --tok-k: #c678dd; --tok-s: #98c379; --tok-c: #7f848e;
  --tok-n: #d19a66; --tok-t: #e5c07b; --tok-f: #61afef;
}
.msy-code .msy-tok-k { color: var(--tok-k); font-weight: 600; }
.msy-code .msy-tok-s { color: var(--tok-s); }
.msy-code .msy-tok-c { color: var(--tok-c); font-style: italic; }
.msy-code .msy-tok-n { color: var(--tok-n); }
.msy-code .msy-tok-t { color: var(--tok-t); }
.msy-code .msy-tok-f { color: var(--tok-f); }
.msy-code code {
  background: none; padding: 0; font-size: 12.5px; line-height: 1.6;
  white-space: pre;
}

/* 思考过程 */
.msy-think {
  margin-bottom: 8px; border: 1px dashed var(--border-strong); border-radius: 9px;
  padding: 6px 10px; font-size: 12px; color: var(--text-dim);
  background: var(--bg-soft);
}
.msy-think summary {
  cursor: pointer; user-select: none; font-weight: 500;
  display: flex; align-items: center; gap: 5px;
}
.msy-think summary::marker { color: var(--text-faint); }
.msy-think .msy-think-body {
  margin-top: 5px; white-space: pre-wrap;
  max-height: 180px; overflow-y: auto; line-height: 1.6;
}

/* 等待首个 token 的打字指示 */
.msy-typing { display: inline-flex; gap: 4px; padding: 3px 0; }
.msy-typing i {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--text-faint); display: block;
  animation: msy-bounce 1.3s ease-in-out infinite;
}
.msy-typing i:nth-child(2) { animation-delay: .18s; }
.msy-typing i:nth-child(3) { animation-delay: .36s; }
@keyframes msy-bounce {
  0%, 62%, 100% { transform: translateY(0); opacity: .4; }
  32% { transform: translateY(-4px); opacity: 1; }
}

.msy-caret {
  display: inline-block; width: 7px; height: 15px;
  background: var(--primary); vertical-align: -3px; border-radius: 2px;
  animation: msy-blink 1.05s steps(2) infinite;
}
@keyframes msy-blink { 0%, 50% { opacity: 1; } 50.01%, 100% { opacity: 0; } }

/* 快速作答 chips */
.msy-quick {
  display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
  margin-top: 10px; padding-top: 9px; border-top: 1px dashed var(--border);
}
.msy-quick .msy-quick-hint {
  font-size: 11px; color: var(--text-faint); margin-right: 1px;
}
.msy-chip {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 4px 11px; border-radius: 8px;
  border: 1px solid var(--border-strong);
  background: var(--bg); color: var(--text);
  font-size: 12.5px; font-family: inherit; font-weight: 600;
  cursor: pointer; transition: all .14s;
}
.msy-chip:hover {
  border-color: var(--primary); color: var(--primary);
  background: var(--primary-soft); transform: translateY(-1px);
}
.msy-chip:active { transform: translateY(0); }
.msy-chip.weak { font-weight: 500; color: var(--text-dim); }
.msy-chip .msy-i { width: 13px; height: 13px; }

/* 自评：这道题掌握得怎么样 */
.msy-rate {
  display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
  margin-top: 9px; padding-top: 9px; border-top: 1px dashed var(--border);
}
.msy-rate-label { font-size: 11px; color: var(--text-faint); margin-right: 2px; }
.msy-rate-btn {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 4px 10px; border-radius: 8px;
  border: 1px solid var(--border-strong); background: var(--bg);
  color: var(--text-dim); font-size: 12px; font-family: inherit;
  cursor: pointer; transition: all .14s;
}
.msy-rate-btn .msy-i { width: 12px; height: 12px; }
.msy-rate-btn:hover { transform: translateY(-1px); }
.msy-rate-btn[data-tone="bad"]:hover { border-color: var(--danger); color: var(--danger); background: var(--danger-soft); }
.msy-rate-btn[data-tone="warn"]:hover { border-color: var(--warn); color: var(--warn); }
.msy-rate-btn[data-tone="ok"]:hover { border-color: var(--ok); color: var(--ok); }
.msy-rate-btn[data-tone="flat"]:hover { border-color: var(--primary); color: var(--primary); background: var(--primary-soft); }
.msy-rate-done {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 11.5px; color: var(--ok); font-weight: 600;
}
.msy-rate-done .msy-i { width: 13px; height: 13px; }

/* 复习入口 */
.msy-review {
  display: flex; flex-wrap: wrap; justify-content: center; gap: 8px;
  margin-top: 12px;
}
.msy-ghost {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 9px 18px; border-radius: 10px;
  border: 1px solid var(--border-strong); background: var(--bg);
  color: var(--text-dim); font-size: 13px; font-family: inherit;
  cursor: pointer; transition: all .15s;
}
.msy-ghost .msy-i { width: 15px; height: 15px; }
.msy-ghost:hover { border-color: var(--primary); color: var(--primary); background: var(--primary-soft); }

/* 消息操作条 */
.msy-actions {
  display: flex; gap: 12px; margin-top: 7px;
  font-size: 11px; color: var(--text-faint);
  opacity: 0; transition: opacity .18s;
}
.msy-row:hover .msy-actions, .msy-actions:focus-within { opacity: 1; }
.msy-actions button {
  display: inline-flex; align-items: center; gap: 4px;
  border: none; background: transparent; color: var(--text-faint);
  cursor: pointer; font-size: 11px; font-family: inherit; padding: 0;
  transition: color .15s;
}
.msy-actions button .msy-i { width: 12px; height: 12px; }
.msy-actions button:hover { color: var(--primary); }

/* 费曼讲完的庆祝 */
.msy-celebrate {
  position: relative; overflow: hidden;
  margin: 4px 0 12px; padding: 20px 16px 16px;
  border-radius: 14px; text-align: center;
  background: linear-gradient(135deg, rgba(var(--primary-rgb), .1), rgba(139,92,246,.14));
  border: 1px solid var(--primary);
  animation: msy-pop .32s cubic-bezier(.34,1.56,.64,1);
}
@keyframes msy-pop { from { transform: scale(.94); opacity: 0; } to { transform: scale(1); opacity: 1; } }
.msy-confetti { position: absolute; inset: 0; pointer-events: none; }
.msy-confetti i {
  position: absolute; top: -8px; width: 6px; height: 10px;
  border-radius: 2px; opacity: 0;
  animation: msy-fall 2.4s ease-in forwards;
}
@keyframes msy-fall {
  0% { transform: translateY(0) rotate(0); opacity: 1; }
  100% { transform: translateY(150px) rotate(320deg); opacity: 0; }
}
.msy-celebrate-icon { font-size: 30px; line-height: 1; margin-bottom: 6px;
  animation: msy-bounce-icon 1.2s ease-in-out infinite; }
@keyframes msy-bounce-icon { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-5px); } }
.msy-celebrate-title { font-size: 14px; font-weight: 700; color: var(--text); }
.msy-celebrate-desc { font-size: 12px; color: var(--text-dim); margin-top: 5px; line-height: 1.7; }
.msy-celebrate-actions {
  display: flex; flex-wrap: wrap; justify-content: center; gap: 7px; margin-top: 13px;
}

/* 空状态 */
.msy-empty { text-align: center; padding: 26px 14px; }
.msy-empty .msy-empty-icon {
  width: 54px; height: 54px; margin: 0 auto 12px;
  border-radius: 16px;
  background: linear-gradient(135deg, var(--primary), var(--accent));
  display: flex; align-items: center; justify-content: center;
  color: #fff; box-shadow: 0 8px 22px rgba(var(--primary-rgb), .32);
}
.msy-empty .msy-empty-icon .msy-i { width: 26px; height: 26px; }
.msy-empty .msy-empty-title {
  font-size: 13.5px; color: var(--text); font-weight: 600;
  line-height: 1.55; margin-bottom: 5px;
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
}
.msy-empty .msy-empty-desc {
  font-size: 12px; line-height: 1.75; color: var(--text-dim);
  max-width: 300px; margin: 0 auto;
}
.msy-empty .msy-empty-note {
  display: inline-block; margin-top: 8px; padding: 3px 10px; border-radius: 8px;
  font-size: 11.5px; color: var(--warn); background: var(--warn-soft);
}
.msy-personas {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: center;
  gap: 5px; margin: 12px 0 2px;
}
.msy-personas-label { font-size: 11.5px; color: var(--text-faint); margin-right: 1px; }
.msy-persona {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 4px 9px; border-radius: 999px;
  border: 1px solid var(--border); background: var(--bg);
  color: var(--text-dim); font-size: 11.5px; font-family: inherit;
  cursor: pointer; transition: all .14s;
}
.msy-persona .msy-i { width: 12px; height: 12px; }
.msy-persona:hover { border-color: var(--primary); color: var(--primary); }
.msy-persona[aria-pressed="true"] {
  background: var(--primary); border-color: var(--primary);
  color: var(--primary-fg); font-weight: 600;
}
.msy-empty .msy-start {
  margin-top: 15px; padding: 9px 22px; border-radius: 10px; border: none;
  background: var(--primary); color: var(--primary-fg);
  font-size: 13px; font-weight: 600; font-family: inherit; cursor: pointer;
  display: inline-flex; align-items: center; gap: 6px;
  box-shadow: 0 4px 14px rgba(var(--primary-rgb), .32);
  transition: transform .15s, box-shadow .15s, background .15s;
}
.msy-empty .msy-start:hover {
  background: var(--primary-hover); transform: translateY(-1px);
  box-shadow: 0 6px 18px rgba(var(--primary-rgb), .42);
}
.msy-empty .msy-start:active { transform: translateY(0); }

/* 往上翻历史时出现：一键回到最新 */
.msy-jump {
  position: absolute; left: 50%; bottom: 12px; transform: translate(-50%, 6px);
  display: inline-flex; align-items: center; gap: 5px;
  padding: 5px 12px; border-radius: 999px;
  border: 1px solid var(--border); background: var(--bg); color: var(--text-dim);
  font-size: 11.5px; font-family: inherit; cursor: pointer;
  box-shadow: var(--shadow-sm), 0 4px 14px rgba(15, 23, 42, .12);
  opacity: 0; pointer-events: none;
  transition: opacity .18s, transform .18s, color .15s, border-color .15s;
}
.msy-jump .msy-i { width: 12px; height: 12px; }
.msy-jump[data-show="1"] { opacity: 1; pointer-events: auto; transform: translate(-50%, 0); }
.msy-jump:hover { color: var(--primary); border-color: var(--primary); }
.msy-jump[data-new="1"] { color: var(--primary-fg); background: var(--primary); border-color: var(--primary); }

/* ---------------- 底部输入 ---------------- */
.msy-foot { flex: none; border-top: 1px solid var(--border); background: var(--bg); }
.msy-input-row {
  display: flex; align-items: flex-end; gap: 7px; padding: 10px 11px 7px;
}
.msy-input-wrap { flex: 1; min-width: 0; position: relative; display: flex; }

/* 输入框内的清除按钮：有内容时才出现，免得空着的时候多一个灰点 */
.msy-input-clear {
  position: absolute; top: 8px; right: 8px;
  width: 20px; height: 20px; border-radius: 50%;
  border: none; background: var(--bg-hover); color: var(--text-dim);
  cursor: pointer; padding: 0;
  display: flex; align-items: center; justify-content: center;
  transition: background .14s, color .14s;
}
.msy-input-clear .msy-i { width: 12px; height: 12px; }
.msy-input-clear:hover { background: var(--border-strong); color: var(--text); }

.msy-input {
  flex: 1; min-height: 38px; max-height: 132px;
  resize: none; overflow-y: auto;
  padding: 9px 32px 9px 11px; border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg-soft); color: var(--text);
  font-family: inherit; font-size: 13px; line-height: 1.55;
  outline: none;
  transition: border-color .15s, background .15s, box-shadow .15s;
}
.msy-input::placeholder { color: var(--text-faint); }
.msy-input:hover { border-color: var(--border-strong); }
.msy-input:focus {
  border-color: var(--primary); background: var(--bg);
  box-shadow: 0 0 0 3px var(--primary-soft);
}
.msy-input:disabled { opacity: .55; cursor: not-allowed; }

.msy-round {
  flex: none; width: 38px; height: 38px; border-radius: 50%;
  border: 1px solid var(--border); background: var(--bg-soft);
  color: var(--text-dim); cursor: pointer; padding: 0;
  display: flex; align-items: center; justify-content: center;
  transition: all .15s; position: relative;
}
.msy-round .msy-i { width: 17px; height: 17px; }
.msy-round:hover:not(:disabled) { background: var(--bg-hover); color: var(--text); }
.msy-round:disabled { opacity: .45; cursor: not-allowed; }
.msy-round.msy-send {
  background: var(--primary); border-color: var(--primary);
  color: var(--primary-fg);
  box-shadow: 0 3px 10px rgba(var(--primary-rgb), .3);
}
.msy-round.msy-send:hover:not(:disabled) { background: var(--primary-hover); }
.msy-round.msy-send[data-state="stop"] {
  background: var(--danger); border-color: var(--danger); color: #fff;
  box-shadow: 0 3px 10px rgba(var(--danger-rgb), .3);
}
.msy-round.msy-mic[data-state="recording"] {
  background: var(--danger); border-color: var(--danger); color: #fff;
  animation: msy-rec 1.4s ease-in-out infinite;
}
@keyframes msy-rec {
  0%, 100% { box-shadow: 0 0 0 0 rgba(var(--danger-rgb), .5); }
  50% { box-shadow: 0 0 0 8px rgba(var(--danger-rgb), 0); }
}
.msy-level {
  position: absolute; inset: -3px; border-radius: 50%;
  border: 2px solid var(--danger); pointer-events: none;
  transform: scale(1); opacity: 0;
  transition: transform .08s linear, opacity .1s;
}
.msy-mic[data-state="recording"] .msy-level { opacity: .9; }

.msy-foot-bar {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap; row-gap: 6px;
  padding: 0 13px 9px;
  font-size: 11.5px; color: var(--text-faint);
}
.msy-foot-bar label, .msy-foot-bar button { white-space: nowrap; flex: none; }
.msy-foot-bar label {
  display: inline-flex; align-items: center; gap: 5px; cursor: pointer;
  user-select: none; transition: color .15s;
}
.msy-foot-bar label:hover { color: var(--text-dim); }
.msy-foot-bar input[type="checkbox"] {
  margin: 0; cursor: pointer; accent-color: var(--primary);
  width: 13px; height: 13px;
}
.msy-foot-bar .msy-i { width: 13px; height: 13px; }
.msy-foot-bar .msy-flex { flex: 1; }
.msy-foot-bar button {
  display: inline-flex; align-items: center; gap: 4px;
  border: none; background: transparent; color: var(--text-faint);
  font-size: 11.5px; font-family: inherit; cursor: pointer; padding: 2px 4px;
  border-radius: 5px; transition: color .15s, background .15s;
}
.msy-foot-bar button:hover:not(:disabled) { color: var(--text); background: var(--bg-hover); }
.msy-foot-bar button:disabled { opacity: .4; cursor: not-allowed; }
.msy-foot-bar button.msy-stop { color: var(--danger); font-weight: 600; }
.msy-foot-bar button.msy-clear[data-confirm="1"] {
  color: var(--danger); background: var(--danger-soft); font-weight: 600;
}
.msy-foot-bar .msy-voice-toggle {
  padding: 3px 9px; border-radius: 999px;
  border: 1px solid var(--border); background: var(--bg-soft);
}
.msy-foot-bar .msy-voice-toggle:hover { border-color: var(--primary); color: var(--primary); }
.msy-foot-bar .msy-voice-toggle.on {
  background: var(--danger); border-color: var(--danger); color: #fff; font-weight: 600;
}
.msy-foot-bar .msy-voice-toggle.on:hover { background: var(--danger); color: #fff; opacity: .9; }

.msy-status {
  flex: none; padding: 5px 13px; font-size: 11.5px;
  border-top: 1px solid var(--border);
  display: flex; align-items: center; gap: 6px;
  background: var(--bg-soft); color: var(--text-dim);
}
.msy-status[hidden] { display: none; }
.msy-status.err { color: var(--danger); }
.msy-status.ok { color: var(--ok); }
.msy-spin {
  width: 11px; height: 11px; flex: none;
  border: 2px solid var(--border-strong); border-top-color: var(--primary);
  border-radius: 50%; animation: msy-spin .7s linear infinite;
}
@keyframes msy-spin { to { transform: rotate(360deg); } }

/* 键盘操作时要看得出焦点在哪；鼠标点击不出框 */
.msy-root button:focus-visible,
.msy-root summary:focus-visible,
.msy-root .msy-profile:focus-visible {
  outline: none; box-shadow: var(--focus);
}
.msy-head button:focus-visible, .msy-head .msy-profile:focus-visible {
  box-shadow: 0 0 0 2px rgba(255, 255, 255, .85);
}
.msy-foot-bar input[type="checkbox"]:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }

@media (prefers-reduced-motion: reduce) {
  .msy-root * { animation-duration: .01ms !important; transition-duration: .01ms !important; }
}
`;

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  /**
   * 按钮里的文字节点。不能直接 querySelector('span') —— 带图标的按钮第一个 span
   * 是图标本身，改它的 textContent 会把 SVG 换成文字，按钮上就出现两遍字。
   */
  const labelOf = (btn) => btn.querySelector(':scope > span:not(.msy-i)');

  function createUI() {
    const host = document.createElement('div');
    host.id = 'msy-ai-host';
    host.style.cssText = `position:fixed;z-index:${Z};top:0;left:0;width:0;height:0;`;
    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.append(style);

    const root = NS.h('div', { class: 'msy-root' });
    shadow.append(root);

    /** 建一个 SVG 图标节点 */
    function icon(name) {
      const span = document.createElement('span');
      span.className = 'msy-i';
      span.innerHTML = NS.ICONS[name] || '';
      return span;
    }

    /* ---------------- 结构 ---------------- */
    const fabCount = NS.h('span', { class: 'msy-fab-count' });
    fabCount.hidden = true;
    const fab = NS.h('button', { class: 'msy-fab', type: 'button', title: 'AI 复习助手（Alt+Shift+M）' }, [
      icon('empty'),
      fabCount,
    ]);

    const modeBtns = NS.MODES.map((m) =>
      NS.h('button', {
        class: 'msy-mode',
        type: 'button',
        'aria-pressed': 'false',
        title: m.hint,
        dataset: { mode: m.id },
      }, [icon(m.icon), NS.h('span', { text: m.label })])
    );
    const modesBar = NS.h('div', { class: 'msy-modes', role: 'toolbar', 'aria-label': '复习模式' }, modeBtns);
    const modesWrap = NS.h('div', { class: 'msy-modes-wrap' }, [modesBar]);
    // 面试范围横幅：只在设了范围时显示
    const scopeBar = NS.h('div', { class: 'msy-scope' });
    scopeBar.hidden = true;

    const qName = NS.h('div', { class: 'msy-q-name', text: '正在识别题目…' });
    const qMeta = NS.h('div', { class: 'msy-q-meta' });
    const qRefresh = NS.h('button', { class: 'msy-q-refresh', type: 'button', title: '重新抓取题目' }, [icon('refresh')]);
    const qbar = NS.h('div', { class: 'msy-qbar' }, [
      NS.h('div', { class: 'msy-q-top' }, [qName, qRefresh]),
      qMeta,
    ]);

    const msgs = NS.h('div', { class: 'msy-msgs', role: 'log', 'aria-live': 'polite' });
    const jumpBtn = NS.h('button', { class: 'msy-jump', type: 'button', title: '回到最新消息' }, [
      icon('down'),
      NS.h('span', { text: '回到最新' }),
    ]);
    const bodyWrap = NS.h('div', { class: 'msy-body-wrap' }, [msgs, jumpBtn]);

    const input = NS.h('textarea', {
      class: 'msy-input',
      rows: 1,
      placeholder: '输入你的回答，或点麦克风说话…（Enter 发送）',
    });
    const micBtn = NS.h('button', { class: 'msy-round msy-mic', type: 'button', title: '语音输入（按 M 或 Alt+Shift+V）' }, [
      icon('interview'),
      NS.h('span', { class: 'msy-level' }),
    ]);
    const sendBtn = NS.h('button', {
      class: 'msy-round msy-send', type: 'button', title: '发送', dataset: { state: 'send' },
    }, [icon('send')]);
    const inputClear = NS.h('button', {
      class: 'msy-input-clear',
      type: 'button',
      title: '清空输入框（Esc）',
    }, [icon('close')]);
    inputClear.hidden = true;
    const inputWrap = NS.h('div', { class: 'msy-input-wrap' }, [input, inputClear]);
    const inputRow = NS.h('div', { class: 'msy-input-row' }, [inputWrap, micBtn, sendBtn]);

    const ttsToggle = NS.h('input', { type: 'checkbox' });
    const stopBtn = NS.h('button', { class: 'msy-stop', type: 'button' }, [icon('stop'), NS.h('span', { text: '停止' })]);
    const saveBtn = NS.h('button', { class: 'msy-save', type: 'button', title: '把题目、答案和这次的对话存成本地 Markdown' }, [
      icon('save'),
      NS.h('span', { text: '存笔记' }),
    ]);
    const clearBtn = NS.h('button', { class: 'msy-clear', type: 'button', title: '清空当前模式的对话' }, [
      NS.h('span', { text: '清空' }),
    ]);
    const voiceBtn = NS.h('button', { class: 'msy-voice-toggle', type: 'button' }, [
      icon('interview'),
      NS.h('span', { text: '语音对话' }),
    ]);
    const footBar = NS.h('div', { class: 'msy-foot-bar' }, [
      NS.h('label', {}, [ttsToggle, icon('speak'), NS.h('span', { text: '朗读回复' })]),
      voiceBtn,
      NS.h('span', { class: 'msy-flex' }),
      stopBtn,
      saveBtn,
      clearBtn,
    ]);
    const foot = NS.h('div', { class: 'msy-foot' }, [inputRow, footBar]);

    const status = NS.h('div', { class: 'msy-status' });
    status.hidden = true;

    const profileChip = NS.h('span', {
      class: 'msy-profile', title: '点击切换 AI 方案', role: 'button', tabindex: '0', dataset: { ok: '0' },
    }, [
      NS.h('span', { class: 'msy-dot' }),
      NS.h('span', { class: 'msy-pname', text: '未配置' }),
    ]);
    const gearBtn = NS.h('button', { class: 'msy-icon-btn', type: 'button', title: '设置' }, [icon('settings')]);
    const foldBtn = NS.h('button', { class: 'msy-icon-btn', type: 'button', title: '收起' }, [icon('minimize')]);
    const head = NS.h('div', { class: 'msy-head' }, [
      NS.h('span', { class: 'msy-brand' }, [icon('empty'), NS.h('span', { text: 'AI 复习助手' })]),
      NS.h('span', { class: 'msy-spacer' }),
      profileChip,
      gearBtn,
      foldBtn,
    ]);

    const resize = NS.h('div', { class: 'msy-resize', title: '拖动调整大小' });
    const panel = NS.h('div', { class: 'msy-panel', role: 'dialog', 'aria-label': 'AI 复习助手' }, [
      resize, head, modesWrap, scopeBar, qbar, bodyWrap, status, foot,
    ]);

    root.append(fab, panel);

    /* ---------------- 状态 ---------------- */
    const state = {
      collapsed: false,
      streaming: false,
      pos: { right: 22, bottom: 22 },
      size: { width: 400, height: 640 },
      mode: 'interview',
      handlers: {},
    };

    NS.md.bindCopy(shadow);

    const emit = (name, ...args) => state.handlers[name]?.(...args);
    const on = (name, fn) => {
      state.handlers[name] = fn;
      return api;
    };

    /* ---------------- 位置 / 大小 ---------------- */
    /**
     * 悬浮球和面板共用一个锚点（右下角）。悬浮球很小，可以拖到很高的位置；
     * 但同一个锚点套到 640px 高的面板上，顶部就跑出屏幕了，标题栏都够不着。
     * 所以面板单独再夹一次：保证整个面板留在可视区里。
     */
    function applyPos() {
      const { right, bottom } = state.pos;
      fab.style.right = `${right}px`;
      fab.style.bottom = `${bottom}px`;
      const w = panel.offsetWidth || state.size.width;
      const h = panel.offsetHeight || state.size.height;
      panel.style.right = `${clamp(right, 4, Math.max(4, window.innerWidth - w - 4))}px`;
      panel.style.bottom = `${clamp(bottom, 4, Math.max(4, window.innerHeight - h - 4))}px`;
    }

    function applySize() {
      const w = clamp(state.size.width, 320, Math.max(360, window.innerWidth - 30));
      const h = clamp(state.size.height, 320, Math.max(360, window.innerHeight - 30));
      panel.style.width = `${w}px`;
      panel.style.height = `${h}px`;
      syncModeFades();
    }

    /* ---------------- 模式条滚动 ---------------- */
    function syncModeFades() {
      const max = modesBar.scrollWidth - modesBar.clientWidth;
      modesWrap.dataset.moreLeft = modesBar.scrollLeft > 2 ? '1' : '0';
      modesWrap.dataset.moreRight = modesBar.scrollLeft < max - 2 ? '1' : '0';
    }
    modesBar.addEventListener('scroll', syncModeFades, { passive: true });
    // 普通鼠标没有横向滚轮，竖着滚也让它横向走
    modesBar.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      if (modesBar.scrollWidth <= modesBar.clientWidth) return;
      e.preventDefault();
      modesBar.scrollLeft += e.deltaY;
    }, { passive: false });

    /**
     * 通用拖拽，用 pointer capture，鼠标移出窗口也不丢。
     *
     * ignoreButtons：拖拽区域里如果还有按钮（标题栏上的设置、折叠），按下它们时
     * 必须放行。否则 setPointerCapture 会把事件从按钮手里抢走，click 永远不触发 ——
     * 表现就是「按钮点了没反应」。
     */
    function makeDrag(handle, onMove, { onUp, ignoreButtons = false } = {}) {
      handle.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        if (ignoreButtons && e.target.closest?.('button')) return;
        const start = { x: e.clientX, y: e.clientY };
        const origin = onMove.start();
        handle.setPointerCapture(e.pointerId);
        const move = (ev) => onMove.move(start, origin, ev);
        const up = () => {
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', up);
          try {
            handle.releasePointerCapture(e.pointerId);
          } catch {
            /* 忽略 */
          }
          onUp?.();
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
        e.preventDefault();
      });
    }

    // 按「当前看得见的那个」的尺寸来夹，拖出屏幕边缘之后往回拖不会有一段没反应
    const posDrag = (start, origin, ev) => {
      const el = state.collapsed ? fab : panel;
      state.pos = {
        right: clamp(origin.right - (ev.clientX - start.x), 4, Math.max(4, window.innerWidth - el.offsetWidth - 4)),
        bottom: clamp(origin.bottom - (ev.clientY - start.y), 4, Math.max(4, window.innerHeight - el.offsetHeight - 4)),
      };
      applyPos();
    };
    // 起点取面板实际所在的位置（可能被 applyPos 夹过），而不是存下来的原始值
    const dragStart = () =>
      state.collapsed
        ? { ...state.pos }
        : { right: parseFloat(panel.style.right) || state.pos.right, bottom: parseFloat(panel.style.bottom) || state.pos.bottom };

    makeDrag(head, { start: dragStart, move: posDrag }, { onUp: () => emit('persistPosition', state.pos), ignoreButtons: true });
    makeDrag(fab, { start: dragStart, move: posDrag }, { onUp: () => emit('persistPosition', state.pos) });

    // 面板锚在右下角，所以左上角拖拽是「反向」的：往左上拖变大
    makeDrag(
      resize,
      {
        start: () => ({ ...state.size }),
        move: (start, origin, ev) => {
          state.size = {
            width: clamp(origin.width - (ev.clientX - start.x), 320, window.innerWidth - 40),
            height: clamp(origin.height - (ev.clientY - start.y), 320, window.innerHeight - 40),
          };
          applySize();
          applyPos();
        },
      },
      { onUp: () => emit('persistSize', state.size) }
    );

    window.addEventListener('resize', () => {
      applySize();
      applyPos();
    });

    /* ---------------- 主题 ---------------- */
    /**
     * 判断站点是深色还是浅色。
     *
     * body 的背景经常是透明的，这时不能直接当成黑色 —— 要往 html 上找，
     * 都没有就退回系统偏好。否则浅色站点会被误判成深色。
     */
    function detectTheme(mode) {
      if (mode === 'dark' || mode === 'light') return mode;

      const el = document.documentElement;
      if (el.classList.contains('dark') || el.dataset.theme === 'dark') return 'dark';
      if (el.classList.contains('light') || el.dataset.theme === 'light') return 'light';

      for (const node of [document.body, el]) {
        if (!node) continue;
        const bg = getComputedStyle(node).backgroundColor;
        const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/);
        if (!m) continue;
        const alpha = m[4] === undefined ? 1 : Number(m[4]);
        if (alpha < 0.1) continue; // 透明，看不出来，继续往上找
        const lum = (0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3]) / 255;
        return lum < 0.5 ? 'dark' : 'light';
      }
      return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }

    /* ---------------- 滚动 ---------------- */
    const nearBottom = () => msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 70;
    const syncJump = () => {
      const show = !nearBottom();
      jumpBtn.dataset.show = show ? '1' : '0';
      if (!show) jumpBtn.dataset.new = '0';
    };
    const scrollToBottom = (force) => {
      if (force || nearBottom()) msgs.scrollTop = msgs.scrollHeight;
      else jumpBtn.dataset.new = '1'; // 你在翻旧消息，下面又来了新内容
      syncJump();
    };
    msgs.addEventListener('scroll', syncJump, { passive: true });
    jumpBtn.addEventListener('click', () => {
      msgs.scrollTo({ top: msgs.scrollHeight, behavior: 'smooth' });
      jumpBtn.dataset.new = '0';
    });

    /* ---------------- 消息渲染 ---------------- */
    const pendingRender = new Map(); // 行元素 -> 待执行的渲染定时器

    function scheduleRender(row, text) {
      if (pendingRender.has(row)) return;
      const id = setTimeout(() => {
        pendingRender.delete(row);
        const node = row.querySelector('.msy-body');
        if (!node) return;
        node.innerHTML = NS.md.render(text) + '<span class="msy-caret"></span>';
        scrollToBottom();
      }, 70);
      pendingRender.set(row, id);
    }

    function makeRow(role) {
      const body = NS.h('div', { class: 'msy-body' });
      const actions = NS.h('div', { class: 'msy-actions' });
      const bubble = NS.h('div', { class: 'msy-bubble' }, [body, actions]);
      const row = NS.h('div', { class: `msy-row ${role}` }, [bubble]);
      msgs.append(row);
      return { row, bubble, body, actions };
    }

    /* ---------------- 快速作答 ---------------- */

    // 只给最新一条 AI 消息挂按钮：旧消息上的按钮点了会让人分不清答的是哪题
    let lastQuick = null;

    function clearQuick() {
      lastQuick?.remove();
      lastQuick = null;
    }

    /**
     * 根据回复内容挂上「点一下就作答」的按钮。
     * 选择题 -> A/B/C/D；判断题 -> 对/错；再额外给一个「不会」。
     */
    function attachQuick(bubble, text) {
      clearQuick();
      const options = NS.md.extractOptions(text);
      const isTF = !options.length && NS.md.looksLikeTrueFalse(text);
      if (!options.length && !isTF) return;

      const wrap = NS.h('div', { class: 'msy-quick' });
      wrap.append(NS.h('span', { class: 'msy-quick-hint', text: '点一下直接作答：' }));

      if (options.length) {
        for (const o of options) {
          wrap.append(
            NS.h('button', {
              class: 'msy-chip',
              type: 'button',
              title: o.text,
              text: o.letter,
              onclick: () => emit('quickAnswer', `我选 ${o.letter}`),
            })
          );
        }
      } else {
        wrap.append(
          NS.h('button', { class: 'msy-chip', type: 'button', text: '对', onclick: () => emit('quickAnswer', '对') }),
          NS.h('button', { class: 'msy-chip', type: 'button', text: '错', onclick: () => emit('quickAnswer', '错') })
        );
      }

      if (state.mode === 'quiz' || state.mode === 'interview') {
        wrap.append(
          NS.h('button', {
            class: 'msy-chip weak',
            type: 'button',
            title: '跳过，直接看答案',
            text: '不会',
            onclick: () => emit('quickAnswer', '不会，直接告诉我答案和要点'),
          })
        );
      }

      bubble.append(wrap);
      lastQuick = wrap;
      scrollToBottom();
    }

    /* ---------------- 自评 ---------------- */

    // 只有需要你自己判断掌握程度的模式才给自评按钮
    const RATE_MODES = new Set(['interview', 'quiz', 'memorize']);

    // 自评只挂最新一条：给早就翻过去的老消息评分没有意义，
    // 而且一屏里堆好几排一样的按钮会让人不知道点哪个
    let lastRate = null;

    function attachRating(bubble) {
      if (!RATE_MODES.has(state.mode)) return;
      lastRate?.remove();
      lastRate = null;

      const wrap = NS.h('div', { class: 'msy-rate' });
      wrap.append(NS.h('span', { class: 'msy-rate-label', text: '这题掌握得怎么样？' }));

      for (const r of NS.srs.RATINGS) {
        wrap.append(
          NS.h('button', {
            class: 'msy-rate-btn',
            type: 'button',
            title: r.hint,
            dataset: { tone: r.tone },
            onclick: () => {
              if (wrap.dataset.done) return; // 评过一次就够了
              wrap.dataset.done = '1';
              const label = r.label;
              wrap.textContent = '';
              wrap.append(
                NS.h('span', { class: 'msy-rate-done' }, [icon('check'), NS.h('span', { text: `已记录「${label}」` })])
              );
              emit('rate', r.id);
            },
          }, [icon(r.icon), NS.h('span', { text: r.label })])
        );
      }
      bubble.append(wrap);
      lastRate = wrap;
    }

    const api = {
      host,
      shadow,
      on,
      el: { fab, panel, msgs, input, micBtn, sendBtn, status, ttsToggle, stopBtn, saveBtn, clearBtn, qName, qMeta, profileChip },

      /* -------- 折叠 -------- */
      setCollapsed(v) {
        state.collapsed = Boolean(v);
        panel.hidden = state.collapsed;
        fab.hidden = !state.collapsed;
        if (!state.collapsed) {
          applySize();
          applyPos();
          setTimeout(() => input.focus(), 30);
        }
      },
      isCollapsed: () => state.collapsed,

      /* -------- 位置 / 尺寸 / 主题 -------- */
      applyLayout(ui) {
        if (ui.position) state.pos = { right: ui.position.right ?? 22, bottom: ui.position.bottom ?? 22 };
        if (ui.width) state.size.width = ui.width;
        if (ui.height) state.size.height = ui.height;
        applySize();
        applyPos();
      },
      getPosition: () => ({ ...state.pos }),
      getSize: () => ({ ...state.size }),

      setTheme(mode) {
        root.dataset.theme = detectTheme(mode);
      },

      /* -------- 题目条 -------- */
      /** 面试范围横幅：设了就显示，点一下能清掉 */
      setScope(text) {
        if (!text) {
          scopeBar.hidden = true;
          scopeBar.textContent = '';
          return;
        }
        scopeBar.hidden = false;
        scopeBar.textContent = '';
        scopeBar.append(
          NS.h('span', { class: 'msy-scope-label', text: '面试范围' }),
          NS.h('span', { class: 'msy-scope-name', text, title: text })
        );
        scopeBar.append(
          NS.h('button', {
            class: 'msy-scope-clear',
            type: 'button',
            title: '取消范围限制，恢复成考所有题',
            text: '取消',
            onclick: () => emit('clearScope'),
          })
        );
      },

      setQuestion(q) {
        qName.textContent = q.title || '未识别到题目';
        qName.title = q.title || '';
        qMeta.textContent = '';

        const badge = (cls, iconName, text) => {
          const el = NS.h('span', { class: `msy-badge ${cls}` }, [icon(iconName), NS.h('span', { text })]);
          qMeta.append(el);
        };

        if (!q.isQuestion && !q.title) {
          badge('warn', 'alert', '当前不是题目页');
        } else if (q.answer) {
          badge('ok', 'check', `已读取参考答案（${q.answer.length} 字）`);
        } else if (q.teaser) {
          badge('warn', 'alert', '完整答案需会员，仅取到摘要');
        } else if (q.paywalled) {
          badge('warn', 'alert', '答案被会员墙挡住，AI 将用自己的知识答');
        } else {
          badge('warn', 'alert', '页面上没找到答案');
        }
        if (q.tags?.length) {
          qMeta.append(NS.h('span', { class: 'msy-badge', text: q.tags.slice(0, 4).join(' · ') }));
        }
      },

      /**
       * 到期数量保留成接口但不再显示 —— 复习排期挪到设置页了，
       * 页面上只留一个干净的面板。
       */
      setDueCount() {
        fabCount.hidden = true;
      },

      setProfile(name, configured) {
        profileChip.querySelector('.msy-pname').textContent = name || '未配置';
        profileChip.dataset.ok = configured ? '1' : '0';
        profileChip.title = configured
          ? `当前方案：${name}（点击切换）`
          : `${name || '未配置'} 还没有填 API Key，点这里去设置`;
      },

      setMode(modeId) {
        state.mode = modeId;
        for (const b of modeBtns) {
          const on = b.dataset.mode === modeId;
          b.setAttribute('aria-pressed', String(on));
          // 选中的模式在可视区外（比如从设置页切到「自由对话」），滚过去让人看见
          if (on && modesBar.clientWidth) {
            const l = b.offsetLeft - 10;
            const r = b.offsetLeft + b.offsetWidth + 10;
            if (l < modesBar.scrollLeft) modesBar.scrollLeft = l;
            else if (r > modesBar.scrollLeft + modesBar.clientWidth) modesBar.scrollLeft = r - modesBar.clientWidth;
          }
        }
        syncModeFades();
        const m = NS.modeById(modeId);
        // 提示要如实：关掉自动断句时不能还写着「说完会自动停」
        const voice = state.asrHint ? `，${state.asrHint}` : '';
        input.placeholder =
          modeId === 'interview'
            ? `开口回答上面的问题${voice}…`
            : modeId === 'quiz'
              ? '直接点上面的选项，或打字回答…'
              : `和 AI ${m.label}…（Enter 发送，Shift+Enter 换行）`;
      },

      /* -------- 消息 -------- */
      clear() {
        msgs.textContent = '';
        jumpBtn.dataset.show = '0';
        jumpBtn.dataset.new = '0';
        pendingRender.clear();
        lastQuick = null;
        lastRate = null;
      },

      showEmpty(info) {
        api.clear();
        const mode = NS.modeById(state.mode);
        // 题目已经写在上面的题目条里了，这里不再重复一遍，改成说清楚这个模式会做什么
        const desc = mode.hint || '选一个模式开始复习。';
        const descEl = NS.h('div', { class: 'msy-empty-desc', text: desc });
        if (info?.paywalled && !info?.answer) {
          descEl.append(NS.h('div', { class: 'msy-empty-note', text: '没读到本站答案（需要会员），AI 会用自己的知识回答。' }));
        }

        const box = NS.h('div', { class: 'msy-empty' }, [
          NS.h('div', { class: 'msy-empty-icon' }, [icon(mode.icon)]),
          NS.h('div', { class: 'msy-empty-title', text: mode.label }),
          descEl,
        ]);

        // 面试类模式下让人挑个面试官 —— 换个语气，复习体感完全不一样。
        // 这个是「选怎么问」，不是统计，所以留在面板上。
        if (mode.id === 'interview' || mode.id === 'followup') {
          const row = NS.h('div', { class: 'msy-personas' });
          row.append(NS.h('span', { class: 'msy-personas-label', text: '面试官' }));
          for (const per of NS.PERSONAS) {
            row.append(
              NS.h('button', {
                class: 'msy-persona',
                type: 'button',
                title: per.desc || '',
                'aria-pressed': String((info?.progress?.persona || '') === per.id),
                onclick: () => emit('personaChange', per.id),
              }, [icon(per.icon), NS.h('span', { text: per.label })])
            );
          }
          box.append(row);
        }

        // 统计性质的（进度、到期、复习入口）都挪到设置页去了，
        // 页面上是刷题的地方，越干净越好，所以这里只剩一个开始按钮。
        box.append(
          NS.h('button', {
            class: 'msy-start',
            type: 'button',
            onclick: () => emit('start', mode.id),
          }, [icon(mode.icon), NS.h('span', { text: `开始${mode.label}` })])
        );

        msgs.append(box);
      },

      /**
       * 费曼讲完的收尾：放个恭喜动画，让用户自己决定继续还是结束。
       * 用纯 CSS 的粒子，不引动画库。
       */
      showCelebration({ title, desc, actions }) {
        const box = NS.h('div', { class: 'msy-celebrate' });
        const confetti = NS.h('div', { class: 'msy-confetti' });
        for (let i = 0; i < 18; i++) {
          confetti.append(
            NS.h('i', {
              style: `left:${Math.round((i / 17) * 100)}%;` +
                `animation-delay:${(i % 6) * 0.12}s;` +
                `background:${['#4f46e5', '#7c5cf0', '#059669', '#f59e0b', '#ef4444'][i % 5]}`,
            })
          );
        }
        box.append(confetti);
        box.append(NS.h('div', { class: 'msy-celebrate-icon', text: '🎉' }));
        box.append(NS.h('div', { class: 'msy-celebrate-title', text: title || '这题你讲明白了！' }));
        if (desc) box.append(NS.h('div', { class: 'msy-celebrate-desc', text: desc }));

        const row = NS.h('div', { class: 'msy-celebrate-actions' });
        for (const a of actions || []) {
          row.append(
            NS.h('button', {
              class: `msy-chip${a.weak ? ' weak' : ''}`,
              type: 'button',
              text: a.label,
              onclick: () => a.run(),
            })
          );
        }
        box.append(row);
        msgs.append(box);
        scrollToBottom(true);
        return box;
      },

      addSystem(text) {
        const { row } = makeRow('sys');
        row.querySelector('.msy-bubble').textContent = text;
        scrollToBottom(true);
        return row;
      },

      addError(text, onRetry) {
        const { row, bubble, actions } = makeRow('assistant');
        bubble.classList.add('error');
        const body = bubble.querySelector('.msy-body');
        const title = NS.h('div', { class: 'msy-err-title' }, [icon('alert'), NS.h('span', { text: '出错了' })]);
        const pre = NS.h('pre');
        pre.textContent = text;
        body.append(title, pre);
        if (onRetry) {
          actions.append(
            NS.h('button', { type: 'button', onclick: onRetry }, [icon('refresh'), NS.h('span', { text: '重试' })])
          );
        }
        scrollToBottom(true);
        return row;
      },

      addUser(text) {
        clearQuick();
        const { row } = makeRow('user');
        row.querySelector('.msy-bubble').textContent = text;
        scrollToBottom(true);
        return row;
      },

      /** 开始一条 AI 消息，返回句柄供流式追加。 */
      beginAssistant() {
        clearQuick();
        const { row, body, actions } = makeRow('assistant');
        body.innerHTML = '<span class="msy-typing"><i></i><i></i><i></i></span>';
        let text = '';
        let thinkEl = null;
        let thinkBody = null;
        let started = false;

        const handle = {
          row,
          getText: () => text,

          addThink(chunk) {
            if (!thinkEl) {
              thinkBody = NS.h('div', { class: 'msy-think-body' });
              thinkEl = NS.h('details', { class: 'msy-think' }, [
                NS.h('summary', { text: '思考过程' }),
                thinkBody,
              ]);
              body.before(thinkEl);
            }
            thinkBody.textContent += chunk;
            thinkBody.scrollTop = thinkBody.scrollHeight;
          },

          append(chunk) {
            if (!started) {
              started = true;
              body.innerHTML = '';
            }
            text += chunk;
            scheduleRender(row, text);
          },

          finish(finalText) {
            if (typeof finalText === 'string') text = finalText;
            clearTimeout(pendingRender.get(row));
            pendingRender.delete(row);

            if (!text) {
              // 一个字都没收到，别留个空壳
              body.innerHTML = '<p style="color:var(--text-faint)">（没有返回内容）</p>';
              return text;
            }
            body.innerHTML = NS.md.render(text);
            scrollToBottom();

            actions.append(
              NS.h('button', {
                type: 'button',
                onclick: async (e) => {
                  const btn = e.currentTarget;
                  const ok = await NS.copyText(text);
                  labelOf(btn).textContent = ok ? '已复制' : '复制失败';
                  setTimeout(() => (labelOf(btn).textContent = '复制'), 1400);
                },
              }, [icon('copy'), NS.h('span', { text: '复制' })]),
              NS.h('button', {
                type: 'button',
                onclick: () => emit('speak', text),
              }, [icon('speak'), NS.h('span', { text: '朗读' })])
            );

            const bubble = row.querySelector('.msy-bubble');
            attachQuick(bubble, text);
            attachRating(bubble);
            return text;
          },
        };
        return handle;
      },

      /* -------- 输入区 -------- */
      getInput: () => input.value,
      setInput(v, { focus = false } = {}) {
        input.value = v;
        input.dispatchEvent(new Event('input'));
        input.style.height = 'auto';
        input.style.height = `${Math.min(input.scrollHeight, 132)}px`;
        syncClearBtn();
        if (focus) input.focus();
      },
      /** 把文字插到光标处（用户自己编辑过输入框时用，别覆盖他的内容）。 */
      insertAtCursor(v) {
        const start = input.selectionStart ?? input.value.length;
        const end = input.selectionEnd ?? start;
        input.value = input.value.slice(0, start) + v + input.value.slice(end);
        input.dispatchEvent(new Event('input'));
        input.style.height = 'auto';
        input.style.height = `${Math.min(input.scrollHeight, 132)}px`;
        syncClearBtn();
        input.focus();
      },
      focusInput: () => input.focus(),

      setBusy(busy) {
        fab.dataset.busy = busy ? '1' : '0';
        input.disabled = busy;
        sendBtn.disabled = busy;
        micBtn.disabled = busy;
      },

      setStreaming(v) {
        state.streaming = v;
        sendBtn.dataset.state = v ? 'stop' : 'send';
        sendBtn.title = v ? '停止生成' : '发送';
        sendBtn.replaceChildren(icon(v ? 'stop' : 'send'));
        stopBtn.hidden = !v;
        if (v) clearBtn.disabled = true; // 生成中不允许清空，清空逻辑也会拒绝
        scrollToBottom();
      },

      setStatus(text, kind = 'busy') {
        if (!text) {
          status.hidden = true;
          return;
        }
        status.hidden = false;
        status.className = `msy-status ${kind}`;
        status.textContent = '';
        if (kind === 'busy') status.append(NS.h('span', { class: 'msy-spin' }));
        status.append(NS.h('span', { text }));
      },

      /**
       * 语音对话开关。开着时面板描红边 + 标题栏显示「语音对话中」，
       * 免得忘了麦克风还开着。
       */
      setVoiceMode(on) {
        panel.dataset.voice = on ? '1' : '0';
        voiceBtn.classList.toggle('on', Boolean(on));
        voiceBtn.setAttribute('aria-pressed', String(Boolean(on)));
        voiceBtn.title = on
          ? '语音对话中：AI 念完会自动开始听你说。点击关闭'
          : '开启后 AI 念完会自动开始听你说，说完自动发送、自动念新回复（模拟面试和费曼最常用）';
        labelOf(voiceBtn).textContent = on ? '语音对话中' : '语音对话';
      },

      /** 语音引擎的提示语（比如「说完停顿约 1.5 秒自动结束」），用在输入框提示里 */
      setAsrHint(text) {
        state.asrHint = text || '';
        api.setMode(state.mode);
      },

      setMicState(s) {
        micBtn.dataset.state = s;
        micBtn.title =
          s === 'recording'
            ? '正在录音，说完停顿一下会自动结束（按 M 或点这里可手动结束）'
            : '语音输入（按 M 或 Alt+Shift+V）';
      },

      setLevel(v) {
        const ring = micBtn.querySelector('.msy-level');
        if (ring) {
          ring.style.transform = `scale(${1 + Math.min(1, v) * 0.55})`;
          ring.style.opacity = String(0.25 + Math.min(1, v) * 0.75);
        }
      },

      setTtsEnabled(v) {
        ttsToggle.checked = Boolean(v);
      },

      setSendWithEnter(v) {
        state.sendWithEnter = v !== false;
      },

      setClearEnabled(v) {
        // 生成中一律禁用 —— 光靠调用顺序保证不了，setClearEnabled 可能在
        // setStreaming(true) 之后被调用，会把按钮又解禁掉
        clearBtn.disabled = state.streaming || !v;
      },

      isStreaming: () => state.streaming,
    };

    /* ---------------- 事件绑定 ---------------- */
    fab.addEventListener('click', () => emit('toggleCollapse', false));
    foldBtn.addEventListener('click', () => emit('toggleCollapse', true));
    gearBtn.addEventListener('click', () => emit('openOptions'));
    profileChip.addEventListener('click', () => emit('openOptions'));
    profileChip.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        emit('openOptions');
      }
    });
    qRefresh.addEventListener('click', () => emit('refreshQuestion'));
    stopBtn.addEventListener('click', () => emit('stop'));
    saveBtn.addEventListener('click', () => emit('saveNote'));
    // 清空会把这道题这个模式的对话整个抹掉，点错了没法撤回，所以要点两下：
    // 第一下变成「再点一次确认」，3 秒内不点就自己复原
    let clearConfirmT = null;
    const resetClearConfirm = () => {
      clearTimeout(clearConfirmT);
      clearBtn.dataset.confirm = '0';
      labelOf(clearBtn).textContent = '清空';
    };
    clearBtn.addEventListener('click', () => {
      if (clearBtn.dataset.confirm !== '1') {
        clearBtn.dataset.confirm = '1';
        labelOf(clearBtn).textContent = '再点一次确认';
        clearTimeout(clearConfirmT);
        clearConfirmT = setTimeout(resetClearConfirm, 3000);
        return;
      }
      resetClearConfirm();
      emit('clear');
    });
    clearBtn.addEventListener('blur', resetClearConfirm);
    ttsToggle.addEventListener('change', () => emit('ttsChange', ttsToggle.checked));
    voiceBtn.addEventListener('click', () => emit('toggleVoice'));

    sendBtn.addEventListener('click', () => emit('submit'));
    micBtn.addEventListener('click', () => emit('micToggle'));

    for (const b of modeBtns) {
      b.addEventListener('click', () => emit('modeChange', b.dataset.mode));
    }

    const syncClearBtn = () => {
      inputClear.hidden = !input.value;
    };

    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 132)}px`;
      syncClearBtn();
    });

    const clearInput = () => {
      if (!input.value) return;
      input.value = '';
      input.dispatchEvent(new Event('input')); // 让上层知道用户把手写内容清掉了
      syncClearBtn();
      input.focus();
    };
    inputClear.addEventListener('click', clearInput);

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !e.isComposing) {
        e.preventDefault();
        clearInput();
        return;
      }
      if (e.key !== 'Enter') return;
      if (e.isComposing || e.keyCode === 229) return; // 中文输入法组字中
      const withEnter = state.sendWithEnter !== false;
      if (withEnter && !e.shiftKey) {
        e.preventDefault();
        emit('submit');
      } else if (!withEnter && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        emit('submit');
      }
    });

    // 面板内快捷键
    shadow.addEventListener('keydown', (e) => {
      if (e.altKey && e.key.toLowerCase() === 'm' && !e.shiftKey) {
        e.preventDefault();
        emit('micToggle');
      }
    });

    return api;
  }

  NS.ui = { create: createUI };
})();
