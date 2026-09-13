//! 桌面端配置：读写 `%APPDATA%/HollyMusic Desktop/config.json`（其它平台落到用户配置目录）。
//!
//! 这里只保存「桌面端外壳」自己的设置（服务地址、壁纸 / 歌词开关、渲染后端等），
//! **绝不触碰 HollyMusic 服务端的数据库**——桌面端只是 WebView 外壳，
//! 所有音乐数据仍由服务端 API 提供。

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    /// HollyMusic 服务地址，例如 `http://localhost:3099` 或自部署域名。
    pub server_url: String,
    /// 启动后是否自动创建桌面壁纸窗口。
    pub wallpaper_enabled: bool,
    /// 启动后是否自动创建桌面歌词窗口。
    pub lyrics_enabled: bool,
    /// 桌面歌词是否鼠标穿透（开启后不能拖动/关闭，需从托盘关闭）。
    pub lyrics_click_through: bool,
    /// 壁纸渲染是否暂停（检测到全屏应用时自动置位）。
    pub wallpaper_paused: bool,
    /// 粒子渲染后端偏好：`auto` / `webgpu` / `webgl2`。
    pub backend: String,
    /// 粒子网格基准边长（粒子数 = grid × grid）。
    pub grid: u32,
    /// 帧率上限。
    pub fps: u32,
    /// 粒子尺寸倍率。
    pub point_size: f32,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            server_url: "http://localhost:3099".to_string(),
            wallpaper_enabled: false,
            lyrics_enabled: false,
            lyrics_click_through: true,
            wallpaper_paused: false,
            backend: "auto".to_string(),
            grid: 160,
            fps: 60,
            point_size: 1.0,
        }
    }
}

/// 桌面端全局状态。配置用 Mutex 保护，允许托盘 / IPC 并发读写。
#[derive(Debug, Default)]
pub struct AppState {
    pub config: Mutex<AppConfig>,
}

impl AppState {
    pub fn load() -> Self {
        Self {
            config: Mutex::new(load_config()),
        }
    }
}

fn config_dir() -> PathBuf {
    let base = dirs::config_dir().unwrap_or_else(std::env::temp_dir);
    base.join("HollyMusic Desktop")
}

pub fn config_path() -> PathBuf {
    config_dir().join("config.json")
}

pub fn load_config() -> AppConfig {
    match fs::read_to_string(config_path()) {
        Ok(text) => serde_json::from_str::<AppConfig>(&text).unwrap_or_default(),
        Err(_) => AppConfig::default(),
    }
}

pub fn save_config(config: &AppConfig) -> Result<(), String> {
    let dir = config_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败：{e}"))?;
    let text =
        serde_json::to_string_pretty(config).map_err(|e| format!("序列化配置失败：{e}"))?;
    fs::write(config_path(), text).map_err(|e| format!("写入配置失败：{e}"))
}

/// 规范化服务地址：去掉结尾斜杠，缺协议时补 `http://`。
pub fn normalize_server_url(url: &str) -> String {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return "http://localhost:3099".to_string();
    }
    let with_scheme = if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    };
    with_scheme.trim_end_matches('/').to_string()
}
