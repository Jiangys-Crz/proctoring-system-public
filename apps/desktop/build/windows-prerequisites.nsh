; This hook runs after elevation but BEFORE electron-builder uninstalls the old
; application. A failed prerequisite or required reboot must never reach the
; application replacement section or its --force-run / finish-page launch.
!ifndef CWNUPAA_WINDOWS_PREREQUISITES_INCLUDED
!define CWNUPAA_WINDOWS_PREREQUISITES_INCLUDED

!include "LogicLib.nsh"
!include "WinVer.nsh"
!include "x64.nsh"

!ifndef BUILD_UNINSTALLER
  Var proctorPrerequisiteDirectory
  Var proctorPrerequisitePowerShell
  Var proctorPrerequisiteResult
  Var proctorPrerequisiteLog
  Var proctorPrerequisitePreviousDirectory

  Function ProctorCheckWindowsPrerequisites
    ; Newer Windows versions do not require the Windows 7 packages.
    ${IfNot} ${IsWin7}
      Return
    ${EndIf}

    InitPluginsDir
    StrCpy $proctorPrerequisitePreviousDirectory $OUTDIR
    StrCpy $proctorPrerequisiteDirectory "$PLUGINSDIR\windows-prerequisites"
    SetOutPath "$proctorPrerequisiteDirectory"
    File /oname=install-prerequisites.ps1 "${PROJECT_DIR}\resources\windows-prerequisites\install-prerequisites.ps1"
    GetTempFileName $proctorPrerequisiteLog "$TEMP"
    StrCpy $proctorPrerequisitePowerShell "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
    ${If} ${RunningX64}
      ; NSIS is a 32-bit process. Use the native host/registry view on x64.
      StrCpy $proctorPrerequisitePowerShell "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
    ${EndIf}
    IfFileExists "$proctorPrerequisitePowerShell" +4 0
      StrCpy $proctorPrerequisiteResult "1"
      MessageBox MB_OK|MB_ICONSTOP "没有找到 Windows PowerShell。请管理员修复系统组件后重新运行安装包。现有监考客户端尚未被替换。" /SD IDOK
      Goto proctor_prerequisites_failed

    ; CheckOnly does not install anything and does not need the large packages.
    nsExec::ExecToLog /TIMEOUT=60000 '"$proctorPrerequisitePowerShell" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$proctorPrerequisiteDirectory\install-prerequisites.ps1" -PackageDirectory "$proctorPrerequisiteDirectory" -CheckOnly -LogPath "$proctorPrerequisiteLog"'
    Pop $proctorPrerequisiteResult
    ${If} $proctorPrerequisiteResult == "0"
      Goto proctor_prerequisites_ready
    ${ElseIf} $proctorPrerequisiteResult == "3010"
      Goto proctor_prerequisites_restart
    ${ElseIf} $proctorPrerequisiteResult != "2"
      Goto proctor_prerequisites_error_message
    ${EndIf}

    ; Silent deployment may prepare dependencies, but must never restart Windows.
    ; Interactive updates explain the one-time machine-level change first.
    ${IfNot} ${Silent}
      MessageBox MB_YESNO|MB_ICONINFORMATION|MB_DEFBUTTON2 "此 Windows 7 电脑需要准备 PowerShell 5.1，才能使用内网 submit 和 printfile。安装器将使用随包的微软离线组件，按需安装 .NET Framework 和 WMF 5.1。过程可能较久，并可能需要重启电脑后重新运行本安装包。$\r$\n$\r$\n是否现在准备？请选择赛前维护时段操作。" IDYES proctor_prerequisites_install
      StrCpy $proctorPrerequisiteResult "1602"
      Goto proctor_prerequisites_failed
    ${EndIf}

    proctor_prerequisites_install:
    DetailPrint "正在准备 Windows 7 命令行环境，请等待；不会自动重启电脑。"
    File /oname=manifest.ini "${BUILD_RESOURCES_DIR}\windows-prerequisites\manifest.ini"
    File /oname=dotnet452.exe "${BUILD_RESOURCES_DIR}\windows-prerequisites\dotnet452.exe"
    ${If} ${RunningX64}
      File /oname=wmf51-x64.msu "${BUILD_RESOURCES_DIR}\windows-prerequisites\wmf51-x64.msu"
    ${Else}
      File /oname=wmf51-x86.msu "${BUILD_RESOURCES_DIR}\windows-prerequisites\wmf51-x86.msu"
    ${EndIf}
    ${IfNot} ${Silent}
      Banner::show /NOUNLOAD "正在离线准备 Windows 7 的 .NET / PowerShell 5.1 环境，请等待。不会自动重启电脑。"
    ${EndIf}
    ; Do not time out a running system update: killing only PowerShell could
    ; leave .NET/wusa installing while NSIS deletes its temporary payload.
    nsExec::ExecToLog '"$proctorPrerequisitePowerShell" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$proctorPrerequisiteDirectory\install-prerequisites.ps1" -PackageDirectory "$proctorPrerequisiteDirectory" -LogPath "$proctorPrerequisiteLog"'
    Pop $proctorPrerequisiteResult
    ${IfNot} ${Silent}
      Banner::destroy
    ${EndIf}
    ${If} $proctorPrerequisiteResult == "0"
      Goto proctor_prerequisites_ready
    ${ElseIf} $proctorPrerequisiteResult == "3010"
      Goto proctor_prerequisites_restart
    ${EndIf}

    proctor_prerequisites_error_message:
    MessageBox MB_OK|MB_ICONSTOP "Windows 7 环境准备未完成（返回码：$proctorPrerequisiteResult）。请管理员确认 SP1、.NET 和 PowerShell 环境；若已安装 WMF 3.0，需要先按微软说明卸载。$\r$\n$\r$\n日志：$proctorPrerequisiteLog$\r$\n修复后重新运行本安装包。现有监考客户端尚未被替换。" /SD IDOK
    ; nsExec returns textual 'error'/'timeout' if the child could not finish.
    StrCpy $proctorPrerequisiteResult "1"
    Goto proctor_prerequisites_failed

    proctor_prerequisites_restart:
    MessageBox MB_OK|MB_ICONINFORMATION "Windows 系统组件需要重启才能完成准备。请保存工作，手动重启电脑，然后再次运行本安装包。$\r$\n$\r$\n日志：$proctorPrerequisiteLog$\r$\n此次监考客户端安装/更新尚未完成，现有程序尚未被替换；安装器不会自动重启电脑或启动客户端。" /SD IDOK
    StrCpy $proctorPrerequisiteResult "3010"

    proctor_prerequisites_failed:
    SetOutPath "$proctorPrerequisitePreviousDirectory"
    SetErrorLevel $proctorPrerequisiteResult
    Quit

    proctor_prerequisites_ready:
    SetOutPath "$proctorPrerequisitePreviousDirectory"
  FunctionEnd

  !macro customInit
    Call ProctorCheckWindowsPrerequisites
  !macroend
!endif
!endif
