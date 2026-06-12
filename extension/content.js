// CNKI 工具书划词查询 - Content Script

const POPUP_ID = 'cnki-toolbook-popup';
const LOADING_ID = 'cnki-toolbook-loading';

let popupVisible = false;
let lastKeyword = '';

// 注入唯一 ID，避免与宿主页面冲突
function ensurePopupContainer() {
  if (document.getElementById(POPUP_ID)) return;

  const container = document.createElement('div');
  container.id = POPUP_ID;
  container.style.cssText = `
    position: fixed;
    z-index: 2147483647;
    display: none;
  `;
  document.body.appendChild(container);
}

function showLoadingIndicator(x, y) {
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
  loading.innerHTML = '<span class="cnki-tb-spinner"></span> 查询释义中...';
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

// 注入弹窗 CSS（仅一次）
function injectPopupStyles() {
  if (document.getElementById('cnki-tb-styles')) return;
  const style = document.createElement('style');
  style.id = 'cnki-tb-styles';
  style.textContent = `
    #${POPUP_ID} { all: initial; position: fixed; z-index: 2147483647; display: none; }
    #${POPUP_ID} .cnki-tb-popup {
      display: block; width: 380px; max-width: 90vw; max-height: 80vh; overflow-y: auto;
      background: #fff; border: 1px solid #e8e8e8; border-radius: 10px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.18);
      font-family: -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
      font-size: 14px; line-height: 1.6; color: #333;
    }
    #${POPUP_ID} .cnki-tb-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 12px 16px; border-bottom: 1px solid #f0f0f0; background: #f8f9ff;
      border-radius: 10px 10px 0 0;
    }
    #${POPUP_ID} .cnki-tb-title { font-size: 13px; font-weight: 600; color: #2347ff; }
    #${POPUP_ID} .cnki-tb-count { font-size: 12px; color: #999; }
    #${POPUP_ID} .cnki-tb-body { padding: 4px 0; }
    #${POPUP_ID} .cnki-tb-result { padding: 12px 16px; }
    #${POPUP_ID} .cnki-tb-result-border { border-top: 1px solid #f0f0f0; }
    #${POPUP_ID} .cnki-tb-word { font-size: 15px; font-weight: 600; color: #222; margin-bottom: 4px; }
    #${POPUP_ID} .cnki-tb-source { font-size: 12px; color: #888; margin-bottom: 6px; }
    #${POPUP_ID} .cnki-tb-abstract { font-size: 13px; color: #555; line-height: 1.6; margin-bottom: 8px; }
    #${POPUP_ID} .cnki-tb-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    #${POPUP_ID} .cnki-tb-tag {
      display: inline-block; font-size: 11px; color: #2347ff; background: #d0e3ff;
      padding: 2px 8px; border-radius: 3px;
    }
    #${POPUP_ID} .cnki-tb-citation { font-size: 11px; color: #e67e22; }
    #${POPUP_ID} .cnki-tb-footer {
      display: block; text-align: center; padding: 10px 16px;
      font-size: 13px; color: #2347ff; text-decoration: none;
      border-top: 1px solid #f0f0f0; border-radius: 0 0 10px 10px; cursor: pointer;
    }
    #${POPUP_ID} .cnki-tb-footer:hover { background: #f8f9ff; }
    #${POPUP_ID} .cnki-tb-empty-msg { text-align: center; padding: 24px 16px; color: #999; font-size: 14px; }
    #${POPUP_ID} .cnki-tb-error-msg { text-align: center; padding: 24px 16px; color: #e74c3c; font-size: 13px; }
    #${POPUP_ID} .cnki-tb-popup::-webkit-scrollbar { width: 5px; }
    #${POPUP_ID} .cnki-tb-popup::-webkit-scrollbar-track { background: transparent; }
    #${POPUP_ID} .cnki-tb-popup::-webkit-scrollbar-thumb { background: #d0d0d0; border-radius: 3px; }

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
  `;
  document.head.appendChild(style);
}

function renderResults(results, x, y, keyword) {
  hideLoadingIndicator();

  const container = document.getElementById(POPUP_ID);
  if (!container) return;

  if (!results || results.length === 0) {
    container.innerHTML = `
      <div class="cnki-tb-popup cnki-tb-empty">
        <div class="cnki-tb-header">
          <span class="cnki-tb-title">CNKI 工具书</span>
        </div>
        <div class="cnki-tb-body">
          <div class="cnki-tb-empty-msg">未找到相关工具书释义</div>
        </div>
      </div>
    `;
  } else {
    container.innerHTML = `
      <div class="cnki-tb-popup">
        <div class="cnki-tb-header">
          <span class="cnki-tb-title">CNKI 工具书</span>
          <span class="cnki-tb-count">${results.length} 条结果</span>
        </div>
        <div class="cnki-tb-body">
          ${results.map((item, i) => `
            <div class="cnki-tb-result ${i > 0 ? 'cnki-tb-result-border' : ''}">
              <div class="cnki-tb-word">${escapeHtml(item.title)}</div>
              <div class="cnki-tb-source">来源：《${escapeHtml(item.bookName)}》</div>
              <div class="cnki-tb-abstract">${escapeHtml(truncate(item.abstract, 200))}</div>
              <div class="cnki-tb-meta">
                ${item.subject ? `<span class="cnki-tb-tag">${escapeHtml(item.subject)}</span>` : ''}
                ${item.citationCount ? `<span class="cnki-tb-citation">被引 ${item.citationCount} 次</span>` : ''}
              </div>
            </div>
          `).join('')}
        </div>
        <a class="cnki-tb-footer" href="https://gongjushu.cnki.net/rbook/search/simplesearch?key=${encodeURIComponent(keyword)}" target="_blank" rel="noopener">
          查看更多释义 →
        </a>
      </div>
    `;
  }

  positionPopup(container, x, y);
  container.style.display = 'block';
  popupVisible = true;
}

function renderError(message, x, y) {
  hideLoadingIndicator();
  const container = document.getElementById(POPUP_ID);
  if (!container) return;

  container.innerHTML = `
    <div class="cnki-tb-popup cnki-tb-empty">
      <div class="cnki-tb-header">
        <span class="cnki-tb-title">CNKI 工具书</span>
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
}

function getSelectedText() {
  const sel = window.getSelection();
  return sel ? sel.toString().trim() : '';
}

// 缓存一个 div 用于 HTML 转义
const escDiv = document.createElement('div');
function escapeHtml(str) {
  escDiv.textContent = str;
  return escDiv.innerHTML;
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

// 检测与当前 popup 同一词条的重复查询
function isDuplicateOfCurrentKeyword(text) {
  return popupVisible && text === lastKeyword;
}

// --- 事件处理 ---

document.addEventListener('mouseup', function (e) {
  if (isInsidePopup(e.target)) return;

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
  injectPopupStyles();
  showLoadingIndicator(e.clientX, e.clientY);

  lastKeyword = selectedText;

  // 调用 background 进行查询（带重试）
  sendMessageWithRetry({ action: 'searchToolbook', keyword: selectedText }, 2, 500)
    .then(response => {
      if (!response || !response.success) {
        renderError(response?.error || '查询失败', e.clientX, e.clientY);
        return;
      }
      renderResults(response.data, e.clientX, e.clientY, selectedText);
    })
    .catch(err => {
      renderError(err.message || '查询失败', e.clientX, e.clientY);
    });
}, false);

// 点击页面其他区域关闭弹窗
document.addEventListener('mousedown', function (e) {
  if (isInsidePopup(e.target)) return;
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

// 弹窗内点击链接不关闭
document.addEventListener('click', function (e) {
  if (isInsidePopup(e.target)) {
    e.stopPropagation();
  }
}, true);

// 带重试的 sendMessage（处理 MV3 service worker 冷启动问题）
function sendMessageWithRetry(msg, retries, delayMs) {
  return new Promise((resolve, reject) => {
    function attempt(n) {
      chrome.runtime.sendMessage(msg, (response) => {
        if (chrome.runtime.lastError) {
          if (n > 0) {
            setTimeout(() => attempt(n - 1), delayMs);
          } else {
            reject(new Error(chrome.runtime.lastError.message));
          }
          return;
        }
        resolve(response);
      });
    }
    attempt(retries);
  });
}
