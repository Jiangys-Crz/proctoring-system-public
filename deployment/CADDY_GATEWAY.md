# Caddy 统一入口部署

本方案适用于 Caddy 运行在宿主机、Docker 容器运行应用的服务器。保留现有 Hydro、协会网站等 Caddy 站点，将监考网站、RTMPS 和 WebRTC 均接入同一个 Caddy。标准 Caddy 的 HTTP `reverse_proxy` 不能转发媒体 TCP/UDP，须使用带 `github.com/mholt/caddy-l4` 的 Caddy 二进制。

## 域名和公网端口

| 域名 | 用途 | 公网入口 | Caddy 转发目标 |
| --- | --- | --- | --- |
| `proctoring.example.org` | 后台、下载、API 和媒体信令 | HTTPS / TCP 443 | `127.0.0.1:4031` |
| `proctorstu.example.org` | 学生答题、手机第二机位登录 | HTTPS / TCP 443 | `127.0.0.1:4032` |
| `proctorstream.example.org` | 原生手机 App 的 RTMPS | RTMPS / TCP 443 | 解密后转发到 `127.0.0.1:1935` |
| `proctorrtc.example.org` | 桌面、手机网页、后台观看的 WebRTC 媒体 | ICE / TCP、UDP 443 | `127.0.0.1:8189` TCP、UDP |

四个域名均直接解析到这台 Caddy 服务器的公网 IP。DNS 记录没有端口。媒体域名不能经过只支持 HTTP 的 CDN/代理；IPv6 记录也必须指向同一台可达网关。

安全组和宿主机防火墙需要放行 **TCP 80、TCP 443、UDP 443**，共两个端口号、三条协议规则。TCP 80 用于证书申请和 HTTPS 跳转。`4031`、`4032`、`1935`、`1936`、`8189`、`8889`、`8080`、`9997`、`3307` 均不需要对公网开放。应用 Compose 将发布的端口绑定在 `127.0.0.1`。

TCP 443 按连接类型区分 HTTPS、RTMPS 和 WebRTC ICE-TCP；WebRTC UDP 使用 UDP 443。本方案关闭 Caddy 的 HTTP/3，为 WebRTC 保留 UDP 443，原有网站继续使用 HTTP/1.1 和 HTTP/2。WebRTC 不是普通 HTTP 网站，`proctorrtc` 无需增加 `reverse_proxy` 网站块，也无需单独的 HTTPS 证书。

## 1. 准备带扩展的 Caddy

在服务器仓库目录执行以下命令，用 Docker 构建适合本机架构的二进制。已验证版本为 Caddy 2.11.7、caddy-l4 0.1.2：

```bash
mkdir -p .cache/caddy-build
docker run --rm \
  -e XCADDY_SETCAP=0 \
  -e 'GOPROXY=https://goproxy.cn|https://proxy.golang.org|direct' \
  -v "$PWD/.cache/caddy-build:/out" \
  -v "$PWD/.cache/caddy-build/go-pkg:/go/pkg" \
  caddy:2.11.7-builder \
  xcaddy build v2.11.7 \
  --with github.com/mholt/caddy-l4@v0.1.2 \
  --output /out/caddy
sudo install -m 755 .cache/caddy-build/caddy /usr/local/bin/caddy-l4
/usr/local/bin/caddy-l4 list-modules | rg 'layer4'
```

服务器未安装 `rg` 时，最后一条可改为 `list-modules | grep layer4`。模块列表应包含 `caddy.listeners.layer4`、`layer4` 和对应 handlers。构建使用国内 Go 模块镜像，并在失败时依次尝试官方代理和源码下载；模块缓存保存在 `.cache/caddy-build/go-pkg`，重试不会丢失已有下载。未关闭模块校验。如果所有下载源均不可达，仍需先解决服务器网络。

若日志显示访问 `proxy.golang.org` 超时，说明旧命令未设置国内镜像，重新执行上述构建即可。必须确认构建成功且 `.cache/caddy-build/caddy` 存在后再安装；`install: cannot stat .../caddy` 是构建失败后没有生成二进制的结果，此时原 Caddy 仍未被替换。

使用独立的 `/usr/local/bin/caddy-l4` 路径，避免覆盖 Hydro/Nix 管理的原有二进制。现有 Caddy 进程必须切换到新二进制并重启一次；用旧进程执行 `reload` 无法增加扩展。新进程使用原有运行用户、工作目录和证书存储环境。

