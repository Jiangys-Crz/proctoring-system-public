# Proctoring System

开源的算法竞赛线上监考平台，包含管理后台、考生网页、Windows/macOS 桌面客户端、原生移动端和 HydroOJ 评测桥接插件。


本仓库是独立的公开源码版本，采用 [GNU AGPL v3](LICENSE)（`AGPL-3.0-only`）。第三方组件保留各自的许可证，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

首次部署请先阅读 [开源版本配置说明](OPEN_SOURCE.md)。文档和客户端中的 `example.org`、`example.test` 及局域网 IP 均为示例；请替换为自己的服务地址、密钥、AppID 和签名配置。仓库不提供现成的公网服务或安装包。


从不含 Reaction 的旧版升级，或在新服务器启用 NovaJudge Reaction，请按下方 [Reaction 完整升级流程](#novajudge-reaction-自动录像与-ccs-授权) 完成数据库迁移、生成器安装、环境配置和独立 Recorder 部署。后台没有 CCS 账号密码输入框。

## 项目结构

- `apps/web`：Next.js 全栈网页端与服务器 API，数据库使用 MySQL + Prisma。
- `apps/client-web`：独立考生网页端（默认端口 `4032`），完整替代微信小程序并通过 WHIP 推送第二机位视频。
- `apps/desktop`：Windows/macOS 桌面监考客户端，基于 Electron 22，兼容 Windows 7 到 Windows 11。
- `apps/miniprogram`：原微信小程序实现，保留用于兼容；新部署优先使用 `apps/client-web`。
- `hydro-plugin/cwnupaa-proctor-auth`：独立 HydroOJ 自动登录插件源码；不会自动修改旁边的 `Hydro-master` 工作区。
- `packages/shared`：三端共享枚举、类型和校验 schema。

Windows 安装/更新向导会检查 Win7 SP1 的 PowerShell 5.1 环境，按需安装随包的微软离线组件。
需要重启时保留旧客户端并提示重启后重新运行安装包；赛前操作流程与构建说明见
[Windows 7 环境准备](apps/desktop/WINDOWS7_PREREQUISITES.md)。

### 独立比赛网页与 Hydro 对接

桌面端加载本项目的 `/contest` 页面。考试、学生身份、提交权限和成绩保存在监考平台；Hydro 只提供题库和 Judger。监考后台使用 API-Key 调用插件，不需要 Hydro 登录账号、密码、签名密钥或考试归属匹配，浏览器不会拿到密钥。

后台「系统设置 → 评测服务设置」填写 Hydro 主地址、API-Key 与题库域；Hydro「系统设置 → 考试监考平台」只需同一 API-Key 和题库域（默认 `Problems`）。部署时覆盖当前启用的 `hydro-plugin/cwnupaa-proctor-auth` 插件目录并重启 Hydro。

后台试运行、公开测试与正式答题使用 Hydro 返回的真实语言编号，完整显示可用语言族及版本，并遵守题目/考试限制。详见 [插件部署说明](hydro-plugin/cwnupaa-proctor-auth/README.md)。旧 Hydro 比赛页和签名登录票据仅作为兼容接口保留。

桌面端 `apps/desktop/src/renderer/config.js` 的 `PROCTOR_CLIENT_WEB_URL` 填写学生网页地址，如 `https://proctorstu.example.org`。

当前没有真实 Hydro API 时，可在 `apps/client-web` 启动开发服务后使用以下地址预览完整比赛流程：

```text
/contest?mock=1                         # 开赛前倒计时、规则与参考文件
/contest?mock=1&phase=running&rule=ioi # IOI：显示分数与测试点
/contest?mock=1&phase=running&rule=oi  # OI：只显示“已提交”
/contest?mock=1&phase=running&rule=acm # ACM：只显示最终状态
```

Mock 模式只在开发环境默认允许；生产构建需要显式设置 `NEXT_PUBLIC_PROCTOR_CONTEST_MOCK=1`，且不会连接或伪造真实 Hydro 数据。接入真实 Hydro 后不要开启此配置。

### 直播 API

系统设置中的「直播 API Key 管理」可生成多个独立命名、启停的直播密钥。使用 `/api/{10位考试编号}/{考号}/{1|2|3}/apikey={直播API_KEY}` 读取现有三个机位的 HLS 流；机位依次为电脑屏幕、电脑前置摄像头、第二机位。播放列表和每个视频分片均鉴权，不需要更改客户端推流配置。详细使用方法见 [直播流使用说明](docs/直播流使用说明.md)。

### NovaJudge 监考考试

发布考试时选择「NovaJudge（监考与浏览器）」，填写比赛名称、开始时间、时长、比赛管理员、NovaJudge 平台域名、比赛 ID 和外榜 API Key。此类型无需配置 Hydro 或选择本平台题目。个人赛、团队账号、考室审核方式、手机第二机位、电脑摄像头及录像要求沿用监考平台设置。

先在 NovaJudge 的对应比赛建立选手账号，再把同一考号（NovaJudge username）和密码导入监考平台；账号必须为该比赛的 TEAM 选手。两边开始、结束时间应保持一致。考生完成监考登录、审核及确认开考后，服务端调用 NovaJudge 现有 `/api/cli/login`，桌面客户端将 `user_token` 安装为平台域名下的 HttpOnly Cookie，直接进入 `/contest/{比赛ID}`。答题界面只有浏览器工具栏、考试计时及监考状态，不显示本平台答题侧栏。题目、提交、判题、答疑、打印和榜单由 NovaJudge 处理；屏幕与摄像头推流、异常检测、锁定/解锁、第二机位、控屏、考室和考生管理继续使用本平台。

NovaJudge 登录状态包含 `loginSource: PROCTORING`，并为该比赛账号生成随机访问凭据。凭据在桌面客户端主进程内保存，仅向 NovaJudge 平台域名注入请求头；NovaJudge 同时验证 JWT、数据库绑定及请求头。监考登录后，普通网页账号密码登录、IP 自动登录、旧浏览器 Cookie 和复制到浏览器的监考 Cookie 都无法访问；重新监考登录会使之前的绑定失效。账号保持监考专用，退出客户端不会恢复普通浏览器登录。

浏览器页面限定于所选比赛，所有网络资源必须来自配置的 NovaJudge **完整 origin（协议、域名、端口）**。禁止站外资源、弹窗和跳转；同平台题目附件、题解、ZIP 等下载及 Blob 下载正常支持，跨平台重定向下载会被阻止。附件应托管在该 NovaJudge 域名下。首次进入新监考会话、结束考试或切换会话时清除旧的 NovaJudge 浏览器登录信息。登录失败支持自动/手动重试，监考老师的「重新登录 NovaJudge」通过心跳通知桌面端重新获取凭据。

「NovaJudge 外榜 API Key」用于**读取 NovaJudge 数据及授权监考专用登录**，必须属于 NovaJudge 超级管理员的启用密钥（在 NovaJudge 后台创建并启用），不会发给考生。官网推送密钥、官网赛事 ID 和实时推送开关仍在「考试管理 → 外榜推送」中配置。后台读取 `/api/contests/{ID}/problems` 和 `/submissions`，转换为现有官网外榜格式，只同步监考名单内账号在本场考试时间范围内的提交，以每批最多 50 条记录同步，并保存成功推送的内容指纹；失败/部分接收会重试，重判结果会重新推送。两个平台的考号需与官网审核通过的比赛报名账号一致。

NovaJudge 当前导出的 `submit_time` 没有时区，发布页的「NovaJudge 数据时区」必须与 NovaJudge 服务的 `TZ` 一致，默认中国时间；NovaJudge 原始 Dockerfile 使用 `America/Vancouver`，使用原始镜像时选择温哥华。带时区的 ISO 提交时间会自动转换。当前 NovaJudge 提交接口按题目名称匹配编号，因此同一比赛的题目名称需唯一，否则同步会显示错误，防止推送到错误题目。

升级部署需执行 `pnpm db:push`，重新构建网页服务和桌面客户端并发布新版安装包；旧桌面客户端不能使用 NovaJudge 考试。NovaJudge 需同步升级监考登录支持及数据库两个新字段，详情见其 `docs/PROCTORING_LOGIN.md`。

内网 NovaJudge 使用私有域名和 Caddy 内部证书时，监考网页容器也必须能解析该域名并信任该服务器的 CA。按 `deployment/docker-compose.host.example.yml` 在对应服务器创建 `deployment/docker-compose.host.yml`，填写本服务器的 DNS 映射与 CA 路径；该文件不提交到仓库，`scripts/deploy-caddy.sh` 会同时加载它。每台服务器单独保留自己的 `.env` 和覆盖配置；直接执行 Compose 命令时也需带上 `-f deployment/docker-compose.host.yml`。不关闭 HTTPS 证书校验。

验证命令：`pnpm --filter @cwnupaa/proctor-web test:novajudge`；隔离 MySQL 数据库名必须为 `proctor_novajudge_qa` 才能运行 `test:novajudge:integration`；构建桌面后运行 `test:novajudge:desktop`，使用本机 HTTP 测试服务验证真实 Electron Cookie、浏览器限制、文件下载、锁定与结束清理，不采集真实监考视频。

### NovaJudge Reaction 自动录像与 CCS 授权

本节用于**已有监考服务器从不含 Reaction 的版本升级**，也可交给 AI 作为部署执行说明。Reaction 包含三个环节：CCS 接收 NovaJudge 提交和判题事件，更新后的桌面客户端上传录像片段，独立 Recorder 裁剪录像并调用官方 Python 生成器合成视频。**完整启用需要数据库、运行环境、配置和常驻进程都就绪。**

#### 1. 检查现有部署与升级数据库

部署者或 AI 先读取实际服务配置，识别宿主机运行还是 Docker、仓库目录、数据库、存储位置、服务运行账号和已有 Recorder。以下目录、域名、账号均为示例，按该服务器实际情况替换；保留现有 `.env`、数据库密码、会话密钥、管理员账号、上传文件和 Docker 卷。更新前备份数据库及上传文件，按原部署方式安排服务停止与重启，不在升级过程中重置数据库或重新初始化管理员。

使用 `package.json` 指定的 pnpm 版本和其支持的 Node 版本；当前 Docker 使用 Node 24。更新代码、安装依赖后，先检查数据库中的 `Exam.reactionEnabled`、`MediaSegment` 的 Reaction 字段以及 `Reaction*` 表：

- **旧库尚无 Reaction 结构**：检查 [增量 SQL](deployment/migrations/20261104-reactions.sql) 与实际 schema，确认没有重复字段/表后执行一次，再生成 Prisma Client。
- **已经有 Reaction 表，或已运行 `db:push` 创建了这些结构**：对比实际 schema 与 `apps/web/prisma/schema.prisma`，只应用缺失变更；不要再次执行整份增量 SQL。早期实验版升级还需阅读 [已有安装升级说明](docs/reaction-export.md#已有安装升级)。
- **全新空库**：使用项目原有初始化流程建立完整 schema；不再叠加执行这份旧库增量 SQL。

宿主机部署、且确认是尚无 Reaction 的旧库时，从仓库根目录执行：

```bash
pnpm install --frozen-lockfile
pnpm --filter @cwnupaa/proctor-web exec prisma db execute --file ../../deployment/migrations/20261104-reactions.sql --schema prisma/schema.prisma
pnpm --filter @cwnupaa/proctor-web db:generate
```

迁移使用该部署原有的 `DATABASE_URL`。这份 SQL 不是可重复执行的初始化脚本；如果升级还跨越其他功能的 schema 变更，也需审查那些差异。Docker 的 Web 启动命令已有 `db:push` / `db:seed`，应在启动新版 Web 前确定迁移顺序：已执行 SQL 的库仍可由正常启动流程检查 schema；已由 `db:push` 补齐结构的库不再执行增量 SQL。

#### 2. 安装官方视频生成器

Recorder 所在运行环境需要 **Python 3.12+、Git、FFmpeg、FFprobe 和中文字体**。Python 包安装在独立虚拟环境内；不要只在另一台机器或宿主机安装，而让实际 Recorder 容器缺少这些依赖。

Linux 示例：先通过该发行版的包管理器准备上述工具及 Python venv 支持，中文字体可安装 Noto CJK。以下假设使用可写的 `/opt/reaction-runtime` 目录进行首次安装：

```bash
mkdir -p /opt/reaction-runtime
git clone https://github.com/icpc/reactions-generator.git /opt/reaction-runtime/reactions-generator
git -C /opt/reaction-runtime/reactions-generator checkout --detach 59fd21d50e8bf4c69bd6e4b5c19a60726f30a20b
python3.12 -m venv /opt/reaction-runtime/venv
/opt/reaction-runtime/venv/bin/python -m pip install /opt/reaction-runtime/reactions-generator typed-ffmpeg==3.11 typer==0.20.1
```

这是仓库指定的已验证上游版本。已有生成器目录或虚拟环境时先检查版本和本地改动，符合要求则复用；不覆盖其他用途的 Python 环境。运行服务的账号需要读取生成器、字体，并可执行虚拟环境的 Python。

Windows 可从仓库根目录运行现有安装脚本；若系统有多个 Python，`-Python` 填实际的 Python 3.12+ 可执行文件路径：

```powershell
.\scripts\setup-reaction-generator.ps1 -Python python
```

脚本在仓库忽略的 `tmp/reaction-generator-runtime` 中安装，并输出 `REACTION_GENERATOR_ROOT`、`REACTION_GENERATOR_PYTHON` 两个路径，**不会自动修改 `.env`**。完整生成器说明见 [reaction-generator.md](docs/reaction-generator.md)。

#### 3. 补充服务端环境变量

**宿主机直接运行的配置入口是 `apps/web/.env`。** 新部署尚无此文件时才从 [模板](apps/web/.env.example) 创建；已有文件只补充或修改对应键，保留数据库、存储和其他配置。下例假设 Linux 仓库位于 `/srv/proctoring-system`，生成器采用上一步的安装目录：

```dotenv
# 必填：NovaJudge CCS 事件接口
REACTION_CCS_ORIGIN="https://judge.example.org"
REACTION_CCS_USERNAME="your_novajudge_super_admin"
REACTION_CCS_PASSWORD="CHANGE_ME_TO_THAT_ACCOUNT_PASSWORD"

# 生成视频必填：实际存在的生成器目录和虚拟环境 Python
REACTION_GENERATOR_ROOT="/opt/reaction-runtime/reactions-generator"
REACTION_GENERATOR_PYTHON="/opt/reaction-runtime/venv/bin/python"

# 可选：合成超时，默认 1800 秒
REACTION_GENERATOR_TIMEOUT_SECONDS=1800
# 可选：默认从 apps/web 工作目录定位；显式配置时需使用实际仓库路径
REACTION_GENERATOR_ADAPTER="/srv/proctoring-system/apps/web/scripts/reaction-generator-cli.py"

# 可选：默认从 PATH 查找；以下为 Linux 常见路径
FFMPEG_PATH="/usr/bin/ffmpeg"
FFPROBE_PATH="/usr/bin/ffprobe"

# 可选：自动查找已安装的 Noto CJK / 微软雅黑；显式设置时文件必须存在
# 以下为 Debian/Ubuntu 安装 fonts-noto-cjk 后的常见路径
REACTION_GENERATOR_FONT="/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
REACTION_GENERATOR_FONT_BOLD="/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"
```

Windows 的生成器目录和 Python 使用安装脚本输出的值，路径可写成 `D:/...`；适配脚本、FFmpeg 和 FFprobe 也改为实际 Windows 路径。中文字体可用 `C:/Windows/Fonts/msyh.ttc` 与 `C:/Windows/Fonts/msyhbd.ttc`。所有路径以 **Recorder 所在主机或容器**为准；未准备某项可选配置时可省略，让程序按默认规则查找，不能保留一个不存在的示例路径。

Python 生成器自身也通过 `PATH` 调用 `ffmpeg` 和 `ffprobe`，因此除上述路径设置外，Recorder 的运行环境中必须能直接找到这两个命令。队名/学校名含中文时，常规字体和粗体都需要中文覆盖。

CCS 使用 **NovaJudge 全局 `SUPER_ADMIN` 账号的用户名和密码**，由 Recorder 通过服务端 HTTP Basic 读取 Event Feed。监考后台管理员账号、比赛内账号、外榜或直播 API Key、浏览器登录状态都不能代替它。凭据保留在服务器，不能提交到 Git、放进 `NEXT_PUBLIC_*` 或发送给浏览器；后台**没有 CCS 账号密码输入框**。

`REACTION_CCS_ORIGIN` 必须与该考试 NovaJudge 平台地址的 origin 完全一致（协议、主机、非默认端口；不带 `/api`、路径或末尾 `/`）。同一 origin 的多场比赛默认复用这三项，无需逐比赛授予 CCS 权限。可选 `REACTION_CCS_CREDENTIALS` 按**监考考试内部 `Exam.id`** 配置完整的 `origin/username/password`，命中时优先于三项默认值；它不是10位考试编号，也不是 NovaJudge 比赛ID。

只有 `localhost`、`127.0.0.1`、`[::1]` 允许 HTTP，其他地址（包括内网 IP 和 Docker 服务名）要求有效 HTTPS。`localhost` 与 `127.0.0.1` 不互换；容器内的回环地址指容器自身。私有域名需让 Web 和 Recorder 都能解析并信任对应 CA，不关闭证书校验。逐考试覆盖的完整规则见 [CCS 授权配置说明](docs/reaction-ccs-auth.md)。

#### 4. 重启 Web 并常驻运行 Recorder

按原部署流程重新构建并重启 Web，更新考生网页及桌面客户端。宿主机可在仓库根目录运行 `pnpm build:web`、`pnpm build:client`，再由原服务管理器启动新版；桌面端需构建、发布并安装包含 Reaction 采集能力的版本。

Recorder 是独立 Node 进程。先等待旧实例退出，再从仓库根目录启动一个实例：

```bash
cd apps/web
node --env-file=.env --import tsx scripts/reaction-recorder.ts
```

正式运行应使用 systemd、现有进程管理器或独立容器守护，而不是依赖 SSH/PowerShell 窗口。配置工作目录为实际 `apps/web`，使用已安装项目依赖和生成 Prisma Client 的同一份代码，设置退出后重启。Web 和 Recorder 必须连接**同一数据库、同一套本地或 S3 存储**；本地存储要指向同一实际目录，运行账号要有读写权限，并为转码临时文件预留空间。

上述 Node 命令显式加载 `.env`，不会自动读取 Next.js 的 `.env.local` / `.env.production`；已有进程环境变量还会覆盖文件同名值。检查两个进程的有效配置一致，修改后重启实际服务。不要同时运行命令行 Recorder 与另一份守护实例；异常退出后的旧数据库租约最多约 60 秒过期。

#### 5. Docker 部署需要补齐的内容

当前基础 `docker-compose.yml` **没有 Recorder 服务，也没有自动转发 `REACTION_*` 变量**。现有 Web 镜像提供 FFmpeg 和 Noto CJK，但未安装 Python 3.12+ 虚拟环境及官方生成器。Docker 部署不能只编辑 `.env` 后重启 Web 就视为完成。

由 AI 或部署者按该服务器现有 Compose / Caddy 覆盖文件实施以下内容：

1. 将 CCS 配置通过 `environment` 或 `env_file` 显式传入 Web 和 Recorder；生成器及字体路径配置传入 Recorder。Compose 根 `.env` 默认只参与变量替换，宿主机 `apps/web/.env` 也不会自动进入容器。`environment` 的同名键优先于 `env_file`。
2. 为 Recorder 构建包含匹配版本的项目代码、Node/pnpm 依赖、Prisma Client、Python 3.12+、固定版本官方生成器、FFmpeg/FFprobe 与中文字体的镜像。Python 虚拟环境应在目标镜像中创建，不能直接搬用 Windows 或其他系统的虚拟环境。所有配置路径必须在运行容器内存在。
3. 新增独立 Recorder 服务，工作目录为 `/app/apps/web`（按镜像实际目录调整），启动命令为 `node --import tsx scripts/reaction-recorder.ts`，配置重启策略。此命令读取容器已注入的环境；只有确实挂载了环境文件时才使用 `--env-file`。
4. Recorder 接入原数据库网络，使用原来的 `DATABASE_URL` 和存储配置；本地存储挂载 **Web 正在使用的同一个上传卷**，并使用相同容器内路径和可读写的运行身份。沿用现有 Compose 项目名和覆盖文件，防止误建另一套数据库/上传卷。使用 S3 时两者须访问同一 bucket、配置及凭据。
5. 数据库迁移在能访问实际数据库、且包含迁移文件的执行环境完成。当前 Web Dockerfile 没有复制 `deployment/migrations`，不能假定该 SQL 已在容器内；可受控挂载 SQL 或通过原数据库维护方式执行。核对 schema 后，按原参数重新构建镜像并重新创建 Web / Recorder 容器。

`docker compose restart` 不会刷新容器环境，`docker compose exec web node ...` 只适合临时诊断，不是持久化 Recorder 部署。已有 Web 的 `db:push` / `db:seed` 启动行为仍需计入迁移顺序。保留所有现有卷，不执行 `down -v`、数据库 reset 或 `--accept-data-loss`。仅注入 Web CCS 配置的示例见 [Docker CCS 配置](docs/reaction-ccs-auth.md#6-docker配置必须进入实际运行进程)，该示例不代替完整生成器和 Recorder 服务。

#### 6. 检查媒体服务并验收

MediaMTX 负责直播，Reaction 使用客户端上传的录像片段；两条链路都要分别检查。媒体地址应按 Web 的运行位置配置：

| Web 运行方式 | `MEDIA_WHIP_INTERNAL_BASE` | `MEDIA_HLS_INTERNAL_BASE` | `MEDIA_API_INTERNAL_BASE` |
| --- | --- | --- | --- |
| 宿主机 Web，媒体端口映射到本机 | `http://127.0.0.1:8889` | `http://127.0.0.1:8080` | `http://127.0.0.1:9997` |
| 同一 Compose 网络，媒体服务名为 `media` | `http://media:8889` | `http://media:8080` | `http://media:9997` |

MediaMTX 的 HTTP 鉴权回调也需能访问 Web。现有 Compose 使用 `http://web:4031/api/media/auth`；宿主机 Web 配媒体容器时按部署设置可达的 `MEDIA_AUTH_HTTP_ADDRESS`（本地 Docker Desktop 常用 `http://host.docker.internal:4031/api/media/auth`）。确认 `MEDIA_WEBRTC_ADDITIONAL_HOSTS` 和实际 ICE 端口可达；直接映射方式使用 TCP/UDP `8189`，Caddy 网关方式按 [网关文档](deployment/CADDY_GATEWAY.md) 配置，不能混用。媒体私有控制和信令端口不需要向公网开放。NovaJudge 与监考服务器均应启用可靠的 NTP 时间同步。

完成部署后按顺序验证：

1. 在真实测试考试中核对 NovaJudge 平台 origin、比赛 ID、外榜 API Key；监考 `Candidate.examNumber` 必须等于对应 NovaJudge 队伍账号/CCS `team_id`，仅队名相同不够。
2. 在“考试详情 → Reaction 录像”开启本场功能，等待 Event Feed 显示 **已连接**，检查 Recorder 持续运行且没有连接错误。“凭据已配置”只表示字段齐全，不能代替实际连接验证。
3. 使用更新后的桌面客户端登录，允许所需的屏幕/摄像头采集；等待至少一个实际配置的缓存窗口（默认 60 秒），确认直播可看、两路缓存持续上传。
4. 完成一次真实 OJ 提交和判题，保持采集直到尾段及上传宽限结束，检查对应 Camera/Desktop 原始录像可播放。
5. 点击生成，确认 `generationStatus=COMPLETE`，预览和下载实际的 1080×1920 MP4；需要批量导出时再验证 ZIP。默认自动生成关闭，需在本场 Reaction 设置中单独开启；**不存在 `REACTION_ENABLED=true` 环境变量**。

开启前或关闭期间的历史提交不会补录。配置修好后，已有原始录像的失败生成任务可以在列表重试；不需要为验证生成器再次提交同一份代码。部分录像的生成规则、保留期与存储预算见 [Reaction 使用与部署](docs/reactions.md)。

| 现象或错误 | 检查位置与处理 |
| --- | --- |
| `REACTION_GENERATOR_NOT_CONFIGURED` | 实际 Recorder 进程缺少 `REACTION_GENERATOR_ROOT` 或 `REACTION_GENERATOR_PYTHON`；安装生成器、补齐环境并重启 Recorder，再重试生成。 |
| `REACTION_GENERATOR_EXECUTABLE_UNAVAILABLE` / `REACTION_GENERATOR_PROCESS_FAILED_*` | 检查 Recorder 内的 Python 路径、虚拟环境依赖、字体文件与 FFmpeg 的 `PATH`，以及该运行账号的权限；仅填写路径不会安装依赖。 |
| CCS 未连接、`CCS_HTTP_401` / `CCS_HTTP_403` | 核对实际配置的 NovaJudge 全局超级管理员凭据、精确 origin、证书信任及网络访问；同时检查逐考试覆盖是否仍使用旧值。 |
| 任务一直 `QUEUED`，或状态 `STOPPED` | 检查独立 Recorder 是否运行、数据库/存储是否一致、旧租约是否释放，以及是否加载了错误环境文件。 |
| WHIP 502，`ECONNREFUSED 127.0.0.1:8889` | Web 无法连接 MediaMTX：检查服务是否启动、端口是否被占用、映射是否正确及 Web 是否在容器内；该错误发生在媒体连接建立之前。 |
| 显示 `PARTIAL` / `MISSING`，缺少原始录像 | 检查新版客户端、缓存上传、采集权限、时间同步和窗口覆盖；CCS 已连接不代表录像片段已到达。 |

交由 AI 升级时，最终交付应列出实际修改的配置键（隐藏密码和密钥）、数据库迁移结果、Web/Recorder/MediaMTX 的启动方式、生成器版本和上述验收结果。尚未验证的环节明确列出，不能仅凭容器在运行或页面显示“已配置”就宣称完整启用。

## 完成度审计

### 比赛代码查重与屏幕控制

比赛详情与「考试管理」导航中的「代码查重」参照 `contest-code-check` 插件，使用相同的语法解析和变量归一化规则。可以选择题目、所有提交或仅 AC 提交、查重灵敏度，查看任务进度、停止任务、筛选重复度及历史报告。每对选手保留历史版本中重复度最高的一组；对比详情保存双方原始代码、提交时间和匹配片段，原始提交变化不影响报告。分析范围仅为本地数据库保存的编程题比赛提交和本地判题状态，不查询外部评测服务的提交记录；客观题与提交答案题不参与查重。解析器和工作线程随服务部署，无需 Java 或联网下载。

考试监考详情右侧的「屏幕控制」由该考试管理员操作。先上传图片组（每组 1–30 张、单张最多 10MB、每组总计最多 80MB），然后选择一组立即推送或设置定时开始。支持 PNG、JPEG、WebP、GIF；上传后统一转换为静态图片，GIF 取首帧。可以调整组内轮播顺序，可设置截止时间或由管理员关闭展示。新展示开始时替换旧展示，结束后不恢复旧图片组；取消尚未开始的计划不会中断当前展示。正在展示或用于未来计划的组需要先关闭或取消计划才能编辑、删除。

图片组中的「添加考生信息」支持类似奖状模板的文字块编辑：添加字段或普通文字，拖动定位，调整文字框、字号、字体、颜色、加粗和对齐。个人赛可用姓名、学校、学院、组别；团队赛可用队伍名称、队伍成员、学校、学院、组别。可以逐张配置，也可勾选组内多张图片，把当前布局按相对位置应用到所选图片；未添加文字块的图片保留原图。使用「示例资料」或搜索并选择本场考生预览实际合成效果，保存全部图片后再推送。长文字自动换行、缩小到文字框内。团队成员账号模式会汇总同队姓名及学校、学院，团队统一账号模式读取导入的队伍成员名单；未填写的资料留空。

本次个性化图片由服务器依据已认证的考生会话生成，预览与推送共用相同渲染流程，现有桌面客户端无需修改或重新打包。仅需更新网页后台并运行 `pnpm db:push`，为 `ScreenControlImage` 增加可空的 `template` JSON 字段（Docker 后台启动流程自动执行）。中文渲染使用系统字体，现有 Docker 镜像已安装 Noto CJK。测试：`pnpm --filter @cwnupaa/proctor-web test:screen`；完整页面与推送验证使用 `test:screen:personalization`，仅允许本机 `proctor_screen_personalization_qa` 测试库，并通过 `SCREEN_QA_BASE` 指向使用同一测试库的后台服务。

桌面客户端从获取登录会话时开始独立同步展示状态，待审核、比赛开始前、比赛中、结束后和后续登录均可自动展示。所有显示器全屏覆盖，每张图片展示 5 秒并循环播放；应用内键鼠、关闭、导航和退出操作被拦截，结束后恢复原考试、等待或异常锁定界面。断网保持已接收的展示，已设置的截止时间仍自动生效。操作系统强制结束进程及系统安全快捷键不属于 Electron 可保证拦截的范围。

更新服务时执行 `pnpm db:push` 建立新增数据库表，并重新构建网页服务和桌面客户端。图片复用系统的本地或 S3 存储，通过管理员权限或当前桌面会话令牌读取；客户端令牌不会传入轮播页面。代码查重引擎资源位于 `apps/web/vendor/contest-code-check`，第三方许可证和原插件许可证一起保留。

当前项目已经完成主监考链路，可用于内测和小规模试监考：

- 超级管理员内置账号登录、协会管理员外部登录、退出账号。
- 考试发布、考试列表、用户管理、系统存储设置。
- 个人赛/团队赛考生导入、考室创建、监考老师绑定、权限裁剪。
- 考生网页提交登录请求：学号/考号/密码、身份照片、3–15 秒环境视频、浏览器扫描电脑端二维码。
- 网页监考端审核请求、预览身份照片和环境视频、批量通过/拒绝。
- 桌面端扫码后等待审核，审核通过后显示考生信息、考试规则、开考倒计时、确认开始考试、确认结束考试。
- 桌面端内置浏览器仅打开项目内置比赛网页；比赛网页通过监考服务端和 Hydro 插件获取题目、提交、判题结果与排行榜。
- 桌面端采集屏幕和摄像头，按 10 秒片段上传。
- 考生网页使用浏览器摄像头通过 WHIP（WebRTC-HTTP Ingest）实时推送第二机位，媒体服务同时兼容原客户端 RTMP 推流。
- 网页监考端显示考生状态格、三路画面、异常通知、历史录像、语音对话、管理员解锁、Hydro 登录重试。
- 本地 uploads 与 S3 兼容对象存储配置。
- Mac DMG 和 Windows NSIS 安装包打包。

尚未达到“最高安全控制”的生产级部分：

- Windows/macOS 目前以 Electron 主程序进行进程检测和异常告警，不会关闭本机其他软件进程。这不是内核级防护，无法保证拦截所有低层绕过。
- USB/外设控制目前通过硬件指纹变化检测并锁屏告警，不是系统驱动级禁用。生产环境建议增加签名原生 helper 服务、Windows 组策略/设备安装限制、macOS MDM 配置描述文件。
- 网络检测记录系统采集到的外部域名及来源，采集权限和工具状态会显示在权限列表；webview 保留请求范围限制。域名采集存在加密和缓存盲区，不是系统防火墙级阻断。
- 桌面端考试期间右下角持续显示监考连接状态，连接中断或心跳停滞达到 15 秒时弹窗提示并自动重连；恢复后关闭提示。点击「我已知晓」只关闭提醒，重连继续进行，考试结束或会话失效后停止。
- macOS 网络授权会检查现有 BPF 设备并为客户端预留有限的新设备，避免 FinalShell 等应用占用已授权设备后反复授权失败；仅授权当前用户，最多覆盖 256 个设备，不安装常驻服务。系统管理员验证仍需由用户完成。
- 浏览器无法真正“禁止切屏”，客户网页通过 Page Visibility API 在切后台时上报告警。正式考试需在考务规则中明确切后台即异常。
- 当前 MediaMTX 是单节点实时媒体服务。大规模考试需要做带宽容量评估，并按考场拆分媒体节点或增加转发/CDN。

结论：项目已完成可运行、可试监考、可打包安装的完整业务闭环；若要用于高风险正式考试，还需要补充原生安全控制、证书签名、公网 HTTPS、对象存储、流媒体扩展和真实 Windows/macOS 机型压测。

## 本地开发

正式考试（含灵活考试）从考试开始前 40 分钟开放考生登录；此前账号验证、第二机位材料凭据和登录请求都会被服务端拒绝。系统测试考试保持随时开放。最晚入场时间和已开始考生的个人考试截止时间仍按考试规则执行。

考生已过最晚开考时间但考试尚未结束时，监考老师可在「实时监考」的考生卡片点击「继续考试」，单独允许该考生登录并确认开始；尚未建立客户端会话的考生也可操作。已审核且仍在线的会话可直接在考试概览确认开始，无需重新登录；已结束的会话须重新登录并按原考室设置审核。授权只作用于该考生并记录监考操作日志，不修改其他考生的入场限制。已开始的考生保留第一次开始时间，统一考试仍统一结束，灵活考试的个人时长仍受考试总结束时间限制，已超过个人或考试截止时间时不能恢复。

桌面 0.1.32 将在线心跳与耗时的设备检测、告警上传分开，采集设备启动期间也保持连接；配对取回登录凭据支持响应丢失后的重试。环境检测的健康请求不依赖考试会话，自动选择后台时只显示当前后台的连接结果。手机与电脑 WebRTC 保留共同支持的 H264 参数；浏览器拒绝编码偏好时恢复默认协商，继续推流。Windows 客户端在启动前启用软件渲染兼容处理，页面异常可在登录前自动恢复一次；启动日志保存在客户端用户数据目录的 `logs/startup.log`，崩溃报告仅保存在本机。更新后需重新构建并发布桌面安装包，考生手机需刷新网页。

1. 安装依赖：

```bash
pnpm install
```

2. 启动 MySQL：

```bash
docker compose up -d mysql
```

默认本项目 MySQL 暴露到宿主机 `3307`，避免占用本机已有 `3306`。

3. 配置环境：

```bash
cp apps/web/.env.example apps/web/.env
```

至少需要修改：

```env
DATABASE_URL="mysql://cwnupaa_proctor:CHANGE_ME_DB_PASSWORD@127.0.0.1:3307/cwnupaa_proctoring"
APP_BASE_URL="http://localhost:4031"
SESSION_SECRET="replace-with-at-least-32-random-characters"
CWNUPAA_EXTERNAL_API_BASE="https://www.example.org/api"
CWNUPAA_EXTERNAL_APP_KEY="replace-with-cwnupaa-app-key"
HYDRO_PROCTOR_SHARED_SECRET="" # 仅旧登录票据使用；当前判题无需配置
HYDRO_PROCTOR_API_KEY="replace-with-a-second-random-api-key"
```

如需 NovaJudge Reaction，还须按上方 [完整升级流程](#novajudge-reaction-自动录像与-ccs-授权) 在同一文件填写 CCS 和生成器配置、安装运行依赖并单独启动 Recorder。已有旧库先按该流程检查迁移分支；下面的初始化命令面向新部署。

4. 初始化数据库：

```bash
pnpm db:generate
pnpm db:push
pnpm db:seed
```

5. 启动网页服务器：

```bash
pnpm dev:web
```

访问 `http://localhost:4031`。

6. 启动考生网页端（新终端）：

```bash
pnpm dev:client
```

访问 `http://localhost:4032`。`localhost` 可以直接使用浏览器摄像头；使用局域网 IP 给手机访问时，浏览器要求安全上下文，请运行：

```bash
pnpm dev:client:https
```

并在手机信任开发证书，或者在生产环境配置正式 HTTPS 证书。HTTP 考生网页默认连接同一主机的 `4031` 端口；独立 HTTPS 考生网页需配置 HTTPS 后台地址：

```env
NEXT_PUBLIC_PROCTOR_API_BASE="https://proctor-api.example.org"
```

开发时也可保持后台 `4031`、考生网页 `4032` 均以 HTTP 启动，再运行 `pnpm dev:mobile:proxy`。该代理在 `3443` 提供手机 HTTPS 入口，把 `/api` 请求转发到后台，其余考生页面转发到 `4032`。证书和私钥默认从 `/tmp/cwnupaa-proctor-dev-cert.pem`、`/tmp/cwnupaa-proctor-dev-key.pem` 读取，也可通过 `PROCTOR_DEV_TLS_CERT`、`PROCTOR_DEV_TLS_KEY` 指定。

桌面客户端的 `apps/desktop/src/renderer/config.js` 中，`PROCTOR_MOBILE_WEB_URL` 填手机考生页面地址，`PROCTOR_PUBLIC_API_URL` 填手机可访问的后台 API 地址。使用上述 HTTPS 代理时，两项均填 `https://服务器局域网IP:3443`；独立部署时分别填写考生网页和后台地址。开启第二机位后，重连入口显示在客户端左下角昵称上方，二维码会自动刷新，也可手动刷新。

第二机位掉线而电脑仍在线时，在手机登录表单右上角点击「断网重连」，扫描在线客户端左下角的二维码即可恢复第二机位，无需填写账号或重新提交审核材料。电脑掉线而第二机位仍在线时，用手机监考页的「断网重连」扫描电脑重新生成的登录二维码，原手机凭据保持有效，电脑经自己的配对查询取得新的登录凭据。两端均离线满两分钟时旧会话自动注销，须重新走登录流程；个人考试开始时间和计时保持不变。重连必须扫描完整二维码，不能仅凭六位配对码恢复登录。

手机第二机位默认将摄像头画面逆时针旋转 90°，以 1280×720、20 帧/秒横屏推流，网页预览使用同一处理后的画面。推流页始终按横向全屏布局显示：浏览器处于竖屏（包括锁定旋转方向）时，页面整体顺时针旋转 90°，手机逆时针横放即可正常查看。预览填满浏览器可视区域，并保持完整的 16:9 画面；状态栏位于顶部，操作栏位于底部，可点击「隐藏操作」查看画面。「旋转画面」只调整摄像头推送的画面方向，重连时保留当前页已选择的方向。

部分手机浏览器会接受 H264 编码偏好，却在设置本地视频描述时失败。第二机位遇到此类错误会关闭失败的连接，复用已授权摄像头依次尝试默认编码和 VP8；仅在本地编码协商失败时回退，网络及媒体服务错误仍按原有重连逻辑处理。推流失败显示「重新推流」，摄像头采集失败才提示重新授权。放置说明可展开查看，错误提示与操作栏分开显示，小屏操作栏可左右滚动。更新后需重新构建并部署考生网页，手机刷新页面生效。

7. 启动支持 RTMP、WHIP 和 HLS 的媒体服务：

```bash
docker compose up -d media
```

浏览器 WHIP 媒体需要 ICE 可达地址。局域网部署填写服务器局域网 IP，公网部署填写媒体公网 IP 或域名：直接部署映射 TCP/UDP `8189`；[Caddy 网关部署](deployment/CADDY_GATEWAY.md) 使用公网 TCP/UDP `443` 和配套的媒体配置。

```env
MEDIA_WEBRTC_ADDITIONAL_HOSTS="192.168.50.30"
# 本地仅运行 media 容器、后台使用 pnpm 启动时：
MEDIA_AUTH_HTTP_ADDRESS="http://host.docker.internal:4031/api/media/auth"
```

8. 启动桌面客户端（Windows/macOS 客户端，Electron）：

   编辑器推荐：**VS Code**（或 Cursor/Windsurf 等 VS Code 系 AI 编辑器）直接打开仓库根目录即可，
   TypeScript 类型检查、`.vscode/launch.json` 断点调试均已配好。

   - 普通启动（无热更新）：

   ```bash
   pnpm dev:desktop
   ```

   - **实时预览开发模式**（推荐）：

   ```bash
   pnpm dev:desktop:watch
   ```

   该模式会自动打开独立 DevTools；修改 `apps/desktop/src/renderer` 下 HTML/CSS/JS 会**自动刷新窗口**，
   修改 `src/main`、`src/preload` 的 TypeScript 会自动重新编译并**自动重启客户端**。
   也可在 VS Code 中按 `F5` 直接调试主进程（断点映射回 TS 源码）。

9. 小程序开发（仅兼容旧流程时需要）：

使用微信开发者工具导入 `apps/miniprogram`。

初始超级管理员：

- 账号：`admin`
- 生产首次部署必须设置 `BOOTSTRAP_ADMIN_PASSWORD`（至少 12 位独立密码，不接受公开默认值或示例占位符）；开发模式未配置时才使用 `LocalDemoOnly403!`。初始化完成会持久记录；后续重启或运行 seed 不会重置密码、权限或停用状态，也不会重新创建已删除账号。

## 生产服务器部署

### Caddy 统一公网入口（业务端口不对公网开放）

使用宿主机 Caddy + `caddy-l4` 时，按 [Caddy 网关部署说明](deployment/CADDY_GATEWAY.md) 操作，配套文件为 `deployment/Caddyfile.gateway`、`docker-compose.caddy.yml` 和 `.env.caddy.example`。四个域名均指向 Caddy 的公网 IP，公网仅开放 TCP `80`、TCP `443`、UDP `443`；所有数据库、网页和媒体服务的宿主机端口均绑定 `127.0.0.1`。RTMPS 地址改为 `rtmps://proctorstream.example.org:443`，WebRTC 经 `proctorrtc.example.org:443` 进入网关。公网证书由 Caddy 管理，无需配置 `MEDIA_TLS_*` 文件路径。

下面各步骤介绍原有媒体端口直接对外开放的部署方式，使用统一入口时应以网关说明为准，不要混用两套 Compose 文件。

### 1. 四个域名与端口

| 域名 | 用途 | 宿主机目标端口 | 容器端口 |
| --- | --- | --- | --- |
| `proctoring.example.org` | 后台、下载、API | `4031` | `4031` |
| `proctorstu.example.org` | `/contest` 答题页、`/` 或 `/candidate` 第二机位登录页 | `4032` | `4032` |
| `proctorstream.example.org` | RTMPS 推流（原生手机 App） | TCP `1936` | TCP `1936` |
| `proctorrtc.example.org` | WebRTC 媒体连接（桌面、手机网页、后台观看） | TCP/UDP `8189` | TCP/UDP `8189` |

DNS 记录指向服务器 IP；后台和学生网页的 HTTPS 入口分别转发到 `4031`、`4032`。RTMPS 域名和 WebRTC 域名分别直接指向媒体服务器，需允许对应的 `1936`、`8189` 网络连接，不通过普通 HTTP 反向代理。公网安全组开放 TCP `80`、TCP `443`、TCP `1936`、TCP/UDP `8189`，共 4 个端口号；`4031`、`4032` 只需供 Caddy 访问。

当前桌面客户端和手机网页使用 WHIP/WebRTC 推流。WHIP 信令经后台 `/api/client/whip` 鉴权并转发到 MediaMTX；后台观看的 WHEP、HLS 同样由后台校验权限。因此不需要公开 `8889`、`8080`、`9997`，WebRTC 域名不需要网站 HTTP 代理或单独的公网 TLS 证书。原生手机 App 使用 RTMPS，TCP `1936` 仅在使用这类客户端时必须对外开放。

学生网页的 API 地址在构建时使用 `APP_BASE_URL`，即 `https://proctoring.example.org`。跨域请求通过客户端令牌认证，WHIP 返回的资源地址可供跨域浏览器读取。安装包中的公网答题链接和扫码链接自动使用 `https://proctorstu.example.org`；内网答题链接和扫码链接使用 `https://proctorstu.example.test`，API 使用选中的 `https://proctoring.example.test`，不需要访问公网。

使用 Caddy 时，参考 `deployment/Caddyfile`：后台域名反向代理到 `127.0.0.1:4031`，学生域名代理到 `127.0.0.1:4032`。两个网站都通过公网 HTTPS `443` 访问，由 Caddy 按域名选择不同内部端口。样例还为 `proctorstream.example.org` 设置一个返回 404 的 HTTPS 站点，仅用于让 Caddy 申请并续期媒体域名证书；RTMPS 实际流量仍直连 `1936`。如已有媒体证书，可省略该证书申请站点。

如果 Caddy 运行在独立容器中，`127.0.0.1` 指向 Caddy 容器本身，应按实际网络使用宿主机地址，或加入本项目 Compose 网络后使用 `web:4031`、`client-web:4032`。标准 Caddy 的 HTTP `reverse_proxy` 不转发 RTMPS 或 WebRTC 的 TCP/UDP 媒体；当前部署让这两个端口直接到媒体容器。

后台入口保留原始 `Host` 和 `X-Forwarded-Proto`。安装包上传需允许 1 GiB 请求、关闭请求缓冲，并提供足够的上传超时；问答事件流和直播请求应关闭响应缓冲。学生入口将所有页面及 `/candidate-assets` 静态资源转发到 `4032`。

### 2. 创建根目录环境配置

仅在仓库根目录配置 Docker Compose 的 `.env`，不需要创建各应用自己的环境文件。完整模板是根目录的 `.env.example`：

本段描述基础监考容器。需要 Reaction 时，还要按照 [Reaction 完整升级流程](#novajudge-reaction-自动录像与-ccs-授权) 显式注入环境变量、安装生成器并部署独立 Recorder；Compose 的 `.env` 不会自动成为所有容器的环境变量。

```bash
cp .env.example .env
chmod 600 .env
nano .env
```

为模板中的各个 `CHANGE_ME` 分别运行 `openssl rand -hex 32` 生成独立密码或密钥。`DATABASE_URL` 中的密码必须与 `MYSQL_PASSWORD` 相同，数据库容器地址保持 `mysql:3306`。新部署还必须为 `BOOTSTRAP_ADMIN_PASSWORD` 单独生成密码；已有部署更新不需要该值，已有账号不会被重置；若仍使用旧公开默认密码，应在现有后台修改。

固定的生产地址为：

```env
PROCTOR_WEB_HOST_PORT=4031
PROCTOR_CLIENT_WEB_HOST_PORT=4032
APP_BASE_URL=https://proctoring.example.org
MEDIA_RTMPS_PUBLIC_BASE=rtmps://proctorstream.example.org:1936
MEDIA_WEBRTC_ADDITIONAL_HOSTS=proctorrtc.example.org
MEDIA_AUTH_HTTP_ADDRESS=http://web:4031/api/media/auth
MEDIA_TLS_CERT_PATH=/etc/letsencrypt/live/proctorstream.example.org/fullchain.pem
MEDIA_TLS_KEY_PATH=/etc/letsencrypt/live/proctorstream.example.org/privkey.pem
```

模板中的 `/etc/letsencrypt/` 路径仅为示例，使用 Caddy 时须改成 Caddy 实际保存或导出的宿主机证书、私钥路径，证书覆盖 `proctorstream.example.org`。Compose 将文件只读挂载到媒体容器。证书续期后重启 `media` 以加载新证书。

Hydro 实际服务地址、API-Key 与题库域在后台「系统设置 → 评测服务设置」中保存，再填写到 Hydro 插件。使用协会外部登录时配置 `CWNUPAA_EXTERNAL_APP_KEY`；内置管理员登录无需该项。保留现有部署的密码和密钥，不要在更新时重新生成数据库密码。

### 3. 启动与验证

```bash
docker compose config --quiet
docker compose up -d mysql
docker compose logs -f mysql
```

MySQL 出现 `ready for connections` 后按 Ctrl+C 退出日志查看，再启动完整服务：

```bash
docker compose up -d --build
docker compose ps -a
docker compose logs --tail=100 web client-web media
curl -f http://127.0.0.1:4031/api/health
```

后台会自动更新数据库结构、初始化管理员和系统测试考试。`uploads-init` 显示 `Exited (0)` 正常，其他服务应保持运行。初始管理员为 `admin`，使用首次启动时设置的 `BOOTSTRAP_ADMIN_PASSWORD` 登录；未配置有效密码的新部署会停止初始化。

浏览器直接访问 `/contest` 返回 403 是正常的客户端访问保护；通过已登录的桌面客户端验证答题页。手机打开 `https://proctorstu.example.org/` 验证第二机位入口，再通过真实考试或系统测试检查三路视频。

更新前备份数据库及上传文件，再执行 `git pull --ff-only` 和 `docker compose up -d --build`。数据库和上传目录保存在 Docker 命名卷中，不要执行 `docker compose down -v`。

从不含 Reaction 的版本升级时，先完成 [Reaction 数据库与运行环境检查](#novajudge-reaction-自动录像与-ccs-授权)，再执行对应部署分支的迁移与重建步骤；基础 Compose 更新命令不会自动安装或启动 Reaction 生成器和 Recorder。

桌面客户端需要重新打包并在后台发布，才能使用新的公网学生域名；原生 Android/iOS App 和微信小程序如使用，也需要重新构建或发布。网页/API 改动不会自动替换已安装的客户端。

### 已有部署升级：协会账号、永久测试账号与 Python 语言列表

先覆盖 Hydro 当前启用的监考插件目录并重启 Hydro，再更新两个网页容器。插件位置可用 `hydrooj addon list` 查看；如果不是 addon 安装方式，使用已有插件的实际安装目录。不要把仓库中的源码目录误当成 Hydro 已启用目录。

```bash
cd /srv/proctoring-system-public
git pull --ff-only
bash scripts/deploy-caddy.sh
docker compose -f docker-compose.caddy.yml logs --tail=100 web
```

只有镜像构建成功才会更新容器。若出现 `ERROR` 或 `failed to solve`，先解决构建错误；单独执行 `up --force-recreate` 会继续使用已有旧镜像，页面仍会显示旧版。

网页容器启动时自动进行数据库升级：保留旧用户 ID、权限和考室关系，增加姓名＋学号身份索引、官网登录绑定及永久测试账号表。无需重建数据库、删除卷或重新创建 `.env`。当前 Caddy、域名及媒体端口配置可继续使用。两端保留已有 API-Key 与题库域，后台点击「检测连接与配置」，然后分别提交试运行、公开测试和正式考试的 Python 3 代码。

本次评测设置页面显示版本 `2026.10.08.2`。更新后可通过下列只读检查确认实际运行服务：

```bash
curl -fsS http://127.0.0.1:4031/api/health
curl -fsS https://proctoring.example.org/api/health
```

两处都应包含 `settingsVersion: "2026.10.08.2"`。若本机地址返回新版本而公网没有，检查 Caddy 的监考域名是否仍转发到其他容器或端口。若两处都没有新版本，重新构建并强制重建 `web` 容器。更新后刷新设置页面；页面与服务版本不一致会显示明确提示。

配置检测支持新版嵌套及平铺返回格式。能够识别旧插件返回，显示需要升级 Hydro 实际启用插件目录，而不再把缺少 `authMode` 的旧格式笼统报告为“配置检测结果无效”，也不会把旧协议误报为新版判题正常。Hydro 插件 `0.2.1` 的检查返回包含版本号。

## HydroOJ 插件部署

插件源码位于：

```text
hydro-plugin/cwnupaa-proctor-auth
```

1. 将整个目录覆盖到 Hydro 当前正在启用的插件目录，重启 Hydro。仅更新监考 Docker 容器不会替换 Hydro 插件。
2. Hydro「系统设置 → 考试监考平台」保留已有 API-Key 与题库域；在监考后台填写 Hydro 主地址及同样的 API-Key、题库域。
3. 点击「检测连接与配置」验证 API-Key 和题库域。当前接口不需要签名、服务账号、密码或 UID。
4. 分别提交后台试运行、公开测试和正式考试的 Python 3 代码验证实际评测。旧记录和题库继续保留。

完整接口及升级说明见 [插件说明](hydro-plugin/cwnupaa-proctor-auth/README.md)。

## 域名变更后如何更新各端

假设新服务器域名为：

```text
https://proctor.example.org
```

### 网页端/服务器

修改 `apps/web/.env`：

```env
APP_BASE_URL="https://proctor.example.org"
NEXT_PUBLIC_MEDIA_HLS_BASE="https://media.example.org"
```

如果数据库或对象存储也变更，同步修改 `DATABASE_URL` 和系统管理中的对象存储配置。然后重新构建/重启：

```bash
pnpm --filter @cwnupaa/proctor-web build
pm2 restart cwnupaa-proctor-web
```

### 考生网页

重新构建时注入 API 地址：

```bash
NEXT_PUBLIC_PROCTOR_API_BASE="https://proctor.example.org" pnpm build:client
pnpm --filter @cwnupaa/proctor-client-web start
```

同时将 `MEDIA_WEBRTC_ADDITIONAL_HOSTS` 更新为浏览器可访问的媒体公网 IP/域名，并确保直接部署的 TCP/UDP `8189` 已映射到 MediaMTX；[Caddy 网关部署](deployment/CADDY_GATEWAY.md) 使用公网 TCP/UDP `443`，不要混用旧媒体配置。

### 桌面客户端

修改：

```text
apps/desktop/src/renderer/config.js
```

将：

```js
window.PROCTOR_DEFAULT_SERVER_URL = 'http://localhost:4031';
```

改为：

```js
window.PROCTOR_DEFAULT_SERVER_URL = 'https://proctor.example.org';
window.PROCTOR_MEDIA_HLS_BASE = 'https://media.example.org';
```

桌面屏幕/摄像头使用 HTTPS WHIP 信令和加密 WebRTC 媒体。原生手机通过 `/api/client/media-publish` 获取 RTMPS 地址及短期发布凭据。

然后重新打包：

```bash
pnpm dist:desktop:mac
pnpm dist:desktop:win
```

重新分发 `apps/desktop/release` 里的 DMG/EXE。已经安装过旧版的考生需要安装新版；客户端界面不允许考生手动修改服务器地址，只显示服务器连接状态。

### 协会管理员导入与本地登录

超级管理员在「用户管理」选择「导入协会用户」，一行一个官网真实姓名＋学号，例如 `张三+20260001`，也支持空格、制表符或逗号分隔。首次使用官网用户名或邮箱及密码登录（官网不支持学号验证），服务端验证返回的 `realName`、`numberId` 与已添加名单匹配后，同步用户名、昵称、姓名、邮箱及官网 userId，并将密码保存为 SHA-512 预摘要的 bcrypt 哈希。以后优先本地验证，不依赖官网可用；官网密码变更后使用官网用户名或邮箱验证成功可刷新本地凭据。重复导入保留角色、停用状态和本地密码。

只有已添加的管理员才能登录监考后台。登录页只填写账号和密码，真实姓名使用官网验证接口返回的资料，不接受填写姓名来选择管理员身份。官网验证及测试账号领取不会自动创建管理员；停用用户无法登录。不同姓名可以使用相同学号，重号时使用官网用户名或邮箱，由接口返回的真实姓名和学号匹配名单。旧管理员记录原 ID、考试授权及考室分配保留；原先仅录入学号的无密码名单可在首次官网验证时补齐资料。考室监考名单支持 `姓名+学号`，原有不重复学号格式仍可使用。

升级时容器启动的 `db:push` 先补齐账号字段及姓名/学号唯一索引，再移除学号全局唯一索引；不会清空用户、考试或持久化上传目录，实际 `.env` 无需修改。

### 下载、测试与使用指南

公开页面顶部统一提供「下载」「测试」「指南」导航，分别进入安装包下载主页 `/`、测试账号领取页面 `/test` 和安装使用指南 `/guide`。指南按 Windows 安装、Mac 安装与权限授权、登录测试三个章节展示，支持章节目录、手机阅读和点击图片放大查看。

指南正文保存在 `apps/web/src/content/installation-guide.md`，图片资源位于 `apps/web/public/guide/images`，图片尺寸记录位于 `apps/web/src/content/guide-images.json`。14 张截图以无损 WebP 保存，重复使用的截图沿用同一资源，图片按文档的操作说明顺序显示，不依赖原电脑上的图片路径。修改指南后重新构建后台网页即可发布。

### 题面附件下载与考生榜单导出

Markdown 和 HTML 题面的 `file://文件名`、相对附件链接及 Hydro 题目文件链接会通过当前考试的附件接口下载；考试开始前不能下载。题面与考试说明可以包含任意网站的 HTTP/HTTPS 链接：常见文件扩展名和文件下载路径进入保存流程，普通网页在独立弹窗中打开。弹窗只允许点击时的完整页面地址，同站路径、查询参数、片段变更、其他网站、重定向、内嵌网页和新窗口都不能继续浏览；页面样式、图片及动态数据可以正常加载。远程链接使用隔离会话，不携带考试登录令牌。后台文件代理仍按 Hydro 地址及 `HYDRO_FILE_ALLOWED_ORIGINS` 校验来源，任意网站链接不会通过该代理。桌面客户端为附件和榜单文件弹出保存窗口。

后台考试详情、考试说明编辑预览和监考客户端统一支持 Markdown 标题、列表、表格、代码、公式与链接。Hydro 考试优先显示管理员填写的考试说明，未填写时沿用 Hydro 的原说明。

考生端「导出榜单」保存 Excel 文件，内容与当前组别、团队/个人榜单、参赛类型、搜索和回放时间一致，包含每题公开成绩或 XCPC 状态；封榜信息按页面可见内容导出。女生队伍显示紫色女性图标徽标，打星参赛显示金色星形徽标，两种身份可同时显示并保留在导出文件中。需重新构建后台与考生网页，并重新打包安装桌面客户端。

### 公开系统测试考试

管理员在后端环境变量中设置 `PUBLIC_TEST_PROBLEM_ID`，默认 `A1`，填写 Hydro 题库中已有编程题的题号（PID，也支持数字 docId）。题库域沿用系统设置中的 Hydro 题库域。Docker 部署在根目录 `.env` 设置后重建 `web` 容器，本地部署修改后重启后端。答题页读取该题的真实题面、语言限制和判题编号；不存在或不是编程题时会显示配置错误，不再自动创建 A+B 题。此次语言修复需要覆盖 Hydro 实际启用的完整插件目录并重启 Hydro，以加载新增的 `judge-language-list.ts`；随后重新构建后台与考生网页。

下载主页的「参加系统测试考试」进入 `/test`，服务启动后自动准备长期开放的测试考试。使用协会官网用户名或邮箱及密码验证后领取永久绑定的虚构测试账号；同一官网用户更换浏览器或重复领取仍返回原账号，领取不创建监考管理员，在监考客户端选择「二维码登录」，用手机浏览器扫描与正式考试相同的登录二维码或输入配对码后填写领取的考试编号、姓名、考号和密码。测试账号支持扫码或配对码登录，不支持桌面密码登录；直接创建临时会话，不创建登录请求或进行审核。测试考试不出现在后台考试监考、登录请求或录像列表，必须连接手机第二机位。点击「开始考试」前，屏幕、电脑摄像头及手机第二机位都必须通过媒体服务器真实接收检测（画面就绪且已接收数据），每次体验计时 30 分钟，提供管理员配置的编程题。

桌面右上角和手机监考页面仅在测试考试显示「断网重连测试」，点击后撤销对应旧令牌，须扫描已登录桌面授权的会话二维码恢复。测试仍完成身份照片和环境视频采集及上传校验，后端仅在内存中解码并丢弃，不创建材料上传凭据、文件或媒体记录。测试不录制画面、不保存监考告警、语音或证据。仅保留运行所需的临时登录与提交数据，结束或超时后自动清理，永久测试账号及官网 userId 绑定保留，成绩不进入正式排行榜。已结束的永久账号可直接再次扫码登录；领取页面只需填写官网账号和密码，不提供绑定已领取旧账号的功能，也不会根据旧浏览器凭据接管匿名测试账号。领取接口有全局、浏览器凭据、登录账号和已验证 userId 的限流，永久账号创建受数据库事务锁与唯一约束保护。

推流检测使用 MediaMTX 私有控制接口：容器内 `MEDIA_API_INTERNAL_BASE=http://media:9997`，本地后端使用 `http://127.0.0.1:9997`。接口必须验证服务端签名凭据，9997 只绑定本机地址，不向公网开放。`test_` 会话路径在媒体服务中禁止录制。

面向考生的部署使用生产构建及 `start`，避免开发工具的 Issue 面板显示在网页上。页面遇到内部错误时只显示可操作的提示，详细诊断保留在服务器日志。

### 微信小程序（兼容旧流程）

修改：

```text
apps/miniprogram/config.js
```

将：

```js
module.exports = {
  serverUrl: 'http://localhost:4031'
};
```

改为：

```js
module.exports = {
  serverUrl: 'https://proctor.example.org'
};
```

然后：

1. 微信公众平台后台添加 request/uploadFile/downloadFile 合法域名：`https://proctor.example.org`。
2. 微信开发者工具导入 `apps/miniprogram`。
3. 关闭开发环境的“不校验合法域名”后真机测试。
4. 上传代码、提交审核、发布版本。

小程序扫码桌面端二维码时会校验二维码中的服务器地址是否与 `config.js` 一致；不一致会拒绝绑定，必须重新发布同一服务器地址的小程序和客户端。

## 桌面客户端打包安装

### 打包命令

```bash
pnpm dist:desktop:mac
pnpm dist:desktop:win
```

输出目录：

```text
apps/desktop/release
```

当前产物：

- macOS：`apps/desktop/release/CWNU PAA Proctor-0.1.0.dmg`
- Windows：`apps/desktop/release/CWNU PAA Proctor Setup 0.1.0.exe`
- Windows 解包版：`apps/desktop/release/win-unpacked/CWNU PAA Proctor.exe`

### 发布到网站下载入口

在本机生成安装包（`dist:desktop:mac` 对应 Intel Mac；Apple Silicon 使用 `pnpm --filter @cwnupaa/proctor-desktop dist:mac:arm64`，Windows 使用 `pnpm dist:desktop:win`）。文件位于 `apps/desktop/release/unified/`，以实际生成的版本号为准。

以超级管理员登录监考后台，进入「系统设置 → 客户端版本发布」，分别选择 Windows、Mac Intel、Mac Apple Silicon，填写与安装包一致的版本号，上传 `.exe` 或 `.dmg` 后发布。发布成功后，监考网站主页展示下载按钮。协会官网可直接链接到 `https://proctoring.example.org/` 作为统一下载入口；如需官网自己的下载按钮，复制主页对应平台的下载链接。

### macOS 安装

1. 打开 DMG。
2. 将 `CWNU PAA Proctor.app` 拖入 Applications。
3. 首次启动时授予：
   - 摄像头权限
   - 麦克风权限
   - 屏幕录制权限
   - 辅助功能权限，活动窗口检测需要
4. 如果未签名，macOS Gatekeeper 会拦截，需要右键打开或在系统设置中允许。

生产分发必须做 Developer ID 签名和 notarization。

### Windows 安装

1. 运行 `proctor-1.0.1-unified-windows-setup.exe`。
2. 安装器配置为 per-machine，需要管理员权限。客户端在创建页面前检查实际进程权限，未提权时显示“申请管理员权限”，通过 Windows 系统授权窗口重新启动；取消后可重试或关闭。已取得管理员权限的进程不会重复请求授权，账号名称（包括 `Administrator`）不作为判断依据。
3. 首次运行时允许摄像头、麦克风和屏幕采集。
4. 客户端仅检测并上报非白名单进程，不会强制关闭本机其他软件。

Windows 管理员权限直接读取客户端进程的 `TOKEN_ELEVATION`，不依赖 PowerShell、.NET、系统显示语言或 Server 服务。32 位和 64 位原生检测组件随安装包提供，只调用 Windows 7 自带的系统 DLL；检测失败与未提权分别提示，均不会绕过权限要求。源码在 `apps/desktop/native/windows-token/probe.c`。修改后安装 MinGW-w64，再在桌面客户端目录运行 `node scripts/prepare-windows-token.mjs --rebuild`；常规构建只校验已提交组件与源码哈希，支持离线打包。

客户端主程序使用 `asInvoker` 清单，避免将管理员要求施加给 Chromium 的受限子进程。提权由 `native/windows-launcher/launcher.c` 调用 `ShellExecuteExW` 的 `runas` 完成，不依赖 PowerShell；主进程重新确认管理员令牌后才载入页面。修改此组件后运行 `node scripts/prepare-windows-launcher.mjs --rebuild`。启动错误会显示本机提示，并在用户数据目录的 `logs/startup.log` 和 `logs/chromium-startup.log` 中记录诊断信息。

启动时验证通过的管理员令牌仅在当前主进程内复用，避免反复启动权限探针导致误报；未验证成功的结果不会被缓存成已授权。进程检测使用系统目录中的原生 PowerShell，32 位客户端在 64 位系统上通过 `Sysnative` 访问，使用启用现有查询权限的 `Win32_Process` 信息并保留 CIM、进程列表回退。检测失败会显示“检测失败”并保存诊断，不会将已取得的管理员权限改为“未授权”；无法验证路径的进程仍交由进程策略判定、上报，不会按名称放行。

生产分发建议做 Authenticode 签名，否则 SmartScreen 会提示风险。

## 微信小程序打包发布

1. 修改 `apps/miniprogram/project.config.json` 中的 `appid` 为正式小程序 AppID。
2. 修改 `apps/miniprogram/config.js` 为正式服务器域名。
3. 微信公众平台配置合法域名。
4. 使用微信开发者工具导入 `apps/miniprogram`。
5. 真机测试摄像头、录音、扫码、上传。
6. 上传代码并提交审核。
7. 审核通过后发布。

小程序需要的能力：

- `scope.camera`：身份照片、环境视频、第二机位。
- `scope.record`：环境视频与语音回复。
- `wx.request`：心跳、告警、语音消息。
- `wx.uploadFile`：照片、视频、语音上传。
- `wx.scanCode`：扫描桌面客户端二维码。

## 网页端用户使用说明

### 超级管理员

1. 打开网页端：`https://proctor.example.org`。
2. 使用内置账号登录：`admin` / 初始密码。
3. 进入“用户管理”：
   - 批量导入监考老师学号。
   - 监考老师用协会官网账号登录后，系统自动补齐昵称、用户名、真实姓名、邮箱。
   - 可将用户角色改为普通管理员或超级管理员。
4. 进入“考试列表”：
   - 发布考试。
   - 设置考试名称、开始时间、最晚开始时间、截止时间、总时长、Hydro 域名、比赛编号、个人/团队类型、规则、小程序/前置摄像头要求。
5. 进入考试详情的“考试设置”：
   - 创建考室并绑定监考老师。
   - 下载考生导入模板。
   - 导入个人赛或团队赛考生；模板可选填写“考室”（兼容“考室名称”），按本场考试已有考室名称自动分配。留空的新考生不分配，重复导入时留空不改动已有分配；团队整队分配，同队考室必须一致。考室不存在时整批导入回滚，请先创建考室。
   - 未填写考室的考生可以稍后在考室设置中手动分配。“添加考生”支持选择按考号或按学号添加，一行一个；学号对应多人时须改用唯一考号，团队统一账号可使用成员学号。新增、修改考生时选择已有考室会更新该考室分配。
6. 进入“考试登录信息”：
   - 查看考生登录状态。
   - 审核小程序提交的身份照片和环境视频。
   - 批量通过或拒绝，拒绝时填写原因。
7. 进入“考试监考”：
   - 查看电脑屏幕、电脑摄像头、手机第二机位。
   - 查看异常通知。
   - 确认告警。
   - 对锁定考生执行管理员解锁。
   - Hydro 自动登录失败时重新请求 Hydro 登录。
   - 结束或继续自己负责考生的考试。
   - 对选中考生录音发送，小程序端自动播放。
8. 进入“历史录像”：
   - 查看历史录制片段、身份照片、环境视频。
9. 进入“系统管理”：
   - 设置本机 uploads 或 S3 兼容对象存储。
10. 点击右上角“退出登录”退出后台。

### 普通管理员/监考老师

1. 先由超级管理员导入本人学号。
2. 使用协会官网账号登录。
3. 登录后只看到有权限的考试。
4. 进入考试后只能查看自己负责考室的考生。
5. 可审核登录请求、查看三路画面、处理告警、语音对话、解锁考生、结束或继续自己负责考生的考试、查看权限范围内历史录像。
6. 点击右上角“退出登录”退出后台。

## 考生使用说明

### 桌面客户端

1. 安装 Windows 或 macOS 客户端。
2. 打开客户端。
3. 查看服务器连接状态，生产环境应显示已连接。
4. 点击“检测系统权限”，点击未授权的卡片申请对应权限；所有权限均已授权后，检测屏幕与摄像头。
5. 点击“进入登录”，选择二维码登录，或填写考试编号、姓名、考号、密码登录。服务端根据考生所在考室的登录方式校验，不允许时提示改用另一种方式；未分配考室的考生不能登录。账号密码登录如需第二机位，会展示用于提交材料的二维码。
6. 提交成功后，客户端以悬浮窗显示“正在等待监考审核，请勿触碰显示器及电脑”。操作错误以顶部中文提示显示 5 秒，内部报错仅保留在开发日志中。
7. 审核通过后，客户端显示：
   - 姓名/学号/考号/座位号，或队伍名称/成员/考号/座位号
   - 考试名称
   - 考试规则
   - 开考倒计时
8. 到开始时间后点击“确认开始考试”，再次确认后进入计时。
9. 右侧内置浏览器自动进入 Hydro 比赛页面。
10. 考试期间不要切屏、停止采集、拔插外设或打开非允许软件。
11. 结束考试时点击“确认结束考试”，按提示输入“姓名确认结束考试”或“队伍名称确认结束考试”。

### 考生网页（推荐）

1. 用手机或带摄像头的第二设备打开 `https://proctorstu.example.org`。
2. 填写考试编号、姓名、考号和密码；学校、学院、学号和团队成员信息由后台登记数据确定，无需重复输入。姓名存在重复时联系监考老师核对报名信息。
3. 通过信息核验后，拍摄手持身份证照片。
4. 使用后置摄像头录制 3–15 秒的周围环境视频。
5. 点击“扫码登录”，扫描桌面客户端显示的配对二维码。
6. 提交登录请求并等待监考老师审核；等待期间可以取消请求。
7. 保持网页打开并将设备横屏放置，使桌面、键盘、显示器和本人侧后方同时入镜。
8. 页面会通过 WHIP 持续实时推流；网络恢复后可点击“重新推流”，也可翻转前后摄像头。
9. 考试期间不要切后台、锁屏或关闭摄像头；切后台和摄像头异常会自动上报告警。
10. 收到监考老师语音时页面自动播放；点击“语音回复”可录音并发送。

第二机位恢复时，在登录输入信息页面点击“扫码恢复第二机位”，扫描已登录电脑客户端左下角的重连二维码，直接恢复原考试会话，无需重新输入密码、拍照或录制环境视频。普通首次登录二维码和仅有 6 位配对码不能代替恢复二维码。

拍照、环境录像、扫码或第二机位推流获取摄像头失败时，页面每次都会弹出重新授权提示；点击“重新获取摄像头权限”会再次请求浏览器授权，重试失败仍会重新弹出。若浏览器已禁止摄像头或麦克风，请先在站点权限中改为允许；手机系统设置也须允许当前浏览器使用相机和麦克风。网页无法清除浏览器保存的拒绝授权决定。扫码识别成功后会先释放扫码摄像头，再重新开启第二机位摄像头。

更新手机页面时必须重新构建和重启 `client-web` 服务，仅更新后台 `web` 不会更新手机页面。使用 Caddy 部署时，在服务器项目目录执行：

```bash
git pull --ff-only
bash scripts/deploy-caddy.sh
```

浏览器摄像头、麦克风和扫码功能要求 HTTPS（`localhost` 开发地址除外）。建议使用最新版 Chrome、Edge 或 Safari，并关闭浏览器省电模式，避免锁屏后暂停摄像头。

### 安全部署与会话规则

- 原生手机媒体只使用 RTMPS（直接部署为 1936，Caddy 网关部署为 443）；明文 RTMP（1935）不对公网开放。Caddy 网关只在本机转发解密后的 RTMP。不支持 RTMPS 的小程序通过 HTTPS 网页第二机位使用 WebRTC。证书必须可信并匹配域名。

- 恢复二维码由已登录桌面授权生成，绑定具体会话及一次性恢复凭据。桌面轮询使用独立私有凭据。双端离线满 120 秒，或不要求第二机位时桌面离线满 120 秒，服务注销会话并撤销双方令牌，个人考试计时保留。
- 登录材料先通过 `/api/client/material-upload-ticket` 校验完整身份或桌面登录凭证，再上传；上传需 `x-proctor-upload-ticket`，提交登录需同一 `uploadTicket`。仅接受解码成功且归属匹配的照片及 3–15 秒环境视频。每配对材料 100 MiB、每会话录像默认 16 GiB；配额与限流在数据库中持久记录。
- PDF 使用开启沙箱的非 root Chromium，禁止 JavaScript 和外部资源。Compose 使用 `deployment/chromium-seccomp.json` 允许沙箱必需的用户命名空间。独立部署需安装 Chromium/字体并配置 `CHROME_PATH`；视频解码可配置 `FFPROBE_PATH`。
- 后台普通响应过滤密码、令牌哈希与嵌套敏感字段；考生密码只从考试管理员专用考生管理接口获取。监考账号只能访问分配考室内的考生及打印材料。

Chromium seccomp 配置来自 [Playwright 官方容器配置](https://github.com/microsoft/playwright/blob/v1.63.0/utils/docker/seccomp_profile.json)（Apache-2.0，见 `deployment/LICENSE.playwright`）。

### 微信小程序（兼容旧流程）

1. 打开小程序。
2. 选择考试。
3. 输入学号、考号、密码。
4. 拍摄正脸加手持身份证明照片。
5. 录制 3–15 秒四周环境视频。
6. 扫描桌面客户端二维码。
7. 提交登录请求。
8. 提交后进入第二机位页面，将手机对准桌面、键盘、显示器和本人侧后方。
9. 考试期间不要退出小程序、切后台或锁屏；切后台会自动上报告警。
10. 监考老师发起语音时，小程序自动播放；需要回复时点击“开始语音回复”，录完后发送。

## 监考状态颜色

- 白色：未请求登录。
- 黄色：请求登录中。
- 绿色：登录成功且无异常。
- 黄色闪烁点：登录成功但有异常行为。
- 红色：登录成功但掉线。
- 橙色：已经确认结束考试。

## 客户端安全控制说明

已实现：

- 允许软件白名单：小熊猫 C++、IDEA、Eclipse、PyCharm、VS Code，以及系统核心进程和本客户端。
- 启动/考试期间进程扫描。
- 环境检测和考试期间仅检测并上报非白名单进程，不主动关闭其他软件。
- 屏幕采集和摄像头采集检测。
- 屏幕采集停止即时告警。
- 客户端失焦/切屏告警。
- USB/Thunderbolt/PnP 外设指纹变化检测，变化后锁屏并上报告警。
- 整机外部域名检测，覆盖其他浏览器和软件；记录域名及来源（HTTP Host、TLS SNI、DNS 查询或 DNS 缓存新增），不报告进程 ID，也不通过 IP 反查猜测访问网站。
- 安装 Wireshark（Windows 同时安装 Npcap；macOS 安装并授权 ChmodBPF）后采集 DNS/HTTP/TLS 域名。未安装时 macOS/Linux 尝试系统 tcpdump 的明文 DNS 采集，Windows 尝试系统 DNS 缓存增量检测。点击“网络检测”会发起授权：macOS 弹出系统管理员验证窗口，仅为当前登录用户授予 BPF 采集设备访问权限，不安装常驻服务；重启电脑后可能需要再次授权。缺少工具时打开官方安装入口。缺少权限或工具时显示不可用并向监考端报告，不能据此判定没有外部访问。
- DNS 查询/缓存是域名线索，不等同于已打开网页；加密 DNS、ECH、VPN/代理、已有连接和缓存复用可能漏报。仅保留最近 30 秒的域名活动；监考前旧缓存不作为新访问上报。
- 非白名单进程检测，报告进程名并立即上传当前录制片段，不锁屏。
- 虚拟机信号检测并告警。
- webview 限制 Hydro 比赛页面和监考服务器访问。
- 登录请求、审核通过、考试中和掉线均使用可移动、可调整大小的普通层级悬浮窗。仅被标记作弊或外设接入/移除触发全屏锁定；解除后恢复悬浮窗。进程和网络异常只提醒考生并通知后台。
- 服务端保存登录时外设基线指纹，桌面端心跳也会独立比对；即使单独告警请求丢失，下一次心跳仍会把外设变化锁定到会话。
- 管理解锁后，服务端把管理员确认时的最新外设指纹作为新基线，避免同一次已确认的插拔反复锁定。

## 正式数据接入注意事项

- 更新源码后必须执行 `pnpm db:generate` 和 `pnpm db:push`，新增会话外设基线字段后旧数据库才可接正式登录请求。
- 当前本地 MySQL 依赖 Docker Desktop；如果 Docker daemon 未启动，`pnpm db:push` 会失败，需要先执行 `docker compose up -d mysql`。
- 考生导入会按考试类型校验字段：个人赛必须有姓名、学号、考号、密码、座位号；团队赛必须有队伍名称、队伍成员姓名、队伍成员对应学号、考号、密码、座位号。
- 考室支持单个创建/更新、批量 CSV 导入和删除；导入时如果填写了不存在的考号会直接拒绝，避免正式监考时静默漏分配。
- 考试监考页支持全部考生、指定考室、未分配考生筛选；考试设置页会显示未分配考生数量和名单，用于正式数据核对。
- 登录请求会拒绝超过最晚开始时间的考生、缺少必需身份材料的请求、以及同一考生已有未结束会话的重复登录。
- 本地 uploads 和对象存储返回的历史录像、身份照片、环境视频、语音消息都会在 API 层转换为可播放 URL。

### 录像保存与空间占用

考试设置提供「保存完整考试录像」和「保存异常前后各 20 秒录像」，新建考试两项默认均不勾选；已有考试升级后新增的异常录像选项默认关闭，原完整录像设置保留。两项都未勾选时仅进行实时监考，不启动录像编码，不生成异常录像或本地录像补传数据。仅勾选异常录像时，正常画面只进入最多一分钟的内存缓冲；异常发生时保存对应机位前后各 20 秒的片段，其他正常片段自动释放。勾选完整录像时，从登录请求阶段保存完整监考过程，结束时补传最后片段；同时勾选异常录像不会重复复制片段。应在考试开始前确定选项，中途开启无法补回此前未保存的录像；更改设置会通过心跳同步到两端，不中断直播。已有历史录像、异常截图及异常审计记录保留。

屏幕、电脑前置摄像头和浏览器第二机位的直播均保持 1080p/30fps。保存录像使用独立画面副本：屏幕为 1080p/20fps、目标码率 2 Mbps；两路摄像头为 720p/20fps、目标码率各 0.8 Mbps；电脑摄像头保留单声道声音、目标码率 32 kbps。录像优先使用 VP9，不支持时回退 VP8 或 MP4，压缩不会改变直播画质。开启完整录像、三路全开时按目标码率估算约 1.63 GB/小时（1.52 GiB），实际大小随画面复杂度、浏览器编码器和音轨变化；关闭不要求的摄像头后不保存对应通道。

每个录像片段都有固定上传标识，重叠告警和网络重试复用同一文件和记录，不额外复制视频。客户端上传成功后删除本地暂存，失败时保留补传；手机重新扫码恢复同一会话后，用新令牌补传该会话的旧片段。后端按考试设置及真实异常记录验证保存范围：两项均关闭时丢弃所有监考录像，包括旧客户端及旧通道的异常视频；仅开启异常录像时只接收匹配真实异常窗口的片段，并等待告警同步后补传。上传期间取消勾选会再次检查设置，拒绝新增录像记录并清理尚未关联的文件。MediaMTX 仅负责直播，不额外保存录像；公开系统测试不保存录像。更新需同步数据库结构、重启后台和第二机位网页，并重新构建安装本次修改后的桌面客户端；旧桌面客户端的上传仍受服务器保存设置约束。

服务启动时及每小时清理登录凭据过期超过 24 小时、从未提交登录请求的身份照片和环境视频。清理会检查登录请求、其他媒体记录和告警引用，正式考试录像及已提交的审核材料不会自动删除。既有正式录像不会被这次更新重新压缩；服务端保存失败时的文件由相同上传标识重试复用。

录像策略测试使用独立数据库 `proctor_recording_qa`，设置 `DATABASE_URL` 和临时 `PROCTOR_UPLOAD_DIR` 后执行 `pnpm --filter @cwnupaa/proctor-web exec tsx tests/recording-policy-integration.ts`，覆盖勾选保存、取消停存、上传途中取消及截图保留。页面测试连接同一隔离数据库和本地后台，使用一致的 `SESSION_SECRET` 与 `RECORDING_QA_BASE`（默认 `http://localhost:4148`），执行 `pnpm --filter @cwnupaa/proctor-web exec tsx tests/recording-settings-http-integration.ts`。

## 安装包位置

后台主页是公开的客户端下载页，右上角「登录系统」进入后台登录。超级管理员在「系统管理 → 客户端版本发布」选择公网或内网、系统与版本号，上传安装包并点击「发布最新版」。Mac Apple 芯片、Mac Intel 和 Windows 分别发布；版本号必须递增，发布后的文件不可覆盖，旧下载链接保留。Windows 安装包同时包含 32 位与 64 位程序。

正式客户端每次启动只自动检查一次已发布版本，权限验证、设备检测、进入登录及刷新二维码复用本次启动的结果，不再定时重查。检查失败后可点击重试；发现新版本时需要先更新。点击更新后由软件下载安装包并校验 SHA-512，下载完成后由用户手动安装：

- Windows 打开安装向导，默认使用当前程序实际所在目录；保留该路径即可替换旧版本，也支持之前自定义的安装目录。从下载首页安装时，向导通过相同应用标识读取已有安装记录。
- Mac 提示当前 `.app` 所在位置，打开 DMG 和旧程序所在目录后退出；将新程序拖到原位置并选择「替换」，适用于 `/Applications` 和用户自定义目录。安装完成后重新打开程序。
- 考试或屏幕展示期间不启动安装。检查失败保留更新提示并允许重试；开发运行不强制检查已发布安装包。

后台发布客户端后，也会拒绝旧版本发起新的桌面登录配对，并提示从下载首页更新；已有考试会话的恢复和心跳不受新版本发布影响。首次部署应先登录后台发布安装包，再安排考生下载使用。

公网和内网使用同一个通用安装包。启动时优先检查 `https://proctoring.example.test`，内网请求最多等待 5 秒；内网不可达时再连接 `https://proctoring.example.org`。从选中的后台检查版本、下载更新、登录和生成第二机位二维码。内网可用时不请求公网，考生电脑不需要互联网。后台容器内部使用 **4031**，Docker 默认映射宿主机 **4031**；客户端使用 HTTPS 入口，无需填写端口。

考试会话建立后保持当前后台，断网恢复继续绑定原会话；结束会话后重新检测连接。切换后台会清除旧登录凭据和配对二维码。两处后台都不可达时显示重试提示，版本检查仍是登录的必要条件。内网电脑须通过内网 DNS 或 hosts 将下面四个内网域名解析到服务器的内网 IP，并信任该服务器的 HTTPS 根证书。

| 用途 | 内网 | 公网（保持不变） |
| --- | --- | --- |
| 后台/API/版本下载 | `proctoring.example.test` | `proctoring.example.org` |
| 考生网页/第二机位扫码 | `proctorstu.example.test` | `proctorstu.example.org` |
| 加密媒体推流（RTMPS） | `proctorstream.example.test` | `proctorstream.example.org` |
| 实时媒体（WebRTC） | `proctorrtc.example.test` | `proctorrtc.example.org` |

打包命令（打包电脑需要下载构建依赖，安装包内已包含对应架构的媒体程序）：

```bash
pnpm --filter @cwnupaa/proctor-desktop dist:mac:x64
pnpm --filter @cwnupaa/proctor-desktop dist:mac:arm64
pnpm --filter @cwnupaa/proctor-desktop dist:win
```

此前带 `intranet` 的打包命令同样生成通用安装包。公网后台 `proctoring.example.org` 转发宿主机 **4031**，公网学生网页 `proctorstu.example.org` 转发 **4032**。客户端使用学生域名打开 `/contest` 和生成第二机位扫码链接。后台容器 **4031** 继续转发 `/contest`、`/candidate`、`/candidate-assets`，供已有安装包及单域名部署兼容使用。构建后台时通过 `PROCTOR_CLIENT_WEB_INTERNAL_BASE` 指定考生网页内部地址，本机默认 `http://127.0.0.1:4032`，Docker 构建使用 `http://client-web:4032`。开发环境仍按后台 `4031`、学生网页 `4032` 工作；自定义学生域名可在打包时设置 `PROCTOR_CLIENT_WEB_URL`。

重新打包后的安装程序位于：

```text
apps/desktop/release/unified/proctor-1.0.2-unified-mac-x64.dmg
apps/desktop/release/unified/proctor-1.0.2-unified-mac-arm64.dmg
apps/desktop/release/unified/proctor-1.0.2-unified-windows-setup.exe
```

软件版本不区分公网和内网，每个操作系统只发布一次。安装包及版本配置由后台本地保存，默认路径是持久化上传目录中的 `desktop-releases`；可通过 `DESKTOP_RELEASE_DIR` 指定其他持久化目录。原有公网/内网发布记录自动按操作系统选择最高版本，旧下载链接与旧客户端更新地址继续兼容；网络地址只影响连接方式，不决定软件版本。独立部署的服务器各自持久化安装包，仍需把统一版本发布到实际提供下载的服务器。上传仅限超级管理员，每个文件最多 1 GiB，最多同时上传 2 个，管理员每小时最多 30 次，总上传配额 40 GiB（失败上传也计入预留配额）。公开接口只允许下载已发布文件，支持断点续传。

反向代理保留原始 `Host`，安装包上传路径允许 1 GiB 请求并关闭请求缓冲，例如 Nginx：

```nginx
location = /api/settings/desktop-releases/upload {
    client_max_body_size 1g;
    client_body_timeout 900s;
    proxy_request_buffering off;
    proxy_read_timeout 900s;
    proxy_send_timeout 900s;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass http://127.0.0.1:4031;
}
```

本机 Mac 安装包使用临时签名，尚未配置 Apple Developer ID 签名和公证；手动安装流程不依赖系统自动安装服务。Windows 为 NSIS 安装包，目标 Electron 版本为 22.3.27。

重要限制：

- Electron 应用无法像内核驱动一样绝对阻止所有进程启动、USB 变更和网络请求。
- macOS 的屏幕录制、摄像头、麦克风、辅助功能权限必须由用户或 MDM 授权。
- Windows 7 到 Windows 11 的强控制建议使用额外原生服务和组策略。
- 正式高安全考试建议配套：机房网络白名单、Windows 防火墙/GPO、macOS MDM、统一镜像、客户端签名、防卸载策略、赛前设备检查。

## 常见问题

### 客户端打开后黑屏

客户端离线或服务器不可达时，也应该显示服务器地址输入框和权限检测页；如果出现全黑屏，通常不是服务器连接问题，而是本地 HTML/脚本资源加载失败。

已修复过的典型原因：Electron 的请求拦截误拦截了 `file://` 本地页面。当前版本已放行 `file:`, `devtools:`, `about:`, `data:`, `blob:` 协议。

排查步骤：

```bash
"apps/desktop/release/mac/CWNU PAA Proctor.app/Contents/MacOS/CWNU PAA Proctor" --enable-logging --v=1
```

如果日志里出现 `ERR_BLOCKED_BY_CLIENT` 且 URL 是 `file://.../index.html`，说明本地资源被拦截，需要重新打包最新版客户端：

```bash
pnpm --filter @cwnupaa/proctor-desktop build
pnpm dist:desktop:mac
pnpm dist:desktop:win
```

### macOS 屏幕采集权限如何申请

macOS 的屏幕录制权限不是服务器控制的，也不能由客户端强制打开。客户端只能检测授权状态并打开系统设置页面，最终需要用户或 MDM 手动授权。

操作步骤：

1. 打开 `CWNU PAA Proctor`。
2. 首屏点击 `检测屏幕与摄像头`。摄像头和麦克风会弹出系统授权框，选择允许。
3. 如果屏幕采集显示异常，点击 `打开屏幕录制权限设置`。
4. 在 macOS `系统设置` -> `隐私与安全性` -> `屏幕录制` 中勾选 `CWNU PAA Proctor`。
5. 完全退出客户端，再重新打开客户端。
6. 再次点击 `检测屏幕与摄像头`，屏幕采集应显示正常，随后才能生成扫码登录二维码。

如果列表里没有 `CWNU PAA Proctor`，先重新运行客户端并再次点击 `检测屏幕与摄像头`。如果已经勾选但仍然失败，通常是 macOS 还没有把权限应用到当前进程，需要退出并重新打开应用。

## 后台并发性能更新（2026-10-11）

首轮后台优化兼容现有桌面、手机和考生网页。后续 USB、屏幕控制和清晰度修复需要桌面 0.1.35 与新版考生网页，部署步骤见下文。

- 提交结果轮询直接读取本地结果，由常驻后台任务统一同步 Hydro；轮询不再重新生成整份试卷、获取语言列表或重复请求评测服务。他人提交只读取摘要，判题状态没有变化时不写数据库，Hydro 超时或 5xx 不再放大为大量单条请求。
- 健康检查先筛选需要改变状态的会话，同场重叠刷新共享一次检查；健康会话、已上报且未达到注销条件的单端离线会话不再反复获取写锁。登录按考生加锁，避免不同考生之间的串行化范围锁；材料校验复用事务连接，避免连接池耗尽时等待第二条连接。
- 登录照片与环境视频保留独立上传名额，录像繁忙不会占用这些名额；通过容量检查后才计入速率限制，正式材料与录像使用独立全局限额，避免忙时重试反复消耗登录次数。恢复二维码也会重试配对码冲突；已取得令牌且心跳新鲜的二维码轮询不再重复锁定会话。
- 存储和评测连接设置缓存 1 秒，同一批读取合并；本进程保存后立即失效，其他进程最迟下次缓存过期刷新。会话权限、考试保存开关和注销状态仍实时检查。生产路由与任务共享 Prisma 连接池。
- 录像保留完整解码校验，单个解码器限制为 1 个线程，默认最多同时校验 2 个文件；输入直接从内存读取，省去临时盘写入。已验证的原视频补传先按内容摘要去重，S3 复用连接，上传表单减少整包内存复制。原有录像策略、删除拦截、额度及补传规则保留。
- 新增会话、录像、告警和待判结果的查询索引。更新时需执行数据库结构同步，只增加索引，不清空记录。

现有 Docker 部署可在停考维护时只构建和重启 `web`（其启动命令自动执行 `db:push`）：

```bash
docker compose build web
docker compose up -d --no-deps web
```

Caddy 部署改用 `bash scripts/deploy-caddy.sh web`，在限制构建资源的同时只更新后台。后台依赖下载支持 npm 官方源失败后切换 npmmirror，并保留已下载包缓存；遇到 Next.js 下载超时，更新仓库后重试此命令即可。主源与备用源可在 `.env` 中通过 `NPM_REGISTRY`、`NPM_FALLBACK_REGISTRY` 设置，详见 [下载故障处理](deployment/CADDY_GATEWAY.md#后台依赖下载出现-err_socket_timeout-或-timeouterror)。

直接运行 Node 的部署先执行 `pnpm db:push`、`pnpm build:web`，然后重启后台进程。后台判题同步需要常驻 Node 服务，已有 Docker 配置符合要求。

`UPLOAD_MAX_CONCURRENT` 控制录像等普通上传的并发数，默认 4；`UPLOAD_MATERIAL_MAX_CONCURRENT` 为正式登录材料单独保留名额，默认 2、范围 1–4，最多额外排队 32 个请求、等待 30 秒；`MEDIA_VALIDATION_CONCURRENCY` 独立控制解码 CPU 并发，默认 2、范围 1–8。共用服务器先保留默认值，再根据实际 CPU、内存和上传积压调整。数据库连接数可用 `DATABASE_URL` 的 `connection_limit` 参数设置，多个后台进程的总连接数应一起计算。

性能与正确性回归：

```bash
pnpm --filter @cwnupaa/proctor-web test:performance
# 以下仅使用独立测试数据库，先对测试库执行 prisma db push。
# 登录测试强制要求 127.0.0.1 上的 proctor_performance_qa 库。
DATABASE_URL='mysql://USER:PASSWORD@127.0.0.1:PORT/proctor_performance_qa?connection_limit=8' \
  pnpm --filter @cwnupaa/proctor-web test:performance:login
PERFORMANCE_TEST_DATABASE_URL='mysql://USER:PASSWORD@127.0.0.1:PORT/proctor_performance_qa' \
  pnpm --filter @cwnupaa/proctor-web test:performance:health
```

本地真实 MySQL 验证中，30 个账号同时登录全部成功，8 个连接时 p95 约 351ms，1 个连接时 p95 约 630ms；同账号并发仅创建一个会话。30 个健康会话的 8 次并发刷新只产生 6 条查询、0 个会话写锁。生产构建的本地 HTTP 验证中，30 次同时登录 p95 约 570ms，随后 90 次心跳 p95 约 143ms。4 个录像槽全部占用时，30 人共 60 份登录材料仍全部保存成功、无需重试；300 条提交的 30 人并发查询在 Hydro 离线时全部成功且没有调用 Hydro。以上是本地接口与数据库测试（视频为小型合成素材），不代表公网带宽、生产服务器或三路实拍视频的容量结论；上线后仍应按实际录像码率和评测负载复测。

## 后续性能与监考修复（桌面 0.1.35）

- 监考刷新只读取题目标题、分值等所需信息，以及打印任务摘要；题面、评测配置和打印正文不再随每次刷新重复传输，打印预览仍按原权限读取完整正文。考试访问/管理权限合并检查，考室隔离及权限撤销继续实时生效。
- 监考页右上角可选择按姓名或学号搜索，筛选后分页；正在收流的考生排前，无画面和已结束的考生排后。画面状态通过媒体服务器批量获取，短时共享查询结果，再按本次授权考室过滤，避免为排序拉取所有人的视频。
- XCPC/ACM 榜单保留封榜边界，旧版 Hydro 聚合榜单无法按本系统封榜时间裁剪时暂停返回。考生提交记录进一步按下述账号/队伍权限隔离，不随解封公开其他队伍的记录。
- 同一监考者并发观看同一考生的三路画面时，合并当次媒体鉴权查询；不缓存已完成的授权结果。考生榜单的重叠轮询共享当次成绩读取，更新和下一次请求立即可见。管理端提交列表/KS 评分读取本地持久化结果，Hydro 离线不再阻塞打开页面；后台同步继续更新判题结果。
- 录像目录批量检查考试管理权限、减少重复扫描；告警录像先按考生会话和通道索引，再定位时间窗口，保留跨窗口长录像、重叠录像和历史录像的匹配规则。
- USB 检测比较排序去重后的物理设备身份，忽略设备名称、软件音视频端点、电源状态等易变字段；真实变化需要至少间隔 1 秒的两次独立扫描确认，扫描失败不当成拔掉设备。后台统一在心跳事务中判断 USB 变化，兼容旧版本格式升级，并避免延迟直报告警在监考解锁后再次误锁。
- 同一会话同类型的持续异常使用数据库状态去重，不再每五分钟重复创建告警与录像事件；明确正常持续 10 秒后再次出现才生成新记录，严重程度上升仍会记录。缺失检测数据不作为恢复，断网直报按原始事件时间补传。瞬时切屏、禁止导航与检测组件诊断保留独立冷却，电脑和手机切屏分别处理。客户端仅在异常开始时持久上报，重连期间保持原有正常检测频率，不随更快的重连循环重复扫描；扫描失败或结果过期时停止发送旧的进程、网络和虚拟机检测结果，避免将旧健康状态误判成恢复。
- Windows 屏幕推送期间启用临时系统快捷键拦截，覆盖 Win+Tab、Win+Ctrl+方向键/新建桌面等组合。检测到虚拟桌面切换时，在当前桌面的所有显示器重新创建遮罩与图片窗口。停止展示或客户端退出即释放；保护组件启动失败会显示异常，最多重试 3 次。保留 Windows 的 Ctrl+Alt+Del 安全操作，不修改注册表或永久系统策略。

| 视频通道 | 采集/直播目标 | 直播码率上限 | 录像码率目标 |
| --- | --- | --- | --- |
| 屏幕 | 最高 1920×1080，30 帧/秒，优先保留文字分辨率 | 3 Mbps | 3 Mbps，20 帧/秒 |
| 电脑前置摄像头 | 1280×720，20 帧/秒 | 450 Kbps | 600 Kbps |
| 手机第二机位网页 | 1280×720，20 帧/秒，旋转画布同频绘制 | 450 Kbps | 600 Kbps |

屏幕编码使用文字内容提示，摄像头优先保持动作连续。上述码率是上限/目标，浏览器仍会根据网络和设备能力调整；后台媒体转发没有追加压缩。三路直播合计上限约 3.9 Mbps/人，30 人合计约 117 Mbps 的服务器入站视频，还需考虑协议、录像补传及监考观看的出站流量。不能把普通网页访问流畅等同于直播带宽足够；100 Mbps 链路无法保证同时达到这些上限。

本轮独立 MySQL 测试：30 考生、10 道大题面、60 个打印任务的监考数据从约 3.92 MB 降至 148 KB；90 路媒体请求（30 人×3 通道）的鉴权 SQL 从 242 条降至 30 条；30 人同时读榜单的考生/成绩查询各从 30 次降至 1 次。30 路旧 USB 直报与格式升级并发没有误锁；30 路真实变化只生成一条告警并保留录像事件。测试同时检查权限隔离、注销、打印全文和最新待判记录。数据为本机隔离环境结果，不等同于线上三路实拍容量。Electron 22 的本地 H264 回环测试确认屏幕编码保持 1920×1080，协商前后保留文字优先策略及码率/帧率上限（可用 `pnpm --filter @cwnupaa/proctor-desktop test:stream-quality` 复跑，仅生成测试画面）。Windows 保护组件已完成 x64/ia32 编译与生命周期/快捷键策略测试，正式开考前仍需 Windows 实机验证 Win+Tab、触控手势、双屏、真实 USB 插拔及停止展示后的恢复。

本轮新增内部 `ClientSession.monitoringAlertState` JSON 字段，部署需执行 `db:push`（只补充状态字段，不清空既有数据）；现有 Docker 启动命令会自动执行。该状态不返回到网页或客户端。

这轮需要先更新后台，再发布桌面 0.1.35；第二机位画质调整需同时部署考生网页并刷新手机页面。Caddy 部署：

```bash
bash scripts/deploy-caddy.sh web client-web
```

考生网页镜像同样支持依赖源失败切换和下载缓存，避免新版手机画质配置发布时重复遇到依赖下载超时。

Windows 安装包由 `pnpm dist:desktop:win` 构建，内含两种架构的屏幕保护组件。现有客户端不会因为仅更新后台而获得新的本机 USB/控屏能力。macOS USB 和屏幕画质修复同样需要重新打包对应架构安装包。

新增隔离数据库回归入口为 `test:performance:monitor`、`test:performance:media-read`、`test:performance:contest-read`、`test:performance:evidence`、`test:peripherals:integration` 和 `test:alerts:integration`（在 `@cwnupaa/proctor-web` 下）。监考和提交读取测试可传 `PERFORMANCE_QA_BASE=http://127.0.0.1:PORT` 与测试服务器相同的 `SESSION_SECRET`，验证实际生产 HTTP 路由；只允许本机临时 QA 库，不要指向正式库。告警单元回归使用 `test:alerts`，数据库回归覆盖 30 并发、持续异常、正常恢复、离线重试、严重程度升级与真实 USB 再次变化。

监考搜索/画面排序与 XCPC 封榜回归使用 `test:monitor`、`test:xcpc-freeze`。对应 `test:monitor:integration` 和 `test:xcpc-freeze:integration` 仅连接本机 `proctor_monitor_freeze_qa` 临时库；浏览器测试使用生产服务 `127.0.0.1:43118`，该服务的 `MEDIA_API_INTERNAL_BASE` 指向测试脚本临时提供的 `127.0.0.1:43119`，不连接真实考生视频。

## 提交记录隔离与考试高并发优化（2026-10-11）

正式发布安装包统一使用 **1.0.1**，包含前述 0.1.35 的 USB、控屏、清晰度及异常去重修复，以递增版本承接线上已发布的 1.0.0。Windows、Mac Intel 和 Mac Apple Silicon 均需重新打包，安装包内部版本与后台发布版本保持一致，不覆盖历史安装包。

考生提交记录默认仅当前考试账号可见，所有赛制一致。考试创建、编辑和基础设置中的「允许同队成员查看提交」默认关闭，仅对成员独立账号开放；开启后可查看同一考试中当前同队成员的记录、代码和详情。关闭共享或成员换队后，下一次读取立即重新检查权限。共用考试账号的成员按同一账号共享，不扩大到其他账号。管理员查看权限保持原有规则；成绩与测试点仍遵守各赛制显示设置，XCPC 封榜不影响获准共享的本队结果。

- 初始考试和后续提交列表使用同一权限范围，直接在数据库限制查询；不能通过提交编号、队名或伪造身份参数读取外队详情。新增考生「考试 + 队名」索引，避免频繁共享查询扫描整个名单。
- 考生页面每 5 秒只读取会话状态与内容版本；题目、考试设置及时间可见性变化时才重新读取完整题面。旧版 Hydro 考试保留完整刷新，以继续遵守外部比赛结束时间。
- 提交列表仅传摘要，打开单条记录才读取代码和测试点。未变化的详情不重复下载；关闭共享或变更成绩显示设置会使已打开详情失效。客观题历史答案仅从本账号恢复，避免覆盖正在编辑的答案。
- 定时请求在上次完成后再安排下一次，不堆积慢请求。待判记录约每秒刷新；已判完的记录页每 3 秒、其他页面每 10 秒、后台标签每 15 秒刷新。公告连接正常时答疑全量刷新降为每 30 秒兜底，异常时每 5 秒兜底，并合并同一时刻的重复刷新。
- 公告和答疑推送按同场考试、同一后台进程共用扫描，每轮三条事件查询加一条会话鉴权查询。每轮检查令牌和撤销状态，再按考生分发定向公告与回复；公开问题撤回只广播刷新通知。最后一位考生断开后停止扫描，慢连接有缓冲上限。

本机隔离 MySQL 测试使用 8 个连接、100 个账号和 1,000 条含大代码/用例的提交：100 个并发摘要查询全部成功，直接路由测试 p95 约 193ms，生产 HTTP 测试 p95 约 592ms；单账号 10 条记录的响应从 380,411 字节降至 5,421 字节，减少 98.6%。100 个并发轻量状态请求 p95 约 362ms，完整考试响应 381,961 字节降至状态响应 409 字节。真实 MySQL 和 100 条 SSE 连接的连续三轮扫描均为 4 条 SQL，增加第 101 条手机连接后保持不变，最后连接关闭后无后续查询。这验证了接口负载改善，不代表 100 人三路直播容量；实际在线人数仍取决于服务器 CPU、评测队列、存储吞吐和视频带宽。

部署本轮需更新 `web` 与 `client-web`，执行 `db:push` 创建新增索引（现有 Docker 启动流程会执行），无需为本轮重打包桌面安装程序。测试入口：`test:submission-sharing`、`test:submission-sharing:integration`、`test:contest-client:integration`、`test:qa-events`、`test:qa-events:integration`。数据库集成测试只接受本机 `proctor_submission_sharing_qa` 临时库，可配 `PERFORMANCE_QA_BASE` 验证生产 HTTP；页面测试使用本机考生网页生产服务与合成接口数据，不连接真实考生。

## 常用命令

```bash
pnpm install
pnpm typecheck
pnpm db:generate
pnpm db:push
pnpm db:seed
pnpm dev:web
pnpm dev:client
pnpm dev:client:https
pnpm dev:desktop
pnpm dev:desktop:watch # 客户端实时开发：界面自动刷新，主进程改动自动重启
pnpm build:web
pnpm build:client
pnpm --filter @cwnupaa/proctor-desktop build
pnpm dist:desktop:mac
pnpm dist:desktop:win
```

## 验收建议

正式使用前至少完成：

- 使用正式 HTTPS 域名跑通管理网页、考生网页、桌面端与 WHIP 推流。
- 使用真实 HydroOJ 安装并测试 `cwnupaa-proctor-auth` 插件。
- 用 5 到 10 台 Windows 和 macOS 机器试考。
- 测试摄像头缺失、屏幕采集被停止、切屏、打开非白名单进程、拔插 U 盘、断网、手机浏览器切后台以及 WHIP 自动恢复。
- 测试对象存储写入和历史录像回放。
- 测试 Windows 7、Windows 10、Windows 11、macOS Intel、macOS Apple Silicon。
- 生产安装包签名。

### 考试发布、编号与 KS 赛制

- 考试发布页使用名称与摘要列表，点击“发布考试”或“编辑考试”进入全屏表单。比赛管理员可从考试列表编辑自己负责的考试，左侧不再单设“考试管理”。
- 考试编号为北京时间的首次开考日期 `YYYYMMDD` 加 `01–99` 序号；数据库每日计数器在事务内分配，唯一约束防止重复。编号生成后不可修改，删除考试也不回收编号；同一日期的 99 个编号用尽后会明确报错。
- 考生通过 10 位考试编号与考号匹配唯一考试及考生记录，密码和原有身份核验仍然保留。手机网页和小程序均传递考试编号；同时传入内部考试 ID 时，服务端验证两者一致。
- 开始时间与时长决定统一结束时间。IO（内部兼容原 OI）、IOI、KS 可设置最晚开始时间，个人考试按首次开始时刻计时，最晚结束时间为最晚开始时间加时长。XCPC 按统一时间计时，封榜分钟数为距结束的剩余分钟，0 表示不封榜。
- 排行榜沿用协会官网 `cwnupaaweb` 的赛事榜单规则。XCPC/ACM 共用总榜，正式参赛、女生队伍计入名次；打星选手保留在榜单中并以 `*` 表示，不占用正式名次。先比较解题数，再比较精确累计罚时；显示罚时仍按每题整分钟计算，CE 不计错误次数。
- GPLT 先选择“星芒初绽 / 长风破浪 / 凌霄问鼎”，再查看团队排名或个人排名；LANQIAO 独立保留赛制，先选择“C/C++程序设计 / Python程序设计 / Java软件开发”，查看个人得分榜。两者每题取最高有效分，分别向上取整、四舍五入，同分比较最早取得该分数的时间；团体分为成员分数之和。
- 组别选项、正式/打星/女生筛选、搜索、单题单元格、奖项、导出与时间回放在管理端和考生端共用实现。GPLT/LANQIAO 按各组正式人数的 10%（至少一名）分配金奖，银奖和铜奖名额分别为金奖的两倍、三倍。排行榜不显示数据分析面板或提交详情入口。可执行 `pnpm --filter @cwnupaa/proctor-web test:leaderboards` 验证排名规则。
- KS 编程题实时判题，考试期间仅显示通过测试点数/总数；客观题先保存提交，整场考试结束后送判。成绩按 OI 的最后一次有效提交计分，考生端不公布 KS 排行榜。
- KS 客观题队列保存在数据库中，由 Next.js Node 服务每 15 秒处理，服务重启后继续处理；Hydro 暂不可用时保留任务并重试。生产环境需运行常驻 Node 服务（本项目 Docker 部署符合此条件）。
- “允许打印”默认为关闭，可在发布和编辑表单保存，考试数据接口会同步返回该设置。
- 语言限制同时作用于考生端选项与服务端提交校验，取考试限制、题目限制和 Hydro 已启用语言的交集。需要同步更新 Hydro 插件，以提供 `/api/proctor/languages` 接口。

更新时运行 `pnpm db:push`，命令会先为已有考试补齐编号，再更新数据库结构，不会删除已有考试。随后重启管理端、考生端及更新后的 Hydro 插件。规则测试运行 `pnpm --filter @cwnupaa/proctor-web test:exams`；数据库集成测试 `tests/exam-integration.ts` 应在测试数据库中运行，会创建并清理测试用户及考试。

### CWNUPAA 外榜推送

- 在「考试管理 → 选择比赛 → 考试管理 → 外榜推送」中，填写 **CWNUPAA 官网域名**（例如 `https://www.example.org`，也可填写带 `/api` 的地址）及 **官网赛事 ID**，点击滑动开关开启推送。每场比赛独立配置，域名默认为 `www.example.org`，比赛 ID 在开启时必须填写。推送开关默认关闭，切换立即生效；开启时一并保存当前配置并立即推送，关闭无需保存且不受未完成的配置草稿影响。域名、比赛 ID、密钥和推送间隔可通过「保存外榜配置」独立更新，不修改考试基本信息；普通编辑考试不会覆盖这里的实时配置。域名自动补全 `/api`；官网使用其他接口前缀时需先配置对应代理。
- 推送密钥可选输入；单独填写时使用该密钥；留空时仅在外榜地址与「系统设置 → 协会官网登录 API 管理」服务同源（协议、域名、端口均一致）时使用系统 AppKey，其他地址必须填写本场专用密钥。官网「接口管理」必须启用所用密钥并授予 **外榜** 权限。单独的推送密钥只允许本场比赛管理员读取，普通比赛、监考和考生接口不返回密钥；不会改变现有外部登录配置。官网已有赛事的赛制、比赛时间、封榜和参赛组别仍在官网管理。官网已审核报名的比赛账号必须与本场 **考号** 一致，团队赛按队伍账号/成员账号分别匹配。
- 开启或更改已开启比赛的配置后立即触发同步，之后按每场比赛设置的推送间隔运行（默认 10 秒，可设置 1～86400 秒的整数）。每批最多 50 条，大量记录也按间隔分批同步；先调用 `/api/external/board/{eventId}/problems` 更新题目，再向 `/api/external/board/{eventId}/submissions` 分批推送已判题记录（包含源代码）。重判、人工成绩和考号调整会更新原记录；更换目标域名、赛事 ID 或重新开启推送会重新同步，单独修改间隔保留同步进度。记录 ID 使用 `proctor:` 前缀，避免与其他来源冲突。
- 同步进度和错误持久保存，失败在推送间隔和 30 秒中取较长时间后重试；后台任务独立运行，每次请求限制超时，网络失败不阻塞登录、提交、判题或比赛设置保存。页面下方自动刷新推送日志，显示开关/配置操作、成功/失败、题目数、提交数、耗时和目标赛事；无新记录时显示检查结果。日志只在服务内存中临时保存最近 100 条，不写入数据库，网站重启后自动清空；日志不保存密钥或原始接口响应。官网成功响应但漏收账号也会标记失败并重试。关闭开关会立即撤销任务租约并取消本进程正在发送的请求；已经被官网接收的历史数据保留。
- 官网现有接口按整数百分比接收成绩，推送按题目原始满分归一化，再由官网按本场题目分值计算；时间使用北京时间并保留毫秒，运行内存单位为 KB。官网没有删除提交接口，本地「忽略提交」按 **Compile Error / 0 分** 更新原记录，使其不计入解题数、成绩和 XCPC 错误罚时。官网页面会以该兼容状态展示。删除本地考生或移除题目不会删除官网历史数据，需在官网管理。
- 更新时先同步数据库结构并重启后台：本地执行 `pnpm --filter @cwnupaa/proctor-web db:push`；Docker 部署的 `web` 服务启动命令已自动执行数据库更新。仅新增默认关闭的配置、推送间隔、同步状态及查询索引，不新增日志表，不修改现有考试、账号或成绩。
- 回归检查：`pnpm --filter @cwnupaa/proctor-web test:external-board`。完整同步测试需使用独立 MySQL 数据库 `proctor_external_board_qa`，设置 `DATABASE_URL` 后执行 `pnpm --filter @cwnupaa/proctor-web test:external-board:integration`。网页测试使用同一隔离数据库和本地后台，设置一致的 `SESSION_SECRET` 及 `EXTERNAL_BOARD_QA_BASE`（默认 `http://localhost:4148`），执行 `test:external-board:http-integration`，覆盖页面保存、密钥优先级、关闭停推和权限隔离；测试不会连接真实官网。


### 后台文件管理与删除

超级管理员在「系统设置 → 客户端发布与安装包管理」搜索、下载、单独或批量删除历史安装包及未发布文件。当前各系统正在发布的最新版受保护，不能删除；删除历史包后，其下载链接失效。安装包发布与删除使用相同的数据库锁，避免并发发布引用已经删除的文件。

「历史录像」支持删除单条或所选异常录像，也可选择已结束的考试，删除整场完整录像、异常片段和异常截图，单次最多 20 场。只有超级管理员、考试创建者或该场比赛管理员可以删除；只有查看权限的考室监考员不能删除。成绩、考生资料、异常审计日志、身份照片和环境审核视频保留。共用片段仍被其他异常或其他业务记录引用时保留。

业务记录的删除标记与文件清理任务在同一个数据库事务内提交，失败则一起回滚；文件系统和 S3 不支持加入 MySQL 事务，因此实际文件删除通过持久化清理任务完成，失败不会被当作已释放空间，会自动重试，后台可查看待清理、失败数量并手动重试。任务保存删除时的存储配置，服务重启后继续执行。整场删除及片段删除标记会拦截迟到补传，不再被其他记录引用的文件，其旧本地存储签名链接也会被拒绝，避免记录再次出现。后台保留少量删除标记及任务元数据用于防止补传复活和审计，不保留已清理视频的内容。

本次功能只需要更新后台并执行 `pnpm db:push`（Docker 后台容器启动时自动执行），无需重新打包桌面客户端。


## 并发、安全与 Windows 7 USB 更新（2026-10-15，桌面 1.0.5）

- 同一会话的心跳、告警和重连在进入数据库前排队，避免重复请求占满连接池；单会话最多 128 个请求，排队超过 10 秒返回可重试的 503，过期请求不会继续更新在线状态。数据库行锁仍保留，用于多个后台进程之间的互斥。心跳使用已锁定的会话快照构造响应，减少 MySQL 更新后的重复读取，不缓存鉴权结果。
- 手机网页心跳、语音和测试画面检查在上次请求结束后再轮询，退出时取消请求。心跳 10 秒超时，防止弱网积压；考试结束停止语音轮询。
- 管理后台变更接口（含上传）校验请求来源；旧管理员登录接口与新入口共用限流。考生密码校验按实际账号共享预算，不以整个考场的公共 IP 限制并发。登录输入限制长度和请求大小，过期计数按索引分批清理。
- 修复外榜地址可使系统 AppKey 外泄的问题：系统备用密钥只发往系统外部登录服务同源地址，不跟随重定向；其他外榜服务须配置本场专用密钥。
- 管理端与考生端更新到 Next.js 16.4.1，覆盖 [10 月 14 日官方安全修复](https://nextjs.org/blog/nextjs-security-update-october-14-2026)。Excel 库改用 [SheetJS 官方 0.20.3 发行包](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/)，修复旧 npm 版本的原型污染、正则拒绝服务问题；同步更新公式渲染、YAML 解析及打包工具的可用安全补丁。
- 新生产数据库初始化取消公开的管理员默认密码，必须配置独立的 `BOOTSTRAP_ADMIN_PASSWORD`，已有账号保持不变。
- 普通 Compose 的 MySQL 端口仅监听本机。受限构建器的内存、交换区、CPU 或实际执行探针检查失败时停止部署，不再回落到无资源限制的构建；任一镜像构建失败均不重启运行中的服务。
- Windows USB 使用独立检测通道，避免其他系统探针的失败或缓慢响应丢弃 USB 结果。原生组件缓冲输出，减少旧机器的管道调用；使用总线和硬件标识补充第三方 Win7 驱动识别。已重建 x86/x64 原生组件，指纹升级为 `usb-v5`。明确检测失败或探针超时会报告检测故障并锁定；故障不覆盖原设备基线，检测恢复后仍需监考员解锁。已有健康会话允许一次指纹格式迁移，旧客户端字段缺失不视为故障。

隔离的本机 MySQL 8.4 测试中，300 名考生同时发送 600 次电脑/手机心跳全部成功：8 个数据库连接约 1.377 秒完成，p95 1.274 秒；1 个连接约 4.706 秒完成，p95 4.442 秒。常规心跳 10 条 SQL，更新部分从 7 条降到 5 条（均含事务与行锁）。100 个请求等待同一会话时，其他会话仍可完成心跳；30 次并发 USB 检测故障仅产生一条告警。以上是直接路由及数据库测试，不含真实视频传输，不能换算为生产环境的在线人数上限。

本轮验证通过：后台 346 项、桌面 244 项、手机网页 51 项、共享/小程序/插件/部署 62 项测试；两个网页生产构建、类型检查、真实浏览器提交权限回归，以及隔离 MySQL 外榜、USB、HTTP 来源校验均通过。

验证入口：`test:performance:heartbeat`、`test:performance`、`test:security`、`test:security:http`、桌面 `tests/*.test.cjs` 及手机网页 `tests/*.test.ts`。心跳压测要求显式设置 `PERFORMANCE_TEST_DATABASE_URL`，只接受本机独立 QA 数据库；测试会建立并清理自有夹具，不读取生产数据库配置。

生产依赖审计已无告警；完整审计仍有 Electron 22.3.27 的 38 条公告以及仅构建时使用的 extract-zip（2 条）、sprintf-js（1 条）公告，后两者在本次 npm 查询中没有可安装的修复版。Electron 虽在开发依赖中，仍是桌面程序实际运行时，不能因此忽略风险。[Electron 22 是支持 Windows 7 的最后主版本，现已停止支持](https://www.electronjs.org/blog/electron-22-0)；本次保持 Win7 兼容，未声称消除旧运行时风险，也未忽略审计条目。详细审计快照见 `docs/security-audit-2026-10-15.json`。

更新需重新构建并部署 `web`、`client-web`，以及重新打包、分发桌面 1.0.5；仅推送源码不会更新已安装客户端。此轮不新增数据库表。当前开发环境没有 Windows 7 真机，交叉编译和回归测试不能代替实机测试；短于轮询/确认周期的拔插仍可能漏检。真实 Win7 SP1 32/64 位验收步骤及检测边界见 [Windows USB 检测说明](apps/desktop/native/windows-inventory/README.md)。


## 监考提醒与并发更新（2026-10-15，桌面 1.0.6）

- 后台提醒默认显示待处理项。同一考生、同一会话、同一类型/文案/严重度在 5 分钟内的重复记录折叠成组，可展开每条记录和取证，也可显式将当前组全部标记已处理；操作期间新来的异常不属于已确认的组。严重程度升级单独展示。接口仍最多返回 80 条，未处理优先，防止旧未处理记录被新已处理记录挤出。
- 处理提醒与告警写入共用会话行锁，避免处理最后一条时误清除同时产生的新异常。全部处理后重新计算考生状态；已处理的同一持续异常不会被重复心跳重新标为异常。真实离线、尚未解除的 USB 锁定、有效作弊标记及已结束考试仍保留对应状态，解除锁定/恢复连接后重新计算。已有历史粘滞状态也由心跳按每会话最多 30 秒一次的有界检查修正，普通正常心跳不增加查询。
- 服务端持续异常恢复仍需 10 秒健康观察，但相邻健康观察超过 15 秒会重新计时，不把断网前后的两个样本当作连续恢复。桌面进程/域名异常在连续健康 30 秒后才结束本地上报阶段，首次异常和严重度升级即时上报。断线积压告警最多 3 条并行补传，多个补传触发共享同一任务。
- 后台状态请求串行执行，15 秒超时，隐藏页面暂停并取消读取，返回页面立即刷新；未打开语音面板时不查询语音。手动刷新与自动轮询合并，变更后的刷新至少等待一次新读取，防止慢请求覆盖新状态。录音期间固定并显示接收考生；关闭语音面板或离开监考页会取消录音并释放麦克风，延迟返回的授权结果也会丢弃。
- 同进程内、同场考试的管理者共享正在进行的完整监考查询，完成后立即释放，不缓存已完成的数据。考室监考员每次重新查询授权范围，部分撤权时也不能复用旧读取。健康检查先筛选真正需要改变状态的会话，每批最多加载 200 个，健康且不需要第二机位的考生不再每 5 秒被完整加载。
- 题目附件响应增加沙箱、禁止类型猜测和来源泄漏保护；HTML 等主动内容强制下载，SVG 题图保留显示但不能执行脚本。代理流式转发附件，避免大文件整包占用内存。图片上传在读取正文前检查频率和容量，图片/视频解码共用有界队列；不同路由共享上限，繁忙时返回可重试的 429。
- 初始电脑配对限制为全局 6000 次/分钟、单设备 10 次/分钟，不按考场共用 IP 限制；请求正文最多 16 KiB。后台每分钟分批清理过期 5 分钟以上的未使用配对码，已认领、关联登录/恢复或仍有材料上传凭据的配对保留。

隔离本机 MySQL 测试：30 次同时进行的管理者监考读取合并为 15 条 SQL（单次完整读取同为 15 条），8 连接 p95 16 ms、1 连接 p95 23 ms；1000 个健康会话的 8 次同时健康检查约 15 ms，仅 1 条候选查询、无会话加载及写锁。1000 个完全离线会话的分页回收、25 项房间要求/超时边界及部分撤权竞态验证通过。这些是数据库与接口负载结果，不是 1000 路视频的实测在线容量；生产容量仍受媒体服务器、带宽和硬件限制。

本轮 730 项回归测试通过（后台 371、桌面 246、手机网页 51、共享/小程序/插件/部署 62），后台生产构建与类型检查通过。真实 MySQL 验证了最后一条提醒处理、同时新增异常、跨会话状态更新、重连与解锁；真实 HTTP 验证了取消作弊与处理提醒之间的状态一致性。Chrome 页面验证了提醒折叠、处理后恢复正常、新提醒保留、USB 解锁、慢网络串行刷新，以及录音接收人固定与取消录音不发送。

验证入口：`test:monitor`、`test:monitor:notifications`、`test:performance:monitor`、`test:performance:health-scan`、`test:alerts:acknowledgement`、`test:alerts:acknowledgement:http`、`test:security:attachments`、`test:security:pairing`。集成测试只允许显式指定本机 QA 数据库，并清理自建测试资料。

部署需同步数据库新增的告警排序索引（`pnpm db:push`，Docker 后台启动时自动执行）并重建后台；桌面本地防抖与补传变化需要重新打包、分发 1.0.6。未在此开发环境操作生产数据库。生产依赖复查仍为 0 条公告，完整依赖审计的 41 条旧 Electron/构建工具公告仍存在，Windows 7 支持与风险边界同上节。

## 公网与内网考试双向同步

本机考试可按考试编号和考号双向同步源代码、提交结果和排行榜，支持双方手动重测、断网续传、版本冲突处理和考试专用 API-KEY。仅更新后台及数据库，无须改动客户端；NovaJudge 不使用此功能。配置和数据库升级见 [公网内网考试双向同步](docs/公网内网考试双向同步.md)。

公告、答疑完整讨论、公开状态与系统上传的图片也双向同步，任意一端均可回复，并保留并发回复和固定消息编号。详情、后续增量 SQL 及本轮并发修复见 [公告答疑双向同步与并发复查](docs/公告答疑双向同步与并发复查.md)。

## 外部直播接收与转发

超级管理员先在“直播管理”创建流 ID，再使用“系统设置”中的通用直播 API-KEY 推流和播放。推流采用 `POST /api/live-relay/publish/流ID?apikey=系统密钥`（WHIP），观看使用 `GET /api/live/流ID?apikey=系统密钥`，也可通过同一播放地址的 POST 请求使用 WHEP。推流和播放均使用 WebRTC，同一流 ID 同时只允许一个推流设备。媒体独立运行，须开放实际配置的 ICE TCP/UDP 端口（默认 1940），无须修改监考客户端。部署、资源限额和接入方式见 [直播接收与转发使用文档](docs/直播接收与转发使用文档.md)。
