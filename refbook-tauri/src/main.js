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

// ---------- 弹窗：仅用于提示信息（查询结果在主窗口展示）----------
// 主窗口模式默认初始化；收到 popup:message 时说明当前窗口是提示弹窗，切换视图
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

// ESC 关闭弹窗（在主窗口中按 ESC 时 popup_close 为安全空操作）
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') invoke('popup_close');
});

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

  // 划词快捷键（Ctrl+Alt+D）唤起主窗口后自动查询
  listen('main:query', (e) => {
    const word = String(e.payload || '').trim();
    if (!word) return;
    input.value = word;
    doSearch();
  });

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
