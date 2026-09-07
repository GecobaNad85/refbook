// CNKI 工具书划词查询 —— Tauri 桌面版主入口
mod cnki;

use std::sync::Mutex;
use tauri::menu::{CheckMenuItem, MenuBuilder, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, Position, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Code, Modifiers, Shortcut, ShortcutState};

struct AppState {
    popup: Mutex<Option<WebviewWindow>>,
    float: Mutex<Option<WebviewWindow>>,
    /// 托盘"显示悬浮图标"开关：false 时即使主窗口关闭也不显示悬浮图标
    float_enabled: Mutex<bool>,
}

#[tauri::command]
async fn cnki_search(word: String, size: Option<i64>) -> cnki::SearchResponse {
    cnki::search_refbook(&word, size.unwrap_or(8)).await
}

#[tauri::command]
async fn cnki_detail(fn_: String, tablename: String, product: String) -> cnki::DetailResponse {
    cnki::fetch_entry_detail(&fn_, &tablename, &product).await
}

#[tauri::command]
async fn cnki_ping() -> bool {
    cnki::ping().await
}

/// 读取系统选中文本：优先 PRIMARY 选区（划词即存入，无需复制），回退剪贴板
fn get_selection_text() -> String {
    let primary = read_primary_selection();
    if !primary.is_empty() {
        return primary;
    }
    read_clipboard()
}

#[cfg(target_os = "linux")]
fn read_primary_selection() -> String {
    // Wayland 会话：原生应用（如 Chrome）的选区走 Wayland 协议，X11 读不到 → 优先 wl-paste --primary
    if is_wayland_session() {
        if let Some(s) = read_wayland_primary() {
            return s;
        }
        if let Some(s) = read_x11_primary() {
            return s;
        }
    } else {
        if let Some(s) = read_x11_primary() {
            return s;
        }
        if let Some(s) = read_wayland_primary() {
            return s;
        }
    }
    String::new()
}

#[cfg(not(target_os = "linux"))]
fn read_primary_selection() -> String {
    String::new()
}

#[cfg(target_os = "linux")]
fn read_clipboard() -> String {
    // 先 wl-paste（Wayland 剪贴板，比 arboard 更可靠），再 arboard
    if let Some(s) = read_wayland_clipboard() {
        return s;
    }
    if let Ok(mut cb) = arboard::Clipboard::new() {
        if let Ok(text) = cb.get_text() {
            let t = text.trim().to_string();
            if !t.is_empty() {
                return t;
            }
        }
    }
    String::new()
}

#[cfg(not(target_os = "linux"))]
fn read_clipboard() -> String {
    if let Ok(mut cb) = arboard::Clipboard::new() {
        if let Ok(text) = cb.get_text() {
            let t = text.trim().to_string();
            if !t.is_empty() {
                return t;
            }
        }
    }
    String::new()
}

#[cfg(target_os = "linux")]
fn is_wayland_session() -> bool {
    std::env::var("XDG_SESSION_TYPE")
        .map(|v| v.eq_ignore_ascii_case("wayland"))
        .unwrap_or(false)
}

/// 执行 wl-paste 并设 1.5s 超时，避免选区所有者无响应时卡住主线程
#[cfg(target_os = "linux")]
fn run_wl_paste(args: &[&str]) -> Option<std::process::Output> {
    use std::process::{Command, Stdio};
    let child = Command::new("wl-paste")
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    match rx.recv_timeout(std::time::Duration::from_millis(1500)) {
        Ok(out) => out.ok(),
        Err(_) => None,
    }
}

