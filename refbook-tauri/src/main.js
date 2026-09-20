// 工具书查词 · Tauri 前端逻辑 —— 展示形式与浏览器扩展一致
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function truncate(str, maxLen) {
  return str.length <= maxLen ? str : str.slice(0, maxLen) + '…';
}
// 生成工具书条目链接 —— 与浏览器扩展 getBookEntryUrl 一致
// readonlineUrl (bar.cnki.net) 校验 Referer 必须来自 *.cnki.net；桌面应用经内置 webview
// 打开 gongjushu.cnki.net 中转页（Referer 建立），由注入脚本读取 #cnki_redirect 跳到原文页。
// 无 readonlineUrl 但有 fn 时跳到 gongjushu 条目详情页；两者都没有返回 null（渲染纯文本）。
function getBookEntryUrl(item) {
  if (item.readonlineUrl) {
    return `https://gongjushu.cnki.net/rbook/detail?Fn=${encodeURIComponent(item.fn || '')}#cnki_redirect=${encodeURIComponent(item.readonlineUrl)}`;
  }
  if (item.fn) {
    return `https://gongjushu.cnki.net/rbook/detail?Fn=${encodeURIComponent(item.fn)}${item.bid ? '&Bid=' + encodeURIComponent(item.bid) : ''}`;
  }
  return null;
}

// ---------- 弹窗：仅用于提示信息（查询结果在主窗口展示）----------
let popupInited = false;
let popupContainer = null;

// 弹窗窗口（加载 popup.html）只注册 popup:message 监听，不跑主窗口逻辑。
// 主窗口绝不能处理 popup:message——即便 Rust 侧 emit_to 已定向到 popup，
// 也避免任何全局事件泄漏到主窗口的 popup-view（index.html 已移除该节点）。
const isPopupWindow = window.__TAURI__.window.getCurrentWindow().label === 'popup';

if (!isPopupWindow) {
  initMain();
}

if (isPopupWindow) {
  // 弹窗仅承载单条提示信息（如"未检测到选中文本"）；带操作的确认对话
  // （如已登录退出确认）已改用原生 tauri-plugin-dialog，不再经此弹窗。
  listen('popup:message', (e) => {
    if (!popupInited) {
      popupContainer = document.getElementById('popup-view');
      if (!popupContainer) return;
      popupContainer.hidden = false;
      popupInited = true;
    }
    const m = e.payload;
    // 多行消息（含 \n）用 white-space: pre-line 渲染
    const msgHtml = `<div class="${m.isError ? 'tb-error-msg' : 'tb-loading-msg'}" style="white-space:pre-line;">${esc(m.msg)}</div>`;
    popupContainer.innerHTML = `
      <div class="tb-popup">
        <div class="tb-header">
          <span class="tb-title">工具书查词</span>
          <button class="tb-close" data-act="close">×</button>
        </div>
        <div class="tb-body">${msgHtml}</div>
      </div>`;
    popupContainer.onclick = (e2) => {
      if (!(e2.target instanceof Element)) return;
      if (e2.target.dataset.act === 'close') invoke('popup_close');
    };
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') invoke('popup_close');
  });
}

// ============================================================
// 分词与繁简转换（移植自浏览器扩展 content.js，去 sandbox 直接用 CDN 全局）
// ============================================================

let _segmentitPromise = null;
let _openccPromise = null;
let _segmenter = null;
function waitForSegmentit() {
  if (window.Segmentit) return Promise.resolve(window.Segmentit);
  if (!_segmentitPromise) {
    _segmentitPromise = new Promise((resolve) => {
      const start = Date.now();
      const t = setInterval(() => {
        if (window.Segmentit) { clearInterval(t); resolve(window.Segmentit); }
        else if (Date.now() - start > 10000) { clearInterval(t); resolve(null); }
      }, 100);
    });
  }
  return _segmentitPromise;
}
function waitForOpencc() {
  if (window.OpenCC) return Promise.resolve(window.OpenCC);
  if (!_openccPromise) {
    _openccPromise = new Promise((resolve) => {
      const start = Date.now();
      const t = setInterval(() => {
        if (window.OpenCC) { clearInterval(t); resolve(window.OpenCC); }
        else if (Date.now() - start > 10000) { clearInterval(t); resolve(null); }
      }, 100);
    });
  }
  return _openccPromise;
}

