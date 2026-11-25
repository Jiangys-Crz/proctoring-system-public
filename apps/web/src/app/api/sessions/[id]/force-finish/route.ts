import { prisma } from '@/lib/db';
import { isPublicTestExam } from '@/lib/public-test';
import { AuthError, requireUser } from '@/lib/auth';
import { canAccessCandidate } from '@/lib/permissions';
import { publicClientSession } from '@/lib/client-auth';
import { options, fail, ok, toErrorMessage } from '@/lib/http';
import { stopTerminalSessionMedia } from '@/lib/session-media-lifecycle';

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(_request);
    const { id } = await context.params;
    const session = await prisma.clientSession.findUnique({ where: { id } });
    if (!session) return fail('客户端会话不存在', 404);
    if (!(await canAccessCandidate(user, session.candidateId))) return fail('无权结束该考生考试', 403);

    const { updated, sessionIds } = await prisma.$transaction(async (tx) => {
      // Serialize with replacement logins so the sessions being stopped match
      // the set marked finished by this transaction.
      await tx.$queryRaw`SELECT id FROM ClientSession WHERE candidateId = ${session.candidateId} ORDER BY id FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM Candidate WHERE id = ${session.candidateId} FOR UPDATE`;
      const scope = { examId: session.examId, candidateId: session.candidateId, status: { not: 'FINISHED' as const } };
      const active = await tx.clientSession.findMany({ where: scope, select: { id: true } });
      const endedAt = new Date();
      await tx.clientSession.updateMany({
        where: scope,
        data: {
          status: 'FINISHED',
          endedAt,
          lockdown: false,
          lockdownReason: null
        }
      });
      await tx.candidate.update({
        where: { id: session.candidateId },
        data: { status: 'FINISHED' }
      });
      if (active.length && !await isPublicTestExam(session.examId, tx)) await tx.alert.create({
        data: {
          examId: session.examId,
          candidateId: session.candidateId,
          sessionId: session.id,
          type: 'MANUAL_NOTE',
          severity: 3,
          message: `监考老师 ${user.realName || user.username || user.numberId || user.id} 已结束该考生考试`
        }
      });
      return {
        updated: await tx.clientSession.findUniqueOrThrow({ where: { id } }),
        sessionIds: [...new Set([id, ...active.map(item => item.id)])]
      };
    }, { isolationLevel: 'ReadCommitted' });

    await stopTerminalSessionMedia(sessionIds);
    return ok(publicClientSession(updated));
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    return fail(toErrorMessage(error), 500);
  }
}

export const OPTIONS = options;