## 2. 修改现有 Caddyfile

`deployment/Caddyfile.hydro.gateway` 是仅包含示例监考站点与可选 Hydro 反向代理的通用配置。所有 `example.org` 和 `example.test` 域名均须替换为自己的域名；示例中的 Hydro 上游端口也须按安装情况调整。它不包含其他业务站点，不能直接覆盖共享服务器上的现有配置。

先备份当前 Caddyfile。将 `deployment/Caddyfile.gateway` 开头的 `{ ... }` 全局配置合并到现有 Caddyfile 的最前面；若已有全局配置，应合并到同一个全局块。保留服务器已有的其他站点，再添加文件末尾的 `proctoring`、`proctorstu`、`proctorstream` 三个站点块；已有同名块时替换，不重复声明。

`proctorstream` 的 HTTPS 404 站点用于触发 Caddy 自动申请、续期域名证书。RTMPS 连接由 Layer 4 接入并使用同一个证书缓存，MediaMTX 无需读取或挂载任何公网私钥。

例如 Caddyfile 位于 `~/.hydro/Caddyfile`：

```bash
cp ~/.hydro/Caddyfile ~/.hydro/Caddyfile.before-proctor-gateway
/usr/local/bin/caddy-l4 fmt --overwrite ~/.hydro/Caddyfile
/usr/local/bin/caddy-l4 validate --config ~/.hydro/Caddyfile --adapter caddyfile
```

备份须在编辑之前执行。校验成功后再切换运行进程。若 Hydro 使用默认 PM2 进程管理方式，先用 `pm2 describe caddy` 确认当前进程名、用户和工作目录，在原运行用户下执行：

```bash
pm2 delete caddy
pm2 start /usr/local/bin/caddy-l4 --name caddy --cwd "$HOME/.hydro" -- \
  run --config "$HOME/.hydro/Caddyfile" --adapter caddyfile
pm2 save
pm2 logs caddy --lines 100
```

切换时网站会短暂中断。若使用 systemd，应修改原 Caddy unit 的启动/重载二进制路径，保留原用户、目录、环境和参数，再重启该 unit；不要同时启动另一个占用 80/443 的 Caddy。非 root 的运行用户还需要原服务具有绑定 80/443 的权限，例如 systemd 的 `CAP_NET_BIND_SERVICE` 或给新二进制授予该 capability。

以后重载使用新二进制：

```bash
/usr/local/bin/caddy-l4 reload --config ~/.hydro/Caddyfile --adapter caddyfile
```

## 3. 手动配置 .env

新部署可复制根目录 `.env.caddy.example` 到 `.env`，替换所有 `CHANGE_ME`。已有部署保留原来的数据库密码、数据库名称、认证密钥及外部接口配置，只更新以下值：

```env
PROCTOR_WEB_HOST_PORT=4031
PROCTOR_CLIENT_WEB_HOST_PORT=4032
APP_BASE_URL=https://proctoring.example.org
MEDIA_RTMPS_PUBLIC_BASE=rtmps://proctorstream.example.org:443
MEDIA_WEBRTC_ADDITIONAL_HOSTS=proctorrtc.example.org
MEDIA_AUTH_HTTP_ADDRESS=http://web:4031/api/media/auth
```

更新旧部署时，务必将已有的 `MEDIA_RTMPS_PUBLIC_BASE` 端口从 `1936` 改成 `443`。Compose 不会覆盖 `.env` 中的旧值；Caddy 的 RTMPS TLS 入口是公网 443，1935 和 8189 仅用于内部转发。四个公开域名分别承担后台 HTTPS、考生网页 HTTPS、RTMPS、WebRTC ICE；WHIP/WHEP 信令仍使用后台 HTTPS 域名。

本方案不使用 `MEDIA_TLS_CERT_PATH` 和 `MEDIA_TLS_KEY_PATH`，可从 `.env` 删除。`DATABASE_URL` 仍使用 Compose 内部数据库地址 `mysql:3306`；不填写宿主机的 `3307`。WHIP/WHEP 信令和 HLS 经后台鉴权转发，不增加公开媒体 API 端口。

## 4. 启动应用

已有部署更新使用以下命令。脚本将构建限制在 2048 MiB 内存和 2 个 CPU 内，顺序构建后台与考生网页；两个镜像均成功后才更新运行容器。依赖安装使用单个导入工作线程、单个安装脚本进程和 512 MiB Node 堆上限；镜像编译使用 Webpack、1024 MiB Node 堆上限和单个页面生成进程，保留完整类型检查。构建失败时继续运行旧镜像。不要在共享服务器上并行执行 `up -d --build` 或同时构建两个 Next.js 应用。

