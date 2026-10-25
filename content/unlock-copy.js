/**
 * 解除面试鸭的复制限制，让页面上**已经显示出来**的文字能正常选中、复制、右键。
 *
 * 站点的做法（dev 里实测过）：
 *   - body 和正文区域 user-select: none，选不中字
 *   - 在 document、body 和一堆 div 上，捕获、冒泡两个阶段都挂了
 *     copy / cut / contextmenu / dragstart / keydown 等监听，
 *     按 Ctrl/⌘+C 时 keydown 和 copy 事件都会被它截住
 *
 * 对策：在 document_start 就往 window 的**捕获阶段**挂监听 —— 这是事件路径的最前端，
 * 比站点任何一个监听都先跑 —— 对复制相关的事件 stopImmediatePropagation，
 * 站点的拦截器就收不到事件了。只拦传播、不 preventDefault，浏览器自己的复制照常发生。
 *
 * 这只是把屏幕上已经渲染的内容放开复制，不去拿会员墙后面的内容。
 * 设置里可以关掉（unlockCopy），关掉后这里的监听全部直接放行。
 */
(function () {
  if (window.__msyUnlockCopy) return; // 同一页面别装两遍
  window.__msyUnlockCopy = true;

  const KEY = 'msy_settings';
  // 读设置是异步的，而监听必须同步挂上才能抢在站点前面 ——
  // 所以先按默认值（开）挂好，读到设置后再决定要不要放行
  let on = true;

  // 输入框、编辑器（站点的评论框、笔记编辑器）里的复制粘贴是它们自己要处理的，别碰。
  // 我们自己的面板不在此列：它在 Shadow DOM 里，事件到这里时 target 是宿主元素，
  // 照样拦下来，站点就够不着面板里的复制；面板自己也不靠这几个事件干活
  const editable = (t) => {
    const el = t instanceof Element ? t : t?.parentElement;
    if (!el) return false;
    return Boolean(el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], .CodeMirror, .bytemd'));
  };

  const guard = (e) => {
    if (!on || editable(e.target)) return;
    e.stopImmediatePropagation();
  };
  for (const type of ['copy', 'cut', 'contextmenu', 'selectstart', 'dragstart']) {
    window.addEventListener(type, guard, true);
  }

  // 只放过复制相关的快捷键：全拦 keydown 会把站点自己的快捷键（比如 H 隐藏答案）也弄坏
  const COPY_KEYS = new Set(['c', 'x', 'a']);
  window.addEventListener('keydown', (e) => {
    if (!on || !(e.ctrlKey || e.metaKey) || e.altKey) return;
    if (!COPY_KEYS.has(String(e.key).toLowerCase()) || editable(e.target)) return;
    e.stopImmediatePropagation();
  }, true);

  // 站点在页面加载约 1 秒后往 body 上写内联 user-select: none（不带 !important），
  // 正文靠继承也选不中；用 !important 的样式表盖回来。
  // 按钮、标签页这类控件保持不可选，免得双击按钮时选中一片文字。
  const style = document.createElement('style');
  style.id = 'msy-unlock-copy';
  style.textContent = `
    html body, html body * { -webkit-user-select: text !important; user-select: text !important; }
    html body :is(button, [role="button"], [role="tab"], .ant-btn, .ant-tabs-tab, .ant-menu-item, .ant-dropdown-trigger, .ant-select-selector, .ant-pagination-item) {
      -webkit-user-select: none !important; user-select: none !important;
    }`;
  const mountStyle = () => {
    // 最早的时候连 <html> 都可能还没有，那就先不挂，等下面的 MutationObserver 再来
    const parent = document.head || document.documentElement;
    if (on && !style.isConnected && parent) parent.append(style);
    if (!on && style.isConnected) style.remove();
  };
  mountStyle();
  // Next.js hydration 会重写 head，把我们的 <style> 一起清掉（实测如此）。
  // 盯着 DOM，样式一掉就挂回去；检查只是一次 isConnected，代价很小。
  new MutationObserver(() => {
    if (on && !style.isConnected) mountStyle();
  }).observe(document, { childList: true, subtree: true });

  const apply = (settings) => {
    on = settings?.unlockCopy !== false;
    mountStyle();
  };
  try {
    chrome.storage.local.get(KEY).then((r) => apply(r[KEY])).catch(() => {});
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[KEY]) apply(changes[KEY].newValue);
    });
  } catch {
    /* 扩展上下文失效（比如刚重新加载过扩展）时保持默认 */
  }
})();
