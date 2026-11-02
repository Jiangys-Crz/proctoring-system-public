# Windows broadcast guard

`guard.c` is a temporary child process used only while an administrator's screen
broadcast is active. Build both architectures with
`node scripts/prepare-windows-screen-control.mjs --rebuild`; normal builds verify
the checked-in binaries against `artifacts.json`.

Electron 22's `setVisibleOnAllWorkspaces` explicitly does nothing on Windows:
https://github.com/electron/electron/blob/v22.3.27/docs/api/browser-window.md#winsetvisibleonallworkspacesvisible-options

The helper installs a low-level keyboard hook on a dedicated message thread.
It blocks Windows-key combinations (including Task View, new/switch/close
virtual desktops) and common window-switch/close shortcuts. It neither captures
nor logs typed text. The Windows secure attention sequence remains available.
The hook thread never waits for painting, shell COM calls, or Node.js work:
https://learn.microsoft.com/en-us/windows/win32/winmsg/lowlevelkeyboardproc

For gesture-driven switches, the documented `IVirtualDesktopManager` checks the
native shields and the Electron HWNDs supplied by the parent. Handles are
accepted only when they belong to the parent PID. On a desktop change, new
native shields are created on every monitor of the active desktop; Electron is
then told to recreate the image windows there. Merely showing old HWNDs would
leave them on the old desktop. Windows 7/8 do not provide virtual desktops and
use the keyboard/multi-monitor portion only.
https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nn-shobjidl_core-ivirtualdesktopmanager

STOP, pipe disconnection, parent exit and helper termination release the hook
and windows. The parent also terminates a helper that fails to stop within one
second. There are no registry, policy, taskbar, or system-desktop changes to undo.
Startup/crash/COM failures produce a visible protection error and at most three
launch attempts per broadcast. They are not reported as protected success.

Portable tests execute the C shortcut policy and test the parent lifecycle,
window recreation, hot-plugging and failure handling. Windows x64/ia32 builds
verify the native ABI/linking. These checks do **not** substitute for Windows OS
testing. Before deployment, test on Windows 10/11 with multiple monitors: Win+Tab,
Ctrl+Win+Left/Right/D/F4, touchpad virtual-desktop gestures, monitor hot-plug,
administrator STOP, parent crash and helper crash. Confirm the images cover the
current desktop and shortcuts return to normal after STOP. Secure desktop/UAC,
Ctrl+Alt+Delete, privileged termination and physical system controls are outside
an ordinary application's isolation boundary; this is not an OS kiosk policy.
