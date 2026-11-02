import { prisma } from '@/lib/db';
import { verifyClientTokenForAnySide } from '@/lib/client-auth';
import { isPublicTestExam } from '@/lib/public-test';
import { testMediaState } from '@/lib/test-media-state';
import { fail, ok, options, toErrorMessage } from '@/lib/http';

export async function GET(request: Request) {
  try {
    const id = new URL(request.url).searchParams.get('sessionId') || '';
    const session = await prisma.clientSession.findUnique({ where: { id } });
    if (!session || !verifyClientTokenForAnySide(request, session)) return fail('当前连接已失效，请重新登录', 401);
    if (!await isPublicTestExam(session.examId)) return fail('仅系统测试考试可查看环境检测', 403);
    return ok({ recording: false, channels: await testMediaState(session.id) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return fail(toErrorMessage(error), 500); }
}
export const OPTIONS = options;
