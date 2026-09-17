; HollyMusic Desktop - NSIS 自定义安装钩子（Tauri 2 installerHooks 机制）
;
; 背景：应用关闭主窗口后会驻留系统托盘（防止误退出），旧进程会锁住
; hollymusic-desktop.exe，导致覆盖安装 / 升级时 NSIS 报
; 「无法打开要写入的文件」。因此在复制文件前先强制结束旧实例。
;
; 安装清理规则：
;   · 安装前：删除 %ProgramFiles%\HollyMusic Desktop\ 下的所有文件（保留旧版本残留的配置目录等）
;   · 卸载时：删除整个安装目录
;   · 用户数据目录 %APPDATA%\HollyMusic Desktop\config.json **永远不删除**

; 获取安装目录路径（perMachine 模式默认 Program Files）
!macro GetInstallDir OUTPUT_VAR
  ; 优先读取注册表（如果用户自定义了安装路径）
  ReadRegStr $99 HKLM "SOFTWARE\HollyMusic Desktop" "InstallDir"
  ${If} $99 == ""
    StrCpy $99 "$PROGRAMFILES64\HollyMusic Desktop"
  ${EndIf}
  StrCpy $${OUTPUT_VAR} $99
!macroend

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "正在关闭正在运行的 HollyMusic Desktop ..."
  ; /T 连同子进程一起结束；进程不存在时 nsExec 静默返回，不弹任何错误
  nsExec::Exec 'taskkill /F /IM hollymusic-desktop.exe /T'
  Pop $0
  Sleep 800

  DetailPrint "正在清理旧版本程序文件 ..."
  ${GetInstallDir} INSTALL_DIR
  IfFileExists "$INSTALL_DIR\*" 0 +3
    ; 删除所有文件和子目录（保留目录本身以便后续写入）
    RMDir /r /REBOOTOK "$INSTALL_DIR"
    Sleep 500
    ; 重新创建空目录
    CreateDirectory "$INSTALL_DIR"
  ${EndIf}
  DetailPrint "旧版本程序文件已清理。"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "HollyMusic Desktop 安装完成。"
!macroend

!macro un.NSIS_HOOK_PREUNINSTALL
  DetailPrint "正在关闭正在运行的 HollyMusic Desktop ..."
  nsExec::Exec 'taskkill /F /IM hollymusic-desktop.exe /T'
  Pop $0
  Sleep 800

  DetailPrint "正在清理安装目录 ..."
  ${GetInstallDir} INSTALL_DIR
  IfFileExists "$INSTALL_DIR\*" 0 +2
    RMDir /r /REBOOTOK "$INSTALL_DIR"
  ${EndIf}
  DetailPrint "安装目录已清理，用户数据已保留。"
!macroend
