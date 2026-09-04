/**
 * 桌面版工具书查词 —— 本地后端服务
 *
 * 参考 nextai-translator 的桌面实现思路：
 *   - 划词/输入查询词 → 由"后端层"发起请求，绕过浏览器 CORS 限制
 *     （nextai 用 Tauri Rust 命令做 fetch；这里用 Node 本地服务，同理）
 *   - 查询 CNKI 工具书词条释义查询接口
 *
 * 说明：
 *   - 该接口本身无需登录也能返回词条基本信息（词目/释义摘要/来源/被引等），
 *     与浏览器扩展的实现一致。完整释义正文需要机构内网/登录态（非本工具范围）。
 *   - 为避免给日志留下长篇内容，正文只做截断展示。
 *
 * 运行： node server.js    （默认端口 8345）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8345;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- CNKI 工具书查询 API ----------
const QUERY_URL = 'https://t.cnki.net/rbook-api/v1/criteria/query?uniplatform=NRBOOK';
const ENTRY_URL = 'https://t.cnki.net/rbook-api/v1/entry/detail?uniplatform=NRBOOK';

function buildQueryPayload(keyword, size = 8) {
  const trimmed = String(keyword || '').trim();
  if (!trimmed) {
    throw new Error('查询词不能为空');
  }
  return {
    resource: 'CROSSDB',
    product: 'TOTAL',
    q: {
      userScope: {
        title: '',
        logic: 'AND',
        items: [
          { key: '', title: '词目', logic: 'AND', operator: 'DEFAULT', uf: 'ET', uv: trimmed },
          { key: '', title: '词目', logic: 'AND', operator: 'DEFAULT', uf: 'LC', uv: 'Y' },
        ],
        childItems: [],
      },
      groupScope: { title: '', logic: 'AND', items: [], childItems: [] },
    },
    extend: 0,
    start: 1,
    size,
    type: 0,
    sort: 'FFD',
    sequence: 'desc',
  };
}

function stripHtml(str) {
  return String(str || '').replace(/<[^>]*>/g, '');
}

function parseVSM(vsmStr) {
  if (!vsmStr) return [];
  return String(vsmStr)
    .split(',')
    .map((pair) => {
      const lastColon = pair.lastIndexOf(':');
      if (lastColon === -1) return null;
      const word = pair.slice(0, lastColon).trim();
      const freq = parseInt(pair.slice(lastColon + 1).trim(), 10) || 0;
      return { word, freq };
    })
    .filter(Boolean)
    .slice(0, 12);
}

function normalizeResults(json) {
  const items = (json && json.data && json.data.data) || [];
  return items.map((item) => {
    const meta = {};
    (item.metadata || []).forEach((m) => {
      meta[m.name] = m.value;
    });
    const relations = {};
    (item.relations || []).forEach((r) => {
      relations[r.scope] = r.url;
    });
    const tablename = meta.TN || '';
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
      tablename,
      product: tablename.replace(/\d+$/, ''), // CRFD2025 → CRFD
      readonlineUrl: relations.readonline || '',
      vsm: parseVSM(meta.VSM || ''),
    };
  });
}

async function postJson(url, payload) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await resp.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {
    json = { code: -1, message: '返回非 JSON: ' + text.slice(0, 200) };
  }
  return { status: resp.status, json };
}

// ---------- HTTP 服务 ----------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(''));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // REST 查询词条（供前端 /api/search?word=xxx）
  if (url.pathname === '/api/search' && req.method === 'GET') {
    const word = url.searchParams.get('word') || '';
    const size = Math.min(parseInt(url.searchParams.get('size') || '8', 10) || 8, 20);
    try {
      const payload = buildQueryPayload(word, size);
      const { status, json } = await postJson(QUERY_URL, payload);
      if ((status >= 200 && status < 300) && json.code === 0) {
        sendJson(res, 200, {
          ok: true,
          total: (json.data && json.data.total) || 0,
          results: normalizeResults(json),
        });
      } else {
        sendJson(res, 200, {
          ok: false,
          error: json.message || `请求失败 (HTTP ${status})`,
        });
      }
    } catch (e) {
      sendJson(res, 200, { ok: false, error: String(e && e.message || e) });
    }
    return;
  }

  // REST 获取词条完整释义（可选，登录态/机构内网下可用）
  if (url.pathname === '/api/detail' && req.method === 'POST') {
    let body = {};
    try {
      body = JSON.parse((await readBody(req)) || '{}');
    } catch (_) {
      body = {};
    }
    const { fn, tablename, product, scope = 'content' } = body;
    try {
      const { status, json } = await postJson(ENTRY_URL, {
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
        idenid: '',
      });
      if ((status >= 200 && status < 300) && json.code === 0) {
        const entry = json.data && json.data.data && json.data.data[0];
        const content = stripHtml((entry && entry.content) || '').trim();
        sendJson(res, 200, { ok: !!content, content });
      } else {
        sendJson(res, 200, { ok: false, error: json.message || `内容获取失败 (HTTP ${status})` });
      }
    } catch (e) {
      sendJson(res, 200, { ok: false, error: String(e && e.message || e) });
    }
    return;
  }

  // 静态资源（前端页面）
  if (url.pathname === '/' || url.pathname === '/index.html') {
    serveFile(res, path.join(PUBLIC_DIR, 'index.html'), 'text/html; charset=utf-8');
    return;
  }
  const filePath = path.join(PUBLIC_DIR, url.pathname);
  if (filePath.startsWith(PUBLIC_DIR) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    const mime = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.ico': 'image/x-icon',
    }[ext] || 'application/octet-stream';
    serveFile(res, filePath, mime);
    return;
  }

  sendJson(res, 404, { ok: false, error: 'Not Found' });
});

function serveFile(res, filePath, type) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendJson(res, 404, { ok: false, error: 'Not Found' });
      return;
    }
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
}

server.listen(PORT, () => {
  console.log(`桌面版工具书查词已启动： http://localhost:${PORT}`);
  console.log('在浏览器打开上面地址即可使用（此工具尚未关闭）；Ctrl+C 退出。');
});

// 简单连通性自检（不阻塞启动）
postJson(QUERY_URL, buildQueryPayload('Meta分析', 1))
  .then(({ json }) => {
    if (json.code === 0) {
      console.log('[自检] CNKI 工具书查询接口连通正常');
    } else {
      console.log('[自检] 接口连通但返回: ' + (json.message || json.code));
    }
  })
  .catch((e) => console.log('[自检] 接口暂不可达: ' + (e && e.message || e)));
