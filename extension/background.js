// 缓存最近查询结果，避免重复请求
const resultCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 分钟
const CACHE_MAX = 200; // 最大缓存条目数

// 定期清理过期缓存
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of resultCache) {
    if (now - entry.timestamp > CACHE_TTL) {
      resultCache.delete(key);
    }
  }
}, 60 * 1000);

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'searchToolbook') {
    searchToolbook(request.keyword)
      .then(data => sendResponse({ success: true, data }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // 保持消息通道打开
  }

  if (request.action === 'checkApiStatus') {
    checkApiStatus()
      .then(ok => sendResponse({ available: ok }))
      .catch(() => sendResponse({ available: false }));
    return true;
  }
});

async function searchToolbook(keyword) {
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
