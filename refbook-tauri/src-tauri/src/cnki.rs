// CNKI 工具书查询逻辑 —— 移植自 refbook-desktop/electron/cnki.js
use serde::{Deserialize, Serialize};
use serde_json::json;

const QUERY_URL: &str = "https://t.cnki.net/rbook-api/v1/Criteria/query?uniplatform=NRBOOK";
const ENTRY_URL: &str = "https://t.cnki.net/rbook-api/v1/entry/detail?uniplatform=NRBOOK";

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub title: String,
    #[serde(rename = "abstract")]
    pub abstract_text: String,
    pub book_name: String,
    pub subject: String,
    pub topic: String,
    pub publish_time: String,
    pub citation_count: String,
    #[serde(rename = "fn")]
    pub fn_: String,
    pub bid: String,
    pub tablename: String,
    pub product: String,
    pub readonline_url: String,
    pub vsm: Vec<VsmItem>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct VsmItem {
    pub word: String,
    pub freq: i64,
}

fn strip_html(s: &str) -> String {
    // 简易去标签：去掉 <...>，解码常见实体
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for ch in s.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .trim()
        .to_string()
}

fn parse_vsm(s: &str) -> Vec<VsmItem> {
    s.split(',')
        .filter_map(|pair| {
            let i = pair.rfind(':')?;
            let word = pair[..i].trim().to_string();
            let freq = pair[i + 1..].trim().parse().unwrap_or(0);
            if word.is_empty() {
                None
            } else {
                Some(VsmItem { word, freq })
            }
        })
        .take(12)
        .collect()
}

fn build_query_payload(keyword: &str, size: i64) -> serde_json::Value {
    json!({
        "resource": "CROSSDB",
        "product": "TOTAL",
        "q": {
            "userScope": {
                "title": "", "logic": "AND",
                "items": [
                    { "key": "", "title": "词目", "logic": "AND", "operator": "DEFAULT", "uf": "ET", "uv": keyword },
                    { "key": "", "title": "词目", "logic": "AND", "operator": "DEFAULT", "uf": "LC", "uv": "Y" }
                ],
                "childItems": []
            },
            "groupScope": { "title": "", "logic": "AND", "items": [], "childItems": [] }
        },
        "extend": 0, "start": 1, "size": size, "type": 0, "sort": "FFD", "sequence": "desc"
    })
}

fn meta_get(meta: &[serde_json::Value], name: &str) -> String {
    meta.iter()
        .find(|m| m.get("name").and_then(|v| v.as_str()) == Some(name))
        .and_then(|m| m.get("value"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

fn rel_get(rels: &[serde_json::Value], scope: &str) -> String {
    rels.iter()
        .find(|r| r.get("scope").and_then(|v| v.as_str()) == Some(scope))
        .and_then(|r| r.get("url"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

fn normalize_results(json: &serde_json::Value) -> Vec<Entry> {
    let items = json
        .pointer("/data/data")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    items.iter().map(|item| {
        let meta = item.get("metadata").and_then(|v| v.as_array())
            .cloned().unwrap_or_default();
        let rels = item.get("relations").and_then(|v| v.as_array())
            .cloned().unwrap_or_default();
        let tablename = meta_get(&meta, "TN");
        let product = tablename.trim_end_matches(|c: char| c.is_ascii_digit()).to_string();
        Entry {
            title: strip_html(&meta_get(&meta, "TI")),
            abstract_text: strip_html(&meta_get(&meta, "AB")),
            book_name: meta_get(&meta, "BTI"),
            subject: meta_get(&meta, "ZJTI"),
            topic: meta_get(&meta, "ZTTI"),
            publish_time: meta_get(&meta, "PT"),
            citation_count: meta_get(&meta, "NOC"),
            fn_: meta_get(&meta, "FN"),
            bid: meta_get(&meta, "BID"),
            product,
            readonline_url: rel_get(&rels, "readonline"),
            vsm: parse_vsm(&meta_get(&meta, "VSM")),
            tablename,
        }
    }).collect()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    pub ok: bool,
    pub total: i64,
    pub results: Vec<Entry>,
    pub error: String,
}

pub async fn search_refbook(keyword: &str, size: i64) -> SearchResponse {
    let client = reqwest::Client::new();
    let payload = build_query_payload(keyword, size);
    match client.post(QUERY_URL).json(&payload).send().await {
        Ok(resp) => {
            let status = resp.status();
            let json: serde_json::Value = match resp.json().await {
                Ok(v) => v,
                Err(e) => {
                    return SearchResponse {
                        ok: false, total: 0, results: vec![],
                        error: format!("返回非 JSON: {e}"),
                    };
                }
            };
            if !status.is_success() || json.get("code").and_then(|v| v.as_i64()) != Some(0) {
                let msg = json.get("message").and_then(|v| v.as_str())
                    .unwrap_or("").to_string();
                return SearchResponse {
                    ok: false, total: 0, results: vec![],
                    error: if msg.is_empty() { format!("请求失败 (HTTP {status})") } else { msg },
                };
            }
            let total = json.pointer("/data/total").and_then(|v| v.as_i64()).unwrap_or(0);
            SearchResponse { ok: true, total, results: normalize_results(&json), error: String::new() }
        }
        Err(e) => SearchResponse {
            ok: false, total: 0, results: vec![],
            error: format!("网络错误: {e}"),
        },
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetailResponse {
    pub ok: bool,
    pub content: String,
    pub error: String,
}

pub async fn fetch_entry_detail(fn_: &str, tablename: &str, product: &str) -> DetailResponse {
    let client = reqwest::Client::new();
    let tablename = if tablename.is_empty() { "CRFD2025" } else { tablename };
    let product = if product.is_empty() { "CRFD" } else { product };
    let payload = json!({
        "filename": fn_, "tablename": tablename, "product": product,
        "platform": "NRBOOK", "type": "REFBOOK", "scope": "content",
        "cflag": "overlay", "dflag": "词条", "language": "CHS",
        "pages": "", "sid": "", "idenid": ""
    });
    match client.post(ENTRY_URL).json(&payload).send().await {
        Ok(resp) => {
            let status = resp.status();
            let json: serde_json::Value = match resp.json().await {
                Ok(v) => v,
                Err(e) => {
                    return DetailResponse { ok: false, content: String::new(), error: format!("返回非 JSON: {e}") };
                }
            };
            if !status.is_success() || json.get("code").and_then(|v| v.as_i64()) != Some(0) {
                let msg = json.get("message").and_then(|v| v.as_str()).unwrap_or("").to_string();
                return DetailResponse {
                    ok: false, content: String::new(),
                    error: if msg.is_empty() { format!("内容获取失败 (HTTP {status})") } else { msg },
                };
            }
            let content = json.pointer("/data/data/0/content")
                .and_then(|v| v.as_str())
                .map(|s| strip_html(s))
                .unwrap_or_default();
            DetailResponse { ok: !content.is_empty(), content, error: String::new() }
        }
        Err(e) => DetailResponse { ok: false, content: String::new(), error: format!("网络错误: {e}") },
    }
}

pub async fn ping() -> bool {
    search_refbook("测试", 1).await.ok
}
