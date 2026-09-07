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

initMain();

listen('popup:message', (e) => {
  if (!popupInited) {
    document.getElementById('main-view').hidden = true;
    popupContainer = document.getElementById('popup-view');
    popupContainer.hidden = false;
    popupInited = true;
  }
  const m = e.payload;
  popupContainer.innerHTML = `
    <div class="tb-popup">
      <div class="tb-header">
        <span class="tb-title">工具书查词</span>
        <button class="tb-close" data-act="close">×</button>
      </div>
      <div class="tb-body">
        <div class="${m.isError ? 'tb-error-msg' : 'tb-loading-msg'}">${esc(m.msg)}</div>
      </div>
    </div>`;
  popupContainer.onclick = (e2) => {
    if (e2.target instanceof Element && e2.target.classList.contains('tb-close')) {
      invoke('popup_close');
    }
  };
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') invoke('popup_close');
});

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

// ---------- 共享：渲染单条结果（与扩展 renderResultItem 一致）----------
// tab: { keyword, items, fullText, expanded } —— 每个标签独立维护展开状态与全文
function renderResultItem(item, idx, tab) {
  const isExpanded = tab.expanded && idx === 0;
  const isFirst = idx === 0;
  let abstractHtml;
  let mayHaveBtn = false;
  let btnText = '查看全文';

  if (!isExpanded) {
    const maxChars = isFirst ? 500 : 200;
    abstractHtml = esc(truncate(item.abstract || '', maxChars));
    mayHaveBtn = isFirst && item.fn ? true : false;
  } else {
    // 已展开且是首条：使用完整释文（如果已获取到）或摘要兜底
    const fullTextLoaded = tab.fullText !== '';
    const loading = tab.fetchError === '加载中…';
    const displayText = fullTextLoaded ? tab.fullText : (item.abstract || '');
    if (displayText) {
      if (displayText.length > 500) {
        abstractHtml = esc(truncate(displayText, 500))
          + `<span class="tb-expand-toggle" data-raw="${encodeURIComponent(displayText)}">展开</span>`;
      } else {
        abstractHtml = esc(displayText);
      }
      // 全文未成功获取（仅以摘要兜底展示）时保留"查看全文"按钮供重试
      if (isFirst && item.fn && !fullTextLoaded) {
        mayHaveBtn = true;
        if (loading) {
          btnText = '加载中…';
          abstractHtml += '<div style="color:#999;font-size:12px;margin-top:4px;">正在获取全文…</div>';
        } else if (tab.fetchError) {
          abstractHtml += `<div style="color:#b94a48;font-size:12px;margin-top:4px;">${esc(tab.fetchError)}，可点击下方按钮重试</div>`;
        }
      }
    } else if (loading) {
      abstractHtml = '<span style="color:#999;font-size:12px;">正在获取全文…</span>';
      mayHaveBtn = isFirst && item.fn;
      btnText = '加载中…';
    } else {
      // 全文和摘要均为空，显示提示并保留"查看全文"按钮
      const err = tab.fetchError ? esc(tab.fetchError) : '获取释文失败';
      abstractHtml = `<span style="color:#b94a48;font-size:12px;">${err}，<a class="tb-book-link" data-act="login">点此登录 CNKI</a> 后重试</span>`;
      mayHaveBtn = true;
    }
  }

  const entryUrl = getBookEntryUrl(item);
  const bookLinkHtml = entryUrl
    ? `<a class="tb-book-link" data-url="${esc(entryUrl)}">《${esc(item.bookName)}》</a>`
    : `《${esc(item.bookName)}》`;

  return `
    <div class="tb-result ${idx > 0 ? 'tb-result-border' : ''}">
      <div class="tb-word">${esc(item.title)}</div>
      <div class="tb-abstract">${abstractHtml}</div>
      ${mayHaveBtn ? `<button class="tb-fulltext-btn">${btnText}</button>` : ''}
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
  document.getElementById('main-view').hidden = false;
  const input = document.getElementById('word-input');
  const searchBtn = document.getElementById('search-btn');
  const resultsEl = document.getElementById('results');
  const statusDot = document.getElementById('status-dot');

  initWindowControls();

  // 划词快捷键（Ctrl+Alt+D）唤起主窗口后自动查询
  listen('main:query', (e) => {
    const word = String(e.payload || '').trim();
    if (!word) return;
    input.value = word;
    doLookup(word);
  });

  invoke('cnki_ping').then((ok) => { statusDot.className = 'status ' + (ok ? 'ok' : 'bad'); })
    .catch(() => { statusDot.className = 'status bad'; });

  // 标签状态（移植扩展 tabState）：整词命中为单标签（不显示标签头）；分词命中为多标签
  let tabs = [];          // [{ keyword, items, fullText, expanded }]
  let activeIndex = 0;
  let currentKeyword = '';
  // 搜索代数：作废过期异步回调
  let generation = 0;

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
      html += '<div class="tb-tabs">';
      tabs.forEach((t, i) => {
        // 原词标签（index 0）即使无结果也显示；分词标签只显示有结果的
        if (i !== 0 && t.items.length === 0) return;
        const cls = i === activeIndex ? 'tb-tab active' : 'tb-tab';
        const cnt = t.items.length > 0 ? `<span class="tb-tab-count">${t.items.length}</span>` : '';
        html += `<div class="${cls}" data-tab="${i}">${esc(t.keyword)}${cnt}</div>`;
      });
      html += '</div>';
    }
    const tab = tabs[activeIndex];
    if (!tab || tab.items.length === 0) {
      html += '<div class="main-empty">该分词未命中结果</div>';
    } else {
      html += tab.items.map((item, idx) => renderResultItem(item, idx, tab)).join('');
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
    if (e.target.classList.contains('tb-fulltext-btn')) { onFullText(); return; }
    const toggle = e.target.closest('.tb-expand-toggle');
    if (toggle) { onExpand(toggle); return; }
    const loginLink = e.target.closest('[data-act="login"]');
    if (loginLink) { invoke('open_cnki_login'); return; }
    const bookLink = e.target.closest('.tb-book-link');
    if (bookLink && bookLink.dataset.url) { invoke('open_entry_url', { url: bookLink.dataset.url }); return; }
  };

  // ---------- 查询链（移植扩展 runQueryChain / queryWithSegmentation）----------
  // 返回 true 表示已渲染（含错误/空），不再兜底；false 表示整链无结果，可继续繁→简兜底
  async function runQueryChain(keyword, gen) {
    setLoading('正在CNKI工具书总库查询 "' + keyword + '"...');
    let j;
    try {
      j = await invoke('cnki_search', { word: keyword, size: 8 });
    } catch (e) {
      if (gen !== generation) return true;
      renderError('请求出错：' + String(e));
      return true;
    }
    if (gen !== generation) return true;
    if (!j.ok) { renderError(j.error); return true; }

    const data = j.results || [];
    if (data.length > 0) {
      // 整词命中：单标签，不显示标签头
      tabs = [{ keyword, items: data, fullText: '', expanded: false, fetchError: '' }];
      activeIndex = 0;
      currentKeyword = keyword;
      render();
      autoFetchActive(gen);
      return true;
    }

    // 整词未命中 → 分词并行查询
    setLoading('整词未命中，正在分词检索...');
    const segments = await segmentKeywordSmart(keyword);
    if (gen !== generation) return true;
    if (!segments || segments.length === 0) return false;

    const queryResults = await Promise.all(
      segments.map((seg) =>
        invoke('cnki_search', { word: seg.text, size: 5 })
          .then((r) => ({ seg, results: r && r.ok ? (r.results || []) : [] }))
          .catch(() => ({ seg, results: [] }))
      )
    );
    if (gen !== generation) return true;
    const withResults = queryResults.filter((r) => r.results.length > 0);
    if (withResults.length === 0) return false;

    const textLen = Array.from(keyword).length;
    const selected = selectNonOverlapping(withResults, textLen);
    if (selected.length === 0) return false;

    // 构建标签：[原词(空)] + 各命中分词
    tabs = [
      { keyword, items: [], fullText: '', expanded: false, fetchError: '' },
      ...selected.map((r) => ({ keyword: r.seg.text, items: r.results, fullText: '', expanded: false, fetchError: '' })),
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
    if (!first.fn || tab.fullText !== '' || tab.expanded) return;
    tab.expanded = true;
    fetchFullText(tab, first, gen);
  }
  function onFullText() {
    const tab = tabs[activeIndex];
    if (!tab) return;
    if (tab.fetchError === '加载中…') return; // 正在获取，忽略重复点击
    tab.expanded = true;
    fetchFullText(tab, tab.items[0], generation);
  }
  async function fetchFullText(tab, item, gen) {
    tab.expanded = true;
    tab.fullText = '';
    tab.fetchError = '加载中…';
    render();
    try {
      // 优先走带 cookie 的鉴权路径（需 CNKI 登录）；失败回退裸 API
      // 注意：Tauri 将 Rust 参数名 fn_ 重命名为 fn，invoke 须传 fn
      let d = await invoke('cnki_detail_auth', { fn: item.fn, tablename: item.tablename, product: item.product });
      if (!d.ok) {
        try {
          d = await invoke('cnki_detail', { fn: item.fn, tablename: item.tablename, product: item.product });
        } catch (_) {}
      }
      if (gen !== generation) return;
      tab.fullText = d.ok ? d.content : '';
      tab.fetchError = d.ok ? '' : (d.error || '获取释文失败');
      render();
    } catch (e) {
      if (gen !== generation) return;
      tab.fetchError = '请求出错：' + String(e);
      render();
    }
  }
  function onExpand(toggle) {
    const raw = decodeURIComponent(toggle.dataset.raw || '');
    const abstractDiv = toggle.closest('.tb-abstract');
    if (toggle.textContent === '展开') {
      abstractDiv.innerHTML = esc(raw) + `<span class="tb-expand-toggle" data-raw="${encodeURIComponent(raw)}">收起</span>`;
    } else {
      abstractDiv.innerHTML = esc(truncate(raw, 500)) + `<span class="tb-expand-toggle" data-raw="${encodeURIComponent(raw)}">展开</span>`;
    }
  }

  function onFooter() {
    invoke('popup_open_external', { url: 'https://gongjushu.cnki.net/rbook/search/simplesearch?key=' + encodeURIComponent(currentKeyword) });
  }

  async function doSearch() {
    const word = input.value.trim();
    if (!word) return;
    await doLookup(word);
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