本次只更新后台时，在脚本后加 `web`：`bash scripts/deploy-caddy.sh web`。该模式只构建和替换后台容器，保留当前客户端；省略参数仍更新两个服务。

```bash
git pull --ff-only
bash scripts/deploy-caddy.sh
curl -f http://127.0.0.1:4031/api/health
```

在服务器仓库目录执行：

```bash
git pull --ff-only
docker compose -f docker-compose.caddy.yml config --quiet
docker compose -f docker-compose.caddy.yml up -d mysql
docker compose -f docker-compose.caddy.yml logs -f mysql
```

MySQL 显示 `ready for connections` 后按 Ctrl+C 退出日志查看，再启动应用：

```bash
docker compose -f docker-compose.caddy.yml up -d --no-build mysql media uploads-init
bash scripts/deploy-caddy.sh
docker compose -f docker-compose.caddy.yml ps -a
docker compose -f docker-compose.caddy.yml logs --tail=100 web client-web media
curl -f http://127.0.0.1:4031/api/health
```

MySQL 首次初始化需要一段时间。Compose 用应用数据库账号通过 TCP 执行 `SELECT 1`，确认数据库及账号可用后才启动后台，避免仅等待容器创建就连接数据库。`ps -a` 中 MySQL 应显示 `healthy`。容器内 `.env not found` 提示正常，环境配置由 Compose 注入，不需要另复制应用 `.env`。

必须指定 **`-f docker-compose.caddy.yml`**。这是独立的 Compose 文件，不是叠加文件，不要同时加 `-f docker-compose.yml`，否则可能合并出旧的公开端口和证书挂载。

已有 Compose 部署在同一个仓库目录、相同项目名下切换此文件，会继续使用原命名卷。若之前使用了 `-p` 或 `COMPOSE_PROJECT_NAME`，必须继续使用同一值。不要运行 `down -v`，避免删除数据库和上传数据。未来更新仍使用此 Compose 文件。

MediaMTX 在容器内用 443 监听 ICE，Docker 仅将其映射到宿主机回环 8189；它签发的 ICE candidate 端口是公网 **443**，从而让客户端连接 Caddy。只修改 Caddyfile 而继续使用原媒体配置，会使客户端仍连接 8189。

### 后台镜像停在 Debian 系统依赖下载

后台镜像需要 Chromium、中文字体和 FFmpeg。若构建长时间停在从 `deb.debian.org` 下载软件包，可按 Ctrl+C 结束本次构建，更新仓库后重试。Dockerfile 和两套 Compose 默认使用清华 Debian 及 Debian Security 镜像；保留原有 APT 签名和 HTTPS 校验，并设置 30 秒连接/空闲超时、3 次重试。镜像不可达时构建会报告具体下载错误。

学生网页镜像已经成功构建时，可只重建后台并显示完整下载日志：

```bash
git pull --ff-only
bash scripts/deploy-caddy.sh web
curl -f http://127.0.0.1:4031/api/health
```

现有 `.env` 不必增加字段，默认镜像会自动生效。若服务器到默认镜像的网络仍不可达，可在 `.env` 单独设置 `DEBIAN_MIRROR` 和 `DEBIAN_SECURITY_MIRROR` 后重新构建；应使用分别提供 Debian 主仓库与安全更新仓库的镜像地址。例如恢复官方源：

```env
DEBIAN_MIRROR=https://deb.debian.org/debian
DEBIAN_SECURITY_MIRROR=https://security.debian.org/debian-security
```

重新构建不会更改 MySQL 和上传文件的命名卷，也无需重装 Caddy。系统依赖层改变会触发后台后续层重新构建；已完成的学生网页镜像可继续使用。

### 后台依赖下载出现 `ERR_SOCKET_TIMEOUT` 或 `TimeoutError`

若日志停在 `pnpm install`，并显示 `registry.npmmirror.com/next/-/next-*.tgz` 下载超时，这是依赖源连接失败，尚未进入网页编译。BuildKit 启动时的 `Max Used Space`、`Min Free Space` 是缓存清理策略，不能据此判断磁盘已满。

