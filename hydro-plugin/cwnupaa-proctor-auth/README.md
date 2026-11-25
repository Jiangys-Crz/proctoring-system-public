# cwnupaa-proctor-auth 0.4.1

0.4.1 在授权直播请求启用 `statistics` 时返回提交语言和可见的判题完成时间，用于监考大屏的比赛图表。封榜期间，尚未揭晓的提交会隐藏判题完成时间。

监考后台可以手动揭晓直播和大屏榜单。监考服务使用评测 API-Key 调用外榜接口，在请求体发送 `"broadcast": true` 和 `"reveal": true` 时，接口返回已评测提交的实际状态和分数，响应中的 `broadcast.frozenAt` 为 `null`。直播模式继续过滤比赛维护者并省略源代码。常规直播读取仍遵守 HydroOJ 封榜，HydroOJ 自己的比赛榜单继续由 HydroOJ 管理。

浏览器限制按登录账号执行。同场比赛中，通过监考系统登录的账号须使用监考客户端，其他账号继续按 HydroOJ 原生权限参加比赛。外榜接口的直播模式提供题目颜色、封榜状态和提交元数据。

本目录是监考平台维护的 HydroOJ 插件。更新时请覆盖 Hydro **正在启用的插件目录**中的整个目录并重启 Hydro；只更新监考网页不会更新 Hydro 插件。本项目不会自动修改旁边的 Hydro 工作区。

从 Hydro 系统设置到 ICPC Live 直连、可选 CDS、OBS 和 Reaction 的操作步骤与配置模板，见 [完整使用部署说明](../../docs/hydro-live-deployment.md)。

### 回归测试

先安装监考仓库依赖。Reaction、外榜测试使用隔离模型和本地 HTTP；配置注册测试使用真实 Hydro 设置注册器，但不启动 Hydro 或连接 MongoDB。它可指向有依赖的 Hydro 源码目录（`HYDRO_SOURCE_ROOT`），也可指向已安装的 `hydrooj` npm 包（`HYDRO_PACKAGE_ROOT`）。CCS 服务端测试在独立仓库运行。在仓库根目录运行，例如 PowerShell：

```powershell
$env:HYDRO_PACKAGE_ROOT = 'D:\hydro-runtime\node_modules\hydrooj'
node --test hydro-plugin/cwnupaa-proctor-auth/tests/*.test.cjs
```

这不替代实际 Hydro、判题机、监考客户端、Recorder 与直播软件的联合验收。

## 浏览器监考

监考后台使用原有 API-Key 调用 `POST /api/proctor/browser-contest/:tid`。发布时登记原生比赛。开考后，已登记的监考账号需要有效的 Hydro 会话和客户端专用凭据才能访问比赛、榜单、比赛题目及记录。其他账号继续按 HydroOJ 原生权限访问。比赛管理权限保留，比赛结束后自动恢复普通访问。域内比赛使用 `/d/域ID/api/proctor/browser-contest/:tid`。

## 配置

`0.3.1` 新增 Hydro 网页比赛外榜数据接口 `POST [/d/域ID]/api/proctor/board-contest/:tid`。使用现有评测 API-Key，按监考名单、比赛时间和游标读取原生题目及提交（含代码），不需要选手 Cookie 或 CCS 直播账号。支持固定时间的 `acm`、`oi`、`ioi`、`strictioi`；未开赛可同步题目信息，个人限时比赛不支持。外榜开关和官网推送密钥在监考后台「考试管理 → 外榜推送」配置。必须完整部署本目录，包含 `board-contest.ts`、`problem-score.ts`，并重启 Hydro。接口属于管理端导出，不采用直播封榜投影；官网负责其公开榜单的封榜。操作与兼容边界见 [Hydro 外榜推送](../../docs/hydro-external-board.md)。

**0.4.0 将 CCS 完整移出本插件。** 原生 Reaction 和直播使用独立 `hydro-ccs-api 1.x` 的 `/api/ccs`。本插件不注册 `/api/proctor/ccs`、不保存 CCS 日志或设置，也不依赖独立插件源码。CCS 日后只在独立仓库更新；本插件继续负责题库、评测、浏览器监考和外榜。旧版迁移、独立密钥及游标切换见 [独立 CCS 接入](../../docs/hydro-ccs.md)。

`0.2.6` 新增原生比赛 Reaction 读取接口 `POST /api/proctor/reaction-contest/:tid`（域内比赛加 `/d/域ID`）。它使用现有 API-Key，按 `since` / `after` 分页返回全部提交的轻量元数据，不使用选手会话、不报名、不返回代码或测试点。监考浏览器保护不会拦截这个独立鉴权的服务接口。部署时务必包含新增的 `reaction-contest.ts`，步骤见 [Hydro Reaction](../../docs/reaction-hydro.md)。

