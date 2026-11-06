# NovaJudge 自动 Reaction

Reaction 默认关闭，仅适用于 NovaJudge 考试。考试详情 → Reaction 录像中开启；客户端必须更新到包含本次改动的版本。它复用现有桌面/摄像头采集、独立约 10 秒 MediaRecorder 片段、认证上传、MediaSegment 和本地/S3 存储。MediaMTX 不开启重复录制，也不新增 WHEP 录制服务。

## 先配置 CCS 授权：服务端 `.env`

**账号密码填写在监考项目 `apps/web/.env`，后台没有 CCS 账号密码输入框。** Reaction 页固定提供“首次使用：CCS 授权在哪里填写？”说明，可随时展开查看。新部署从 [模板](../apps/web/.env.example) 创建该文件；已有文件只补充配置，不覆盖其他密钥或数据库设置。默认填写以下三项：

```env
REACTION_CCS_ORIGIN="https://judge.example.org"
REACTION_CCS_USERNAME="your_novajudge_super_admin"
REACTION_CCS_PASSWORD="CHANGE_ME_TO_THAT_ACCOUNT_PASSWORD"
```

用户名和密码属于 **NovaJudge 全局 `SUPER_ADMIN`** 账号，由 Recorder 以服务端 HTTP Basic 请求 `/api/ccs/contests/{contestId}/event-feed`。监考后台账号、考试外榜 `x-api-key` 和浏览器登录状态不能代替它。无需在 NovaJudge 中为每场比赛重复分配 CCS 权限；同一 origin 上的新比赛可复用这组默认凭据，仍须在监考考试中填写正确比赛ID并单独开启 Reaction。

origin 是协议、主机和非默认端口，不包含路径、`/api` 或末尾 `/`，必须与考试 NovaJudge 平台地址经 URL 解析后的 origin 完全一致。例如 `localhost` 和 `127.0.0.1` 不相同；非本机服务要求 HTTPS。

可选 `REACTION_CCS_CREDENTIALS` 为按**监考内部 `Exam.id`** 索引的 JSON。命中的条目完整覆盖三项默认配置，不做逐字段合并；键不是10位 `examCode`，也不是 NovaJudge 比赛ID。更换默认账号后，如该考试仍有覆盖条目，需要同时更新该条目。

```env
# 只有需要逐考试覆盖或连接多个NovaJudge服务时才设置；以下均为占位符。
REACTION_CCS_CREDENTIALS='{"PROCTOR_EXAM_ID":{"origin":"https://judge.example.org","username":"your_novajudge_super_admin","password":"CHANGE_ME_TO_THAT_ACCOUNT_PASSWORD"}}'
```

完成后重启**监考网页后台与独立 Recorder**，让两者读取同一份授权配置，再在考试 Reaction 页开启并检查 Event Feed“已连接”。前台 Recorder 在原窗口按 Ctrl+C 后重新运行下节命令；重跑服务启动命令不等于已运行进程重载 `.env`。页面的“已配置”只表示配置项齐全，实际认证结果以 Event Feed 连接状态为准。

Docker 部署需把同样变量显式注入 `web` 和独立 Recorder 的环境；当前基础 Compose 没有自动转发这些变量，也未包含 Recorder 服务。修改注入配置后需重建对应容器，单纯 `docker compose restart` 不会更新容器环境。凭据仅由服务器保存，不能提交到 Git、前端或下载文件。完整配置入口、HTTP认证检查和故障分层见 [CCS 授权配置说明](reaction-ccs-auth.md)。

## 部署与入口

从当前未启用 Reaction 的主分支升级，先备份并执行 [增量 SQL](../deployment/migrations/20261104-reactions.sql)，再生成 Prisma Client；迁移仅新增表、字段和索引，不重置数据库。空白测试库可以使用项目现有 `db:push` 建立完整 schema，不能在同一库重复执行两种初始化。已有早期 Reaction 表的环境先对比实际 schema，见 [已有安装升级说明](reaction-export.md)。按上节在实际 `apps/web/.env` 填写 CCS 凭据，`.env.example` 只提供模板。

