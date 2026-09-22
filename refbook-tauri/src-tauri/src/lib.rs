// CNKI 工具书划词查询 —— Tauri 桌面版主入口
mod cnki;

use std::sync::Mutex;
use tauri::menu::{CheckMenuItem, MenuBuilder, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Position, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Code, Modifiers, Shortcut, ShortcutState};

struct AppState {
    popup: Mutex<Option<WebviewWindow>>,
    float: Mutex<Option<WebviewWindow>>,
    /// 托盘"显示悬浮图标"开关：false 时即使主窗口关闭也不显示悬浮图标
    float_enabled: Mutex<bool>,
    /// 弹窗失焦自动关窗的"武装"标志：show 后延迟 400ms 置 true，
    /// 避开 Wayland/KDE 下窗口 show→focus 时序抖动导致弹出即自灭。
    popup_armed: Mutex<bool>,
    /// 弹窗 show/close 世代计数：每次 show 与手动 close 自增。延迟 arm 的线程
    /// 醒来时发现 epoch 已被更新的 show/close 取代则放弃 arm，防止孤儿线程
    /// 提前 arm 或给已隐藏的窗口残留 armed 状态。
    popup_epoch: Mutex<u64>,
    /// 启动预检的 CNKI 登录态缓存：None = 尚未预检
    ///（预检由 setup 里后台任务完成，前端"查看全文"读这里，不再现建/现显窗口）
    login_cached: Mutex<Option<LoginCache>>,
    /// 托盘"CNKI 登录"菜单项句柄：用于随登录态切换文字
    ///（已登录 → "已登录（用户名/机构）"，未登录 → "CNKI 登录…"）
    login_menu: Mutex<Option<MenuItem<tauri::Wry>>>,
    /// cnki_detail_auth 独占锁：同一 cnki-auth 窗口同时只能有一个取全文任务，
    /// 否则两次 navigate 互相覆盖、轮询同一 p.image_box 会返回错误的条目内容。
    detail_busy: Mutex<bool>,
}

/// 启动预检得到的登录态快照
#[derive(Clone)]
struct LoginCache {
    logged_in: bool,
    error: String,
    /// 已登录时从页面 DOM 提取的展示名（用户名/机构名），未登录或提取失败为空
    display_name: String,
    checked_at: std::time::Instant,
}

#[tauri::command]
async fn cnki_search(word: String, size: Option<i64>) -> cnki::SearchResponse {
    cnki::search_refbook(&word, size.unwrap_or(8)).await
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
    if is_wayland_session() {        if let Some(s) = read_wayland_primary() {
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

/// 是否运行在 Wayland 会话（基于 XDG_SESSION_TYPE，WAYLAND_DISPLAY 作回退）。
/// 用于与窗口后端无关的判断（如选区读取：wl-paste 读的是 compositor，与 app 后端无关）。
fn is_wayland_session() -> bool {
    match std::env::var("XDG_SESSION_TYPE").ok().as_deref() {
        Some("wayland") => true,
        Some("x11") => false,
        _ => std::env::var("WAYLAND_DISPLAY").is_ok(),
    }
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
        let _ = main.emit_to(tauri::EventTarget::webview_window("main"), "main:query", text.trim().to_string());
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
            tauri::WebviewUrl::App("popup.html".into()),
        )
        .title("划词查询")
        .inner_size(440.0, 190.0)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .visible(false)
        .build()
        .ok()?;
        // 失焦自动关窗：armed 置位后才生效（show 后 400ms 由 show_popup_message 延迟 arm）。
        // popup 现仅承载瞬时提示（"未检测到选中文本"等），可操作的确认对话已改走原生对话框，
        // 因此失焦关闭不会藏掉按钮。
        let app_h = app.clone();
        popup.on_window_event(move |event| {
            if let WindowEvent::Focused(false) = event {
                let st = app_h.state::<AppState>();
                if *st.popup_armed.lock().unwrap() {
                    *st.popup_armed.lock().unwrap() = false;
                    if let Some(p) = st.popup.lock().unwrap().clone() {
                        let _ = p.hide();
                    }
                }
            }
        });
        *guard = Some(popup);
    }
    guard.clone()
}

/// 在弹窗中显示单条提示信息（可关闭）
fn show_popup_message(app: &AppHandle, msg: &str, is_error: bool) {
    if let Some(win) = get_or_create_popup(app) {
        // 重置 arm，show 后延迟 400ms 再 arm，避开窗口 show→focus 时序抖动导致自灭。
        let state = app.state::<AppState>();
        *state.popup_armed.lock().unwrap() = false;
        // 记录本次 show 的 epoch；延迟 arm 线程凭它判断期间是否又有新的 show/close。
        let epoch = {
            let mut e = state.popup_epoch.lock().unwrap();
            *e += 1;
            *e
        };
        let _ = win.set_size(LogicalSize::new(440.0, 190.0));
        center_popup(&win, 440.0, 190.0);
        let _ = win.show();
        let _ = set_focus_delayed(&win);
        let payload = serde_json::json!({"msg": msg, "isError": is_error});
        emit_popup_message(&win, payload);
        let app_h = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(400));
            let s = app_h.state::<AppState>();
            // 期间若有新的 show/close（epoch 变化）则由那次负责 arm / 已撤销，本线程不再 arm。
            if *s.popup_epoch.lock().unwrap() == epoch {
                *s.popup_armed.lock().unwrap() = true;
            }
        });
    }
}

/// 把弹窗定位到屏幕中央偏上
fn center_popup(win: &WebviewWindow, w: f64, h: f64) {
    if let Ok(monitor) = win.current_monitor() {
        if let Some(monitor) = monitor {
            let size = monitor.size();
            let scale = monitor.scale_factor();
            let pw = w * scale;
            let ph = h * scale;
            let x = (size.width as f64 - pw) / 2.0 / scale;
            let y = (size.height as f64 - ph) / 4.0 / scale;
            let _ = win.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(x, y)));
        }
    }
}

/// 向弹窗窗口发送 popup:message 事件。必须用 emit_to 定向到 "popup" 窗口——
/// WebviewWindow::emit 是全局广播（经 manager().emit 发给所有窗口），会同时触达
/// 主窗口，导致主窗口的 popup-view 也渲染出一份关不掉的重复弹窗。
/// 弹窗首次创建时页面 JS 尚未加载、监听器未注册，首次 emit 会丢失 → 延迟 300ms
/// 重发一次确保送达。前端 popupInited 标志防止重复初始化，innerHTML 覆盖为相同
/// 内容，双重送达无副作用。
fn emit_popup_message(win: &WebviewWindow, payload: serde_json::Value) {
    let _ = win.emit_to(tauri::EventTarget::webview_window("popup"), "popup:message", payload.clone());
    let win2 = win.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(300));
        let _ = win2.emit_to(tauri::EventTarget::webview_window("popup"), "popup:message", payload);
    });
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
        let _ = main.unminimize();
        let _ = main.set_focus();
        // Linux（X11/Wayland）窗口管理器上 set_focus 不保证把窗口抬到最顶层：
        // 快捷键划词唤起时主窗口可能仍被原焦点窗口（如浏览器）遮挡，结果窗口
        // 置于顶层却不可见。短暂开启 always_on_top 强制置顶，再延迟关闭，确保
        // 窗口管理器先把窗口抬到最前再取消置顶。
        #[cfg(target_os = "linux")]
        {
            let m = main.clone();
            std::thread::spawn(move || {
                let _ = m.set_always_on_top(true);
                std::thread::sleep(std::time::Duration::from_millis(60));
                let _ = m.set_focus();
                let _ = m.set_always_on_top(false);
            });
        }
    }
    hide_float(app, false);
}

