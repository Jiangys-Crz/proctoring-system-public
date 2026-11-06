# 内网 macOS / Windows 的 submit 和 printfile

监考客户端成功登录 NovaJudge 后，自动准备全局 `submit`、`printfile` 命令并绑定当前比赛队伍。
考生打开新终端，在代码目录运行 `submit A.cpp`，核对文件、网站、比赛、队伍、题号和语言后输入 `y` 提交。
提交记录使用比赛中的显示编号。无需再次在浏览器登录，也无需安装 Node.js、Python 或 Homebrew。

此功能同时要求：

- 运行系统为 macOS 或 Windows（Windows PowerShell 5.1 及以上）。
- 运行时版本服务实际选择的 `releaseChannel` 为 `intranet`。
- 当前考试的后台地址与版本服务选定的后台地址完全一致。
- NovaJudge 登录属于当前考试范围，且返回监考专用凭据。

统一安装包也遵循运行时选择结果。公网、Linux 和尚未选定后台的开发运行都不会安装命令或签发提交授权。
如果本机上次在内网运行时异常退出，下次启动会清理并撤销该客户端遗留的授权；普通网页绑定的配置不受此清理影响。

安装脚本和原生命令随 Mac / Windows 安装包放在 `resources/novajudge-submit`，macOS 通过安装器的 `--source` 参数安装，
不需要从互联网或 NovaJudge 下载脚本。仅签发和撤销授权需要连接当前比赛的 NovaJudge 服务。
内置命令版本为 `2026.11.05.2`。代码提交和打印均支持 `-y` / `--yes` 自动确认，
参数可放在文件名前后；仍会展示比赛、文件、队伍等信息。不加该参数时需在终端输入 `y`。
运行 `submit --help` 或 `printfile --help` 查看各自的选项、语言识别、授权条件和限制；
运行 `submit version` 可核对已安装的脚本版本。

Windows 主进程通过隐藏窗口的 `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass`
调用内置 `install-windows.ps1 -Url <网站> -SourceDir <资源目录>`，参数分别传递，不经过命令字符串拼接。
安装器将命令安装到当前用户的 `%LOCALAPPDATA%\NovaJudge\submit` 并更新用户 PATH。
命令入口为 `submit.cmd` / `submit.bat`，实际脚本命名为 `novajudge-submit.ps1`，
避免 PowerShell 优先选中同名 PS1 导致执行策略阻断命令入口。新开终端即可使用。

监考程序在 Windows 上需要管理员权限；同一账号的 UAC 提升可以正常使用。
如果用另一个管理员账号完成授权，准备阶段会拒绝把凭据写入错误的用户目录，并提示使用同一 Windows 账号。
系统须安装 Windows PowerShell 5.1。新版 Windows 安装向导会在替换旧客户端前，按需离线准备
Win7 SP1 的 .NET 和 WMF 5.1；如提示重启，重启后须重新运行安装包。详见
[Windows 7 环境准备](WINDOWS7_PREREQUISITES.md)。

`printfile [-y|--yes] <文件名> [y/N]` 显示文件名、大小、语言、比赛及队伍，不输出源码正文；确认后将文件发送到
NovaJudge 打印队列。只接受 `.cpp`、`.c`、`.cc`、`.cxx`、`.java`、`.py`，
且服务端独立核验监考设备授权，普通网页绑定不能使用。回车或 `n` 取消，末尾可显式指定 `y` 或 `n`。
该命令与 submit 共用监考授权，退出/切换账号后的清理同时生效。
大小按实际发送源码的 UTF-8 字节数计算，不包含开头的 BOM。
Windows 的文件检查和读取均使用 PowerShell 解析后的绝对路径，避免切换目录后读错文件或在预览前退出。

```text
submit -y A.cpp
submit --problem A "source file.cpp" --yes
printfile -y "source file.cpp"
printfile --help
```

提交预览依次显示 `contest`、`filename`、`team`、`problem`、`language`、`url`；
打印预览依次显示 `contest`、`filename`、`team`、`language`、`size`。

授权文件为 `~/.novajudge-submit.json`（Windows 为 `%USERPROFILE%\.novajudge-submit.json`），原子写入。
macOS 权限为 `0600`；Windows 临时文件先关闭 ACL 继承，仅授予当前用户 SID 权限，再写入令牌并原子替换。
文件只保存用途受限的 `njcli_` 提交令牌和比赛、队伍信息，不保存监考 JWT、监考访问密钥或私有赛令牌。
所有授权请求固定在已校验的 NovaJudge origin，拒绝重定向，并使用操作系统信任的证书。

结束考试、注销、切换考试或后台、关闭客户端时，会清除本次持有的本地授权，并尝试撤销服务端令牌。
离线时本地清理仍执行。清理会核对所有者和令牌，不会删除后来通过网页或另一客户端绑定的新配置。
监考失效后，`submit` 会提示回到监考客户端重新登录。

比赛窗口顶部显示准备状态；失败时网页比赛仍可使用，可点击“重新准备 submit”重试。
如果 `~/.local/bin/submit` 已被其他程序占用，安装器会保留原程序并报告失败。

## 开发验证

在仓库根目录执行：

```sh
pnpm --filter @cwnupaa/proctor-desktop build
node --test apps/desktop/tests/novajudge-submit.test.cjs
```

测试覆盖实际内外网选择、平台和身份限制、授权失败、登出和安装期间切换的竞态、
配置归属、异常退出后的清理、退出时等待撤销，以及使用系统自带工具离线安装。
Windows 还验证中文空格用户路径、ACL、错误用户目录保护。安装测试使用临时用户目录，
不修改开发者的终端配置或真实用户 PATH。Windows 开发机也可在 `apps/desktop` 执行
`npm run typecheck` 和 `npm run test:submit`。

NovaJudge 项目包含真实 HTTP 联调脚本：在该项目设置 `PROCTORING_DESKTOP_ROOT` 为本仓库绝对路径，
运行 `npm run test:submit-windows:integration`。它直接加载这里的 `NovaJudgeSubmit`，
以隔离目录调用真实离线安装、真实监考授权接口及实际 submit 提交，检查 AC 和 reset/切公网撤销。
管理器的 `windowsInstallation` 依赖注入仅用于隔离测试；正式 `main.ts` 不设置该项。

更新原生脚本时，同步 NovaJudge 仓库的 `tools/contestant-cli/submit-macos` 和 `install-macos.sh`；
Windows 同步 `install-windows.ps1`、`submit.ps1`、`submit.cmd` 和 `submit.bat` 四个文件。
保留离线安装参数支持后重新构建安装包。
生产使用需要重新打包并发布监考客户端；修改源码或只更新 NovaJudge 服务不会更新已经安装的监考应用。
本次实现未生成或发布 DMG / Windows 安装包；已安装的旧版客户端需要升级新构建才会启用此功能。