#[cfg(target_os = "linux")]
fn read_wayland_primary() -> Option<String> {
    let out = run_wl_paste(&["--primary"])?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

#[cfg(target_os = "linux")]
fn read_wayland_clipboard() -> Option<String> {
    let out = run_wl_paste(&[])?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

#[cfg(target_os = "linux")]
fn read_x11_primary() -> Option<String> {
    let clipboard = x11_clipboard::Clipboard::new().ok()?;
    let atoms = &clipboard.getter.atoms;
    // load 带超时（load_wait 会无限阻塞快捷键回调），超时即跳过
    let bytes = clipboard
        .load(
            atoms.primary,
            atoms.utf8_string,
            atoms.property,
            Some(std::time::Duration::from_millis(200)),
        )
        .ok()?;
    let s = String::from_utf8_lossy(&bytes);
    let s = s.trim_end_matches('\0').to_string();
    if s.is_empty() { None } else { Some(s) }
}

/// 触发划词查询：读选区 → 唤起主窗口查询；选区为空则在弹窗提示
fn trigger_selection_lookup(app: &tauri::AppHandle) {
    let text = get_selection_text();
    if text.trim().is_empty() {
        show_popup_message(
            app,
            "未检测到选中文本。请先选中文字；若为 Chrome 浏览器，建议先按 Ctrl+C 复制，再按 Ctrl+Alt+D。",
            true,
        );
        return;
    }
    // 唤起主窗口并在主窗口查询（结果在主窗口完整展示，弹窗不再承载结果）
    show_main(app);
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.emit("main:query", text.trim().to_string());
    }
}

/// 获取（或创建）划词提示弹窗
fn get_or_create_popup(app: &AppHandle) -> Option<WebviewWindow> {
    let state = app.state::<AppState>();
    let mut guard = state.popup.lock().unwrap();
    if guard.is_none() {
        let popup = tauri::WebviewWindowBuilder::new(
            app,
            "popup",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .title("划词查询")
        .inner_size(440.0, 190.0)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .visible(false)
        .build()
        .ok();
        *guard = popup;
    }
    guard.clone()
}

/// 在弹窗中显示提示信息（可关闭）
fn show_popup_message(app: &AppHandle, msg: &str, is_error: bool) {
    if let Some(win) = get_or_create_popup(app) {
        // 定位到屏幕中央偏上
        if let Ok(monitor) = win.current_monitor() {
            if let Some(monitor) = monitor {
                let size = monitor.size();
                let scale = monitor.scale_factor();
                let w = 440.0 * scale;
                let h = 190.0 * scale;
                let x = (size.width as f64 - w) / 2.0 / scale;
                let y = (size.height as f64 - h) / 4.0 / scale;
                let _ = win.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(x, y)));
            }
        }
        let _ = win.show();
        let _ = set_focus_delayed(&win);
        let _ = win.emit(
            "popup:message",
            serde_json::json!({"msg": msg, "isError": is_error}),
        );
    }
}

/// 延迟设置焦点，避免窗口刚 show 时焦点立即丢失
fn set_focus_delayed(win: &WebviewWindow) {
    let win = win.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(50));
        let _ = win.set_focus();
    });
}

/// 显示并聚焦主窗口（托盘 / 悬浮图标 / IPC 共用），同时隐藏悬浮图标入口
fn show_main(app: &AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
    }
    hide_float(app);
}

/// 隐藏悬浮图标
fn hide_float(app: &AppHandle) {
    let state = app.state::<AppState>();
    let float = state.float.lock().unwrap().clone();
    if let Some(float) = float {
        // 隐藏前补存最终位置（Wayland 下 outer_position 可能失败，则忽略）
        if let Ok(pos) = float.outer_position() {
            save_float_pos(app, pos.x, pos.y);
        }
        let _ = float.hide();
    }
}

/// 显示悬浮图标（受托盘"显示悬浮图标"开关约束）
fn show_float_if_enabled(app: &AppHandle) {
    let state = app.state::<AppState>();
    let enabled = *state.float_enabled.lock().unwrap();
    if !enabled {
        return;
    }
    let float = state.float.lock().unwrap().clone();
    if let Some(float) = float {
        let _ = float.show();
    }
}

