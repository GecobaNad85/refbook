// 工具书查词 · Tauri 前端逻辑 —— 展示形式与浏览器扩展一致
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function truncate(str, maxLen) {
  return str.length <= maxLen ? str : str.slice(0, maxLen) + '…';
}
function bookUrl(item) {
  return item.readonlineUrl || '';
}

// 弹窗模式：由 popup:query 事件触发切换（不依赖 URL hash，因为 Tauri 2 的 hash 设置时序不可靠）
// 主窗口模式：默认初始化，收到 popup:query 时切换为弹窗
let popupInited = false;
const popupState = { expandedFirst: false, firstFullText: '' };
let popupResults = [];
let popupKeyword = '';
let popupContainer = null;

// 先初始化主窗口
initMain();

// 监听 popup:query —— 若主窗口收到，说明当前窗口实际是弹窗，切换视图
listen('popup:query', (e) => {
  if (!popupInited) {
    // 隐藏主窗口视图，显示弹窗视图
    document.getElementById('main-view').hidden = true;
    popupContainer = document.getElementById('popup-view');
    popupContainer.hidden = false;
    popupInited = true;
  }
  lookupPopup(e.payload);
});

listen('popup:message', (e) => {
  if (!popupInited) {
    document.getElementById('main-view').hidden = true;
    popupContainer = document.getElementById('popup-view');
    popupContainer.hidden = false;
    popupInited = true;
  }
  const m = e.payload;
  popupContainer.innerHTML = `<div class="tb-popup"><div class="tb-body"><div class="${m.isError ? 'tb-error-msg' : 'tb-loading-msg'}">${esc(m.msg)}</div></div></div>`;
});

function lookupPopup(word) {
  popupKeyword = word;
  popupState.expandedFirst = false;
  popupState.firstFullText = '';
  popupContainer.innerHTML = `<div class="tb-popup"><div class="tb-body"><div class="tb-loading-msg"><span class="tb-spinner"></span>正在CNKI工具书总库查询...</div></div></div>`;
  invoke('cnki_search', { word, size: 5 }).then((j) => {
    if (!j.ok) {
      popupContainer.innerHTML = `<div class="tb-popup"><div class="tb-body"><div class="tb-error-msg">${esc(j.error || '查询失败')}</div></div></div>`;
      return;
    }
    popupResults = j.results || [];
    renderPopupResults();
    if (popupResults.length && popupResults[0].fn) fetchPopupFullText();
  }).catch((e) => {
    popupContainer.innerHTML = `<div class="tb-popup"><div class="tb-body"><div class="tb-error-msg">请求出错：${esc(String(e))}</div></div></div>`;
  });
}

function renderPopupResults() {
  renderResults(popupContainer, popupResults, popupKeyword, popupState, () => fetchPopupFullText(), onPopupExpand, () => {
    invoke('popup_open_external', { url: 'https://gongjushu.cnki.net/rbook/search/simplesearch?key=' + encodeURIComponent(popupKeyword) });
  });
}

function fetchPopupFullText() {
  const first = popupResults[0];
  if (!first) return;
  invoke('cnki_detail', { fn_: first.fn, tablename: first.tablename, product: first.product }).then((d) => {
    popupState.firstFullText = d.ok ? d.content : '';
    popupState.expandedFirst = true;
    renderPopupResults();
  }).catch(() => {});
}

function onPopupExpand(toggle, target) {
  const raw = decodeURIComponent(toggle.dataset.raw || '');
  const abstractDiv = toggle.closest('.tb-abstract');
  if (target.textContent === '展开') {
    abstractDiv.innerHTML = esc(raw) + `<span class="tb-expand-toggle" data-raw="${encodeURIComponent(raw)}">收起</span>`;
  } else {
    abstractDiv.innerHTML = esc(truncate(raw, 500)) + `<span class="tb-expand-toggle" data-raw="${encodeURIComponent(raw)}">展开</span>`;
  }
}