// 滑动窗口分词（SegmentIt 加载失败时的回退方案）
function slidingWindowSegment(text) {
  const chars = Array.from(text);
  const len = chars.length;
  if (len < 4) return [];
  const segments = [];
  const seen = new Set();
  const MAX_SEGS = 12;
  function addSeg(start, length) {
    if (start + length > len) return;
    const s = chars.slice(start, start + length).join('');
    if (!seen.has(s)) {
      seen.add(s);
      segments.push({ text: s, start, end: start + length, len: length });
    }
  }
  const lengths = len >= 6 ? [4, 3, 2] : [3, 2];
  for (const l of lengths) {
    for (let i = 0; i <= len - l; i++) {
      addSeg(i, l);
      if (segments.length >= MAX_SEGS) break;
    }
    if (segments.length >= MAX_SEGS) break;
  }
  return segments;
}

// 预切分用的标点集合（中英文标点）。模块级常量，避免每次调用重新分配。
const PRE_SPLIT_PUNCT = new Set([
  '，', '。', '、', '：', '；', '·', '・', '•', '─', '—',
  ',', '.', ':', ';', '·', '・', '•', '－', '-',
  '（', '）', '(', ')', '《', '》', '〈', '〉',
  '「', '」', '『', '』', '"', '"', "'", "'", '"', "'",
  '？', '！', '?', '!', '…', '～', '~',
  '【', '】', '[', ']', '｛', '｝', '{', '}',
  '　', ' ', '\t', '\n', '\r', '/', '\\', '|',
]);
const PRE_SPLIT_MAX_SEGS = 12; // 与 slidingWindowSegment 一致，限制并发查询数

// 判断字符是否为中文（CJK 统一汉字 + 扩展A + 兼容汉字 + 扩展B+）
function isChineseChar(ch) {
  const code = ch.codePointAt(0);
  return (code >= 0x4E00 && code <= 0x9FFF)    // CJK 统一汉字
      || (code >= 0x3400 && code <= 0x4DBF)    // CJK 扩展A
      || (code >= 0xF900 && code <= 0xFAFF)    // CJK 兼容汉字
      || (code >= 0x20000 && code <= 0x2FA1F); // CJK 扩展B+ 及兼容补充
}
// 判断是否为拉丁字母/数字（含全角拉丁字母与全角数字）
function isLatinChar(ch) {
  const code = ch.codePointAt(0);
  return (code >= 0x41 && code <= 0x5A)       // A-Z
      || (code >= 0x61 && code <= 0x7A)       // a-z
      || (code >= 0x30 && code <= 0x39)       // 0-9
      || (code >= 0xFF21 && code <= 0xFF3A)   // Ａ-Ｚ 全角
      || (code >= 0xFF41 && code <= 0xFF5A)   // ａ-ｚ 全角
      || (code >= 0xFF10 && code <= 0xFF19);  // ０-９ 全角
}

