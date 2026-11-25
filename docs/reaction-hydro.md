# Hydro 比赛 Reaction

完整的 Hydro 设置入口、ICPC Live 直连/CDS 配置、WHEP 视频映射、Recorder 与 OBS 使用步骤见 [Hydro XCPC 直播与 Reaction 使用部署说明](hydro-live-deployment.md)。原生 Hydro Reaction 读取独立 `hydro-ccs-api`，使用独立未封榜读取密钥；直播使用 Basic 账号。迁移和以后只更新 CCS 的步骤见 [独立 CCS 接入](hydro-ccs.md)。

Reaction 支持以下来源，默认关闭：

| 考试方式 | 提交与判题来源 | 名次变化 |
| --- | --- | --- |
| 本平台考试，使用 Hydro 判题（HYDRO，比赛 ID 为 local） | 本地 ContestSubmission，由评测 worker 同步结果 | 暂不提供 |
| HydroOJ（监考与浏览器）（HYDRO_BROWSER） | 独立 hydro-ccs-api 的原生 XCPC HTTP 事件流 | 可靠基线建立后保存判题前后名次 |
| 旧版直接对接 Hydro 的考试（HYDRO，24 位比赛 ID） | 同上 | 同上 |

原生 CCS 仅支持固定起止时间的 `acm`（XCPC）比赛。它同时提供榜单与面向直播的独立认证视图，见 [Hydro XCPC CCS API](hydro-ccs.md)。本平台提交使用 `sub_<UUID>`，兼容旧 CUID；原生提交使用 24 位 Record ObjectId。列表、单个下载和 ZIP 中的 `{submissionId}.mp4` 文件名均保留原始 ID（包括 `sub_` 前缀），详见[导出说明](reaction-export.md)。

## 启用与升级

