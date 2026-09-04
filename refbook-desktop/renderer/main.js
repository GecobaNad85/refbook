/* 主窗口逻辑 —— 通过 window.cnki IPC 调用主进程查询 */
(function () {
  const { cnki } = window;
  const input = document.getElementById('word-input');
  const searchBtn = document.getElementById('search-btn');
  const resultsEl = document.getElementById('results');
  const metaBar = document.getElementById('meta-bar');
  const totalLabel = document.getElementById('total-label');
  const detailToggle = document.getElementById('detail-toggle');
  const detailPanel = document.getElementById('detail-panel');
  const statusDot = document.getElementById('status-dot');

  let currentResults = [];

  cnki.ping().then((ok) => {
    statusDot.className = 'status ' + (ok ? 'ok' : 'bad');
    statusDot.title = ok ? '接口连通正常' : '接口暂不可达';
  });
  cnki.onStatus((ok) => { statusDot.className = 'status ' + (ok ? 'ok' : 'bad'); });

  async function doSearch() {
    const word = input.value.trim();
    if (!word) return;
    currentResults = [];
    detailPanel.hidden = true;
    metaBar.hidden = true;
    resultsEl.innerHTML = '<div class="loading">正在查询 “' + esc(word) + '” …</div>';
    detailToggle.textContent = '🔖 查看完整释义';

    try {
      const j = await cnki.search(word, 8);
      if (!j.ok) {
        resultsEl.innerHTML = '<div class="error">' + esc(j.error || '查询失败') + '</div>';
        return;
      }
      currentResults = j.results || [];
      renderResults(j.total || currentResults.length);
    } catch (e) {
      resultsEl.innerHTML = '<div class="error">请求出错：' + esc(e && e.message || e) + '</div>';
    }
  }

  function renderResults(total) {
    resultsEl.innerHTML = '';
    totalLabel.textContent = '共 ' + total + ' 条词条';
    metaBar.hidden = false;
    if (!currentResults.length) {
      resultsEl.innerHTML = '<div class="empty">未找到相关词条，换个词试试。</div>';
      return;
    }
    currentResults.forEach((r) => {
      const card = document.createElement('article');
      card.className = 'card';
      const head = document.createElement('div');
      head.className = 'card-head';
      head.innerHTML = '<h2 class="word">' + esc(r.title) + '</h2>';
      if (r.citationCount) head.innerHTML += '<span class="cite">被引 ' + esc(r.citationCount) + '</span>';
      const body = document.createElement('div');
      body.className = 'card-body';
      if (r.abstract) {
        const p = document.createElement('p');
        p.className = 'abstract';
        p.textContent = r.abstract;
        body.appendChild(p);
      }
      const rows = document.createElement('div');
      rows.className = 'meta-rows';
      addRow(rows, '来源工具书', r.bookName);
      addRow(rows, '学科', r.subject + (r.topic ? ' / ' + r.topic : ''));
      addRow(rows, '出版时间', r.publishTime);
      addRow(rows, '书目编号', (r.fn || '') + (r.tablename ? ' · ' + r.tablename : ''));
      body.appendChild(rows);
      if (r.vsm && r.vsm.length) {
        const tags = document.createElement('div');
        tags.className = 'tags';
        r.vsm.forEach((v) => {
          const s = document.createElement('span');
          s.className = 'tag';
          s.textContent = v.word + ' ' + v.freq;
          tags.appendChild(s);
        });
        body.appendChild(tags);
      }
      if (r.readonlineUrl) {
        const link = document.createElement('a');
        link.className = 'read-link';
        link.href = '#';
        link.textContent = '查看在线词条 →';
        link.addEventListener('click', (e) => { e.preventDefault(); cnki.openExternal(r.readonlineUrl); });
        body.appendChild(link);
      }
      card.appendChild(head);
      card.appendChild(body);
      resultsEl.appendChild(card);
    });
  }

  function addRow(container, label, value) {
    if (!value) return;
    const row = document.createElement('div');
    row.className = 'meta-row';
    row.innerHTML = '<span class="k">' + esc(label) + '</span><span class="v">' + esc(value) + '</span>';
    container.appendChild(row);
  }

  detailToggle.addEventListener('click', async () => {
    if (!currentResults.length) return;
    if (!detailPanel.hidden) {
      detailPanel.hidden = true;
      detailToggle.textContent = '🔖 查看完整释义';
      return;
    }
    const first = currentResults[0];
    detailPanel.innerHTML = '<div class="loading">正在获取完整释义…</div>';
    detailPanel.hidden = false;
    detailToggle.textContent = '🔖 收起释义';
    try {
      const j = await cnki.detail({ fn: first.fn, tablename: first.tablename, product: first.product });
      if (j.ok && j.content) {
        detailPanel.innerHTML = '<div class="detail-card"><h3>' + esc(first.title) + '</h3><p class="full">' + esc(j.content) + '</p></div>';
      } else {
        detailPanel.innerHTML = '<div class="error">' + esc(j.error || '无法获取完整释义（可能需要机构内网或登录态）') + '</div>';
      }
    } catch (e) {
      detailPanel.innerHTML = '<div class="error">请求出错：' + esc(e && e.message || e) + '</div>';
    }
  });

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  searchBtn.addEventListener('click', doSearch);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
})();
