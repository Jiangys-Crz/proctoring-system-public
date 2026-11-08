import { retiredBankKey } from './platform-sync-problem-history';
import { awaitRoomAssignment, roomAssignmentPending, clearRoomAssignmentPending } from './platform-sync-room';
import { migrateLegacyFederation } from './platform-sync-legacy';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { resolveQaMessageId } from './qa-thread';
import { ContestRuleSchema, ContestTypeSchema, TeamAccountModeSchema } from '@cwnupaa/proctor-shared';
import { normalizeContestFormat } from './contest-format';
import { prisma } from './db';
import { digest, FederationError, keyHash, sealKey } from './exam-federation-protocol';
import { federationTransaction } from './exam-federation-store';
import { captureItem, captureDeletions, acceptItem, jsonValue, itemHash } from './platform-sync-store';
import { getHydroSettings } from './settings';
import { getPlatformSyncSettings, type PlatformSyncSettings } from './platform-sync-settings';
import { assertCandidateCanDelete } from './platform-sync-candidate-delete';
import type { PlatformItem } from './platform-sync-protocol';

const EXAM_FIELDS = ['name','startAt','latestStartAt','endAt','durationMinutes','contestType','teamAccountMode','contestRule','published','flexible','scoreboardFrozenAt','freezeMinutes','allowedLanguages','showTestCaseCount','showObjectiveScore','allowPrint','printMode','allowTeamSubmissionView','leaderOnlySubmission','rules','saveFullRecording','saveIncidentRecording','externalBoardEnabled','externalBoardBaseUrl','externalBoardApiKey','externalBoardEventId','externalBoardIntervalSeconds'] as const;
const CANDIDATE_FIELDS = ['name','studentId','school','college','major','gender','gradeYear','className','advisor','groupName','teamName','teamMembers','teamMemberStudentIds','teamRoster','memberOrder','examNumber','password','seatNo','isTeamLeader','ranked','status','startedAt','lateStartAllowedAt','abnormal'] as const;
const PROBLEM_FIELDS = ['order','label','title','content','html','problemType','config','hydroScore','scorePercent','score','timeLimitMs','memoryLimitMb','languages','files','sourceDeleted'] as const;
const ROOM_FIELDS = ['name','requireSecondCamera','requireFrontCamera','loginMode','loginReviewMode'] as const;
const PRINT_FIELDS = ['mode','status','title','content','teamName','candidateName','examNumber','teamMembers','roomName','seatNo','rejectedReason','reviewedAt','printedAt','createdAt'] as const;
const CHEATING_FIELDS = ['reason','teamWide','teamName','canceledAt','canceledReason','finalizedAt','createdAt'] as const;
const ALERT_FIELDS = ['type','severity','message','acknowledgedAt','createdAt'] as const;
const LOGIN_FIELDS = ['memberStudentId','memberName','status','rejectReason','reviewedAt','createdAt'] as const;
const pick = (row: object, fields: readonly string[]) => Object.fromEntries(fields.map(k => [k, (row as Record<string, unknown>)[k]]));
const compareIdentities = (a: object, b: object) => {
  const left = JSON.stringify(a), right = JSON.stringify(b);
  return left < right ? -1 : left > right ? 1 : 0;
};
function dataFields(payload: Record<string, unknown>, fields: readonly string[]) {
  const result = pick(payload, fields);
  for (const key of Object.keys(result)) if ((key.endsWith('At') || ['startAt','endAt'].includes(key)) && typeof result[key] === 'string') {
    const date = new Date(result[key] as string); if (!Number.isFinite(+date)) throw new FederationError('同步日期无效', 400); result[key] = date;
  }
  return result;
}
function synchronizedExamFields(payload: Record<string, unknown>) {
  const rule = ContestRuleSchema.safeParse(payload.contestRule), type = ContestTypeSchema.safeParse(payload.contestType), mode = TeamAccountModeSchema.safeParse(payload.teamAccountMode);
  if (!rule.success || !type.success || !mode.success) throw new FederationError('同步考试的赛制或账号方式无效');
  const format = normalizeContestFormat({ contestRule: rule.data, contestType: type.data, teamAccountMode: mode.data,
    allowTeamSubmissionView: payload.allowTeamSubmissionView === true, leaderOnlySubmission: payload.leaderOnlySubmission === true });
  // Do not silently turn a legacy shared roster into individual member accounts.
  // Keep the incoming record queued until its source has a compatible roster.
  if (format.contestType !== type.data || format.teamAccountMode !== mode.data) throw new FederationError('来源考试的赛制与个人/团队账号方式不一致，请先调整来源考试');
  return { ...dataFields(payload, EXAM_FIELDS), ...format };
}
function examPlatformSyncData(examCode: string, settings: PlatformSyncSettings, enabled: boolean) {
  return { managedGlobally: true, enabled, role: settings.role === 'PUBLIC' ? 'HUB' : 'EDGE',
    apiKeyHash: keyHash(settings.publicApiKey), apiKeyCiphertext: sealKey(settings.publicApiKey),
    contractHash: digest({ examCode, protocol: 'platform-sync-v2' }), remoteBaseUrl: settings.publicBaseUrl,
    nextAttemptAt: new Date(), leaseUntil: null, leaseToken: null };
}

