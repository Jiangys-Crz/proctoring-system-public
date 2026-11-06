import type { Prisma } from '@prisma/client';
import { prisma } from './db';
import { isPublicTestExam } from './public-test';
import { accountDigest, digest, FederationError, manifestContractHash, SYNC_VERSION, type SyncManifest } from './exam-federation-protocol';
import { PROBLEM_MAPPING_CAPABILITY, type ProblemMapping } from './exam-federation-problems';
import { RequestParseError } from './http';

type Database = Pick<Prisma.TransactionClient, 'exam' | 'examFederation' | 'examFederationEntry' | 'systemSetting' | '$queryRaw'>;
export async function eligibleSyncExam(examId: string, db: Database = prisma) {
  const exam = await db.exam.findUnique({ where: { id: examId } });
  if (!exam) throw new FederationError('考试不存在', 404);
  if (exam.platform !== 'HYDRO' || exam.platformContestId !== 'local' || await isPublicTestExam(examId, db)) {
    throw new FederationError('跨网同步仅支持监考系统本机考试', 400);
  }
  if (!exam.published) throw new FederationError('请先发布考试并配置题目和考生', 400);
  return exam;
}
export async function syncManifest(examId: string, nodeId: string, key: string, db: Database = prisma): Promise<SyncManifest> {
  const exam = await eligibleSyncExam(examId, db);
  const full = await db.exam.findUniqueOrThrow({ where: { id: examId }, include: {
    candidates: { orderBy: { examNumber: 'asc' } }, problems: { orderBy: { order: 'asc' } },
  } });
  if (!full.candidates.length || !full.problems.length) throw new FederationError('同步考试必须配置完整的考生和题目', 400);
  const candidates = full.candidates.map(c => ({ number: c.examNumber, hash: accountDigest(key, {
    examNumber: c.examNumber, password: c.password, name: c.name, studentId: c.studentId, hydroAccount: c.hydroAccount,
    teamName: c.teamName, teamMembers: c.teamMembers, teamMemberStudentIds: c.teamMemberStudentIds,
    gender: c.gender, groupName: c.groupName, ranked: c.ranked, isTeamLeader: c.isTeamLeader, school: c.school, college: c.college,
  }) })).sort((a, b) => a.number < b.number ? -1 : a.number > b.number ? 1 : 0);
  const problems = full.problems.map(p => {
    const definition = { order: p.order, title: p.title, content: p.content, html: p.html, type: p.problemType, config: p.config,
      score: p.score, hydroScore: p.hydroScore, scorePercent: p.scorePercent, time: p.timeLimitMs, memory: p.memoryLimitMb, languages: p.languages };
    return { order: p.order, number: p.hydroProblemId, hash: digest({ ...definition, number: p.hydroProblemId }), definitionHash: digest(definition) };
  });
  const rules = digest({ startAt: exam.startAt, latestStartAt: exam.latestStartAt, endAt: exam.endAt, duration: exam.durationMinutes,
    rule: exam.contestRule, type: exam.contestType, teamMode: exam.teamAccountMode, flexible: exam.flexible,
    freezeMinutes: exam.freezeMinutes, scoreboardFrozenAt: exam.scoreboardFrozenAt, allowedLanguages: exam.allowedLanguages,
    leaderOnlySubmission: exam.leaderOnlySubmission, allowTeamSubmissionView: exam.allowTeamSubmissionView,
    showObjectiveScore: exam.showObjectiveScore,
  });
  return { version: SYNC_VERSION, capabilities: ['submissions', 'communications', 'qa-assets', PROBLEM_MAPPING_CAPABILITY], nodeId, now: new Date().toISOString(), examCode: exam.examCode,
    rules, candidates, problems, hash: manifestContractHash({ examCode: exam.examCode, rules, candidates, problems }) };
}
export function compareManifests(local: SyncManifest, remote: SyncManifest): ProblemMapping {
  const errors: string[] = [];
  if (local.rules !== remote.rules) errors.push('考试时间、赛制或计分规则不一致');
  const remoteCandidates = new Map(remote.candidates.map(c => [c.number, c.hash]));
  const different = local.candidates.filter(c => remoteCandidates.get(c.number) !== c.hash).map(c => c.number);
  const localCandidates = new Set(local.candidates.map(c => c.number));
  const missing = remote.candidates.filter(c => !localCandidates.has(c.number)).map(c => c.number);
  if (different.length || missing.length) errors.push(`考生账号或资料不一致：${[...different, ...missing].slice(0, 10).join('、')}`);
  const physicalIdentity = (m: SyncManifest) => m.problems.map(({ order, number, hash }) => ({ order, number, hash }));
  if (digest(physicalIdentity(local)) !== digest(physicalIdentity(remote))) {
    if (!remote.capabilities?.includes(PROBLEM_MAPPING_CAPABILITY) || remote.problems.some(p => !p.definitionHash)) {
      errors.push('两端后台均需更新到支持跨网题号映射的版本');
    } else {
      const definitions = (m: SyncManifest) => m.problems.map(({ order, definitionHash }) => ({ order, definitionHash }));
      if (digest(definitions(local)) !== digest(definitions(remote))) errors.push('题目顺序、题面、判题设置或分值不一致');
    }
  }
  if (errors.length) throw new FederationError(errors.join('；'), 409);
  return local.problems.map((p, index) => ({ order: p.order, localNumber: p.number, remoteNumber: remote.problems[index].number }));
}
/** Called inside the same transaction as the definition mutation. Room-only operations stay independent. */
export async function assertFederationDefinitionMutable(tx: Prisma.TransactionClient, examId: string) {
  await tx.$queryRaw`SELECT id FROM Exam WHERE id = ${examId} FOR UPDATE`;
  const config = await tx.examFederation.findUnique({ where: { examId }, select: { enabled: true } });
  const history = config && await tx.examFederationEntry.findFirst({ where: { examId }, select: { submissionId: true } });
  const contentHistory = config && await tx.examFederationContent.findFirst({ where: { examId }, select: { entityId: true } });
  if (config?.enabled || history || contentHistory) throw new RequestParseError('该考试已启用跨网同步或已有同步记录，不能修改考试定义、题目和考生资料；考室配置仍可单独修改');
}
