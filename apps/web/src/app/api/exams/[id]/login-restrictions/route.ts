import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { AuthError, requireUser } from '@/lib/auth';
import { canAccessCandidate, canAccessExam, canManageExam } from '@/lib/permissions';
import { isPublicTestExam } from '@/lib/public-test';
import { fail, ok, options, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';

const Action = z.discriminatedUnion('action', [
  z.object({ action: z.literal('toggle'), enabled: z.boolean() }),
  z.object({ action: z.literal('release'), candidateIds: z.array(z.string().min(1).max(128)).min(1).max(200) })
]);
const noStore = { headers: { 'Cache-Control': 'private, no-store' } };
function failure(error: unknown) {
  if (error instanceof AuthError) return fail(error.message, error.status);
  if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
  if (error instanceof z.ZodError) return fail('查询参数无效', 400);
  return fail(toErrorMessage(error), 500);
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(), { id } = await context.params;
    if (!await canAccessExam(user, id)) return fail('无权查看该考试登录限制', 403);
    const manageable = await canManageExam(user, id);
    const search = new URL(request.url).searchParams;
    const page = z.coerce.number().int().min(1).max(100000).parse(search.get('page') || 1);
    const query = (search.get('q') || '').trim().slice(0, 100);
    const where: Prisma.CandidateWhereInput = { examId: id,
      ...(!manageable ? { rooms: { some: { room: { proctors: { some: { userId: user.id } } } } } } : {}),
      ...(query ? { OR: ['examNumber', 'name', 'teamName', 'studentId', 'loginIp'].map(field => ({ [field]: { contains: query } })) } : {})
    };
    const [exam, candidates, total] = await Promise.all([
      prisma.exam.findUnique({ where: { id }, select: { ipLoginRestrictionEnabled: true } }),
      prisma.candidate.findMany({ where, select: { id: true, examNumber: true, name: true, teamName: true, seatNo: true,
        loginIp: true, loginIpBoundAt: true, loginIpReleasedAt: true }, orderBy: [{ examNumber: 'asc' }, { id: 'asc' }], skip: (page - 1) * 50, take: 50 }),
      prisma.candidate.count({ where })
    ]);
    if (!exam) return fail('考试不存在', 404);
    return ok({ enabled: exam.ipLoginRestrictionEnabled, canManage: manageable, candidates, total, page, pageSize: 50 }, noStore);
  } catch (error) { return failure(error); }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request), { id } = await context.params;
    if (!await canAccessExam(user, id)) return fail('无权管理该考试登录限制', 403);
    const origin = request.headers.get('origin');
    const allowed = [new URL(request.url).origin, process.env.APP_BASE_URL && new URL(process.env.APP_BASE_URL).origin];
    if (origin && !allowed.includes(origin)) throw new AuthError('请求来源无效', 403);
    if (await isPublicTestExam(id)) return fail('公开测试不启用考试登录 IP 限制', 400);
    const input = await parseBody(request, Action);
    if (input.action === 'toggle') {
      if (!await canManageExam(user, id)) return fail('只有考试管理员可以更改整场考试的登录限制', 403);
      const exam = await prisma.exam.update({ where: { id }, data: { ipLoginRestrictionEnabled: input.enabled }, select: { ipLoginRestrictionEnabled: true } });
      return ok({ enabled: exam.ipLoginRestrictionEnabled }, noStore);
    }
    const ids = [...new Set(input.candidateIds)].sort();
    const candidates = await prisma.candidate.findMany({ where: { examId: id, id: { in: ids } }, select: { id: true } });
    if (candidates.length !== ids.length) return fail('所选考生不属于本场考试', 400);
    if (!await canManageExam(user, id)) {
      if (!(await Promise.all(ids.map(candidateId => canAccessCandidate(user, candidateId)))).every(Boolean)) return fail('只能解除负责考室考生的登录限制', 403);
    }
    const result = await prisma.$transaction(async tx => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM Candidate WHERE examId = ${id} AND id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`);
      return tx.candidate.updateMany({ where: { examId: id, id: { in: ids } }, data: {
        loginIp: null, loginIpBoundAt: null, loginIpReleasedAt: new Date()
      } });
    }, { isolationLevel: 'ReadCommitted' });
    return ok({ released: result.count }, noStore);
  } catch (error) { return failure(error); }
}
export const OPTIONS = options;
