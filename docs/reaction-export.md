# Reaction UUID 与 MP4 导出

Reaction 的 `submissionId` 直接使用 NovaJudge CCS `submissions.id` 中的 UUID，与判题事件的 `submission_id` 及原外榜接口的 `rid` 对应。列表、预览标题、单个竖屏文件下载和 ZIP 中的文件名都使用这一 UUID；不转换为比赛内序号，不新增编号同步步骤。

本功能使用 NovaJudge 现有 CCS 与外榜接口，无需修改 NovaJudge 响应、判题、计分或任何其他源码。CCS 凭据与外榜 API Key 仍按各自现有认证方式配置，不能相互代替；视频导出本身不需要额外查询 NovaJudge。

## 导出方式

在考试详情进入 **Reaction 录像管理**，先生成需要的竖屏视频，再点击 **批量导出 MP4（ZIP）**。导出覆盖整场考试所有已生成且未过期的成片，不受列表最近 200 条记录的显示限制。未生成的记录需要先完成生成。

ZIP 根目录只有 `{uuid}.mp4`，例如：

```text
11111111-1111-4111-8111-111111111111.mp4
22222222-2222-4222-8222-222222222222.mp4
```

每个名称来自该录像原始 `submissionId`。单独下载 Reaction 成片采用同样的 `{uuid}.mp4` 名称。原始 Camera、Desktop 和 metadata 的存储及下载入口保持原有用途，ZIP 不额外包含 metadata、账号或密钥。

已成功生成的 PARTIAL 成片也可导出，原录像仍保持不完整状态及缺失诊断。导出不会重编码、补录或把部分录像标为完整。

## 权限、预检和一致性

- `GET /api/exams/{examId}/reactions/export?check=1` 验证本场管理权限、Submission UUID、存储路径和全部待导出文件。
- 不带 `check` 参数时流式下载 ZIP64，权限要求相同。没有公开视频或公开 S3 链接。
- 汇总为 `{ generatedCount, invalidSubmissionIds }`，覆盖整场考试。UUID无效、重名或任一文件缺失时拒绝整个导出，不悄悄漏文件或覆盖同名项。
- UUID校验拒绝非UUID字符串、斜杠、路径遍历等输入；存储对象路径另行检查，不允许通过Submission或URL选择任意文件。
- MP4使用ZIP STORE，LOCAL/S3逐个读取，不把整场视频缓存在服务端或浏览器内存。下载取消或源中断会终止归档；浏览器留下的不完整文件需要重新下载。

## 已有安装升级

从不含 Reaction 的版本升级时，按仓库当前增量迁移部署完整 Reaction schema，生成 Prisma Client 并重启 Web/Recorder；新空库可以按项目现有初始化流程建表。升级前检查实际数据库与目标schema差异，不重置数据库。

若曾部署使用比赛内 `displayId` 的实验版本，Schema 以 `legacyDisplayId Int? @map("displayId") @ignore` 保留旧可空列，并将唯一索引显式映射到原名 `Reaction_examId_displayId_key`。该字段不进入 Prisma Client，功能不再读写或同步展示编号；已有列、索引和数据保持不变。这样 Docker 启动时现有的 `db push` 不会因移除该列而请求数据丢失确认。首次安装的增量 SQL 同样保留这项兼容定义，确保 Schema 与数据库一致。

无需 DROP 列、删除映射记录或重新生成已有录像，也无需编号同步和 NovaJudge 配套补丁。不要为了清理这些残留项执行破坏性迁移或 `--accept-data-loss`。Prisma 6.19.3 已验证从原字段定义迁移到忽略字段的数据库差异为空；升级仍应检查本机其他 Schema 差异。

## 验收

`tests/reaction-export-integration.ts` 使用新建隔离考试和随机UUID，验证超过200条视频的汇总与完整ZIP、逐文件SHA-256/CRC、未授权访问拒绝、无效UUID/存储路径拒绝和仅清理本次fixture。测试原始UUID不依赖某场真实比赛的序号；NovaJudge实际提交验收与模拟媒体的范围仍应分别记录。