/// 隐藏悬浮图标。
/// `force=true` 强制隐藏（托盘菜单关闭悬浮图标）；`force=false` 为窗口联动隐藏。
/// Wayland 下联动隐藏会让窗口 unmap，重新 show 时 KWin 重新居中放置，丢失用户拖动后的位置；
/// 因此 Wayland 下非强制隐藏一律跳过，保持窗口 mapped 以保持位置（常驻显示策略）。
fn hide_float(app: &AppHandle, force: bool) {
    if !force && is_wayland() {
        return;
    }
    let state = app.state::<AppState>();
    let float = state.float.lock().unwrap().clone();
    if let Some(float) = float {
        // 隐藏前补存最终位置（Wayland 下 outer_position 可能失效，则忽略）
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

/// 拼接托盘登录菜单项的文字：已登录显示"已登录（用户名）"，未登录为"CNKI 登录…"
fn login_menu_text(logged_in: bool, display_name: &str) -> String {
    if logged_in {
        let name = display_name.trim();
        if name.is_empty() {
            "已登录 CNKI".to_string()
        } else {
            // 菜单文字过长会被截断，限制展示名长度
            let n = if name.chars().count() > 20 {
                let mut s = String::new();
                for (i, c) in name.chars().enumerate() {
                    if i >= 18 { break; }
                    s.push(c);
                }
                s.push('…');
                s
            } else {
                name.to_string()
            };
            format!("已登录（{n}）")
        }
    } else {
        "CNKI 登录…".to_string()
    }
}

/// 刷新托盘"CNKI 登录"菜单项文字，使其反映当前登录态。
fn refresh_login_menu_text(app: &AppHandle, logged_in: bool, display_name: &str) {
    let state = app.state::<AppState>();
    let item = state.login_menu.lock().unwrap().clone();
    if let Some(item) = item {
        let text = login_menu_text(logged_in, display_name);
        let _ = item.set_text(text);
    }
}

/// 已登录时点击托盘"退出"项：用原生对话框确认是否退出登录。
/// 标题"账号已登录"+正文"如需切换账号/重新登录点击退出"，按钮"确定"/"退出"。
/// 确定 → 仅关闭对话框；退出 → 调 cnki_logout 清除登录态（退出后即未登录，
/// 可再点托盘"CNKI 登录…"重新登录，等价于原"重新登录"流程）。
fn show_logged_in_popup(app: &AppHandle, display_name: &str) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
    let name = display_name.trim();
    let title = if name.is_empty() {
        "账号已登录".to_string()
    } else {
        format!("账号已登录（{name}）")
    };
    let app_h = app.clone();
    app.dialog()
        .message("如需切换账号/重新登录点击退出")
        .title(&title)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "确定".to_string(),
            "退出".to_string(),
        ))
        .show(move |ok| {
            // true = 点了"确定"：不操作；false = 点了"退出"：退出登录。
            // 退出后即未登录，可再点托盘"CNKI 登录…"重新登录（等价原"重新登录"流程）。
            if !ok {
                let app_h2 = app_h.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = cnki_logout(app_h2).await;
                });
            }
        });
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
    // 保存登录菜单项句柄，供 refresh_login_menu_text 随登录态切换文字
    {
        let state = app.state::<AppState>();
        *state.login_menu.lock().unwrap() = Some(login.clone());
    }

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
            // 已登录 → 原生对话框确认是否退出登录（标题"账号已登录"+正文提示）；
            // 未登录 → 打开登录窗口。读缓存（即使过期也先用，避免阻塞菜单回调），
            // 同时后台刷新登录态、刷新托盘文字。
            "login" => {
                let cached = app.state::<AppState>().login_cached.lock().unwrap().clone();
                let (logged_in, display_name) = match cached {
                    Some(c) => (c.logged_in, c.display_name),
                    None => (false, String::new()),
                };
                if logged_in {
                    show_logged_in_popup(app, &display_name);
                } else {
                    open_cnki_login(app.clone());
                }
                // 后台刷新登录态（缓存可能过期），刷新托盘菜单文字
                let app_h = app.clone();
                let app_h2 = app.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(100));
                    let _ = app_h.run_on_main_thread(move || {
                        let live = check_cnki_login_live(&app_h2);
                        let li = live.get("loggedIn").and_then(|v| v.as_bool()).unwrap_or(false);
                        let dn = live.get("displayName").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let state = app_h2.state::<AppState>();
                        let mut guard = state.login_cached.lock().unwrap();
                        *guard = Some(LoginCache {
                            logged_in: li,
                            error: live.get("error").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                            display_name: dn.clone(),
                            checked_at: std::time::Instant::now(),
                        });
                        drop(guard);
                        refresh_login_menu_text(&app_h2, li, &dn);
                    });
                });
            }
            "toggle-float" => {
                // 从我们维护的 float_enabled 推导新状态（而非 is_checked()——
                // 原生菜单点击时部分平台会自动翻转 check，再读 is_checked 会二次翻转导致状态不变）
                let state = app.state::<AppState>();
                let new_enabled = !*state.float_enabled.lock().unwrap();
                *state.float_enabled.lock().unwrap() = new_enabled;
                let _ = float_toggle.set_checked(new_enabled);
                if new_enabled {
                    // 重新勾选 → 显示悬浮图标。Wayland 常驻策略下无条件显示；
                    // X11/Windows 下仅主窗口不可见时才显示（避免与主窗口重叠）
                    let main_visible = app
                        .get_webview_window("main")
                        .map(|w| w.is_visible().unwrap_or(false))
                        .unwrap_or(false);
                    if is_wayland() || !main_visible {
                        show_float_if_enabled(app);
                    }
                } else {
                    // 取消勾选 → 立即隐藏悬浮图标（强制，不受 Wayland 常驻策略影响）
                    hide_float(app, true);
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

/// 主题偏好持久化文件（app_config_dir/theme.json）：值 "light" | "dark" | "system"
fn theme_pref_file(app: &AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    Some(dir.join("theme.json"))
}
/// 读取主题偏好，缺省返回 "system"
fn load_theme_pref(app: &AppHandle) -> String {
    if let Some(path) = theme_pref_file(app) {
        if let Ok(data) = std::fs::read_to_string(&path) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&data) {
                if let Some(s) = v.get("pref").and_then(|x| x.as_str()) {
                    if s == "light" || s == "dark" || s == "system" {
                        return s.to_string();
                    }
                }
            }
        }
    }
    "system".to_string()
}
fn save_theme_pref(app: &AppHandle, pref: &str) {
    if let Some(path) = theme_pref_file(app) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let v = serde_json::json!({ "pref": pref });
        // 先写临时文件再 rename，原子替换，避免写一半崩溃留下损坏文件导致偏好静默丢失
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, v.to_string()).is_ok() {
            let _ = std::fs::rename(&tmp, &path);
        }
    }
}

#[tauri::command]
fn get_theme_pref(app: tauri::AppHandle) -> String {
    load_theme_pref(&app)
}
/// 设置主题偏好：持久化并广播 theme:changed，主窗口/弹窗各自重新套用 data-theme。
/// "system" 由前端各自用 matchMedia 解析为具体 dark/light（CSS 不写媒体查询，避免暗色变量重复）。
#[tauri::command]
fn set_theme_pref(app: tauri::AppHandle, pref: String) -> Result<(), String> {
    let pref = match pref.as_str() {
        "light" | "dark" | "system" => pref,
        _ => return Err("invalid theme pref".into()),
    };
    save_theme_pref(&app, &pref);
    let _ = app.emit("theme:changed", pref.clone());
    Ok(())
}

/// 主窗口尺寸持久化文件（app_config_dir/main-window.json）：逻辑像素宽高。
/// 只记尺寸不记位置（窗口保持 center 居中）；最大化期间不写盘，保留最近一次
/// 正常态尺寸，避免还原后变成整屏大小。
fn main_window_state_file(app: &AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join("main-window.json"))
}

/// 读取上次保存的主窗口尺寸（逻辑像素），缺省或不合理（小于最小尺寸）返回 None
fn load_main_window_size(app: &AppHandle) -> Option<(f64, f64)> {
    let path = main_window_state_file(app)?;
    let data = std::fs::read_to_string(&path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&data).ok()?;
    let w = v.get("width")?.as_f64()?;
    let h = v.get("height")?.as_f64()?;
    // 与 tauri.conf.json 的 minWidth/minHeight 一致，防御手改/损坏文件产生迷你窗口
    if !(640.0..=20000.0).contains(&w) || !(480.0..=20000.0).contains(&h) {
        return None;
    }
    Some((w, h))
}

/// 保存主窗口尺寸（逻辑像素）。必须主线程调用（GTK 窗口查询要求）。
fn save_main_window_size(win: &WebviewWindow) {
    // 最大化/最小化/全屏时的尺寸不代表用户设定的正常态尺寸，跳过（保留上次记录）
    if win.is_maximized().unwrap_or(false)
        || win.is_minimized().unwrap_or(false)
        || win.is_fullscreen().unwrap_or(false)
    {
        return;
    }
    let scale = win.scale_factor().unwrap_or(1.0);
    // 存 outer_size、恢复也用 set_size（外框尺寸），保持同一度量，避免 GTK 装饰
    // 导致每次重启客户区都缩小一截的累计漂移。
    let size = match win.outer_size() {
        Ok(s) => s.to_logical::<f64>(scale),
        Err(_) => return,
    };
    if size.width < 1.0 || size.height < 1.0 {
        return;
    }
    if let Some(path) = main_window_state_file(win.app_handle()) {
        let v = serde_json::json!({ "width": size.width, "height": size.height });
        // 与 theme.json 一致：先写临时文件再 rename 原子替换
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, v.to_string()).is_ok() {
            let _ = std::fs::rename(&tmp, &path);
        }
    }
}

/// 悬浮图标逻辑尺寸（与 float.html 的 #floating 一致），用于按当前缩放推算物理尺寸
const FLOAT_LOGICAL_SIZE: f64 = 56.0;
/// 悬浮图标贴边时保留的逻辑边距，避免完全贴边或被任务栏遮挡
const FLOAT_EDGE_MARGIN: f64 = 12.0;

/// Tauri/GTK 窗口是否运行在 Wayland 后端。Wayland 协议不允许客户端定位顶级窗口，
/// set_outer_position 是 no-op、outer_position 返回失效值，hide/show 间
/// KWin 会重新居中放置窗口。因此 Wayland 下悬浮图标采用常驻策略（见 hide_float）。
/// 与 is_wayland_session 的区别：GDK_BACKEND 显式指定时以它为准——Wayland 会话下
/// 若强制 GDK_BACKEND=x11（XWayland），窗口仍走 X11，set_position 可用；未指定时
/// 复用 is_wayland_session，避免两个函数用不同启发式产生分歧。
fn is_wayland() -> bool {
    match std::env::var("GDK_BACKEND").ok().as_deref() {
        Some("x11") => false,
        Some("wayland") => true,
        _ => is_wayland_session(),
    }
}

/// 找到物理坐标 (x, y) 所在的显示器；不在任何显示器内则返回 None。
fn monitor_at(monitors: &[tauri::Monitor], x: i32, y: i32) -> Option<tauri::Monitor> {
    monitors.iter().find(|m| {
        let p = m.position();
        let s = m.size();
        x >= p.x && y >= p.y && x < p.x + s.width as i32 && y < p.y + s.height as i32
    }).cloned()
}

