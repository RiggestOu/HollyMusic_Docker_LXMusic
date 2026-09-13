//! Tauri IPC 命令：前端（Web）与桌面外壳之间的唯一通道。
//!
//! # 数据流
//! ```text
//! 主窗口 JS --invoke--> Rust --eval(CustomEvent)--> 壁纸窗口 / 歌词窗口
//! ```
//! 命令名与事件名保持稳定，便于后续其它客户端（如移动端壳）复用。
//!
//! # 与前端的桥接方式
//! 前端不引入 `@tauri-apps/api`：
//!   · 前端 → Rust：用 Tauri 注入的全局 `window.__TAURI__.core.invoke()`（`withGlobalTauri = true`）
//!   · Rust → 前端：用 `WebviewWindow::eval()` 派发标准 `CustomEvent`，
//!     前端只需 `window.addEventListener('hm:spectrum', ...)`，零依赖、跨端可测。

use crate::config::{normalize_server_url, save_config, AppConfig, AppState};
use crate::windows;
use tauri::{AppHandle, Emitter, Manager, State};

/// 读取当前桌面端配置。
#[tauri::command]
pub fn get_config(state: State<'_, AppState>) -> AppConfig {
    state.config.lock().clone()
}

/// 保存配置并立即生效（服务地址变化会重新导航主窗口）。
#[tauri::command]
pub fn set_config(app: AppHandle, state: State<'_, AppState>, config: AppConfig) -> Result<(), String> {
    let mut current = state.config.lock();
    let prev_url = normalize_server_url(&current.server_url);
    let next_url = normalize_server_url(&config.server_url);
    let mut next = config;
    next.server_url = next_url.clone();
    *current = next.clone();
    drop(current);
    save_config(&next)?;

    if prev_url != next_url {
        windows::navigate_main(&app, &next_url)?;
    }
    // 让壁纸 / 歌词窗口同步新配置（渲染后端、密度、帧率等）
    let payload = serde_json::to_string(&next).unwrap_or_else(|_| "{}".to_string());
    for label in ["main", "wallpaper", "lyrics", "settings"] {
        if let Some(w) = app.get_webview_window(label) {
            let js = format!(
                "window.dispatchEvent(new CustomEvent('hm:config',{{detail:{payload}}}))"
            );
            let _ = w.eval(&js);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn create_wallpaper_window(app: AppHandle) -> Result<(), String> {
    windows::create_wallpaper_window(&app)
}

#[tauri::command]
pub fn close_wallpaper_window(app: AppHandle) {
    windows::close_wallpaper_window(&app)
}

#[tauri::command]
pub fn create_lyrics_window(app: AppHandle) -> Result<(), String> {
    windows::create_lyrics_window(&app)
}

#[tauri::command]
pub fn close_lyrics_window(app: AppHandle) {
    windows::close_lyrics_window(&app)
}

/// 主窗口把实时频谱推给桌面壁纸（0~255，通常 32~64 个频段）。
///
/// Rust 侧同时以 Tauri 事件 `audio-spectrum` 和 `hm:spectrum` 自定义事件两种形式广播，
/// 前者供未来原生页面使用，后者是当前 Web 壁纸页实际监听的通道。
#[tauri::command]
pub fn send_audio_spectrum(app: AppHandle, spectrum: Vec<f32>) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("wallpaper") {
        let detail = serde_json::to_string(&spectrum).unwrap_or_else(|_| "[]".to_string());
        let js = format!(
            "window.dispatchEvent(new CustomEvent('hm:spectrum',{{detail:{detail}}}))"
        );
        w.eval(&js).map_err(|e| format!("推送频谱失败：{e}"))?;
        let _ = w.emit("audio-spectrum", spectrum);
    }
    Ok(())
}

/// 推送歌词到桌面歌词窗口。payload 由前端自行定义（这里保持透传，Rust 不解析结构）。
#[tauri::command]
pub fn update_lyrics(app: AppHandle, payload: serde_json::Value) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("lyrics") {
        let detail = payload.to_string();
        let js =
            format!("window.dispatchEvent(new CustomEvent('hm:lyrics',{{detail:{detail}}}))");
        w.eval(&js).map_err(|e| format!("推送歌词失败：{e}"))?;
        let _ = w.emit("lyrics-update", payload);
    }
    Ok(())
}

/// 播放状态变化（切歌 / 播放 / 暂停 / 进度）。桌面歌词窗口据此自取歌词与高亮行。
#[tauri::command]
pub fn send_playback_state(app: AppHandle, payload: serde_json::Value) -> Result<(), String> {
    let detail = payload.to_string();
    if let Some(w) = app.get_webview_window("lyrics") {
        let js = format!(
            "window.dispatchEvent(new CustomEvent('hm:playback',{{detail:{detail}}}))"
        );
        let _ = w.eval(&js);
        let _ = w.emit("playback-state", payload.clone());
    }
    Ok(())
}

/// 桌面歌词鼠标穿透开关。
#[tauri::command]
pub fn set_lyrics_click_through(
    app: AppHandle,
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("lyrics") {
        crate::wallpaper::set_click_through(&w, enabled)?;
    }
    let mut config = state.config.lock();
    config.lyrics_click_through = enabled;
    save_config(&config)?;
    Ok(())
}

/// 暂停 / 恢复壁纸渲染（全屏应用遮挡桌面时由看门狗自动调用，也可手动）。
/// 传 `null` 表示切换当前状态，返回切换后的暂停状态。
#[tauri::command]
pub fn toggle_wallpaper_pause(
    app: AppHandle,
    state: State<'_, AppState>,
    paused: Option<bool>,
) -> Result<bool, String> {
    let mut config = state.config.lock();
    let next = paused.unwrap_or(!config.wallpaper_paused);
    config.wallpaper_paused = next;
    drop(config);
    if let Some(w) = app.get_webview_window("wallpaper") {
        let js = format!(
            "window.dispatchEvent(new CustomEvent('hm:pause',{{detail:{{paused:{next}}}}}))"
        );
        let _ = w.eval(&js);
        let _ = w.emit("wallpaper-pause", next);
    }
    Ok(next)
}

/// 打开桌面端设置页。
#[tauri::command]
pub fn open_settings_window(app: AppHandle) -> Result<(), String> {
    windows::create_settings_window(&app)
}
