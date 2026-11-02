import { publicTestExamId } from '@/lib/public-test';
import { prisma } from '@/lib/db';
import { candidateStartDeadline, flexibleExam } from '@/lib/contest-rules';
import { options, fail, ok, toErrorMessage } from '@/lib/http';

export async function GET(request: Request) {
  try {
    const now = new Date();
    const examCode = new URL(request.url).searchParams.get('examCode');
    if (examCode && !/^\d{10}$/.test(examCode)) return fail('考试编号必须是 10 位数字', 400);
    const testExamId = await publicTestExamId();
    const exams = await prisma.exam.findMany({
      where: { ...(examCode ? {} : { id: { not: testExamId } }), ...(examCode ? { examCode } : {}), endAt: { gt: now } },
      orderBy: { startAt: 'asc' },
      select: {
        id: true,
        examCode: true,
        name: true,
        startAt: true,
        latestStartAt: true,
        endAt: true,
        durationMinutes: true,
        platform: true,
        contestType: true,
        teamAccountMode: true,
        contestRule: true,
        flexible: true,
        published: true,
        requireMiniProgram: true,
        requireFrontCamera: true
      },
      take: 100
    });
    return ok(exams
      .filter(exam => Boolean(examCode) || candidateStartDeadline(exam) >= now)
      .slice(0, 30)
      .map(exam => ({ ...exam, isPublicTest: exam.id === testExamId, latestStartAt: candidateStartDeadline(exam), flexible: flexibleExam(exam) })));
  } catch (error) {
    return fail(toErrorMessage(error), 500);
  }
}

export const OPTIONS = options;
