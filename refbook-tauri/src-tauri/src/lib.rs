// CNKI 工具书划词查询 —— Tauri 桌面版主入口
mod cnki;

use std::sync::Mutex;
use tauri::{Emitter, Manager, WebviewWindow};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Code, Modifiers, Shortcut, ShortcutState};

struct AppState {
    popup: Mutex<Option<WebviewWindow>>,
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

/// 读取系统选中文本：Linux 读 X11 PRIMARY 选区，其他平台读剪贴板
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
    let bytes = clipboard.load_wait(
        atoms.primary,
        atoms.utf8_string,
        atoms.property,
    ).ok()?;
    let s = String::from_utf8_lossy(&bytes);
    let s = s.trim_end_matches('\0').to_string();
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
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(AppState { popup: Mutex::new(None) })
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
