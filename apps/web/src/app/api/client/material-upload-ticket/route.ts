import { randomBytes } from 'node:crypto';
import { admittedLogin } from '@/lib/request-admission';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { isPublicTestExam } from '@/lib/public-test';
import { verifyCandidateIdentity } from '@/lib/candidate-verify';
import { readCredentialTicket } from '@/lib/credential-login';
import { candidateLoginError } from '@/lib/contest-rules';
import { LoginFlowError, requireRoomLoginMethod } from '@/lib/room-login-policy';
import { hashUploadTicket, consumeRateLimit, UploadSecurityError } from '@/lib/upload-security';
import { fail, ok, options, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';

const Input = z.object({ pairCode: z.string().regex(/^\d{6}$/), miniProgramDeviceId: z.string().min(4).max(128),
  credentialTicket: z.string().max(4096).optional(), examCode: z.string().optional(), examId: z.string().optional(),
  examNumber: z.string().optional(), password: z.string().optional(), name: z.string().optional(), studentId: z.string().optional(),
  school: z.string().optional(), college: z.string().optional(), teamName: z.string().optional() });

export async function POST(request: Request) {
  return admittedLogin(request, () => handlePost(request));
}

async function handlePost(request: Request) {
  try {
    // A global ceiling also covers attempts to manufacture new identities or spoof proxy headers.
    await consumeRateLimit('material-ticket:global', 300);
    const input = await parseBody(request, Input, 16 * 1024);
    await consumeRateLimit(`material-ticket:${input.pairCode}`, 12);
    let candidateId: string, examId: string;
    let memberStudentId: string | null = null, memberName: string | null = null;
    if (input.credentialTicket) {
      const ticket = readCredentialTicket(input.credentialTicket);
      if (ticket.pairCode !== input.pairCode) throw new LoginFlowError('登录凭证与电脑配对不匹配', 403);
      ({ candidateId, examId } = ticket);
      ({ memberStudentId, memberName } = ticket);
    } else {
      const result = await verifyCandidateIdentity({ ...input, examCode: input.examCode || '', examNumber: input.examNumber || '', password: input.password || '' });
      if (!result.ok || !result.candidate) throw new LoginFlowError(result.error || '考生信息不匹配', 401);
      candidateId = result.candidate.id;
      memberStudentId = result.memberIdentity?.memberStudentId || result.candidate.studentId;
      memberName = result.memberIdentity?.memberName || result.candidate.name;
      const candidate = await prisma.candidate.findUniqueOrThrow({ where: { id: candidateId } });
      examId = candidate.examId;
    }
    const [candidate, exam, pair, room] = await Promise.all([
      prisma.candidate.findUnique({ where: { id: candidateId } }), prisma.exam.findUnique({ where: { id: examId } }),
      prisma.pairingSession.findUnique({ where: { pairCode: input.pairCode } }),
      prisma.examRoom.findFirst({ where: { examId, candidates: { some: { candidateId } } } })
    ]);
    if (await isPublicTestExam(examId)) return fail('环境测试无需上传身份材料', 403);
    if (!candidate || candidate.examId !== examId || !exam || candidate.status === 'FINISHED') throw new LoginFlowError('当前考生不能登录此考试', 403);
    const timingError = candidateLoginError(exam, candidate.startedAt, new Date(), false, candidate.lateStartAllowedAt);
    if (timingError) throw new LoginFlowError(timingError, 403);
    if (!pair || pair.purpose !== 'INITIAL' || pair.claimedAt || pair.expiresAt <= new Date() || !pair.screenOk) throw new LoginFlowError('电脑配对已失效，请重新扫码', 403);
    requireRoomLoginMethod(room, input.credentialTicket ? 'CREDENTIALS' : 'SECOND_CAMERA_QR');
    if (!room?.requireSecondCamera) throw new LoginFlowError('该考室无需第二机位材料', 409);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Math.min(pair.expiresAt.getTime(), Date.now() + 10 * 60_000));
    await prisma.materialUploadGrant.create({ data: { tokenHash: hashUploadTicket(token), examId, candidateId, pairingId: pair.id, deviceId: input.miniProgramDeviceId, memberStudentId, memberName, expiresAt } });
    return ok({ uploadTicket: token, expiresAt, candidateId }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof RequestParseError) return fail('材料上传参数不完整', 400);
    return fail(toErrorMessage(error), error instanceof LoginFlowError || error instanceof UploadSecurityError ? error.status : 500);
  }
}
export const OPTIONS = options;
