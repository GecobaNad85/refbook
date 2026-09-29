// 缓存最近查询结果，避免重复请求
const resultCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 分钟
const CACHE_MAX = 200; // 最大缓存条目数

// 条目完整内容缓存（key: fn）
const entryContentCache = new Map();
const ENTRY_CACHE_TTL = 30 * 60 * 1000; // 30 分钟

// 存储的 invoice/nonce 凭证
let storedInvoice = '';
let storedNonce = '';
const INVOICE_KEY = 'cnki_tb_invoice';
const NONCE_KEY = 'cnki_tb_nonce';

// 启动时从 chrome.storage 加载存储的凭证
chrome.storage.local.get([INVOICE_KEY, NONCE_KEY]).then(result => {
  if (result[INVOICE_KEY]) storedInvoice = result[INVOICE_KEY];
  if (result[NONCE_KEY]) storedNonce = result[NONCE_KEY];
}).catch(() => {});

// 点击工具栏图标打开说明页面
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('help.html') });
});

// 定期清理过期缓存
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of resultCache) {
    if (now - entry.timestamp > CACHE_TTL) {
      resultCache.delete(key);
    }
  }
  for (const [key, entry] of entryContentCache) {
    if (now - entry.timestamp > ENTRY_CACHE_TTL) {
      entryContentCache.delete(key);
    }
  }
}, 60 * 1000);

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // 轻量 ping：仅用于唤醒 service worker，立即响应
  if (request.action === 'ping') {
    sendResponse({ success: true });
    return false;
  }

  if (request.action === 'searchRefbook') {
    searchRefbook(request.keyword)
      .then(data => sendResponse({ success: true, data }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === 'fetchEntryContent') {
    fetchFullContent(request.fn, request.bid, request.tablename, request.product)
      .then(content => sendResponse({ success: true, content }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === 'checkApiStatus') {
    checkApiStatus()
      .then(ok => sendResponse({ available: ok }))
      .catch(() => sendResponse({ available: false }));
    return true;
  }

  // 从 content.js 接收 invoice/nonce 凭证
  if (request.action === 'storeAuthToken') {
    if (request.invoice) {
      storedInvoice = request.invoice;
      storedNonce = request.nonce || '';
      chrome.storage.local.set({
        [INVOICE_KEY]: storedInvoice,
        [NONCE_KEY]: storedNonce
      }).catch(() => {});
    }
    sendResponse({ success: true });
    return true;
  }

  // 从 content.js 接收条目完整内容缓存
  if (request.action === 'cacheEntryContent') {
    if (request.fn && request.content) {
      entryContentCache.set(request.fn, {
        content: request.content,
        timestamp: Date.now()
      });
    }
    sendResponse({ success: true });
    return true;
  }

  // content.js 请求查看已缓存的条目内容
  if (request.action === 'getCachedEntryContent') {
    const cached = entryContentCache.get(request.fn);
    if (cached && Date.now() - cached.timestamp < ENTRY_CACHE_TTL
        && isValidEntryContent(cached.content)) {
      sendResponse({ success: true, content: { content: cached.content } });
    } else {
      sendResponse({ success: false });
    }
    return true;
  }
});

async function searchRefbook(keyword) {
  const trimmed = keyword.trim();
  if (!trimmed) return [];

  // 检查缓存
  const cached = resultCache.get(trimmed);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  const payload = {
    resource: "CROSSDB",
    product: "TOTAL",
    q: {
      userScope: {
        title: "",
        logic: "AND",
        items: [
          { key: "", title: "词目", logic: "AND", operator: "DEFAULT", uf: "ET", uv: trimmed },
          { key: "", title: "词目", logic: "AND", operator: "DEFAULT", uf: "LC", uv: "Y" }
        ],
        childItems: []
      },
      groupScope: { title: "", logic: "AND", items: [], childItems: [] }
    },
    extend: 0,
    start: 1,
    size: 5,
    type: 0,
    sort: "FFD",
    sequence: "desc"
  };

  const resp = await fetch(
    'https://t.cnki.net/rbook-api/v1/criteria/query?uniplatform=NRBOOK',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(payload)
    }
  );

  if (!resp.ok) {
    throw new Error(`API 请求失败: ${resp.status} ${resp.statusText}`);
  }

  const json = await resp.json();

  if (json.code !== 0) {
    throw new Error(json.message || 'API 返回异常');
  }

  const items = (json.data && json.data.data) || [];

  // 解析为友好的格式
  const results = items.map(item => {
    const meta = {};
    (item.metadata || []).forEach(m => { meta[m.name] = m.value; });

    const relations = {};
    (item.relations || []).forEach(r => { relations[r.scope] = r.url; });

    return {
      title: stripHtml(meta.TI || ''),
      abstract: stripHtml(meta.AB || ''),
      bookName: meta.BTI || '',
      subject: meta.ZJTI || '',
      topic: meta.ZTTI || '',
      publishTime: meta.PT || '',
      citationCount: meta.NOC || '',
      fn: meta.FN || '',
      bid: meta.BID || '',
      tablename: meta.TN || '',
      product: meta.TN ? meta.TN.replace(/\d+$/, '') : '',  // CRFD2025 → CRFD
      readonlineUrl: relations.readonline || '',
      coverUrl: relations.cover || null,
      // 高频关联词
      vsm: parseVSM(meta.VSM || '')
    };
  });

  // 写入缓存（超限时删除最旧的）
  if (resultCache.size >= CACHE_MAX) {
    const oldest = resultCache.keys().next().value;
    if (oldest) resultCache.delete(oldest);
  }
  resultCache.set(trimmed, { data: results, timestamp: Date.now() });

  return results;
}

function stripHtml(str) {
  return str.replace(/<[^>]*>/g, '');
}

// 简易 HTML 属性/文本转义（SW 无 DOM）。转义 & < > "，输出可用于属性或文本节点。
function escHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 条目释文 HTML → 保留 <img>/<table>/<br> 的安全 HTML（SW 无 DOM，用正则处理）。
// <img>/<table> 属性转义后保留；<br>/块级标签结束 → <br>；其余标签删除；文本中的换行
// 是源 HTML 固定宽度的折行残留，折叠为单个空格。表格内保留 <sup>/<sub>/<br>/<img>。
function htmlToContentHtml(html) {
  const BR = '\x1F'; // 语义换行占位符（非空白，不被 \s 折叠）
  const PH = '\x1E'; // 通用占位符前缀（img/tbl），后接序号 + \x1E
  const phMap = []; // 顺序无关，按序号取回
  const stash = (s) => { phMap.push(s); return PH + phMap.length + '\x1E'; };
  const getAttr = (tag, name) => {
    const m = tag.match(new RegExp('\\b' + name + '\\s*=\\s*("[^"]*"|\'[^\']*\'|[^\\s>]+)', 'i'));
    return m ? m[1].replace(/^["']|["']$/g, '').trim() : '';
  };
  const escTxt = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // 1. 先抽出 <table>...</table>（整块替换为占位符，内部独立清洗）
  html = html.replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, (m) => stash(cleanTable(m)));

  // 2. <img> → 安全 <img> 占位符
  html = html.replace(/<img\b[^>]*>/gi, (m) => {
    const src = getAttr(m, 'src');
    if (!src) return '';
    return stash('<img src="' + escHtml(src) + '" alt="' + escHtml(getAttr(m, 'alt')) + '"' +
      (getAttr(m, 'width') ? ' width="' + escHtml(getAttr(m, 'width')) + '"' : '') +
      (getAttr(m, 'height') ? ' height="' + escHtml(getAttr(m, 'height')) + '"' : '') +
      ' style="max-width:100%;height:auto;" loading="lazy">');
  });

  // 3. 内联白名单标签（sup/sub/b/i/em/strong）整对抽出为占位符（含标签对），避免被后续去标签删掉
  const inlineRe = /<(\/?)(sup|sub|b|i|em|strong)\b[^>]*>/gi;
  html = html.replace(inlineRe, (m) => {
    const tag = m.toLowerCase().replace(/\s+style="[^"]*"/g, '').replace(/\s+class="[^"]*"/g, '');
    return stash(tag); // 存 <sup>、</sup> 等，还原时直接插回
  });

  // 4. <br> / 块级结束标签 → 语义换行
  html = html
    .replace(/<br[^>]*>/gi, BR)
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|section)>/gi, BR)
    // 5. 去除其余标签
    .replace(/<[^>]*>/g, '')
    // 6. &nbsp; → 空格
    .replace(/&nbsp;/g, ' ')
    // 7. 折叠空白（含折行换行）
    .replace(/\s+/g, ' ')
    // 8. 语义换行 → <br>
    .replace(new RegExp(BR, 'g'), '<br>')
    // 9. 压缩多余 <br>
    .replace(/(<br\s*\/?>\s*){3,}/gi, '<br><br>')
    .trim();

  // 10. 还原占位符（img/table/inline）。表格还原后其内部可能仍含单元格内联标签占位符，
  //     需循环还原至稳定（每轮 PH 占位符数递减，上限 phMap.length 轮）
  const PH_RE = new RegExp(PH + '(\\d+)\\x1E', 'g');
  let prev;
  do {
    prev = html;
    html = html.replace(PH_RE, (_, i) => phMap[Number(i) - 1] || '');
  } while (html !== prev);
  return html;

  // 清洗单个表格 HTML：保留结构 + colspan/rowspan/valign，单元格内仅留白名单内联标签 + 文本
  function cleanTable(tbl) {
    const tblAttrs = ' border="1" cellspacing="0" cellpadding="4" style="border-collapse:collapse;width:auto;max-width:100%;font-size:12px;margin:6px 0;"';
    const inlineAllowed = { sup:1, sub:1, b:1, i:1, em:1, strong:1, span:1, a:1 };
    const cleanInline = (s) => {
      // <br> 保留；<img> 重建；白名单内联标签保留（属性丢弃，a 仅留 http(s) href）；其余删标签留文本。
      // 占位符用 stash()（返回 PH+序号+PH，不含 <>，不会被后续去标签/转义破坏，最终统一还原）
      s = s.replace(/<img\b[^>]*>/gi, (m) => {
        const src = getAttr(m, 'src');
        if (!src) return '';
        return stash('<img src="' + escHtml(src) + '" alt="' + escHtml(getAttr(m, 'alt')) + '" style="max-width:100%;height:auto;vertical-align:middle;" loading="lazy">');
      }).replace(/<br\s*\/?>/gi, stash('<br>'));
      // 白名单内联标签整对抽出为占位符（存标签本身，还原时直接插回）
      s = s.replace(/<\/?(sup|sub|b|i|em|strong|span)\b[^>]*>/gi, (m) => stash(m.toLowerCase().replace(/\s+style="[^"]*"/g, '').replace(/\s+class="[^"]*"/g, '')));
      s = s.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (m, attrs, inner) => {
        const href = getAttr('<a' + attrs + '>', 'href').trim();
        if (!/^https?:\/\//i.test(href)) return inner; // 非 http 链接：丢弃 <a>，留内容
        return stash('<a href="' + escHtml(href) + '">') + inner + stash('</a>');
      });
      s = s.replace(/<[^>]*>/g, ''); // 去除其余标签
      s = escTxt(s).replace(/\s+/g, ' ').trim() || '&nbsp;';
      // 占位符在第 10 步统一还原（PH+序号+PH）
      return s;
    };
    let out = '<table' + tblAttrs + '>';
    const rows = tbl.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || [];
    for (const tr of rows) {
      out += '<tr>';
      const cells = tr.match(/<t[hd]\b[^>]*>[\s\S]*?<\/t[hd]>/gi) || [];
      for (const cell of cells) {
        const tag = /<th\b/i.test(cell) ? 'th' : 'td';
        const attrs = (cell.match(/<t[hd]\b([^>]*)>/i) || [])[1] || '';
        const parts = [];
        const cs = getAttr('<td' + attrs + '>', 'colspan'); if (cs) parts.push('colspan="' + escHtml(cs) + '"');
        const rs = getAttr('<td' + attrs + '>', 'rowspan'); if (rs) parts.push('rowspan="' + escHtml(rs) + '"');
        const va = getAttr('<td' + attrs + '>', 'valign'); if (va) parts.push('style="vertical-align:' + escHtml(va) + '"');
        const inner = (cell.match(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/i) || [])[1] || '';
        out += '<' + tag + (parts.length ? ' ' + parts.join(' ') : '') + '>' + cleanInline(inner) + '</' + tag + '>';
      }
      out += '</tr>';
    }
    return out + '</table>';
  }
}

