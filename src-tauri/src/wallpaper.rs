//! 桌面壁纸 / 桌面歌词的原生窗口操作。
//!
//! # 桌面壁纸（WorkerW）
//! Windows 的桌面由 `Progman` 管理，图标层是一个 class 名为 `WorkerW` 的窗口
//! （其子窗口为 `SHELLDLL_DefView`）。向 `Progman` 发送 `0x052C` 会让它分裂出
//! 第二个 `WorkerW`，这个「没有 DefView 子窗口」的 WorkerW 就是壁纸层。
//! 把我们的窗口 `SetParent` 到它下面，即可显示在图标之后、桌面壁纸之上。
//!
//! 注意：Explorer 重启、分辨率/多显示器变化都会让 WorkerW 失效，
//! 因此这里附带一个看门狗线程定期校验并重新挂载。
//!
//! # 桌面歌词
//! `WS_EX_TOOLWINDOW`（不进任务栏与 Alt+Tab）+ `WS_EX_NOACTIVATE`（点击不抢焦点）
//! + `WS_EX_TRANSPARENT`（鼠标穿透）实现「悬浮、不打扰、可穿透」的歌词条。

use tauri::WebviewWindow;

/// 把窗口挂到桌面壁纸层（WorkerW）并铺满整个虚拟屏幕。
#[cfg(target_os = "windows")]
pub fn attach_wallpaper(window: &WebviewWindow) -> Result<(), String> {
    use std::ffi::c_void;
    use windows::core::w;
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, FindWindowExW, FindWindowW, SendMessageTimeoutW, SetParent, SetWindowPos,
        SMTO_NORMAL, SWP_NOACTIVATE, SWP_NOZORDER, SWP_SHOWWINDOW, HWND_BOTTOM,
    };

    struct Probe {
        worker: HWND,
    }

    unsafe extern "system" fn enum_workerw(hwnd: HWND, lparam: LPARAM) -> windows::Win32::Foundation::BOOL {
        let probe = &mut *(lparam.0 as *mut Probe);
        // 只有带 SHELLDLL_DefView 子窗口的 WorkerW 才是桌面图标层
        if FindWindowExW(hwnd, None, w!("SHELLDLL_DefView"), None).is_ok() {
            // 它在 Z 序上的下一个 WorkerW 才是壁纸层（Win10/11）
            probe.worker = match FindWindowExW(None, hwnd, w!("WorkerW"), None) {
                Ok(next) if !next.0.is_null() => next,
                _ => hwnd,
            };
            return windows::Win32::Foundation::BOOL(0); // 找到即停止枚举
        }
        windows::Win32::Foundation::BOOL(1)
    }

    /// 查找壁纸层 WorkerW；找不到时先向 Progman 发 0x052C 催生再找一次。
    unsafe fn find_wallpaper_workerw() -> Option<HWND> {
        let mut probe = Probe {
            worker: HWND(std::ptr::null_mut()),
        };
        let _ = EnumWindows(
            Some(enum_workerw),
            LPARAM(&mut probe as *mut Probe as isize),
        );
        if !probe.worker.0.is_null() {
            return Some(probe.worker);
        }
        if let Ok(progman) = FindWindowW(w!("Progman"), None) {
            // 0x052C 是未公开的「分裂 WorkerW」消息：Progman 收到后会生成一个壁纸层窗口
            let mut result: usize = 0;
            SendMessageTimeoutW(
                progman,
                0x052C,
                windows::Win32::Foundation::WPARAM(0),
                LPARAM(0),
                SMTO_NORMAL,
                1000,
                Some(&mut result),
            );
            let mut probe2 = Probe {
                worker: HWND(std::ptr::null_mut()),
            };
            let _ = EnumWindows(
                Some(enum_workerw),
                LPARAM(&mut probe2 as *mut Probe as isize),
            );
            if !probe2.worker.0.is_null() {
                return Some(probe2.worker);
            }
        }
        None
    }

    /// 虚拟屏幕范围：覆盖所有显示器（可能为负起点，例如副屏在主屏左侧）。
    unsafe fn virtual_screen() -> (i32, i32, i32, i32) {
        use windows::Win32::UI::WindowsAndMessaging::{
            GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
            SM_YVIRTUALSCREEN,
        };
        (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN),
            GetSystemMetrics(SM_CYVIRTUALSCREEN),
        )
    }

    let hwnd = window.hwnd().map_err(|e| format!("获取窗口句柄失败：{e}"))?;
    // tauri 与本项目可能链接不同版本的 windows crate，用裸指针做一次无损转换。
    let hwnd = HWND(hwnd.0 as *mut c_void);

    unsafe {
        let worker =
            find_wallpaper_workerw().ok_or_else(|| "未找到 WorkerW 壁纸层".to_string())?;
        let (x, y, w, h) = virtual_screen();
        let _ = SetParent(hwnd, worker);
        SetWindowPos(
            hwnd,
            HWND_BOTTOM,
            x,
            y,
            w,
            h,
            SWP_NOACTIVATE | SWP_NOZORDER | SWP_SHOWWINDOW,
        )
        .map_err(|e| format!("调整壁纸窗口位置失败：{e}"))?;
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn attach_wallpaper(_window: &WebviewWindow) -> Result<(), String> {
    Err("桌面壁纸仅支持 Windows".to_string())
}

/// 把窗口从壁纸层摘下来（关闭前调用，避免 Explorer 侧残留）。
#[cfg(target_os = "windows")]
pub fn detach_wallpaper(window: &WebviewWindow) {
    use std::ffi::c_void;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::SetParent;

    if let Ok(hwnd) = window.hwnd() {
        let hwnd = HWND(hwnd.0 as *mut c_void);
        unsafe {
            let _ = SetParent(hwnd, HWND(std::ptr::null_mut()));
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub fn detach_wallpaper(_window: &WebviewWindow) {}

/// 设置鼠标穿透（桌面歌词用）。打开时同时置上 NOACTIVATE / TOOLWINDOW，
/// 保证歌词条不抢焦点、不进任务栏、不出现在 Alt+Tab。
#[cfg(target_os = "windows")]
pub fn set_click_through(window: &WebviewWindow, enabled: bool) -> Result<(), String> {
    use std::ffi::c_void;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongW, SetWindowLongW, GWL_EXSTYLE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
        WS_EX_TRANSPARENT,
    };

    let hwnd = window.hwnd().map_err(|e| format!("获取窗口句柄失败：{e}"))?;
    let hwnd = HWND(hwnd.0 as *mut c_void);
    unsafe {
        let style = GetWindowLongW(hwnd, GWL_EXSTYLE);
        let base = style | (WS_EX_TOOLWINDOW.0 as i32) | (WS_EX_NOACTIVATE.0 as i32);
        let next = if enabled {
            base | (WS_EX_TRANSPARENT.0 as i32)
        } else {
            base & !(WS_EX_TRANSPARENT.0 as i32)
        };
        SetWindowLongW(hwnd, GWL_EXSTYLE, next);
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn set_click_through(_window: &WebviewWindow, _enabled: bool) -> Result<(), String> {
    Err("鼠标穿透仅支持 Windows".to_string())
}

/// 看门狗：每 5 秒校验一次挂载状态，并检测是否有全屏应用遮挡桌面。
///
/// - Explorer 重启 / 分辨率变化 → WorkerW 失效，自动重新挂载；
/// - 前台窗口占满整个屏幕（游戏、视频全屏）→ 通知前端暂停渲染，省电省 GPU。
#[cfg(target_os = "windows")]
pub fn spawn_watchdog(window: WebviewWindow) {
    use std::time::Duration;
    use tauri::Emitter;
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetParent, GetShellWindow, GetSystemMetrics, GetWindowRect,
        SM_CXSCREEN, SM_CYSCREEN,
    };

    std::thread::spawn(move || {
        let mut last_paused = false;
        loop {
            std::thread::sleep(Duration::from_secs(5));
            if !window.is_visible().unwrap_or(false) {
                continue;
            }

            // 1) 挂载失效 → 重新挂载
            let need_attach = match window.hwnd() {
                Ok(hwnd) => unsafe {
                    let hwnd = HWND(hwnd.0 as *mut std::ffi::c_void);
                    // GetParent 返回 Result：拿不到父窗口即视为挂载已失效
                    !GetParent(hwnd).map(|p| !p.0.is_null()).unwrap_or(false)
                },
                Err(_) => false,
            };
            if need_attach {
                let _ = attach_wallpaper(&window);
            }

            // 2) 全屏检测
            let fullscreen = unsafe {
                let fg = GetForegroundWindow();
                let shell = GetShellWindow();
                if fg.0.is_null() || fg.0 == shell.0 {
                    false
                } else {
                    let mut rect = RECT::default();
                    let ok = GetWindowRect(fg, &mut rect);
                    match ok {
                        Ok(()) => {
                            let sw = GetSystemMetrics(SM_CXSCREEN);
                            let sh = GetSystemMetrics(SM_CYSCREEN);
                            (rect.right - rect.left) >= sw && (rect.bottom - rect.top) >= sh
                        }
                        Err(_) => false,
                    }
                }
            };

            if fullscreen != last_paused {
                last_paused = fullscreen;
                let js = format!(
                    "window.dispatchEvent(new CustomEvent('hm:pause',{{detail:{{paused:{fullscreen}}}}}))"
                );
                let _ = window.eval(&js);
                let _ = window.emit("wallpaper-pause", fullscreen);
            }
        }
    });
}

#[cfg(not(target_os = "windows"))]
pub fn spawn_watchdog(_window: WebviewWindow) {}