// 预切分：在 SegmentIt 分词之前，先按标点和中英文边界拆分。
// 适用于用户划选了带标点的短语（如"人之初，性本善"）或中英混合词（如"AI人工智能"）。
// 返回 [{text, start, end, len}]，不适用（与原词无差异）时返回 null。
function preSplitText(text) {
  const chars = Array.from(text);
  const len = chars.length;
  if (len < 2) return null;

  // 第一步：按标点切分成段
  const punctSegments = [];
  let segStart = 0;
  for (let i = 0; i < len; i++) {
    if (PRE_SPLIT_PUNCT.has(chars[i])) {
      if (i > segStart) {
        punctSegments.push({ start: segStart, end: i });
      }
      segStart = i + 1;
    }
  }
  if (len > segStart) {
    punctSegments.push({ start: segStart, end: len });
  }

  // 第二步：对每段做中英文分离
  // 逐字符扫描，语言类型变化时断开（中文段、英文段交替）
  const segments = [];
  for (const seg of punctSegments) {
    let langStart = seg.start;
    let currentType = null; // 'zh' | 'latin' | 'other'
    for (let i = seg.start; i < seg.end; i++) {
      const ch = chars[i];
      const type = isChineseChar(ch) ? 'zh' : (isLatinChar(ch) ? 'latin' : 'other');
      if (currentType === null) {
        currentType = type;
      } else if (type !== currentType && type !== 'other' && currentType !== 'other') {
        // 语言边界：中文↔英文切换，断开
        if (i > langStart) {
          segments.push({ start: langStart, end: i });
        }
        langStart = i;
        currentType = type;
      } else if (type === 'other') {
        // other 字符不改变当前语言段，但也不断开（附属于当前段）
        // 若 currentType 也是 other（连续 other），保持
      } else if (currentType === 'other') {
        // 从 other 进入中文/英文
        if (i > langStart) {
          segments.push({ start: langStart, end: i });
        }
        langStart = i;
        currentType = type;
      }
    }
    if (seg.end > langStart) {
      segments.push({ start: langStart, end: seg.end });
    }
  }

  // 过滤太短的段（单字符）并构造结果，限制最大段数以约束并发查询
  const result = [];
  for (const seg of segments) {
    const segText = chars.slice(seg.start, seg.end).join('');
    const segLen = seg.end - seg.start;
    if (segLen >= 2) {
      result.push({ text: segText, start: seg.start, end: seg.end, len: segLen });
      if (result.length >= PRE_SPLIT_MAX_SEGS) break;
    }
  }

  if (result.length === 0) return null;
  // 若唯一结果就是原词本身（未发生标点剥离或语言切分），预切分无增益——交给 SegmentIt。
  // 注意：带首尾标点（如"人工智能。"）或单侧被长度过滤的中英混合（如"AI啊"）在此都会
  // 产生与原词不同的结果文本，从而不被跳过。
  if (result.length === 1 && result[0].text === text) return null;

  // 去重
  const seen = new Set();
  return result.filter(s => {
    if (seen.has(s.text)) return false;
    seen.add(s.text);
    return true;
  });
}

// SegmentIt 智能分词（带 POS 过滤），返回 [{text,start,end,len}]；失败返回 null
async function segmentWithSegmentIt(text) {
  const Segmentit = await waitForSegmentit();
  if (!Segmentit) return null;
  try {
    if (!_segmenter) {
      _segmenter = new Segmentit.Segment();
      Segmentit.useDefault(_segmenter);
    }
    const tokens = _segmenter.doSegment(text);
    if (!tokens || !tokens.length) return null;
    const MEANINGFUL_POS = new Set([64, 128, 32, 16, 8, 256, 1048576, 16384]);
    const PUNCT_CHARS = new Set(['·', '・', '•', '。', '，', '、', '：', '；']);
    const segments = [];
    let pos = 0;
    for (const token of tokens) {
      const word = token.w;
      const wordChars = Array.from(word || '');
      const wordLenCp = wordChars.length;
      const wordLenUtf16 = (word || '').length;
      if (wordLenCp < 2) { pos += wordLenUtf16; continue; }
      if (wordChars.some((ch) => PUNCT_CHARS.has(ch))) { pos += wordLenUtf16; continue; }
      const idx = text.indexOf(word, pos);
      if (idx === -1) { pos += wordLenUtf16; continue; }
      const hasMeaningfulPos = MEANINGFUL_POS.has(token.p) || (token.p === 0 && wordLenCp >= 3);
      if (hasMeaningfulPos) {
        const start = Array.from(text.slice(0, idx)).length;
        segments.push({ text: word, start, end: start + wordLenCp, len: wordLenCp });
      }
      pos = idx + wordLenUtf16;
    }
    const seen = new Set();
    return segments.filter((s) => { if (seen.has(s.text)) return false; seen.add(s.text); return true; });
  } catch (e) {
    return null;
  }
}