```powershell
# 已有主分支部署，从仓库根目录执行一次增量迁移：
pnpm --filter @cwnupaa/proctor-web exec prisma db execute --file ../../deployment/migrations/20261104-reactions.sql --schema prisma/schema.prisma
pnpm --filter @cwnupaa/proctor-web db:generate
pnpm --filter @cwnupaa/proctor-web dev
# 新 PowerShell 窗口，仓库根目录：
Set-Location apps/web
node --env-file=.env --import tsx scripts/reaction-recorder.ts
```

Recorder 是独立进程，不放在 Next 请求或 NovaJudge Worker 内。数据库租约避免重复订阅，同一 worker 一次最多运行一个裁剪/合成任务；编码限制两个线程。关闭网页不会停止后台任务。生产部署应由服务管理器守护该命令。

生成器安装、官方版本及小范围兼容适配见 [reaction-generator.md](reaction-generator.md)。默认赛中保存 Camera/Desktop/metadata，管理员在列表单独或批量生成。三种视频与 metadata 只能通过具备本考试管理权限的下载端点读取，支持 Range；不返回公开 S3 URL。

## 缓存、时间与状态

- 配置默认缓存 60 秒、提交前 3 秒、最终判题观测后 10 秒，最长待判 1800 秒，原始与产物保留 30 天；自动合成关闭。
- 每个提交精确映射本考试的 `Candidate.examNumber === CCS team_id`，不按名字匹配。原始片段只存一份，重叠提交通过 ReactionSegment 共享引用。
- 普通缓存按片段结束时间清理，因片段约 10 秒，实际可恢复缓存会比 60 秒多至约一段加调度时间。待判窗口不受 60 秒限制。全程录像和异常证据不因 Reaction 清理而删除。
- 桌面端认证请求 `/api/client/time`，使用请求往返中点估计采集时钟偏差；片段保存偏移与不确定度。未知或 >250 ms 不确定度、时间缺口、时长不符都不能标记完整。NovaJudge 与监考服务器应使用可靠 NTP。`eventOffsetMs` 是提交源时间到接收时间的差，包含网络/轮询延迟，不声称是纯时钟偏差。
- NovaJudge 的 `judgement.end_time` 是合成时间，仅记录备查；实际终点一律使用本服务接收到最终 judgement 的时间 +10 秒。
- 缺片段时标记 PARTIAL/MISSING；已有可用片段中缺失的时段显示黑帧，保留两路共同时间轴，不压缩空缺。PARTIAL只要Desktop可完整解码且有判题观测时间，也允许生成：双路存在时从原共同窗口起点截到两路视频与原窗口的最短时长；缺少Camera时，摄像头区域显示内置“未提供摄像头画面”模板，时长取Desktop与原窗口的最小值，均按25fps向下量化。模板只在临时目录生成，不写入真实cameraPath。旧黑色补帧仅在采集metadata明确证明没有保留帧时替换，不按画面颜色猜测；已有Camera文件损坏或读取失败会明确报错。原缺失诊断保留，状态仍为PARTIAL；metadata记录cameraSource、模板依据、degraded、原因及输入/选取/输出时长。MISSING、EXPIRED、缺Desktop或文件损坏仍不能生成。
- 如果最短录像截断在判题观测之前或恰好该时刻，卡片保持黄色等待，隐藏结果动画与结果音效，不把判题时间提前；metadata明确记录`OUTSIDE_TRIMMED_WINDOW_WAITING`。裁剪包含判题时仍使用原真实观测偏移。
- 超时 TIMEOUT、映射失败 UNMAPPED、取消 CANCELLED、删除 DELETED、到期 EXPIRED 都明确显示。停止整个 Recorder 不会伪造完成；恢复后补处理持久化窗口和任务。
- 开启时持久化本次启用时间；旧配置无起点时，以首次快照请求开始时间补建起点。起点前的提交不会触发录像，其后的新提交正常捕获。关闭再开启会重设起点，关闭期间的历史提交不会补录；保持开启状态修改参数不会改变起点。连接重建按持久化事件哈希和 exam/submission 唯一键去重。已有 Reaction 保留；事件源已绑定后不能在原考试换成另一场比赛。
- 重判更新最新 verdict 和观测历史，已保存录像保留 originalVerdict，合成仍使用原录像对应结果。NovaJudge 当前不会发 delete，极快的同结果重判可能被它的 2 秒轮询漏掉；本系统无法凭空恢复未发出的事件。收到显式 delete/update 时仍按相应状态处理。

