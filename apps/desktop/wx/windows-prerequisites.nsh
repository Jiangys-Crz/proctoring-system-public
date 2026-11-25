!include "LogicLib.nsh"
!include "x64.nsh"
!include "WinVer.nsh"

!ifdef APP_ARM64
  !ifndef APP_64
    !ifndef APP_32
      !define CWNUPAA_WINDOWS_ARM64_ONLY
    !endif
  !endif
!else
  !ifdef APP_64
    !ifndef APP_32
      !define CWNUPAA_WINDOWS_X64_ONLY
    !endif
  !else
    !ifdef APP_32
      !define CWNUPAA_WINDOWS_X86_ONLY
    !endif
  !endif
!endif

!macro customHeader
  ManifestSupportedOS Win7 Win8 Win8.1 Win10
!macroend

!macro customInstall
  ; Custom installation folders must remain readable by WebView2's sandbox.
  ${If} ${AtLeastWin8}
    nsExec::ExecToStack '"$SYSDIR\icacls.exe" "$INSTDIR\webview2\109.0.1518.140" /grant "*S-1-15-2-1:(OI)(CI)(RX)" "*S-1-15-2-2:(OI)(CI)(RX)" /T /Q'
    Pop $0
    Pop $1
  ${EndIf}
  ; Network addresses and certificate trust are provisioned by the school.
  ; Installation must not change hosts or the Windows certificate stores.
!macroend
!ifndef CWNUPAA_WINDOWS_ARM64_ONLY
  !define CWNUPAA_WINDOWS_REQUIRE_UCRT
  !include "${PROJECT_DIR}\build\windows-prerequisites.nsh"
!endif

!macro ProctorWrongArchitecture MESSAGE
  MessageBox MB_OK|MB_ICONSTOP "${MESSAGE}" /SD IDOK
  SetErrorLevel 1
  Quit
!macroend

; Check the host before NSIS finds or uninstalls a previous installation.
; Keep the legacy x86+x64 installer on the original architecture selection.
!macro preInit
  !ifndef BUILD_UNINSTALLER
    !ifdef CWNUPAA_WINDOWS_ARM64_ONLY
      ${IfNot} ${IsNativeARM64}
        !insertmacro ProctorWrongArchitecture "此安装包适用于 ARM64 版 Windows，请下载与电脑架构相符的安装包。"
      ${EndIf}
    !endif
    !ifdef CWNUPAA_WINDOWS_X64_ONLY
      ${IfNot} ${IsNativeAMD64}
        !insertmacro ProctorWrongArchitecture "此安装包适用于 x64 版 Windows，请下载与电脑架构相符的安装包。"
      ${EndIf}
    !endif
    !ifdef CWNUPAA_WINDOWS_X86_ONLY
      ${IfNot} ${IsNativeIA32}
        !insertmacro ProctorWrongArchitecture "此安装包适用于 32 位 x86 版 Windows，请下载与电脑架构相符的安装包。"
      ${EndIf}
    !endif
  !endif
!macroend
