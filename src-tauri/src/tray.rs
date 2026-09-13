//! 系统托盘：桌面端的常驻入口（壁纸 / 歌词 / 设置 / 退出）。
//!
//! 壁纸窗口不进任务栏，歌词窗口也不进 Alt+Tab，所以托盘是它们唯一的可见入口。

use tauri::{
    menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    AppHandle, Manager,
};

pub fn build(app: &AppHandle) -> Result<(), String> {
    let config = crate::current_config(app);

    let show = MenuItemBuilder::with_id("show", "显示主窗口")
        .build(app)
        .map_err(|e| e.to_string())?;
    let wallpaper = CheckMenuItemBuilder::with_id("wallpaper", "桌面壁纸")
        .checked(config.wallpaper_enabled)
        .build(app)
        .map_err(|e| e.to_string())?;
    let lyrics = CheckMenuItemBuilder::with_id("lyrics", "桌面歌词")
        .checked(config.lyrics_enabled)
        .build(app)
        .map_err(|e| e.to_string())?;
    let settings = MenuItemBuilder::with_id("settings", "桌面设置…")
        .build(app)
        .map_err(|e| e.to_string())?;
    let quit = MenuItemBuilder::with_id("quit", "退出")
        .build(app)
        .map_err(|e| e.to_string())?;

    let menu = MenuBuilder::new(app)
        .item(&show)
        .separator()
        .item(&wallpaper)
        .item(&lyrics)
        .separator()
        .item(&settings)
        .separator()
        .item(&quit)
        .build()
        .map_err(|e| e.to_string())?;

    let wallpaper_item = wallpaper.clone();
    let lyrics_item = lyrics.clone();

    TrayIconBuilder::new()
        .icon(
            app.default_window_icon()
                .ok_or_else(|| "缺少托盘图标".to_string())?
                .clone(),
        )
        .tooltip("HollyMusic")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(move |app, event| {
            match event.id.as_ref() {
                "show" => {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.unminimize();
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                }
                "wallpaper" => {
                    if app.get_webview_window("wallpaper").is_some() {
                        crate::windows::close_wallpaper_window(app);
                        let _ = wallpaper_item.set_checked(false);
                    } else {
                        let ok = crate::windows::create_wallpaper_window(app);
                        let _ = wallpaper_item.set_checked(ok.is_ok());
                        if let Err(e) = ok {
                            eprintln!("[hollymusic] 创建壁纸窗口失败：{e}");
                        }
                    }
                }
                "lyrics" => {
                    if app.get_webview_window("lyrics").is_some() {
                        crate::windows::close_lyrics_window(app);
                        let _ = lyrics_item.set_checked(false);
                    } else {
                        let ok = crate::windows::create_lyrics_window(app);
                        let _ = lyrics_item.set_checked(ok.is_ok());
                        if let Err(e) = ok {
                            eprintln!("[hollymusic] 创建歌词窗口失败：{e}");
                        }
                    }
                }
                "settings" => {
                    if let Err(e) = crate::windows::create_settings_window(app) {
                        eprintln!("[hollymusic] 打开设置窗口失败：{e}");
                    }
                }
                "quit" => {
                    crate::windows::close_wallpaper_window(app);
                    crate::windows::close_lyrics_window(app);
                    app.exit(0);
                }
                _ => {}
            }
        })
        .build(app)
        .map_err(|e| e.to_string())?;

    Ok(())
}
