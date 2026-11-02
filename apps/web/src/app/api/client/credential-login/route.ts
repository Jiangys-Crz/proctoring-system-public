import { z } from 'zod';
import { prisma } from '@/lib/db';
import { isPublicTestExam } from '@/lib/public-test';
import { createCandidateLoginRequest } from '@/lib/candidate-login';
import { credentialMember, readCredentialTicket, signCredentialTicket } from '@/lib/credential-login';
import { LoginFlowError, requireRoomLoginMethod } from '@/lib/room-login-policy';
import { candidateLoginError, candidateStartDeadline } from '@/lib/contest-rules';
import { fail, ok, options, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';
import { assertLoginIp, desktopRequestIp } from '@/lib/login-ip';
import { consumeCandidatePasswordAttempt } from '@/lib/login-attempts';
import { UploadSecurityError } from '@/lib/upload-security';

const Credentials = z.object({
  examCode: z.string().trim().regex(/^\d{10}$/), name: z.string().trim().min(1).max(191),
  examNumber: z.string().trim().min(1).max(191), password: z.string().min(1).max(200), pairCode: z.string().regex(/^\d{6}$/)
});
const Inspect = z.object({ credentialTicket: z.string().min(1).max(4096), action: z.literal('inspect') });
const Materials = z.object({
  credentialTicket: z.string().min(1).max(4096), miniProgramDeviceId: z.string().min(4),
  uploadTicket: z.string().min(1).max(128),
  identityPhotoPath: z.string().min(1), roomVideoPath: z.string().min(1)
});

async function ticketContext(value: string) {
  const ticket = readCredentialTicket(value);
  const [exam, pairing, candidate, room] = await Promise.all([
    prisma.exam.findUnique({ where: { id: ticket.examId } }),
    prisma.pairingSession.findUnique({ where: { pairCode: ticket.pairCode } }),
    prisma.candidate.findUnique({ where: { id: ticket.candidateId } }),
    prisma.examRoom.findFirst({ where: { examId: ticket.examId, candidates: { some: { candidateId: ticket.candidateId } } } })
  ]);
  if (!exam || !candidate || candidate.examId !== exam.id || !pairing || pairing.claimedAt || pairing.expiresAt <= new Date()) throw new LoginFlowError('第二机位登录已失效，请在电脑重新登录', 401);
  if (await isPublicTestExam(exam.id)) throw new LoginFlowError('请在浏览器填写测试账号，通过扫码或配对码登录', 403);
  const now = new Date();
  const timingError = candidateLoginError(exam, candidate.startedAt, now, false, candidate.lateStartAllowedAt);
  if (timingError) throw new LoginFlowError(timingError, 403);
  requireRoomLoginMethod(room, 'CREDENTIALS');
  return { ticket, exam, pairing, candidate, room: room! };
}

export async function POST(request: Request) {
  try {
    const input = await parseBody(request, z.union([Inspect, Materials, Credentials]), 16 * 1024);
    if ('credentialTicket' in input) {
      const { ticket, exam, pairing, candidate, room } = await ticketContext(input.credentialTicket);
      if ('action' in input) return ok({
        pairCode: ticket.pairCode, name: ticket.memberName, studentId: ticket.memberStudentId, examNumber: candidate.examNumber,
        exam: { id: exam.id, examCode: exam.examCode, name: exam.name, startAt: exam.startAt, latestStartAt: candidateStartDeadline(exam, candidate.lateStartAllowedAt), endAt: exam.endAt, durationMinutes: exam.durationMinutes, contestType: exam.contestType, teamAccountMode: exam.teamAccountMode, requireMiniProgram: exam.requireMiniProgram, requireFrontCamera: exam.requireFrontCamera },
        requirements: { requireSecondCamera: room.requireSecondCamera, requireFrontCamera: room.requireFrontCamera, loginMode: room.loginMode, saveFullRecording: exam.saveFullRecording, saveIncidentRecording: exam.saveIncidentRecording }
      });
      return ok(await createCandidateLoginRequest({
        exam, pairing, candidateId: candidate.id, method: 'CREDENTIALS', materials: input,
        memberIdentity: { memberName: ticket.memberName, memberStudentId: ticket.memberStudentId }
      }), { status: 201 });
    }
    const exam = await prisma.exam.findUnique({ where: { examCode: input.examCode } });
    if (!exam) throw new LoginFlowError('考试编号、姓名、考号或密码错误', 401);
    if (await isPublicTestExam(exam.id)) throw new LoginFlowError('请在浏览器填写测试账号，通过扫码或配对码登录', 403);
    const candidates = await prisma.candidate.findMany({ where: { examId: exam.id, examNumber: input.examNumber } });
    await consumeCandidatePasswordAttempt(candidates.map(candidate => candidate.id));
    const matches = candidates.filter(candidate => candidate.password === input.password)
      .map(candidate => ({ candidate, member: credentialMember(candidate, input.name, exam.contestType === 'TEAM') }))
      .filter(match => match.member);
    if (matches.length !== 1) throw new LoginFlowError('考试编号、姓名、考号或密码不匹配，或姓名存在重复，请核对信息并联系监考老师', 401);
    const { candidate, member } = matches[0];
    const [pairing, room] = await Promise.all([
      prisma.pairingSession.findUnique({ where: { pairCode: input.pairCode } }),
      prisma.examRoom.findFirst({ where: { examId: exam.id, candidates: { some: { candidateId: candidate.id } } } })
    ]);
    requireRoomLoginMethod(room, 'CREDENTIALS');
    const now = new Date();
    const timingError = candidateLoginError(exam, candidate.startedAt, now, false, candidate.lateStartAllowedAt);
    if (timingError) throw new LoginFlowError(timingError, 403);
    if (!pairing) throw new LoginFlowError('登录配对已使用或过期，请重新提交登录');
    assertLoginIp(exam.ipLoginRestrictionEnabled, candidate.loginIp, desktopRequestIp(request));
    if (pairing.claimedAt && pairing.loginRequestId) {
      const completed = await prisma.loginRequest.findUnique({
        where: { id: pairing.loginRequestId },
        include: { clientSessions: { orderBy: { createdAt: 'desc' }, take: 1 } }
      });
      const existingSession = completed?.candidateId === candidate.id ? completed.clientSessions[0] : null;
      if (completed && existingSession) {
        return ok({ requiresSecondCamera: false, id: completed.id, sessionId: existingSession.id });
      }
    }
    if (pairing.expiresAt <= now || pairing.claimedAt) throw new LoginFlowError('登录配对已使用或过期，请重新提交登录');
    if (!pairing.screenOk) throw new LoginFlowError('请先完成电脑屏幕检测');
    if (room!.requireSecondCamera && !await isPublicTestExam(exam.id)) {
      const credentialTicket = signCredentialTicket({
        purpose: 'desktop-login-materials', pairCode: pairing.pairCode, examId: exam.id, candidateId: candidate.id,
        memberName: member!.memberName, memberStudentId: member!.memberStudentId,
        expiresAt: Math.min(pairing.expiresAt.getTime(), Date.now() + 5 * 60 * 1000)
      });
      return ok({ requiresSecondCamera: true, credentialTicket, expiresAt: pairing.expiresAt });
    }
    const result = await createCandidateLoginRequest({ exam, pairing, candidateId: candidate.id, memberIdentity: member!, materials: {}, method: 'CREDENTIALS' });
    return ok({ requiresSecondCamera: false, id: result.id, sessionId: result.sessionId }, { status: 201 });
  } catch (error) {
    if (error instanceof RequestParseError) return fail('请填写完整的考试编号、姓名、考号和密码，或重新扫码提交第二机位材料', 400);
    return fail(toErrorMessage(error), error instanceof LoginFlowError || error instanceof UploadSecurityError ? error.status : 500);
  }
}

export const OPTIONS = options;
