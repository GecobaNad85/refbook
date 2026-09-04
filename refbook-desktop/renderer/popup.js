/* 弹窗逻辑：收到选中文本后查询并展示 */
(function () {
  const { cnki } = window;
  const titleEl = document.getElementById('pw-title');
  const bodyEl = document.getElementById('pw-body');
  const metaEl = document.getElementById('pw-meta');
  const closeBtn = document.getElementById('pw-close');
  const openMain = document.getElementById('pw-open-main');

  closeBtn.addEventListener('click', () => cnki.closePopup());
  openMain.addEventListener('click', () => { cnki.focusMain(); cnki.closePopup(); });

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function lookup(word) {
    titleEl.textContent = word;
    bodyEl.innerHTML = '<div class="loading">查询中…</div>';
    metaEl.textContent = '';

    try {
      const j = await cnki.search(word, 5);
      if (!j.ok) {
        bodyEl.innerHTML = '<div class="error">' + esc(j.error || '查询失败') + '</div>';
        return;
      }
      const results = j.results || [];
      metaEl.textContent = '共 ' + (j.total || results.length) + ' 条';
      if (!results.length) {
        bodyEl.innerHTML = '<div class="empty">未找到相关词条</div>';
        return;
      }
      bodyEl.innerHTML = '';
      // 第一条展开释义，其余仅展示摘要
      results.forEach((r, i) => {
        const card = document.createElement('div');
        card.className = 'popup-card';
        card.innerHTML = '<div class="pw-title">' + esc(r.title) + '</div>';
        if (r.abstract) card.innerHTML += '<div class="pw-abs">' + esc(r.abstract) + '</div>';
        card.innerHTML += '<div class="pw-meta">' + esc(r.bookName || '') + (r.citationCount ? ' · 被引 ' + esc(r.citationCount) : '') + '</div>';
        if (i === 0) {
          const fullEl = document.createElement('div');
          fullEl.className = 'pw-full';
          fullEl.textContent = '正在加载释义…';
          card.appendChild(fullEl);
          cnki.detail({ fn: r.fn, tablename: r.tablename, product: r.product }).then((d) => {
            fullEl.textContent = d.ok ? d.content : (d.error || '完整释义不可用（可能需要登录态）');
          });
        }
        bodyEl.appendChild(card);
      });
    } catch (e) {
      bodyEl.innerHTML = '<div class="error">请求出错：' + esc(e && e.message || e) + '</div>';
    }
  }

  cnki.onPopupQuery((word) => lookup(word));
  cnki.onPopupMessage((m) => {
    titleEl.textContent = '提示';
    bodyEl.innerHTML = m.isError ? '<div class="error">' + esc(m.msg) + '</div>' : '<div class="loading">' + esc(m.msg) + '</div>';
  });
})();
