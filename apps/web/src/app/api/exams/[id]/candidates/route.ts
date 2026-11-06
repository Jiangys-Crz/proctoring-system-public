import { assertFederationDefinitionMutable } from '@/lib/exam-federation-contract';
import { z } from 'zod';
import { normalizeParticipationGroup, participationOptions, isXcpcLeaderboard, isFemale } from '@cwnupaa/proctor-shared/leaderboard';
import { CandidateImportRowSchema } from '@cwnupaa/proctor-shared';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { AuthError, requireUser } from '@/lib/auth';
import { canManageExam } from '@/lib/permissions';
import { candidateIdentityLookup } from '@/lib/candidate-identity';
import { options, fail, ok, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';

const ImportSchema = z.object({ rows: z.array(CandidateImportRowSchema).min(1) });
const CandidateUpdateSchema = CandidateImportRowSchema.extend({ id: z.string().min(1) });
const CandidateDeleteSchema = z.object({ ids: z.array(z.string().min(1)).min(1) });
type CandidateImportRow = z.infer<typeof CandidateImportRowSchema>;
type TeamAccountMode = 'MEMBER_ACCOUNTS' | 'TEAM_ACCOUNT';

function clean(value?: string) { return value?.trim() || null; }
function normalizeRow(row: CandidateImportRow, contestRule: string, contestType: string) {
  let groupName = normalizeParticipationGroup(contestRule, row.groupName);
  if (isXcpcLeaderboard(contestRule) && contestType === 'INDIVIDUAL' && groupName === 'official' && isFemale(row.gender)) groupName = 'girl';
  return {
    name: clean(row.name), studentId: clean(row.studentId), school: clean(row.school), college: clean(row.college), major: clean(row.major),
    gender: clean(row.gender), gradeYear: clean(row.gradeYear), className: clean(row.className), advisor: clean(row.advisor), groupName: groupName || null,
    teamName: clean(row.teamName), teamMembers: clean(row.teamMembers), teamMemberStudentIds: clean(row.teamMemberStudentIds), hydroAccount: null,
    examNumber: row.examNumber.trim(), password: row.password.trim(), seatNo: row.seatNo.trim(),
    isTeamLeader: Boolean(row.isTeamLeader), ranked: row.ranked !== false && !(isXcpcLeaderboard(contestRule) && groupName === 'star')
  };
}

function memberIds(row: ReturnType<typeof normalizeRow>, contestType: 'INDIVIDUAL' | 'TEAM', teamAccountMode: TeamAccountMode) {
  return contestType === 'TEAM' && teamAccountMode === 'TEAM_ACCOUNT'
    ? (row.teamMemberStudentIds || '').split(/[、,，;；\s]+/).map(value => value.trim()).filter(Boolean)
    : row.studentId ? [row.studentId] : [];
}

function memberNames(row: ReturnType<typeof normalizeRow>) {
  return (row.teamMembers || '').split(/[、,，;；\s]+/).map(value => value.trim()).filter(Boolean);
}

function validateRows(contestRule: string, contestType: 'INDIVIDUAL' | 'TEAM', teamAccountMode: TeamAccountMode, rows: ReturnType<typeof normalizeRow>[]) {
  const errors: string[] = [];
  const identities = new Set<string>();
  rows.forEach((row, index) => {
    const rowNo = index + 1;
    const singleTeamAccount = contestType === 'TEAM' && teamAccountMode === 'TEAM_ACCOUNT';
    if (!singleTeamAccount && !row.name) errors.push(`第 ${rowNo} 行缺少姓名`);
    if (!singleTeamAccount && !row.studentId) errors.push(`第 ${rowNo} 行缺少学号`);
    if (!row.school) errors.push(`第 ${rowNo} 行缺少学校`);
    const options = participationOptions(contestRule);
    if (options.length && !options.some(option => option.value === row.groupName)) errors.push(`第 ${rowNo} 行参赛组别须为：${options.map(option => option.label).join('、')}`);
    const ids = memberIds(row, contestType, teamAccountMode);
    ids.forEach(studentId => {
      const identity = `${row.school || ''}\0${studentId}`;
      if (row.school && identities.has(identity)) errors.push(`第 ${rowNo} 行的学校和学号 ${studentId} 重复`);
      identities.add(identity);
    });
    if (contestType === 'TEAM') {
      if (!row.teamName) errors.push(`第 ${rowNo} 行缺少队伍名称`);
      if (singleTeamAccount) {
        const names = memberNames(row);
        if (!names.length) errors.push(`第 ${rowNo} 行缺少队伍成员姓名`);
        if (!ids.length) errors.push(`第 ${rowNo} 行缺少队伍成员学号`);
        if (names.length !== ids.length) errors.push(`第 ${rowNo} 行的成员姓名与学号数量不一致`);
      }
    }
  });
  if (contestType === 'TEAM') {
    const teamGroups = new Map<string, string>();
    const teamMetadata = new Map<string, string>();
    const teamLeaders = new Map<string, number>();
    rows.forEach((row, index) => {
      if (!row.teamName) return;
      const previousGroup = teamGroups.get(row.teamName);
      if (previousGroup !== undefined && previousGroup !== (row.groupName || '')) errors.push(`第 ${index + 1} 行与同队伍的组别不一致`);
      teamGroups.set(row.teamName, row.groupName || '');
      const metadata = `${row.ranked}\0${row.advisor || ''}`;
      const previousMetadata = teamMetadata.get(row.teamName);
      if (previousMetadata !== undefined && previousMetadata !== metadata) errors.push(`第 ${index + 1} 行与同队伍的指导老师或是否排名不一致`);
      teamMetadata.set(row.teamName, metadata);
      if (row.isTeamLeader) teamLeaders.set(row.teamName, (teamLeaders.get(row.teamName) || 0) + 1);
    });
    if (contestRule === 'XCPC' && teamAccountMode === 'MEMBER_ACCOUNTS') {
      for (const teamName of new Set(rows.map(row => row.teamName).filter(Boolean) as string[])) {
        if ((teamLeaders.get(teamName) || 0) > 1) errors.push(`队伍 ${teamName} 只能设置一名队长`);
      }
    }
  }
  return errors;
}

async function assertUniqueness(tx: Prisma.TransactionClient, examId: string, contestType: 'INDIVIDUAL' | 'TEAM', teamAccountMode: TeamAccountMode, row: ReturnType<typeof normalizeRow>, exceptId?: string, previousTeamName?: string | null) {
  if (row.school) {
    const ids = memberIds(row, contestType, teamAccountMode);
    // Candidate identities are unique only inside one exam. The same student
    // must be able to register for other exams using the same school and ID.
    const sameSchool = ids.length ? await tx.candidate.findMany({ where: candidateIdentityLookup(examId, row.school, exceptId), select: { studentId: true, teamMemberStudentIds: true } }) : [];
    const usedIds = new Set(sameSchool.flatMap(candidate => [candidate.studentId || '', ...(candidate.teamMemberStudentIds || '').split(/[、,，;；\s]+/)]).filter(Boolean));
    const duplicateId = ids.find(studentId => usedIds.has(studentId));
    if (duplicateId) throw new RequestParseError(`学号 ${duplicateId} 在本场考试的学校 ${row.school} 中已存在`);
  }
  const numberOwner = await tx.candidate.findFirst({ where: { examId, examNumber: row.examNumber, ...(exceptId ? { id: { not: exceptId } } : {}) } });
  if (numberOwner) throw new RequestParseError(`考号 ${row.examNumber} 在本场考试中已被使用`);
  if (contestType === 'TEAM' && row.teamName) {
    const teamOwner = await tx.candidate.findFirst({ where: { examId, teamName: row.teamName, ...(exceptId ? { id: { not: exceptId } } : {}) } });
    if (teamAccountMode === 'TEAM_ACCOUNT' && teamOwner) throw new RequestParseError(`队伍名称 ${row.teamName} 在本场考试中已被使用`);
    if (teamOwner && row.teamName !== previousTeamName && ((teamOwner.groupName || '') !== (row.groupName || '') || teamOwner.ranked !== row.ranked || (teamOwner.advisor || '') !== (row.advisor || ''))) throw new RequestParseError(`队伍 ${row.teamName} 的组别、指导老师和是否排名必须一致`);
    if (teamAccountMode === 'MEMBER_ACCOUNTS' && row.isTeamLeader) {
      const leader = await tx.candidate.findFirst({ where: { examId, teamName: row.teamName, isTeamLeader: true, ...(exceptId ? { id: { not: exceptId } } : {}) } });
      if (leader) throw new RequestParseError(`队伍 ${row.teamName} 已设置队长，每个队伍只能有一名队长`);
    }
  }
}

/** Credential management is intentionally separate from public monitoring DTOs. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(); const { id } = await context.params;
    if (!(await canManageExam(user, id))) return fail('无权管理该考试的考生', 403);
    return ok(await prisma.candidate.findMany({ where: { examId: id }, orderBy: [{ seatNo: 'asc' }, { examNumber: 'asc' }] }));
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    return fail(toErrorMessage(error), 500);
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request); const { id } = await context.params;
    if (!(await canManageExam(user, id))) return fail('无权管理该考试的考生', 403);
    const input = await parseBody(request, ImportSchema);
    const exam = await prisma.exam.findUnique({ where: { id } });
    if (!exam) return fail('考试不存在', 404);
    const rows = input.rows.map(row => normalizeRow(row, exam.contestRule, exam.contestType));
    const errors = validateRows(exam.contestRule, exam.contestType, exam.teamAccountMode, rows);
    if (errors.length) return fail(errors.join('；'), 400, errors);
    const result = await prisma.$transaction(async tx => {
      await assertFederationDefinitionMutable(tx, id);
      const roomNames = [...new Set(input.rows.map(row => clean(row.roomName)).filter((name): name is string => Boolean(name)))];
      const rooms = roomNames.length ? await tx.examRoom.findMany({ where: { examId: id, name: { in: roomNames } } }) : [];
      const roomIds = new Map(rooms.map(room => [room.name, room.id]));
      const missing = roomNames.filter(name => !roomIds.has(name));
      if (missing.length) throw new RequestParseError(`本场考试不存在考室：${missing.join('、')}，请先创建考室或修改考室名称`);
      const teamRooms = new Map<string, string>();
      if (exam.contestType === 'TEAM') {
        rows.forEach((row, index) => {
          const roomName = clean(input.rows[index].roomName);
          if (!row.teamName || !roomName) return;
          if (teamRooms.has(row.teamName) && teamRooms.get(row.teamName) !== roomName) throw new RequestParseError(`队伍 ${row.teamName} 的考室必须一致`);
          teamRooms.set(row.teamName, roomName);
        });
      }
      const saved = [];
      for (const row of rows) {
        const existing = exam.contestType === 'TEAM' && exam.teamAccountMode === 'TEAM_ACCOUNT'
          ? await tx.candidate.findFirst({ where: { examId: id, examNumber: row.examNumber } })
          : row.school && row.studentId ? await tx.candidate.findFirst({ where: { examId: id, school: row.school, studentId: row.studentId } }) : null;
        await assertUniqueness(tx, id, exam.contestType, exam.teamAccountMode, row, existing?.id);
        saved.push(existing ? await tx.candidate.update({ where: { id: existing.id }, data: row }) : await tx.candidate.create({ data: { ...row, examId: id } }));
      }
      // Resolve team members after all upserts, including members already imported.
      const assignments = new Map<string, string>();
      saved.forEach((candidate, index) => {
        const roomName = clean(input.rows[index].roomName);
        if (roomName) assignments.set(candidate.id, roomIds.get(roomName)!);
      });
      for (const [teamName, roomName] of teamRooms) {
        const members = await tx.candidate.findMany({ where: { examId: id, teamName }, select: { id: true } });
        for (const member of members) assignments.set(member.id, roomIds.get(roomName)!);
      }
      if (assignments.size) {
        await tx.examRoomCandidate.deleteMany({ where: { candidateId: { in: [...assignments.keys()] }, room: { examId: id } } });
        await tx.examRoomCandidate.createMany({ data: [...assignments].map(([candidateId, roomId]) => ({ candidateId, roomId })) });
      }
      return saved;
    }, { timeout: 60_000 });
    return ok({ imported: result.length, candidates: result });
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
    return fail(toErrorMessage(error), 500);
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request); const { id } = await context.params;
    if (!(await canManageExam(user, id))) return fail('无权管理该考试的考生', 403);
    const input = await parseBody(request, CandidateUpdateSchema);
    const exam = await prisma.exam.findUnique({ where: { id } });
    if (!exam) return fail('考试不存在', 404);
    const row = normalizeRow(input, exam.contestRule, exam.contestType);
    const errors = validateRows(exam.contestRule, exam.contestType, exam.teamAccountMode, [row]);
    if (errors.length) return fail(errors.join('；'), 400, errors);
    const updated = await prisma.$transaction(async tx => {
      await assertFederationDefinitionMutable(tx, id);
      const current = await tx.candidate.findFirst({ where: { id: input.id, examId: id } });
      if (!current) throw new RequestParseError('考生不存在');
      await assertUniqueness(tx, id, exam.contestType, exam.teamAccountMode, row, current.id, current.teamName);
      if (exam.contestType === 'TEAM' && exam.teamAccountMode === 'MEMBER_ACCOUNTS' && current.teamName) {
        await tx.candidate.updateMany({ where: { examId: id, teamName: current.teamName }, data: { teamName: row.teamName, groupName: row.groupName, advisor: row.advisor, ranked: row.ranked } });
      }
      return tx.candidate.update({ where: { id: current.id }, data: row });
    });
    return ok(updated);
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
    return fail(toErrorMessage(error), 500);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request); const { id } = await context.params;
    if (!(await canManageExam(user, id))) return fail('无权管理该考试的考生', 403);
    const input = await parseBody(request, CandidateDeleteSchema);
    const result = await prisma.$transaction(async tx => {
      await assertFederationDefinitionMutable(tx, id);
      return tx.candidate.deleteMany({ where: { examId: id, id: { in: input.ids } } });
    });
    return ok({ deleted: result.count });
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
    return fail(toErrorMessage(error), 500);
  }
}

export const OPTIONS = options;
