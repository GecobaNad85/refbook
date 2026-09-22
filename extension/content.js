// CNKI工具书总库划词查询 - Content Script

const POPUP_ID = 'cnki-refbook-popup';
const LOADING_ID = 'cnki-refbook-loading';
const FAB_ID = 'cnki-refbook-fab';

// 提取元素文本并保留段落结构：块级元素结束与 <br> 转成换行（textContent 不反映
// 布局，直接用会把段落黏成一行）。输出压缩 3 个以上连续换行并去首尾空白。
function extractParagraphText(el) {
  const BLOCK = new Set(['P', 'DIV', 'LI', 'TR', 'SECTION', 'BLOCKQUOTE',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
  let out = '';
  (function walk(node) {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        out += child.textContent;
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        if (child.tagName === 'BR') { out += '\n'; continue; }
        walk(child);
        if (BLOCK.has(child.tagName)) out += '\n';
      }
    }
  })(el);
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

// API 返回的释文 HTML 字符串 → 保留段落结构的纯文本（经 DOMParser 复用上面的遍历）
function htmlToParagraphText(html) {
  try {
    return extractParagraphText(new DOMParser().parseFromString(html, 'text/html').body);
  } catch (_) {
    return html.replace(/<[^>]*>/g, '').trim();
  }
}

// 在 gongjushu.cnki.net 页面上捕获认证凭证和条目内容
(function captureAuthFromCnkiPage() {
  if (!window.location.hostname.endsWith('.cnki.net')) return;

  // 1. 从 URL 提取 invoice/nonce
  const urlParams = new URLSearchParams(window.location.search);
  const invoice = urlParams.get('invoice');
  const nonce = urlParams.get('nonce');

  if (invoice) {
    chrome.runtime.sendMessage({
      action: 'storeAuthToken',
      invoice: invoice,
      nonce: nonce || ''
    }).catch(() => {});

    // 2. 从 DOM 提取条目释文内容（如果存在）
    const imageBox = document.querySelector('p.image_box');
    if (imageBox) {
      const fn = urlParams.get('filename');
      if (fn) {
        const fullText = extractParagraphText(imageBox);
        chrome.runtime.sendMessage({
          action: 'cacheEntryContent',
          fn: fn,
          content: fullText
        }).catch(() => {});
      }
    }

    // 3. 设置 MutationObserver 监听 Vue SPA 渲染完成后的内容
    const observer = new MutationObserver(() => {
      const box = document.querySelector('p.image_box');
      if (box) {
        const fn = urlParams.get('filename');
        if (fn) {
          const fullText = extractParagraphText(box);
          chrome.runtime.sendMessage({
            action: 'cacheEntryContent',
            fn: fn,
            content: fullText
          }).catch(() => {});
        }
        observer.disconnect();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    // 5 秒后停止观察
    setTimeout(() => observer.disconnect(), 5000);
  }
})();

// 中转跳转：非CNKI页面点击条目链接后，先跳到 gongjushu.cnki.net（CNKI域内），
// 由这里的脚本再跳转到 bar.cnki.net 的原文页面，使 Referer 为 *.cnki.net
(function handleCnkiRedirect() {
  if (!window.location.hostname.endsWith('.cnki.net')) return;
  const hash = window.location.hash;
  const match = hash && hash.match(/#cnki_redirect=(.+)/);
  if (match) {
    const targetUrl = decodeURIComponent(match[1]);
    // 安全校验：仅允许跳转到 *.cnki.net 域，防止开放重定向攻击
    try {
      const u = new URL(targetUrl);
      if (u.protocol !== 'https:' || (!u.hostname.endsWith('.cnki.net') && u.hostname !== 'cnki.net')) {
        return; // 非法目标，不跳转
      }
    } catch (_) {
      return; // 无效 URL，不跳转
    }
    // 清除 hash 避免循环，然后跳转
    history.replaceState(null, '', window.location.pathname + window.location.search);
    location.href = targetUrl;
  }
})();

let popupVisible = false;
let lastKeyword = '';
let expandedFirstResult = false;  // 首条结果是否已展开
let firstResultFullText = '';     // 首条结果的完整释文
let lastResults = [];             // 最近一次查询结果（供重渲染使用）
let lastX = 0, lastY = 0;         // 最近一次鼠标坐标
let searchGeneration = 0;         // 搜索代数，用于检测过期的异步回调
let expandFetchGen = 0;           // 首条结果"展开/获取全文"的代数，用于取消被用户后续操作作废的异步获取
let popupMode = null;             // 'select' | 'search' | null，当前弹窗的来源
let searchInputValue = '';        // 图标入口搜索框的输入内容（跨重渲染保留）
let activeRerender = null;        // 当前活动面板的重渲染函数（供"查看全文"等异步重渲染调用）
let tabState = null;              // 分词查询标签状态：{ tabs: [{keyword,results,fullText,expanded,scrollTop}], activeIndex, x, y }
let lastRenderedTabIndex = -1;    // 上一次 renderTabbedResults 渲染的标签下标，用于区分“切标签”与“同标签重渲染”

// 注入唯一 ID，避免与宿主页面冲突
function ensurePopupContainer() {
  if (document.getElementById(POPUP_ID)) return;

  // 确保 CSS 已注入：manifest.json 的 content_scripts.css 仅在页面加载时注入，
  // 扩展安装/更新时已打开的标签页不会注入，需要动态补入
  injectPopupStyles();

  const container = document.createElement('div');
  container.id = POPUP_ID;
  container.style.cssText = `
    position: fixed;
    z-index: 2147483647;
    display: none;
  `;
  document.body.appendChild(container);
  setupPopupDelegation();
}

// 动态注入弹窗 CSS（仅一次，带去重守卫）
// 如果 manifest.css 已注入则规则相同不会冲突；如果未注入则作为兜底
function injectPopupStyles() {
  if (document.getElementById('cnki-tb-styles')) return;
  const style = document.createElement('style');
  style.id = 'cnki-tb-styles';
  style.textContent = `
    #cnki-refbook-popup { all: initial; position: fixed; z-index: 2147483647; display: none; }
    #cnki-refbook-popup .cnki-tb-popup {
      display: block; width: 380px; max-width: 90vw; max-height: 80vh; overflow-y: auto;
      background: #fff; border: 1px solid #e8e8e8; border-radius: 10px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.18);
      font-family: -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
      font-size: 14px; line-height: 1.6; color: #333;
    }
    #cnki-refbook-popup .cnki-tb-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 12px 16px; border-bottom: 1px solid #f0f0f0; background: #f8f9ff;
      border-radius: 10px 10px 0 0;
    }
    #cnki-refbook-popup .cnki-tb-title { font-size: 13px; font-weight: 600; color: #2347ff; }
    #cnki-refbook-popup .cnki-tb-count { font-size: 12px; color: #999; }
    #cnki-refbook-popup .cnki-tb-body { padding: 4px 0; }
    #cnki-refbook-popup .cnki-tb-result { padding: 12px 16px; }
    #cnki-refbook-popup .cnki-tb-result-border { border-top: 1px solid #f0f0f0; }
    #cnki-refbook-popup .cnki-tb-word { font-size: 15px; font-weight: 600; color: #222; margin-bottom: 4px; }
    #cnki-refbook-popup .cnki-tb-source { font-size: 12px; color: #888; margin-bottom: 6px; }
    #cnki-refbook-popup .cnki-tb-book-link { color: #2347ff; text-decoration: none; }
    #cnki-refbook-popup .cnki-tb-book-link:hover { text-decoration: underline; }
    #cnki-refbook-popup .cnki-tb-abstract { font-size: 13px; color: #555; line-height: 1.6; margin-bottom: 8px; white-space: pre-line; }
    #cnki-refbook-popup .cnki-tb-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    #cnki-refbook-popup .cnki-tb-tag {
      display: inline-block; font-size: 11px; color: #2347ff; background: #d0e3ff;
      padding: 2px 8px; border-radius: 3px;
    }
    #cnki-refbook-popup .cnki-tb-footer {
      display: block; text-align: center; padding: 10px 16px;
      font-size: 13px; color: #2347ff; text-decoration: none;
      border-top: 1px solid #f0f0f0; border-radius: 0 0 10px 10px; cursor: pointer;
    }
    #cnki-refbook-popup .cnki-tb-footer:hover { background: #f8f9ff; }
    #cnki-refbook-popup .cnki-tb-empty-msg { text-align: center; padding: 24px 16px; color: #999; font-size: 14px; }
    #cnki-refbook-popup .cnki-tb-error-msg { text-align: center; padding: 24px 16px; color: #e74c3c; font-size: 13px; }
    #cnki-refbook-popup .cnki-tb-popup::-webkit-scrollbar { width: 5px; }
    #cnki-refbook-popup .cnki-tb-popup::-webkit-scrollbar-track { background: transparent; }
    #cnki-refbook-popup .cnki-tb-popup::-webkit-scrollbar-thumb { background: #d0d0d0; border-radius: 3px; }
    #cnki-refbook-popup .cnki-tb-fulltext-btn {
      display: inline-block; margin-top: 6px; padding: 4px 12px;
      font-size: 12px; color: #fff; background: #2347ff;
      border: none; border-radius: 4px; cursor: pointer;
    }
    #cnki-refbook-popup .cnki-tb-fulltext-btn:hover { background: #1a36cc; }
    #cnki-refbook-popup .cnki-tb-expand-toggle {
      color: #2347ff; cursor: pointer; font-size: 12px; margin-left: 4px;
      white-space: nowrap; user-select: none;
    }
    #cnki-refbook-popup .cnki-tb-expand-toggle:hover { text-decoration: underline; }
    .cnki-tb-loading {
      position: fixed; z-index: 2147483646; background: #fff; border: 1px solid #e0e0e0;
      border-radius: 8px; padding: 12px 20px; box-shadow: 0 4px 16px rgba(0,0,0,0.15);
      font-family: -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
      font-size: 13px; color: #666; display: flex; align-items: center; gap: 8px; pointer-events: none;
    }
    .cnki-tb-spinner {
      display: inline-block; width: 14px; height: 14px;
      border: 2px solid #d0e3ff; border-top-color: #2347ff; border-radius: 50%;
      animation: cnki-spin .6s linear infinite;
    }
    /* 浮动图标入口（FAB），可拖动 */
    #cnki-refbook-fab {
      position: fixed; bottom: 24px; right: 24px; z-index: 2147483646;
      width: 48px; height: 48px; border-radius: 50%;
      background: transparent; border: 1px solid rgba(35,71,255,0.22); box-shadow: 0 4px 14px rgba(35,71,255,0.35);
      display: flex; align-items: center; justify-content: center;
      cursor: grab; user-select: none; opacity: 0.9; box-sizing: content-box;
      transition: transform .15s ease, box-shadow .15s ease, opacity .15s ease;
      touch-action: none;
    }
    #cnki-refbook-fab:hover { transform: scale(1.08); box-shadow: 0 6px 20px rgba(35,71,255,0.55); opacity: 1; }
    #cnki-refbook-fab:active { transform: scale(0.96); }
    #cnki-refbook-fab.cnki-tb-fab-dragging {
      cursor: grabbing; opacity: 1; transform: scale(1.06);
      box-shadow: 0 8px 24px rgba(35,71,255,0.6); transition: none;
    }
    #cnki-refbook-fab svg { width: 24px; height: 24px; fill: #fff; pointer-events: none; }
    #cnki-refbook-fab img { width: 34px; height: 34px; object-fit: contain; pointer-events: none; }
    /* 图标入口搜索面板 */
    #cnki-refbook-popup .cnki-tb-search-popup { display: flex; flex-direction: column; overflow: hidden; }
    #cnki-refbook-popup .cnki-tb-search-popup .cnki-tb-body { overflow-y: auto; flex: 1 1 auto; min-height: 0; }
    #cnki-refbook-popup .cnki-tb-search-popup .cnki-tb-body::-webkit-scrollbar { width: 5px; }
    #cnki-refbook-popup .cnki-tb-search-popup .cnki-tb-body::-webkit-scrollbar-thumb { background: #d0d0d0; border-radius: 3px; }
    #cnki-refbook-popup .cnki-tb-search-header {
      display: flex; align-items: center; gap: 8px;
      padding: 10px 12px; border-bottom: 1px solid #f0f0f0; background: #f8f9ff;
      border-radius: 10px 10px 0 0;
    }
    #cnki-refbook-popup .cnki-tb-search-icon { flex: 0 0 auto; display: flex; }
    #cnki-refbook-popup .cnki-tb-search-icon svg { width: 18px; height: 18px; fill: #2347ff; }
    #cnki-refbook-popup .cnki-tb-search-input {
      flex: 1 1 auto; min-width: 0; height: 30px; border: 1px solid #d8d8d8;
      border-radius: 6px; padding: 0 10px; font-size: 13px; color: #333; outline: none;
      background: #fff; box-sizing: border-box;
    }
    #cnki-refbook-popup .cnki-tb-search-input:focus { border-color: #2347ff; }
    #cnki-refbook-popup .cnki-tb-search-btn {
      flex: 0 0 auto; height: 30px; padding: 0 14px; border: none; border-radius: 6px;
      background: #2347ff; color: #fff; font-size: 13px; cursor: pointer;
    }
    #cnki-refbook-popup .cnki-tb-search-btn:hover { background: #1a36cc; }
    #cnki-refbook-popup .cnki-tb-search-close {
      flex: 0 0 auto; width: 26px; height: 26px; border: none; background: transparent;
      color: #999; font-size: 20px; line-height: 1; cursor: pointer; border-radius: 4px;
    }
    #cnki-refbook-popup .cnki-tb-search-close:hover { background: #e8eaff; color: #555; }
    #cnki-refbook-popup .cnki-tb-search-hint { text-align: center; padding: 24px 16px 4px; color: #888; font-size: 13px; }
    #cnki-refbook-popup .cnki-tb-search-subhint { text-align: center; padding: 0 16px 24px; color: #b0b0b0; font-size: 12px; }
    #cnki-refbook-popup .cnki-tb-search-status { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 24px 16px; color: #666; font-size: 13px; }
    /* 分词查询标签栏 */
    #cnki-refbook-popup .cnki-tb-tabs {
      display: flex; overflow-x: auto; border-bottom: 1px solid #f0f0f0; background: #fafafa;
      -webkit-overflow-scrolling: touch; scrollbar-width: thin;
    }
    #cnki-refbook-popup .cnki-tb-tabs::-webkit-scrollbar { height: 3px; }
    #cnki-refbook-popup .cnki-tb-tabs::-webkit-scrollbar-thumb { background: #d0d0d0; border-radius: 2px; }
    #cnki-refbook-popup .cnki-tb-tab {
      flex: 0 0 auto; padding: 8px 14px; font-size: 13px; color: #777; cursor: pointer;
      white-space: nowrap; border-bottom: 2px solid transparent; user-select: none;
      transition: color .15s, border-color .15s;
    }
    #cnki-refbook-popup .cnki-tb-tab:hover { color: #2347ff; }
    #cnki-refbook-popup .cnki-tb-tab.active {
      color: #2347ff; font-weight: 600; border-bottom-color: #2347ff; background: #fff;
    }
    #cnki-refbook-popup .cnki-tb-tab-empty { font-size: 11px; color: #ccc; margin-left: 3px; }
    #cnki-refbook-popup .cnki-tb-tab-count { font-size: 11px; color: #aaa; margin-left: 3px; }
  `;
  document.head.appendChild(style);
}

function showLoadingIndicator(x, y, message) {
  let loading = document.getElementById(LOADING_ID);
  if (!loading) {
    loading = document.createElement('div');
    loading.id = LOADING_ID;
    loading.className = 'cnki-tb-loading';
    document.body.appendChild(loading);
  }

  // 限制在视口内
  const w = 160, h = 44;
  let posX = Math.min(x, window.innerWidth - w - 10);
  let posY = Math.min(y + 10, window.innerHeight - h - 10);
  posX = Math.max(10, posX);
  posY = Math.max(10, posY);

  loading.style.left = posX + 'px';
  loading.style.top = posY + 'px';
  loading.style.display = 'flex';
  loading.innerHTML = '<span class="cnki-tb-spinner"></span> ' + (message || '正在CNKI工具书总库查询...');
}

function hideLoadingIndicator() {
  const el = document.getElementById(LOADING_ID);
  if (el) el.style.display = 'none';
}

// 注入加载动画 keyframes（仅一次）
function injectKeyframes() {
  if (document.getElementById('cnki-spin-keyframes')) return;
  const style = document.createElement('style');
  style.id = 'cnki-spin-keyframes';
  style.textContent = `@keyframes cnki-spin { to { transform: rotate(360deg); } }`;
  document.head.appendChild(style);
}

// 渲染单条结果卡片（划词弹窗与图标入口搜索面板共用）
function renderResultItem(item, index) {
  const isFirst = index === 0;
  let abstractHtml;
  let mayHaveBtn = false;

  if (!expandedFirstResult) {
    // 未展开状态：首条显示 500 字截断，其他显示 200 字截断
    const maxChars = isFirst ? 500 : 200;
    abstractHtml = escapeHtml(truncate(item.abstract || '', maxChars));
    mayHaveBtn = isFirst && item.fn ? true : false;
  } else if (isFirst) {
    // 已展开且是首条：使用完整释文（如果已获取到）或摘要
    const displayText = firstResultFullText !== '' ? firstResultFullText : (item.abstract || '');
    if (displayText) {
      // 超过 500 字才截断，否则直接全文显示
      if (displayText.length > 500) {
        abstractHtml = escapeHtml(truncate(displayText, 500))
          + `<span class="cnki-tb-expand-toggle" data-raw="${encodeURIComponent(displayText)}">展开</span>`;
      } else {
        abstractHtml = escapeHtml(displayText);
      }
    } else {
      // 全文和摘要均为空，显示提示并保留"查看全文"按钮
      abstractHtml = '<span style="color:#999;font-size:12px;">获取释文失败，可尝试点击下方按钮</span>';
      mayHaveBtn = true;
    }
  } else {
    // 非首条：保持 200 字截断
    abstractHtml = escapeHtml(truncate(item.abstract || '', 200));
    mayHaveBtn = false;
  }

  return `
    <div class="cnki-tb-result ${index > 0 ? 'cnki-tb-result-border' : ''}">
      <div class="cnki-tb-word">${escapeHtml(item.title)}</div>
      <div class="cnki-tb-abstract">${abstractHtml}</div>
      ${mayHaveBtn ? '<button class="cnki-tb-fulltext-btn">查看全文</button>' : ''}
      <div class="cnki-tb-source">来源：${renderBookLink(item)}</div>
      <div class="cnki-tb-meta">
        ${item.subject ? `<span class="cnki-tb-tag">${escapeHtml(item.subject)}</span>` : ''}
      </div>
    </div>
  `;
}

function renderResults(results, x, y, keyword) {
  hideLoadingIndicator();

  // 持久化当前结果供后续"查看全文"重渲染使用
  lastResults = results;
  lastX = x;
  lastY = y;
  popupMode = 'select';
  activeRerender = () => renderResults(lastResults, lastX, lastY, lastKeyword);

  const container = document.getElementById(POPUP_ID);
  if (!container) return;

  // 重渲染时保存滚动位置
  const popupEl = container.querySelector('.cnki-tb-popup');
  const savedScrollTop = popupEl ? popupEl.scrollTop : 0;

  if (!results || results.length === 0) {
    container.innerHTML = `
      <div class="cnki-tb-popup cnki-tb-empty">
        <div class="cnki-tb-header">
          <span class="cnki-tb-title">CNKI工具书总库</span>
        </div>
        <div class="cnki-tb-body">
          <div class="cnki-tb-empty-msg">在CNKI工具书总库中未找到相关释义</div>
        </div>
      </div>
    `;
  } else {
    container.innerHTML = `
      <div class="cnki-tb-popup">
        <div class="cnki-tb-header">
          <span class="cnki-tb-title">CNKI工具书总库</span>
          <span class="cnki-tb-count">${results.length} 条结果</span>
        </div>
        <div class="cnki-tb-body">
          ${results.map((item, i) => renderResultItem(item, i)).join('')}
        </div>
        <a class="cnki-tb-footer" href="https://gongjushu.cnki.net/rbook/search/simplesearch?key=${encodeURIComponent(keyword)}" target="_blank" rel="noopener">
          在CNKI工具书总库查看更多释义 →
        </a>
      </div>
    `;
  }

  positionPopup(container, x, y);
  container.style.display = 'block';
  popupVisible = true;
  // 恢复重渲染前的滚动位置
  const newPopupEl = container.querySelector('.cnki-tb-popup');
  if (newPopupEl && savedScrollTop > 0) {
    newPopupEl.scrollTop = savedScrollTop;
  }
}

/**
 * 弹窗内事件委托：
 * - "查看全文" 按钮 → 展开首条结果（完整重渲染）
 * - "展开"/"收起" 切换 → DOM 操作切换 500 字截断 ↔ 全文
 * - 图标入口搜索面板：查询按钮 / 关闭按钮 / 回车提交
 */
function setupPopupDelegation() {
  const container = document.getElementById(POPUP_ID);
  if (!container) return;
  container.addEventListener('click', function (e) {
    // 忽略非 Element 目标（如 Text 节点），避免 classList 为 undefined 导致 TypeError
    if (!(e.target instanceof Element)) return;
    // 分词查询：标签切换
    const tabEl = e.target.closest('.cnki-tb-tab');
    if (tabEl) {
      e.stopPropagation();
      const index = parseInt(tabEl.dataset.tab, 10);
      switchTab(index);
      return;
    }
    // 图标入口：关闭按钮
    if (e.target.classList.contains('cnki-tb-search-close')) {
      e.stopPropagation();
      hidePopup();
      return;
    }
    // 图标入口：查询按钮
    if (e.target.classList.contains('cnki-tb-search-btn')) {
      e.stopPropagation();
      submitIconSearch();
      return;
    }
    // "查看全文"按钮：获取完整释文后展开
    if (e.target.classList.contains('cnki-tb-fulltext-btn')) {
      e.stopPropagation();
      const btn = e.target;
      btn.disabled = true;
      btn.textContent = '加载中...';

      // 获取第一条结果数据
      const firstItem = lastResults && lastResults[0];
      if (!firstItem) {
        btn.textContent = '查看全文';
        btn.disabled = false;
        return;
      }

      const gen = searchGeneration;
      fetchAndExpandFirstResult(firstItem, gen, { fallbackAbstract: firstItem.abstract || '' });
      return;
    }

    // "展开" / "收起" 切换：直接 DOM 操作，避免重渲染
    if (e.target.classList.contains('cnki-tb-expand-toggle')) {
      e.stopPropagation();
      const isExpanded = e.target.textContent === '收起';
      const abstractDiv = e.target.parentElement;
      const rawText = decodeURIComponent(e.target.getAttribute('data-raw'));

      // 同步 expandedFirstResult 状态，并作废进行中的异步获取，
      // 避免后到的 applyResult 覆盖用户的手动展开/收起
      expandFetchGen++;
      expandedFirstResult = !isExpanded;

      if (isExpanded) {
        // 收起 → 回到 200 字截断
        abstractDiv.innerHTML = escapeHtml(truncate(rawText, 200))
          + `<span class="cnki-tb-expand-toggle" data-raw="${encodeURIComponent(rawText)}">展开</span>`;
      } else {
        // 展开 → 显示全部
        abstractDiv.innerHTML = escapeHtml(rawText)
          + `<span class="cnki-tb-expand-toggle" data-raw="${encodeURIComponent(rawText)}">收起</span>`;
      }
      return;
    }
  });

  // 图标入口：输入框回车提交查询
  container.addEventListener('keydown', function (e) {
    if (!(e.target instanceof Element)) return;
    if (e.target.classList.contains('cnki-tb-search-input') && e.key === 'Enter') {
      e.preventDefault();
      submitIconSearch();
    }
  });
}

function renderError(message, x, y) {
  hideLoadingIndicator();
  popupMode = 'select';
  activeRerender = null;
  tabState = null;
  const container = document.getElementById(POPUP_ID);
  if (!container) return;

  container.innerHTML = `
    <div class="cnki-tb-popup cnki-tb-empty">
      <div class="cnki-tb-header">
        <span class="cnki-tb-title">CNKI工具书总库</span>
      </div>
      <div class="cnki-tb-body">
        <div class="cnki-tb-error-msg">查询失败：${escapeHtml(message)}</div>
      </div>
    </div>
  `;
  positionPopup(container, x, y);
  container.style.display = 'block';
  popupVisible = true;
}

// 缓存上次成功定位的尺寸，避免重复 reflow
let lastPopupWidth = 380;
let lastPopupHeight = 200;

function positionPopup(container, mouseX, mouseY) {
  // 先用隐藏的方式测量尺寸（一次性 reflow）
  container.style.visibility = 'hidden';
  container.style.display = 'block';
  const popup = container.querySelector('.cnki-tb-popup');
  const pw = popup ? (popup.offsetWidth || lastPopupWidth) : lastPopupWidth;
  const ph = popup ? (popup.offsetHeight || lastPopupHeight) : lastPopupHeight;
  container.style.display = 'none';
  container.style.visibility = 'visible';

  if (pw > 0) lastPopupWidth = pw;
  if (ph > 0) lastPopupHeight = ph;

  const viewW = window.innerWidth;
  const viewH = window.innerHeight;
  const gap = 8;

  let left, top;

  if (mouseX + gap + pw <= viewW - 10) {
    left = mouseX + gap;
  } else if (mouseX - gap - pw >= 10) {
    left = mouseX - pw - gap;
  } else {
    left = Math.max(10, Math.min(viewW - pw - 10, mouseX - pw / 2));
  }

  if (mouseY + gap + ph <= viewH - 10) {
    top = mouseY + gap;
  } else if (mouseY - gap - ph >= 10) {
    top = mouseY - ph - gap;
  } else {
    top = Math.max(10, Math.min(viewH - ph - 10, mouseY - ph / 2));
  }

  container.style.left = left + 'px';
  container.style.top = top + 'px';
}

function hidePopup() {
  const container = document.getElementById(POPUP_ID);
  if (container) container.style.display = 'none';
  hideLoadingIndicator();
  popupVisible = false;
  popupMode = null;
  activeRerender = null;
  tabState = null;
  lastRenderedTabIndex = -1;   // 弹窗关闭，复位标签渲染标记
  expandedFirstResult = false;
  firstResultFullText = '';
  searchGeneration++;  // 使所有未完成的异步回调失效
}

function getSelectedText() {
  const sel = window.getSelection();
  return sel ? sel.toString().trim() : '';
}

// 缓存一个 div 用于 HTML 转义
const escDiv = document.createElement('div');
function escapeHtml(str) {
  escDiv.textContent = str;
  // textContent→innerHTML 转义 < > &，但不转义引号；
  // 补转义双引号，确保输出可安全用于双引号属性（如 value="..."、href="..."）
  return escDiv.innerHTML.replace(/"/g, '&quot;');
}

// 生成工具书条目链接
// readonlineUrl (bar.cnki.net) 是条目原文页面，但校验 Referer 必须来自 *.cnki.net
// 非CNKI页面直接跳会被拒（来源应用不正确），需要通过 gongjushu.cnki.net 中转
// 返回 null 表示没有可用的直接链接
function getBookEntryUrl(item) {
  if (item.readonlineUrl) {
    if (isCnkiPage()) {
      // CNKI 域内直接跳转，Referer 天然是 *.cnki.net
      return item.readonlineUrl;
    }
    // 非CNKI域：通过 gongjushu.cnki.net 中转，让 Referer 变为 *.cnki.net
    return `https://gongjushu.cnki.net/rbook/detail?Fn=${encodeURIComponent(item.fn || '')}#cnki_redirect=${encodeURIComponent(item.readonlineUrl)}`;
  }
  // 没有 readonlineUrl 但有 fn：跳到 gongjushu 条目详情页
  if (item.fn) {
    return `https://gongjushu.cnki.net/rbook/detail?Fn=${encodeURIComponent(item.fn)}${item.bid ? '&Bid=' + encodeURIComponent(item.bid) : ''}`;
  }
  // 既没有 readonlineUrl 也没有 fn，没有可用的直接链接
  return null;
}

// 渲染来源链接：有直接链接时显示可点击的书名，否则显示纯文本
function renderBookLink(item) {
  const url = getBookEntryUrl(item);
  if (url) {
    return `<a class="cnki-tb-book-link" href="${escapeHtml(url)}" target="_blank" rel="noopener">《${escapeHtml(item.bookName)}》</a>`;
  }
  return `《${escapeHtml(item.bookName)}》`;
}

// 判断当前页面是否在 CNKI 域名下
function isCnkiPage() {
  return window.location.hostname.endsWith('.cnki.net') || window.location.hostname === 'cnki.net';
}

function truncate(str, maxLen) {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '…';
}

function isExcludedTag(el) {
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'a' || tag === 'button' || tag === 'select';
}

function isInsidePopup(el) {
  return el && (el.id === POPUP_ID || el.closest && el.closest(`#${POPUP_ID}`));
}

// 判断点击是否发生在浮动查词图标上
function isInsideFab(el) {
  return !!(el && (el.id === FAB_ID || (el.closest && el.closest(`#${FAB_ID}`))));
}

// 检测与当前 popup 同一词条的重复查询
function isDuplicateOfCurrentKeyword(text) {
  return popupVisible && text === lastKeyword;
}

// --- 事件处理 ---

document.addEventListener('mouseup', function (e) {
  if (isInsidePopup(e.target) || isInsideFab(e.target)) return;

  const selectedText = getSelectedText();
  if (!selectedText) {
    // 点击非弹窗区域时关闭弹窗（无选中文本）
    hidePopup();
    return;
  }

  // 如果弹窗已显示且选中文本与上次相同，不重复查询
  if (isDuplicateOfCurrentKeyword(selectedText)) return;
  if (isExcludedTag(e.target)) return;

  // 显示加载中
  ensurePopupContainer();
  injectKeyframes();
  showLoadingIndicator(e.clientX, e.clientY);
  warmupSegmenterOnce();

  lastKeyword = selectedText;
  expandedFirstResult = false;
  searchGeneration++;  // 新搜索开始，使旧回调失效
  const gen = searchGeneration;

  // 调用分词查询流程（带重试，无结果时自动分词）
  queryWithSegmentation(selectedText, e.clientX, e.clientY, gen)
    .catch(err => {
      if (gen !== searchGeneration) return;
      renderError(err.message || '查询失败', e.clientX, e.clientY);
    });
}, false);

// 点击页面其他区域关闭弹窗
document.addEventListener('mousedown', function (e) {
  if (isInsidePopup(e.target) || isInsideFab(e.target)) return;
  if (popupVisible) {
    hidePopup();
    lastKeyword = '';
  }
}, false);

// 按 ESC 关闭弹窗
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && popupVisible) {
    hidePopup();
    lastKeyword = '';
  }
}, false);

// 弹窗内的 a 标签（书籍链接、查看更多）点击时阻止弹窗关闭，但不干扰事件委托
document.addEventListener('click', function (e) {
  if (isInsidePopup(e.target) && e.target.tagName === 'A') {
    e.stopPropagation();
  }
}, true);

// 带重试的 sendMessage（处理 MV3 service worker 冷启动问题）
// 采用指数退避：首次重试快速（SW 唤醒通常很快），后续逐步拉长
function sendMessageWithRetry(msg, retries, delayMs) {
  return new Promise((resolve, reject) => {
    function attempt(n, currentDelay) {
      chrome.runtime.sendMessage(msg, (response) => {
        if (chrome.runtime.lastError) {
          if (n > 0) {
            // 首次重试用传入的 delayMs，之后指数退避（×1.8，上限 1500ms）
            const next = Math.min(Math.round(currentDelay * 1.8), 1500);
            setTimeout(() => attempt(n - 1, next), currentDelay);
          } else {
            reject(new Error(chrome.runtime.lastError.message));
          }
          return;
        }
        resolve(response);
      });
    }
    attempt(retries, delayMs);
  });
}

// --- 分词查询标签状态辅助函数 ---

// 获取当前活动标签
function getActiveTab() {
  return tabState && tabState.tabs[tabState.activeIndex];
}

// 从活动标签同步状态到全局变量（切换标签或渲染前调用）
function syncGlobalsFromActiveTab() {
  const tab = getActiveTab();
  if (!tab) return;
  lastResults = tab.results;
  lastKeyword = tab.keyword;
  expandedFirstResult = tab.expanded;
  firstResultFullText = tab.fullText;
}

// 从全局变量同步状态到活动标签（异步获取全文后、切换标签前调用）
function syncTabStateFromGlobals() {
  const tab = getActiveTab();
  if (!tab) return;
  tab.fullText = firstResultFullText;
  tab.expanded = expandedFirstResult;
}

// 重渲染当前活动面板（划词弹窗或图标入口搜索面板），供异步获取全文后调用
function rerenderActivePanel() {
  syncTabStateFromGlobals();
  if (activeRerender) activeRerender();
}

// 获取首条结果完整释文：优先获取 full text，失败则用完整摘要（比默认 200 字截断好）
// 由"查看全文"按钮和 autoFetchExpandFirst 共用
function fetchAndExpandFirstResult(firstItem, gen, options) {
  const { fallbackAbstract = '' } = options || {};
  // 每次发起获取都递增代数；applyResult 只在仍是最新代数时生效，
  // 这样后到的异步结果（如自动获取）不会覆盖用户此后的收起/切换操作
  const myGen = ++expandFetchGen;

  const applyResult = (text) => {
    if (gen !== searchGeneration) return;
    if (myGen !== expandFetchGen) return;
    firstResultFullText = text;
    expandedFirstResult = true;
    rerenderActivePanel();
  };

  // 1. 先查缓存（SW 内存查找，开销小，单独走一步）
  sendMessageWithRetry({ action: 'getCachedEntryContent', fn: firstItem.fn }, 1, 200)
    .then(cacheResponse => {
      if (gen !== searchGeneration) return;
      if (cacheResponse && cacheResponse.success && cacheResponse.content
          && cacheResponse.content.content != null) {
        applyResult(cacheResponse.content.content);
        return;
      }
      // 2. 缓存未命中：先尝试页面直 fetch（共享页面 cookie，最可能成功），
      //    失败再回退到 background（SW cookie + invoice 兜底）。
      //    串行两段而非并发，避免对同一 entry/detail 端点同时发起 6-7 个请求
      //    触发速率限制；每段内部仍并发尝试多个 scope。
      directFetchEntryDetail(firstItem)
        .then(r => { if (r) return r; throw new Error('直 fetch 获取失败'); })
        .catch(() => sendMessageWithRetry({
          action: 'fetchEntryContent',
          fn: firstItem.fn,
          bid: firstItem.bid,
          tablename: firstItem.tablename,
          product: firstItem.product
        }, 1, 300).then(r => {
          if (r && r.success && r.content && r.content.content != null) return r.content.content;
          throw new Error('background 获取失败');
        }))
        .then(text => applyResult(text))
        .catch(() => {
          if (gen !== searchGeneration) return;
          // 全部失败，回退到摘要
          applyResult(firstItem.abstract !== undefined ? firstItem.abstract : fallbackAbstract);
          console.info('CNKI工具书总库：未获取到完整释文。如需查看全文，请先访问 https://gongjushu.cnki.net/ 并登录。');
        });
    })
    .catch(() => {
      if (gen !== searchGeneration) return;
      applyResult(firstItem.abstract !== undefined ? firstItem.abstract : fallbackAbstract);
    });
}

// 直接从页面上下文 fetch entry/detail API（共享页面 cookie）
async function directFetchEntryDetail(item) {
  if (!item.fn) return null;
  const scopes = ['content', 'preview', 'download'];

  // 并发尝试所有 scope，任一返回有效内容即采用
  try {
    const result = await Promise.any(
      scopes.map(async (scope) => {
        const resp = await fetch(
          'https://t.cnki.net/rbook-api/v1/entry/detail?uniplatform=NRBOOK',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json;charset=utf-8',
              'language': 'CHS',
              'Origin': 'https://gongjushu.cnki.net',
              'Referer': 'https://gongjushu.cnki.net/'
            },
            credentials: 'include',
            body: JSON.stringify({
              filename: item.fn,
              tablename: item.tablename || 'CRFD2025',
              product: item.product || 'CRFD',
              platform: 'NRBOOK',
              type: 'REFBOOK',
              scope,
              cflag: 'overlay',
              dflag: '词条',
              language: 'CHS',
              pages: '',
              sid: '',
              idenid: ''
            })
          }
        );
        if (!resp.ok) throw new Error(`scope ${scope} HTTP ${resp.status}`);
        const contentType = resp.headers.get('content-type') || '';
        if (!contentType.includes('json')) throw new Error(`scope ${scope} 非 JSON`);
        const json = await resp.json();
        if (json.code !== 0) throw new Error(`scope ${scope} code ${json.code}`);
        const data = json.data;
        if (!data || !data.data || !data.data.length) throw new Error(`scope ${scope} 无数据`);
        const entry = data.data[0];
        const rawContent = entry.content || '';
        const cleanContent = htmlToParagraphText(rawContent);
        if (!cleanContent) throw new Error(`scope ${scope} 内容为空`);
        return cleanContent;
      })
    );
    return result;
  } catch (e) {
    // 所有 scope 均失败
  }
  return null;
}

// 自动展开第一条结果（不阻塞弹窗展示）：失败时用摘要回退而不是静默跳过
function autoFetchExpandFirst(firstItem) {
  const gen = searchGeneration;
  fetchAndExpandFirstResult(firstItem, gen, {});
}

// ============================================================
// 分词查询：选中内容无结果时，自动分词并多标签展示
// ============================================================

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

// 同步滑动窗口分词（SegmentIt 加载失败时的回退方案）
function slidingWindowSegment(text) {
  const chars = Array.from(text);
  const len = chars.length;
  if (len < 4) return []; // 太短不值得分词

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

  // 按长度从长到短生成，优先匹配更完整的词
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

// --- 沙箱 iframe（绕过页面 CSP，加载 SegmentIt 分词与 OpenCC 繁简转换） ---
// content script 中无法使用 eval/new Function（受宿主页面 CSP 限制），
// 因此创建一个隐藏的 sandbox iframe（扩展沙箱页面，CSP 允许加载 CDN 脚本），
// 通过 postMessage 与之通信。分词与繁简转换共用同一 iframe，两库独立加载、独立就绪。
let sandboxIframe = null;          // sandbox iframe 元素
let sandboxLoading = null;         // 创建中的 Promise（防止重复创建）
let segmentitReady = false;        // SegmentIt 是否就绪
let openccReady = false;           // OpenCC 是否就绪
let pendingSegmentitReady = null;  // 等待 SegmentIt 就绪的 Promise（resolve iframe|null）
let pendingOpenccReady = null;     // 等待 OpenCC 就绪的 Promise（resolve iframe|null）
let segmentRequestId = 0;          // 分词请求自增 ID
let t2sRequestId = 0;              // 繁→简转换请求自增 ID

// 创建隐藏 iframe 加载 sandbox.html（SegmentIt 与 OpenCC 在此独立加载）
function createSandboxIframe() {
  return new Promise((resolve, reject) => {
    if (!document.body) { reject(new Error('document.body 不可用')); return; }

    // 两库各自的就绪 Promise，由 onMessage 在收到 ready/error 信号时 resolve
    let segResolve, occResolve;
    pendingSegmentitReady = new Promise(r => { segResolve = r; });
    pendingOpenccReady = new Promise(r => { occResolve = r; });

    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden;';
    iframe.src = chrome.runtime.getURL('sandbox.html');

    // 常驻监听：两库 ready/error 信号独立到达，互不阻塞
    function onMessage(e) {
      if (!e.data || !e.data.type) return;
      switch (e.data.type) {
        case 'cnki-segmentit-ready':
          segmentitReady = true;
          segResolve(iframe);
          break;
        case 'cnki-opencc-ready':
          openccReady = true;
          occResolve(iframe);
          break;
        case 'cnki-segmentit-error':
          segResolve(null);  // SegmentIt 不可用，不影响 OpenCC
          break;
        case 'cnki-opencc-error':
          occResolve(null);  // OpenCC 不可用，不影响 SegmentIt
          break;
      }
    }

    window.addEventListener('message', onMessage);
    iframe.onerror = () => reject(new Error('sandbox iframe 加载失败'));

    document.body.appendChild(iframe);
    sandboxIframe = iframe;
    resolve(iframe);  // iframe 已创建即可用，各库就绪由其各自的 ready 信号决定
  });
}

// 懒加载 sandbox iframe（仅在需要分词或繁简转换时创建，不影响页面初始性能）
async function getSandboxIframe() {
  if (sandboxIframe) return sandboxIframe;
  if (sandboxLoading) return sandboxLoading;
  sandboxLoading = (async () => {
    try {
      return await createSandboxIframe();
    } catch (e) {
      console.warn('CNKI工具书总库：沙箱 iframe 加载失败，分词与繁简转换均不可用', e);
      return null;
    } finally {
      sandboxLoading = null;
    }
  })();
  return sandboxLoading;
}

// 等待 SegmentIt 就绪，返回 iframe 或 null（超时/失败）
async function getSegmenter() {
  const iframe = await getSandboxIframe();
  if (!iframe) return null;
  if (segmentitReady) return iframe;
  if (!pendingSegmentitReady) return null;
  // sandbox.html 自带 10s 超时会发 error；这里再加 12s 兜底防止信号丢失
  return Promise.race([
    pendingSegmentitReady,
    new Promise(r => setTimeout(() => r(null), 12000))
  ]);
}

// 等待 OpenCC 就绪，返回 iframe 或 null（超时/失败）
async function getConverter() {
  const iframe = await getSandboxIframe();
  if (!iframe) return null;
  if (openccReady) return iframe;
  if (!pendingOpenccReady) return null;
  return Promise.race([
    pendingOpenccReady,
    new Promise(r => setTimeout(() => r(null), 12000))
  ]);
}

// 通过 sandbox iframe 调用 OpenCC 将繁体转为简体
// 返回简体字符串；OpenCC 不可用或超时则返回 null（调用方据此跳过兜底）
async function toSimplified(text) {
  const iframe = await getConverter();
  if (!iframe) return null;
  const id = ++t2sRequestId;
  return new Promise(resolve => {
    function onMessage(e) {
      if (e.data && e.data.type === 'cnki-t2s-result' && e.data.id === id) {
        window.removeEventListener('message', onMessage);
        clearTimeout(timer);
        resolve(e.data.result);
      }
    }
    // 5 秒超时
    const timer = setTimeout(() => {
      window.removeEventListener('message', onMessage);
      resolve(null);
    }, 5000);
    window.addEventListener('message', onMessage);
    iframe.contentWindow.postMessage({ type: 'cnki-t2s-convert', text: text, id: id }, '*');
  });
}

// 通过 postMessage 将文本发送到 sandbox iframe 进行分词，接收词元结果
function segmentViaIframe(iframe, text) {
  return new Promise((resolve) => {
    const id = ++segmentRequestId;

    function onMessage(e) {
      if (e.data && e.data.type === 'cnki-segment-result' && e.data.id === id) {
        window.removeEventListener('message', onMessage);
        clearTimeout(timer);
        resolve(e.data.words);
      }
    }

    // 5 秒超时
    const timer = setTimeout(() => {
      window.removeEventListener('message', onMessage);
      resolve(null);
    }, 5000);

    window.addEventListener('message', onMessage);
    iframe.contentWindow.postMessage({ type: 'cnki-segment', text: text, id: id }, '*');
  });
}

// 使用 SegmentIt（通过 sandbox iframe）对文本进行智能分词，返回带位置的词段
// 若 SegmentIt 不可用则返回 null（由调用方回退到滑动窗口）
async function segmentWithSegmentIt(text, iframe) {
  if (!iframe) return null;

  try {
    const words = await segmentViaIframe(iframe, text);
    if (!words || !words.length) return null;

    // POS 标记：A_NS=64(地名), A_NR=128(人名), A_NT=32(机构), A_NX=16(其他专名), A_NZ=8(其他名词)
    // D_Z=256(状态词), D_N=1048576(名词), D_T=16384(时间/节气，含二十四节气如"霜降")
    // 注：D_T 原先漏在白名单外，导致"霜降"等节气词被丢弃，必须补入。
    const MEANINGFUL_POS = new Set([64, 128, 32, 16, 8, 256, 1048576, 16384]);
    // 分隔标点（含中点号"·"）。segmentit 有时会误把标点并入相邻词，
    // 例如"三候·"被误判为人名 A_NR=128，这里据此剔除这类污染词段。
    const PUNCT_CHARS = new Set(['·', '・', '•', '。', '，', '、', '：', '；']);
    const segments = [];
    let pos = 0;

    for (const token of words) {
      const word = token.w;
      const wordChars = Array.from(word || '');
      const wordLenCp = wordChars.length;          // 码点数，用于词段 start/end（与 occupied 数组口径一致）
      const wordLenUtf16 = (word || '').length;    // UTF-16 单元数，用于推进 text.indexOf 的 pos

      if (wordLenCp < 2) {
        pos += wordLenUtf16;
        continue;
      }

      // 跳过包含分隔标点的词段（segmentit 误吞标点的产物，如"候·"）
      if (wordChars.some(ch => PUNCT_CHARS.has(ch))) {
        pos += wordLenUtf16;
        continue;
      }

      // 在原文中查找该词的位置（text.indexOf 基于 UTF-16，pos 须以 UTF-16 推进）
      const idx = text.indexOf(word, pos);
      if (idx === -1) {
        pos += wordLenUtf16;
        continue;
      }

      // 优先保留有 POS 标记的词，但也保留未标记的长词（≥3字）
      const hasMeaningfulPos = MEANINGFUL_POS.has(token.p) || (token.p === 0 && wordLenCp >= 3);
      if (hasMeaningfulPos) {
        const start = Array.from(text.slice(0, idx)).length;
        segments.push({
          text: word,
          start,
          end: start + wordLenCp,
          len: wordLenCp
        });
      }
      pos = idx + wordLenUtf16;
    }

    // 去重
    const seen = new Set();
    return segments.filter(s => {
      if (seen.has(s.text)) return false;
      seen.add(s.text);
      return true;
    });
  } catch (e) {
    return null;
  }
}

// 对文本进行分词，生成候选词段
// 优先使用 SegmentIt 智能分词（通过 sandbox iframe 从 CDN 加载），失败时回退到滑动窗口
async function segmentKeywordSmart(text) {
  const iframe = await getSegmenter();
  const smartSegs = await segmentWithSegmentIt(text, iframe);

  if (smartSegs && smartSegs.length > 0) {
    return smartSegs;
  }

  // 回退到滑动窗口
  return slidingWindowSegment(text);
}

// 从有结果的词段中贪心选取互不重叠的子集（优先长词、靠前的词）
function selectNonOverlappingSegments(segmentsWithResults, textLen) {
  // 按长度降序、起始位置升序排序
  segmentsWithResults.sort((a, b) => b.len - a.len || a.start - b.start);

  const occupied = new Array(textLen).fill(false);
  const selected = [];

  for (const seg of segmentsWithResults) {
    let overlaps = false;
    for (let i = seg.start; i < seg.end; i++) {
      if (occupied[i]) { overlaps = true; break; }
    }
    if (!overlaps) {
      selected.push(seg);
      for (let i = seg.start; i < seg.end; i++) occupied[i] = true;
    }
  }

  // 按原文中的出现顺序排列
  selected.sort((a, b) => a.start - b.start);
  return selected;
}

// 并行查询一批词段，返回 [{seg, results}]（失败或无结果时 results 为 []）
async function querySegments(segs) {
  return Promise.all(
    segs.map(seg =>
      sendMessageWithRetry({ action: 'searchRefbook', keyword: seg.text }, 1, 300)
        .then(r => ({ seg, results: (r && r.success) ? (r.data || []) : [] }))
        .catch(() => ({ seg, results: [] }))
    )
  );
}

// 将"有结果的词段"渲染为多标签弹窗（原词空标签 + 各命中词段标签），并自动抓取首条全文。
// pre-split 与 SegmentIt 路径共用，避免逻辑漂移。返回 true（已渲染）。
function renderSegmentTabs(keyword, segmentsWithResults, x, y) {
  const textLen = Array.from(keyword).length;
  const selected = selectNonOverlappingSegments(
    segmentsWithResults.map(r => r.seg), textLen
  );
  // O(1) 查表替代原先的 find 线性扫描
  const resultsBySeg = new Map(segmentsWithResults.map(r => [r.seg, r.results]));
  const selectedTabs = selected.map(seg => ({
    keyword: seg.text,
    results: resultsBySeg.get(seg) || [],
    fullText: '',
    expanded: false,
    scrollTop: 0,
  }));

  const tabs = [
    { keyword, results: [], fullText: '', expanded: false, scrollTop: 0 },
    ...selectedTabs,
  ];
  const firstWithResults = tabs.findIndex(t => t.results.length > 0);

  tabState = { tabs, activeIndex: firstWithResults, x, y };
  lastRenderedTabIndex = -1;
  syncGlobalsFromActiveTab();
  renderTabbedResults();

  const activeTab = tabs[firstWithResults];
  if (activeTab.results[0] && activeTab.results[0].fn) {
    autoFetchExpandFirst(activeTab.results[0]);
  }
  return true;
}

// 单条查询链：整词查询 → 无结果则分词并行查询 → 多标签展示
// 返回 true 表示已渲染结果（含错误渲染，不再兜底）；返回 false 表示无结果（可继续兜底）
async function runQueryChain(keyword, x, y, gen) {
  // 1. 查询完整关键词
  const response = await sendMessageWithRetry({ action: 'searchRefbook', keyword }, 2, 500);
  if (gen !== searchGeneration) return false;

  if (!response || !response.success) {
    tabState = null;
    renderError(response?.error || '查询失败', x, y);
    return true;  // 已渲染错误，不兜底
  }

  const data = response.data || [];

  // 2. 有结果 → 正常展示，不分词
  if (data.length > 0) {
    tabState = null;
    renderResults(data, x, y, keyword);
    if (data[0].fn) autoFetchExpandFirst(data[0]);
    return true;
  }

  // 3. 无结果 → 尝试分词（先显示加载状态，SegmentIt 首次加载需要时间）
  showLoadingIndicator(x, y, '整词未命中，正在分词检索...');

  // 3a. 预切分：按标点和中英文边界拆分（适合带标点/中英混合的划词）
  const preSegs = preSplitText(keyword) || [];

  // 3b. SegmentIt 智能分词 / 滑动窗口兜底
  const smartSegs = await segmentKeywordSmart(keyword);
  if (gen !== searchGeneration) return false;

  // 合并两路候选词段，按文本去重（避免预切分与 SegmentIt 重复查询同一关键词）。
  // 不再因预切分部分命中就短路——SegmentIt 可能切出更细的词段（如"经济"+"发展"），
  // 否则这些细粒度命中会被永久丢弃。
  const seenText = new Set();
  const allSegs = [];
  for (const seg of [...preSegs, ...(smartSegs || [])]) {
    if (!seenText.has(seg.text)) {
      seenText.add(seg.text);
      allSegs.push(seg);
    }
  }

  if (allSegs.length === 0) {
    return false;  // 无法分词，留空给上层决定是否兜底
  }

  // 4. 并行查询所有候选词段
  const queryResults = await querySegments(allSegs);
  if (gen !== searchGeneration) return false;

  // 5. 筛选有结果的词段
  const segmentsWithResults = queryResults.filter(r => r.results.length > 0);
  if (segmentsWithResults.length === 0) {
    return false;  // 分词也无结果，留空给上层决定是否兜底
  }

  // 6. 渲染多标签结果并自动抓取首条全文
  return renderSegmentTabs(keyword, segmentsWithResults, x, y);
}

// 划词查询主流程：繁体原文查询（整词+分词），无结果时自动转简体兜底再查一遍。
// 策略（方案①串行兜底）：分支A繁体原文链完全无结果时，才进入分支B简体链。
async function queryWithSegmentation(keyword, x, y, gen) {
  // 分支 A：按原文（繁体）查询
  let hit = await runQueryChain(keyword, x, y, gen);
  if (gen !== searchGeneration) return;
  if (hit) return;

  // 分支 B：繁体→简体兜底。转换结果与原文不同才说明含繁体字，需补查
  showLoadingIndicator(x, y, '未命中，正在尝试简体补查...');
  const simplified = await toSimplified(keyword);
  if (gen !== searchGeneration) return;
  if (!simplified || simplified === keyword) {
    // OpenCC 不可用或本就是简体，无兜底可言，显示空结果
    tabState = null;
    renderResults([], x, y, keyword);
    return;
  }

  hit = await runQueryChain(simplified, x, y, gen);
  if (gen !== searchGeneration) return;
  if (hit) return;

  // 繁简两链均无结果
  tabState = null;
  renderResults([], x, y, keyword);
}

// 渲染分词查询的多标签结果
function renderTabbedResults() {
  if (!tabState) return;
  hideLoadingIndicator();

  const { tabs, activeIndex, x, y } = tabState;
  const activeTab = tabs[activeIndex];

  // 同步全局变量
  lastResults = activeTab.results;
  lastKeyword = activeTab.keyword;
  expandedFirstResult = activeTab.expanded;
  firstResultFullText = activeTab.fullText;
  popupMode = 'select';
  lastX = x;
  lastY = y;

  // 设置重渲染入口
  activeRerender = () => renderTabbedResults();

  const container = document.getElementById(POPUP_ID);
  if (!container) return;

  // 滚动位置：区分“跨标签切换”与“同标签重渲染”。
  // - 跨标签切换：恢复目标标签保存的 scrollTop（switchTab 已先把旧标签滚动归档）
  // - 同标签重渲染（如全文获取完成后）：沿用当前可见滚动，保持用户位置
  const popupEl = container.querySelector('.cnki-tb-popup');
  const isTabSwitch = lastRenderedTabIndex !== activeIndex;
  const currentScrollTop = popupEl ? popupEl.scrollTop : 0;
  // 同标签重渲染时才把当前滚动写回该标签（跨标签时旧标签滚动已由 switchTab 保存）
  if (!isTabSwitch && activeTab) {
    activeTab.scrollTop = currentScrollTop;
  }
  const restoreScrollTop = isTabSwitch ? (activeTab.scrollTop || 0) : currentScrollTop;

  // 渲染标签栏
  const tabsHtml = tabs.map((tab, i) => {
    const isActive = i === activeIndex;
    const badge = tab.results.length === 0
      ? '<span class="cnki-tb-tab-empty">无</span>'
      : `<span class="cnki-tb-tab-count">${tab.results.length}</span>`;
    return `<div class="cnki-tb-tab ${isActive ? 'active' : ''}" data-tab="${i}">${escapeHtml(tab.keyword)}${badge}</div>`;
  }).join('');

  // 渲染活动标签内容
  let bodyHtml;
  if (activeTab.results.length === 0) {
    bodyHtml = '<div class="cnki-tb-empty-msg">在CNKI工具书总库中未找到相关释义</div>';
  } else {
    bodyHtml = activeTab.results.map((item, i) => renderResultItem(item, i)).join('');
  }

  // 底部链接
  const footerHtml = activeTab.results.length > 0
    ? `<a class="cnki-tb-footer" href="https://gongjushu.cnki.net/rbook/search/simplesearch?key=${encodeURIComponent(activeTab.keyword)}" target="_blank" rel="noopener">在CNKI工具书总库查看更多释义 →</a>`
    : '';

  container.innerHTML = `
    <div class="cnki-tb-popup">
      <div class="cnki-tb-header">
        <span class="cnki-tb-title">CNKI工具书总库</span>
        <span class="cnki-tb-count">分词查询 · ${tabs.length} 个词</span>
      </div>
      <div class="cnki-tb-tabs">${tabsHtml}</div>
      <div class="cnki-tb-body">${bodyHtml}</div>
      ${footerHtml}
    </div>
  `;

  positionPopup(container, x, y);
  container.style.display = 'block';
  popupVisible = true;
  lastRenderedTabIndex = activeIndex;

  // 恢复滚动位置（跨标签恢复该标签保存的位置，同标签保持当前）
  const newPopupEl = container.querySelector('.cnki-tb-popup');
  if (newPopupEl && restoreScrollTop > 0) {
    newPopupEl.scrollTop = restoreScrollTop;
  }

  // 滚动标签栏使活动标签可见（仅滚动标签栏容器，避免影响页面滚动）
  scrollTabBarToActive(container);
}

// 将活动标签滚动到标签栏可视区域内（仅调整标签栏 scrollLeft，不影响页面滚动）
function scrollTabBarToActive(container) {
  const tabBar = container.querySelector('.cnki-tb-tabs');
  const activeTabEl = tabBar && tabBar.querySelector('.cnki-tb-tab.active');
  if (!tabBar || !activeTabEl) return;
  const barRect = tabBar.getBoundingClientRect();
  const tabRect = activeTabEl.getBoundingClientRect();
  if (tabRect.left < barRect.left) {
    tabBar.scrollLeft -= (barRect.left - tabRect.left);
  } else if (tabRect.right > barRect.right) {
    tabBar.scrollLeft += (tabRect.right - barRect.right);
  }
}

// 切换标签
function switchTab(index) {
  if (!tabState || index < 0 || index >= tabState.tabs.length) return;
  if (index === tabState.activeIndex) return;

  // 保存当前标签的展开状态
  syncTabStateFromGlobals();

  // 保存当前标签的滚动位置（离开前归档，供切回时恢复）
  const popupScrollEl = document.getElementById(POPUP_ID);
  const popupScrollBox = popupScrollEl ? popupScrollEl.querySelector('.cnki-tb-popup') : null;
  const leavingTab = tabState.tabs[tabState.activeIndex];
  if (popupScrollBox && leavingTab) {
    leavingTab.scrollTop = popupScrollBox.scrollTop;
  }

  // 切换到新标签，并递增搜索代数以取消旧标签的异步全文获取（防止跨标签污染）
  tabState.activeIndex = index;
  searchGeneration++;
  syncGlobalsFromActiveTab();

  // 重新渲染
  renderTabbedResults();

  // 如果新标签有结果且尚未展开全文，自动获取
  const tab = tabState.tabs[index];
  if (tab.results.length > 0 && tab.results[0] && tab.results[0].fn && !tab.expanded) {
    autoFetchExpandFirst(tab.results[0]);
  }
}

// ============================================================
// 图标入口：浮动查词按钮 + 输入式搜索面板
// ============================================================

const SEARCH_ICON_SVG = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z"/></svg>';

// 浮动入口图标：CNKI 徽标（透明背景 PNG，内联为 data URI 以兼容所有页面 CSP）
const FAB_ICON_IMG = '<img src="data:image/png;base64,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" alt="CNKI工具书" draggable="false">';

// --- 浮动图标拖动 ---
const FAB_SIZE = 48;             // 与 CSS width/height 一致
const FAB_MARGIN = 12;           // 距视口边缘最小间距
const FAB_DRAG_THRESHOLD = 5;    // 判定为拖动的位移阈值（px），小于此值视为点击
const FAB_POS_KEY = 'cnki_tb_fab_pos';  // 持久化位置的 storage key

let fabDragMoved = false;        // 本次按下是否发生了拖动
let fabDragStartX = 0, fabDragStartY = 0;
let fabOffsetX = 0, fabOffsetY = 0;
let fabResizeTimer = null;

// 默认位置：视口右下角
function defaultFabPosition() {
  return {
    left: window.innerWidth - FAB_SIZE - FAB_MARGIN - 12,
    top: window.innerHeight - FAB_SIZE - FAB_MARGIN - 12
  };
}

// 将图标位置限制在视口内
function clampFabPosition(left, top) {
  const maxLeft = window.innerWidth - FAB_SIZE - FAB_MARGIN;
  const maxTop = window.innerHeight - FAB_SIZE - FAB_MARGIN;
  return {
    left: Math.max(FAB_MARGIN, Math.min(left, maxLeft)),
    top: Math.max(FAB_MARGIN, Math.min(top, maxTop))
  };
}

// 应用位置到图标元素：使用 left/top 定位，清除 bottom/right
function applyFabPosition(fab, left, top) {
  const pos = clampFabPosition(left, top);
  fab.style.left = pos.left + 'px';
  fab.style.top = pos.top + 'px';
  fab.style.right = 'auto';
  fab.style.bottom = 'auto';
}

// 拖动 + 点击判定（基于 Pointer Events，兼容鼠标和触摸）
function setupFabDrag(fab) {
  fab.addEventListener('pointerdown', function (e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return; // 仅响应左键
    e.preventDefault();
    e.stopPropagation();

    fabDragMoved = false;
    fabDragStartX = e.clientX;
    fabDragStartY = e.clientY;
    const rect = fab.getBoundingClientRect();
    fabOffsetX = e.clientX - rect.left;
    fabOffsetY = e.clientY - rect.top;

    function onMove(ev) {
      const dx = ev.clientX - fabDragStartX;
      const dy = ev.clientY - fabDragStartY;
      if (!fabDragMoved && Math.hypot(dx, dy) < FAB_DRAG_THRESHOLD) return;
      if (!fabDragMoved) {
        fabDragMoved = true;
        fab.classList.add('cnki-tb-fab-dragging');
      }
      applyFabPosition(fab, ev.clientX - fabOffsetX, ev.clientY - fabOffsetY);
    }

    function onUp() {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      fab.classList.remove('cnki-tb-fab-dragging');

      if (fabDragMoved) {
        // 拖动结束：持久化位置
        const left = parseFloat(fab.style.left) || 0;
        const top = parseFloat(fab.style.top) || 0;
        chrome.storage.local.set({ [FAB_POS_KEY]: { left, top } }).catch(() => {});
      } else {
        // 未拖动：视为点击，切换搜索面板
        toggleSearchBox();
      }
    }

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  });
}

// 窗口尺寸变化时重新将图标限制在视口内（防抖）
function handleFabResize() {
  if (fabResizeTimer) clearTimeout(fabResizeTimer);
  fabResizeTimer = setTimeout(() => {
    const fab = document.getElementById(FAB_ID);
    if (!fab) return;
    const left = parseFloat(fab.style.left) || 0;
    const top = parseFloat(fab.style.top) || 0;
    applyFabPosition(fab, left, top);
  }, 150);
}

// 注入浮动查词图标（页面右下角），点击打开输入式搜索面板，支持拖动
function injectFloatingButton() {
  if (document.getElementById(FAB_ID)) return;
  if (!document.body) return;
  injectPopupStyles(); // 确保样式已注入（manifest.css 在扩展更新后已打开的页面不会注入）
  const fab = document.createElement('div');
  fab.id = FAB_ID;
  fab.title = 'CNKI工具书总库查词（可拖动）';
  fab.setAttribute('role', 'button');
  fab.setAttribute('aria-label', 'CNKI工具书总库查词，可拖动');
  fab.innerHTML = FAB_ICON_IMG;

  // 先用默认位置（右下角），避免异步读取存储期间闪烁
  const def = defaultFabPosition();
  applyFabPosition(fab, def.left, def.top);

  // 异步恢复上次保存的位置
  chrome.storage.local.get(FAB_POS_KEY).then(result => {
    const saved = result && result[FAB_POS_KEY];
    if (saved && typeof saved.left === 'number' && typeof saved.top === 'number') {
      applyFabPosition(fab, saved.left, saved.top);
    }
  }).catch(() => {});

  setupFabDrag(fab);
  document.body.appendChild(fab);
  window.addEventListener('resize', handleFabResize);
}

// 切换搜索面板的显示/隐藏
function toggleSearchBox() {
  if (popupVisible && popupMode === 'search') {
    hidePopup();
  } else {
    openSearchBox();
  }
}

// 打开图标入口的搜索面板（初始为输入提示状态）
function openSearchBox() {
  hidePopup(); // 关闭可能存在的划词弹窗
  ensurePopupContainer();
  injectKeyframes();
  searchInputValue = '';
  lastResults = [];
  lastKeyword = '';
  expandedFirstResult = false;
  firstResultFullText = '';
  renderSearchBox(null, '', 'init');
}

// 提交图标入口的查词请求
function submitIconSearch() {
  const container = document.getElementById(POPUP_ID);
  const input = container && container.querySelector('.cnki-tb-search-input');
  const keyword = (input ? input.value : '').trim();
  if (!keyword) {
    if (input) input.focus();
    return;
  }
  searchInputValue = keyword;
  lastKeyword = keyword;
  expandedFirstResult = false;
  firstResultFullText = '';
  searchGeneration++;  // 新查询开始，使旧回调失效
  const gen = searchGeneration;
  warmupSegmenterOnce();

  renderSearchBox(null, keyword, 'loading');

  sendMessageWithRetry({ action: 'searchRefbook', keyword: keyword }, 2, 500)
    .then(response => {
      if (gen !== searchGeneration) return;
      if (!response || !response.success) {
        renderSearchBox([], keyword, 'error');
        return;
      }
      const data = response.data || [];
      renderSearchBox(data, keyword, 'results');
      // 自动获取第一条结果的完整释文（异步，不阻塞渲染）
      if (data.length > 0 && data[0].fn) {
        autoFetchExpandFirst(data[0]);
      }
    })
    .catch(() => {
      if (gen !== searchGeneration) return;
      renderSearchBox([], keyword, 'error');
    });
}

// 将搜索面板定位到浮动图标附近（根据图标实际位置自适应）
function positionSearchBox(container) {
  // 先以隐藏方式测量尺寸（一次性 reflow）
  container.style.visibility = 'hidden';
  container.style.display = 'block';
  const popup = container.querySelector('.cnki-tb-popup');
  const pw = popup ? (popup.offsetWidth || lastPopupWidth) : lastPopupWidth;
  const ph = popup ? (popup.offsetHeight || lastPopupHeight) : lastPopupHeight;
  container.style.display = 'none';
  container.style.visibility = 'visible';

  if (pw > 0) lastPopupWidth = pw;
  if (ph > 0) lastPopupHeight = ph;

  const margin = 12;
  let left, top;
  const fab = document.getElementById(FAB_ID);

  if (fab) {
    const fl = parseFloat(fab.style.left) || 0;
    const ft = parseFloat(fab.style.top) || 0;
    // 垂直：优先在图标上方展开，空间不足时放下方
    top = ft - ph - margin;
    if (top < 10) {
      top = ft + FAB_SIZE + margin;
    }
    // 水平：优先右对齐到图标右边缘，越界则左对齐到图标左边缘，仍越界则贴右边
    left = fl + FAB_SIZE - pw;
    if (left < 10) left = fl;
    if (left + pw > window.innerWidth - 10) {
      left = window.innerWidth - pw - 10;
    }
  } else {
    // 无图标（理论上不会发生），回退到右下角
    left = window.innerWidth - pw - margin;
    top = window.innerHeight - ph - 80;
  }

  left = Math.max(10, left);
  top = Math.max(10, top);
  // 若高度超出视口，向上延伸至顶部
  if (top + ph > window.innerHeight - 10) {
    top = Math.max(10, window.innerHeight - ph - 10);
  }

  container.style.left = left + 'px';
  container.style.top = top + 'px';
}

// 渲染图标入口的搜索面板（写入与划词弹窗共用的容器，复用样式与结果卡片渲染）
function renderSearchBox(results, keyword, status) {
  hideLoadingIndicator();

  popupMode = 'search';
  if (keyword !== undefined) lastKeyword = keyword;

  const container = document.getElementById(POPUP_ID);
  if (!container) return;

  // 重渲染前保留用户已输入的内容
  const existingInput = container.querySelector('.cnki-tb-search-input');
  if (existingInput) searchInputValue = existingInput.value;

  // 仅在有结果时更新 lastResults，避免 loading/error 状态覆盖已有结果
  if (results) lastResults = results;

  // 异步获取全文后的重渲染入口：复用当前结果与关键词
  activeRerender = () => renderSearchBox(lastResults, lastKeyword, 'results');

  let bodyHtml;
  if (status === 'loading') {
    bodyHtml = `<div class="cnki-tb-search-status"><span class="cnki-tb-spinner"></span> 正在CNKI工具书总库查询中…</div>`;
  } else if (status === 'error') {
    bodyHtml = `<div class="cnki-tb-error-msg">查询失败，请稍后重试</div>`;
  } else if (!results || results.length === 0) {
    if (status === 'init') {
      bodyHtml = `<div class="cnki-tb-search-hint">输入要查询的词语，按回车或点击"查询"</div><div class="cnki-tb-search-subhint">在中国知网工具书总库查询专业释义</div>`;
    } else {
      bodyHtml = `<div class="cnki-tb-empty-msg">在CNKI工具书总库中未找到"${escapeHtml(keyword)}"的相关释义</div>`;
    }
  } else {
    bodyHtml = results.map((item, i) => renderResultItem(item, i)).join('');
  }

  const showFooter = results && results.length > 0 && keyword;
  const footerHtml = showFooter
    ? `<a class="cnki-tb-footer" href="https://gongjushu.cnki.net/rbook/search/simplesearch?key=${encodeURIComponent(keyword)}" target="_blank" rel="noopener">在CNKI工具书总库查看更多释义 →</a>`
    : '';

  container.innerHTML = `
    <div class="cnki-tb-popup cnki-tb-search-popup">
      <div class="cnki-tb-search-header">
        <span class="cnki-tb-search-icon">${SEARCH_ICON_SVG}</span>
        <input class="cnki-tb-search-input" type="text" autocomplete="off" placeholder="输入要查询的词…" value="${escapeHtml(searchInputValue)}" />
        <button class="cnki-tb-search-btn" type="button">查询</button>
        <button class="cnki-tb-search-close" type="button" title="关闭" aria-label="关闭">×</button>
      </div>
      <div class="cnki-tb-body">${bodyHtml}</div>
      ${footerHtml}
    </div>
  `;

  positionSearchBox(container);
  container.style.display = 'block';
  popupVisible = true;

  // 聚焦输入框并将光标置于末尾
  const input = container.querySelector('.cnki-tb-search-input');
  if (input) {
    input.focus();
    const len = input.value.length;
    try { input.setSelectionRange(len, len); } catch (_) {}
  }
}

// 脚本加载后注入浮动查词图标
injectFloatingButton();

// --- 启动预热：把首次查询的冷启动开销摊到后台 ---

// 预热 service worker：发送一个轻量 ping 唤醒后台，避免首次划词时
// 遇到 "Receiving end does not exist" 触发 500ms 重试
warmupServiceWorker();

// 预连接 CNKI API 域名：提前完成 DNS/TLS 握手，首次查询省一轮 RTT
warmupConnection();

// SegmentIt 预热改为首次用户交互时触发（见 warmupSegmenterOnce），
// 避免在每个页面加载时都下载数 MB 词典，绝大多数页面用户根本不会用到分词

function warmupServiceWorker() {
  try {
    chrome.runtime.sendMessage({ action: 'ping' }, () => {
      // 吞掉 lastError（无监听器或未处理 ping 都属正常）
      void chrome.runtime.lastError;
    });
  } catch (_) {}
}

function warmupConnection() {
  try {
    // 请求 favicon 触发 DNS 解析 + TLS 握手，首次查询时省一轮连接建立
    fetch('https://t.cnki.net/favicon.ico', { method: 'GET', mode: 'no-cors' }).catch(() => {});
  } catch (_) {}
}

let segmenterWarmupDone = false;
// 首次用户交互时触发一次 SegmentIt 预热（划词或搜索框提交）。
// 不在页面加载时预热，避免对从不使用分词的页面白下载数 MB 词典。
function warmupSegmenterOnce() {
  if (segmenterWarmupDone) return;
  segmenterWarmupDone = true;
  warmupSegmenterOnIdle();
}

function warmupSegmenterOnIdle() {
  const start = () => {
    // getSegmenter 是幂等的：已加载则立即返回，加载中则复用同一个 Promise
    getSegmenter().catch(() => {});
  };
  if ('requestIdleCallback' in window) {
    requestIdleCallback(start, { timeout: 4000 });
  } else {
    setTimeout(start, 1500);
  }
}
