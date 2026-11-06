# Reaction 的 NovaJudge CCS 授权配置

**CCS 账号密码填写在监考服务器的 `apps/web/.env`，目前没有网页密码填写框。** 考试详情 → Reaction 录像中可展开“首次使用：CCS 授权在哪里填写？”查看配置位置与本场内部考试 ID；页面的开关只控制本场是否采集，不会代替服务器授权。配置入口示例在 [`apps/web/.env.example`](../apps/web/.env.example)；保留已有 `.env`，只添加或修改对应项，不要用示例文件覆盖现有数据库、媒体或登录配置。

该授权用于服务器请求 NovaJudge 的 `/api/ccs/contests/{contestId}/event-feed`。它与监考管理员登录、考生登录、视频发布密钥及 NovaJudge 外榜 API Key 分开。

## 1. 使用哪个账号

当前 NovaJudge 的 `lib/ccs/auth.ts` 在 Basic Auth 路径中查询 **`GlobalUser`，要求角色为 `SUPER_ADMIN`，并验证该账号在数据库中保存的密码**。可以使用已有合法全局超级管理员账号，无须为每场比赛重新注册账号或执行“授权比赛”。

- 比赛内 `User` 的 `ADMIN` 账号不能直接作为此 Basic 账号。
- 浏览器登录 NovaJudge 不会给 Recorder 提供凭据。NovaJudge 本身也支持 Cookie 认证，但当前 Recorder 仅发送 Basic，不读取或转发浏览器 Cookie。
- `x-api-key` 不被当前 CCS 认证读取。外榜或其他 NovaJudge API 已能访问，不代表 CCS 认证成功。
- 比赛未开始、正在进行或已经结束，不改变 Basic 验证规则；PRIVATE 比赛也可由有效全局超级管理员 Basic 访问。
- 如果修改了 NovaJudge 全局账号密码，必须更新监考服务器配置并重启实际读取它的进程。仅修改 NovaJudge 的初始化环境变量，不等于修改数据库内已有账号的密码。

## 2. 单个 NovaJudge 服务：配置默认凭据

在监考仓库的 `apps/web/.env` 添加以下三项，将占位符替换为自己服务的真实配置：

```dotenv
REACTION_CCS_ORIGIN=https://judge.example.org
REACTION_CCS_USERNAME=YOUR_EXISTING_GLOBAL_SUPER_ADMIN
REACTION_CCS_PASSWORD='YOUR_PASSWORD'
```

本机 HTTP 示例的 origin 可以为 `http://127.0.0.1:3001`，前提是考试的平台地址也使用这个 origin。示例域名、用户名和密码不是可用账号。

同一 origin 下的新 NovaJudge 比赛，会自动复用这组三项；仍需在监考系统创建或关联对应考试，并分别开启该考试的 Reaction。新比赛不需要再次创建 CCS 账号。默认值只覆盖一个 origin，多服务或个别考试需要独立配置时使用下一节。

凭据保留在服务器，不添加 `NEXT_PUBLIC_` 前缀，不放入客户端源码、提交记录、下载的 metadata 或公开日志。`.env` 已被 Git 忽略。密码含 `#`、空白等字符时必须使用适合所用环境文件解析器的引号；引号、换行、`$` 等特殊字符在 Node、Next.js 和 Compose 中可能有不同解析规则，复杂值优先由服务管理器或密钥管理系统注入**原始环境变量值**，并以实际 HTTP 检查为准。

## 3. 按监考考试覆盖默认值

可在同一环境文件内加入单行 JSON map：

```dotenv
REACTION_CCS_CREDENTIALS='{"YOUR_PROCTOR_EXAM_ID":{"origin":"https://judge.example.org","username":"YOUR_EXISTING_GLOBAL_SUPER_ADMIN","password":"YOUR_PASSWORD"},"ANOTHER_PROCTOR_EXAM_ID":{"origin":"https://other-judge.example.org","username":"ANOTHER_GLOBAL_SUPER_ADMIN","password":"ANOTHER_PASSWORD"}}'
```