/// 默认定位：主屏幕右下角，距边 32 逻辑像素（含显示器原点偏移）。
fn place_float_default(float: &WebviewWindow) {
    let Ok(Some(monitor)) = float.primary_monitor() else { return };
    let size = monitor.size();
    let mpos = monitor.position();
    let scale = monitor.scale_factor();
    // 窗口(56) + 边距(32) 逻辑像素 → 物理像素
    let off = ((FLOAT_LOGICAL_SIZE + 32.0) * scale).round() as i32;
    let x = mpos.x + size.width as i32 - off;
    let y = mpos.y + size.height as i32 - off;
    let _ = float.set_position(Position::Physical(PhysicalPosition::new(x, y)));
}

/// 用上次保存的位置定位悬浮图标，并校验整个窗口矩形仍在某显示器可见区内。
/// 返回 true 表示成功用保存的位置定位；false 表示无保存位置或位置已越界，调用方应回退默认。
fn place_float_from_saved(float: &WebviewWindow) -> bool {
    let Some((sx, sy)) = load_float_pos(float.app_handle()) else { return false };
    let monitors = float.available_monitors().ok().unwrap_or_default();
    if monitors.is_empty() {
        return false;
    }
    // 保存坐标所在（或最近的）显示器；找不到包含它的就回退默认，避免图标落到屏幕外。
    let monitor = monitor_at(&monitors, sx, sy)
        .or_else(|| {
            // 越界但可能离某显示器很近（如缩放变化导致窗口溢出几像素）：选最近的
            monitors.iter().min_by_key(|m| {
                let p = m.position();
                let s = m.size();
                let cx = p.x + s.width as i32 / 2;
                let cy = p.y + s.height as i32 / 2;
                (sx - cx).abs() + (sy - cy).abs()
            }).cloned()
        });
    let Some(monitor) = monitor else { return false };
    let scale = monitor.scale_factor();
    let win = FLOAT_LOGICAL_SIZE * scale; // 窗口物理尺寸
    let margin = FLOAT_EDGE_MARGIN * scale; // 贴边安全边距（物理）
    let p = monitor.position();
    let s = monitor.size();
    let min_x = p.x as f64 + margin;
    let min_y = p.y as f64 + margin;
    let max_x = p.x as f64 + s.width as f64 - win - margin;
    let max_y = p.y as f64 + s.height as f64 - win - margin;
    // 钳制：保证整个窗口（含边距）在显示器内。max<min 说明显示器太小，退回 min 端贴边。
    let x = (sx as f64).clamp(min_x, max_x.max(min_x));
    let y = (sy as f64).clamp(min_y, max_y.max(min_y));
    let _ = float.set_position(Position::Physical(PhysicalPosition::new(
        x.round() as i32,
        y.round() as i32,
    )));
    true
}

/// 悬浮图标窗口标题（与 create_floating_icon 的 .title() 一致），用于 KWin 规则匹配
const FLOAT_WINDOW_TITLE: &str = "工具书查词 · 悬浮图标";

/// 运行命令并返回 stdout（失败返回空串）
fn run_capture(cmd: &str, args: &[&str]) -> String {
    std::process::Command::new(cmd)
        .args(args)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default()
}

/// 运行命令，返回是否成功
fn run_ok(cmd: &str, args: &[&str]) -> bool {
    std::process::Command::new(cmd)
        .args(args)
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// 计算悬浮图标目标位置（逻辑像素）：主屏靠右、垂直 2/3 处。
/// x = 屏宽 - 窗口宽 - 右边距；y = 屏高 * 2/3 - 窗口高/2（窗口中心落在 2/3 线）。
/// Wayland 下 Tauri 的 primary_monitor 返回 None（GDK 在 Wayland 不暴露主屏），
/// 改用 `kscreen-doctor -o` 解析 KDE 显示配置，取第一个 enabled 输出的几何与缩放。
fn compute_float_target_logical(_app: &AppHandle) -> Option<(i32, i32)> {
    let out = run_capture("kscreen-doctor", &["-o"]);
    if out.is_empty() {
        return None;
    }
    // 去除 ANSI 颜色码
    let clean = strip_ansi(&out);
    // 解析所有 enabled 输出块，取第一个
    let mut geo: Option<(i32, i32, i32, i32)> = None; // (x, y, w, h)
    let mut in_enabled_block = false;
    for line in clean.lines() {
        let t = line.trim();
        if t.starts_with("Output:") {
            in_enabled_block = false;
        } else if t == "enabled" {
            in_enabled_block = true;
        } else if in_enabled_block {
            if let Some(rest) = t.strip_prefix("Geometry:") {
                // 格式: "x,y WxH"
                let rest = rest.trim();
                let (xy, wh) = rest.split_once(' ')?;
                let (xs, ys) = xy.split_once(',')?;
                let (ws, hs) = wh.split_once('x')?;
                let x = xs.trim().parse::<i32>().ok()?;
                let y = ys.trim().parse::<i32>().ok()?;
                let w = ws.trim().parse::<i32>().ok()?;
                let h = hs.trim().parse::<i32>().ok()?;
                geo = Some((x, y, w, h));
                break;
            }
        }
    }
    let (mx, my, w, h) = geo?;
    let x = w - FLOAT_LOGICAL_SIZE as i32 - FLOAT_EDGE_MARGIN as i32;
    let y = (h as f64 * 2.0 / 3.0 - FLOAT_LOGICAL_SIZE / 2.0).round() as i32;
    Some((mx + x, my + y))
}

/// 去除 ANSI 转义序列（颜色码等）
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            // 跳过 ESC[ ... m（或其他 CSI 序列，止于字母）
            if chars.peek() == Some(&'[') {
                chars.next();
                while let Some(c) = chars.next() {
                    if c.is_ascii_alphabetic() {
                        break;
                    }
                }
                continue;
            }
        }
        out.push(c);
    }
    out
}

/// 写入单条 KWin 规则的所有字段（按标题精确匹配，强制定位/置顶/跳过任务栏）
fn write_kwin_rule_fields(id: &str, x: i32, y: i32) {
    let file = "kwinrulesrc";
    let pos = format!("{},{}", x, y);
    let kv: &[(&str, &str)] = &[
        ("description", "工具书悬浮图标定位"),
        ("title", FLOAT_WINDOW_TITLE),
        ("titlematch", "1"),       // 1=精确匹配
        ("types", "1"),            // 1=Normal toplevel
        ("position", &pos),
        ("positionrule", "4"),     // 4=Apply initially（仅首次应用，之后允许用户拖动；2=Force 会锁定位置阻止拖动）
        ("above", "true"),
        ("aboverule", "2"),
        ("skiptaskbar", "true"),
        ("skiptaskbarrule", "2"),
    ];
    for (k, v) in kv {
        let _ = run_ok("kwriteconfig6", &["--file", file, "--group", id, "--key", k, v]);
    }
}

/// 读取 kwinrulesrc 文件内容（XDG_CONFIG_HOME/kwinrulesrc，回退 ~/.config/kwinrulesrc）。
/// 失败返回空串。一次性读取整文件，避免逐 key 调 kreadconfig6（每次都是一次子进程）。
fn read_kwinrulesrc() -> String {
    let dir = std::env::var("XDG_CONFIG_HOME")
        .ok()
        .filter(|p| !p.is_empty())
        .or_else(|| std::env::var("HOME").ok().map(|h| format!("{h}/.config")));
    let Some(dir) = dir else { return String::new() };
    std::fs::read_to_string(format!("{dir}/kwinrulesrc")).unwrap_or_default()
}

/// 解析 kwinrulesrc（INI 格式）为 group -> {key -> value}。
fn parse_kwinrulesrc(
    content: &str,
) -> std::collections::HashMap<String, std::collections::HashMap<String, String>> {
    let mut map: std::collections::HashMap<String, std::collections::HashMap<String, String>> =
        std::collections::HashMap::new();
    let mut cur = String::new();
    for line in content.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        if let Some(g) = t.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
            cur = g.trim().to_string();
            map.entry(cur.clone()).or_default();
        } else if let Some((k, v)) = t.split_once('=') {
            map.entry(cur.clone())
                .or_default()
                .insert(k.trim().to_string(), v.trim().to_string());
        }
    }
    map
}