1. 已有 Reaction 表的部署无需新增 MySQL 迁移。尚未安装 Reaction 的旧版先按 [README 升级流程](../README.md#novajudge-reaction-自动录像与-ccs-授权) 准备数据库、FFmpeg、Python 生成器和存储；Hydro 跳过 NovaJudge CCS 账号配置。
2. 更新监考 Web 与独立 Recorder。考生使用已支持 Reaction 分段采集的桌面客户端。在 `apps/web` 下运行 `node --env-file=.env --import tsx scripts/reaction-recorder.ts`，生产配置为常驻服务。
3. 原生比赛安装独立 **hydro-ccs-api 1.x**，监考插件升级至 **0.4.1**，按原方式重启 Hydro。本平台本地考试沿用现有评测同步接口，无需 CCS 插件。
4. 在 Hydro“系统设置 → CCS 比赛数据接口”填写比赛允许清单与未封榜读取密钥。Web 和 Recorder 均配置 `REACTION_HYDRO_CCS_ORIGIN`、`REACTION_HYDRO_CCS_API_KEY`，密钥对应 `hydroCcsApi.adminApiKey`。原生考试地址保留 `/d/域ID`，其 origin 必须与 CCS 配置一致。题库与本地评测使用系统评测地址和原有 API-Key；HydroOJ 浏览器监考优先使用本场考试单独填写的插件 API-Key，未填写时使用与评测服务同站点的 Key。
5. 开赛前打开“考试详情 → Reaction 录像”，开启并保存，等待事件来源显示“已连接”。监考考号必须与实际提交者的 Hydro `uname` 完全一致；团队成员按本人用户名映射摄像头与屏幕，名次按所属原生队伍计算。不按姓名或显示名匹配。
6. 使用监考客户端实际提交，检查“等待判题 → 录制判题后画面 → 完整保存/录像不完整”，再生成、预览和下载。缺失摄像头或屏幕时沿用 PARTIAL/MISSING 行为。

原生 Recorder 使用 `GET [/d/域ID]/api/ccs/contests/:id/event-feed` 与独立 `x-ccs-api-key`，不发送选手 Cookie 或评测密钥。比赛允许清单同时约束 Basic 和 Recorder，必须包含当前域/比赛。旧 `POST /api/proctor/reaction-contest/:tid` 分页接口保留兼容，但新版 Recorder 不会静默回退。旧内置 CCS 游标保留，新接口使用单独游标；原片与已保存名次不变。

## 录制、名次与恢复

- 原生事件流每 2 秒观察比赛变化，事件与名次上下文先持久写入 Hydro MongoDB，再推送给 Recorder。游标按域、比赛和认证视图隔离，重启可续传；同一提交及同一事件重复到达不会重建录像。
- 可靠基线之后的最终结果携带 `HYDRO_CCS_OBSERVED_ORDER`，按 Hydro 原生秒级 XCPC 规则保存前后名次。第一次接入的历史结果、打星队或 journal 顺序不足时，数字名次隐藏。它反映 CCS 观察顺序，不代表数据库事务的原始完成顺序，详见 [名次依据](reaction-ranking.md)。
- 本地 Hydro 考试仍轮询轻量提交元数据，每轮完成后等待 2 秒；扫描失败不会把尚未读取的提交误判为删除。本地考试与旧版无证据的录像保持 `HYDRO_OBSERVED_RESULT / UNAVAILABLE`，不会套用 NovaJudge 计分补造名次。
- 开启时保存录制起点，起点前提交不创建录像；关闭再开启重设起点。Hydro ObjectId 只有秒级时间，开启当秒无法确认先后的提交会跳过，因此应提前开启。
- 等待、编译和评测中不结束窗口；最终结果进入尾段。录制结束时间以 Recorder **观察到最终结果的时刻**为准，判题时间另存审计字段。Hydro 状态 10 是未知错误 `FAILED`，31 是格式错误 `FE`。
- 重判更新最新 verdict 与历史，保留原片 verdict、名次及录制窗口。已生成的旧视频不会自动因升级获得历史名次。
- 本平台同步导入的异地提交不触发本机录像。评测 worker 未运行、Hydro 离线或客观题赛后评测时，录制仍受最长待判时间约束。
- 内部 Reaction 使用未封榜视图；直播 CCS 使用封榜视图。两边赛程应一致；原生比赛的视频经过时间优先使用 CCS `contest_time`，本地考试或缺少该字段时按监考考试开始时间计算。

“已连接”表示成功读取提交来源；本地考试还要确认评测 worker 持续更新结果。“凭据已配置”只表示字段和地址校验通过。原生比赛 400 检查固定时间 XCPC；404 检查域、ID 与独立插件；401 检查 CCS 未封榜读取密钥；403 检查比赛允许清单和代理规则。`REACTION_HYDRO_CCS_CONFIGURATION` 表示实际 Web/Recorder 环境的 CCS 密钥或 origin 配置无效。

## 验证

在 `apps/web` 下运行：

```powershell
node --import tsx --test tests/reaction-hydro.test.ts tests/reaction-export.test.ts tests/reaction-ranking.test.ts
```

在仓库根目录运行：

```powershell
node --test hydro-plugin/cwnupaa-proctor-auth/tests/reaction.test.cjs hydro-plugin/cwnupaa-proctor-auth/tests/browser-contest.test.cjs
```

测试覆盖实际消费适配器与事件状态机、CCS 名次保存、迁移/续传去重、重判、关闭重开、团队成员映射、密钥隔离与浏览器保护共存。CCS 生产端的封榜、计分和 HTTP 流测试只在独立仓库运行 `npm run check`。使用隔离模型，不连接正式数据库；不代替真实 Hydro 判题、桌面实拍、视频合成和直播软件联合验收。

旧内置 CCS 在 2026-11-09 完成本机真实 Hydro 判题 → CDS/ICPC Live → Recorder/FFmpeg/官方生成器联合测试，包含 `2 → 1` 名次变化、封榜与重启续传；媒体为模拟摄像头/桌面。这不代表独立插件已在真实服务器验收，迁移后须重新检查数据链路与客户端。缺媒体的 MISSING 与时间戳不完整的 PARTIAL 不视为完整录像。
