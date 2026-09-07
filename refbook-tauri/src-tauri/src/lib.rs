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

/// 读取系统选中文本：Linux 读 X11/Wayland PRIMARY 选区，其他平台读剪贴板
fn get_selection_text() -> String {
    #[cfg(target_os = "linux")]
    {
        // X11 PRIMARY selection：选中文字即存入，无需复制
        if let Some(text) = read_x11_primary() {
            let t = text.trim().to_string();
            if !t.is_empty() {
                return t;
            }
        }
        // Wayland 会话下 X11 协议读不到原生应用的 PRIMARY 选区，改用 wl-paste --primary
        if let Some(text) = read_wayland_primary() {
            let t = text.trim().to_string();
            if !t.is_empty() {
                return t;
            }
        }
    }
    // 回退：读剪贴板
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
fn read_x11_primary() -> Option<String> {
    let clipboard = x11_clipboard::Clipboard::new().ok()?;
    let atoms = &clipboard.getter.atoms;
    // load 带超时（load_wait 会无限阻塞快捷键回调），超时即跳过走 Wayland 回退
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

/// Wayland PRIMARY 选区读取：依赖 wl-clipboard 提供的 wl-paste 命令行工具
#[cfg(target_os = "linux")]
fn read_wayland_primary() -> Option<String> {
    let out = std::process::Command::new("wl-paste")
        .arg("--primary")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

/// 触发划词查询：读选区 → 显示弹窗 → 通知前端查询
fn trigger_selection_lookup(app: &tauri::AppHandle, state: &AppState) {
    let text = get_selection_text();
    let win = {
        let mut guard = state.popup.lock().unwrap();
        if guard.is_none() {
            let popup = tauri::WebviewWindowBuilder::new(
                app,
                "popup",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("划词查询")
            .inner_size(420.0, 460.0)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(true)
            .visible(false)
            .build()
            .ok();
            *guard = popup;
        }
        guard.clone().unwrap()
    };

    // 定位到屏幕中央偏上
    if let Ok(monitor) = win.current_monitor() {
        if let Some(monitor) = monitor {
            let size = monitor.size();
            let scale = monitor.scale_factor();
            let w = 420.0 * scale;
            let h = 460.0 * scale;
            let x = (size.width as f64 - w) / 2.0 / scale;
            let y = (size.height as f64 - h) / 4.0 / scale;
            let _ = win.set_position(tauri::Position::Logical(
                tauri::LogicalPosition::new(x, y),
            ));
        }
    }

    let _ = win.show();
    let _ = set_focus_delayed(&win);

    // 通过 eval 设置 popup 模式（hash 方式在 Tauri 2 不可靠）
    let _ = win.eval("window.location.hash = 'popup';");

    if text.is_empty() {
        let _ = win.emit("popup:message", serde_json::json!({"msg": "（未检测到选中文本，请先选中文字或复制词目）", "isError": true}));
    } else {
        let _ = win.emit("popup:query", &text);
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

/// 显示并聚焦主窗口（托盘 / 悬浮图标 / IPC 共用）
fn show_main(app: &AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
    }
}

/// 创建系统托盘：左键唤起主窗口，菜单提供 显示主窗口 / 划词查询 / 悬浮图标开关 / 退出
fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let lookup = MenuItem::with_id(app, "lookup", "划词查询", true, None::<&str>)?;
    let float_toggle =
        CheckMenuItem::with_id(app, "toggle-float", "显示悬浮图标", true, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = MenuBuilder::new(app)
        .item(&show)
        .item(&lookup)
        .separator()
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
            "lookup" => {
                let state = app.state::<AppState>();
                trigger_selection_lookup(app, state.inner());
            }
            "toggle-float" => {
                let checked = float_toggle.is_checked().unwrap_or(true);
                let _ = float_toggle.set_checked(!checked);
                let state = app.state::<AppState>();
                let float = state.float.lock().unwrap().clone();
                if let Some(float) = float {
                    if checked {
                        let _ = float.hide();
                    } else {
                        let _ = float.show();
                    }
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

    // 初始定位：主屏幕右下角，留出边距
    if let Ok(monitor) = float.primary_monitor() {
        if let Some(monitor) = monitor {
            let size = monitor.size();
            let scale = monitor.scale_factor();
            let x = size.width as i32 - (56.0 * scale + 32.0 * scale).round() as i32;
            let y = size.height as i32 - (56.0 * scale + 32.0 * scale).round() as i32;
            let _ = float.set_position(Position::Physical(PhysicalPosition::new(x, y)));
        }
    }
    let _ = float.show();
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

#[tauri::command]
fn focus_main(app: tauri::AppHandle) {
    show_main(&app);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(AppState {
            popup: Mutex::new(None),
            float: Mutex::new(None),
        })
        .setup(|app| {
            // 全局快捷键 Ctrl+Alt+D（避免与浏览器 Ctrl+Shift+D 书签管理冲突）
            let shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyD);
            let app_handle = app.handle().clone();
            app.global_shortcut().on_shortcut(shortcut, move |_app, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    let state = app_handle.state::<AppState>();
                    trigger_selection_lookup(&app_handle, state.inner());
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
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = win.hide();
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
            focus_main,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