export async function enablePlatformSyncForNewExam(
  tx: Prisma.TransactionClient, exam: { id: string; examCode: string; published: boolean }, settings: PlatformSyncSettings,
) {
  if (!settings.enabled || !settings.publicApiKey) throw new FederationError('请先在系统设置启用公网与内网同步', 400);
  if (settings.role === 'LOCAL') throw new FederationError('请通过“导入公网考试”建立考试对应关系', 400);
  if (!exam.published) throw new FederationError('请先发布本地题库考试', 400);
  await tx.examFederation.create({ data: { examId: exam.id, nodeId: randomUUID(), generation: 1,
    ...examPlatformSyncData(exam.examCode, settings, true) } });
}

export async function setExamPlatformSync(examId: string, enabled: boolean) {
  const settings = await getPlatformSyncSettings();
  if (!settings.enabled && enabled) throw new FederationError('请先在系统设置启用公网与内网同步', 400);
  const exam = await prisma.exam.findUniqueOrThrow({ where: { id: examId } });
  if (exam.platform !== 'HYDRO' || exam.platformContestId !== 'local' || !exam.published) throw new FederationError('请先发布本地题库考试', 400);
  let old = await prisma.examFederation.findUnique({ where: { examId } });
  if (old && !old.managedGlobally) {
    if (!enabled) { await prisma.examFederation.update({ where: { examId }, data: { enabled: false, generation: { increment: 1 } } }); return { enabled: false }; }
    if (settings.role === 'LOCAL') throw new FederationError('请通过导入公网考试对齐旧版连接', 400);
    await migrateLegacyFederation(examId, settings); old = await prisma.examFederation.findUnique({ where: { examId } });
  }
  if (!old && settings.role === 'LOCAL') throw new FederationError('请通过“导入公网考试”建立考试对应关系', 400);
  const data = { ...examPlatformSyncData(exam.examCode, settings, enabled), generation: (old?.generation ?? 0) + 1 };
  await federationTransaction(examId, tx => tx.examFederation.upsert({ where: { examId }, create: { examId, nodeId: randomUUID(), ...data }, update: data }));
  return { enabled };
}
export async function captureExam(examId: string, settings: PlatformSyncSettings) {
  return federationTransaction(examId, tx => captureExamInTransaction(tx, examId, settings));
}
export async function captureExamInTransaction(tx: Prisma.TransactionClient, examId: string, settings: PlatformSyncSettings, incoming?: PlatformItem) {
    const config = await tx.examFederation.findUnique({ where: { examId } });
    if (!config?.managedGlobally || !config.enabled) return;
    const exam = await tx.exam.findUniqueOrThrow({ where: { id: examId }, include: { problems: true, candidates: true,
      rooms: { include: { candidates: true, proctors: { include: { user: true } } } }, administrators: { include: { user: true } }, printJobs: true, cheatingRecords: true, alerts: true, loginRequests: true } });
    const scope = exam.examCode;
    // A normal poll should not issue a lookup for every unchanged candidate,
    // room assignment or receipt. Keep only journal metadata in this transaction.
    const cacheLimit = 4096;
    const known = await tx.platformSyncItem.findMany({ where: { scope, deleted: false, kind: { in: ['EXAM','ADMINISTRATORS','CANDIDATE','PROBLEM','ROOM','ROOM_ASSIGNMENT','PRINT','CHEATING','ALERT','LOGIN','RECEIPT','MESSAGE_RECEIPT'] } },
      select: { id: true, kind: true, localId: true, appliedHash: true, deleted: true }, orderBy: { updatedAt: 'desc' }, take: cacheLimit });
    const byId = new Map(known.map(item => [item.id, item]));
    const byLocal = new Map(known.filter(item => item.localId).map(item => [`${item.kind}:${item.localId}`, item]));
    const capture = async (kind: PlatformItem['kind'], localId: string, payload: Record<string, unknown>, preferredId?: string) => {
      const prior = byLocal.get(`${kind}:${localId}`) || (preferredId ? byId.get(preferredId) : undefined);
      if (prior && (prior.kind !== kind || (prior.localId && prior.localId !== localId))) throw new FederationError('同步身份已经绑定其他本地记录');
      if (prior && (prior.deleted || prior.appliedHash === itemHash(payload))) return prior;
      const item = await captureItem(tx, settings.nodeId, scope, kind, localId, payload, preferredId);
      const metadata = { id: item.id, kind: item.kind, localId: item.localId, appliedHash: item.appliedHash, deleted: item.deleted };
      if (byId.has(item.id) || byId.size < cacheLimit) byId.set(item.id, metadata);
      if (byLocal.has(`${kind}:${localId}`) || byLocal.size < cacheLimit) byLocal.set(`${kind}:${localId}`, metadata);
      return item;
    };
    const target = incoming ? await tx.platformSyncItem.findUnique({ where: { id: incoming.id } }) : null;
    const matches = (kind: PlatformItem['kind'], id: string, legacy = false) => !incoming || (incoming.kind === kind && (target?.localId === id || (!target?.localId && legacy)));
    if (matches('EXAM', examId, true)) await capture('EXAM', examId, jsonValue({ ...pick(exam, EXAM_FIELDS), hubNodeId: config.role === 'HUB' ? config.nodeId : config.boundHubId }), `exam:${scope}`);
    const identity = (user: { realName: string | null; numberId: string | null; username: string | null; email: string | null }) => ({ realName: user.realName, numberId: user.numberId, username: user.username, email: user.email });
    if (matches('ADMINISTRATORS', examId, true)) await capture('ADMINISTRATORS', examId, jsonValue({ users: exam.administrators.map(a => identity(a.user)).sort(compareIdentities) }), `admins:${scope}`);
    for (const candidate of exam.candidates) {
      if (!matches('CANDIDATE', candidate.id, candidate.syncKey === incoming?.id || (!candidate.syncKey && candidate.examNumber === incoming?.payload.examNumber))) continue;
      const item = await capture('CANDIDATE', candidate.id, jsonValue(pick(candidate, CANDIDATE_FIELDS)), candidate.syncKey || undefined);
      if (!candidate.syncKey) await tx.candidate.update({ where: { id: candidate.id }, data: { syncKey: item.id, updatedAt: candidate.updatedAt } });
    }
    for (const problem of exam.problems) {
      if (!matches('PROBLEM', problem.id, problem.syncKey === incoming?.id || (!problem.syncKey && problem.order === incoming?.payload.order))) continue;
      const prior = problem.sourceDeleted ? await tx.platformSyncItem.findUnique({ where: { scope_kind_localId: { scope, kind: 'PROBLEM', localId: problem.id } } }) : null;
      const retired = problem.sourceDeleted ? await tx.systemSetting.findUnique({ where: { key: retiredBankKey(problem.hydroDomain, problem.hydroProblemId) } }) : null;
      const priorBank = (prior?.payload as Record<string, unknown> | undefined)?.bankId || (retired?.value as { bankId?: string } | undefined)?.bankId;
      const bank = priorBank ? await tx.platformSyncItem.findUnique({ where: { id: String(priorBank) } }) : await tx.platformSyncItem.findUnique({ where: { scope_kind_localId: { scope: 'bank', kind: 'BANK', localId: `${problem.hydroDomain}:${problem.hydroProblemId}` } } });
      const errorKey = `platform-problem-error:${examId}:${problem.id}`;
      if (!bank) {
        if (incoming) throw new FederationError(`题目 ${problem.title} 尚未建立题库映射，稍后自动重试`);
        const value = { id: problem.id, error: '考试题目尚未建立题库映射，原题已保留等待补齐' };
        await tx.systemSetting.upsert({ where: { key: errorKey }, create: { key: errorKey, value }, update: { value } });
        continue;
      }
      await tx.systemSetting.deleteMany({ where: { key: errorKey } });
      const item = await capture('PROBLEM', problem.id, jsonValue({ ...pick(problem, PROBLEM_FIELDS), bankId: bank.id }), problem.syncKey || undefined);
      if (!problem.syncKey) await tx.examProblem.update({ where: { id: problem.id }, data: { syncKey: item.id, updatedAt: problem.updatedAt } });
    }
    const candidateKeys = new Map((await tx.candidate.findMany({ where: { examId }, select: { id: true, syncKey: true } })).map(c => [c.id, c.syncKey]));
    const roomKeys = new Map<string, string>();
    for (const room of exam.rooms) {
      if (incoming?.kind === 'ROOM_ASSIGNMENT') { const mapping = await tx.platformSyncItem.findUnique({ where: { scope_kind_localId: { scope, kind: 'ROOM', localId: room.id } } }); if (mapping) roomKeys.set(room.id, mapping.id); continue; }
      if (!matches('ROOM', room.id, room.name === incoming?.payload.name)) continue;
      const item = await capture('ROOM', room.id, jsonValue({ ...pick(room, ROOM_FIELDS), proctors: room.proctors.map(p => identity(p.user)).sort(compareIdentities) }));
      roomKeys.set(room.id, item.id);
    }
    const membershipsByCandidate = new Map<string, typeof exam.rooms>();
    for (const room of exam.rooms) for (const membership of room.candidates) {
      const assigned = membershipsByCandidate.get(membership.candidateId);
      if (assigned) assigned.push(room); else membershipsByCandidate.set(membership.candidateId, [room]);
    }
    for (const candidate of exam.candidates) {
      if (!matches('ROOM_ASSIGNMENT', candidate.id, candidateKeys.get(candidate.id) === incoming?.payload.candidateKey)) continue;
      const memberships = membershipsByCandidate.get(candidate.id) || [];
      const key = candidateKeys.get(candidate.id);
      if (!key) continue;
      if (!memberships.length && await roomAssignmentPending(tx, key)) continue;
      if (memberships.length > 1) throw new FederationError('考生被分配到多个考室，请先修正考室安排');
      if (memberships.length && !roomKeys.has(memberships[0].id)) {
        const room = memberships[0];
        const item = await capture('ROOM', room.id, jsonValue({ ...pick(room, ROOM_FIELDS), proctors: room.proctors.map(p => identity(p.user)).sort(compareIdentities) }));
        roomKeys.set(room.id, item.id);
      }
      await capture('ROOM_ASSIGNMENT', candidate.id, jsonValue({ candidateKey: candidateKeys.get(candidate.id), roomKey: memberships.length ? roomKeys.get(memberships[0].id) : null }), `room-assignment:${key}`);
      await clearRoomAssignmentPending(tx, [key]);
    }
    if (!incoming || incoming.kind === 'ROOM_ASSIGNMENT') await captureDeletions(tx, settings.nodeId, scope, 'ROOM_ASSIGNMENT', new Set(exam.candidates.map(c => c.id)));
    for (const [kind, rows, fields] of [ ['PRINT', exam.printJobs, PRINT_FIELDS], ['CHEATING', exam.cheatingRecords, CHEATING_FIELDS], ['ALERT', exam.alerts, ALERT_FIELDS], ['LOGIN', exam.loginRequests, LOGIN_FIELDS] ] as const) {
      for (const row of rows) {
        if (!matches(kind, row.id)) continue;
        const extra: Record<string, unknown> = {};
        if (kind === 'LOGIN' && 'identityPhotoPath' in row) {
          const photo = row.identityPhotoPath ? await tx.mediaSegment.findFirst({ where: { examId, candidateId: row.candidateId, objectPath: row.identityPhotoPath, channel: 'IDENTITY_PHOTO', deletedAt: null, validatedAt: { not: null } } }) : null;
          const video = row.roomVideoPath ? await tx.mediaSegment.findFirst({ where: { examId, candidateId: row.candidateId, objectPath: row.roomVideoPath, channel: 'ROOM_VIDEO', deletedAt: null, validatedAt: { not: null } } }) : null;
          extra.photoKey = photo ? `photo:${photo.id}` : null;
          extra.materialsVerified = row.syncMaterialsVerified || Boolean(photo && video);
        }
        await capture(kind, row.id, jsonValue({ ...pick(row, fields), ...extra, candidateKey: row.candidateId ? candidateKeys.get(row.candidateId) : null }));
      }
      if (!incoming || incoming.kind === kind) await captureDeletions(tx, settings.nodeId, scope, kind, new Set(rows.map(r => r.id)));
    }
    const receipts = await tx.examAnnouncementReceipt.findMany({ where: { announcement: { examId } } });
    for (const row of receipts) {
      const candidateKey = candidateKeys.get(row.candidateId);
      if (candidateKey && matches('RECEIPT', row.id)) await capture('RECEIPT', row.id, jsonValue({ announcementId: row.announcementId, candidateKey, acknowledgedAt: row.acknowledgedAt }), `receipt:${digest({ scope, announcementId: row.announcementId, candidateKey })}`);
    }
    // A synthetic imported legacy answer may not have a real remote message
    // identity yet. Keep its local receipt until that message's snapshot exists.
    const messages = await tx.$queryRaw<Array<{id:string;acknowledgedAt:Date}>>`SELECT message.id, message.acknowledgedAt FROM ExamQuestionMessage message
      JOIN ExamQuestion question ON question.id = message.questionId
      JOIN ExamFederationContent content ON content.examId = question.examId AND content.kind = 'message' AND content.entityId = message.id
      WHERE question.examId = ${examId} AND message.acknowledgedAt IS NOT NULL`;
    for (const row of messages) if (matches('MESSAGE_RECEIPT', row.id, row.id === incoming?.payload.messageId)) await capture('MESSAGE_RECEIPT', row.id, jsonValue({ messageId: row.id, acknowledgedAt: row.acknowledgedAt }), `message-receipt:${row.id}`);
    for (const [kind, rows] of [['CANDIDATE',exam.candidates],['PROBLEM',exam.problems],['ROOM',exam.rooms]] as const) if (!incoming || incoming.kind === kind) await captureDeletions(tx, settings.nodeId, scope, kind, new Set(rows.map(r => r.id)));
    if (!incoming) {
      const ids = new Set(exam.problems.map(problem => problem.id));
      const errors = await tx.systemSetting.findMany({ where: { key: { startsWith: `platform-problem-error:${examId}:` } }, select: { key: true, value: true } });
      for (const error of errors) if (!ids.has((error.value as {id:string}).id)) await tx.systemSetting.deleteMany({ where: { key: error.key } });
    }
}
async function ensureUser(tx: Prisma.TransactionClient, value: Record<string, unknown>) {
  const realName = typeof value.realName === 'string' ? value.realName : null, numberId = typeof value.numberId === 'string' ? value.numberId : null;
  if (realName && numberId) return tx.user.upsert({ where: { realName_numberId: { realName, numberId } }, create: { realName, numberId, username: typeof value.username === 'string' ? value.username : null, email: typeof value.email === 'string' ? value.email : null, role: 'ADMIN' }, update: {} });
  const username = typeof value.username === 'string' ? value.username : null;
  const user = await tx.user.findFirst({ where: numberId ? { numberId } : username ? { username } : { id: '__none' } });
  const email = typeof value.email === 'string' ? value.email : null;
  if (!realName && !numberId && !username && !email) throw new FederationError('管理员身份缺少可匹配信息');
  const key = `platform-user:${digest(value)}`;
  const mapped = await tx.systemSetting.findUnique({ where: { key } });
  const userId = (mapped?.value as { userId?: string } | undefined)?.userId;
  const saved = user || (userId ? await tx.user.findUnique({ where: { id: userId } }) : null) || await tx.user.create({ data: { realName, numberId, username, email, role: 'ADMIN' } });
  await tx.systemSetting.upsert({ where: { key }, create: { key, value: { userId: saved.id } }, update: { value: { userId: saved.id } } });
  return saved;
}
export async function mergeExamItem(value: PlatformItem, settings: PlatformSyncSettings, creatorId?: string, alreadyCaptured = false) {
  if (!/^\d{10}$/.test(value.scope)) throw new FederationError('考试同步范围无效', 400);
  if (value.hash !== itemHash(value.payload, value.deleted)) throw new FederationError('同步资料校验失败', 400);
  let initializing = false;
  let exam = await prisma.exam.findUnique({ where: { examCode: value.scope }, include: { federation: true } });
  if (!exam) {
    if (!creatorId || value.kind !== 'EXAM' || value.deleted) throw new FederationError('考试尚未导入，请先导入公网考试');
    initializing = true;
    const hydro = await getHydroSettings();
    exam = await prisma.exam.create({ data: { ...synchronizedExamFields(value.payload) as unknown as Omit<Prisma.ExamUncheckedCreateInput,'examCode'|'createdById'|'platform'|'platformBaseUrl'|'platformContestId'>,
      examCode: value.scope, createdById: creatorId, platform: 'HYDRO', platformBaseUrl: hydro.baseUrl, platformContestId: 'local',
      federation: { create: { role: 'EDGE', managedGlobally: true, enabled: false, nodeId: randomUUID(), boundHubId: String(value.payload.hubNodeId),
        remoteBaseUrl: settings.publicBaseUrl, apiKeyHash: keyHash(settings.publicApiKey), apiKeyCiphertext: sealKey(settings.publicApiKey), contractHash: digest({ examCode: value.scope, protocol: 'platform-sync-v2' }) } } }, include: { federation: true } });
  } else if (!exam.federation?.managedGlobally || (!exam.federation.enabled && !creatorId)) throw new FederationError('本地同编号考试未开启平台同步，不能覆盖');
  const examId = exam.id;
  // Capture local edits before comparing Lamport versions, under the same exam lock as editor writes.
  await federationTransaction(examId, async tx => {
    const current = await tx.examFederation.findUnique({ where: { examId } });
    if (!current?.managedGlobally || (!current.enabled && !creatorId)) throw new FederationError('考试同步已暂停，资料将在恢复后补齐');
    // Runtime/login writers lock their own rows rather than the exam. Lock the
    // incoming entity before capturing so their unsampled edits cannot be overwritten.
    const tables: Record<string,string> = { CANDIDATE:'Candidate', PROBLEM:'ExamProblem', ROOM:'ExamRoom', PRINT:'PrintJob', CHEATING:'CheatingRecord', ALERT:'Alert', LOGIN:'LoginRequest' };
    const table = tables[value.kind];
    if (table) await tx.$queryRaw(Prisma.sql`SELECT id FROM ${Prisma.raw(table)} WHERE examId = ${examId} FOR UPDATE`);
    if (!initializing) await captureExamInTransaction(tx, examId, settings, value);
    await acceptItem(tx, value, async localId => {
      const payload = value.payload;
      const candidateId = async () => {
        if (!payload.candidateKey) return null;
        const candidate = await tx.candidate.findFirst({ where: { examId, syncKey: String(payload.candidateKey) } });
        if (!candidate) { if (value.deleted) return null; throw new FederationError('考生资料尚未同步，将自动重试'); } return candidate.id;
      };
      if (value.kind === 'EXAM') {
        if (value.deleted) throw new FederationError('考试记录不能通过同步自动删除');
        const saved = await tx.exam.update({ where: { id: examId }, data: synchronizedExamFields(payload) });
        return { localId: examId, actual: jsonValue({ ...pick(saved, EXAM_FIELDS), hubNodeId: payload.hubNodeId }) };
      }
      if (value.kind === 'CANDIDATE') {
        const row = localId ? await tx.candidate.findFirst({ where: { id: localId, examId } }) : await tx.candidate.findFirst({ where: { examId, OR: [{ syncKey: value.id }, { syncKey: null, examNumber: String(payload.examNumber) }] } });
        if (value.deleted) {
          if (row) { await assertCandidateCanDelete(tx, examId, [row.id]); await tx.candidate.delete({ where: { id: row.id } }); await clearRoomAssignmentPending(tx, [row.syncKey]); } return { localId: row?.id ?? localId };
        }
        const data = { ...dataFields(payload, CANDIDATE_FIELDS), syncKey: value.id } as Prisma.CandidateUncheckedUpdateInput;
        const saved = row ? await tx.candidate.update({ where: { id: row.id }, data }) : await tx.candidate.create({ data: { ...data as Prisma.CandidateUncheckedCreateInput, examId, ...(localId ? { id: localId } : {}) } });
        if (!row) await awaitRoomAssignment(tx, value.id);
        return { localId: saved.id, actual: jsonValue(pick(saved, CANDIDATE_FIELDS)) };
      }
      if (value.kind === 'PROBLEM') {
        const row = localId ? await tx.examProblem.findFirst({ where: { id: localId, examId } }) : await tx.examProblem.findFirst({ where: { examId, syncKey: null, order: Number(payload.order) } });
        if (value.deleted) { if (row) await tx.examProblem.update({ where: { id: row.id }, data: { sourceDeleted: true } }); return { localId: row?.id ?? localId }; }
        const bank = await tx.platformSyncItem.findUnique({ where: { id: String(payload.bankId) } });
        const hydro = await getHydroSettings();
        if (!bank || bank.kind !== 'BANK' || bank.scope !== 'bank' || (!bank.deleted && !bank.localId?.startsWith(`${hydro.problemDomainId}:`))) throw new FederationError('题库映射尚未同步，将自动重试');
        const data = { ...dataFields(payload, PROBLEM_FIELDS), hydroDomain: hydro.problemDomainId, hydroProblemId: bank.localId?.slice(hydro.problemDomainId.length + 1) || row?.hydroProblemId || `deleted-${bank.id}`, syncKey: value.id,
          sourceDeleted: bank.deleted || payload.sourceDeleted === true } as Prisma.ExamProblemUncheckedCreateInput;
        const occupant = await tx.examProblem.findUnique({ where: { examId_order: { examId, order: data.order } } });
        let displaced: typeof occupant = null, freeOrder = 0;
        if (occupant && occupant.id !== row?.id) {
          const maximum = await tx.examProblem.aggregate({ where: { examId }, _max: { order: true } });
          freeOrder = (maximum._max.order ?? -1) + 1;
          await tx.examProblem.update({ where: { id: occupant.id }, data: { order: freeOrder } });
          displaced = occupant;
        }
        const saved = row ? await tx.examProblem.update({ where: { id: row.id }, data }) : await tx.examProblem.create({ data: { ...data, examId, ...(localId ? { id: localId } : {}) } });
        if (displaced) {
          const order = row ? row.order : freeOrder;
          await tx.examProblem.update({ where: { id: displaced.id }, data: { order } });
          const item = await tx.platformSyncItem.findUnique({ where: { scope_kind_localId: { scope: value.scope, kind: 'PROBLEM', localId: displaced.id } } });
          if (item) await tx.platformSyncItem.update({ where: { id: item.id }, data: { appliedHash: itemHash({ ...(item.payload as Record<string, unknown>), order }) } });
        }
        if (row && row.hydroProblemId !== saved.hydroProblemId) await tx.examQuestion.updateMany({ where: { examId, problemPid: row.hydroProblemId }, data: { problemPid: saved.hydroProblemId } });
        return { localId: saved.id, actual: jsonValue({ ...pick(saved, PROBLEM_FIELDS), bankId: bank.id }) };
      }
      if (value.kind === 'ADMINISTRATORS') {
        await tx.examAdministrator.deleteMany({ where: { examId } });
        for (const user of payload.users as Record<string, unknown>[]) { const saved = await ensureUser(tx, user); await tx.examAdministrator.upsert({ where: { examId_userId: { examId, userId: saved.id } }, create: { examId, userId: saved.id }, update: {} }); }
        const users = await tx.examAdministrator.findMany({ where: { examId }, include: { user: true } });
        return { localId: examId, actual: jsonValue({ users: users.map(a => pick(a.user, ['realName','numberId','username','email'])).sort(compareIdentities) }) };
      }
      if (value.kind === 'ROOM') {
        if (value.deleted) {
          // The separate assignment stream may still contain a move to another
          // room. Cascading memberships first would look like a local null edit.
          if (localId && await tx.examRoomCandidate.count({ where: { roomId: localId, room: { examId } } })) throw new FederationError('等待考生考室变更同步后再移除考室');
          if (localId) await tx.examRoom.deleteMany({ where: { id: localId, examId } });
          return { localId };
        }
        const data = dataFields(payload, ROOM_FIELDS) as Prisma.ExamRoomUncheckedCreateInput;
        const existingRoom = localId ? null : await tx.examRoom.findUnique({ where: { examId_name: { examId, name: data.name } } });
        localId ||= existingRoom?.id || null;
        const room = localId ? await tx.examRoom.upsert({ where: { id: localId }, update: data, create: { ...data, examId, id: localId } }) : await tx.examRoom.create({ data: { ...data, examId } });
        await tx.examRoomProctor.deleteMany({ where: { roomId: room.id } });
        for (const user of payload.proctors as Record<string, unknown>[]) { const saved = await ensureUser(tx, user); await tx.examRoomProctor.upsert({ where: { roomId_userId: { roomId: room.id, userId: saved.id } }, create: { roomId: room.id, userId: saved.id }, update: {} }); }
        const proctors = await tx.examRoomProctor.findMany({ where: { roomId: room.id }, include: { user: true } });
        return { localId: room.id, actual: jsonValue({ ...pick(room, ROOM_FIELDS), proctors: proctors.map(a => pick(a.user, ['realName','numberId','username','email'])).sort(compareIdentities) }) };
      }
      if (value.kind === 'ROOM_ASSIGNMENT') {
        const candidate = await candidateId();
        if (!candidate) { if (value.deleted) return { localId: null }; throw new FederationError('考生尚未同步'); }
        const mapping = payload.roomKey ? await tx.platformSyncItem.findUnique({ where: { id: String(payload.roomKey) } }) : null;
        if (!value.deleted && payload.roomKey && (!mapping?.localId || mapping.deleted || mapping.scope !== value.scope || mapping.kind !== 'ROOM')) throw new FederationError('考室尚未同步');
        await tx.examRoomCandidate.deleteMany({ where: { candidateId: candidate, room: { examId } } });
        if (!value.deleted && mapping?.localId) await tx.examRoomCandidate.create({ data: { candidateId: candidate, roomId: mapping.localId } });
        await clearRoomAssignmentPending(tx, [String(payload.candidateKey)]);
        return { localId: candidate };
      }
      if (value.kind === 'RECEIPT') {
        if (value.deleted) return { localId };
        const candidate = await candidateId();
        if (!candidate || !await tx.examAnnouncement.findFirst({ where: { id: String(payload.announcementId), examId } })) throw new FederationError('公告尚未同步，将自动重试');
        const prior = await tx.platformSyncItem.findUnique({ where: { id: value.id }, select: { payload: true } });
        const identity = prior?.payload as { announcementId?: string; candidateKey?: string } | undefined;
        if (identity && (identity.announcementId !== payload.announcementId || (identity.candidateKey && identity.candidateKey !== payload.candidateKey))) throw new FederationError('公告回执的原始考生或公告不允许改写');
        const acknowledgedAt = new Date(String(payload.acknowledgedAt));
        if (!Number.isFinite(+acknowledgedAt)) throw new FederationError('公告回执时间无效');
        const saved = await tx.examAnnouncementReceipt.upsert({ where: { announcementId_candidateId: { announcementId: String(payload.announcementId), candidateId: candidate } },
          create: { announcementId: String(payload.announcementId), candidateId: candidate, acknowledgedAt }, update: {} });
        await tx.$executeRaw`UPDATE ExamAnnouncementReceipt SET acknowledgedAt = GREATEST(acknowledgedAt, ${acknowledgedAt}) WHERE id = ${saved.id}`;
        // Legacy nodes could assign two transport IDs to this one natural key.
        // Keep the alias durable without binding two IDs to the same local row.
        const bound = await tx.platformSyncItem.findUnique({ where: { scope_kind_localId: { scope: value.scope, kind: 'RECEIPT', localId: saved.id } }, select: { id: true } });
        return { localId: bound && bound.id !== value.id ? null : saved.id };
      }
      if (value.kind === 'MESSAGE_RECEIPT') {
        if (value.deleted) return { localId };
        const prior = await tx.platformSyncItem.findUnique({ where: { id: value.id }, select: { payload: true } });
        if (prior && (prior.payload as {messageId?:unknown}).messageId !== payload.messageId) throw new FederationError('答疑回执的原始消息编号不允许改写');
        const originalId = String(payload.messageId), messageId = await resolveQaMessageId(tx, examId, originalId);
        if (!await tx.examQuestionMessage.findFirst({ where: { id: messageId, question: { examId } } })) throw new FederationError('答疑消息尚未同步，将自动重试');
        const acknowledgedAt = new Date(String(payload.acknowledgedAt));
        if (!Number.isFinite(+acknowledgedAt)) throw new FederationError('答疑回执时间无效');
        await tx.$executeRaw`UPDATE ExamQuestionMessage SET acknowledgedAt = GREATEST(COALESCE(acknowledgedAt, ${acknowledgedAt}), ${acknowledgedAt}) WHERE id = ${messageId}`;
        const bound = await tx.platformSyncItem.findUnique({ where: { scope_kind_localId: { scope: value.scope, kind: 'MESSAGE_RECEIPT', localId: messageId } }, select: { id: true } });
        // Legacy transport aliases carry their original immutable wire identity,
        // but must not compete with the canonical receipt for one local row.
        return { localId: messageId !== originalId || (bound && bound.id !== value.id) ? null : messageId };
      }
      const candidate = await candidateId();
      // Local session/device tokens, IP bindings and all media paths are deliberately absent.
      if (value.kind === 'PRINT') {
        if (value.deleted) { if (localId) await tx.printJob.deleteMany({ where: { id: localId, examId } }); return { localId }; }
        const data = { ...dataFields(payload, PRINT_FIELDS), examId, candidateId: candidate! } as Prisma.PrintJobUncheckedCreateInput;
        const row = localId ? await tx.printJob.upsert({ where: { id: localId }, update: data, create: { ...data, id: localId } }) : await tx.printJob.create({ data }); return { localId: row.id };
      }
      if (value.kind === 'CHEATING') {
        if (value.deleted) { if (localId) await tx.cheatingRecord.deleteMany({ where: { id: localId, examId } }); return { localId }; }
        const data = { ...dataFields(payload, CHEATING_FIELDS), examId, candidateId: candidate! } as Prisma.CheatingRecordUncheckedCreateInput;
        const row = localId ? await tx.cheatingRecord.upsert({ where: { id: localId }, update: data, create: { ...data, id: localId } }) : await tx.cheatingRecord.create({ data }); return { localId: row.id };
      }
      if (value.kind === 'ALERT') {
        if (value.deleted) { if (localId) await tx.alert.deleteMany({ where: { id: localId, examId } }); return { localId }; }
        const data = { ...dataFields(payload, ALERT_FIELDS), examId, candidateId: candidate } as Prisma.AlertUncheckedCreateInput;
        const row = localId ? await tx.alert.upsert({ where: { id: localId }, update: data, create: { ...data, id: localId } }) : await tx.alert.create({ data }); return { localId: row.id };
      }
      if (value.kind === 'LOGIN') {
        if (value.deleted) { if (localId) await tx.loginRequest.deleteMany({ where: { id: localId, examId } }); return { localId }; }
        const photo = payload.photoKey ? await tx.platformSyncItem.findUnique({ where: { id: String(payload.photoKey) } }) : null;
        if (payload.photoKey && (!photo?.localId || photo.kind !== 'PHOTO' || photo.scope !== value.scope || photo.deleted)) throw new FederationError('身份照片尚未同步或来源不一致');
        const media = photo?.localId ? await tx.mediaSegment.findUnique({ where: { id: photo.localId } }) : null;
        if (payload.photoKey && (!media || media.examId !== examId || media.candidateId !== candidate || media.deletedAt || !media.validatedAt)) throw new FederationError('身份照片与考生映射不一致');
        const data = { ...dataFields(payload, LOGIN_FIELDS), examId, candidateId: candidate!, syncMaterialsVerified: payload.materialsVerified === true, identityPhotoPath: media?.objectPath || null } as Prisma.LoginRequestUncheckedCreateInput;
        const row = localId ? await tx.loginRequest.upsert({ where: { id: localId }, update: data, create: { ...data, id: localId } }) : await tx.loginRequest.create({ data }); return { localId: row.id };
      }
      throw new FederationError('未知的考试同步资料');
    });
  });
}
