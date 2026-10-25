/** 通用小工具。内容脚本之间通过 window.MSY 共享。 */
(function () {
  const NS = globalThis.MSY || (globalThis.MSY = {});

  NS.log = (...args) => console.log('%c[面试鸭AI]', 'color:#0f766e', ...args);
  NS.warn = (...args) => console.warn('%c[面试鸭AI]', 'color:#f59e0b', ...args);

  /** 建 DOM。h('div', {class:'x', onclick:fn}, [子元素或字符串]) */
  NS.h = function h(tag, props, children) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'html') el.innerHTML = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'dataset' && typeof v === 'object') Object.assign(el.dataset, v);
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    if (children) {
      for (const c of [].concat(children)) {
        if (c === null || c === undefined || c === false) continue;
        el.append(typeof c === 'string' ? document.createTextNode(c) : c);
      }
    }
    return el;
  };

  NS.escapeHtml = (s) =>
    String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  NS.debounce = (fn, ms) => {
    let t;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
  };

  NS.throttle = (fn, ms) => {
    let last = 0;
    let timer;
    return (...a) => {
      const now = Date.now();
      const wait = ms - (now - last);
      clearTimeout(timer);
      if (wait <= 0) {
        last = now;
        fn(...a);
      } else {
        timer = setTimeout(() => {
          last = Date.now();
          fn(...a);
        }, wait);
      }
    };
  };

  NS.truncate = (s, n) => {
    const str = String(s ?? '');
    if (str.length <= n) return str;
    return `${str.slice(0, n)}\n\n…（内容过长已截断）`;
  };

  NS.formatTime = (d = new Date()) =>
    `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

  /**
   * 复制文本。
   *
   * 面试鸭这类站点会拦复制：在 document 上挂一个 copy 监听然后 preventDefault。
   * 所以顺序很重要：
   *   1. navigator.clipboard.writeText —— 扩展声明了 clipboardWrite 权限，
   *      这条路走的是权限而不是事件，压根不产生 copy 事件，站点拦不到
   *   2. document.execCommand('copy') 兜底 —— 它一定会产生 copy 事件，
   *      所以临时在 window 的捕获阶段插一个护盾，把站点的拦截器挡在外面
   */
  NS.copyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* 落到兜底 */
    }

    let ta = null;
    const shield = (e) => e.stopImmediatePropagation();
    try {
      ta = document.createElement('textarea');
      ta.value = text;
      // 固定定位 + 透明，避免滚动页面，也别让站点看见
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
      ta.setAttribute('readonly', '');
      document.body.append(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);

      // window + 捕获阶段：这是事件路径的最前端，挂在这里才挡得住
      window.addEventListener('copy', shield, true);
      document.addEventListener('copy', shield, true);
      const ok = document.execCommand('copy');
      return Boolean(ok);
    } catch {
      return false;
    } finally {
      window.removeEventListener('copy', shield, true);
      document.removeEventListener('copy', shield, true);
      ta?.remove();
    }
  };

  /** 生成短 id（实现放在 shared/config.js，设置页也要用） */
  NS.uid = NS.uid || (() => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);
})();