function parseVSM(vsmStr) {
  if (!vsmStr) return [];
  return vsmStr.split(',').map(pair => {
    // 使用 lastIndexOf(':') 分离词和频次，避免词本身含冒号
    const lastColon = pair.lastIndexOf(':');
    if (lastColon === -1) return null;
    const word = pair.slice(0, lastColon).trim();
    const freq = parseInt(pair.slice(lastColon + 1).trim(), 10) || 0;
    return { word, freq };
  }).filter(Boolean).slice(0, 10);
}

// 校验缓存的条目内容是否为有效释文（排除 CDN/SPA 渲染失败时的错误占位文本）
function isValidEntryContent(content) {
  return !!(content && content.length > 10
    && !content.includes('does not work')
    && !content.includes('JavaScript enabled'));
}

async function fetchFullContent(fn, bid, tablename, product) {
  // 1. 先检查内存中是否有缓存的条目内容
  const cached = entryContentCache.get(fn);
  if (cached && Date.now() - cached.timestamp < ENTRY_CACHE_TTL
      && isValidEntryContent(cached.content)) {
    return { content: cached.content };
  }

  // 2. 尝试用 cookie 直接请求 API
  //    注意：background service worker 的 credentials: 'include' 可能不共享用户页面 cookie，
  //    但如果 CNKI 在 t.cnki.net 域下也设置了 cookie，仍然有可能工作
  try {
    const result = await callEntryApiWithCookie(fn, tablename, product);
    entryContentCache.set(fn, { content: result.content, timestamp: Date.now() });
    return result;
  } catch (e) {
    // cookie API 方式失败
  }

  // 3. 有存储的 invoice/nonce 凭证时，作为兜底
  //    注意：content.js 会优先尝试直接通过页面上下文（有 cookie）调用 API，
  //    background 只在 content.js 无法直接调用时被使用
  if (storedInvoice) {
    try {
      const result = await callEntryApi(fn, tablename, storedInvoice, storedNonce, product);
      entryContentCache.set(fn, { content: result.content, timestamp: Date.now() });
      return result;
    } catch (e) {
      // 仅在确认是登录过期（code -1）时清除凭证，避免 CDN 抖动等临时错误误清
      if (e && e.message === '未登录或登录已过期') {
        storedInvoice = '';
        storedNonce = '';
        chrome.storage.local.remove([INVOICE_KEY, NONCE_KEY]).catch(() => {});
      }
    }
  }

  // 4. 所有方式均失败
  throw new Error('无访问权限，请先访问 https://gongjushu.cnki.net/ 并登录');
}

