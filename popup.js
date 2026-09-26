/** 工具栏弹窗：看当前页面状态、切方案、一键展开面板。 */
(function () {
  const $ = (id) => document.getElementById(id);
  const S = MSY.store;

  let settings = null;
  let tab = null;
  let isQuestionPage = false;

  const setState = (text) => ($('stateText').textContent = text);

  function renderProfiles() {
    const sel = $('profile');
    sel.innerHTML = '';
    for (const p of settings.profiles) {
      sel.append(new Option(`${p.name}${p.model ? ` · ${p.model}` : ''}`, p.id));
    }
    sel.value = settings.activeProfileId || settings.profiles[0]?.id || '';
  }

  function renderQuestion(state) {
    const q = state?.question;
    const title = $('qTitle');
    const meta = $('qMeta');

    if (!isQuestionPage) {
      title.textContent = '当前页面不是面试鸭题目页';
      meta.textContent = '打开任意一道题，面板会自动出现';
      meta.className = 'qm';
      return;
    }
    if (!state?.mounted) {
      title.textContent = '面板已关闭';
      meta.textContent = '勾选上面的「启用面板」即可恢复';
      meta.className = 'qm warn';
      return;
    }
    if (!q?.title) {
      title.textContent = '正在识别题目…';
      meta.textContent = '';
      return;
    }
    title.textContent = q.title;
    if (q.hasAnswer) {
      meta.textContent = '✓ 已读取到本站参考答案';
      meta.className = 'qm ok';
    } else if (q.paywalled) {
      meta.textContent = '⚠ 答案需会员，AI 将用自己的知识回答';
      meta.className = 'qm warn';
    } else {
      meta.textContent = '· 页面上没有找到答案';
      meta.className = 'qm';
    }
  }

  async function askContent() {
    if (!tab?.id) return null;
    try {
      return await chrome.tabs.sendMessage(tab.id, { type: 'popup.state' });
    } catch {
      // 内容脚本没应答：要么不是面试鸭页面，要么页面刚打开还没注入
      return null;
    }
  }

  async function init() {
    settings = await S.get();
    renderProfiles();
    $('enabled').checked = Boolean(settings.enabled);

    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // 判断当前页面靠「内容脚本能不能应答」，而不是读 tab.url ——
    // 读 url 需要 tabs 权限（会多一条「读取浏览记录」的授权提醒），
    // 而且没有该权限时 url 会静默变成 undefined，判断直接失效。
    const state = await askContent();
    isQuestionPage = state !== null;

    $('linkSite').href = isQuestionPage ? tab?.url || 'https://www.mianshiya.com/questions' : 'https://www.mianshiya.com/questions';
    $('btnShow').disabled = !isQuestionPage;

    if (!isQuestionPage) {
      setState('不在面试鸭页面上');
      $('qbox').style.display = 'none';
    } else {
      setState(state.mounted ? '已注入' : '面板已关闭');
    }
    renderQuestion(state);
  }

  /* ------------------------------ 事件 ------------------------------ */

  $('enabled').addEventListener('change', async () => {
    settings = await S.set({ enabled: $('enabled').checked });
    setState($('enabled').checked ? '已启用' : '已停用');
    const state = await askContent();
    renderQuestion(state);
  });

  $('profile').addEventListener('change', async () => {
    settings = await S.set({ activeProfileId: $('profile').value });
    setState('已切换方案');
    setTimeout(() => setState('已注入'), 1200);
  });

  $('btnShow').addEventListener('click', async () => {
    if (!tab?.id) return;
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'panel.expand' });
      window.close();
    } catch {
      // 内容脚本没响应，可能页面是刚打开的，重新加载一次即可
      setState('页面还没加载完，刷新一下再试');
    }
  });

  $('btnReport').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('options.html#report') });
    window.close();
  });

  $('btnRandom').addEventListener('click', async () => {
    if (!tab?.id) return;
    // 让面板去挑：它知道当前页面上有哪些别的题
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'app.random' });
      window.close();
    } catch {
      setState('页面还没加载完，刷新一下再试');
    }
  });

  $('btnOptions').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  init().catch((e) => {
    console.error(e);
    setState('出错了');
  });
})();