`YOUR_PROCTOR_EXAM_ID` 指监考数据库的 **`Exam.id`**，即管理页地址 `/dashboard/exams/{id}/reactions` 中的 `{id}`。它不是10位考试编号 `examCode`，也不是 NovaJudge 的比赛编号 `platformContestId`。

凭据选择顺序与 [`ccsCredential()`](../apps/web/src/lib/reaction-domain.ts) 一致：

1. 若 JSON map 中存在该 `Exam.id` 的配置项，使用这一整项。
2. 否则使用默认的 `REACTION_CCS_ORIGIN`、`REACTION_CCS_USERNAME`、`REACTION_CCS_PASSWORD`。

**不会逐字段合并。** 一项配置必须同时包含非空 `origin`、`username`、`password`；旧项中有错误密码时，修改默认密码不会覆盖它。需要复用默认值时，从 map 中移除对应考试项。完全不需要按考试覆盖时可移除该变量或设置为 `{}`。保留合法 JSON 对象，不能添加注释或尾随逗号；无效 JSON 会阻止凭据解析，即使默认三项正确也一样。

## 4. Origin 必须严格一致

系统计算 `new URL(exam.platformBaseUrl).origin`，然后与配置的 `origin` 做字符串相等比较。origin 仅含协议、主机、非默认端口，不含路径、查询参数或末尾 `/`。

| 考试平台地址 | 应填写的 `REACTION_CCS_ORIGIN` / map `origin` |
| --- | --- |
| `http://127.0.0.1:3001` | `http://127.0.0.1:3001` |
| `http://localhost:3001` | `http://localhost:3001` |
| `https://judge.example.org/` | `https://judge.example.org` |
| `https://judge.example.org:443` | `https://judge.example.org` |

`localhost` 与 `127.0.0.1` 不互换，HTTP 与 HTTPS 不互换，端口不同也不匹配。连接不会跟随重定向携带凭据。若部署地址会跳转，应在考试平台地址和凭据中使用真实最终 origin。

只有 `localhost`、`127.0.0.1`、`[::1]` 允许 HTTP；其他主机必须 HTTPS，包括局域网 IP、Docker 服务名和 `host.docker.internal`。不要关闭证书校验来绕过连接错误。Docker 容器中的 `localhost` 指该容器，不是宿主机；容器应使用其能访问、证书有效且与考试配置一致的 HTTPS origin。

## 5. 启动与修改后重启（Windows / PowerShell）

以下命令从**监考仓库根目录**开始，前提是已经按项目文档安装 Node、项目依赖（含 `tsx`）、生成 Prisma 客户端并准备好数据库。这里不初始化数据库、不创建账号。

### 前台运行：两个 PowerShell 窗口

窗口一启动管理后台：

```powershell
Set-Location .\apps\web
node node_modules/next/dist/bin/next dev -p 4031
```

窗口二启动 Recorder：

```powershell
Set-Location .\apps\web
node --env-file=.env --import tsx scripts/reaction-recorder.ts
```

必须在 `apps/web` 目录执行 Recorder 命令，`.env` 的路径相对于当前工作目录。`pnpm reaction:recorder` 是同目录下的等价项目脚本。不要同时运行两个入口。

修改凭据后，在上述两个运行窗口各按一次 **Ctrl+C**，等待进程退出，再分别重新运行各自命令。已经运行的进程不会因为磁盘 `.env` 改动而自动更新 Recorder 的环境。避免在旧进程仍运行时反复启动新 Recorder；租约用于故障恢复，不是配置热更新机制。异常终止后旧租约最多约60秒过期，新进程随后接管。

Web 和 Recorder 的配置读取不同：

| 进程 | 配置来源与作用 |
| --- | --- |
| Next.js Web | 按 Next.js 规则读取进程环境、`.env.local`、对应环境的 `.env.*` 和 `.env`；负责管理页的配置存在检查与开启校验。 |
| 上述 Recorder 命令 | Node 显式读取 `apps/web/.env`；不会自动读取 Next.js 的 `.env.local` / `.env.production`。已有进程环境变量优先于 `--env-file` 文件值。负责真实 CCS HTTP 连接、裁剪和生成队列。 |

