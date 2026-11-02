# Windows 7 安装与更新时准备命令行环境

Windows 安装向导会在替换旧客户端前检查 Windows 7 的系统组件。已具备 PowerShell 5.1、
.NET Framework 4.5.2 或更高版本且不需要重启的电脑直接继续安装。
Windows 8 及以上不会执行这个 Win7 依赖安装流程；本次不改变其他系统的要求。

## 机房管理员操作

1. 在赛前维护时段运行新版 Windows 安装包，完成管理员授权。
2. Win7 SP1 缺少依赖时，向导说明将安装微软组件，确认后开始。依赖随包提供，选手电脑无需联网下载。
3. 安装器先检查文件哈希与微软签名，按需安装 .NET，再安装对应系统位数的 WMF 5.1。
   进度提示期间请等待；系统更新可能耗时数分钟。
4. 如果提示需要重启，保存工作并手动重启，然后**再次运行同一个安装包**。
   本轮客户端更新尚未完成，旧客户端未被替换；不会自动重启电脑或自动进入考试。
   .NET 与 WMF 可能分别要求重启，向导会逐步检测，已完成的组件不会重复安装。
5. 环境检查通过后完成客户端安装，重新打开客户端，选择内网后台并登录 NovaJudge。
   新终端中运行 `submit version`、`printfile A.cpp n`，然后确认一次打印并检查 NovaJudge 的打印队列。

以下情况会停止更新并显示日志位置：

- Win7 没有 SP1：先由管理员安装 SP1。本安装包不包含操作系统 Service Pack。
- 安装了 WMF 3.0（KB2506143）：先按微软说明卸载该更新并重启。本安装器不会自动卸载系统更新。
- Windows 已有待完成的重启：先重启再运行安装包。
- 包缺失、哈希不匹配、微软签名不能验证、系统组件安装失败：先查看安装向导给出的日志。
  离线 Win7 若缺少可信根证书，应由管理员修复系统信任或提前准备系统环境，不关闭签名验证。

依赖引导仅负责系统组件，不安装比赛账号或签发凭据。`submit`、`printfile` 仍仅在内网模式、
有效 NovaJudge 监考登录后自动安装并绑定；公网行为不变。取消依赖准备会取消本次客户端更新。

## 发布者构建

正式 Windows 打包命令会先运行依赖准备脚本：

```sh
pnpm --filter @cwnupaa/proctor-desktop prepare:windows-prerequisites
pnpm --filter @cwnupaa/proctor-desktop dist:win
```

准备脚本仅下载/校验包，不安装系统组件。它从微软 HTTPS 地址取得 .NET 4.5.2 离线包和两种
架构的 WMF 5.1 ZIP，只提取指定的 MSU，不执行 ZIP 内脚本；ZIP 与最终文件的 SHA-256 均固定在代码中。
缓存目录为 `apps/desktop/build/windows-prerequisites/`，文件较大且不提交 Git。
NSIS 将离线文件嵌入安装包，运行时只解压本机架构所需的 WMF 包。

在联网构建机准备一次后，可以将完整缓存目录拷贝到离线构建机。PowerShell 下离线校验与打包：

```powershell
$env:PROCTOR_PREREQUISITES_OFFLINE = '1'
pnpm --filter @cwnupaa/proctor-desktop prepare:windows-prerequisites
pnpm --filter @cwnupaa/proctor-desktop dist:win
```

此变量仅控制系统依赖包下载。其他构建依赖（pnpm 包、Electron、NSIS、FFmpeg 等）仍需按原流程提前缓存。
离线依赖缺失或校验失败会阻断构建，不会生成一个遗漏依赖的新安装包。直接运行 electron-builder
时也须先准备资源；缺少文件会使 NSIS 编译失败。

自定义 NSIS `customInit` 在提权之后、旧客户端卸载之前运行；卸载器不执行依赖安装。
退出码 `3010` 表示系统需要重启，客户端安装/更新尚未完成。静默部署也不会自动重启，
部署系统必须处理该返回码，安排重启并再次运行安装包，不能把它视为客户端更新成功。

## 验证范围

```sh
pnpm --filter @cwnupaa/proctor-desktop test:windows-prerequisites
pnpm --filter @cwnupaa/proctor-desktop test:submit
pnpm --filter @cwnupaa/proctor-desktop typecheck
```

前置依赖测试使用隔离目录与替代安装进程，覆盖版本检测、位数选择、安装顺序、文件校验、
失败与重启退出码；NSIS 测试只编译安装器，不启动它，不修改开发电脑的系统组件。
NSIS 不在 PATH 时可用 `NSIS_MAKENSIS` 指定编译器。

自动化验证不能替代 Win7 真机验收。发布前分别在 Win7 SP1 x86/x64 干净镜像和已有旧版客户端的镜像上，
验证缺 .NET、已有 .NET、已有 WMF 5.1、待重启、安装失败、取消更新、离线签名验证，以及重启后
重新安装、内网监考登录、submit 和 printfile 全流程。验证时保留旧安装和日志用于核对。

微软来源：[WMF 5.1 安装包](https://www.microsoft.com/en-us/download/details.aspx?id=54616)、
[WMF 5.1 升级要求](https://devblogs.microsoft.com/powershell/windows-management-framework-wmf-5-1-released/)、
[.NET 4.5.2 离线包](https://dotnet.microsoft.com/en-us/download/dotnet-framework/net452)。