/// KDE(KWin) 下为悬浮图标写入窗口规则，强制初始定位到主屏靠右、垂直 2/3 处。
/// Wayland 协议禁止客户端定位 toplevel，set_position 是 no-op；KWin 窗口规则
/// (kwinrulesrc) 是 Wayland+KDE 下唯一能控制 toplevel 初始位置的方式。
/// 幂等：按标题查找已有规则，找到则刷新坐标（适应分辨率/缩放变化），否则追加。
fn ensure_kwin_float_rule(app: &AppHandle) {
    // 仅 Wayland+KDE 下生效：X11 下 set_position 可用，KWin 规则会反而覆盖用户保存的位置
    if !is_wayland() || std::env::var("KDE_FULL_SESSION").ok().as_deref() != Some("true") {
        return;
    }
    let Some((x, y)) = compute_float_target_logical(app) else { return };
    let file = "kwinrulesrc";
    // 一次性读取并解析 kwinrulesrc，避免逐 ID 调 kreadconfig6（每个都是一次子进程）
    let groups = parse_kwinrulesrc(&read_kwinrulesrc());
    let ids: Vec<String> = groups
        .get("General")
        .and_then(|g| g.get("rules"))
        .map(|r| {
            r.split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();
    // 按标题查找已有规则
    let found = ids.iter().find(|id| {
        groups
            .get(id.as_str())
            .and_then(|g| g.get("title"))
            .map(|t| t.as_str())
            == Some(FLOAT_WINDOW_TITLE)
    });
    if let Some(id) = found {
        // 已存在 → 刷新坐标
        write_kwin_rule_fields(id, x, y);
    } else {
        // 追加新规则：仅取数值 ID 求最大，非数值 ID 不参与（避免它们被当成 0 抬高新 ID 导致碰撞）
        let new_id = ids
            .iter()
            .filter_map(|s| s.parse::<i32>().ok())
            .max()
            .unwrap_or(0)
            + 1;
        let new_id = new_id.to_string();
        write_kwin_rule_fields(&new_id, x, y);
        let mut all = ids;
        all.push(new_id);
        let _ = run_ok("kwriteconfig6", &["--file", file, "--group", "General", "--key", "rules", &all.join(",")]);
        let _ = run_ok("kwriteconfig6", &["--file", file, "--group", "General", "--key", "count", &(all.len() as i32).to_string()]);
    }
    // 重新加载 KWin 配置，让规则立即生效
    let _ = run_ok("qdbus6", &["org.kde.KWin", "/KWin", "org.kde.KWin.reconfigure"]);
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

    // 定位：优先用上次拖动后保存的位置；否则放到主屏幕右下角。
    // 保存的是物理坐标，但窗口物理尺寸随显示器缩放变化（56 逻辑px 在 200% 下变 112 物理px），
    // 且分辨率/显示器布局可能已改变，因此恢复时必须校验整个窗口矩形仍在某显示器可见区内，
    // 否则钳制到区内或回退默认位置——否则图标可能落在屏幕外无法拖回。
    if !place_float_from_saved(&float) {
        place_float_default(&float);
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
    // 初始不显示：主窗口可见时隐藏悬浮图标，主窗口关闭（隐藏到托盘）后才显示。
    // Wayland 常驻策略：一旦显示就不再 hide（见 hide_float），用户拖动后位置永久保持。
    // Wayland 协议禁止客户端定位顶级窗口，set_position 会被 KWin 忽略。KDE 下通过写入
    // KWin 窗口规则(kwinrulesrc)强制初始定位到主屏靠右、垂直 2/3 处，绕过协议限制。
    ensure_kwin_float_rule(app);
    Ok(())
}

#[tauri::command]
fn popup_close(app: tauri::AppHandle, window: WebviewWindow) {
    if window.label() == "popup" {
        // 手动关闭时撤销 arm，并推进 epoch，令任何尚在 sleep 的延迟 arm 线程
        // 醒来后放弃置位，防止 armed 残留导致下次 show 期间误关。
        let st = app.state::<AppState>();
        *st.popup_armed.lock().unwrap() = false;
        *st.popup_epoch.lock().unwrap() += 1;
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

/// CNKI 登录/鉴权 webview 的初始化脚本（document-start，对所有加载页面执行）：
/// 1. 处理 #cnki_redirect 中转：从 gongjushu 域内 location.href 跳 bar.cnki.net
///    （Referer 校验通过），bar.cnki.net 随后 302 到带 invoice/nonce 的详情 URL；
/// 2. 登录模式（URL 带 tb_login=1）：自动点击右上角"登录"按钮，展开登录层
///    （gongjushu 登录为同域 iframe Ecp_top_login_realNa，登录 cookie 直接落在
///    gongjushu.cnki.net 域）。
/// 全文获取由 cnki_detail_auth 用 eval_with_callback 轮询 p.image_box，不经页面回传。
const CNKI_AUTH_INIT_SCRIPT: &str = r#"
(function () {
  try {
    if (window.location.hostname.endsWith('.cnki.net')) {
      var m = window.location.hash && window.location.hash.match(/#cnki_redirect=(.+)/);
      if (m) {
        var t = decodeURIComponent(m[1]);
        try {
          var u = new URL(t);
          if (u.protocol !== 'https:' || (!u.hostname.endsWith('.cnki.net') && u.hostname !== 'cnki.net')) return;
        } catch (_) { return; }
        history.replaceState(null, '', window.location.pathname + window.location.search);
        location.href = t;
        return;
      }
    }
  } catch (_) {}

  // 登录模式：把页面收成"仅登录"小窗。
  // gongjushu 未登录时页面右上角只有一个"登录"文字，登录表单（.login_box_main_container，
  // 含用户名/密码/验证码/登录按钮）是页面内 DOM，点"登录"后展开。此处：
  // 1. 点右上角"登录"文字，触发登录层渲染/展开；
  // 2. 等 .login_box_main_container（含 Ecp_TextBoxUserName）出现后，
  //    把它从原浮层中剪切出来挂到 body 顶层、全窗居中显示；
  // 3. 隐藏 body 下其余所有顶层区块，只留登录表单。
  // 已登录态（页面无"登录"文字）则跳过，保持普通页面。
  try {
    var loginMode = new URLSearchParams(window.location.search).get('tb_login');
    if (loginMode) {
      var tries = 0;
      var timer = setInterval(function () {
        if (++tries > 100) { clearInterval(timer); return; } // ~20s 后放弃
        // 找可点的"登录"文字（未登录标志）
        var loginTab = null;
        var btns = document.querySelectorAll('a.ecp_tn-tab');
        for (var i = 0; i < btns.length; i++) {
          if ((btns[i].textContent || '').trim() === '登录') { loginTab = btns[i]; break; }
        }
        if (!loginTab) {
          // 区分"真已登录"与"顶栏渲染失败"：读实际会话 cookie（Ecp_LoginStuts 为
          // JS 可读 cookie，toplogin 脚本自己也用它判断登录态）。顶栏脚本跨域加载
          // （login.cnki.net/toploginnew），偶发加载失败/慢时 tab 缺失，若不区分
          // 会误报"当前已登录"。
          var stuts = /(?:^|;\s*)Ecp_LoginStuts=/.test(document.cookie || '');
          if (stuts) {
            clearInterval(timer);
            try { history.replaceState(null, '', window.location.pathname); } catch (_) {}
            var notice = document.createElement('div');
            notice.textContent = '当前已登录 CNKI，可关闭此窗口。如需切换账号，请先退出登录再重新打开登录。';
            notice.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center;font-size:15px;color:#333;line-height:1.8;padding:24px 32px;background:#fff;border-radius:8px;box-shadow:0 2px 16px rgba(0,0,0,0.1);z-index:999999;max-width:80%;';
            Array.prototype.forEach.call(document.body.children, function (el) {
              if (el.tagName === 'SCRIPT' || el.tagName === 'NOSCRIPT') return;
              el.style.display = 'none';
            });
            document.body.appendChild(notice);
            return;
          }
          // 未登录但顶栏没渲染出登录入口：先等 ~5s 再重载（顶栏由跨域 toplogin
          // 脚本渲染，加载慢是常态，冷缓存下远超首个 200ms tick，不能立刻 reload）。
          // 只重载一次重试（toplogin 脚本加载失败通常重载即恢复）；用带时间戳的
          // sessionStorage 标志防止无限重载循环，标志 60s 后自动过期——不会因一次
          // 彻底失败就永久失去重试机会。重载过仍无入口则不再干预，保留原页面
          // （用户可手动点页面上"登录"）。
          var lastReload = 0;
          try { lastReload = parseInt(sessionStorage.getItem('tbLoginReloadedAt') || '0', 10) || 0; } catch (_) {}
          if (tries >= 25 && Date.now() - lastReload > 60000) {
            try { sessionStorage.setItem('tbLoginReloadedAt', String(Date.now())); } catch (_) {}
            clearInterval(timer);
            location.reload();
          }
          return;
        }
        try { sessionStorage.removeItem('tbLoginReloadedAt'); } catch (_) {}
        try { if (!loginTab.dataset.tbClicked) { loginTab.dataset.tbClicked = '1'; loginTab.click(); } } catch (_) {}
        // 等登录表单渲染完成（用户名输入框存在且容器有尺寸）
        var box = document.querySelector('.login_box_main_container');
        var input = document.getElementById('Ecp_TextBoxUserName');
        if (!box || !input) return;
        try {
          clearInterval(timer);
          // 登录表单上方加标题条，让登录小窗有明确上下文
          var header = document.createElement('div');
          header.textContent = 'CNKI 工具书 · 登录';
          header.style.cssText = 'font-size:16px;font-weight:600;color:#2347ff;margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid #e8e8e8;';
          // 剪切登录表单到 body 顶层（保留元素自身的事件绑定）
          document.body.appendChild(box);
          box.insertBefore(header, box.firstChild);
          box.style.cssText = [
            'display:block !important',
            'position:fixed !important',
            'top:0 !important',
            'left:0 !important',
            'width:100% !important',
            'height:100% !important',
            'margin:0 !important',
            'padding:26px 28px !important',
            'box-sizing:border-box !important',
            'background:#fff !important',
            'z-index:999999 !important',
            'overflow:auto !important',
          ].join(';');
          // 隐藏页面其余所有顶层区块
          Array.prototype.forEach.call(document.body.children, function (el) {
            if (el.tagName === 'SCRIPT' || el.tagName === 'NOSCRIPT') return;
            if (el === box) return;
            el.style.display = 'none';
          });
          try { history.replaceState(null, '', window.location.pathname); } catch (_) {}
        } catch (_) {}
      }, 200);
    }
  } catch (_) {}
})();
"#;

/// 获取（或创建）CNKI 鉴权 webview：加载 gongjushu.cnki.net，带持久化 cookie 罐。
/// 注入初始化脚本：#cnki_redirect 中转 + 登录模式自动展开登录层。
fn get_or_create_cnki_auth(app: &AppHandle) -> Option<WebviewWindow> {
    if let Some(w) = app.get_webview_window("cnki-auth") {
        return Some(w);
    }
    let url: tauri::Url = "https://gongjushu.cnki.net/".parse().ok()?;
    let w = WebviewWindowBuilder::new(app, "cnki-auth", WebviewUrl::External(url))
        .title("CNKI 登录 · 工具书查词")
        .inner_size(1024.0, 720.0)
        // 创建时隐藏：仅"查看全文"/"CNKI 登录"时才显示。
        // 否则前端查登录状态（cnki_login_status）首次创建窗口时会瞬间弹出，
        // 造成"查词却弹出登录窗口"的打扰。
        .visible(false)
        .initialization_script(CNKI_AUTH_INIT_SCRIPT)
        .build()
        .ok()?;
    // 登录窗口"关闭"→ 隐藏而非销毁：cnki_detail_auth 复用该窗口内已登录的
    // cookie 会话完成跳转取凭证。一旦销毁，即使已登录也拿不到 invoice/nonce。
    let wc = w.clone();
    w.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = wc.hide();
        }
    });
    Some(w)
}

/// 从 gongjushu cookie 中提取已登录用户的展示名。
/// Ecp_LoginStuts 的值是一段 JSON（字段经 URL 转义），含 UserName/ShowName：
/// {"IsAutoLogin":true,"UserName":"TTOD","ShowName":"%E5%90%8C%E6%96%B9...","UserType":"bk",...}
/// 优先用 BUserName/BShowName（绑定的机构账号），其次 UserName/ShowName。
/// ShowName 对个人账号常为通用欢迎语（"同方知网欢迎您"），不算真实身份 → 退回 UserName。
fn extract_display_name_from_cookies(cookies: &[tauri::webview::Cookie<'_>]) -> String {
    let raw = cookies.iter().find(|c| c.name() == "Ecp_LoginStuts");
    let Some(cookie) = raw else { return String::new(); };
    // cookie value 的 JSON 字段值经 URL 编码（%XX），先整体 url_decode 再解析
    let decoded = url_decode(cookie.value());
    let Ok(j) = serde_json::from_str::<serde_json::Value>(&decoded) else {
        return String::new();
    };
    let pick = |field: &str| -> String {
        j.get(field)
            .and_then(|v| v.as_str())
            .map(|s| url_decode(s.trim()))
            .filter(|s| !s.is_empty())
            .unwrap_or_default()
    };
    // 优先机构账号（B 前缀字段），其次个人账号
    let b_user = pick("BUserName");
    let b_show = pick("BShowName");
    let user = pick("UserName");
    let show = pick("ShowName");
    // 通用欢迎语不是真实身份，排除
    let is_generic = |s: &str| s.is_empty() || s.contains("欢迎您") || s.contains("欢迎");
    if !b_user.is_empty() || !b_show.is_empty() {
        return if !is_generic(&b_show) { b_show } else { b_user };
    }
    if !is_generic(&show) {
        show
    } else {
        user
    }
}

/// 实时检查 CNKI 登录态：创建（或复用）隐藏的 cnki-auth 窗口，读 gongjushu 域 cookie。
/// 返回 { loggedIn, cookies, error }。
/// 注意：本函数创建窗口时必须保持隐藏（WebviewWindowBuilder .visible(false)），
/// 否则首次调用会瞬间弹出窗口，造成"查词却弹出登录窗口"的打扰。
///
/// 过期判断：gongjushu 会话 cookie `c_m_expire` 的值是 URL 编码的
/// `YYYY-MM-DD HH:MM:SS`（如 `2026-10-08%2008%3A15%3A06`），表示服务端会话过期时间。
/// 仅凭 cookie 存在判断登录态会把"已过期"误判为"已登录"，因此把过期时间与当前时间比较：
/// 会话 cookie 存在但已过期 → 视为未登录。
fn check_cnki_login_live(app: &AppHandle) -> serde_json::Value {
    let w = match get_or_create_cnki_auth(app) {
        Some(w) => w,
        None => {
            return serde_json::json!({
                "loggedIn": false,
                "error": "无法创建 CNKI 登录窗口，请稍后重试",
            });
        }
    };
    let url: tauri::Url = match "https://gongjushu.cnki.net/".parse() {
        Ok(u) => u,
        Err(_) => return serde_json::json!({ "loggedIn": false, "error": "URL 解析失败" }),
    };
    match w.cookies_for_url(url) {
        Ok(cookies) => {
            let pairs: Vec<String> = cookies
                .iter()
                .map(|c| {
                    let v = c.value();
                    let v = if v.len() > 48 { &v[..48] } else { v };
                    format!("{}={}", c.name(), v)
                })
                .collect();
            let session_cookie = cookies.iter().any(|c| {
                matches!(c.name(), "Ecp_session" | "Ecp_LoginStuts" | "c_m_LinID")
            });
            // 会话 cookie 存在，但 c_m_expire（服务端过期时间）已过期 → 视为未登录
            let expired = session_cookie && cookies.iter().any(|c| {
                c.name() == "c_m_expire" && cookie_expired(c.value())
            });
            let logged_in = session_cookie && !expired;
            eprintln!(
                "[cnki_login_status] gongjushu cookies: {pairs:?} -> session={session_cookie}, expired={expired}, logged_in={logged_in}"
            );
            // 已登录时从 Ecp_LoginStuts cookie 的 JSON 值提取用户名/机构展示名
            let display_name = if logged_in {
                extract_display_name_from_cookies(&cookies)
            } else {
                String::new()
            };
            serde_json::json!({ "loggedIn": logged_in, "cookies": pairs, "error": "", "displayName": display_name })
        }
        Err(e) => {
            eprintln!("[cnki_login_status] cookies_for_url error: {e}");
            serde_json::json!({
                "loggedIn": false,
                "cookies": [],
                "error": format!("读取登录状态失败: {e}"),
            })
        }
    }
}

/// 判断 gongjushu 会话是否过期：c_m_expire 的值是 URL 编码的 `YYYY-MM-DD HH:MM:SS`，
/// 解码后与当前时间比较。无法解析时视为未过期（宁可放行，由取全文超时兜底）。
fn cookie_expired(value: &str) -> bool {
    use time::macros::format_description;
    let decoded = url_decode(value);
    let fmt = format_description!("[year]-[month]-[day] [hour]:[minute]:[second]");
    let Ok(exp) = time::PrimitiveDateTime::parse(&decoded, &fmt) else {
        return false;
    };
    // c_m_expire 是 CNKI 服务端时间（CST/UTC+8），统一用 UTC+8 比较，避免用户本地时区
    // 与 CST 不一致时误判（如 UTC-8 用户会把已过期的会话判为未过期）。
    let now_cst = time::UtcOffset::from_hms(8, 0, 0)
        .map(|offset| time::OffsetDateTime::now_utc().to_offset(offset))
        .unwrap_or_else(|_| {
            // 偏移构造失败（理论上不会），退回本地时间
            time::OffsetDateTime::now_local().unwrap_or_else(|_| time::OffsetDateTime::now_utc())
        });
    let now_naive = time::PrimitiveDateTime::new(now_cst.date(), now_cst.time());
    now_naive > exp
}

/// 极简 URL 解码（仅处理 %XX 十六进制），用于解码 c_m_expire 的值
fn url_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = &s[i + 1..i + 3];
                if let Ok(b) = u8::from_str_radix(hex, 16) {
                    out.push(b);
                    i += 3;
                } else {
                    out.push(b'%');
                    i += 1;
                }
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 前端"查看全文"调用的登录状态命令：优先返回启动预检的缓存（新鲜度 60s），
/// 缓存缺失/过期时才实时检查。实时检查的窗口创建保持隐藏，不打扰用户。
#[tauri::command]
fn cnki_login_status(app: tauri::AppHandle) -> serde_json::Value {
    let state = app.state::<AppState>();
    let cached = state.login_cached.lock().unwrap().clone();
    if let Some(c) = cached {
        if c.checked_at.elapsed() < std::time::Duration::from_secs(60) {
            return serde_json::json!({
                "loggedIn": c.logged_in,
                "cookies": [],
                "error": c.error,
                "displayName": c.display_name,
            });
        }
    }
    let live = check_cnki_login_live(&app);
    // 回填缓存，供后续调用复用
    if let (Some(li), Some(err)) = (
        live.get("loggedIn").and_then(|v| v.as_bool()),
        live.get("error").and_then(|v| v.as_str()),
    ) {
        let dn = live
            .get("displayName")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let mut guard = state.login_cached.lock().unwrap();
        *guard = Some(LoginCache {
            logged_in: li,
            error: err.to_string(),
            display_name: dn.clone(),
            checked_at: std::time::Instant::now(),
        });
        // 登录态变化后刷新托盘菜单文字
        refresh_login_menu_text(&app, li, &dn);
    }
    live
}

/// 收成"仅登录"小窗——点右上角"登录"触发登录层，再把 .login_box_main_container
/// （用户名/密码/验证码/登录按钮）提取成全窗居中显示，隐藏页面其余内容。
/// 登录在 gongjushu 同域 iframe 内完成，cookie 直接落在 gongjushu.cnki.net 域，
/// 与"查看全文"会话共享。
#[tauri::command]
fn open_cnki_login(app: tauri::AppHandle) {
    if let Some(w) = get_or_create_cnki_auth(&app) {
        // 防御性恢复窗口状态：该窗口可能刚被"退出登录"流程最小化+skip_taskbar+
        // 不可聚焦过（cnki_logout），残留状态会导致窗口无法聚焦/难以关闭。
        let _ = w.unminimize();
        let _ = w.set_skip_taskbar(false);
        let _ = w.set_focusable(true);
        // 仅登录小窗：登录表单自然宽约 360px、高约 400px，窗口略大留出边距
        let _ = w.set_size(LogicalSize::new(460.0, 500.0));
        let _ = w.set_resizable(true);
        let _ = w.navigate("https://gongjushu.cnki.net/rbook/?tb_login=1".parse().unwrap());
        let _ = w.show();
        let _ = w.set_focus();
        // 登录成功监控：后台轮询 gongjushu 会话 cookie，一旦已登录且登录窗口
        // 正在前台显示（非最小化隐身——那是"查看全文"场景），就自动隐藏登录窗口。
        // 否则 gongjushu 表单被注入脚本提取后，登录成功的界面更新（顶部用户菜单）
        // 被隐藏看不到，用户会以为登录卡住；窗口自动关闭后流程清晰。
        let w2 = w.clone();
        std::thread::spawn(move || {
            let url: tauri::Url = match "https://gongjushu.cnki.net/".parse() {
                Ok(u) => u,
                Err(_) => return,
            };
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(180);
            let mut dn_cell: Option<String> = None;
            loop {
                std::thread::sleep(std::time::Duration::from_millis(800));
                // 登录窗口已被用户关闭 → 结束监控
                if !w2.is_visible().unwrap_or(false) {
                    break;
                }
                if std::time::Instant::now() > deadline {
                    break;
                }
                let logged = w2
                    .cookies_for_url(url.clone())
                    .map(|cs| {
                        let is_logged = cs.iter().any(|c| matches!(c.name(), "Ecp_LoginStuts" | "c_m_LinID"));
                        if is_logged {
                            // 顺便提取展示名（Ecp_LoginStuts cookie 的 JSON 值）
                            dn_cell = Some(extract_display_name_from_cookies(&cs));
                        }
                        is_logged
                    })
                    .unwrap_or(false);
                if logged && !w2.is_minimized().unwrap_or(true) {
                    eprintln!("[login-monitor] logged in, hiding login window");
                    let dn = dn_cell.take().unwrap_or_default();
                    {
                        let state = w2.app_handle().state::<AppState>();
                        let mut guard = state.login_cached.lock().unwrap();
                        *guard = Some(LoginCache {
                            logged_in: true,
                            error: String::new(),
                            display_name: dn.clone(),
                            checked_at: std::time::Instant::now(),
                        });
                    }
                    refresh_login_menu_text(&w2.app_handle(), true, &dn);
                    let _ = w2.hide();
                    break;
                }
            }
        });
    }
}

/// 退出 CNKI 登录：在 cnki-auth webview 内调用页面自带的 Ecp_LogoutOptr_my(0)
/// （即页头"退出"按钮的逻辑）。它向 login.cnki.net/TopLoginCore/api/loginapi/Logout
/// 发同步 ajax（带 createSign 签名 + withCredentials），服务端使会话失效并通过
/// Set-Cookie 过期 HttpOnly 会话 cookie（Ecp_session 等），其 success/complete 回调
/// 再用 JS 清掉 Ecp_LoginStuts 等可访问 cookie。
///
/// 这条路是唯一能真正清掉 HttpOnly 会话 cookie 的方式——此前仅靠 delete_cookie +
/// 销毁 webview，但 Tauri/wry 的 cookie 罐是持久化落盘的共享罐，销毁窗口不会清掉
/// 已落盘的 cookie，复检仍读到旧会话 → 托盘仍显示已登录。调完页面登出后再复检；
/// 若仍残留（接口未过期某些 HttpOnly cookie），再 delete_cookie 兜底清一遍。
#[tauri::command]
async fn cnki_logout(app: tauri::AppHandle) -> serde_json::Value {
    // 独占锁：与 cnki_detail_auth 互斥。登出会导航共享的 cnki-auth 窗口并跑 eval
    // 轮询，若与取全文并发，导航会把对方轮询中的页面拽走、cookie 清扫会删掉对方
    // 还要用的会话 cookie，两边都失败。
    {
        let state = app.state::<AppState>();
        let mut busy = state.detail_busy.lock().unwrap();
        if *busy {
            return serde_json::json!({ "ok": false, "error": "正在获取条目全文，请等取全文完成后再退出登录" });
        }
        *busy = true;
    }
    let app_for_unlock = app.clone();
    let unlock = || {
        let state = app_for_unlock.state::<AppState>();
        *state.detail_busy.lock().unwrap() = false;
    };

    // 1. 确保 cnki-auth 窗口存在（窗口创建须在主线程）
    let w = match ensure_cnki_auth_window(&app).await {
        Some(w) => w,
        None => {
            unlock();
            return serde_json::json!({ "ok": false, "error": "无法创建 CNKI 登录窗口" });
        }
    };

    // 2. 显示+最小化窗口（不入任务栏、不可聚焦），保证 WebKitGTK 执行页面 JS。
    //    与 cnki_detail_auth 同套做法：最小化在前 8s 内仍跑 JS，足够同步登出 ajax 完成。
    let was_visible = w.is_visible().unwrap_or(false);
    let _ = w.show();
    let _ = w.set_skip_taskbar(true);
    let _ = w.set_focusable(false);
    let _ = w.minimize();
    let _ = w.set_title("CNKI 登录 · 工具书查词");
    // 导航到 gongjushu 首页：加载 toplogin 脚本，提供 Ecp_LogoutOptr_my
    let nav_url: tauri::Url = "https://gongjushu.cnki.net/rbook/".parse().unwrap();
    if let Err(e) = w.navigate(nav_url) {
        restore_auth_window(&w, was_visible);
        unlock();
        return serde_json::json!({ "ok": false, "error": format!("导航失败: {e}") });
    }

    // 3. 轮询：等 Ecp_LogoutOptr_my 就绪后调一次（其内部 async:false ajax 同步完成）。
    //    单条 eval 兼顾"等待就绪"+"触发登出"：未就绪返 waiting，就绪则同步执行后返 done。
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    let mut js_ok = false;
    let mut done = false;
    while std::time::Instant::now() < deadline {
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        if w.eval_with_callback(CNKI_EVAL_LOGOUT, move |res| { let _ = tx.send(res); }).is_err() {
            continue;
        }
        // 同步登出 ajax 可能阻塞 JS 线程数秒，recv 给足 8s
        match rx.recv_timeout(std::time::Duration::from_millis(8000)) {
            Ok(raw) => {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                    match v.get("stage").and_then(|x| x.as_str()).unwrap_or("") {
                        "done" => {
                            js_ok = v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false);
                            done = true;
                            break;
                        }
                        "err" => {
                            eprintln!("[cnki_logout] eval err: {:?}", v.get("error"));
                            break;
                        }
                        _ => { /* waiting / kicked → 继续轮询 */ }
                    }
                }
            }
            Err(_) => { /* JS 线程阻塞在同步 ajax 中或回调未触发，继续轮询 */ }
        }
    }
    eprintln!("[cnki_logout] js logout done={done}, js_ok={js_ok}");

    // 4. 恢复窗口可见性
    restore_auth_window(&w, was_visible);

    // 5. 复检登录态 + 兜底清 cookie + 刷新缓存与托盘菜单。
    //    cookie 操作须主线程（cookies_for_url/delete_cookie），但等待（Set-Cookie
    //    落定、destroy 排队落地）全部用 async sleep 留在异步线程，不冻结 GTK 主线程。
    // 等 Set-Cookie 在 cookie 罐里落定（异步线程等待，不占主线程）
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let mut live = check_login_on_main(&app).await;
    let mut li = live.get("loggedIn").and_then(|v| v.as_bool()).unwrap_or(false);

    // 服务端登出仍残留（HttpOnly cookie 未被过期等）→ 兜底：delete_cookie 逐个清
    // + 销毁窗口，等销毁落地后重建再复检
    let mut swept = false;
    if li {
        swept = sweep_and_destroy_auth(&app).await;
        // destroy 经事件循环代理排队，在闭包返回后才落地；先在异步线程等它处理完，
        // 之后 ensure_cnki_auth_window 才会真正重建新窗口（否则 get_webview_window
        // 仍返回已判死的旧窗口，复检也读到 teardown 中的 webview）。
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let _ = ensure_cnki_auth_window(&app).await;
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        live = check_login_on_main(&app).await;
        li = live.get("loggedIn").and_then(|v| v.as_bool()).unwrap_or(false);
    }
    eprintln!("[cnki_logout] js_ok={js_ok}, swept={swept}, recheck logged_in={li}");

    let dn = live.get("displayName").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let error = live.get("error").and_then(|v| v.as_str()).unwrap_or("").to_string();
    {
        let state = app.state::<AppState>();
        *state.detail_busy.lock().unwrap() = false;
        let mut guard = state.login_cached.lock().unwrap();
        *guard = Some(LoginCache {
            logged_in: li,
            error,
            display_name: dn.clone(),
            checked_at: std::time::Instant::now(),
        });
    }
    refresh_login_menu_text(&app, li, &dn);
    serde_json::json!({ "ok": !li, "loggedIn": li, "jsLogout": js_ok, "swept": swept })
}

/// 在主线程上获取（必要时创建）cnki-auth 窗口。窗口创建是 webview 操作，须主线程。
async fn ensure_cnki_auth_window(app: &AppHandle) -> Option<WebviewWindow> {
    if let Some(w) = app.get_webview_window("cnki-auth") {
        return Some(w);
    }
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<WebviewWindow>>();
    let app_h = app.clone();
    if app.run_on_main_thread(move || {
        let w = get_or_create_cnki_auth(&app_h);
        let _ = tx.send(w);
    }).is_err() {
        return None;
    }
    match tokio::time::timeout(std::time::Duration::from_secs(5), rx).await {
        Ok(Ok(w)) => w,
        _ => None,
    }
}

/// 恢复 cnki-auth 窗口的最小化/任务栏/焦点状态，并按原先是否可见决定隐藏。
fn restore_auth_window(w: &WebviewWindow, was_visible: bool) {
    let _ = w.set_skip_taskbar(false);
    let _ = w.set_focusable(true);
    let _ = w.unminimize();
    if !was_visible {
        let _ = w.hide();
    }
}

/// 在主线程上执行 check_cnki_login_live（cookie 读取须主线程），异步等待结果。
async fn check_login_on_main(app: &AppHandle) -> serde_json::Value {
    let (tx, rx) = tokio::sync::oneshot::channel::<serde_json::Value>();
    let app_h = app.clone();
    if app.run_on_main_thread(move || {
        let _ = tx.send(check_cnki_login_live(&app_h));
    }).is_err() {
        return serde_json::json!({ "loggedIn": false, "error": "无法切回主线程读取登录状态" });
    }
    match tokio::time::timeout(std::time::Duration::from_secs(5), rx).await {
        Ok(Ok(v)) => v,
        _ => serde_json::json!({ "loggedIn": false, "error": "读取登录状态超时" }),
    }
}

/// 登出兜底（须主线程执行）：delete_cookie 逐个清 gongjushu cookie，再销毁
/// cnki-auth 窗口。destroy 经事件循环代理排队、在闭包返回后才落地，因此不复检、
/// 不在此处重建窗口——由调用方等待落地后经 ensure_cnki_auth_window 重建再复检。
/// 返回是否执行了 cookie 清扫。
async fn sweep_and_destroy_auth(app: &AppHandle) -> bool {
    let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
    let app_h = app.clone();
    if app.run_on_main_thread(move || {
        let mut swept = false;
        if let Some(w) = app_h.get_webview_window("cnki-auth") {
            let url: tauri::Url = "https://gongjushu.cnki.net/".parse().unwrap();
            if let Ok(cookies) = w.cookies_for_url(url) {
                for c in &cookies {
                    let _ = w.delete_cookie(c.clone());
                }
                swept = true;
            }
            let _ = w.destroy();
        }
        let _ = tx.send(swept);
    }).is_err() {
        return false;
    }
    match tokio::time::timeout(std::time::Duration::from_secs(5), rx).await {
        Ok(Ok(s)) => s,
        _ => false,
    }
}

/// 查询条目全文（桌面版主路径）：在 cnki-auth webview 内导航到条目的跳转链接
/// （readonline_url，bar.cnki.net），登录态会话经 #cnki_redirect 中转后，bar.cnki.net
/// 302 到带 invoice/nonce 的 gongjushu 详情 URL，SPA 将全文渲染到 p.image_box。
/// Rust 侧用 eval_with_callback 轮询读取该元素文本（eval 回调是 wry 原生 JS 求值
/// 通道，不依赖 __TAURI_INTERNALS__；窗口显示时页面 JS 正常执行）。
///
/// 这条路复刻浏览器扩展 content.js 的已验证路径——登录态页面直接渲染释文，
/// 不经过 t.cnki.net entry/detail API（该 API 即使带 invoice/nonce 也返回系统异常）。
///
/// async 命令（轮询用 async sleep，不阻塞 UI）。
#[tauri::command]
async fn cnki_detail_auth(
    app: tauri::AppHandle,
    fn_: String,
    tablename: String,
    product: String,
    readonline_url: String,
) -> cnki::DetailResponse {
    let _ = (&tablename, &product); // 保留参数兼容前端
    // 独占锁：防止多个标签页并发取全文时 navigate 互相覆盖、轮询串结果
    {
        let state = app.state::<AppState>();
        let mut busy = state.detail_busy.lock().unwrap();
        if *busy {
            return cnki::DetailResponse {
                ok: false, content: String::new(),
                error: "正在获取其他条目全文，请稍候重试".into(),
            };
        }
        *busy = true;
    }
    // 所有退出路径都必须释放锁——用 guard 闭包确保
    let app_for_unlock = app.clone();
    let unlock = || {
        let state = app_for_unlock.state::<AppState>();
        *state.detail_busy.lock().unwrap() = false;
    };
    let w = match app.get_webview_window("cnki-auth") {
        Some(w) => w,
        None => {
            unlock();
            return cnki::DetailResponse {
                ok: false, content: String::new(),
                error: "未登录 CNKI，请先在托盘菜单点击\"CNKI 登录…\"".into(),
            };
        }
    };
    // 无 readonline_url 时无法触发 bar.cnki.net 跳转，也就进不了渲染释文的详情页
    if readonline_url.is_empty() {
        unlock();
        return cnki::DetailResponse {
            ok: false, content: String::new(),
            error: "该条目没有跳转链接，无法获取全文".into(),
        };
    }
    // 经 gongjushu detail 中转（#cnki_redirect）：页面初始化脚本校验后跳到
    // bar.cnki.net，其 Referer 校验自然通过；bar.cnki.net 再 302 到带凭证的详情 URL。
    let nav_url = format!(
        "https://gongjushu.cnki.net/rbook/detail?Fn={}#cnki_redirect={}",
        urlencode(&fn_),
        urlencode(&readonline_url),
    );
    let url: tauri::Url = match nav_url.parse() {
        Ok(u) => u,
        Err(e) => {
            unlock();
            return cnki::DetailResponse {
                ok: false, content: String::new(),
                error: format!("构造链接失败: {e}"),
            };
        }
    };
    // 取全文是后台操作，始终把查询过程页面隐藏起来：最小化（保持窗口映射，
    // 让 WebKitGTK 继续执行页面 JS）+ 不入任务栏 + 不可聚焦。原先可见的窗口
    // 结束时还原为可见，原先隐藏的还原为隐藏——避免窗口本来就已显示（如登录
    // 窗口未被自动隐藏）时，导航/轮询过程整个暴露给用户。
    let was_visible = w.is_visible().unwrap_or(false);
    let mut minimized = true;
    // 结束时恢复窗口状态：还原任务栏/焦点属性，取消最小化
    let restore_min = |w: &WebviewWindow| {
        let _ = w.set_skip_taskbar(false);
        let _ = w.set_focusable(true);
        let _ = w.unminimize();
    };
    let _ = w.show();
    let _ = w.set_skip_taskbar(true);
    let _ = w.set_focusable(false);
    let _ = w.minimize();
    // 窗口标题改为"条目详情"，避免沿用"CNKI 登录 · 工具书查词"造成误导
    let _ = w.set_title("条目详情 · 工具书查词");
    // 登录时窗口被缩小为登录小窗，看全文时恢复为可展示条目页的尺寸
    let _ = w.set_size(LogicalSize::new(960.0, 720.0));
    if let Err(e) = w.navigate(url) {
        if minimized { restore_min(&w); }
        if !was_visible { let _ = w.hide(); }
        unlock();
        return cnki::DetailResponse {
            ok: false, content: String::new(),
            error: format!("导航到条目页失败: {e}"),
        };
    }
    eprintln!("[cnki_detail_auth] navigate ok, fn={fn_}, minimized={minimized}, polling p.image_box...");
    // 轮询 eval_with_callback 读取 p.image_box 释文（SPA 渲染 + 跳转，最长 ~25s）
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(25);
    // 最小化 8s 无结果 → 视为最小化冻结了 JS，恢复可见继续取（保证功能）
    let minimized_deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
    let mut silent_polls = 0u32;
    // 稳定性检查：非空释文需连续 2 次相同才接受（防中间页残留 / 部分渲染误判）
    let mut last_text = String::new();
    let mut stable_count = 0u32;
    // 空释文（p.image_box 存在但无文本）：连续 4 次（~1s）才接受为"条目无正文"
    let mut empty_exists_count = 0u32;
    loop {
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        if minimized && std::time::Instant::now() > minimized_deadline {
            minimized = false;
            restore_min(&w);
            eprintln!("[cnki_detail_auth] minimized 8s no result, restored visible to continue");
        }
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        let tx2 = tx.clone();
        if w
            .eval_with_callback(CNKI_EVAL_EXTRACT, move |res| {
                let _ = tx2.send(res);
            })
            .is_err()
        {
            continue;
        }
        match rx.recv_timeout(std::time::Duration::from_millis(500)) {
            Ok(raw) => {
                silent_polls = 0;
                // eval_with_callback 回调收到的是 JS 求值结果的 JSON 序列化字符串
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                    let exists = v.get("exists").and_then(|x| x.as_bool()).unwrap_or(false);
                    let text = v.get("text").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
                    let is_placeholder = ["加载中", "正在加载", "加载失败", "系统异常", "请登录"]
                        .iter()
                        .any(|p| text.contains(p));

                    if exists && !is_placeholder {
                        if !text.is_empty() {
                            // 有实际释文（不论长短）：连续 2 次相同即接受
                            if text == last_text {
                                stable_count += 1;
                                if stable_count >= 2 {
                                    if minimized { restore_min(&w); }
                                    if !was_visible { let _ = w.hide(); }
                                    eprintln!("[cnki_detail_auth] FOUND full text, {} chars", text.len());
                                    unlock();
                                    return cnki::DetailResponse { ok: true, content: text, error: String::new() };
                                }
                            } else {
                                last_text = text.clone();
                                stable_count = 1;
                            }
                            empty_exists_count = 0;
                        } else {
                            // p.image_box 存在但文本为空：条目可能无正文（释文即摘要）
                            stable_count = 0;
                            empty_exists_count += 1;
                            if empty_exists_count >= 4 {
                                if minimized { restore_min(&w); }
                                if !was_visible { let _ = w.hide(); }
                                eprintln!("[cnki_detail_auth] p.image_box empty for 1s, accepting empty content");
                                unlock();
                                return cnki::DetailResponse { ok: true, content: String::new(), error: String::new() };
                            }
                        }
                    } else {
                        // 元素未出现或是占位符：重置稳定性计数，继续等待
                        stable_count = 0;
                        empty_exists_count = 0;
                    }
                }
            }
            Err(_) => {
                // 回调未触发：页面可能还在跳转/渲染，或 eval 通道不可用
                silent_polls += 1;
                if silent_polls % 8 == 0 {
                    eprintln!("[cnki_detail_auth] {} silent polls (eval no callback yet)", silent_polls);
                }
            }
        }
        if std::time::Instant::now() > deadline {
            let url_now = w.url().map(|u| u.to_string()).unwrap_or_default();
            if minimized { restore_min(&w); }
            if !was_visible { let _ = w.hide(); }
            eprintln!("[cnki_detail_auth] TIMEOUT, silent_polls={silent_polls}, url={url_now}");
            unlock();
            return cnki::DetailResponse {
                ok: false, content: String::new(),
                error: format!(
                    "获取全文超时（页面可能未渲染或未登录）。url={}",
                    url_now
                ),
            };
        }
    }
}

/// 读取当前页面 p.image_box 的释文，返回 {exists, text}。
/// exists=true 表示元素已在 DOM 中（页面已渲染详情页）；text 为去空白后的文本，
/// 段落结构保留：块级元素结束与 <br> 转成换行（textContent 不反映布局，直接用
/// 会把段落黏成一行），3 个以上连续换行压缩为两个。
/// Rust 侧据此区分"页面未加载"（exists=false，继续轮询）与"条目无正文"（exists=true,
/// text 空，返回空内容而非超时）。短释文（如"golden brick"）也能被接受。
///（eval_with_callback 把 JS 求值结果 JSON 序列化后回调给 Rust）
const CNKI_EVAL_EXTRACT: &str = r#"(function () {
  try {
    var box = document.querySelector('p.image_box');
    if (box) {
      var BLOCK = { P:1, DIV:1, LI:1, TR:1, SECTION:1, BLOCKQUOTE:1, H1:1, H2:1, H3:1, H4:1, H5:1, H6:1 };
      var out = '';
      (function walk(node) {
        for (var c = node.firstChild; c; c = c.nextSibling) {
          if (c.nodeType === 3) { out += c.nodeValue; }
          else if (c.nodeType === 1) {
            if (c.tagName === 'BR') { out += '\n'; continue; }
            walk(c);
            if (BLOCK[c.tagName]) { out += '\n'; }
          }
        }
      })(box);
      return { exists: true, text: out.replace(/\n{3,}/g, '\n\n').trim() };
    }
  } catch (_) {}
  return { exists: false, text: '' };
})()"#;