因此，“凭据已配置”仅说明 **Web 进程的本地配置检查通过**，并未校验远端密码，也不能证明 Recorder 已加载同一配置。应让两个进程使用一致的有效值，并确认 Reaction 页的 Event Feed 最终显示 `CONNECTED`。生产模式也应重启对应 Web 服务和 Recorder 服务；只刷新浏览器没有效果。


## 6. Docker：配置必须进入实际运行进程

当前根目录 `docker-compose.yml` **没有独立 Recorder 服务，也没有转发 `REACTION_CCS_*` 变量**。Compose 的项目根 `.env` 默认用于变量替换，不会把所有值自动传进容器；仅编辑宿主机 `apps/web/.env` 也不会自动改变容器环境。

已有 Docker Web 部署可先使用以下方式注入凭据。在 Git 忽略的 `.local/reaction-ccs.env` 中填写第2、3节的凭据变量，不复制数据库或初始化账号配置。然后新建 `.local/reaction-ccs.compose.yml`：

```yaml
services:
  web:
    env_file:
      - ./.local/reaction-ccs.env
```

路径相对于第一份 Compose 文件所在的仓库根目录。Compose 的 `environment` 同名项优先于 `env_file`，要检查自己已有的覆盖文件。若使用 `$` 等特殊字符，按照所用 Compose 版本的环境文件规则保存；不要通过输出完整 `docker compose config` 来公开验证密码。

在仓库根目录、现有基础服务已就绪时更新 Web 容器环境（若原部署使用其他 `-p` / `-f` 参数，应保留它们）：

```powershell
docker compose -f docker-compose.yml -f .local/reaction-ccs.compose.yml up -d --no-deps web
```

这是正常的 Web 容器重建/重启，会短暂影响后台访问；使用既有卷，不执行 `down -v`。现有 Compose 的 Web 启动命令仍会执行项目原有 `db:push` / `db:seed`，部署者应按既有维护流程操作。

一次前台连通性验证可以在这个 Web 容器内启动**独立 Node 进程**，继承容器已经注入的环境：

```powershell
docker compose -f docker-compose.yml -f .local/reaction-ccs.compose.yml exec --workdir /app/apps/web web node --import tsx scripts/reaction-recorder.ts
```

此命令不是持久化 Recorder 服务，也不自动安装官方 Python 视频生成器；Ctrl+C 停止后不再运行。已有其他 Recorder 时先停止原实例。正式部署应为该命令配置独立守护进程或单独服务，显式传入相同 CCS、数据库及存储环境，挂载同一录像存储，并按 [生成器文档](reaction-generator.md) 安装依赖。不要假设存在名为 `recorder` 的 Compose 服务，也不要只给 Web 注入凭据而遗漏独立 Recorder。更新环境后重建对应容器；`docker compose restart` 不会应用新的容器环境配置。

## 7. 只读验证：检查实际配置与 HTTP 状态

在本机 Recorder 停止或运行期间均可做以下一次性检查。它只读取考试配置，使用与 Recorder 相同的凭据选择函数发送有限的 `stream=false` 请求，不保存事件、不提交代码、不修改数据库，也不输出密码、Authorization 或响应内容。

从仓库根目录进入 `apps/web` 后执行；输入监考内部 `Exam.id`：

