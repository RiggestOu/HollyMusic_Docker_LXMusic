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

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "正在关闭正在运行的 HollyMusic Desktop ..."
  ; /T 连同子进程一起结束；进程不存在时 nsExec 静默返回，不弹任何错误
  nsExec::Exec 'taskkill /F /IM hollymusic-desktop.exe /T'
  Pop $0
  Sleep 800

  DetailPrint "正在清理旧版本程序文件 ..."
  ; 获取安装目录：优先读注册表，回退到默认 Program Files
  ReadRegStr $R0 HKLM "SOFTWARE\HollyMusic Desktop" "InstallDir"
  ${If} $R0 == ""
    StrCpy $R0 "$PROGRAMFILES64\HollyMusic Desktop"
  ${EndIf}
  
  ; 检查并删除旧文件
  ${If} ${FileExists} "$R0\*"
    RMDir /r /REBOOTOK "$R0"
    Sleep 500
    CreateDirectory "$R0"
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
  ; 获取安装目录：优先读注册表，回退到默认 Program Files
  ReadRegStr $R0 HKLM "SOFTWARE\HollyMusic Desktop" "InstallDir"
  ${If} $R0 == ""
    StrCpy $R0 "$PROGRAMFILES64\HollyMusic Desktop"
  ${EndIf}
  
  ; 删除整个安装目录
  ${If} ${FileExists} "$R0\*"
    RMDir /r /REBOOTOK "$R0"
  ${EndIf}
  DetailPrint "安装目录已清理，用户数据已保留。"
!macroend
