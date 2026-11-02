import { publicTestExamId } from '@/lib/public-test';
import { LoginRequestCreateSchema } from '@cwnupaa/proctor-shared';
import { prisma } from '@/lib/db';
import { AuthError, requireUser } from '@/lib/auth';
import { canAccessExam } from '@/lib/permissions';
import { verifyCandidateIdentity } from '@/lib/candidate-verify';
import { createCandidateLoginRequest } from '@/lib/candidate-login';
import { LoginFlowError } from '@/lib/room-login-policy';
import { UploadSecurityError } from '@/lib/upload-security';
import { options, fail, ok, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';
import { publicDto, PUBLIC_USER_SELECT } from '@/lib/public-dto';

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const { searchParams } = new URL(request.url);
    const examId = searchParams.get('examId') || undefined;
    if (examId && !(await canAccessExam(user, examId))) return fail('无权查看该考试', 403);

    const loginRequests = await prisma.loginRequest.findMany({
      where: {
        AND: [{ examId }, { examId: { not: await publicTestExamId() } }],
        ...(user.role === 'SUPER_ADMIN'
          ? {}
          : {
              candidate: {
                rooms: {
                  some: {
                    room: {
                      proctors: { some: { userId: user.id } }
                    }
                  }
                }
              }
            })
      },
      include: { candidate: true, exam: true, reviewedBy: { select: PUBLIC_USER_SELECT } },
      orderBy: { createdAt: 'desc' },
      take: 100
    });
    return ok(publicDto(loginRequests));
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    return fail(toErrorMessage(error), 500);
  }
}

export async function POST(request: Request) {
  try {
    const input = await parseBody(request, LoginRequestCreateSchema, 16 * 1024);
    const now = new Date();
    const [exam, pairing] = await Promise.all([
      prisma.exam.findUnique({ where: { examCode: input.examCode } }),
      prisma.pairingSession.findUnique({ where: { pairCode: input.pairCode } })
    ]);
    if (!exam) return fail('考试编号不存在', 404);
    if (exam.id === await publicTestExamId()) return fail('请通过浏览器扫码或配对码直接登录', 403);
    if (input.examId && input.examId !== exam.id) return fail('考试编号与所选考试不匹配', 400);
    if (!pairing || pairing.expiresAt < now) return fail('电脑客户端二维码已过期，请刷新后重试', 400);
    if (!pairing.screenOk) return fail('电脑端屏幕采集未通过，请先在电脑客户端完成屏幕检测', 400);
    const normalizedStudentId = input.studentId?.trim();

    let candidate: { id: string } | null = null;
    let memberIdentity: { memberStudentId: string | null; memberName: string | null } | null = null;

      const result = await verifyCandidateIdentity({
        examId: exam.id,
        examCode: exam.examCode!,
        examNumber: input.examNumber,
        password: input.password,
        studentId: normalizedStudentId,
        name: input.name,
        school: input.school,
        college: input.college,
        teamName: input.teamName
      });
      if (!result.ok) return fail(result.error || '信息不匹配', 400);
      if (!result.candidate) return fail('考号或密码错误', 401);
      candidate = { id: result.candidate.id };
      memberIdentity =
        result.memberIdentity ||
        (result.candidate
          ? { memberStudentId: result.candidate.studentId || null, memberName: result.candidate.name || null }
          : null);
    if (!candidate) return fail('考号或密码错误', 401);

    const loginRequest = await createCandidateLoginRequest({
      exam, pairing, candidateId: candidate.id, memberIdentity, materials: input, method: 'SECOND_CAMERA_QR', now
    });
    return ok(loginRequest, { status: 201 });
  } catch (error) {
    if (error instanceof LoginFlowError || error instanceof UploadSecurityError) return fail(error.message, error.status);
    if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
    return fail(toErrorMessage(error), 500);
  }
}

export const OPTIONS = options;
