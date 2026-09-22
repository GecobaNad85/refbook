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
  - **Full text flow**: `autoFetchExpandFirst` → `fetchAndExpandFirstResult` (checks entry cache first, then calls `fetchEntryContent` API). "查看全文" button uses same function with `silent: false`
  - **Segmentation & traditional→simplified fallback** (both run inside a shared `sandbox.html` iframe to bypass page CSP; libs load independently from `cdn.jsdelivr.net`):
    - `sandbox.html` loads SegmentIt (`segmentit@2.0.3`, smart word segmentation) and OpenCC (`opencc-js@1.4.2`, `OpenCC.Converter({from:'t',to:'cn'})` — dictionaries bundled at build time, no runtime fetch). Each posts its own `cnki-*-ready`/`-error` signal; one failing does not block the other.
    - Content-side: `getSandboxIframe()` creates the iframe lazily; `getSegmenter()`/`getConverter()` await the respective ready signal. `segmentViaIframe` (分词) and `toSimplified` (繁→简) are postMessage RPCs over the same iframe.
    - `queryWithSegmentation(keyword,x,y,gen)` = **方案① 串行兜底**：`runQueryChain` does integral query → (on miss) merge pre-split + SegmentIt segments (deduped by text, parallel query) → multi-tab render. Pre-split (`preSplitText`, caps at 12 segs) splits on punctuation + zh/latin boundaries; it no longer short-circuits SegmentIt, so finer word-level hits aren't lost. SegmentIt failure falls back to `slidingWindowSegment`. If the whole traditional chain yields nothing, `toSimplified(keyword)` is called; when the simplified text differs from the original (i.e. it contained traditional chars), `runQueryChain` runs again on the simplified text. Pure-simplified or OpenCC-unavailable input skips the fallback and renders empty.
    - `slidingWindowSegment` is the fallback when SegmentIt fails to load.
  - CSS is dual-injected: `popup.css` via manifest's `content_scripts.css` AND dynamically via `injectPopupStyles()` as fallback for tabs opened before extension install

- **`extension/manifest.json`** — MV3, permissions: `storage`, host_permissions for `t.cnki.net`, `gongjushu.cnki.net`, `bar.cnki.net`, `cdn.jsdelivr.net`

## Key Data Flow

