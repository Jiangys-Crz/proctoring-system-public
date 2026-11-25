import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { AuthError, requireUser } from '@/lib/auth';
import { canAccessExam, candidateRoomScope, canManageExam } from '@/lib/permissions';
import { isPublicTestExam } from '@/lib/public-test';
import { fail, ok, options, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';
import { examRoomLoginIpPolicies, restrictedCandidateWhere, setRoomLoginIpPolicy } from '@/lib/room-login-ip';
import { federationTransaction } from '@/lib/exam-federation-store';

const Action = z.discriminatedUnion('action', [
  z.object({ action: z.literal('toggle'), enabled: z.boolean() }),
  z.object({ action: z.literal('set-room'), roomId: z.string().min(1).max(128), enabled: z.boolean() }),
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
    const user = await requireUser(request), { id } = await context.params;
    if (!await canAccessExam(user, id)) return fail('无权查看该考试登录限制', 403);
    const manageable = await canManageExam(user, id);
    const search = new URL(request.url).searchParams;
    const page = z.coerce.number().int().min(1).max(100000).parse(search.get('page') || 1);
    const query = (search.get('q') || '').trim().slice(0, 100);
    if (await isPublicTestExam(id)) return ok({ enabled: false, canManage: false, rooms: [], candidates: [], total: 0, page, pageSize: 50 }, noStore);
    const policy = await examRoomLoginIpPolicies(id);
    const where: Prisma.CandidateWhereInput = { AND: [manageable ? { examId: id } : candidateRoomScope(id, user.id),
      restrictedCandidateWhere(id, policy),
      ...(query ? [{ OR: ['examNumber', 'name', 'teamName', 'studentId', 'loginIp'].map(field => ({ [field]: { contains: query } })) }] : []),
    ] };
    const [candidates, total, visible] = await Promise.all([
      prisma.candidate.findMany({ where, select: { id: true, examNumber: true, name: true, teamName: true, seatNo: true,
        loginIp: true, loginIpBoundAt: true, loginIpReleasedAt: true }, orderBy: [{ examNumber: 'asc' }, { id: 'asc' }], skip: (page - 1) * 50, take: 50 }),
      prisma.candidate.count({ where }),
      manageable ? Promise.resolve(null) : prisma.examRoom.findMany({ where: { examId: id, proctors: { some: { userId: user.id } } }, select: { id: true } }),
    ]);
    const rooms = visible ? policy.rooms.filter(room => visible.some(row => row.id === room.id)) : policy.rooms;
    return ok({ enabled: policy.defaultEnabled, rooms, canManage: manageable, candidates, total, page, pageSize: 50 }, noStore);
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
    if (input.action === 'toggle' || input.action === 'set-room') {
      if (!await canManageExam(user, id)) return fail('只有考试管理员可以更改考室的登录限制', 403);
      await federationTransaction(id, async tx => {
        if (input.action === 'set-room') {
          const room = await tx.examRoom.findFirst({ where: { id: input.roomId, examId: id }, select: { id: true } });
          if (!room) throw new AuthError('考室不存在或不属于本场考试', 404);
          await setRoomLoginIpPolicy(tx, id, room.id, input.enabled);
        } else {
          await tx.exam.update({ where: { id }, data: { ipLoginRestrictionEnabled: input.enabled } });
          const rooms = await tx.examRoom.findMany({ where: { examId: id }, select: { id: true } });
          for (const room of rooms) await setRoomLoginIpPolicy(tx, id, room.id, input.enabled);
        }
      });
      return ok({ enabled: input.enabled }, noStore);
    }
    const ids = [...new Set(input.candidateIds)].sort();
    const candidates = await prisma.candidate.findMany({ where: { examId: id, id: { in: ids } }, select: { id: true } });
    if (candidates.length !== ids.length) return fail('所选考生不属于本场考试', 400);
    const scope = await canManageExam(user, id) ? { examId: id } : candidateRoomScope(id, user.id);
    const result = await prisma.$transaction(async tx => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM Candidate WHERE examId = ${id} AND id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`);
      const policy = await examRoomLoginIpPolicies(id, tx);
      const updated = await tx.candidate.updateMany({ where: { AND: [scope, { id: { in: ids } }, restrictedCandidateWhere(id, policy)] }, data: {
        loginIp: null, loginIpBoundAt: null, loginIpReleasedAt: new Date()
      } });
      if (updated.count !== ids.length) throw new AuthError('只能解除负责考室中已启用 IP 限制的考生，请刷新列表', 403);
      return updated;
    }, { isolationLevel: 'ReadCommitted' });
    return ok({ released: result.count }, noStore);
  } catch (error) { return failure(error); }
}
export const OPTIONS = options;
