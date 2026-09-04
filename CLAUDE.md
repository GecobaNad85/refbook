# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CNKI 工具书划词查询 — a Chrome extension (Manifest V3) that lets users select text on any webpage and instantly look up definitions from CNKI's reference book database (gongjushu.cnki.net).

## Architecture

Two-file extension, no build step:

- **`extension/background.js`** — Service worker handling all API calls and credential management:
  - `searchRefbook(keyword)` → POSTs to `t.cnki.net/rbook-api/v1/criteria/query`, returns parsed results (title, abstract, fn, bid, etc.)
  - `fetchFullContent(fn, bid, tablename, product)` → fetches complete entry text via `t.cnki.net/rbook-api/v1/entry/detail`, requires `invoice`/`nonce` auth tokens
  - `callEntryApi(...)` — the actual API call for entry detail; strips HTML from `content` field
  - Auth tokens (`invoice`/`nonce`) are captured from CNKI pages (via content script), stored in memory + `chrome.storage.local`, and cleared on API auth failure
  - Two caches: `resultCache` (search results, 5 min TTL) and `entryContentCache` (full entry text, 30 min TTL)

- **`extension/content.js`** — Content script injected on all pages, handles UI and event logic:
  - **Auth capture** (runs on `*.cnki.net`): extracts `invoice`/`nonce` from URL params and `p.image_box` content from the DOM, sends to background via `storeAuthToken`/`cacheEntryContent` messages. Uses MutationObserver for SPA-rendered content (5s timeout)
  - **Redirect handler** (runs on `*.cnki.net`): `#cnki_redirect=...` hash-based redirect to bypass Referer checks when linking from non-CNKI pages to `bar.cnki.net`
  - **Popup lifecycle**: mouseup → show loading → search API → render results → auto-fetch first result's full text asynchronously. ESC / outside-click dismisses popup
  - **State vars**: `expandedFirstResult`, `firstResultFullText`, `lastResults`, `searchGeneration` (stale-async guard)
  - **Full text flow**: `autoFetchFullText` → `fetchAndExpandFirstResult` (checks entry cache first, then calls `fetchEntryContent` API). "查看全文" button uses same function with `silent: false`
  - **Segmentation & traditional→simplified fallback** (both run inside a shared `sandbox.html` iframe to bypass page CSP; libs load independently from `cdn.jsdelivr.net`):
    - `sandbox.html` loads SegmentIt (`segmentit@2.0.3`, smart word segmentation) and OpenCC (`opencc-js@1.4.2`, `OpenCC.Converter({from:'t',to:'cn'})` — dictionaries bundled at build time, no runtime fetch). Each posts its own `cnki-*-ready`/`-error` signal; one failing does not block the other.
    - Content-side: `getSandboxIframe()` creates the iframe lazily; `getSegmenter()`/`getConverter()` await the respective ready signal. `segmentViaIframe` (分词) and `toSimplified` (繁→简) are postMessage RPCs over the same iframe.
    - `queryWithSegmentation(keyword,x,y,gen)` = **方案① 串行兜底**: `runQueryChain` does integral query → (on miss) SegmentIt segmentation + parallel per-segment queries → multi-tab render. If the whole traditional chain yields nothing, `toSimplified(keyword)` is called; when the simplified text differs from the original (i.e. it contained traditional chars), `runQueryChain` runs again on the simplified text. Pure-simplified or OpenCC-unavailable input skips the fallback and renders empty.
    - `slidingWindowSegment` is the fallback when SegmentIt fails to load.
  - CSS is dual-injected: `popup.css` via manifest's `content_scripts.css` AND dynamically via `injectPopupStyles()` as fallback for tabs opened before extension install

- **`extension/manifest.json`** — MV3, permissions: `storage`, host_permissions for `t.cnki.net`, `gongjushu.cnki.net`, `bar.cnki.net`, `cdn.jsdelivr.net`

## Key Data Flow

```
User selects text → content.js mouseup → background.searchRefbook()
  → t.cnki.net/rbook-api query → results with abstract (truncated)
  → renderResults() shows popup immediately
  → autoFetchFullText() async: check entryContentCache → background.fetchFullContent()
    → if invoice exists: callEntryApi() → full text from API
    → if no invoice: fails silently (user can click "查看全文" to retry)
```

## Development

No build system. Load `extension/` as an unpacked extension in `chrome://extensions` (developer mode). Changes to `background.js` require clicking "Service Worker" reload; changes to `content.js` require page refresh.

## CNKI API Details

- Search endpoint: `POST https://t.cnki.net/rbook-api/v1/criteria/query?uniplatform=NRBOOK`
- Entry detail: `POST https://t.cnki.net/rbook-api/v1/entry/detail?uniplatform=NRBOOK`
- Auth: `invoice` + `nonce` obtained from CNKI page URL params after login at `gongjushu.cnki.net`
- Entry detail API returns HTML in `data.data[0].content` — must strip tags for display
- `bar.cnki.net` (readonline URL) requires Referer from `*.cnki.net` — hence the redirect mechanism via `gongjushu.cnki.net`

## Known Issues

- Full entry text often fails to load because the `invoice`/`nonce` tokens expire or aren't captured (user must visit gongjushu.cnki.net and log in first)
- The `abstract` field from search API is often a short excerpt; the `content` field from entry detail API contains the complete text but requires auth
