# 桌面进程信任配置

客户端按真实可执行文件、规范路径和平台签名判断进程，改文件名、命令参数或自建带 `code` / `idea` / `system` 的目录不会获得信任。无法读取路径、文件不存在、签名检测失败或不认识的程序会进入异常进程上报；不会因检测失败直接放行。

Windows 系统程序需在真实 Windows 系统目录中，Authenticode 状态为 `Valid`，证书 `O`、`CN` 精确属于 Microsoft。VS Code 与 JetBrains IDE 需安装在 `C:\Program Files` 或 `C:\Program Files (x86)`，保留准确程序名和发行者证书。用户目录安装、Dev-C++、自编译工具及其他 IDE 由管理员固定具体文件哈希，不能在考试中由考生自行批准。

macOS 系统程序须 root 拥有且不允许组或其他用户写入，位于受信系统目录，并通过 `codesign --verify --strict -R='anchor apple'`。仅有 Apple 字样或 `com.apple` 标识不足以通过；未签名守护程序或检测失败仍上报。正常 Apple 签名系统文件包括 SSV 内的程序均按上述规则验证，不通过检测时不假设 SSV 自动放行。

macOS VS Code 和 JetBrains 程序需在 `/Applications`，Apple generic 证书锚链验证成功，TeamIdentifier 精确为 Microsoft `UBF8T346G9` 或 JetBrains `2ZEFAR8TH3`，并匹配相应产品 Identifier。Eclipse 的未知签名团队和其他工具需固定哈希。客户端自身只放行准确的已安装二进制与 Electron helper 路径，不按整个 `Frameworks` 目录放行。

Linux 从 `/proc/<pid>/exe` 读取真实可执行文件。仅少量准确命名、root 拥有、无组/其他用户写权限的系统程序在系统目录放行；Linux IDE 和其他工具均使用管理员固定的 SHA-256 清单。

## 自定义工具清单

在打包前编辑 `src/renderer/process-policy.json`。`version` 为清单格式版本，`executables` 的键为实际可执行文件的完整规范路径，值为所批准版本文件的 64 位 SHA-256。程序升级后重新审核并更新哈希；相同名称的新文件、不同路径或其他版本都不会匹配。

例如 Linux 可以使用以下结构（示例哈希须替换为实际已审核文件的 SHA-256）：

```json
{
  "version": 1,
  "executables": {
    "/opt/exam-ide/bin/ide": "<已审核文件的64位SHA-256>"
  }
}
```

可使用 `sha256sum /opt/exam-ide/bin/ide`（Linux）、`shasum -a 256 /Applications/批准的工具.app/Contents/MacOS/工具`（macOS），或 PowerShell `Get-FileHash -Algorithm SHA256 -LiteralPath 'C:\批准的工具\工具.exe'`（Windows）计算。应从官方发布包或管理员审核的版本采集，不从考生提供的程序自动学习信任。

`pnpm build` 会将清单复制到 `dist/renderer/process-policy.json`，客户端打包会收入 `app.asar`。清单应在管理员掌握的安装包中发布，普通考生不得修改安装目录或拥有系统管理员权限。拥有管理员/root 权限的人可以修改客户端、系统或签名信任库；进程检测无法为这种已控制终端提供完整性保证。

Windows FFmpeg 准备脚本 `scripts/prepare-win-ffmpeg.mjs` 对下载和已存在的 x64/ia32 文件均校验固定 SHA-256，校验失败立即中止。大体积生成的 `ffmpeg.exe` 不加入源码仓库，安装包由构建流程收入。
