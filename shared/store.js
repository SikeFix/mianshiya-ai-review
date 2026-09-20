/**
 * 配置读写。统一用 chrome.storage.local —— 不用 sync，
 * 因为里面有 API Key，不应该同步到 Google 账号。
 */
(function () {
  const KEY = 'msy_settings';

  const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

  /** 用默认值补齐缺失字段；数组整体替换，不做逐项合并。 */
  function deepMerge(base, override) {
    if (!isPlainObject(base) || !isPlainObject(override)) {
      return override === undefined ? base : override;
    }
    const out = { ...base };
    for (const [k, v] of Object.entries(override)) {
      out[k] = isPlainObject(base[k]) && isPlainObject(v) ? deepMerge(base[k], v) : v;
    }
    return out;
  }

  const listeners = new Set();

  async function get() {
    let raw;
    try {
      raw = (await chrome.storage.local.get(KEY))[KEY];
    } catch {
      raw = undefined;
    }
    return deepMerge(MSY.DEFAULT_SETTINGS, raw || {});
  }

  async function set(patch) {
    const next = deepMerge(await get(), patch || {});
    await chrome.storage.local.set({ [KEY]: next });
    return next;
  }

  /** 用回调改写配置，回调收到当前值、返回要合并的补丁。 */
  async function update(fn) {
    const current = await get();
    const patch = (await fn(current)) || {};
    return set(patch);
  }

  /** 订阅配置变化（跨上下文都能收到）。返回取消订阅函数。 */
  function onChange(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[KEY]) return;
      const next = deepMerge(MSY.DEFAULT_SETTINGS, changes[KEY].newValue || {});
      for (const cb of listeners) {
        try {
          cb(next);
        } catch (e) {
          console.error('[MSY] settings listener failed', e);
        }
      }
    });
  }

  /* ------------------------------ 方案相关 ------------------------------ */

  /** 取当前生效的 AI 方案。找不到就退回到第一个。 */
  function activeProfile(settings) {
    const list = settings.profiles || [];
    return list.find((p) => p.id === settings.activeProfileId) || list[0] || null;
  }

  /** 去掉末尾斜杠，保证拼接 /chat/completions 时不会出现双斜杠。 */
  function normalizeBaseUrl(url) {
    return String(url || '').trim().replace(/\/+$/, '');
  }

  /** 由 baseUrl 推出需要申请的 host 权限匹配串，例：https://api.deepseek.com/* */
  function originPattern(baseUrl) {
    try {
      const u = new URL(normalizeBaseUrl(baseUrl));
      return `${u.protocol}//${u.hostname}${u.port ? ':' + u.port : ''}/*`;
    } catch {
      return null;
    }
  }

  /**
   * 确保当前上下文有访问该 baseUrl 的权限。
   * 扩展页（options / popup）里会弹出授权框，必须由用户手势触发。
   * service worker 里没有这个 API，所以调用前先判断。
   */
  async function ensureHostPermission(baseUrl) {
    const pattern = originPattern(baseUrl);
    if (!pattern) return { ok: false, error: '接口地址填得不对，无法解析出域名。' };
    if (!chrome.permissions || !chrome.permissions.request) return { ok: true };

    const has = await chrome.permissions.contains({ origins: [pattern] });
    if (has) return { ok: true };

    const granted = await chrome.permissions.request({ origins: [pattern] });
    return granted
      ? { ok: true }
      : { ok: false, error: `没有获得访问 ${pattern} 的授权，请求发不出去。请重新点一次并选择「允许」。` };
  }

  MSY.store = {
    KEY,
    get,
    set,
    update,
    onChange,
    deepMerge,
    activeProfile,
    normalizeBaseUrl,
    originPattern,
    ensureHostPermission,
  };
})();