## 安装与运行前提

先按仓库 [README](../README.md) 安装监考系统的 Node/pnpm 依赖、MySQL、MediaMTX 和更新后的桌面客户端。使用 `package.json` 指定的包管理器版本与其支持的 Node 版本。已有部署保留自己的 `.env`、存储目录和卷；Reaction 不要求特定数据库名、Docker 容器名或工作区目录。

NovaJudge 按其官方文档单独部署 PostgreSQL、Redis、go-judge、Web 和 Worker。两个平台须能从服务器侧互相访问；本地开发通常使用 NovaJudge 3001、监考后台4031、考生网页4032，实际端口以各自配置为准。正常部署流程不调用 E2E 初始化脚本。

官方竖屏生成器另行安装：

```powershell
# 仓库根目录，Python 3.12+、Git、FFmpeg、FFprobe 已在 PATH：
.\scripts\setup-reaction-generator.ps1 -Python python
```

按命令输出把生成器路径加入服务端环境；脚本不会覆盖已有 `.env`。Linux安装步骤和字体要求见 [生成器说明](reaction-generator.md)。Web 和独立 Recorder 都需要数据库、存储与 CCS 配置；只有 Recorder 需要生成器 Python/FFmpeg 运行时。

## 管理员使用步骤

1. 在 NovaJudge 创建专用测试比赛和测试队伍，确认 Worker 能完成真实判题。
2. 在监考后台创建 NovaJudge 考试，填写准确的平台 origin、比赛 ID 和合法外榜 API Key。考生 `examNumber` 必须与 NovaJudge 队伍 username 完全相同。
3. 配置服务端 CCS 凭据并启动独立 Recorder，在考试详情 → **Reaction 录像** 开启。等待 Event Feed 显示已连接。
4. 用更新后的桌面客户端登录测试考试，允许摄像头和桌面采集，等待至少一个完整缓存窗口。后台检查两路源与缓存状态。
5. 测试队伍提交正确程序，等待真实 AC；保持采集直至结果后尾段和上传宽限结束。可再以错误程序验证 WA。
6. 在 `/dashboard/exams/{examId}/reactions` 查看与提交关联的 Camera/Desktop。缺失或稀疏帧记录保留明确的 PARTIAL/MISSING 状态。
7. 点击生成或批量生成，完成后预览并下载1080×1920成片。组织徽章与背景设置见下节。
8. 需要外榜文件时，直接批量导出 `{uuid}.mp4` ZIP，文件名与原始 CCS Submission UUID 一致，无需修改NovaJudge。详见 [UUID与导出](reaction-export.md)。

## 可复现验收

[隔离测试说明](reaction-testing.md) 给出完整的依赖准备、私有配置文件及 PowerShell 命令。`scripts/reaction-e2e.ps1` 必须显式提供 NovaJudge 测试 checkout 和独立 runtime env，不读取正式 NovaJudge `.env`，不启动任何固定名称的容器。它创建或复用专用测试比赛，使用真实 Worker/CCS，媒体明确标为模拟内容并通过合法 WHIP→MediaMTX→WHEP 与原片段上传链路。

已有比赛与已有本地服务的人工流程使用 [manual E2E](reaction-manual-submissions.md)，必须显式指定考试、队伍和私有授权文件。模拟媒体验收与真实桌面客户端/摄像头验收在报告中分别记录；模块构造事件测试不代替真实判题或媒体验收。

