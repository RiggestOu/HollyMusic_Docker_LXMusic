//! HollyMusic 桌面端外壳（Tauri 2.x）。
//!
//! 设计原则：
//!   1. **不重写 UI** —— 所有窗口都是同一个 Web 前端的不同路由，桌面端只提供窗口与系统集成。
//!   2. **不碰数据** —— 音乐数据、歌单、播放历史全部由服务端 API 提供，
//!      桌面端只保存自己的外壳配置（`%APPDATA%/HollyMusic Desktop/config.json`）。
//!   3. **渐进启用** —— 桌面壁纸 / 桌面歌词默认关闭，随时可从托盘打开，关闭即释放资源。

mod config;
mod ipc;
mod tray;
mod wallpaper;
mod windows;

use config::AppState;
use tauri::{AppHandle, Manager, WindowEvent};

pub use config::AppConfig;

/// 读取当前配置快照（托盘 / 窗口工厂 / IPC 共用）。
pub fn current_config(app: &AppHandle) -> AppConfig {
    app.state::<AppState>().config.lock().clone()
}

pub fn run() {
    tauri::Builder::default()
        .manage(AppState::load())
        .invoke_handler(tauri::generate_handler![
            ipc::get_config,
            ipc::set_config,
            ipc::create_wallpaper_window,
            ipc::close_wallpaper_window,
            ipc::create_lyrics_window,
            ipc::close_lyrics_window,
            ipc::send_audio_spectrum,
            ipc::update_lyrics,
            ipc::send_playback_state,
            ipc::set_lyrics_click_through,
            ipc::toggle_wallpaper_pause,
            ipc::open_settings_window,
        ])
        .on_window_event(|window, event| {
            // 主窗口关闭 → 隐藏到托盘（托盘「退出」才真正结束进程）。
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
                if window.label() == "wallpaper" {
                    // 关闭前先从 WorkerW 摘下来，避免 Explorer 侧残留子窗口
                    if let Some(w) = window.app_handle().get_webview_window("wallpaper") {
                        wallpaper::detach_wallpaper(&w);
                    }
                }
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let config = current_config(&handle);

            // 服务地址与配置窗口默认地址不一致时，立即重新导航。
            let url = config::normalize_server_url(&config.server_url);
            let _ = windows::navigate_main(&handle, &url);

            tray::build(&handle)?;

            // 上次退出前开启过的窗口，本次启动自动恢复。
            if config.wallpaper_enabled {
                if let Err(e) = windows::create_wallpaper_window(&handle) {
                    eprintln!("[hollymusic] 恢复桌面壁纸失败：{e}");
                }
            }
            if config.lyrics_enabled {
                if let Err(e) = windows::create_lyrics_window(&handle) {
                    eprintln!("[hollymusic] 恢复桌面歌词失败：{e}");
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("启动 HollyMusic 桌面端失败");
}
