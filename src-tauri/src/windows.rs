//! 窗口工厂：主窗口 / 桌面壁纸 / 桌面歌词 / 设置。
//!
//! 所有窗口都是同一套 Web 前端的不同路由，桌面端不重写任何 UI：
//!   · `/`          主界面（主窗口）
//!   · `/wallpaper` 纯粒子壁纸页（无侧栏、无播控）
//!   · `/lyrics`    透明歌词叠加页
//!   · `/settings`  桌面端设置页

use crate::config::{normalize_server_url, AppConfig};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

fn page_url(config: &AppConfig, path: &str) -> Result<tauri::Url, String> {
    let base = normalize_server_url(&config.server_url);
    tauri::Url::parse(&format!("{base}{path}")).map_err(|e| format!("服务地址无效：{e}"))
}

/// 桌面壁纸窗口：无边框、不进任务栏，创建后由 `wallpaper::attach_wallpaper` 挂到 WorkerW。
pub fn create_wallpaper_window(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window("wallpaper").is_some() {
        return Ok(());
    }
    let config = crate::current_config(app);
    let url = page_url(&config, "/wallpaper")?;
    let window = WebviewWindowBuilder::new(app, "wallpaper", WebviewUrl::External(url))
        .title("HollyMusic Wallpaper")
        .decorations(false)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .inner_size(960.0, 600.0)
        .build()
        .map_err(|e| format!("创建壁纸窗口失败：{e}"))?;

    window.show().map_err(|e| format!("显示壁纸窗口失败：{e}"))?;
    crate::wallpaper::attach_wallpaper(&window)?;
    crate::wallpaper::spawn_watchdog(window);
    Ok(())
}

/// 桌面歌词窗口：透明、置顶、默认鼠标穿透。
pub fn create_lyrics_window(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window("lyrics").is_some() {
        return Ok(());
    }
    let config = crate::current_config(app);
    let url = page_url(&config, "/lyrics")?;
    let window = WebviewWindowBuilder::new(app, "lyrics", WebviewUrl::External(url))
        .title("HollyMusic Lyrics")
        .transparent(true)
        .decorations(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .resizable(false)
        .shadow(false)
        .inner_size(1000.0, 240.0)
        .build()
        .map_err(|e| format!("创建歌词窗口失败：{e}"))?;

    window.show().map_err(|e| format!("显示歌词窗口失败：{e}"))?;
    if config.lyrics_click_through {
        let _ = crate::wallpaper::set_click_through(&window, true);
    }
    Ok(())
}

/// 桌面端设置页窗口。
pub fn create_settings_window(app: &AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("settings") {
        w.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    let config = crate::current_config(app);
    let url = page_url(&config, "/settings")?;
    WebviewWindowBuilder::new(app, "settings", WebviewUrl::External(url))
        .title("HollyMusic 桌面设置")
        .inner_size(680.0, 720.0)
        .resizable(true)
        .build()
        .map_err(|e| format!("创建设置窗口失败：{e}"))?;
    Ok(())
}

/// 关闭壁纸窗口：先把窗口从 WorkerW 摘下来，再销毁，避免 Explorer 残留。
pub fn close_wallpaper_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("wallpaper") {
        crate::wallpaper::detach_wallpaper(&w);
        let _ = w.destroy();
    }
}

pub fn close_lyrics_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("lyrics") {
        let _ = w.destroy();
    }
}

/// 主窗口重新导航（服务地址变更时调用）。
pub fn navigate_main(app: &AppHandle, url: &str) -> Result<(), String> {
    let parsed = tauri::Url::parse(url).map_err(|e| format!("服务地址无效：{e}"))?;
    if let Some(w) = app.get_webview_window("main") {
        w.navigate(parsed).map_err(|e| format!("导航失败：{e}"))?;
    }
    Ok(())
}
