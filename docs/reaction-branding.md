# 系统组织徽章

超级管理员在系统设置维护组织名称、徽章图片和系统默认徽章。所有考试共用这份映射；考试外观只配置背景和字体。组织上传 PNG/JPEG/WebP，不超过 4 MiB、1600 万像素，服务端解码并重新编码成 PNG。未经上传的默认值是内置中性建筑徽章，不代表任何学校，系统页面可直接预览。

## 匹配与历史行为

生成时先按 Reaction.candidateId 找到当前候选人，并同时验证考试 ID 和准确考号 `examNumber === Reaction.teamId`。验证成功使用当前 `Candidate.school`；候选人已删除或身份不符时才使用原录像的 school 快照。修改队伍所属学校后，预览和重新生成均使用新学校。

组织名处理为 **NFKC 归一、去首尾空白、连续空白折叠为一个空格，保留大小写**。处理后精确匹配，不按队名、拼音、子串或相似名称推断。选择顺序为：组织匹配徽章 → 系统自定义默认徽章 → 内置中性默认徽章。缺失或已归档的库记录不能作为新生成的组织徽章，会使用下一层默认。

旧的考试 `teamLogos`、`schoolLogos`、`defaultLogoPath/defaultLogoId` JSON 保留供历史读取，但不再参与生成。系统修改不自动重做已生成 MP4；管理员点击重新生成才应用当前设置。替换或移除组织只改变系统绑定，原素材记录和文件保留，避免破坏历史引用。

每次生成的 metadata 保存实际 `basis`（system-organization/system-default/built-in-default）、组织名、归一后的学校名、schoolSource（current-candidate/recording-snapshot）、logoId 和图片 SHA-256；素材存储路径不写入下载元数据。

## 接口

所有系统入口只允许 ACTIVE SUPER_ADMIN；写入还校验请求来源。响应使用现有 `{ok,data}` 格式和 private/no-store。

- `GET /api/settings/reaction-branding`：`{version:1,organizations:[{name,logoId,previewUrl}],defaultBadge:{logoId,previewUrl},limit:500}`。内置默认的 logoId 为 null，previewUrl 始终提供。
- `POST`：multipart `kind=organization|default`、`file`，组织还需 `name`。归一后重名返回409。组织替换必须显式 `replace=true` 且 `existingName` 与 `name` 归一后相同；先重命名应使用 PATCH。默认已有自定义图片时，替换需 `replace=true,existingName=default`。
- `PATCH`：JSON `{name,newName}`，原名和新名都按相同规则处理；禁止归一后重名。
- `DELETE`：JSON `{name}` 移除组织绑定；`{}` 重置系统默认为内置中性徽章。
- `GET /api/settings/reaction-branding/logos/{id}`：受限 PNG 预览；`id=builtin` 为内置默认。

旧 `/api/exams/{id}/reactions/logo-library` 及其单条路径保留有权限的 GET 兼容，POST/PATCH/DELETE 在授权后返回410，提示迁移到系统设置。考试 `reactions/assets` POST 只允许 `kind=background`，`kind=logo` 返回410。

## 存储与并发

不新增数据库模型。`SystemSetting.key=reactionBranding` 保存 `{version:1,organizations:[{name,logoId}],defaultLogoId}`；图片继续使用 ReactionLogo 和现有本地/S3 存储。系统配置读写没有进程缓存，因此 Web 和 Recorder 立即读取相同配置。并发写在 SystemSetting 行锁和 Serializable 事务下完成，不会静默覆盖同名组织。

组织数量上限500；所有新旧徽章素材历史总数默认上限2000，可用 `REACTION_BRANDING_MAX_ASSETS` 调整至500–10000。失败上传仅清理本次尚未发布的 UUID 对象；不会清理原图、其他比赛或已有录像。

本机验收入口（apps/web）：

```powershell
node --env-file=.env --import tsx --test tests/reaction-render-settings.test.ts
node --env-file=.env --import tsx tests/reaction-branding-integration.ts
```

集成测试需独占短暂系统设置修改窗口，记录原设置并在 finally 精确恢复；只创建和清理独立测试账号、考试和图片。已有真实比赛数据不作为可写 fixture。