```
User selects text → content.js mouseup → background.searchRefbook()
  → t.cnki.net/rbook-api query → results with abstract (truncated)
  → renderResults() shows popup immediately
  → autoFetchExpandFirst() async: check entryContentCache → background.fetchFullContent()
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

## Tauri 桌面版（refbook-tauri/）

`refbook-tauri/` 是独立的 Tauri v2 原型（Rust，无前端构建步骤，前端在 `src/`）。与扩展共用 API 逻辑（`src-tauri/src/cnki.rs`）。

- **划词选区读取**（`get_selection_text`，Linux）：**Wayland 会话优先 `wl-paste --primary`**（原生应用如 Chrome 的选区走 Wayland 协议，X11 读不到）→ X11 PRIMARY（`x11-clipboard::load`，200ms 超时，避免 `load_wait` 阻塞）→ 剪贴板（先 `wl-paste` 再 arboard）。**Wayland 下 PRIMARY 必须安装 `wl-clipboard`**，否则选区读不到（弹窗会提示"未检测到选中文本"）。`wl-paste` 经 `run_wl_paste` 带 1.5s 超时执行，避免选区所有者无响应卡住主线程。
- **划词流程**（`trigger_selection_lookup`）：读选区 → 非空则**唤起主窗口**（`show_main` + 向主窗口 emit `main:query`，前端自动填入搜索框并查询）；选区为空则在**提示弹窗**中显示提示（可关闭）。弹窗（440×190，无边框）只承载提示信息，**不再展示查询结果**；**失焦自动关闭**（`popup_focus_armed`：show 后延迟 400ms 才武装，避免启动瞬间抢焦点误关，也保证弹窗内按钮可点）。
- **托盘**（`create_tray`）：左键唤起主窗口（非 macOS），菜单 = 显示主窗口 / 划词查询 / **CNKI 登录**（动态文字）/ **显示悬浮图标**（`CheckMenuItem` 开关，控制悬浮图标是否允许显示）/ 退出。Ctrl+Alt+D 全局快捷键触发划词查询。
  - **CNKI 登录菜单项动态文字**（`login_menu` + `refresh_login_menu_text`）：已登录时显示"已登录（用户名/机构）"，未登录显示"CNKI 登录…"。用户身份从 `Ecp_LoginStuts` cookie 的 JSON 值提取（`extract_display_name_from_cookies`，字段 `UserName`/`ShowName`，机构账号用 `BUserName`/`BShowName`；`ShowName` 为通用欢迎语时退回 `UserName`）。
  - **已登录时点击**：弹信息弹窗（`show_logged_in_popup` → `show_popup_actions`），显示"当前已登录 CNKI\n用户：xxx"，提供 确定/退出登录/重新登录 按钮。前端 `popup:message` 事件支持 `actions` 数组渲染按钮，点击触发 `popup_action` 命令。
  - **未登录/重新登录时点击**：打开登录窗口（`open_cnki_login`，导航到 `gongjushu.cnki.net/rbook/?tb_login=1`）。登录窗口注入 `CNKI_AUTH_INIT_SCRIPT`：提取 `.login_box_main_container` 登录表单全窗居中显示、加"CNKI 工具书 · 登录"标题条；已登录态下显示"当前已登录"提示而非暴露整页。
  - **退出登录**（`cnki_logout`）：在 cnki-auth webview 内导航到 `gongjushu.cnki.net/rbook/` 并调用页面自带的 `Ecp_LogoutOptr_my(0)`（页头"退出"按钮逻辑）——其 `$.ajax({async:false})` 同步请求 `login.cnki.net/TopLoginCore/api/loginapi/Logout`（带 `createSign` 签名 + `withCredentials`），服务端使会话失效并经 `Set-Cookie` 过期 HttpOnly 会话 cookie（`Ecp_session` 等），回调再用 JS 清 `Ecp_LoginStuts`。这是唯一能真正清掉 HttpOnly 会话 cookie 的方式（Tauri/wry 的 cookie 罐持久化落盘，`delete_cookie`/销毁窗口都清不掉已落盘 cookie）。`CNKI_EVAL_LOGOUT` 兼顾等待就绪与触发登出；复检与兜底清扫拆为 `check_login_on_main` / `sweep_and_destroy_auth`（cookie 操作留主线程、等待全部 async sleep 留异步线程，销毁落地后经 `ensure_cnki_auth_window` 重建再复检），与 `cnki_detail_auth` 共用 `detail_busy` 互斥，回填 `LoginCache` 与托盘菜单。
  - **登录态缓存**（`LoginCache`：`logged_in`/`display_name`/`error`/`checked_at`）：启动预检（setup 后台线程 1.5s 延迟 `check_cnki_login_live`）填充，60s 新鲜度内直接复用；`cnki_login_status` 命令、登录监控、登出都会回填并调 `refresh_login_menu_text`。
- **悬浮图标**（`create_floating_icon` + `src/float.html`）：56×56 透明置顶小窗。**与主窗口事件联动**：主窗口 `CloseRequested`（关闭隐藏到托盘）→ `show_float_if_enabled` 显示悬浮图标；主窗口 `Focused(true)` 或 `show_main` → `hide_float` 隐藏。受托盘开关（`float_enabled`）约束。**不能用 `data-tauri-drag-region`**（GTK 下 mousedown 即抢占原生拖拽，click 不可靠）；改用 pointer 事件：pointermove 位移 >5px → `invoke('plugin:window|start_dragging')`，pointerup 无位移 → `invoke('focus_main')`。位置持久化到 `float-position.json`，优先用上次拖动位置；无记录时默认主屏右下角（距边 32 逻辑像素）。**Wayland+KDE 下经 KWin 窗口规则定位**（`ensure_kwin_float_rule` 写 `kwinrulesrc`，按窗口标题精确匹配，强制初始位置 = 主屏靠右、垂直 2/3 处——Wayland 协议禁止客户端 set_position，KWin 规则是唯一手段；仅 Wayland+KDE 启用，X11 下不用以免覆盖保存的位置）。
- **主题系统**（light/dark/system）：Rust 侧持久化到 `app_config_dir/theme.json`（`get_theme_pref`/`set_theme_pref`），切换后广播 `theme:changed`，主窗口/弹窗各自套用 `data-theme`；`system` 由前端 matchMedia 解析（CSS 只维护 `[data-theme="dark"]` 一份暗色变量，不写 prefers-color-scheme 媒体查询），系统主题变化时跟随。偏好另缓存到 localStorage，避免首帧闪白；用户手动切换后忽略迟到的异步初始化覆盖（`_userToggled`）。弹窗与主窗口同步主题，悬浮图标无主题化样式。
- **主窗口尺寸记忆**：手动调整大小后防抖 500ms 持久化到 `app_config_dir/main-window.json`（逻辑像素，`load_main_window_size`/`save_main_window_size`，原子写与 theme.json 同款）；启动 setup 时应用并 `center()` 居中（首帧前 set_size 不闪默认尺寸）。最大化/最小化期间不写盘，保留最近正常态尺寸；尺寸校验下限与 `tauri.conf.json` 的 minWidth/minHeight 一致。
- **主窗口图标**：`tauri.conf.json` 的 `bundle.icon` 已全部由 `icons/crfd.svg` 生成（png/icns/ico）。Linux 默认窗口图标取 icon 列表第一个 `.png`（已调整为 128x128）；setup 中再用 `main.set_icon(app.default_window_icon())` 显式设置（非 macOS）。deb 程序列表图标由 bundler 按实际尺寸拷进 hicolor，新构建即生效。
- 主窗口"关闭"→ 隐藏到托盘；窗口图标、托盘、悬浮图标在同一 `AppState` 管理中。
