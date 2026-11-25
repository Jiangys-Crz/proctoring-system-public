# Hydro 网页比赛外榜推送

适用于监考平台的「HydroOJ（监考与浏览器）」考试。题目、递交和评测仍在 Hydro 原生比赛中完成，监考后台自动将题目和已判题提交发送到现有 CWNUPAA 外榜接口。

## 部署

1. 将本仓库 `hydro-plugin/cwnupaa-proctor-auth` **整个目录**更新到 Hydro 实际启用的插件路径，版本至少 `0.3.1`，然后重启 Hydro。新增文件 `board-contest.ts` 和已有 `problem-score.ts` 均须部署。
2. 更新监考 Web 服务，执行项目原有构建及重启流程，例如 `pnpm --filter @cwnupaa/proctor-web build`，再由现有进程管理器重启服务。本次复用已有外榜配置和远端记录检查点表，不新增数据库结构；从不含外榜功能的旧版本升级，仍需按项目流程同步数据库。
3. 在「系统设置 → 评测服务设置」确认 Hydro 主地址和 API-Key，与 Hydro「控制面板 → 系统设置 → 考试监考平台 → API-Key」一致。运行连接检测应显示插件 `0.3.1` 或更新版本。若比赛位于其他 HydroOJ 站点，改为在本场考试填写该站点监考插件的 API-Key，不需要修改系统评测服务或题库同步映射。
4. 不需要更新监考桌面客户端，也不需要启动 CDS 或 ICPC Live。

## 开启与关闭

1. 在官网准备目标比赛，设置 XCPC 赛制、起止时间、封榜和报名名单。官网审核通过的比赛账号须与监考考号、实际 Hydro 用户名一致。
2. 监考考试选择「HydroOJ（监考与浏览器）」，填写 Hydro 站点或 `https://oj.example/d/域ID`，以及 24 位原生比赛 ID。Hydro 固定时间 `acm` 对应 XCPC；也兼容固定时间 OI/IOI 导出，不支持个人限时 `duration` 比赛。
3. 打开「考试管理 → 选择考试 → 考试管理 → 外榜推送」。填写官网域名、**官网赛事 ID**、官网推送密钥和间隔，点击「自动推送外榜」开关。
4. 开启时自动保存表单并立即开始同步。每轮重新发送全部符合条件的提交，每批最多 50 条，后续页按约 1 秒的调度节奏继续。一轮完成后，等待配置的间隔（默认 10 秒）再开始下一轮。题目发生变化时先推送题目。页面下方显示每批状态、发送数量和错误日志。
5. 已开启时可直接保存配置。关闭开关立即停止后续读取和发送，也会取消本进程的在途请求；官网已经接收的数据保留。即使配置草稿未填完，也能关闭。

外榜开关默认关闭，每场独立保存。更新程序不会替你选择官网比赛或开启真实官网推送。

## 三种凭据不要混填

| 用途 | 填写位置 | 使用方 |
| --- | --- | --- |
| Hydro 评测 API-Key | 监考系统设置与 Hydro 监考插件设置；其他站点使用本场考试单独填写的插件 API-Key | 后台读取原生提交 |
| 官网推送密钥 | 每场考试的「外榜推送」 | 后台写入官网外榜 |
| CCS 直播用户名、密码 | Hydro CCS 设置与直播软件 | ICPC Live/CDS 读取直播数据 |

官网推送密钥须在官网接口管理启用并有「外榜」权限。留空仅在目标与系统外部登录 API 同源时使用系统 AppKey；不同站点必须提供专用推送密钥。Hydro 读取密钥不会发给官网，官网密钥不会发给 Hydro 或选手。

## 数据与接口约定

Hydro 内部源接口为 `POST [/d/域ID]/api/proctor/board-contest/:tid`，请求头 `x-proctor-api-key`；请求包含 `since`、`until`、`after` 和监考名单 `usernames`。它返回题目元数据及限定账号的提交代码、结果、用时和内存，不返回密码、测试数据或判题日志。

官网接收接口保持不变：

```text
POST /api/external/board/{官网赛事ID}/problems
POST /api/external/board/{官网赛事ID}/submissions
```

请求体分别为 `{ "api_key": "…", "problems": [...] }` 和 `{ "api_key": "…", "submissions": [...] }`。成功响应须包含 `code: 200`；提交返回的 `data` 须为 `成功处理并保存了 N 条提交记录`，且数量与发送数量一致。旧的单条 `/external/submit` 接口不能代替这两个批量接口。

题目按原生比赛顺序标记 A/B/C，提交按题目内部 ID 对应，允许重名题。ACM 的 AC 为 100%，其余为 0%；OI/IOI 按原始满分转成整数百分比。运行时间为毫秒，运行内存为 KB，题目内存为 MB，提交时间为北京时间、秒精度。选手排名、罚时和封榜最终由官网依其配置重算。

后台以稳定的 `hydro:监考考试ID:来源摘要:原生记录ID` 推送。每轮从头扫描并重新发送已判提交，重判完成后同一 RID 的最新结果会覆盖外榜旧结果。失败或接收数量不匹配时保留扫描游标，下一次从失败批次继续。若重判发生时该提交已在本轮发送，下一轮会发送最新结果。

导出的是管理端原始结果，**包含封榜期间的判题结果**；官网必须配置自己的封榜规则。它与 CCS 面向直播的封榜投影独立。

官网协议没有删除接口。Hydro 取消、忽略及 ACM 格式错误使用原 ID 的 `Compile Error / 0` 中和已推送成绩与错误罚时；界面会显示此兼容状态。物理删除 Hydro 记录、移除题目、移出名单或更换源比赛不会自动清除官网旧数据，应在官网处理。

## 验证

```sh
pnpm --filter @cwnupaa/proctor-web test:external-board
node --test hydro-plugin/cwnupaa-proctor-auth/tests/board.test.cjs
```

数据库集成测试只允许独立的 `proctor_external_board_qa` MySQL 库：同步该库 schema 后，设置 `DATABASE_URL` 运行 `test:external-board:hydro-integration`。界面测试还需启动使用同库、同 `SESSION_SECRET` 的生产构建后台，设置 `EXTERNAL_BOARD_QA_BASE`，运行 `test:external-board:hydro-http-integration`；可用 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定 Chrome/Edge 路径。测试源和接收端均在本机，不会发送到真实官网。
