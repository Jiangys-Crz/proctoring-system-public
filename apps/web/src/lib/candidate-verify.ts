import { prisma } from './db';
import { credentialMember } from './credential-login';
import { consumeCandidatePasswordAttempt } from './login-attempts';

export function splitMemberText(value?: string | null) {
  return (value || '')
    .split(/[、,，;；\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function teamMemberIdentity(
  candidate: { teamMembers: string | null; teamMemberStudentIds: string | null },
  studentId: string
) {
  const names = splitMemberText(candidate.teamMembers);
  const ids = splitMemberText(candidate.teamMemberStudentIds);
  const index = ids.findIndex((id) => id === studentId);
  if (index < 0) return null;
  return {
    memberStudentId: ids[index],
    memberName: names[index] || ''
  };
}

export interface CandidateVerifyInput {
  examId?: string;
  examCode: string;
  examNumber: string;
  password: string;
  studentId?: string;
  name?: string;
  school?: string;
  college?: string;
  teamName?: string;
}

export interface CandidateVerifyResult {
  ok: boolean;
  error?: string;
  candidate?: {
    id: string;
    name: string | null;
    studentId: string | null;
    examNumber: string;
    school: string | null;
    college: string | null;
    teamName: string | null;
  };
  memberIdentity?: { memberStudentId: string; memberName: string } | null;
}

/** Validate the four login fields; member metadata comes from the registered candidate. */
export async function verifyCandidateIdentity(input: CandidateVerifyInput): Promise<CandidateVerifyResult> {
  if (!/^\d{10}$/.test(input.examCode || '')) return { ok: false, error: '请输入 10 位考试编号' };
  const exam = await prisma.exam.findUnique({ where: { examCode: input.examCode } });
  if (!exam) return { ok: false, error: '考试编号不存在' };
  if (input.examId && input.examId !== exam.id) return { ok: false, error: '考试编号与所选考试不匹配' };

  const candidates = await prisma.candidate.findMany({ where: { examId: exam.id, examNumber: input.examNumber } });
  await consumeCandidatePasswordAttempt(candidates.map(candidate => candidate.id));
  const matches = candidates.filter(candidate => candidate.password === input.password)
    .map(candidate => ({ candidate, member: credentialMember(candidate, (input.name || '').trim(), exam.contestType === 'TEAM') }))
    .filter(match => match.member);
  if (matches.length !== 1) return { ok: false, error: '考试编号、姓名、考号或密码不匹配，或姓名存在重复，请核对信息并联系监考老师' };
  const { candidate, member } = matches[0];
  const memberIdentity = member?.memberStudentId ? { memberStudentId: member.memberStudentId, memberName: member.memberName } : null;

  return {
    ok: true,
    candidate: {
      id: candidate.id,
      name: candidate.name,
      studentId: candidate.studentId,
      examNumber: candidate.examNumber,
      school: candidate.school,
      college: candidate.college,
      teamName: candidate.teamName
    },
    memberIdentity
  };
}
