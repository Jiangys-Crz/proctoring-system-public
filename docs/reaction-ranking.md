# Reaction 判题前后名次的依据

`Reaction.rankContext` 保存不可变的原片名次上下文：`beforeRank`、`afterRank`、`status`、`source`、`observedAt` 和 `provenance`。只有来源、考试/比赛、准确队伍 username、Submission 和原始 verdict 都匹配且状态为 `AVAILABLE`，视频才显示数字。无法验证时隐藏，不拿当前排行榜冒充历史名次。

## 实时事件的观察顺序

Recorder 每次连接先通过服务端 CCS 授权读取完整静态 Event Feed，保存 contests、teams、problems、submissions、judgements 检查点，完成后才允许计算排名。初始化或断线补数据期间的名次标记 `UNAVAILABLE`。重新连接的初始提交不会重复创建 Reaction；当前快照中已消失的实体从排名检查点中移除，显式 delete 记录删除标记。

NovaJudge 的静态 feed 不是数据库一致性快照：它分别查询提交和判题。若出现没有对应提交的 judgement、未知的非空队伍 ID 或未同步题目，排名停止输出数字，直到可验证状态恢复。静态快照内依次应用判题时基线始终为未完成，不能产生伪造的历史前后名次。某个最终 judgement 先到、submission 后到时，同 hash 回放仍会补完成录像状态，截取终点保留首次判题观测时间；该条实时名次明确不可用，不会借回放时刻补造。

首次最终 judgement 到达时，在同一个考试数据库事务中计算应用该事件之前和之后的排名，保存为 `CCS_OBSERVED_ORDER`。来源记录基线时刻、观察时刻、队伍数、前后 solved/penalty、输入 SHA-256 等。NovaJudge 每两秒轮询，可能同批观察多个结果；这里明确是 **CCS 观察顺序**，不是声称数据库内部实际完成顺序。NovaJudge 合成的 `end_time` 不用于推断历史排名时刻。

原始视频绑定首次最终判题。即使仍在判题后十秒尾段，重判也只更新 latest verdict 和历史，不改原片 cutoff、original verdict 或原排名。后续名次不能覆盖原片上下文。

## 已审计的 NovaJudge 规则

本次源码审计对应 NovaJudge `6c1c4b22dddc40ce30a4341dc7d379fb5a9c3c29`，`app/(main)/contest/[contestId]/(board)/rank/page.tsx`：

- 默认 TEAM 榜按解题数降序、总罚时升序；二者相同则并列。
- 首次 AC 的提交相对分钟数向下取整，加该 AC 前非 CE/SE 尝试次数 ×20。
- 按当前 NovaJudge 实现，早于 AC 的未完成尝试也计入该题的尝试罚时。不会擅自改成另一套理想化规则。
- AC 后尝试不影响该题分数，比赛结束后的补题不计入赛中成绩。
- 使用未封榜的管理员视图；不声称等同于公开冻结榜。

当前 CCS 不包含打星队伍显示与稳定行顺序的完整信息，包含打星队伍时不输出未经证实的数字名次。完全同毫秒提交且 AC/非 AC 顺序影响罚时、时间基准不符、队伍或完整基线缺失时也会隐藏。升级 NovaJudge 排名实现后须重新审计规则。

## 旧录像的显式历史重建

旧录像没有实时 rankContext 时，可以显式使用 NovaJudge 只读数据库证据与监考系统原始 `verdictHistory` 重建。当前最终 verdict 仅作一致性核对，不当作当时 verdict。任一早期提交缺少观察历史、原判题不能对应、同时刻顺序不明或数据不符时拒绝给出数字。

结果标记为 `HISTORICAL_CCS_RECONSTRUCTION`，保留重建时刻、队伍账号创建时间、数据和历史 hash，并声明不是历史 HTTP 榜快照。NovaJudge 没有已删除账号审计；当前存续队伍及其创建时间只能佐证原队伍集合，这个限制保留在 metadata provenance 中。

```powershell
# 仓库根目录；只读导出指定比赛，不包含账号密码或密钥。输出必须是新文件。
node .\scripts\reaction-novajudge-rank-proof.mjs 'D:\path\to\NovaJudge' '<contestId>' 'D:\proof\rank-proof.json'

# apps/web；默认只报告，--apply 才写入缺失/不可用 context，已有可靠 context 不覆盖。
node --env-file=.env --import tsx scripts/reaction-rank-backfill.ts '<examId>' 'D:\proof\rank-proof.json' '<submissionId1>,<submissionId2>' 'D:\proof\report'
node --env-file=.env --import tsx scripts/reaction-rank-backfill.ts '<examId>' 'D:\proof\rank-proof.json' '<submissionId1>,<submissionId2>' 'D:\proof\report' --apply
```


## 性能与验收范围

当前实现只在首次最终判题时计算该 Reaction 的前后排名。使用同场完整检查点，两次计算及输入 hash 的最坏复杂度约为 O(E log E)，E 为队伍、题目、提交、判题事件总数；计算发生在该场考试的事件事务内。重判及重复 final 不重复生成原片名次。

本机一次合成数据微基准：500 队、5000 提交、10511 事件，前后排名和 hash 合计约 48 ms，不含数据库查询和网络。它不是生产压力测试，不能证明更大规模的吞吐。每次重连的完整静态快照和流初始回放会额外遍历全场事件；大量提交时应关注 Recorder 的 feed 延迟与事务耗时，并在同源规则不变的前提下实现增量计分缓存或有界队列，而不是放宽完整性检查。

本次模块验收含 21 项 domain/ranking 单测及 16 组数据库状态集成场景：多队名次变化、并列、Nova 罚时细节、删除、同毫秒歧义、跨比赛约束、快照不一致、断线补数据、重判原片冻结和最终判题早于提交的回放竞态。测试使用构造事件，明确不代替真实 NovaJudge 提交验收。真实客户端验收需使用所选测试比赛的实际提交和持久化事件证据。
