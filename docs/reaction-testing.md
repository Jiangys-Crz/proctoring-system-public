# Reaction 隔离验收

模块单测、隔离集成测试和真实端到端验收是三个不同层次。不要把构造 CCS 事件或单独生成 MP4 的通过结果当作真实提交、摄像头和客户端验收。

## 通用环境

- 使用独立 NovaJudge **测试 checkout**，安装依赖时先用 `npm ci --ignore-scripts`，避免其默认 postinstall 访问不正确的数据库。
- 预先准备本机专用 PostgreSQL 测试数据库，名称为 `reaction_e2e_<自定义后缀>`。数据库可以复用，但不能包含正式比赛。
- 为测试准备独立 Redis 实例或非零逻辑数据库（URL必须显式写 `/1` 等编号）、可运行的 go-judge，并选择空闲的 NovaJudge HTTP 端口。脚本不创建数据库、不启动/删除容器，也不推断本机原有服务名称。
- 按监考仓库 README 部署 MySQL、MediaMTX 和 Web；监考测试数据库同样使用 `reaction_e2e_<后缀>`。设置实际媒体发布/读取配置，确认 Web、Recorder 与存储互通。
- 安装官方 Reaction Generator、FFmpeg、FFprobe，并设置 `REACTION_CHROME_PATH` 指向已安装的 Chrome/Chromium。Windows常见安装路径可作为默认回退；其他环境请显式设置。
- 所有示例路径、端口、账号均为占位或测试配置。私有环境文件、fixture、录像和验收输出不得提交 Git。

## 准备 NovaJudge 私有运行配置

创建一个 Git 忽略的私有文件，例如测试 checkout 下的 `.env.reaction-test`。填写自己的连接信息与随机凭据：

```dotenv
REACTION_TEST_RUNTIME=1
DATABASE_URL="postgresql://TEST_USER:TEST_PASSWORD@127.0.0.1:55432/reaction_e2e_local"
REDIS_URL="redis://127.0.0.1:56379/1"
GO_JUDGE_API="http://127.0.0.1:55050"
NOVAJUDGE_URL="http://127.0.0.1:3101"
JWT_SECRET="REPLACE_ME_WITH_AT_LEAST_32_RANDOM_CHARACTERS"
SUPER_ADMIN_USERNAME="reaction-e2e-admin"
SUPER_ADMIN_PASSWORD="REPLACE_ME_WITH_AT_LEAST_16_RANDOM_CHARACTERS"
REACTION_E2E_TEAM="team007"
```

用安全随机值替换占位凭据。配置校验会拒绝占位值、非本机地址、非 `reaction_e2e_*` 数据库及已有但内容不一致的 runtime。该文件只用于隔离测试，不能填写正式账号。`REACTION_E2E_TEAM` 可自定义，监考考号会直接复用它。

在监考仓库根目录运行（替换实际路径）：

```powershell
$novaRoot = 'D:\test-checkouts\NovaJudge'
$runtimeEnv = Join-Path $novaRoot '.env.reaction-test'
.\scripts\reaction-novajudge-setup.ps1 -NovaJudgeRoot $novaRoot -RuntimeEnvFile $runtimeEnv
```

脚本把模板复制到测试 checkout 的 `.local/reaction-e2e`，生成私有 `runtime.env`，只对指定测试库执行 schema 初始化，创建或复用测试比赛、队伍、A+B题，并启动该测试 Web/Worker。已占用端口若不属于本测试进程则直接停止操作，不终止其他进程。默认创建的测试账号密码、API Key 只保存在私有 `fixture.private.json`。

## 启动监考服务并运行端到端测试

在监考 `apps/web/.env` 配置独立 MySQL、MediaMTX、存储、生成器，并让以下三项与上面的 NovaJudge 测试配置相同：

```dotenv
REACTION_CCS_ORIGIN="http://127.0.0.1:3101"
REACTION_CCS_USERNAME="reaction-e2e-admin"
REACTION_CCS_PASSWORD="同一份私有测试密码"
```

按仓库方式初始化监考测试 schema。启动 Web，再在独立终端启动 Recorder；修改 `.env` 后两个进程都需要重启：

```powershell
# 监考仓库根目录：
pnpm --filter @cwnupaa/proctor-web dev
# 另一个终端，apps/web目录：
node --env-file=.env --import tsx scripts/reaction-recorder.ts
```

在仓库根目录运行：

```powershell
.\scripts\reaction-e2e.ps1 -NovaJudgeRoot $novaRoot -NovaJudgeRuntimeEnv $runtimeEnv -Mode full -OutputDirectory .\.local\reaction-results
# 连续提交、重连与断流等边界场景：
.\scripts\reaction-e2e.ps1 -NovaJudgeRoot $novaRoot -NovaJudgeRuntimeEnv $runtimeEnv -Mode edge -OutputDirectory .\.local\reaction-edge-results
```

`fixture` 模式仅准备监考测试记录，`publish` 模式维持模拟媒体；完整模式使用真实 NovaJudge 提交/Worker/CCS，并验证两路合法 MediaMTX/WHEP、片段上传、60秒缓存、截取、生成器和后台播放。报告中的媒体类型明确为模拟，不证明物理摄像头或桌面客户端已验收。完整物理客户端验收还需要按 [使用说明](reactions.md) 登录更新后的桌面客户端，再执行实际提交。

E2E 账号、考试和报告目录均由 fixture 确定，不依赖某个历史比赛编号或已有个人账号。重新运行复用匹配的测试 fixture；不要手改 fixture 使其指向正式记录。

## 模块和集成测试

```powershell
# apps/web目录，无服务依赖的模块测试：
node --import tsx --test tests/reaction-domain.test.ts tests/reaction-frame-timing.test.ts tests/reaction-camera-source.test.ts tests/reaction-team-name.test.ts tests/reaction-export.test.ts tests/reaction-export-s3.test.ts
node node_modules/typescript/bin/tsc --noEmit
```

`reaction-state-integration.ts` 仅使用构造事件与标记文件，清理本次创建的记录；`reaction-frame-capture-integration.ts`、`reaction-partial-generation-integration.ts` 和 `reaction-desktop-only-integration.ts` 使用生成的视频验证截取/合成。它们需要各自注释中的本地测试数据库或生成器环境，不能作为真实判题通过证据。

`reaction-admin-integration.ts`、`reaction-export-integration.ts` 的管理员凭据通过环境变量或私有 fixture 显式提供。外观与系统徽章集成测试会创建隔离记录；`reaction-branding-integration.ts` 还会短暂保存/恢复全局设置，要求独立测试库、明确的 `REACTION_BRANDING_TEST_MUTATE_GLOBAL=1` 及无并发人工修改。不要把集成脚本混入无环境隔离的自动测试通配符。

## UUID 导出

Reaction沿用NovaJudge现有CCS Submission UUID，列表、单个成片下载和ZIP文件均使用该UUID，不依赖比赛内序号或额外响应字段，无需NovaJudge配套修改。导出格式及预检契约见 [UUID与导出](reaction-export.md)。
