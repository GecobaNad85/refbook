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
// readonlineUrl (bar.cnki.net) 校验 Referer 必须来自 *.cnki.net；桌面应用经系统浏览器
// 打开属"非CNKI域"，直接跳会被拒（来源应用不正确）。需先经 gongjushu.cnki.net 中转
// （#cnki_redirect 由扩展脚本再跳原文页；未装扩展时落在 gongjushu 条目详情页，同样合法）。
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

// SegmentIt / OpenCC 就绪 Promise（10s 超时；失败则各自降级）
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

// 对文本进行分词，生成候选词段
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

// OpenCC 繁→简；不可用或超时返回 null
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
// state: { expandedKey, expandedFullText }；key 为该项在扁平列表中的索引字符串
function renderResultItem(item, key, state, firstKey) {
  const isExpanded = state.expandedKey === key;
  const isFirst = key === firstKey;
  let abstractHtml;
  let mayHaveBtn = false;

  if (!isExpanded) {
    const maxChars = isFirst ? 500 : 200;
    abstractHtml = esc(truncate(item.abstract || '', maxChars));
    mayHaveBtn = isFirst && item.fn ? true : false;
  } else {
    const displayText = state.expandedFullText !== '' ? state.expandedFullText : (item.abstract || '');
    if (displayText) {
      if (displayText.length > 500) {
        abstractHtml = esc(truncate(displayText, 500))
          + `<span class="tb-expand-toggle" data-raw="${encodeURIComponent(displayText)}">展开</span>`;
      } else {
        abstractHtml = esc(displayText);
      }
    } else {
      abstractHtml = '<span style="color:#999;font-size:12px;">获取释文失败，可尝试点击下方按钮</span>';
      mayHaveBtn = true;
    }
  }

  const entryUrl = getBookEntryUrl(item);
  const bookLinkHtml = entryUrl
    ? `<a class="tb-book-link" data-url="${esc(entryUrl)}">《${esc(item.bookName)}》</a>`
    : `《${esc(item.bookName)}》`;

  return `
    <div class="tb-result ${key !== '0' ? 'tb-result-border' : ''}">
      <div class="tb-word">${esc(item.title)}</div>
      <div class="tb-abstract">${abstractHtml}</div>
      ${mayHaveBtn ? '<button class="tb-fulltext-btn">查看全文</button>' : ''}
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

  // 自定义窗口控制按钮（替代 Linux 下常失灵的原生标题栏）
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

  // 当前查询的全部结果：currentGroups = [{ seg, items }]（seg=null 表示整词命中）
  let currentGroups = [];
  let currentKeyword = '';
  let renderedItems = []; // 扁平化结果项，供事件委托按索引定位
  // 搜索代数：作废过期异步回调（用户发起新查询后，旧查询结果不再渲染）
  let generation = 0;
  const state = { expandedKey: null, expandedFullText: '' };

  function setLoading(msg) {
    resultsEl.innerHTML = '<div class="main-loading"><span class="tb-spinner"></span> ' + esc(msg) + '</div>';
  }
  function renderError(msg) {
    resultsEl.innerHTML = '<div class="main-error">' + esc(msg || '查询失败') + '</div>';
  }
  function renderEmpty() {
    resultsEl.innerHTML = '<div class="main-empty">在CNKI工具书总库中未找到相关释义</div>';
  }

  function render() {
    if (renderedItems.length === 0) { renderEmpty(); return; }
    let html = '';
    let idx = 0;
    for (const g of currentGroups) {
      if (g.seg) {
        html += `<div class="tb-segment-header">分词检索：<b>${esc(g.seg)}</b> · ${g.items.length} 条</div>`;
      }
      for (const item of g.items) {
        html += renderResultItem(item, String(idx), state, '0');
        idx++;
      }
    }
    resultsEl.innerHTML = html;
  }

  resultsEl.onclick = (e) => {
    if (!(e.target instanceof Element)) return;
    if (e.target.classList.contains('tb-fulltext-btn')) { onFullText(); return; }
    const toggle = e.target.closest('.tb-expand-toggle');
    if (toggle) { onExpand(toggle); return; }
    const bookLink = e.target.closest('.tb-book-link');
    if (bookLink && bookLink.dataset.url) { invoke('popup_open_external', { url: bookLink.dataset.url }); return; }
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
      currentGroups = [{ seg: null, items: data }];
      currentKeyword = keyword;
      renderedItems = data.slice();
      state.expandedKey = null;
      state.expandedFullText = '';
      render();
      autoFetchFirst(gen);
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

    currentKeyword = keyword;
    currentGroups = selected.map((r) => ({ seg: r.seg.text, items: r.results }));
    renderedItems = currentGroups.flatMap((g) => g.items);
    state.expandedKey = null;
    state.expandedFullText = '';
    let html = '<div class="tb-segment-note">整词未命中，以下为分词检索结果：</div>';
    let idx = 0;
    for (const g of currentGroups) {
      html += `<div class="tb-segment-header">分词检索：<b>${esc(g.seg)}</b> · ${g.items.length} 条</div>`;
      for (const item of g.items) {
        html += renderResultItem(item, String(idx), state, '0');
        idx++;
      }
    }
    resultsEl.innerHTML = html;
    autoFetchFirst(gen);
    return true;
  }

  // 划词/搜索主流程：原文链（整词+分词）→ 无结果时繁→简兜底再查一遍
  async function doLookup(keyword) {
    const gen = ++generation;
    let hit = await runQueryChain(keyword, gen);
    if (gen !== generation) return;
    if (hit) return;
    // 繁→简兜底
    setLoading('未命中，正在尝试简体补查...');
    const simplified = await toSimplified(keyword);
    if (gen !== generation) return;
    if (!simplified || simplified === keyword) { renderEmpty(); return; }
    hit = await runQueryChain(simplified, gen);
    if (gen !== generation) return;
    if (!hit) renderEmpty();
  }

  function autoFetchFirst(gen) {
    const first = renderedItems[0];
    if (first && first.fn) {
      state.expandedKey = '0';
      fetchFullText(first, gen);
    }
  }
  function onFullText() {
    const first = renderedItems[0];
    if (!first) return;
    state.expandedKey = '0';
    fetchFullText(first, generation);
  }
  async function fetchFullText(item, gen) {
    try {
      const d = await invoke('cnki_detail', { fn_: item.fn, tablename: item.tablename, product: item.product });
      if (gen !== generation) return;
      state.expandedFullText = d.ok ? d.content : '';
      render();
    } catch (e) { /* 静默失败，保留按钮 */ }
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