/// 触发 CNKI 页面自带登出：调用 Ecp_LogoutOptr_my(0)（页头"退出"按钮的逻辑）。
/// 其内部 $.ajax({async:false}) 同步调 login.cnki.net Logout 接口，完成时回调清
/// Ecp_LoginStuts 等 cookie。本 eval 兼顾"等待就绪"与"执行登出"：
///   - 脚本未加载（Ecp_LogoutOptr_my 未定义）→ 返 {stage:"waiting"}，继续轮询
///   - 首次就绪 → 同步执行登出后返 {stage:"done", ok:true}
///   - 执行抛异常 → 返 {stage:"done", ok:false, error:...}
/// 因 ajax 为同步，eval 回调会在登出完成后才触发（JS 线程阻塞至 ajax 返回）。
const CNKI_EVAL_LOGOUT: &str = r#"(function () {
  try {
    if (typeof Ecp_LogoutOptr_my !== 'function') return { stage: 'waiting' };
    if (!window.__cnkiLogoutDone) {
      try { Ecp_LogoutOptr_my(0); window.__cnkiLogoutDone = true; }
      catch (e) { return { stage: 'done', ok: false, error: String(e) }; }
    }
    return { stage: 'done', ok: true, cookie: (document.cookie || '').slice(0, 150) };
  } catch (e) { return { stage: 'err', error: String(e) }; }
})()"#;

