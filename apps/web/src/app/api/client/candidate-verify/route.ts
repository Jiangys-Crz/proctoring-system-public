import { admittedLogin } from '@/lib/request-admission';
import { z } from 'zod';
import { verifyCandidateIdentity } from '@/lib/candidate-verify';
import { LoginFlowError, requireRoomLoginMethod } from '@/lib/room-login-policy';
import { isPublicTestExam } from '@/lib/public-test';
import { prisma } from '@/lib/db';
import { UploadSecurityError } from '@/lib/upload-security';
import { candidateLoginError } from '@/lib/contest-rules';
import { options, fail, ok, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';

const Input = z.object({
  examCode: z.string().trim().regex(/^\d{10}$/), examId: z.string().max(191).optional(),
  examNumber: z.string().trim().min(1).max(191), password: z.string().min(1).max(200),
  name: z.string().trim().min(1).max(191), studentId: z.string().max(191).optional(),
  school: z.string().max(191).optional(), college: z.string().max(191).optional(), teamName: z.string().max(191).optional(),
});

export async function POST(request: Request) {
  return admittedLogin(request, () => handlePost(request));
}

async function handlePost(request: Request) {
  try {
    const body = await parseBody(request, Input, 16 * 1024);
    const result = await verifyCandidateIdentity(body);
    if (!result.ok) return fail(result.error || '信息不匹配', 400);
    const candidate = result.candidate?.id ? await prisma.candidate.findUnique({
      where: { id: result.candidate.id }, include: { exam: true }
    }) : null;
    const publicTest = !!candidate && await isPublicTestExam(candidate.examId);
    if (candidate) {
      const timingError = candidateLoginError(candidate.exam, candidate.startedAt, new Date(), publicTest, candidate.lateStartAllowedAt);
      if (timingError) throw new LoginFlowError(timingError, 403);
    }
    const room = result.candidate?.id ? await prisma.examRoom.findFirst({
      where: { candidates: { some: { candidateId: result.candidate.id } } }
    }) : null;
    requireRoomLoginMethod(room, 'SECOND_CAMERA_QR');
    return ok({
      candidateId: result.candidate?.id,
      name: result.candidate?.name,
      memberIdentity: result.memberIdentity,
      requirements: room ? {
        requireSecondCamera: room.requireSecondCamera,
        requireFrontCamera: room.requireFrontCamera,
        loginMode: room.loginMode, isPublicTest: publicTest
      } : null
    });
  } catch (error) {
    if (error instanceof RequestParseError) return fail(error.message, 400);
    if (error instanceof LoginFlowError || error instanceof UploadSecurityError) return fail(error.message, error.status);
    return fail(toErrorMessage(error), 500);
  }
}

export const OPTIONS = options;
