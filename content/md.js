/**
 * 轻量 Markdown 渲染。不引第三方库（保持零构建），
 * 重点保证 AI 回答里最常见的几类结构：代码块、表格、列表、加粗、行内代码。
 *
 * 流式输出的关键点：代码围栏可能只出现了一半（``` 开了没关），
 * 这时要把后半段当成代码渲染，否则用户会看到满屏乱跳的字面量 ```。
 */
(function () {
  const NS = globalThis.MSY;
  const esc = NS.escapeHtml;

  const FENCE = /^[ \t]*(`{3,}|~{3,})[ \t]*([\w+#.-]*)[ \t]*$/;

  /** 把原文切成 text / code 两种片段，容忍未闭合的围栏。 */
  function splitFences(src) {
    const lines = String(src ?? '').split('\n');
    const segs = [];
    let buf = [];
    let fence = null; // {marker, lang, body:[]}

    const flushText = () => {
      if (buf.length) {
        segs.push({ type: 'text', value: buf.join('\n') });
        buf = [];
      }
    };

    for (const line of lines) {
      const m = line.match(FENCE);
      if (fence) {
        // 闭合围栏：要求同种符号且长度不短于开头
        if (m && m[1][0] === fence.marker[0] && m[1].length >= fence.marker.length && !m[2]) {
          segs.push({ type: 'code', lang: fence.lang, value: fence.body.join('\n') });
          fence = null;
        } else {
          fence.body.push(line);
        }
      } else if (m) {
        flushText();
        fence = { marker: m[1], lang: m[2] || '', body: [] };
      } else {
        buf.push(line);
      }
    }
    if (fence) segs.push({ type: 'code', lang: fence.lang, value: fence.body.join('\n') });
    flushText();
    return segs;
  }

  const LANG_LABEL = {
    js: 'JavaScript', javascript: 'JavaScript', ts: 'TypeScript', tsx: 'TSX', jsx: 'JSX',
    py: 'Python', python: 'Python', java: 'Java', go: 'Go', golang: 'Go', rust: 'Rust',
    c: 'C', cpp: 'C++', 'c++': 'C++', cs: 'C#', csharp: 'C#', php: 'PHP', rb: 'Ruby',
    sql: 'SQL', sh: 'Shell', bash: 'Bash', shell: 'Shell', zsh: 'Shell', powershell: 'PowerShell',
    json: 'JSON', yaml: 'YAML', yml: 'YAML', xml: 'XML', html: 'HTML', css: 'CSS',
    scss: 'SCSS', less: 'Less', vue: 'Vue', kotlin: 'Kotlin', swift: 'Swift', scala: 'Scala',
    dockerfile: 'Dockerfile', nginx: 'Nginx', redis: 'Redis', text: '文本', txt: '文本',
  };

  /** 行内元素。入参必须是已经 escape 过的文本。 */
  function inline(s) {
    const codes = [];
    let out = s.replace(/`([^`\n]+)`/g, (_, c) => {
      codes.push(c);
      return `\u0000${codes.length - 1}\u0000`;
    });

    // 公式必须在强调之前抽出来，否则 a_i * b_j 里的星号会被当成斜体
    const maths = [];
    // 先处理 $$...$$（它常和正文写在同一行），再处理 $...$
    out = out.replace(/\$\$([^$\n]+?)\$\$/g, (_, tex) => {
      maths.push(`<span class="msy-math msy-math-display">${renderMath(tex)}</span>`);
      return `\u0001${maths.length - 1}\u0001`;
    });
    out = out.replace(/\$([^$\n]+?)\$/g, (_, tex) => {
      maths.push(renderMath(tex));
      return `\u0001${maths.length - 1}\u0001`;
    });

    out = out.replace(/\*\*([^\n]+?)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*\w])\*([^*\n]+?)\*(?![*\w])/g, '$1<em>$2</em>');
    out = out.replace(/~~([^\n]+?)~~/g, '<del>$1</del>');
    out = out.replace(
      /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>'
    );

    out = out.replace(/\u0001(\d+)\u0001/g, (_, i) => maths[Number(i)]);
    return out.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
  }

  const isTableSep = (line) => /^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/.test(line);

  function splitRow(line) {
    return line
      .replace(/^[ \t]*\|/, '')
      .replace(/\|[ \t]*$/, '')
      .split('|')
      .map((c) => c.trim());
  }

  function renderTable(rows) {
    const head = splitRow(rows[0]);
    const body = rows.slice(2).map(splitRow);
    const th = head.map((c) => `<th>${inline(esc(c))}</th>`).join('');
    const tb = body
      .map((r) => `<tr>${r.map((c) => `<td>${inline(esc(c))}</td>`).join('')}</tr>`)
      .join('');
    return `<div class="msy-table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div>`;
  }

  const UL = /^[ \t]*[-*+][ \t]+/;
  const OL = /^[ \t]*\d+[.)][ \t]+/;

  /** 渲染一段非代码文本的块级结构。 */
  function blocks(src) {
    const lines = String(src ?? '').split('\n');
    const out = [];
    let para = [];

    const flush = () => {
      if (!para.length) return;
      const joined = para.map((l) => inline(esc(l))).join('<br>');
      if (joined.trim()) out.push(`<p>${joined}</p>`);
      para = [];
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (!line.trim()) {
        flush();
        continue;
      }

      // 独占一行的公式 $$...$$
      if (/^\s*\$\$/.test(line)) {
        const head = line.replace(/^\s*\$\$/, '');
        const buf = [];
        if (/\$\$\s*$/.test(head)) {
          // 起止都在同一行：$$...$$
          buf.push(head.replace(/\$\$\s*$/, ''));
        } else {
          buf.push(head);
          i++;
          while (i < lines.length && !/\$\$\s*$/.test(lines[i])) {
            buf.push(lines[i]);
            i++;
          }
          if (i < lines.length) buf.push(lines[i].replace(/\$\$\s*$/, ''));
        }
        flush();
        out.push(`<div class="msy-math-block">${renderMath(esc(buf.join(' ').trim()))}</div>`);
        continue;
      }

      // 水平线
      if (/^[ \t]*([-*_])([ \t]*\1){2,}[ \t]*$/.test(line)) {
        flush();
        out.push('<hr>');
        continue;
      }

      // 标题
      const h = line.match(/^(#{1,6})[ \t]+(.+)$/);
      if (h) {
        flush();
        const lvl = Math.min(h[1].length + 2, 6); // h1 -> h3，避免盖过站点自身标题
        out.push(`<h${lvl}>${inline(esc(h[2]))}</h${lvl}>`);
        continue;
      }

      // 引用（支持连续多行）
      if (/^[ \t]*>[ \t]?/.test(line)) {
        flush();
        const quote = [];
        while (i < lines.length && /^[ \t]*>[ \t]?/.test(lines[i])) {
          quote.push(lines[i].replace(/^[ \t]*>[ \t]?/, ''));
          i++;
        }
        i--;
        out.push(`<blockquote>${quote.map((q) => inline(esc(q))).join('<br>')}</blockquote>`);
        continue;
      }

      // 表格：当前行是表头，下一行是分隔行
      if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        flush();
        const rows = [lines[i], lines[i + 1]];
        i += 2;
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
          rows.push(lines[i]);
          i++;
        }
        i--;
        out.push(renderTable(rows));
        continue;
      }

      // 无序列表
      if (UL.test(line)) {
        flush();
        const items = [];
        while (i < lines.length && UL.test(lines[i])) {
          items.push(lines[i].replace(UL, ''));
          i++;
          // 支持列表项的续行（缩进且不是新条目）
          while (i < lines.length && lines[i].trim() && !UL.test(lines[i]) && !OL.test(lines[i]) && /^[ \t]{2,}/.test(lines[i])) {
            items[items.length - 1] += ` ${lines[i].trim()}`;
            i++;
          }
        }
        i--;
        out.push(`<ul>${items.map((t) => `<li>${inline(esc(t))}</li>`).join('')}</ul>`);
        continue;
      }

      // 有序列表
      if (OL.test(line)) {
        flush();
        const items = [];
        while (i < lines.length && OL.test(lines[i])) {
          items.push(lines[i].replace(OL, ''));
          i++;
          while (i < lines.length && lines[i].trim() && !UL.test(lines[i]) && !OL.test(lines[i]) && /^[ \t]{2,}/.test(lines[i])) {
            items[items.length - 1] += ` ${lines[i].trim()}`;
            i++;
          }
        }
        i--;
        out.push(`<ol>${items.map((t) => `<li>${inline(esc(t))}</li>`).join('')}</ol>`);
        continue;
      }

      para.push(line);
    }

    flush();
    return out.join('');
  }

  function codeBlock(lang, value) {
    const key = String(lang || '').toLowerCase();
    const label = LANG_LABEL[key] || (lang ? esc(lang) : '代码');
    return (
      `<div class="msy-code">` +
      `<div class="msy-code-head"><span class="msy-code-lang">${label}</span>` +
      `<button type="button" class="msy-copy">复制</button></div>` +
      `<pre><code>${highlight(value, lang)}</code></pre>` +
      `</div>`
    );
  }

  /** 主入口：Markdown 文本 -> HTML 字符串 */
  function render(text) {
    return splitFences(text)
      .map((seg) => (seg.type === 'code' ? codeBlock(seg.lang, seg.value) : blocks(seg.value)))
      .join('');
  }

  /** 面板里点代码块的「复制」按钮。用事件委托，避免每次重渲染都要重绑。 */
  function bindCopy(root) {
    root.addEventListener('click', async (e) => {
      const btn = e.target.closest?.('.msy-copy');
      if (!btn) return;
      e.preventDefault();
      const code = btn.closest('.msy-code')?.querySelector('code')?.textContent ?? '';
      const ok = await NS.copyText(code);
      btn.textContent = ok ? '已复制' : '复制失败';
      btn.classList.toggle('msy-ok', ok);
      setTimeout(() => {
        btn.textContent = '复制';
        btn.classList.remove('msy-ok');
      }, 1400);
    });
  }

  /* ------------------------------ 代码高亮 ------------------------------ */

  /**
   * 轻量语法高亮。
   *
   * 同样不引 highlight.js：那是几百 KB，跟「零构建、单文件夹」的定位冲突。
   * 这里按「注释 / 字符串 / 数字 / 关键字 / 类型 / 函数名」六类做一次词法扫描，
   * 覆盖最常见的十几种语言。认不出的语言也至少能把字符串和注释区分出来 ——
   * 那已经是大半的观感提升。
   */

  const KW_COMMON_C = [
    'abstract', 'assert', 'async', 'await', 'bool', 'boolean', 'break', 'byte', 'case', 'catch',
    'char', 'class', 'const', 'continue', 'default', 'defer', 'delete', 'do', 'double', 'else',
    'enum', 'export', 'extends', 'false', 'final', 'finally', 'float', 'fn', 'for', 'from',
    'func', 'function', 'go', 'if', 'implements', 'import', 'in', 'instanceof', 'int', 'interface',
    'let', 'long', 'loop', 'match', 'mod', 'mut', 'namespace', 'new', 'nil', 'null', 'of',
    'package', 'private', 'protected', 'pub', 'public', 'range', 'return', 'self', 'short',
    'static', 'struct', 'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'trait',
    'transient', 'true', 'try', 'type', 'typeof', 'union', 'unsigned', 'use', 'using', 'var',
    'virtual', 'void', 'volatile', 'where', 'while', 'yield', 'void',
  ];

  const KW_PY = [
    'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif',
    'else', 'except', 'False', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is',
    'lambda', 'None', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'True', 'try', 'while',
    'with', 'yield',
  ];

  const KW_SQL = [
    'SELECT', 'FROM', 'WHERE', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'JOIN',
    'LEFT', 'RIGHT', 'INNER', 'OUTER', 'ON', 'GROUP', 'BY', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET',
    'CREATE', 'TABLE', 'INDEX', 'DROP', 'ALTER', 'ADD', 'AND', 'OR', 'NOT', 'NULL', 'AS', 'DISTINCT',
    'COUNT', 'SUM', 'AVG', 'MAX', 'MIN', 'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES', 'UNION', 'CASE',
    'WHEN', 'THEN', 'ELSE', 'END', 'ASC', 'DESC',
  ];

  const KW_SH = [
    'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done', 'case', 'esac', 'function',
    'return', 'export', 'local', 'readonly', 'source', 'echo', 'cd', 'set', 'unset', 'exit', 'in',
  ];

  /** 不同语言族的词表与注释符号 */
  function profileFor(lang) {
    const l = String(lang || '').toLowerCase();
    if (['py', 'python'].includes(l)) return { kw: KW_PY, hash: true };
    if (['sh', 'bash', 'zsh', 'shell', 'console'].includes(l)) return { kw: KW_SH, hash: true };
    if (['yaml', 'yml', 'toml', 'ini', 'conf', 'dockerfile', 'makefile', 'r', 'perl'].includes(l)) return { kw: [], hash: true };
    if (['sql', 'mysql', 'postgresql', 'psql'].includes(l)) return { kw: KW_SQL, dash: true };
    if (['ruby', 'rb'].includes(l)) return { kw: KW_PY, hash: true };
    if (['html', 'xml', 'vue', 'svg', 'markdown', 'md', 'text', 'txt', 'plain'].includes(l)) return { kw: [], html: true };
    if (['json', 'json5'].includes(l)) return { kw: ['true', 'false', 'null'], colon: true };
    // 其余都按 C 系处理：js/ts/java/go/rust/c/cpp/cs/php/swift/kotlin/scala/…
    return { kw: KW_COMMON_C, slash: true };
  }

  const RE_COMMENT_SLASH = '\\/\\*[\\s\\S]*?\\*\\/|\\/\\/[^\\n]*';
  const RE_STRING =
    '"""[\\s\\S]*?"""|\'\'\'[\\s\\S]*?\'\'\'|"(?:\\\\.|[^"\\\\\\n])*"|\'(?:\\\\.|[^\'\\\\\\n])*\'|`(?:\\\\.|[^`\\\\])*`';
  const RE_NUMBER = '\\b(?:0[xXbBoO][0-9a-fA-F_]+|\\d+(?:[._]\\d+)*(?:[eE][+-]?\\d+)?)\\b';

  const HL_CACHE = new Map();

  function highlighterFor(lang) {
    const key = String(lang || '').toLowerCase() || '_';
    if (HL_CACHE.has(key)) return HL_CACHE.get(key);
    const p = profileFor(key);
    const parts = [];
    if (p.slash) parts.push(`(?<c>${RE_COMMENT_SLASH})`);
    if (p.hash) parts.push('(?<c>#[^\\n]*)');
    if (p.dash) parts.push('(?<c>--[^\\n]*)');
    if (p.html) parts.push('(?<c><!--[\\s\\S]*?-->)');
    parts.push(`(?<s>${RE_STRING})`);
    if (!p.html) parts.push(`(?<n>${RE_NUMBER})`);
    if (p.kw?.length) parts.push(`(?<k>\\b(?:${p.kw.join('|')})\\b)`);
    if (!p.html && !p.colon) {
      parts.push('(?<t>\\b[A-Z][A-Za-z0-9_]*\\b)');
      parts.push('(?<f>\\b[A-Za-z_]\\w*(?=\\s*\\())');
    }
    const re = new RegExp(parts.join('|'), 'g');
    HL_CACHE.set(key, re);
    return re;
  }

  /** 把代码切成带样式的片段。入参是原始代码，转义在这里做 */
  function highlight(code, lang) {
    const src = String(code ?? '');
    const re = highlighterFor(lang);
    let out = '';
    let last = 0;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src))) {
      if (m.index > last) out += esc(src.slice(last, m.index));
      const g = m.groups || {};
      const cls = g.c ? 'c' : g.s ? 's' : g.n ? 'n' : g.k ? 'k' : g.t ? 't' : g.f ? 'f' : '';
      out += cls ? `<span class="msy-tok-${cls}">${esc(m[0])}</span>` : esc(m[0]);
      last = m.index + m[0].length;
      if (m[0].length === 0) re.lastIndex++; // 防死循环
    }
    out += esc(src.slice(last));
    return out;
  }

  /* ------------------------------ 数学公式 ------------------------------ */

  /**
   * 轻量 LaTeX 渲染。
   *
   * 不引 KaTeX：那要额外几百 KB 加一堆字体，跟「零构建、单文件夹」的定位冲突。
   * 这里覆盖面试题里真正会出现的写法 —— 上下标、分数、希腊字母、常见算子符号，
   * 剩下的命令原样保留成可读文本，总比满屏反斜杠强。
   */
  const GREEK = {
    alpha: 'α', beta: 'β', gamma: 'γ', Gamma: 'Γ', delta: 'δ', Delta: 'Δ',
    epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', Theta: 'Θ',
    iota: 'ι', kappa: 'κ', lambda: 'λ', Lambda: 'Λ', mu: 'μ', nu: 'ν', xi: 'ξ',
    pi: 'π', Pi: 'Π', rho: 'ρ', sigma: 'σ', Sigma: 'Σ', tau: 'τ', upsilon: 'υ',
    phi: 'φ', varphi: 'φ', Phi: 'Φ', chi: 'χ', psi: 'ψ', Psi: 'Ψ', omega: 'ω', Omega: 'Ω',
  };

  const SYMBOLS = {
    times: '×', cdot: '·', div: '÷', pm: '±', mp: '∓',
    le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', equiv: '≡', approx: '≈',
    in: '∈', notin: '∉', subset: '⊂', subseteq: '⊆', supset: '⊃', cup: '∪', cap: '∩',
    emptyset: '∅', forall: '∀', exists: '∃', neg: '¬', land: '∧', lor: '∨',
    sum: '∑', prod: '∏', int: '∫', oint: '∮', partial: '∂', nabla: '∇',
    to: '→', rightarrow: '→', leftarrow: '←', Rightarrow: '⇒', leftrightarrow: '↔',
    infty: '∞', ldots: '…', cdots: '⋯', dots: '…', propto: '∝',
    ll: '≪', gg: '≫', sim: '∼', simeq: '≃', star: '⋆', circ: '∘', bullet: '•',
    mathbb: '', mathcal: '', mathbf: '', mathrm: '', text: '', operatorname: '',
    quad: ' ', qquad: '  ', ',': ' ', ';': ' ', ':': ' ', '!': '',
  };

  const BBCAL = { R: 'ℝ', N: 'ℕ', Z: 'ℤ', Q: 'ℚ', C: 'ℂ', E: '𝔼', P: 'ℙ' };

  const MATH_ESCAPE = { '{': '{', '}': '}', '%': '%', '&': '&amp;', '#': '#', '$': '$', '_': '_' };

  /** 把一段 TeX 转成 HTML。入参必须是已经 escape 过的文本 */
  function renderMath(src) {
    let t = String(src ?? '').trim();

    // \ 换行
    t = t.replace(/\\\\/g, '<br>');

    // rac{a}{b} —— 支持嵌套一层括号
    t = t.replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g,
      (_, a, b) => `<span class="msy-frac"><span class="msy-num">${a}</span><span class="msy-den">${b}</span></span>`);

    // \sqrt{x} / \sqrt[n]{x}
    t = t.replace(/\\sqrt\s*\[([^{}]*)\]\s*\{([^{}]*)\}/g, '<span class="msy-root">$1</span>√<span class="msy-rad">$2</span>');
    t = t.replace(/\\sqrt\s*\{([^{}]*)\}/g, '√<span class="msy-rad">$1</span>');

    // \mathbb{R} 之类的空心字母
    t = t.replace(/\\(?:mathbb|mathcal|mathbf|mathrm)\s*\{([A-Za-z])\}/g,
      (_, c) => BBCAL[c.toUpperCase()] || c);

    // 	ext{中文}：直接留文字
    t = t.replace(/\\text\s*\{([^{}]*)\}/g, '$1');
    t = t.replace(/\\operatorname\s*\{([^{}]*)\}/g, '$1');

    // 上下标。先合并 {..} 里的多字符，再落到 sup/sub
    t = t.replace(/\^\s*\{([^{}]*)\}/g, '<sup>$1</sup>');
    t = t.replace(/_\s*\{([^{}]*)\}/g, '<sub>$1</sub>');
    t = t.replace(/\^\s*(\S)/g, '<sup>$1</sup>');
    t = t.replace(/_\s*(\S)/g, '<sub>$1</sub>');

    // 剩下的 \command：能翻的翻，翻不了的原样留着（去掉反斜杠更干净）
    t = t.replace(/\\([A-Za-z]+)/g, (m, name) => {
      if (GREEK[name] !== undefined) return GREEK[name];
      if (SYMBOLS[name] !== undefined) return SYMBOLS[name];
      return name;
    });

    // 分组花括号只是语法糖，渲染时去掉
    t = t.replace(/[{}]/g, '');

    return `<span class="msy-math">${t}</span>`;
  }

  /* ---------------------------- 选择题选项 ---------------------------- */

  /**
   * 从 AI 回复里抽出选择题选项。
   *
   * 判据刻意收得很紧：至少两个选项，字母必须从 A 开始连续，且每个选项独占一行。
   * 否则正文里随便一句「A. 」都会被当成选项 —— 技术回答里出现这种写法的概率不低。
   */
  function extractOptions(text) {
    const found = [];
    for (const line of String(text ?? '').split('\n')) {
      const m = line.match(/^\s*([A-H])[.、．)）:：]\s*(\S.*?)\s*$/);
      if (m) found.push({ letter: m[1], text: m[2] });
    }
    if (found.length < 2) return [];
    for (let i = 0; i < found.length; i++) {
      if (found[i].letter !== String.fromCharCode(65 + i)) return [];
    }
    return found;
  }

  /**
   * 判断这条消息是不是在问一道判断题。
   * 给「对 / 错」两个按钮用，比让人打字方便得多。
   */
  function looksLikeTrueFalse(text) {
    const t = String(text ?? '').trim();
    if (!t || extractOptions(t).length) return false;
    if (!/[?？]$/.test(t)) return false;
    return /(判断|对不对|是否正确|对还是错|说法对吗|这个说法|是不是)/.test(t.slice(-140));
  }

  NS.md = { render, bindCopy, extractOptions, looksLikeTrueFalse, highlight };
})();