在 Hydro「控制面板 → 系统设置 → 考试监考平台」填写：

| 设置 | 系统键 | 监考后台对应项 |
| --- | --- | --- |
| API-Key | `cwnupaaProctor.apiKey` | 系统设置 → 评测服务设置 → API-Key |
| 题库域 ID | `cwnupaaProctor.problemDomainId` | 题库域 ID，默认 `Problems` |

监考后台另外填写 Hydro 服务主地址。API-Key 在监考后台生成、保存并复制到 Hydro；已有密钥可继续使用，无需重新生成。密钥输入框留空会保留现值。系统设置优先于插件启动配置，保存即生效。

题库及判题接口只检查请求头 `x-proctor-api-key`。不要求签名密钥、服务账号、密码、UID、Hydro 比赛编号，也不匹配考生与 Hydro 账号。监考平台负责自己的学生会话、考试权限和成绩展示。

Hydro 原生记录结构要求数值 UID，插件内部固定填入 `1`，不查询或登录这个账号，也不把它作为鉴权或提交归属条件。题库域首次使用时自动创建；改变域 ID 不会迁移旧题目和记录，请保持现有值。

后台「检测连接与配置」只读检查 API-Key 认证及题库域，返回：

```json
{"ok":true,"data":{"problemDomainId":"Problems","authMode":"api-key","pluginVersion":"0.3.1","configured":true}}
```

## 题库与判题接口

以下均为 POST，使用同一 API-Key：

- `/api/proctor/config-check`：配置检查。
- `/api/proctor/languages`：启用的语言编号及显示名称；合并各判题机报告的可用编译器，排除禁用及明确缺失的编译器；没有版本命令、空报告或缺少某语言的版本信息不会把该语言误判为不可用。
- `/api/proctor/problems`、`/api/proctor/problem/:pid`：题目查询。列表接口可传 `exactPid` 精确匹配题号，只返回标题、题型、真实满分等摘要（`content`、`files` 为空，`config` 仅含 `type`）；题目详情及考试导入通过数字 docId 单独读取。列表查询每进程最多同时两项，逐份读取原始配置计算满分，不批量加载题面或测试数据；搜索文字最多 1000 字符，数据库搜索最多执行 10 秒。
- `/api/proctor/problem/sync`：同步题面、配置及测试数据。
- `/api/proctor/problem-bank` 的 `create-step`：题目创建与断点保存，使用固定创建编号，完整保存前不进入题库列表或跨网同步。客观题和按点计分的编程题配置由共享转换模块生成。需更新整个插件目录，详见 [题库创建](../../docs/problem-authoring.md)。
- `/api/proctor/problem/:pid/file`：题目文件下载地址。
- `/api/proctor/problem/:pid/answer-key`：仅供持有密钥的后台读取客观题答案。
- `/api/proctor/judge`：提交 `{ "pid": 1, "lang": "py.py3", "code": "print(1 + 2)" }`，直接进入 Hydro Judger 队列。示例语言编号必须替换为语言接口实际返回的值。
- `/api/proctor/judge/:rid`、`/api/proctor/judge-status`：查询单条或批量结果。记录读取只验证 API-Key，不检查 Hydro 账号或考试归属。

`0.2.3` 的批量结果查询先去重并校验编号，每批最多 200 条，以一次数据库查询读取，不再并行发起 200 次查询。结果查询不再返回源代码；监考后台已经持久保存原始代码，状态同步不依赖此字段。提交接口仍返回原有提交信息，并限制语言编号为 64 字符、代码为 512 Ki 字符，与监考后台的提交上限一致。插件配置检查返回的版本与包版本统一为 `0.2.3`。

单条及批量结果轮询均按实际返回字段读取数据库，不再先载入源代码、编译日志等未返回内容；测试点结果、子任务、成绩和判题时间继续完整返回。

`0.2.4` 保留上述查询优化，新增以下修正：

- `/api/proctor/problem/sync` 的 `testdata` 同时适用于新建和更新已有题目，按文件名增量覆盖，不删除未提供的旧文件。`testdata` 必须是“相对文件名 → 文本字符串”的对象；文件名不能包含空段、`.`、`..`、反斜杠或控制字符，去除首尾空白后不能重名。输入先全部校验，再修改题目。
- 指定非零 `id` 或 `hydroProblemId` 表示更新已有数字 docId；不存在时返回失败，不再自动创建其他编号的题目。不指定或传 `0` 才按原流程新建。多文件存储不属于一个原子事务，写入失败会返回失败，不能把部分写入当作同步成功；使用原题号重试可覆盖同名文件。
- 旧签名登录票据在签发、消费时清理过期项，未过期项最多 4096 个；满额拒绝新增，不淘汰仍有效的票据。跳转按规范化后的站内路径和路径段边界检查，拒绝跨站地址、反斜杠、控制字符及越出允许目录的跳转。