后台构建默认先从 npm 官方源下载，失败后自动尝试 npmmirror。pnpm 本身的安装也使用相同回退机制；包下载并发降为 4，单次请求超时为 180 秒、重试 1 次。BuildKit 为 npm、pnpm 和 Prisma 引擎分别保存下载缓存，重试时可复用已下载内容；锁文件、依赖版本及完整性校验保持不变。依赖文件安装在镜像中，运行容器不需要挂载构建缓存。

更新后按以下命令重试，只替换后台：

```bash
git pull --ff-only
bash scripts/deploy-caddy.sh web
curl -f http://127.0.0.1:4031/api/health
```

现有 `.env` 无需修改。若需要使用服务器可访问的其他 npm 仓库，可设置 `NPM_REGISTRY` 和 `NPM_FALLBACK_REGISTRY`；后者留空可禁用备用源。Prisma 引擎使用独立下载服务，切换 npm 仓库不会改变引擎地址。保留同一个 `proctor-limited` builder，不要使用 `--no-cache`、删除 builder 或清空下载缓存；两个仓库均失败时脚本停止，现有运行容器继续提供服务。

### 编译成功后停在权限设置

如果路由列表之后已经显示 `DONE`，接着停在 `chown`，说明编译成功，当前正在设置镜像中的文件权限。旧 Dockerfile 对整个 `/app` 递归改权限，会处理大量 pnpm 依赖文件；新配置仅处理上传目录、Next.js 构建/缓存目录和 Prisma 生成目录。Prisma 生成目录保留可写权限，以兼容启动时 `db:push` 中的客户端生成。

按 Ctrl+C 结束旧构建后执行上述更新、重建后台和启动命令。不使用 `--no-cache`，以便复用已经完成的依赖安装和编译层。镜像导出期间仍可能有一段没有新增日志的时间，可另开终端用 `df -h`、`free -h` 和 `top` 查看磁盘及资源状态。

若镜像已经成功导出，当前部署可先继续使用已有镜像，通过 `git pull --ff-only` 更新 Compose 后执行 `docker compose -f docker-compose.caddy.yml up -d --no-build`，无需为了健康检查重新构建。权限范围的优化在下一次后台镜像构建时生效。如果 `ps -a` 仍显示 `127.0.0.1:3401->4031`，手动将根目录 `.env` 的 `PROCTOR_WEB_HOST_PORT` 改成 `4031` 并重新运行 `up -d --no-build`；`.env` 的显式值会覆盖 Compose 默认值。

## 5. 验证

```bash
curl -f https://proctoring.example.org/api/health
curl -I https://proctorstu.example.org/
openssl s_client -connect proctorstream.example.org:443 \
  -servername proctorstream.example.org </dev/null
```

最后一条验证 RTMPS TLS 握手，证书应匹配推流域名。RTMP 是二进制协议，随后关闭连接并不意味着推流失败；实际推流需用对应客户端验证。

再使用手机网页第二机位和桌面系统测试，确认后台的三路视频均可看到。浏览器 WebRTC 统计中的远端 candidate 应使用网关 IP 和端口 443。UDP 被客户端网络阻断时可尝试 ICE-TCP；若客户端网络只允许真正的 HTTPS 而拦截 raw ICE TCP，则需另行部署 TURN，这个方案未包含 TURN。

桌面客户端的新域名逻辑需要重新打包并在后台发布；已有安装包不会随服务端更新自动替换。

## 本地验证范围

配置使用带 caddy-l4 的 Caddy 进行语法及模块校验，并用独立测试网关验证 HTTPS 转发、RTMPS TLS 解密转发以及 ICE TCP/UDP 双向转发。MediaMTX 启动及 WHIP SDP 应答验证了 TCP/UDP candidate 均使用 443。服务器证书申请、服务器防火墙和真实客户端音视频需在部署后按上面的步骤验证。

后台镜像还在独立测试数据库和网络中验证了首次数据库初始化后的账号健康检查、非 root Prisma 客户端重新生成、数据库结构更新、seed、HTTP 健康接口以及上传/Next.js 缓存目录写入。

参考：[caddy-l4 协议混合代理示例](https://github.com/mholt/caddy-l4/blob/master/docs/examples/combining_apps.md)、[caddy-l4 Server 配置](https://github.com/mholt/caddy-l4/blob/master/docs/servers.md)。

新生产部署需在根目录 `.env` 设置独立且至少 12 位的 `BOOTSTRAP_ADMIN_PASSWORD`；不设置则管理员初始化失败。已有管理员及初始化标记会保留，不重置密码。