/// 创建系统托盘：左键唤起主窗口，菜单提供 显示主窗口 / 划词查询 / 悬浮图标开关 / CNKI登录 / 退出
fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let lookup = MenuItem::with_id(app, "lookup", "划词查询", true, None::<&str>)?;
    let login = MenuItem::with_id(app, "login", "CNKI 登录…", true, None::<&str>)?;
    let float_toggle =
        CheckMenuItem::with_id(app, "toggle-float", "显示悬浮图标", true, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = MenuBuilder::new(app)
        .item(&show)
        .item(&lookup)
        .separator()
        .item(&login)
        .item(&float_toggle)
        .separator()
        .item(&quit)
        .build()?;

    let builder = TrayIconBuilder::with_id("main-tray")
        .menu(&menu)
        .tooltip("工具书查词 · CNKI")
        // macOS 惯例：左键直接弹出菜单；Windows/Linux 左键视为唤起主窗口
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .icon(tauri::include_image!("icons/32x32.png"));

    builder
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "show" => show_main(app),
            "lookup" => trigger_selection_lookup(app),
            "login" => open_cnki_login(app.clone()),
            "toggle-float" => {
                // 从我们维护的 float_enabled 推导新状态（而非 is_checked()——
                // 原生菜单点击时部分平台会自动翻转 check，再读 is_checked 会二次翻转导致状态不变）
                let state = app.state::<AppState>();
                let new_enabled = !*state.float_enabled.lock().unwrap();
                *state.float_enabled.lock().unwrap() = new_enabled;
                let _ = float_toggle.set_checked(new_enabled);
                if new_enabled {
                    // 重新勾选 → 主窗口当前不可见则显示悬浮图标
                    let main_visible = app
                        .get_webview_window("main")
                        .map(|w| w.is_visible().unwrap_or(false))
                        .unwrap_or(false);
                    if !main_visible {
                        show_float_if_enabled(app);
                    }
                } else {
                    // 取消勾选 → 立即隐藏悬浮图标
                    hide_float(app);
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            #[cfg(not(target_os = "macos"))]
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// 悬浮图标位置持久化文件（app_config_dir/float-position.json），跨会话记忆上次拖动后位置
fn float_pos_file(app: &AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join("float-position.json"))
}

/// 读取上次保存的悬浮图标位置（物理坐标）
fn load_float_pos(app: &AppHandle) -> Option<(i32, i32)> {
    let path = float_pos_file(app)?;
    let data = std::fs::read_to_string(&path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&data).ok()?;
    let x = v.get("x")?.as_i64()? as i32;
    let y = v.get("y")?.as_i64()? as i32;
    Some((x, y))
}

/// 保存悬浮图标位置（物理坐标）
fn save_float_pos(app: &AppHandle, x: i32, y: i32) {
    if let Some(path) = float_pos_file(app) {
        let v = serde_json::json!({ "x": x, "y": y });
        let _ = std::fs::write(&path, v.to_string());
    }
}

/// 创建桌面悬浮图标：透明置顶小窗，可拖拽，点击唤起主窗口
fn create_floating_icon(app: &AppHandle) -> tauri::Result<()> {
    #[allow(unused_mut)] // macOS 分支不会在此变更，仅在其他平台设置透明
    let mut float_builder = WebviewWindowBuilder::new(app, "float", WebviewUrl::App("float.html".into()))
        .title("工具书查词 · 悬浮图标")
        .inner_size(56.0, 56.0)
        .resizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .visible(false);
    // macOS 默认不支持透明窗口（需 macos-private-api 特性），改用深色窗口背景
    #[cfg(not(target_os = "macos"))]
    {
        float_builder = float_builder.transparent(true);
    }
    let float = float_builder.build()?;
    // 保存句柄，供托盘菜单开关悬浮图标使用
    let state = app.state::<AppState>();
    *state.float.lock().unwrap() = Some(float.clone());

    // macOS：窗口背景设为深色，让悬浮图标呈现为深色小方块
    #[cfg(target_os = "macos")]
    {
        let _ = float.set_background_color(Some(tauri::webview::Color(15, 40, 66, 255)));
    }

    // 定位：优先用上次拖动后保存的位置；否则放到主屏幕右下角（含显示器原点偏移）
    if let Some((x, y)) = load_float_pos(app) {
        let _ = float.set_position(Position::Physical(PhysicalPosition::new(x, y)));
    } else if let Ok(monitor) = float.primary_monitor() {
        if let Some(monitor) = monitor {
            let size = monitor.size();
            let mpos = monitor.position();
            let scale = monitor.scale_factor();
            // 56(窗口) + 32(右边距) 逻辑像素 → 物理像素
            let off = (56.0 * scale + 32.0 * scale).round() as i32;
            let x = mpos.x + size.width as i32 - off;
            let y = mpos.y + size.height as i32 - off;
            let _ = float.set_position(Position::Physical(PhysicalPosition::new(x, y)));
        }
    }
    // 拖动后位置持久化：Moved 事件节流写入（500ms 内只写一次），hide 时再补写最终位置
    let app_h = app.clone();
    let last_save = std::sync::Mutex::new(
        std::time::Instant::now() - std::time::Duration::from_millis(600),
    );
    float.on_window_event(move |event| {
        if let WindowEvent::Moved(pos) = event {
            let mut last = last_save.lock().unwrap();
            if last.elapsed() >= std::time::Duration::from_millis(500) {
                *last = std::time::Instant::now();
                drop(last);
                save_float_pos(&app_h, pos.x, pos.y);
            }
        }
    });
    // 初始不显示：主窗口可见时隐藏悬浮图标，主窗口关闭（隐藏到托盘）后才显示
    Ok(())
}

#[tauri::command]
fn popup_close(window: WebviewWindow) {
    if window.label() == "popup" {
        let _ = window.hide();
    }
}

#[tauri::command]
fn popup_open_external(app: tauri::AppHandle, url: String) {
    let _ = tauri_plugin_opener::open_url(url, None::<&str>);
    let _ = app;
}

/// 打开工具书条目链接（readonlineUrl 经 gongjushu.cnki.net 中转）。
/// 用内置 webview 打开 gongjushu 页面并注入初始化脚本，复刻扩展 content.js 的
/// handleCnkiRedirect：读 #cnki_redirect → 校验目标为 *.cnki.net → 跳转原文页。
/// 这样系统浏览器无需安装扩展，Referer 也由 gongjushu.cnki.net 域内跳转自然建立。
#[tauri::command]
fn open_entry_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    const LABEL: &str = "entry-viewer";
    // 初始化脚本：在 gongjushu.cnki.net 页面加载时立即处理 #cnki_redirect
    let init_script = r#"
(function () {
  try {
    if (!window.location.hostname.endsWith('.cnki.net')) return;
    var m = window.location.hash && window.location.hash.match(/#cnki_redirect=(.+)/);
    if (!m) return;
    var t = decodeURIComponent(m[1]);
    try {
      var u = new URL(t);
      if (u.protocol !== 'https:' || (!u.hostname.endsWith('.cnki.net') && u.hostname !== 'cnki.net')) return;
    } catch (_) { return; }
    history.replaceState(null, '', window.location.pathname + window.location.search);
    location.href = t;
  } catch (_) {}
})();
"#;
    // 复用已有窗口：直接导航到新 URL（init_script 仍会处理 hash）
    if let Some(w) = app.get_webview_window(LABEL) {
        let js = format!(
            "window.location.href = {};",
            serde_json::to_string(&url).map_err(|e| format!("序列化 URL 失败: {e}"))?
        );
        let _ = w.eval(&js);
        let _ = w.set_focus();
        return Ok(());
    }
    let parsed: tauri::Url = url
        .parse()
        .map_err(|e| format!("无效 URL: {e}"))?;
    WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::External(parsed))
        .title("工具书条目")
        .inner_size(960.0, 720.0)
        .initialization_script(init_script)
        .build()
        .map_err(|e| format!("打开失败: {e}"))?;
    Ok(())
}

#[tauri::command]
fn focus_main(app: tauri::AppHandle) {
    show_main(&app);
}

/// CNKI 登录/鉴权窗口的注入脚本：监听 Rust 下发的查询请求，在 gongjushu.cnki.net
/// 页面上下文内带 cookie fetch t.cnki.net entry/detail API（等价于扩展 content.js 的
/// callEntryApiWithCookie）。结果写入 window.__cnkiResult，由 Rust 侧 eval 读取
/// （External URL 页面不注入 __TAURI__ 全局，不能用 emit 回传）。
const CNKI_AUTH_INIT_SCRIPT: &str = r#"
(function () {
  window.__cnkiResult = null; // { reqId, ok, content, error }
  window.__cnkiDetail = async function (req) {
    var SCOPES = ['content', 'preview', 'download'];
    async function tryScope(scope) {
      var body = {
        filename: req.fn_, tablename: req.tablename || 'CRFD2025',
        product: req.product || 'CRFD', platform: 'NRBOOK', type: 'REFBOOK',
        scope: scope, cflag: 'overlay', dflag: '词条', language: 'CHS',
        pages: '', sid: '', idenid: ''
      };
      var r = await fetch('https://t.cnki.net/rbook-api/v1/entry/detail?uniplatform=NRBOOK', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json;charset=utf-8', language: 'CHS',
                   Origin: 'https://gongjushu.cnki.net', Referer: 'https://gongjushu.cnki.net/' },
        credentials: 'include',
        body: JSON.stringify(body)
      });
      var j = await r.json();
      if (j.code !== 0) throw new Error(j.message || ('code ' + j.code));
      var c = (j.data && j.data.data && j.data.data[0] && j.data.data[0].content) || '';
      c = c.replace(/<[^>]*>/g, '').trim();
      if (!c) throw new Error('条目内容为空');
      return c;
    }
    try {
      var content = await Promise.any(SCOPES.map(tryScope));
      return { ok: true, content: content };
    } catch (e) {
      var msg = (e && e.errors && e.errors[0] && e.errors[0].message) || (e && e.message) || '获取失败';
      if (/未登录|登录|403|验证参数/.test(msg)) msg = '未登录或登录已过期，请在托盘菜单点击\"CNKI 登录…\"重新登录';
      return { ok: false, content: '', error: msg };
    }
  };
})();
"#;