fn urlencode(s: &str) -> String {
    // 极简 URL 编码：仅编码需要编码的字符（用于 Fn / readonline_url 放进 URL）
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            popup: Mutex::new(None),
            float: Mutex::new(None),
            float_enabled: Mutex::new(true),
            popup_armed: Mutex::new(false),
            popup_epoch: Mutex::new(0),
            login_cached: Mutex::new(None),
            login_menu: Mutex::new(None),
            detail_busy: Mutex::new(false),
        })
        .setup(|app| {
            // 启动即后台预检 CNKI 登录态：创建隐藏的 cnki-auth 窗口并读 cookie，
            // 结果缓存到 AppState，供前端"查看全文"读取，避免首次点击时现建/现显窗口。
            // 注意：必须在 setup 返回之后（事件循环已跑起来）再做，否则窗口无法创建。
            {
                let app_handle = app.handle().clone();
                // 用普通线程延迟 + run_on_main_thread 回主线程做检查（GTK 窗口操作须在主线程）
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(1500));
                    let app_handle2 = app_handle.clone();
                    let _ = app_handle.run_on_main_thread(move || {
                        let v = check_cnki_login_live(&app_handle2);
                        if let (Some(li), Some(err)) = (
                            v.get("loggedIn").and_then(|x| x.as_bool()),
                            v.get("error").and_then(|x| x.as_str()),
                        ) {
                            let dn = v.get("displayName").and_then(|x| x.as_str()).unwrap_or("").to_string();
                            let state = app_handle2.state::<AppState>();
                            let mut guard = state.login_cached.lock().unwrap();
                            *guard = Some(LoginCache {
                                logged_in: li,
                                error: err.to_string(),
                                display_name: dn.clone(),
                                checked_at: std::time::Instant::now(),
                            });
                            // 预检完成后刷新托盘菜单文字（已登录显示用户名/机构）
                            refresh_login_menu_text(&app_handle2, li, &dn);
                            eprintln!(
                                "[startup] cnki login precheck -> logged_in={}, display_name='{}', cached",
                                li, dn
                            );
                        }
                    });
                });
            }

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
                // 恢复上次手动调整的窗口尺寸（逻辑像素），再居中保持默认定位策略。
                // setup 在事件循环开跑/首帧绘制前执行，先 set_size 不会闪默认尺寸。
                if let Some((w, h)) = load_main_window_size(app.handle()) {
                    let _ = main.set_size(tauri::LogicalSize::new(w, h));
                    let _ = main.center();
                }
                // 任务栏窗口图标：运行时显式设置（Linux/Windows 生效，macOS 用 .app 包内图标）
                #[cfg(not(target_os = "macos"))]
                if let Some(icon) = app.default_window_icon() {
                    let _ = main.set_icon(icon.clone());
                }
                // resize 防抖计数：连续拖拽只让最后一个事件落盘（Resized 事件极高频）。
                // 事件处理只递增计数，落盘交给下方单个看门狗线程，避免按事件 spawn 线程
                // （长拖拽 ~60Hz 会产生上百个睡 500ms 的线程）。
                let resize_epoch = std::sync::Arc::new(std::sync::Mutex::new(0u64));
                let win = main.clone();
                let win_ev = win.clone();
                let epoch_ev = std::sync::Arc::clone(&resize_epoch);
                main.on_window_event(move |event| {
                    let app = win_ev.app_handle();
                    match event {
                        // 主窗口"关闭"→ 隐藏到托盘，显示悬浮图标入口
                        WindowEvent::CloseRequested { api, .. } => {
                            api.prevent_close();
                            // 隐藏前兜底保存一次尺寸（防抖线程可能还没跑）
                            save_main_window_size(&win_ev);
                            let _ = win_ev.hide();
                            show_float_if_enabled(&app);
                        }
                        // 主窗口重新获得焦点（托盘 / 任务栏 / 悬浮图标唤起）→ 隐藏悬浮图标。
                        // Wayland 常驻策略下跳过（hide_float 内部判断），避免重新 show 时丢位置。
                        WindowEvent::Focused(true) => hide_float(&app, false),
                        // 手动调整窗口大小 → 仅递增防抖计数，由看门狗线程择机落盘
                        WindowEvent::Resized(_) => {
                            *epoch_ev.lock().unwrap() += 1;
                        }
                        _ => {}
                    }
                });
                // resize 防抖看门狗：单个常驻线程每 500ms 检查一次 epoch，仅在尺寸
                // 稳定两个 tick（约 500ms 无变化）后落盘一次。保存须主线程
                // （GTK 窗口查询），经 run_on_main_thread。
                {
                    let epoch = std::sync::Arc::clone(&resize_epoch);
                    let win_watch = win.clone();
                    let app_watch = win.app_handle().clone();
                    std::thread::spawn(move || {
                        let mut prev = 0u64;
                        loop {
                            std::thread::sleep(std::time::Duration::from_millis(500));
                            let cur = { *epoch.lock().unwrap() };
                            if cur == 0 {
                                prev = 0;
                                continue;
                            }
                            if cur == prev {
                                // 尺寸已稳定：自上一 tick 起未再变化，落盘（保存函数内部
                                // 亦会跳过最大化/最小化/全屏）
                                let win2 = win_watch.clone();
                                let app2 = app_watch.clone();
                                let epoch2 = std::sync::Arc::clone(&epoch);
                                let _ = app2.run_on_main_thread(move || {
                                    // 保存前再确认 epoch 未再变化，避免记录到拖拽中的中间尺寸
                                    if *epoch2.lock().unwrap() == cur {
                                        save_main_window_size(&win2);
                                    }
                                });
                            }
                            prev = cur;
                        }
                    });
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            cnki_search,
            cnki_ping,
            popup_close,
            popup_open_external,
            open_entry_url,
            open_cnki_login,
            cnki_login_status,
            cnki_detail_auth,
            cnki_logout,
            focus_main,
            get_theme_pref,
            set_theme_pref,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