```powershell
Set-Location .\apps\web
$env:REACTION_CHECK_EXAM_ID = Read-Host '监考内部 Exam.id（管理页 URL 中的 id）'
@'
import { prisma } from './src/lib/db.ts';
import { ccsCredential } from './src/lib/reaction-domain.ts';
try {
  const exam = await prisma.exam.findUnique({
    where: { id: process.env.REACTION_CHECK_EXAM_ID || '' },
    select: { id: true, platform: true, platformBaseUrl: true, platformContestId: true },
  });
  if (!exam || exam.platform !== 'NOVAJUDGE' || !exam.platformContestId) {
    console.error('EXAM_NOT_FOUND_OR_NOT_BOUND_TO_NOVAJUDGE');
    process.exitCode = 1;
  } else {
    let credentials;
    try { credentials = ccsCredential(exam); }
    catch { console.error('CCS_LOCAL_CONFIG_INVALID: check JSON, exact origin, credentials and HTTPS'); process.exitCode = 1; }
    if (credentials) {
      const endpoint = `${credentials.origin}/api/ccs/contests/${encodeURIComponent(exam.platformContestId)}/event-feed?stream=false&runs=false`;
      const response = await fetch(endpoint, {
        headers: { authorization: credentials.authorization },
        redirect: 'error', signal: AbortSignal.timeout(30000),
      });
      console.log(`CCS_HTTP_${response.status}`);
      await response.body?.cancel();
      if (!response.ok) process.exitCode = 1;
    }
  }
} catch {
  console.error('CHECK_FAILED: inspect database availability, DNS, network, HTTPS certificate and redirects');
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
'@ | node --env-file=.env --import tsx --input-type=module
Remove-Item Env:REACTION_CHECK_EXAM_ID
```

HTTP 200 验证该次服务器请求通过，不表示视频源、缓存和合成已经验收。上述命令验证新进程读取到的 `.env`；若它返回200但运行中的 Recorder 仍401，检查旧进程未重启、服务管理器覆盖变量或不同工作目录。容器/生产服务也应在其实际环境中验证，不能用宿主机成功代替容器成功。

## 8. 常见错误与最小修复

| 现象 | 含义与排查 |
| --- | --- |
| 页面提示未配置凭据，或开启时提示 `CCS credentials are missing for this exact origin` | Web 的本地配置未通过。检查三项是否非空、origin是否严格匹配、按考试 map 是否覆盖默认值，以及 `.env.local` / 进程变量是否覆盖 `.env`。重启 Web；同时给 Recorder 一致配置。 |
| `CCS credential configuration is invalid` | `REACTION_CCS_CREDENTIALS` 不是合法 JSON。修正为对象；不用覆盖时设为 `{}` 或移除该变量。 |
| `CCS requires HTTPS outside loopback` | 当前 origin 非允许的回环主机却使用 HTTP。配置可达且证书有效的 HTTPS 地址，不绕过校验。 |
| Event Feed `CCS_HTTP_401` | 请求到达了 HTTP 服务，但认证被拒绝。核对使用的是 NovaJudge `GlobalUser SUPER_ADMIN` 及当前数据库密码；排查旧 map 覆盖、旧进程环境、错误服务/数据库或代理未转发 `Authorization`。当前 NovaJudge 比赛不存在本身不会导致401；它先认证，再查比赛。无需新增比赛内管理员。 |
| Event Feed `CCS_HTTP_403` | 先确认响应来自 NovaJudge 还是网关/WAF。当前 NovaJudge 这条认证失败分支返回401，不返回403；检查网关访问策略、路径及请求头转发。不要通过取消鉴权处理。 |
| Event Feed `CCS_HTTP_404` | 直接到达当前 NovaJudge 且认证成功时，检查 `platformContestId` 是否存在于该服务的数据库。反向代理路径错误或请求到其他服务也可能404。URL使用 NovaJudge 比赛ID，不是监考 `Exam.id`。 |
| `CCS_DISCONNECTED_OR_INVALID_EVENT` | Recorder 将本地配置错误、网络/证书/重定向故障和无效事件统一脱敏。先用上述只读检查区分本地配置与HTTP，再查网络和服务日志；它不等同于密码错误。 |
| 管理页/API 返回401或403，但没有 `CCS_HTTP_*` 前缀 | 这是监考平台自身的登录/考试管理权限或写操作来源检查，不能通过改 CCS 密码修复。使用有本场管理权限的监考账号访问。 |
| 页面配置已就绪，Event Feed 为 `STOPPED` | 检查本场开关、Recorder 是否启动、数据库连接与租约。开启成功不等于后台工作进程已经运行。 |

修复凭据后保留该考试现有 Reaction 开启状态并重启进程即可重连，不需要反复关闭再开启。关闭再开启会重设事件起点，关闭期间历史提交不会补录。最后在管理页确认 `CONNECTED`，再用新的真实提交验证录像，完整流程见 [Reaction 使用说明](reactions.md)。
