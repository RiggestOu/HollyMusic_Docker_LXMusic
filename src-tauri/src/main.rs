// 隐藏发布版本的控制台窗口（Windows）。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    hollymusic_desktop_lib::run()
}
