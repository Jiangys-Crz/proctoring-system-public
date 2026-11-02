# 开源版本配置说明

本仓库提供可自行部署的监考平台源码，不包含运行中的服务、数据库、用户资料、录像或已发布安装包。源码采用 GNU AGPL v3，准确许可标识为 `AGPL-3.0-only`，完整条款见 [LICENSE](LICENSE)。第三方组件及其独立许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 开始部署

1. 安装根目录 `package.json` 指定的 Node.js 兼容环境和 pnpm，然后运行 `pnpm install`。
2. 本地开发复制 `apps/web/.env.example` 为 `apps/web/.env`；Docker 部署复制根目录 `.env.example` 或 `.env.caddy.example` 为 `.env`。为数据库、会话签名、媒体访问和管理员初始化分别设置独立凭据。
3. 按 [README.md](README.md) 初始化数据库并启动后台和考生网页。生产环境必须设置至少 12 位的 `BOOTSTRAP_ADMIN_PASSWORD`；公开的开发示例密码不能用于生产。已有管理员不会因修改这个变量而自动改密。
4. 在后台系统设置中填写自己的 HydroOJ 主地址、题库域和 API-Key，部署对应的 `hydro-plugin/cwnupaa-proctor-auth` 插件。NovaJudge 考试另按文档配置自己的服务。
5. 使用自己管理的 HTTPS 域名部署后台、考生网页和媒体服务。`example.org`、`example.test` 和文档中的局域网地址都是配置示例，不是可使用的服务。

## 客户端与可选集成

- 桌面开发配置在 `apps/desktop/src/renderer/config.js`。手机扫码入口须填写手机可访问且受信任的 HTTPS 地址。打包前同步修改 `apps/desktop/scripts/copy-assets.mjs`、`apps/desktop/scripts/package-release.mjs`、`apps/desktop/src/main/main.ts` 和 `apps/desktop/package.json` 中的示例后端及更新地址；自定义后台与独立考生网页还需配置 `PROCTOR_CLIENT_WEB_URL`。
- 示例公网后台和考生网页分别为 `proctoring.example.org`、`proctorstu.example.org`；内网对应 `proctoring.example.test`、`proctorstu.example.test`。如采用其他命名，请同时更新 `apps/desktop/src/renderer/renderer.js` 中的域名映射，或显式提供考生网页地址。
- 原生 Android/iOS 客户端和微信小程序使用自己的 HTTPS 服务。微信项目默认使用游客 AppID，正式发布前须在 `apps/miniprogram/project.config.json` 填写自己的 AppID；iOS 的 `DEVELOPMENT_TEAM` 留空，须自行设置签名团队。
- 外部账号登录和测试账号领取使用 `CWNUPAA_EXTERNAL_API_BASE`、`CWNUPAA_EXTERNAL_APP_KEY`，也可在后台配置。这里保留的是既有集成的接口约定；需要兼容的外部服务才能启用，本地管理员登录不依赖该集成。
- 仓库保留原有项目命名、应用标识和品牌资源以便识别来源。部署衍生版本时请配置自己的包标识、签名和品牌，不应将自行部署的服务描述为原组织运营的服务。

## 源码发布边界

公开版本使用全新的 Git 历史。发布更新时只同步经过检查的源码，不要推送其他仓库的历史、分支或标签。

运行配置、私钥、签名材料、数据库、上传文件、录像、个人 IDE 工作区和现场测试报告不属于源码分发内容。教程保留文字操作步骤，原部署截图不随仓库发布；测试目录内的两段小视频是合成色块素材。

提交前检查暂存文件和差异，确认所有凭据均为占位符、测试数据均为合成数据。若曾提交有效凭据，应先撤销或更换；仅新增删除提交不能清除旧提交中的内容。

## 验证

主要检查包括各工作区的 `typecheck`，以及后台计分、权限、Hydro 集成、考生网页和桌面客户端回归测试。需要数据库、浏览器、Electron 或外部服务的集成测试应在独立测试环境中按各测试文件的要求运行。

源码公开不代替生产部署验收。正式考试前应验证自己的设备、HTTPS、媒体连通性、存储和容量，并为用户说明监考采集的内容及用途。
