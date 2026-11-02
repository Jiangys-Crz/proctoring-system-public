# CWNU PAA 第二机位原生 App

Android 使用 Kotlin、Compose、RootEncoder 2.5.5；iOS 使用 Swift、UIKit、HaishinKit 1.9.9。登录材料在本机拍摄，获得后台签发的上传凭据后上传；审核及恢复成功后，通过 RTMPS 发布第二机位画面，持续发送心跳、接收与回复语音。

## 连接与身份

服务器地址必须是 **HTTPS origin**，默认线上入口为 `https://proctoring.example.org`。地址不得包含用户名、密码、路径、查询参数或片段。证书必须受设备信任，生产环境使用与域名匹配的可信证书。Docker 后台宿主机端口 4031（容器内部 HTTP 4031）、学生网页内部 4032 由部署代理提供 HTTPS；原生 App 不直接连接明文地址。

扫码支持电脑生成的 HTTPS 网页二维码与旧 JSON 初始配对二维码。初始登录仅带配对码；电脑已验证身份时，二维码片段携带短期 `credentialTicket`，App 核对后只补拍材料。恢复二维码必须带 `recoverySecret`，六位码本身不能恢复已有会话。初始配对的 `pollToken` 只在桌面内存中使用，不进入二维码。

会话令牌绑定到签发服务器 origin。更换服务器会清理旧会话；Android 将令牌加密存入 Android Keystore，禁止备份与明文连接；iOS 将令牌放入本机 Keychain，禁止任意 ATS 明文加载。后台返回 `CLIENT_SESSION_REVOKED` 时，客户端停采集、清令牌、回登录页。客户端不会从已切换服务器的旧响应安装新令牌。

## 接口契约

| 接口 | 用途 |
| --- | --- |
| `GET /api/client/exams` | 获取考试；身份请求含十位 `examCode` |
| `POST /api/client/candidate-verify` | 完整身份校验 |
| `POST /api/client/credential-login`，`action: inspect` | 核对电脑材料凭据，读取考试与考生信息 |
| `POST /api/client/material-upload-ticket` | 完整身份或 `credentialTicket`，加 `pairCode`、`miniProgramDeviceId`，获取材料上传凭据 |
| `POST /api/client/upload` | 材料上传头必须带 `x-proctor-upload-ticket`；返回自有材料的 `stored.objectPath` 或 `segment.objectPath` |
| `POST /api/login-requests` | 完整身份、上传凭据、两项自有材料路径，提交请求 |
| `POST /api/client/credential-login` | 材料凭据模式提交：`credentialTicket`、设备 ID、`uploadTicket`、两项材料路径 |
| `POST /api/client/reconnect` | `pairCode`、`recoverySecret`、`deviceId`，绑定恢复的第二机位 |
| `GET /api/client/media-publish` | 使用客户端认证头，查询 `sessionId` 与 `channel=MOBILE_CAMERA`，获取专用媒体发布凭据 |
| `POST /api/client/heartbeat` | `side: MINIPROGRAM`；摄像头状态按真实发布连接上报 |
| `GET/POST /api/client/voice`、`POST /api/client/alerts` | 经认证 HTTPS 收发语音与异常 |

发布接口返回 `{url,token,expiresAt}`。客户端只接受 `rtmps://媒体域名:1936/<sessionId>/MOBILE_CAMERA?token=<短期专用发布凭据>`。普通客户端会话令牌不进入媒体 URL；断线重连时重新获取发布凭据。服务器必须开启 RTMPS TLS 并校验发布凭据。Android 额外在系统 CA 校验后检查证书 SAN 与媒体主机名，修补当前 RootEncoder 未传 TLS serverName 的限制；iOS 使用系统 Network TLS。

监考播放继续走有权限的后台 HTTPS 媒体代理。不要直接公开 MediaMTX 读取端口，不要给第三方推流软件或考生分发会话令牌。

## 构建

Android：Android Studio 打开 `android`，使用 JDK 17+、Android SDK 35 和 Gradle 8.7；执行 `gradle :app:assembleDebug`。生成物位于 `android/app/build/outputs/apk/debug/`。首次同步需从 JitPack 下载 RootEncoder。支持 Android 8.0+，首次运行授权相机与麦克风。

iOS：Xcode 打开 `ios/CwnupaaProctor.xcodeproj`，选择自己的签名 Team 后运行。Swift Package Manager 自动解析 HaishinKit。使用 XcodeGen 重新生成工程时应保留现有固定依赖版本。

模拟器编译验证（不启用真实考试或采集）：

```sh
xcodebuild -project ios/CwnupaaProctor.xcodeproj -scheme CwnupaaProctor \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO build
```

Android 的 `tests/MediaTlsTest.java` 可在 `assembleDebug` 后对编译后的 Kotlin 类运行，使用 Kotlin stdlib 作为 classpath；覆盖 DNS、IP、证书 SAN、单层通配与冒名域名。

## 微信小程序

微信 `live-pusher` 不能保证 RTMPS 支持，因此小程序不再发布明文 RTMP，也不会上报摄像头采集成功。监考页提供 HTTPS 手机网页地址：复制后在手机浏览器打开，再扫描电脑左下角的恢复二维码；或直接使用原生 App。网页开始采集后关闭小程序。`apps/miniprogram/config.js` 的 `serverUrl`、`mobileWebUrl` 都必须配置可信 HTTPS，并在微信管理后台登记相应域名。

小程序回归：在仓库根目录执行 `node --test apps/miniprogram/tests/*.test.cjs`。
