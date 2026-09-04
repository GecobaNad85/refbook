/**
 * CNKI 工具书查询逻辑 —— 供 Electron 主进程直接调用
 * 移植自 refbook-desktop/server.js，去掉 HTTP 外壳，暴露纯异步函数。
 */

const QUERY_URL = 'https://t.cnki.net/rbook-api/v1/Criteria/query?uniplatform=NRBOOK';
const ENTRY_URL = 'https://t.cnki.net/rbook-api/v1/entry/detail?uniplatform=NRBOOK';

function buildQueryPayload(keyword, size = 8) {
  const trimmed = String(keyword || '').trim();
  if (!trimmed) throw new Error('查询词不能为空');
  return {
    resource: 'CROSSDB',
    product: 'TOTAL',
    q: {
      userScope: {
        title: '', logic: 'AND',
        items: [
          { key: '', title: '词目', logic: 'AND', operator: 'DEFAULT', uf: 'ET', uv: trimmed },
          { key: '', title: '词目', logic: 'AND', operator: 'DEFAULT', uf: 'LC', uv: 'Y' },
        ],
        childItems: [],
      },
      groupScope: { title: '', logic: 'AND', items: [], childItems: [] },
    },
    extend: 0, start: 1, size, type: 0, sort: 'FFD', sequence: 'desc',
  };
}

function stripHtml(str) {
  return String(str || '').replace(/<[^>]*>/g, '');
}

function parseVSM(vsmStr) {
  if (!vsmStr) return [];
  return String(vsmStr).split(',').map((pair) => {
    const i = pair.lastIndexOf(':');
    if (i === -1) return null;
    return { word: pair.slice(0, i).trim(), freq: parseInt(pair.slice(i + 1).trim(), 10) || 0 };
  }).filter(Boolean).slice(0, 12);
}

function normalizeResults(json) {
  const items = (json && json.data && json.data.data) || [];
  return items.map((item) => {
    const meta = {};
    (item.metadata || []).forEach((m) => { meta[m.name] = m.value; });
    const relations = {};
    (item.relations || []).forEach((r) => { relations[r.scope] = r.url; });
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
      product: tablename.replace(/\d+$/, ''),
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
  let json;
  try { json = JSON.parse(text); }
  catch (_) { json = { code: -1, message: '返回非 JSON: ' + text.slice(0, 200) }; }
  return { status: resp.status, json };
}

/** 搜索词条，返回 { ok, total, results } 或 { ok:false, error } */
async function searchRefbook(keyword, size = 8) {
  const { status, json } = await postJson(QUERY_URL, buildQueryPayload(keyword, size));
  if (status < 200 || status >= 300 || json.code !== 0) {
    return { ok: false, error: json.message || `请求失败 (HTTP ${status})` };
  }
  return { ok: true, total: (json.data && json.data.total) || 0, results: normalizeResults(json) };
}

/** 获取完整释义正文，返回 { ok, content } 或 { ok:false, error } */
async function fetchEntryDetail({ fn, tablename, product }) {
  const { status, json } = await postJson(ENTRY_URL, {
    filename: fn,
    tablename: tablename || 'CRFD2025',
    product: product || 'CRFD',
    platform: 'NRBOOK',
    type: 'REFBOOK',
    scope: 'content',
    cflag: 'overlay',
    dflag: '词条',
    language: 'CHS',
    pages: '', sid: '', idenid: '',
  });
  if (status < 200 || status >= 300 || json.code !== 0) {
    return { ok: false, error: json.message || `内容获取失败 (HTTP ${status})` };
  }
  const entry = json.data && json.data.data && json.data.data[0];
  const content = stripHtml((entry && entry.content) || '').trim();
  return { ok: !!content, content };
}

/** 连通性自检 */
async function ping() {
  try {
    const { json } = await postJson(QUERY_URL, buildQueryPayload('测试', 1));
    return json.code === 0;
  } catch (e) { return false; }
}

module.exports = { searchRefbook, fetchEntryDetail, ping };