// ---------- 共享：渲染单条结果（与扩展 renderResultItem 一致）----------
// state: { expandedFirst, firstFullText }
function renderResultItem(item, index, state) {
  const isFirst = index === 0;
  let abstractHtml;
  let mayHaveBtn = false;

  if (!state.expandedFirst) {
    const maxChars = isFirst ? 500 : 200;
    abstractHtml = esc(truncate(item.abstract || '', maxChars));
    mayHaveBtn = isFirst && item.fn ? true : false;
  } else if (isFirst) {
    const displayText = state.firstFullText !== '' ? state.firstFullText : (item.abstract || '');
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
  } else {
    abstractHtml = esc(truncate(item.abstract || '', 200));
    mayHaveBtn = false;
  }

  const bookLinkHtml = bookUrl(item)
    ? `<a class="tb-book-link" data-url="${esc(bookUrl(item))}">《${esc(item.bookName)}》</a>`
    : `《${esc(item.bookName)}》`;

  return `
    <div class="tb-result ${index > 0 ? 'tb-result-border' : ''}">
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

// 渲染整个结果列表到容器
function renderResults(container, results, keyword, state, onFullText, onExpand, onFooter) {
  if (!results || results.length === 0) {
    container.innerHTML = `
      <div class="tb-popup">
        <div class="tb-header">
          <span class="tb-title">CNKI工具书总库</span>
          <button class="tb-close" data-act="close">×</button>
        </div>
        <div class="tb-body">
          <div class="tb-empty-msg">在CNKI工具书总库中未找到相关释义</div>
        </div>
      </div>`;
    return;
  }
  container.innerHTML = `
    <div class="tb-popup">
      <div class="tb-header">
        <span class="tb-title">CNKI工具书总库</span>
        <span class="tb-count">${results.length} 条结果</span>
      </div>
      <div class="tb-body">
        ${results.map((item, i) => renderResultItem(item, i, state)).join('')}
      </div>
      <a class="tb-footer" data-act="footer">在CNKI工具书总库查看更多释义 →</a>
    </div>`;

  // 事件委托
  container.onclick = (e) => {
    if (!(e.target instanceof Element)) return;
    if (e.target.classList.contains('tb-fulltext-btn') && onFullText) { onFullText(); return; }
    const toggle = e.target.closest('.tb-expand-toggle');
    if (toggle && onExpand) { onExpand(toggle, e.target); return; }
    const bookLink = e.target.closest('.tb-book-link');
    if (bookLink && bookLink.dataset.url) { invoke('popup_open_external', { url: bookLink.dataset.url }); return; }
    if (e.target.classList.contains('tb-close')) { invoke('popup_close'); return; }
    if (e.target.closest('.tb-footer') && onFooter) { onFooter(); return; }
  };
}

function loadingHtml(msg) {
  return `<div class="tb-popup"><div class="tb-body"><div class="tb-loading-msg"><span class="tb-spinner"></span>${esc(msg || '正在CNKI工具书总库查询...')}</div></div></div>`;
}

// 主窗口：结果项作为独立卡片直接列在搜索框下方（不套弹窗容器）
function renderMainResults(container, results, state, onFullText, onExpand) {
  if (!results || results.length === 0) {
    container.innerHTML = '<div class="main-empty">在CNKI工具书总库中未找到相关释义</div>';
    return;
  }
  container.innerHTML = results.map((item, i) => renderResultItem(item, i, state)).join('');
  container.onclick = (e) => {
    if (!(e.target instanceof Element)) return;
    if (e.target.classList.contains('tb-fulltext-btn') && onFullText) { onFullText(); return; }
    const toggle = e.target.closest('.tb-expand-toggle');
    if (toggle && onExpand) { onExpand(toggle, e.target); return; }
    const bookLink = e.target.closest('.tb-book-link');
    if (bookLink && bookLink.dataset.url) { invoke('popup_open_external', { url: bookLink.dataset.url }); return; }
  };
}

// ---------- 主窗口 ----------
function initMain() {
  document.getElementById('main-view').hidden = false;
  const input = document.getElementById('word-input');
  const searchBtn = document.getElementById('search-btn');
  const resultsEl = document.getElementById('results');
  const statusDot = document.getElementById('status-dot');

  let lastResults = [];
  let lastKeyword = '';
  const state = { expandedFirst: false, firstFullText: '' };

  invoke('cnki_ping').then((ok) => { statusDot.className = 'status ' + (ok ? 'ok' : 'bad'); })
    .catch(() => { statusDot.className = 'status bad'; });

  function rerender() {
    renderMainResults(resultsEl, lastResults, state, onFullText, onExpand);
  }

  async function doSearch() {
    const word = input.value.trim();
    if (!word) return;
    lastKeyword = word;
    state.expandedFirst = false;
    state.firstFullText = '';
    resultsEl.innerHTML = '<div class="main-loading"><span class="tb-spinner"></span> 正在CNKI工具书总库查询 "' + esc(word) + '"...</div>';
    try {
      const j = await invoke('cnki_search', { word, size: 8 });
      if (!j.ok) {
        resultsEl.innerHTML = '<div class="main-error">' + esc(j.error || '查询失败') + '</div>';
        return;
      }
      lastResults = j.results || [];
      rerender();
      if (lastResults.length && lastResults[0].fn) {
        fetchFullText();
      }
    } catch (e) {
      resultsEl.innerHTML = '<div class="main-error">请求出错：' + esc(String(e)) + '</div>';
    }
  }

  async function fetchFullText() {
    const first = lastResults[0];
    if (!first) return;
    try {
      const d = await invoke('cnki_detail', { fn_: first.fn, tablename: first.tablename, product: first.product });
      state.firstFullText = d.ok ? d.content : '';
      state.expandedFirst = true;
      rerender();
    } catch (e) { /* 静默失败，保留按钮 */ }
  }

  function onFullText() { fetchFullText(); }
  function onExpand(toggle, target) {
    const raw = decodeURIComponent(toggle.dataset.raw || '');
    const abstractDiv = toggle.closest('.tb-abstract');
    if (target.textContent === '展开') {
      abstractDiv.innerHTML = esc(raw) + `<span class="tb-expand-toggle" data-raw="${encodeURIComponent(raw)}">收起</span>`;
    } else {
      abstractDiv.innerHTML = esc(truncate(raw, 500)) + `<span class="tb-expand-toggle" data-raw="${encodeURIComponent(raw)}">展开</span>`;
    }
  }
  function onFooter() {
    invoke('popup_open_external', { url: 'https://gongjushu.cnki.net/rbook/search/simplesearch?key=' + encodeURIComponent(lastKeyword) });
  }

  searchBtn.addEventListener('click', doSearch);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
}
