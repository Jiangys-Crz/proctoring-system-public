# Windows 监考客户端

此项目使用 wxWidgets 创建原生窗口，以 WebView2 Fixed Version 109.0.1518.140 加载原有桌面页面。CMake 从 `apps/desktop/package.json` 读取客户端版本，并沿用原有渲染资源、发布频道配置、Windows 辅助程序和 FFmpeg。

## 构建依赖

- Windows 构建机、CMake 3.24 或更新版本、支持 C++20 的工具链。以下命令使用 Visual Studio 2022 v143（MSVC 14.44 或更早）及「使用 C++ 的桌面开发」工作负载。MSVC 14.50 起的工具集已移除 Win7/8/8.1 支持。 [Microsoft STL 工具集说明](https://github.com/microsoft/STL/releases/tag/msvc-build-tools-14.50)
- Node.js 和仓库指定的 pnpm，用于准备 HLS、二维码和页面资源。
- 目标架构对应的完整 WebView2 **109.0.1518.140** 运行时目录。已有同版本 Fixed Version CAB 时，可解包后直接提供。Microsoft Update Catalog 也保存了同版本签名更新包，可用下述脚本提取应用本地运行时。 [Microsoft 固定版分发说明](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution#the-fixed-version-runtime-distribution-mode)
- CMake 获取并校验 wxWidgets 3.2.8.1、nlohmann/json 3.11.3 和 WebView2 SDK 1.0.1518.46。 [Microsoft SDK 版本说明](https://learn.microsoft.com/en-us/microsoft-edge/webview2/release-notes/sdk/1-0-1518-46)

### 准备固定版本运行时

新目录可通过下列命令一次准备 x64、x86 两个架构。提取需要 7-Zip（`7z` 或 `7zz`），也可在输出目录后传入工具的完整路径。

```powershell
node apps/desktop/wx/prepare-webview2-109.mjs
```

脚本下载并校验 Microsoft Update Catalog 的独立更新 EXE，从中原样提取 `Chrome-bin/109.0.1518.140`。这是微软签名的更新载荷，来源区别于微软单独发布的 Fixed Version CAB。解包过程只读取安装包文件，应用从自己的目录加载运行时。

| 架构 | Microsoft Update Catalog | 下载文件 SHA-256 |
| --- | --- | --- |
| x64 | [更新记录](https://www.catalog.update.microsoft.com/ScopedViewInline.aspx?updateid=322eb0af-cdbc-4a17-a8ca-f0ace4d4adc8) · [EXE](https://catalog.s.download.windowsupdate.com/c/msdownload/update/software/updt/2023/09/microsoftedgestandaloneinstallerx64_1c890b4b8dd6b7c93da98ebdc08ecdc5e30e50cb.exe) | `eac95c8095ec5f9971eade9827d8fb67fd251f5c16e702b5312d31067e39119b` |
| x86 | [更新记录](https://www.catalog.update.microsoft.com/ScopedViewInline.aspx?updateid=cd7a382c-62c6-46c0-8098-0d50a7953b61) · [EXE](https://catalog.s.download.windowsupdate.com/c/msdownload/update/software/updt/2023/09/microsoftedgestandaloneinstallerx86_179f59bc54d73843d9288a9fd5609de0e507b911.exe) | `60b22c71128f10abc5e92dd8fed90ff6ca55b8382ba01e48d87faf1664746a31` |

输出位于忽略提交的 `tmp/webview2-109.0.1518.140/`，包含 `x64/`、`x86/` 和来源记录 `provenance.json`。用 `--catalog-directory` 可传入保留原文件名的离线 EXE 缓存。Windows 上可加 `--verify-signatures` 用系统信任库验证 Authenticode。

## 编译和运行

在仓库根目录运行以下 PowerShell 命令。使用其他来源的同版本解包目录时，替换 `$runtime`。

```powershell
pnpm --filter @cwnupaa/proctor-desktop... install --frozen-lockfile --ignore-scripts
node apps/desktop/scripts/prepare-win-ffmpeg.mjs
$runtime = (Resolve-Path tmp/webview2-109.0.1518.140).Path

cmake -S apps/desktop/wx -B out/proctor-wx-x64 -G "Visual Studio 17 2022" -A x64 `
  -DPROCTOR_WEBVIEW2_RUNTIME="$runtime/x64"
cmake --build out/proctor-wx-x64 --config Release
cmake --install out/proctor-wx-x64 --config Release --prefix tmp/proctor-wx-dist-109.0.1518.140/x64
& .\tmp\proctor-wx-dist-109.0.1518.140\x64\proctor-desktop.exe
```

构建 x86 时改用 `-A Win32`、独立构建目录和 `$runtime/x86`，将安装目录设为 `tmp/proctor-wx-dist-109.0.1518.140/x86`。可通过 `PROCTOR_FFMPEG` 指定同架构 FFmpeg 的绝对路径。默认频道为 `unified`，也可通过 `PROCTOR_BUILD_CHANNEL` 选择 `public` 或 `intranet`。本地调试使用 `-DPROCTOR_PACKAGED=OFF`，沿用开发版更新检查流程。

编译验证时可以省略 `PROCTOR_WEBVIEW2_RUNTIME`。启动所需目录结构如下。

```text
proctor-desktop.exe
WebView2Loader.dll
resources/
  renderer/
  ffmpeg/ffmpeg.exe
  security/
  novajudge-submit/
  bridge.js
  guest.js
  media.js
  migration.html
  migration-source.js
  migration-client.js
  overlay.js
  qr.js
webview2/
  109.0.1518.140/
    msedgewebview2.exe
    ...固定版的其余文件
```

应用从自身目录加载运行时，校验文件版本、WebView2 环境版本和实际浏览器进程路径。缺少对应归档或校验失败会中止启动。内核版本由应用文件决定，固定版分发的运行时由发布包更新。 [Microsoft 固定版与 Evergreen](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/evergreen-vs-fixed-version)

## 本地数据与业务入口

- `src/main.cpp` 管理 wxWidgets 窗口、消息循环、管理员重启和 WebView2 容器的生命周期。启动日志在 `%APPDATA%\程序设计算法协会监考客户端\logs`。保留 `--proctor-version` 版本查询和 `--proctor-elevated-relaunch` 提权接续参数。
- `bridge` 与 `resources/bridge.js` 提供原有 `window.proctorApi` 请求和事件回调。主页面和比赛页的 Cookie、缓存与其他浏览器数据分别写入 `WebView2/client` 和 `WebView2/contest`。首次启动会按下节规则导入旧客户端资料。参考链接窗口使用各自独立的用户数据目录和 InPrivate 会话。
- 桌面采集在 Windows 7 保留 FFmpeg GDI 路径和原有的采集帧率与尺寸上限。正常路径通过本地二进制 JPEG 响应交付原生画面，静止画面复用已解码的位图。采集尺寸等于录像尺寸时，录像在原采集画布上独立取帧，避免在第二张画布逐帧重绘。原有预览、WHIP 与录像继续按各自的帧率工作。摄像头和麦克风由 WebView2 提供。 [Microsoft 处理本地 Web 内容](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/working-with-local-content) · [W3C 画布取帧规范](https://www.w3.org/TR/mediacapture-fromelement/)

### 旧 Windows 客户端数据迁移

在同一 Windows 用户下关闭旧 Electron 客户端再启动新版。迁移优先读取 `%APPDATA%\@cwnupaa\proctor-desktop`，也识别以应用中文名称保存的旧资料目录。旧目录保持原样，读取失败会记录到启动日志。

- 已验证的设备标识会用于尚无设备标识的新目录。服务器地址和监控预览位置写入尚无对应值的 WebView2 本地存储。
- 主页面和比赛页分别导入原分区可读取的 Cookie，保留 HttpOnly、Secure 和会话期限，以及新版中同名、同域、同路径的现有值。新考试绑定和短期监考凭据由原有登录流程建立。
- 原离线录像和告警保留原服务器地址、会话标识、上传 ID 与上传凭据。导入记录与凭证在同一个事务提交，迁移重试不会重新入队已处理的录像。新版已存在的记录继续使用新版数据。
- 恢复原内置考场会话时，客户端先向原后台验证当前会话，再读取旧比赛分区内同网站、同后台、同会话的代码和客观题草稿。新版已有草稿优先，旧登录凭据不参与草稿迁移。读不到旧档案时照常打开考场。
- 临时读取环境使用同一个固定版内核，数据读取或传输结束后即释放。某类旧数据暂时不可读取时，其余数据继续迁移。旧 HTTP 磁盘缓存文件留在原档案，浏览器在新目录重新建立缓存。切换考试范围会清理站点状态，并保留 HTTP 缓存。 [Microsoft WebView2 浏览数据接口](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2profile2)

## WebView2 109 兼容性

- HydroOJ 实时判题需要 [监考插件 0.3.7](../../../hydro-plugin/cwnupaa-proctor-auth/README.md)。客户端原生进程使用已有监考凭据申请短期 WebSocket 凭据，写入考试浏览器的 HttpOnly 会话 Cookie，并定时续期。插件校验来源、会话、比赛、连接路径及记录范围。比赛网页继续使用原有 WebSocket 代码。HTTP 请求仍按比赛范围校验，响应过滤覆盖会话的 Cookie，浏览器的连接策略限制在原有 WebSocket 路径。 [WebView2 请求接口限制](https://github.com/MicrosoftEdge/WebView2Feedback/issues/4303)
- 比赛页通过 DevTools Protocol 让页面请求绕过 Service Worker。Service Worker 的缓存、后台请求和代理行为仍需单独验证。
- Windows 7 需要 SP1。统一 NSIS 安装器在 Win7 SP1、Win8 和 Win8.1 上检测 Universal CRT，缺失时按系统版本和架构安装微软离线 KB2999226。较早的 Win8.1 系统需要先安装 KB2919355。直接运行 CMake 安装目录中的程序时应先确认系统具备 UCRT。 [Microsoft KB2999226](https://support.microsoft.com/en-us/help/2999226)

支持目标为 Windows 7 SP1、Windows 8/8.1、Windows 10 和 Windows 11。统一安装器在 32 位 Windows 上选择 x86，在 64 位 Windows 上选择 x64。交互验收由使用者在对应系统上进行。 [Microsoft WebView2 109 系统支持说明](https://blogs.windows.com/msedgedev/2022/12/09/microsoft-edge-and-webview2-ending-support-for-windows-7-and-windows-8-8-1/)

## NSIS 安装包

将 x64、x86 和 ARM64 按同一个正式频道（`unified`、`public` 或 `intranet`）构建并安装到各自的输出目录，然后生成一个合并安装包。安装器沿用现有应用标识、安装向导、快捷方式和 Win7 离线依赖检查，自动按电脑的原生架构选择客户端和固定运行时。Windows 不再生成按架构分开的安装包。 [Windows 7 安装依赖](../WINDOWS7_PREREQUISITES.md)

```powershell
pnpm dist:desktop:win
# 自定义 CMake 安装目录时
pnpm dist:desktop:win "out/proctor-wx-dist-x64" "out/proctor-wx-dist-x86" "out/proctor-wx-dist-arm64"
```

产物位于 `apps/desktop/release/wx-webview2-109`。通过现有发布 API 上传和发布时标记 `runtime=wx-webview2-109`，并用同一安装包作为安装和更新文件。客户端使用独立的 wxWidgets 版本清单和 `latest.yml` 更新源。

三个架构统一使用 `windows` 更新清单。合包中保留 x86，供 32 位 Windows 7 SP1 / Windows 10 使用；x64 用于对应的 64 位系统，ARM64 用于 ARM64 电脑。安装包保留旧版的安装标识、路径规则和快捷方式目标。发布文件前同时校验主程序和固定 WebView2 运行时的 PE 架构与实际版本资源，避免打入旧二进制。

在 Windows 上使用 Visual Studio 的 ARM64 C++ 工具可原生构建 ARM64 版。该版本连同 WebView2 和四个系统检测组件一并使用 ARM64 二进制，目标系统为 Windows 10 22H2 和 Windows 11 的 ARM64 版本。 [FFmpeg Windows 构建说明](https://github.com/BtbN/FFmpeg-Builds)

```powershell
node apps/desktop/wx/prepare-webview2-109.mjs --arch arm64
node apps/desktop/scripts/prepare-win-ffmpeg.mjs --arm64
$armRuntime = (Resolve-Path tmp/webview2-109.0.1518.140-arm64/arm64).Path
cmake -S apps/desktop/wx -B out/proctor-wx-arm64 -A ARM64 -DPROCTOR_WEBVIEW2_RUNTIME="$armRuntime"
cmake --build out/proctor-wx-arm64 --config Release --target proctor-desktop
cmake --install out/proctor-wx-arm64 --config Release --prefix out/proctor-wx-dist-arm64
# 完成其余两个架构的安装目录后，一起合包
pnpm dist:desktop:win out/proctor-wx-dist-x64 out/proctor-wx-dist-x86 out/proctor-wx-dist-arm64
```

也可在 macOS 或 Linux 上交叉编译。将 LLVM-MinGW UCRT 的 `bin` 目录加入 `PATH`，从仓库根目录用 `-DCMAKE_TOOLCHAIN_FILE="$PWD/apps/desktop/wx/cmake/windows-arm64-llvm-mingw.cmake"` 替代 `-A ARM64`。

## macOS WKWebView

macOS 目标使用 wxWidgets、Objective-C++ 和系统 WKWebView。最低版本为 macOS 14，它提供可分别持久化主页面和考试页面 Cookie、缓存及网站数据的 `WKWebsiteDataStore`。临时参考链接和屏幕展示各使用非持久化存储。 [Apple WKWebsiteDataStore](https://developer.apple.com/documentation/webkit/wkwebsitedatastore)

构建机器需要支持 C++20/Objective-C++ 的 Xcode 工具链、CMake 3.24 或以上、Node 和已安装仓库依赖的 pnpm。CMake 使用与 Windows 目标相同的 wxWidgets 和 nlohmann/json 固定版本。打包脚本分别准备对应架构的 FFmpeg 和 Electron 22.3.27 数据迁移助手，并校验下载文件的 SHA-256。正常界面和考试页均由 WKWebView 渲染，迁移助手用于读取旧档案。

```sh
pnpm dist:desktop:mac
pnpm --filter @cwnupaa/proctor-desktop dist:mac:arm64
pnpm --filter @cwnupaa/proctor-desktop dist:mac:x64
```

默认打包目录为 `apps/desktop/release/wx-wkwebview`。Apple Silicon 的文件名为 `proctor-<版本>-mac-arm64.dmg`，Intel 的文件名为 `proctor-<版本>-mac-x64.dmg`。本地包使用临时签名。正式签名可通过 `PROCTOR_MAC_SIGN_IDENTITY` 指定 Developer ID，公证另行完成。发布后台分别选择 WKWebView 的两个 Mac 架构，运行时标记为 `wx-wkwebview`。

- `mac/main.mm` 运行 wxWidgets 与 AppKit 消息循环。主界面沿用桌面渲染资源，屏幕采集使用 ScreenCaptureKit，摄像头和麦克风使用 WebKit 与系统权限。屏幕覆盖、参考窗口、文件保存和快捷键由原生宿主管理。
- 屏幕采集通过应用内本地 HTTP 接口交付二进制 JPEG。内容未变化时复用上一帧。控屏窗口通过私有资源地址只读取当前图片，多屏布局变化时复用已有窗口。考试分区切换时保留 HTTP 缓存。
- 主页面通过仅监听 `127.0.0.1` 的应用内静态服务读取资源。端口在同一 macOS 用户的应用数据目录保存，使页面偏好和 IndexedDB 在升级后仍属于同一个来源。启动日志位于 `~/Library/Application Support/org.cwnupaa.proctor/wkwebview/startup.log`。
- 首次启动从旧 Electron 档案迁移设备 ID 和三项页面偏好。迁移助手在临时快照中读取主页面及考试分区 Cookie、待上传录像、离线告警和主页面 CacheStorage 中可读取的 GET 响应。跨源不透明响应和重定向留在旧档案。Cookie 写入对应的 WKWebView 存储，录像保留原上传 ID 和会话信息，由原队列继续处理。遇到不可读取的录像时，其余可读取记录继续迁移。原始档案完整保留。
- 恢复原内置考场会话时，沿用 Windows 版的草稿核验规则。后台迁移助手通过旧档案的临时快照读取匹配的草稿，由 WKWebView 补齐当前网站缺失的条目。
- macOS 钥匙串可能要求授权读取原 Electron Cookie。授权失败时客户端仍导入其他可读数据，下次启动再尝试未完成部分。WKWebView 的公开接口无法导入 Chromium 的 HTTP 磁盘缓存，旧文件留在原目录，WKWebView 按原请求重新填充自己的缓存。 [Apple WKWebsiteDataStore](https://developer.apple.com/documentation/webkit/wkwebsitedatastore)
- HydroOJ 浏览器考试需要部署 [监考插件 0.3.8](../../../hydro-plugin/cwnupaa-proctor-auth/README.md) 并使用 HTTPS。客户端在考试存储中安装按路径分配的短时凭据并定时续期，网页继续使用原有 HTTP 与 WebSocket。
- NovaJudge 浏览器考试需要部署提供 `POST /api/contests/:contestId/proctoring-wk-lease` 的 NovaJudge 服务并使用 HTTPS。客户端原生进程提交原有监考凭据换取最多 90 秒的 HttpOnly Cookie，写入隔离的考试存储并定时续期。服务端校验比赛、会话和当前监考绑定。原有登录页面、提交流程和命令行凭据接口继续使用。
