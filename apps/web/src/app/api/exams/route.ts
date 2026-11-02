import { publicTestExamId } from '@/lib/public-test';
import { CreateExamSchema } from '@cwnupaa/proctor-shared';
import { prisma } from '@/lib/db';
import { AuthError, requireSuperAdmin, requireUser } from '@/lib/auth';
import { saveExam } from '@/lib/exam-save';
import { ExamSettingsError } from '@/lib/exam-settings';
import { options, fail, ok, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';
import { publicDto } from '@/lib/public-dto';

export async function GET() {
  try {
    const user = await requireUser();
    const testExamId = await publicTestExamId();
    const candidateScope = user.role === 'SUPER_ADMIN' ? {} : { OR: [
      { exam: { createdById: user.id } }, { exam: { administrators: { some: { userId: user.id } } } },
      { rooms: { some: { room: { proctors: { some: { userId: user.id } } } } } },
    ] };
    const include = { _count: { select: { candidates: { where: candidateScope },
      loginRequests: { where: { candidate: candidateScope } }, alerts: { where: { candidate: candidateScope } }, problems: true } },
      problems: { select: { id: true } }, administrators: { select: { userId: true } } } as const;
    const exams =
      user.role === 'SUPER_ADMIN'
        ? await prisma.exam.findMany({
            where: { id: { not: testExamId } },
            orderBy: { startAt: 'desc' },
            include
          })
        : await prisma.exam.findMany({
            where: {
              id: { not: testExamId },
              OR: [
                { createdById: user.id },
                { administrators: { some: { userId: user.id } } },
                { rooms: { some: { proctors: { some: { userId: user.id } } } } }
              ]
            },
            orderBy: { startAt: 'desc' },
            include
          });
    return ok(publicDto(exams.map(exam => ({ ...exam, canManage: user.role === 'SUPER_ADMIN' || exam.createdById === user.id || exam.administrators.some(admin => admin.userId === user.id) }))));
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    return fail(toErrorMessage(error), 500);
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireSuperAdmin(request);
    const input = await parseBody(request, CreateExamSchema);
    const exam = await saveExam(input, user.id);
    return ok(exam, { status: 201 });
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    if (error instanceof ExamSettingsError) return fail(error.message, 400);
    if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
    return fail(toErrorMessage(error), 500);
  }
}

export const OPTIONS = options;
