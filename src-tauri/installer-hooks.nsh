; HollyMusic Desktop - NSIS 自定义安装钩子（Tauri 2 installerHooks 机制）
;
; 背景：应用关闭主窗口后会驻留系统托盘（防止误退出），旧进程会锁住
; hollymusic-desktop.exe，导致覆盖安装 / 升级时 NSIS 报
; 「无法打开要写入的文件」。因此在复制文件前先强制结束旧实例。

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "正在关闭正在运行的 HollyMusic Desktop ..."
  ; /T 连同子进程一起结束；进程不存在时 nsExec 静默返回，不弹任何错误
  nsExec::Exec 'taskkill /F /IM hollymusic-desktop.exe /T'
  Pop $0
  Sleep 800
!macroend

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "HollyMusic Desktop 安装完成。"
!macroend