async function segmentKeywordSmart(text) {
  const smartSegs = await segmentWithSegmentIt(text);
  if (smartSegs && smartSegs.length > 0) return smartSegs;
  return slidingWindowSegment(text);
}

// 从有结果的词段中贪心选取互不重叠的子集（优先长词、靠前的词）
function selectNonOverlapping(segmentsWithResults, textLen) {
  segmentsWithResults.sort((a, b) => b.seg.len - a.seg.len || a.seg.start - b.seg.start);
  const occupied = new Array(textLen).fill(false);
  const selected = [];
  for (const r of segmentsWithResults) {
    let overlaps = false;
    for (let i = r.seg.start; i < r.seg.end; i++) { if (occupied[i]) { overlaps = true; break; } }
    if (!overlaps) {
      selected.push(r);
      for (let i = r.seg.start; i < r.seg.end; i++) occupied[i] = true;
    }
  }
  selected.sort((a, b) => a.seg.start - b.seg.start);
  return selected;
}

// 并行查询一批词段，返回 [{seg, results}]（失败或无结果时 results 为 []）
async function querySegments(segs) {
  return Promise.all(
    segs.map((seg) =>
      invoke('cnki_search', { word: seg.text, size: 5 })
        .then((r) => ({ seg, results: r && r.ok ? (r.results || []) : [] }))
        .catch(() => ({ seg, results: [] }))
    )
  );
}

async function toSimplified(text) {
  const OpenCC = await waitForOpencc();
  if (!OpenCC) return null;
  try {
    const conv = OpenCC.Converter({ from: 't', to: 'cn' });
    return conv(text);
  } catch (e) {
    return null;
  }
}

// ---------- 共享：渲染单条结果 ----------
// 每条结果独立维护展开状态与全文（item._expanded / _fullText / _fetchError），
// 因此非首条结果也可点击"查看全文"获取并展开自身释文。
// API 返回的 item 不带这些字段（undefined），需经 normalizeItem 初始化为空值，
// 否则 `_fullText !== ''` 之类判空会因 undefined 而误判，导致自动取全文永不触发。
function normalizeItem(item) {
  item._expanded = false;
  item._fullText = '';
  item._fetchError = '';
  return item;
}
function renderResultItem(item, idx) {
  const isExpanded = !!item._expanded;
  const isFirst = idx === 0;
  // 能否取全文：cnki_detail_auth 经 readonlineUrl 跳转渲染释文，无 readonlineUrl 则无法取
  const canFetch = !!item.readonlineUrl;
  let abstractHtml;
  let mayHaveBtn = false;
  let btnText = '查看全文';

  if (!isExpanded) {
    const maxChars = isFirst ? 500 : 200;
    abstractHtml = esc(truncate(item.abstract || '', maxChars));
    mayHaveBtn = canFetch;
  } else {
    // 已展开：使用完整释文（如果已获取到）或摘要兜底
    const fullTextLoaded = item._fullText !== '';
    const loading = item._fetchError === '加载中…';
    const displayText = fullTextLoaded ? item._fullText : (item.abstract || '');
    if (displayText) {
      if (displayText.length > 500) {
        abstractHtml = esc(truncate(displayText, 500))
          + `<span class="tb-expand-toggle" role="button" tabindex="0" data-raw="${encodeURIComponent(displayText)}">展开</span>`;
      } else {
        abstractHtml = esc(displayText);
      }
      // 全文未成功获取（仅以摘要兜底展示）时保留"查看全文"按钮供重试
      if (canFetch && !fullTextLoaded) {
        mayHaveBtn = true;
        if (loading) {
          btnText = '加载中…';
          abstractHtml += '<div style="color:#999;font-size:12px;margin-top:4px;">正在获取全文…</div>';
        } else if (item._fetchError) {
          abstractHtml += `<div style="color:#b94a48;font-size:12px;margin-top:4px;">${esc(item._fetchError)}，可点击下方按钮重试</div>`;
        }
      }
    } else if (loading) {
      abstractHtml = '<span style="color:#999;font-size:12px;">正在获取全文…</span>';
      mayHaveBtn = canFetch;
      btnText = '加载中…';
    } else {
      // 全文和摘要均为空，显示提示并保留"查看全文"按钮
      const err = item._fetchError ? esc(item._fetchError) : '获取释文失败';
      abstractHtml = `<span style="color:#b94a48;font-size:12px;">${err}，<a class="tb-book-link" role="link" tabindex="0" data-act="login">点此登录 CNKI</a> 后重试</span>`;
      mayHaveBtn = canFetch;
    }
  }

  const entryUrl = getBookEntryUrl(item);
  const bookLinkHtml = entryUrl
    ? `<a class="tb-book-link" role="link" tabindex="0" data-url="${esc(entryUrl)}">《${esc(item.bookName)}》</a>`
    : `《${esc(item.bookName)}》`;

  return `
    <div class="tb-result">
      <div class="tb-word">${esc(item.title)}</div>
      <div class="tb-abstract">${abstractHtml}</div>
      ${mayHaveBtn ? `<button class="tb-fulltext-btn" data-idx="${idx}">${btnText}</button>` : ''}
      <div class="tb-source">来源：${bookLinkHtml}</div>
      <div class="tb-meta">
        ${item.subject ? `<span class="tb-tag">${esc(item.subject)}</span>` : ''}
      </div>
    </div>
  `;
}