/// 获取（或创建）CNKI 鉴权 webview：加载 gongjushu.cnki.net，带 cookie 罐，
/// 注入 __cnkiDetail 用于带 cookie 调用 entry/detail API
fn get_or_create_cnki_auth(app: &AppHandle) -> Option<WebviewWindow> {
    if let Some(w) = app.get_webview_window("cnki-auth") {
        return Some(w);
    }
    let url: tauri::Url = "https://gongjushu.cnki.net/".parse().ok()?;
    let w = WebviewWindowBuilder::new(app, "cnki-auth", WebviewUrl::External(url))
        .title("CNKI 登录 · 工具书查词")
        .inner_size(1024.0, 720.0)
        .initialization_script(CNKI_AUTH_INIT_SCRIPT)
        .build()
        .ok()?;
    Some(w)
}

/// 打开 CNKI 登录窗口（用户在此登录后，cookie 持久化到 webview cookie 罐，
/// 之后"查看全文"经该窗口上下文带 cookie 调用 API）
#[tauri::command]
fn open_cnki_login(app: tauri::AppHandle) {
    if let Some(w) = get_or_create_cnki_auth(&app) {
        let _ = w.show();
        let _ = w.set_focus();
        // 已存在时导航回首页，方便重新登录
        let _ = w.eval("window.location.href = 'https://gongjushu.cnki.net/';");
    }
}