上述 `0.2.4` 题库和判题改动需要更新 Hydro 实际启用的目录并重启服务才能生效，不要求更新桌面客户端。

后台试运行、公开测试及正式答题都读取真实语言列表，按语言族分组显示具体版本，同时遵守题目及考试的限制。旧客户端的 `python`/`py` 别名仅兼容到启用的 Python 3；不会改成 Python 2 或 PyPy。禁用或题目不允许的语言不会通过别名绕过限制。

## 升级与旧数据

1. 备份并覆盖 Hydro 当前启用的整个插件目录，包含 `reaction-contest.ts`、`board-contest.ts` 及现有文件，然后重启 Hydro。原先使用内置 CCS 的部署，先按 [迁移步骤](../../docs/hydro-ccs.md#从内置-ccs-迁移) 安装独立插件、切换 Web/Recorder 和 Live/CDS。旧 CCS 设置与日志保留，不会自动迁移。
2. 保留两端现有 API-Key 和题库域。旧签名字段可保留，核心判题接口不再使用它；旧客户端带签名请求头仍兼容。
3. 更新监考后台，运行数据库更新后在后台检测连接。
4. 分别用后台试运行、公开系统测试的配置题目（后端环境变量 `PUBLIC_TEST_PROBLEM_ID`，默认 `A1`）、正式考试的 Python 3 提交验证实际判题机。

旧 Hydro 比赛页面接口 `/api/proctor/contest/*` 仍保留原有赛制及账号行为。旧登录票据 `/api/proctor/login-ticket`、`/proctor/consume-ticket` 属于兼容功能，仍需旧签名密钥、时间戳和 HMAC 校验；新版本地考试流程不使用它们。旧 `judgeAccount`、`judgePassword`、`ownerUid`、票据及赛制设置隐藏/兼容保留，不需要重新配置，也不会迁移或删除原题目、判题记录。

## 监考账号的浏览器访问限制

从 0.3.2 起，监考后台在考生登录 HydroOJ 浏览器考试时通过 API-Key 登记账号和考试截止时间。该 Hydro 账号在所有域的页面、接口、文件和 WebSocket 访问均须携带已绑定的客户端会话及专用凭据；仅伪造浏览器名称或复制登录 Cookie 不能放行。已有客户端无需更新。

限制持续至登记的考试截止时间或 Hydro 比赛结束，普通浏览器随后自动恢复访问；关闭客户端、断网或提前交卷不会提前解除整场比赛的限制。修改监考考试的结束时间会同步更新登记截止时间。已有登录账号的 WebSocket 每两秒重新检查限制。此限制针对相应 Hydro 登录账号，不是对设备、IP 或未登录访客的封禁。

### WebView2 109 实时连接

0.3.7 支持 Windows 固定版客户端。客户端沿用考试配置中的 Hydro 地址，用已绑定的会话和监考凭据请求 90 秒的 WebSocket 凭据，并将凭据写入三个连接路径各自的 HttpOnly Cookie。Hydro 验证请求来源、会话、比赛范围及判题记录所属比赛。凭据续期时原有连接保持打开，考试保护期间的复查要求原始绑定、会话和有效的续期记录。

使用 wxWidgets 客户端前需更新 Hydro 插件。Electron 客户端可继续用原有请求头完成 WebSocket 鉴权。数据库沿用现有监考绑定集合。

### WKWebView 网页与实时连接

0.3.8 支持 macOS 客户端在同一 HTTPS Hydro 站点使用网页和实时连接。原生客户端通过现有接口出示会话与监考请求头，并在申请 WebSocket 凭据时请求网页凭据。网页凭据有效期为 90 秒，由客户端写入当前站点各路径的 HttpOnly Cookie。Hydro 同时检查当前会话、监考绑定、比赛和请求路径。重新登录会使之前的网页凭据失效。

更新 Hydro 正在使用的插件目录并重启服务。若由反向代理终止 TLS，请按 Hydro 的代理配置保留公开 Host 和 HTTPS 请求协议。现有 Windows 和 Electron 鉴权方式继续可用。

## 验证

插件测试使用 Hydro 的原生设置注册器和隔离的模型替身，不连接生产 MongoDB：

Reaction 接口与浏览器保护的隔离测试无需 Hydro 安装，在监考仓库根目录运行 `node --test hydro-plugin/cwnupaa-proctor-auth/tests/reaction.test.cjs`。

```bash
HYDRO_SOURCE_ROOT=/path/to/Hydro node --test hydro-plugin/cwnupaa-proctor-auth/tests/config.test.cjs
```

测试验证仅 API-Key 调用、Python 别名、语言限制、直接排队、跨判题机语言合并以及查询记录不读取用户或比赛模型。