// ============================================================
// 主窗口
// ============================================================
function initMain() {
  const input = document.getElementById('word-input');
  const searchBtn = document.getElementById('search-btn');
  const resultsEl = document.getElementById('results');
  const statusDot = document.getElementById('status-dot');

  // 连接状态点：绿 = 可达 CNKI API；查询级失败（网络/服务不可用）时联动变红
  function setStatus(ok) { statusDot.className = 'status ' + (ok ? 'ok' : 'bad'); }

  // 首次启动的引导空态（发起查询后即被 loading/结果替换）
  function renderWelcome() {
    resultsEl.innerHTML = `
      <div class="main-welcome">
        <img class="welcome-logo" src="/assets/homelogoimg.png" alt="工具书查词" />
        <div class="welcome-title">在上方输入词目开始查询，或在任意页面选中文字后按 <b>Ctrl+Alt+D</b></div>
        <div class="welcome-sub">在CNKI工具书中查询词条，从托盘菜单CNKI登录你的（机构）账号，使用你的订购权限查看词条全文。</div>
      </div>`;
  }
  renderWelcome();

  initWindowControls();

  // 划词快捷键（Ctrl+Alt+D）唤起主窗口后自动查询
  listen('main:query', (e) => {
    const word = String(e.payload || '').trim();
    if (!word) return;
    input.value = word;
    doLookup(word);
  });

  invoke('cnki_ping').then(setStatus).catch(() => setStatus(false));

  // 标签状态：每个 tab 含 { keyword, items }；items 各自带 _expanded/_fullText/_fetchError
  let tabs = [];          // [{ keyword, items }]
  let activeIndex = 0;
  let currentKeyword = '';
  // 搜索代数：作废过期异步回调
  let generation = 0;
  // 取全文串行锁：cnki_detail_auth 在 Rust 侧有独占锁（detail_busy），并发调用会被拒。
  // 此标志在前端先拦一道，避免点击不同条目的"查看全文"时第二个拿到"正在获取其他条目"报错。
  let fetchInProgress = false;

  function setLoading(msg) {
    resultsEl.innerHTML = '<div class="main-loading"><span class="tb-spinner"></span> ' + esc(msg) + '</div>';
  }
  function renderError(msg) {
    resultsEl.innerHTML = '<div class="main-error">' + esc(msg || '查询失败') + '</div>';
  }
  function renderEmpty() {
    resultsEl.innerHTML = '<div class="main-empty">在CNKI工具书总库中未找到相关释义</div>';
  }

  // 渲染当前标签集（标签头横向并排 + 活动标签内容）
  function render() {
    if (tabs.length === 0) { renderEmpty(); return; }
    const showTabs = tabs.length > 1;
    let html = '';
    if (showTabs) {
      html += '<div class="tb-tabs" role="tablist">';
      tabs.forEach((t, i) => {
        // 原词标签（index 0）即使无结果也显示；分词标签只显示有结果的
        if (i !== 0 && t.items.length === 0) return;
        const cls = i === activeIndex ? 'tb-tab active' : 'tb-tab';
        const cnt = t.items.length > 0 ? `<span class="tb-tab-count">${t.items.length}</span>` : '';
        html += `<div class="${cls}" role="tab" tabindex="0" aria-selected="${i === activeIndex}" data-tab="${i}">${esc(t.keyword)}${cnt}</div>`;
      });
      html += '</div>';
    }
    const tab = tabs[activeIndex];
    if (!tab || tab.items.length === 0) {
      html += '<div class="main-empty">该分词未命中结果</div>';
    } else {
      html += tab.items.map((item, idx) => renderResultItem(item, idx)).join('');
    }
    resultsEl.innerHTML = html;
  }

  resultsEl.onclick = (e) => {
    if (!(e.target instanceof Element)) return;
    // 切换标签
    const tabBtn = e.target.closest('.tb-tab');
    if (tabBtn && tabBtn.dataset.tab != null) {
      activeIndex = Number(tabBtn.dataset.tab);
      render();
      autoFetchActive(generation);
      return;
    }
    if (e.target.classList.contains('tb-fulltext-btn')) {
      onFullText(Number(e.target.dataset.idx));
      return;
    }
    const toggle = e.target.closest('.tb-expand-toggle');
    if (toggle) { onExpand(toggle); return; }
    const loginLink = e.target.closest('[data-act="login"]');
    if (loginLink) { invoke('open_cnki_login'); return; }
    const bookLink = e.target.closest('.tb-book-link');
    if (bookLink && bookLink.dataset.url) { invoke('open_entry_url', { url: bookLink.dataset.url }); return; }
  };

  // 键盘可操作性：tab/展开收起/来源与登录链接均为非原生元素，Enter/空格等同点击
  resultsEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const t = e.target;
    if (!(t instanceof Element)) return;
    if (t.closest('.tb-tab, .tb-expand-toggle, .tb-book-link, [data-act="login"]')) {
      e.preventDefault();
      t.click();
    }
  });

  // ---------- 查询链（移植扩展 runQueryChain / queryWithSegmentation）----------
  // 返回 true 表示已渲染（含错误/空），不再兜底；false 表示整链无结果，可继续繁→简兜底
  async function runQueryChain(keyword, gen) {
    setLoading('正在CNKI工具书总库查询 "' + keyword + '"...');
    let j;
    try {
      j = await invoke('cnki_search', { word: keyword, size: 8 });
    } catch (e) {
      if (gen !== generation) return true;
      setStatus(false);
      renderError('请求出错：' + String(e));
      return true;
    }
    if (gen !== generation) return true;
    // 网络级失败在 Rust 侧也以 ok=false 返回（error 以"网络错误"开头），统一按 ok 联动状态点。
    // 放在 stale-check 之后，避免被后续查询盖掉的旧请求回写状态点。
    setStatus(!!j.ok);
    if (!j.ok) { renderError(j.error); return true; }

    const data = j.results || [];
    if (data.length > 0) {
      // 整词命中：单标签，不显示标签头
      tabs = [{ keyword, items: data.map(normalizeItem) }];
      activeIndex = 0;
      currentKeyword = keyword;
      render();
      autoFetchActive(gen);
      return true;
    }

    // 整词未命中 → 合并预切分 + SegmentIt 分词，去重后并行查询
    setLoading('整词未命中，正在分词检索...');
    const preSegs = preSplitText(keyword) || [];
    const smartSegs = await segmentKeywordSmart(keyword);
    if (gen !== generation) return true;
    // 合并两路候选词段，按文本去重（避免预切分与 SegmentIt 重复查询同一关键词）。
    // 不再因预切分部分命中就短路——SegmentIt 可能切出更细的词段（如"经济"+"发展"），
    // 否则这些细粒度命中会被永久丢弃。
    const seenText = new Set();
    const allSegs = [];
    for (const seg of [...preSegs, ...(smartSegs || [])]) {
      if (!seenText.has(seg.text)) { seenText.add(seg.text); allSegs.push(seg); }
    }
    if (allSegs.length === 0) return false;

    const queryResults = await querySegments(allSegs);
    if (gen !== generation) return true;
    const withResults = queryResults.filter((r) => r.results.length > 0);
    if (withResults.length === 0) return false;

    const textLen = Array.from(keyword).length;
    const selected = selectNonOverlapping(withResults, textLen);
    if (selected.length === 0) return false;

    // 构建标签：[原词(空)] + 各命中分词
    tabs = [
      { keyword, items: [] },
      ...selected.map((r) => ({ keyword: r.seg.text, items: r.results.map(normalizeItem) })),
    ];
    activeIndex = 1; // 第一个有结果的分词标签
    currentKeyword = keyword;
    render();
    autoFetchActive(gen);
    return true;
  }

  // 划词/搜索主流程：原文链（整词+分词）→ 无结果时繁→简兜底再查一遍
  async function doLookup(keyword) {
    const gen = ++generation;
    let hit = await runQueryChain(keyword, gen);
    if (gen !== generation) return;
    if (hit) return;
    setLoading('未命中，正在尝试简体补查...');
    const simplified = await toSimplified(keyword);
    if (gen !== generation) return;
    if (!simplified || simplified === keyword) { renderEmpty(); return; }
    hit = await runQueryChain(simplified, gen);
    if (gen !== generation) return;
    if (!hit) renderEmpty();
  }

  // 自动获取活动标签首条的完整释文（与扩展 autoFetchExpandFirst 一致）
  function autoFetchActive(gen) {
    const tab = tabs[activeIndex];
    if (!tab || tab.items.length === 0) return;
    const first = tab.items[0];
    // 完整性判断：仅当首条具备 readonlineUrl（可经详情页跳转渲染全文）且尚未展开时
    // 才自动获取。fn 不足以判定——cnki_detail_auth 必须靠 readonlineUrl 跳转，
    // 缺失时只会返回"该条目没有跳转链接"报错，污染首条展示。
    if (!first.readonlineUrl || first._expanded || first._fullText !== '') return;
    fetchFullText(first, gen);
  }
  function onFullText(idx) {
    const tab = tabs[activeIndex];
    if (!tab) return;
    const item = tab.items[idx];
    if (!item) return; // idx 越界/NaN 时安全 no-op
    if (item._fetchError === '加载中…') return; // 本条正在获取，忽略重复点击
    fetchFullText(item, generation);
  }
  async function fetchFullText(item, gen) {
    // 串行锁：Rust 侧 detail_busy 同一时刻只允许一个取全文任务，前端先拦并发
    if (fetchInProgress) {
      item._expanded = true;
      item._fetchError = '正在获取其他条目全文，请稍候重试';
      render();
      return;
    }
    fetchInProgress = true;
    // 状态转移统一在此完成，调用方不再预置 _expanded
    item._expanded = true;
    item._fullText = '';
    item._fetchError = '加载中…';
    render();
    try {
      // 先检查登录态：已登录静默走详情页流程；未登录只提示去登录，
      // 不再出现"点查看全文就触发登录、点了又显示已登录"的矛盾。
      const st = await invoke('cnki_login_status');
      if (gen !== generation) return;
      if (!st.loggedIn) {
        item._fullText = '';
        item._fetchError = st.error || '未登录 CNKI，请先在托盘菜单点击"CNKI 登录…"';
        render();
        return;
      }
      // 唯一主路径：在 cnki-auth webview 里导航到条目的跳转链接，
      // 页面渲染出 p.image_box 释文后由 Rust 侧 eval 轮询取回。
      // 注意：Tauri 将 Rust 参数名 fn_ 重命名为 fn，invoke 须传 fn。
      // 不再回退裸 entry/detail API——实测它即使带 invoice/nonce 也返回
      // "系统异常"，只会给出误导性报错。
      const d = await invoke('cnki_detail_auth', {
        fn: item.fn,
        tablename: item.tablename,
        product: item.product,
        readonlineUrl: item.readonlineUrl || '',
      });
      if (gen !== generation) return;
      // ok=true 但 content 为空：条目释文即摘要（p.image_box 无额外正文），
      // 退回摘要作为全文，标记已加载（避免重试按钮误导用户）
      if (d.ok && !d.content) {
        item._fullText = item.abstract || '';
        item._fetchError = '';
      } else {
        item._fullText = d.ok ? d.content : '';
        item._fetchError = d.ok ? '' : (d.error || '获取释文失败');
      }
      render();
    } catch (e) {
      if (gen !== generation) return;
      item._fetchError = '请求出错：' + String(e);
      render();
    } finally {
      fetchInProgress = false;
    }
  }
  function onExpand(toggle) {
    const raw = decodeURIComponent(toggle.dataset.raw || '');
    const abstractDiv = toggle.closest('.tb-abstract');
    const toggleAttrs = 'role="button" tabindex="0"';
    const label = toggle.textContent === '展开' ? '收起' : '展开';
    const body = label === '收起' ? esc(raw) : esc(truncate(raw, 500));
    abstractDiv.innerHTML = body + `<span class="tb-expand-toggle" ${toggleAttrs} data-raw="${encodeURIComponent(raw)}">${label}</span>`;
    // innerHTML 重置会销毁原 toggle（可能正持有键盘焦点），重建后将焦点回填到新 toggle，
    // 避免焦点掉到 <body> 迫使键盘用户从头重新 Tab。
    abstractDiv.querySelector('.tb-expand-toggle')?.focus();
  }

  async function doSearch() {
    const word = input.value.trim();
    if (!word || searchBtn.disabled) return;
    // 查询链期间禁用按钮防连点（generation 机制仍在，双保险）
    searchBtn.disabled = true;
    try {
      await doLookup(word);
    } finally {
      searchBtn.disabled = false;
    }
  }

  searchBtn.addEventListener('click', doSearch);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
}

// 自定义窗口控制：最小化 / 最大化·还原 / 关闭（关闭→隐藏到托盘，与原生一致）
function initWindowControls() {
  const w = window.__TAURI__.window.getCurrentWindow();
  const minBtn = document.getElementById('win-min');
  const maxBtn = document.getElementById('win-max');
  const closeBtn = document.getElementById('win-close');
  minBtn && minBtn.addEventListener('click', () => { try { w.minimize(); } catch (_) {} });
  closeBtn && closeBtn.addEventListener('click', () => { try { w.close(); } catch (_) {} });
  async function refreshMax() {
    try {
      const m = await w.isMaximized();
      if (maxBtn) maxBtn.classList.toggle('is-max', m);
    } catch (_) {}
  }
  maxBtn && maxBtn.addEventListener('click', async () => {
    try { await w.toggleMaximize(); } catch (_) {}
    refreshMax();
  });
  try { w.onResized(() => refreshMax()); } catch (_) {}
  refreshMax();
}