// 单个 scope 的尝试：成功返回 { content }, 失败抛错
async function tryEntryApiScope(fn, tablename, product, scope) {
  const apiResp = await fetch(
    'https://t.cnki.net/rbook-api/v1/entry/detail?uniplatform=NRBOOK',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json;charset=utf-8',
        'language': 'CHS',
        'Origin': 'https://gongjushu.cnki.net',
        'Referer': 'https://gongjushu.cnki.net/',
        'Accept': 'application/json, text/plain, */*'
      },
      credentials: 'include',
      body: JSON.stringify({
        filename: fn,
        tablename: tablename || 'CRFD2025',
        product: product || 'CRFD',
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

  if (!apiResp.ok) {
    throw new Error(`内容 API 请求失败(${scope}): ${apiResp.status}`);
  }

  const contentType = apiResp.headers.get('content-type') || '';
  if (!contentType.includes('json')) {
    const text = await apiResp.text();
    throw new Error(`内容 API 返回非 JSON(${scope}): ${text.slice(0, 200)}`);
  }

  const json = await apiResp.json();
  if (json.code !== 0) {
    throw new Error(json.message || '内容 API 返回异常');
  }

  const data = json.data;
  if (!data || !data.data || !data.data.length) {
    throw new Error('未获取到条目内容');
  }

  const entry = data.data[0];
  const rawContent = entry.content || '';
  const cleanContent = htmlToContentHtml(rawContent);

  if (!cleanContent) {
    throw new Error('条目内容为空');
  }
  return { content: cleanContent };
}

// 并发尝试多种 scope 值，任一成功即返回，全部失败时抛出 AggregateError
async function callEntryApiWithCookie(fn, tablename, product) {
  const scopes = ['content', 'preview', 'download'];
  // Promise.any：首个成功即返回，其余请求的结果被忽略
  return Promise.any(
    scopes.map(scope => tryEntryApiScope(fn, tablename, product, scope))
  );
}

async function callEntryApi(fn, tablename, invoice, nonce, product) {
  const apiResp = await fetch(
    'https://t.cnki.net/rbook-api/v1/entry/detail?uniplatform=NRBOOK',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json;charset=utf-8',
        'language': 'CHS',
        'Referer': 'https://gongjushu.cnki.net/'
      },
      credentials: 'include',
      body: JSON.stringify({
        filename: fn,
        tablename: tablename || 'CRFD2025',
        product: product || 'CRFD',
        platform: 'NRBOOK',
        type: 'REFBOOK',
        scope: 'download',
        cflag: 'overlay',
        dflag: '词条',
        language: 'CHS',
        invoice,
        nonce,
        pages: '',
        sid: '',
        idenid: ''
      })
    }
  );

  if (!apiResp.ok) throw new Error(`内容 API 请求失败: ${apiResp.status}`);

  const contentType = apiResp.headers.get('content-type') || '';
  if (!contentType.includes('json')) {
    const text = await apiResp.text();
    throw new Error(`内容 API 返回非 JSON: ${text.slice(0, 200)}`);
  }

  const json = await apiResp.json();
  if (json.code !== 0) {
    if (json.code === -1) throw new Error('未登录或登录已过期');
    throw new Error(json.message || '内容 API 返回异常');
  }

  const data = json.data;
  if (!data || !data.data || !data.data.length) throw new Error('未获取到条目内容');

  const entry = data.data[0];
  const rawContent = entry.content || '';
  const cleanContent = rawContent.replace(/<[^>]*>/g, '').trim();

  return { content: cleanContent };
}

async function checkApiStatus() {
  const resp = await fetch(
    'https://t.cnki.net/rbook-api/v1/criteria/query?uniplatform=NRBOOK',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        resource: "CROSSDB", product: "TOTAL",
        q: { userScope: { title: "", logic: "AND", items: [
          { key: "", title: "词目", logic: "AND", operator: "DEFAULT", uf: "ET", uv: "测试" },
          { key: "", title: "词目", logic: "AND", operator: "DEFAULT", uf: "LC", uv: "Y" }
        ], childItems: [] }, groupScope: { title: "", logic: "AND", items: [], childItems: [] } },
        extend: 0, start: 1, size: 1, type: 0, sort: "FFD", sequence: "desc"
      })
    }
  );
  return resp.ok;
}