## 系统组织徽章与视频外观

徽章统一在 [系统设置 → Reaction 组织徽章与默认徽章](/dashboard/system#reaction-branding) 维护。只有超级管理员能新增、改名、替换或删除组织映射，以及设置全局默认徽章。

1. 填写组织名称，选择自己的徽章图片，点击“添加组织徽章”。图片支持静态 PNG/JPEG/WebP，≤4 MiB，推荐512×512透明正方形。选择后可看圆形底衬预览。
2. 确保考生资料的“学校/组织”与组织名称对应。名字按NFKC兼容字符、首尾空白与连续空白规范化后精确匹配，保留大小写，不做模糊推断。一份徽章由同组织的所有队伍、所有考试复用。
3. 可在“全局默认徽章”上传并保存默认图。未匹配组织、组织为空时使用它；未上传自定义默认图时使用系统内置中性徽章，不代入某所学校的标识。
4. 打开 [考试 Reaction](/dashboard/exams/{examId}/reactions) 的“视频外观”。这里仅设置背景与字体，徽章自动匹配。背景推荐1080×1920（9:16），静态PNG/JPEG/WebP≤4MiB，最多1600万像素且单边≤8192px。其他比例按居中cover裁切。
5. 右侧完整9:16预览展示实际背景裁切、所选队伍当前组织徽章、摄像头/桌面和信息卡位置；可切换待判/AC/WA示意或隐藏覆盖层看背景。占位画面、题目、时间和名次均为排版示意，浏览器字体近似；最终视频由官方生成器输出。
6. 点击“保存视频外观”，然后对完整录像点击“生成竖屏”或“重新生成”，生成后预览并下载。已有成片不会因修改设置而自动变化，原始Camera/Desktop保留。

生成时优先读取该Reaction准确关联的当前考生学校字段，核验考试ID和队伍账号；关联不可用才回退原录像学校快照。生成元数据记录学校来源、规范化学校、命中组织、徽章ID和SHA-256。这样修正考生学校后，预览与重新生成使用同一组织。历史每考试/每队伍手动徽章配置和原文件保留，但不再覆盖系统组织规则。

系统设置使用已有SystemSetting的reactionBranding JSON键保存组织映射和defaultLogoId；复用ReactionLogo和现有本地/S3存储，不新增数据库表或迁移。组织上限500；历史不可变徽章对象上限默认2000，可用REACTION_BRANDING_MAX_ASSETS调整（500–10000）。删除映射/替换徽章不物理删除旧图片，历史文件不被破坏。

管理API为GET/POST/PATCH/DELETE /api/settings/reaction-branding，图片由受保护的 /logos/{id} 返回。POST使用multipart kind=organization|default、file和组织name；替换显式传replace=true及existingName。PATCH支持{name,newName}，DELETE{name}删除组织映射，DELETE{}恢复内置默认。所有写操作验证超级管理员、来源和图片解码/大小限制。

原考试logo-library写入口返回410；背景assets上传仅接受kind=background，旧素材读取保留原考试权限。外观预览端点 /api/exams/{id}/reactions/appearance-preview?kind=background|logo&teamId=... 验证本场管理权限与队伍归属；通用uploads/file不开放Reaction素材。

可复用测试入口（apps/web目录，显式配置独立本地Reaction测试库）：

~~~powershell
node node_modules/typescript/bin/tsc --noEmit
node --import tsx --test tests/reaction-render-settings.test.ts
node --env-file=.env --import tsx tests/reaction-appearance-browser.ts
node --env-file=.env --import tsx tests/reaction-branding-ui.ts
# 后台集成测试含短暂的系统默认徽章测试窗口；勿与人工修改同时执行：
node --env-file=.env --import tsx tests/reaction-branding-integration.ts
~~~

CCS名次逻辑不变：可靠基线之上的最终判题事件更新榜单，保存前后排名；缺少可靠数据隐藏名次，重判保留原片名次，详见reaction-ranking.md。