/// 带 cookie 查询条目全文：在 cnki-auth webview 内执行 fetch（带 cookie），结果通过
/// document.title 分块回传（External URL 页面无 __TAURI__ 全局，eval_with_callback 在
/// 跨域页面上回调不可靠；title() 可同步读取 JS 设置的 document.title，但实测 WebKitGTK
/// 把 document.title 截断到 1000 字符，单块放不下完整结果，故切成小块依次写入、
/// Rust 侧轮询累积，最后以 "DONE:<n>" 收尾）。前端"查看全文"调用此命令替代裸 reqwest 的 cnki_detail。
#[tauri::command]
async fn cnki_detail_auth(app: tauri::AppHandle, fn_: String, tablename: String, product: String) -> cnki::DetailResponse {
    let w = match app.get_webview_window("cnki-auth") {
        Some(w) => w,
        None => return cnki::DetailResponse {
            ok: false, content: String::new(),
            error: "未登录 CNKI，请先在托盘菜单点击\"CNKI 登录…\"".into(),
        },
    };
    // 用唯一标记避免读到旧 title。fetch 逻辑内联，不依赖 init script 注入时机。
    // 标题上限 1000 字符：标记(~30) + "P:<idx>:"(~8) + 块(900) 留有余量。
    // 块按 150ms 间隔依次写入（Rust 侧 40ms 轮询，确保每块至少被读到 3 次）。
    let marker = format!("__CNKI_RES__{}__", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    let js = format!(
        r#"(async () => {{
  var SCOPES = ['content','preview','download'];
  async function tryScope(scope){{
    var body={{filename:{fn_},tablename:{tn}||'CRFD2025',product:{pd}||'CRFD',
      platform:'NRBOOK',type:'REFBOOK',scope:scope,cflag:'overlay',dflag:'词条',
      language:'CHS',pages:'',sid:'',idenid:''}};
    var r=await fetch('https://t.cnki.net/rbook-api/v1/entry/detail?uniplatform=NRBOOK',
      {{method:'POST',headers:{{'Content-Type':'application/json;charset=utf-8',language:'CHS'}},
       credentials:'include',body:JSON.stringify(body)}});
    var j=await r.json();
    if(j.code!==0) throw new Error(j.message||('code '+j.code));
    var c=(j.data&&j.data.data&&j.data.data[0]&&j.data.data[0].content)||'';
    c=c.replace(/<[^>]*>/g,'').trim();
    if(!c) throw new Error('条目内容为空');
    return c;
  }}
  var res;
  try {{
    var content=await Promise.any(SCOPES.map(tryScope));
    res={{ok:true,content:content}};
  }} catch(e){{
    var msg=(e&&e.errors&&e.errors[0]&&e.errors[0].message)||(e&&e.message)||'获取失败';
    if(/未登录|登录|403|验证参数/.test(msg)) msg='未登录或登录已过期，请在托盘菜单点击\"CNKI 登录…\"重新登录';
    res={{ok:false,content:'',error:msg}};
  }}
  var M={mk};
  var payload=JSON.stringify(res);
  var CS=900;
  var n=Math.max(1,Math.ceil(payload.length/CS));
  var i=0;
  (function w(){{
    if(i>=n){{ document.title=M+'DONE:'+n; return; }}
    document.title=M+'P:'+i+':'+payload.slice(i*CS,(i+1)*CS);
    i++;
    setTimeout(w,150);
  }})();
}})();"#,
        fn_ = serde_json::to_string(&fn_).unwrap_or_else(|_| "\"\"".into()),
        tn = serde_json::to_string(&tablename).unwrap_or_else(|_| "\"\"".into()),
        pd = serde_json::to_string(&product).unwrap_or_else(|_| "\"\"".into()),
        mk = serde_json::to_string(&marker).unwrap_or_else(|_| "\"\"".into()),
    );
    if let Err(e) = w.eval(&js) {
        return cnki::DetailResponse {
            ok: false, content: String::new(),
            error: format!("调用鉴权窗口失败: {e}"),
        };
    }
    // 轮询 document.title（同步 title()）累积分块，读到 "DONE:<n>" 后拼接解析
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    let mut chunks: Vec<String> = Vec::new();
    loop {
        tokio::time::sleep(std::time::Duration::from_millis(40)).await;
        if std::time::Instant::now() > deadline {
            return cnki::DetailResponse {
                ok: false, content: String::new(),
                error: "查询超时，若未登录请在托盘菜单点击\"CNKI 登录…\"".into(),
            };
        }
        let title = match w.title() {
            Ok(t) => t,
            Err(_) => continue,
        };
        let Some(body) = title.strip_prefix(&marker) else { continue };
        if let Some(count_str) = body.strip_prefix("DONE:") {
            let count: usize = count_str.trim().parse().unwrap_or(0);
            if chunks.len() >= count && chunks.iter().all(|c| !c.is_empty()) {
                // 全部块已收到，恢复 title（去掉脏数据）
                let _ = w.set_title("CNKI 登录 · 工具书查词");
                let payload = chunks.concat();
                let v: serde_json::Value = match serde_json::from_str::<serde_json::Value>(&payload) {
                    Ok(v) => v,
                    Err(e) => return cnki::DetailResponse {
                        ok: false, content: String::new(),
                        error: format!("解析鉴权结果失败: {e}"),
                    },
                };
                let ok = v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false);
                let content = v.get("content").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let error = v.get("error").and_then(|x| x.as_str()).unwrap_or("").to_string();
                return cnki::DetailResponse { ok, content, error };
            }
            continue;
        }
        if let Some(rest) = body.strip_prefix("P:") {
            if let Some(colon) = rest.find(':') {
                if let Ok(idx) = rest[..colon].parse::<usize>() {
                    let chunk = rest[colon + 1..].to_string();
                    if chunks.len() <= idx { chunks.resize(idx + 1, String::new()); }
                    chunks[idx] = chunk;
                }
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(AppState {
            popup: Mutex::new(None),
            float: Mutex::new(None),
            float_enabled: Mutex::new(true),
        })
        .setup(|app| {
            // 全局快捷键 Ctrl+Alt+D（避免与浏览器 Ctrl+Shift+D 书签管理冲突）
            let shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyD);
            let app_handle = app.handle().clone();
            app.global_shortcut().on_shortcut(shortcut, move |_app, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    trigger_selection_lookup(&app_handle);
                }
            })?;

            // 系统托盘 + 桌面悬浮图标
            create_tray(app.handle())?;
            create_floating_icon(app.handle())?;

            // 主窗口"关闭"→ 隐藏到托盘（应用常驻，可经托盘/悬浮图标/快捷键唤起）
            if let Some(main) = app.get_webview_window("main") {
                // 任务栏窗口图标：运行时显式设置（Linux/Windows 生效，macOS 用 .app 包内图标）
                #[cfg(not(target_os = "macos"))]
                if let Some(icon) = app.default_window_icon() {
                    let _ = main.set_icon(icon.clone());
                }
                let win = main.clone();
                main.on_window_event(move |event| {
                    let app = win.app_handle();
                    match event {
                        // 主窗口"关闭"→ 隐藏到托盘，显示悬浮图标入口
                        WindowEvent::CloseRequested { api, .. } => {
                            api.prevent_close();
                            let _ = win.hide();
                            show_float_if_enabled(&app);
                        }
                        // 主窗口重新获得焦点（托盘 / 任务栏 / 悬浮图标唤起）→ 隐藏悬浮图标
                        WindowEvent::Focused(true) => hide_float(&app),
                        _ => {}
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            cnki_search,
            cnki_detail,
            cnki_ping,
            popup_close,
            popup_open_external,
            open_entry_url,
            open_cnki_login,
            cnki_detail_auth,
            focus_main,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
