# 在已有 NovaJudge 比赛中验证真实提交

`scripts/reaction-novajudge-manual-submit.mjs` 使用 NovaJudge 网页原有的 `loginContestUser` 与 `submitCode` Server Actions 发出 HTTP 请求。该方式适用于本机已有比赛，无需切换全局 CLI 比赛，也不会给测试队伍增加 `PROCTORING` 绑定。

脚本读取指定 NovaJudge 源码目录的 `.env` 连接数据库，只读查询提交结果；登录、提交、排队和判题均通过正在运行的 NovaJudge 服务完成。数据库中必须已经存在专用测试比赛、TEAM 账号和测试题。脚本不会创建或修改这些对象，不修改比赛时间，不重置账号，不自动重试提交。

## 私有配置

将配置保存在 NovaJudge Git 忽略的 `.local` 目录，勿提交密码、API Key 或此文件。必填字段如下，值应来自已授权的测试账号及合法 CCS 管理员：

- `novaBase`：本机 NovaJudge HTTP 地址。
- `contestId`：测试比赛 ID。
- `userId`、`teamUsername`、`teamPassword`：测试队伍的准确数据库 ID、用户名和密码。
- `problemId`、`problemLetter`：该比赛中测试题的准确 ID 和展示字母。
- `ccsBasic.username`、`ccsBasic.password`：当前 NovaJudge CCS API 支持的合法 Basic 凭据。
- 可选 `expectedDatabase`：预期数据库名，可防止配置选错库。
- 可选 `language`：默认 `cpp`。
- 可选 `acSource`、`waSource`：相对配置文件目录的源码路径，默认 `ac.cpp`、`wa.cpp`。

AC/WA 源码必须与该测试题匹配。脚本会添加唯一注释来精确定位本次实际提交。

## PowerShell 调用

```powershell
$novaRoot = 'D:\path\to\NovaJudge'
$fixture = 'D:\path\to\NovaJudge\.local\reaction-test\handoff.private.json'
node .\scripts\reaction-novajudge-manual-submit.mjs --nova-root $novaRoot --fixture $fixture --mode check
# 先确认 Reaction 已开启、两路视频已建立且缓存充足，再分别执行：
node .\scripts\reaction-novajudge-manual-submit.mjs --nova-root $novaRoot --fixture $fixture --mode AC
node .\scripts\reaction-novajudge-manual-submit.mjs --nova-root $novaRoot --fixture $fixture --mode WA
```

`check` 会执行正常比赛登录，更新该测试账号的最近登录时间，但不提交代码。AC/WA 模式只在比赛配置的时间范围内提交一次，监听真实 CCS Event Feed，并等待原 Worker 的最终判题。默认使用 Next 开发服务 manifest；运行生产构建时明确传入 `--runtime production`。

可用 `--report-dir <目录>` 指定公开报告目录；否则写入私有配置旁。报告包含 Submission UUID、判题结果、CCS 事件观测时间及原 CLI 配置未变、未启用 proctor-only 的检查，不含密码或会话 Cookie。只有判题符合预期且两个 CCS 事件均已观测到，才报告 PASS。判题超时、缺少事件或出现视频问题时，不能将本脚本的提交结果代替完整录像验收；录像仍须由 Reaction 端单独核验。

脚本从 NovaJudge 的 `node_modules` 加载 `pg` 和 Next 的协议编码器，因此不需要给监考仓库重复安装这些依赖。两套服务须使用同一份 NovaJudge 源码和数据库配置。

## 已有比赛的两个终端全流程

`scripts/reaction-manual-e2e.ps1` 将上述真实 AC/WA 提交与 `tests/reaction-existing-verify.ts` 串联：等待 Camera/Desktop 完整截取、排队调用官方生成器、授权下载、FFprobe 和完整解码检查、1080×1920 与两路时长检查、管理页实际播放。它不启停服务，不创建比赛，不改变比赛配置，也不会另开媒体源。

先用现有启动命令启动 NovaJudge Web/Worker、监考后台和 Recorder，并在两个后台配置好同一场比赛、准确考号及 Reaction。以下流程使用标有 SIMULATED 的媒体，经合法 MediaMTX/WHEP 和现有上传通道验证；它不代表完成真实摄像头/桌面客户端验收。

终端 1（监考仓库根目录）：

```powershell
.\scripts\reaction-media.ps1 -ExamId '<已有监考考试ID>' -ExamNumber '<与NovaJudge相同的队伍用户名>' -Mode run
```

保持终端运行。除 READY 外，还需要缓存曾清理过期片段且两路缓存覆盖配置窗口；默认 60 秒缓存一般先等待约 80 秒。已有真实客户端或模拟发布器时，不要重复启动。

终端 2（监考仓库根目录）：

```powershell
$options = @{
  ExamId = '<已有监考考试ID>'
  NovaJudgeRoot = 'D:\path\to\NovaJudge'
  PrivateFixturePath = 'D:\path\to\NovaJudge\.local\reaction-test\handoff.private.json'
  OutputDirectory = 'D:\path\to\reaction-results'
  # 如未使用默认本机管理员fixture，指定现有私有文件：
  # AdminFixturePath = 'D:\path\to\proctor-admin.private.json'
}
.\scripts\reaction-manual-e2e.ps1 @options -CheckOnly
.\scripts\reaction-manual-e2e.ps1 @options
```

`CheckOnly` 验证正在运行的媒体、原考试/比赛/队伍绑定、两路 WHEP、过期缓存删除、当前窗口、Recorder/CCS 连接与普通队伍登录，不发起提交或视频合成。媒体缺失或 STOPPED 时会明确输出启动命令；已有源尚在预热时应继续等待，不能重复开启发布器。

完整模式依次提交一次 AC 和一次 WA，使用提交工具 stdout 中的实际 Submission UUID 调用录像验收。报告包含 `manual-e2e.json`、每次真实提交报告、`verification.json`，每条 Submission 目录包含 `camera.mp4`、`desktop.mp4`、`reaction.mp4`、`metadata.json` 和 `ffprobe.json`。失败时不自动重试提交，也不自动停止用户服务或媒体，便于检查现场。

新建隔离环境的全流程使用 `scripts/reaction-e2e.ps1 -NovaJudgeRoot <测试checkout> -NovaJudgeRuntimeEnv <私有测试env> -Mode full`，前提与配置见 [隔离测试说明](reaction-testing.md)。已有比赛使用上面的显式考试/队伍流程。
