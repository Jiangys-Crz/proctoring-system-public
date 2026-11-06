import { effectiveEnd } from '@/lib/contest-rules';
import { withSessionWrite, SessionWriteQueueError } from '@/lib/session-write';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { AuthError, requireUser } from '@/lib/auth';
import { canAccessCandidate } from '@/lib/permissions';
import { issueApprovedSessionOjTicket } from '@/lib/login-approval';
import { assertReviewMaterials } from '@/lib/upload-security';
import { LoginFlowError } from '@/lib/room-login-policy';
import { getStorageSettings } from '@/lib/settings';
import type { Prisma } from '@prisma/client';
import { publicClientSession } from '@/lib/client-auth';
import { options, fail, ok, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';

const ReviewSchema = z.object({
  approved: z.boolean(),
  reason: z.string().optional()
});

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    const input = await parseBody(request, ReviewSchema);
    const loginRequest = await prisma.loginRequest.findUnique({
      where: { id },
      include: {
        candidate: true,
        exam: true,
        clientSessions: { orderBy: { createdAt: 'desc' }, take: 1 },
        pairingSessions: { orderBy: { createdAt: 'desc' }, take: 1 }
      }
    });
    if (!loginRequest) return fail('登录请求不存在', 404);
    if (!(await canAccessCandidate(user, loginRequest.candidateId))) return fail('无权审核该考生', 403);

    const boundSession = loginRequest.clientSessions[0];
    if (!boundSession) return fail('登录请求没有有效客户端会话，请重新登录', 409);
    const requirePending = async (tx: Prisma.TransactionClient) => {
      await tx.$queryRaw`SELECT id FROM ClientSession WHERE id = ${boundSession.id} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM Candidate WHERE id = ${loginRequest.candidateId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM LoginRequest WHERE id = ${id} FOR UPDATE`;
      const [current, session] = await Promise.all([
        tx.loginRequest.findUnique({ where: { id } }), tx.clientSession.findUnique({ where: { id: boundSession.id }, include: { candidate: true, exam: true } })
      ]);
      if (!current || current.status !== 'REQUESTING' || !session || session.revokedAt || (session.status !== 'WAITING_REVIEW' && !(session.status === 'LOCKED' && session.lockdown && !session.approvedAt)) || session.candidate.status === 'FINISHED' || effectiveEnd(session.exam, session.candidate.startedAt || session.startedAt) <= new Date()) throw new LoginFlowError('登录请求已处理或客户端会话已注销，请重新登录', 409);
      return session;
    };

    if (!input.approved) {
      const rejected = await withSessionWrite(boundSession.id, async (tx) => {
        await requirePending(tx);
        const updated = await tx.loginRequest.update({
          where: { id },
          data: {
            status: 'REJECTED',
            rejectReason: input.reason || '监考老师未通过登录审核',
            reviewedById: user.id,
            reviewedAt: new Date()
          }
        });
        await tx.candidate.update({
          where: { id: loginRequest.candidateId },
          data: { status: 'REJECTED' }
        });
        await tx.clientSession.updateMany({
          where: { loginRequestId: id },
          data: { status: 'FINISHED', endedAt: new Date(), revokedAt: new Date(), desktopTokenHash: null, miniProgramTokenHash: null, lockdown: false, lockdownReason: null }
        });
        return updated;
      });
      return ok(rejected);
    }

    const pairing = loginRequest.pairingSessions[0];
    if (!pairing) return fail('该登录请求没有绑定电脑客户端，请重新扫码提交', 400);

    const storage = await getStorageSettings();
    const verifiedFiles = await assertReviewMaterials(prisma, id, loginRequest.candidateId, loginRequest.examId, storage);
    const approved = await withSessionWrite(boundSession.id, async (tx) => {
      const pendingSession = await requirePending(tx);
      await assertReviewMaterials(tx, id, loginRequest.candidateId, loginRequest.examId, storage, verifiedFiles);
      const firstStartedAt = pendingSession.candidate.startedAt || pendingSession.startedAt;
      const sessionStatus = pendingSession.lockdown ? 'LOCKED' : firstStartedAt ? 'IN_EXAM' : 'APPROVED';
      const updated = await tx.loginRequest.update({
        where: { id },
        data: {
          status: 'APPROVED',
          reviewedById: user.id,
          reviewedAt: new Date()
        }
      });
      // Heartbeats/recovery may already have updated device bindings and USB
      // fingerprints while waiting for review. Approval must preserve them.
      const session = await tx.clientSession.update({ where: { id: boundSession.id }, data: {
        status: sessionStatus, approvedAt: new Date(), startedAt: firstStartedAt, endedAt: null
      } });
      await tx.candidate.update({
        where: { id: loginRequest.candidateId },
        data: { status: pendingSession.lockdown || pendingSession.candidate.abnormal ? 'ONLINE_ABNORMAL' : firstStartedAt ? 'ONLINE_NORMAL' : 'APPROVED' }
      });
      return { updated, session, exam: pendingSession.exam, candidate: pendingSession.candidate };
    });

    void issueApprovedSessionOjTicket({
      exam: approved.exam,
      candidate: approved.candidate,
      sessionId: approved.session.id
    }).catch(error => console.error('Failed to issue OJ ticket after review', error));

    return ok({ updated: approved.updated, session: publicClientSession(approved.session) });
  } catch (error) {
    if (error instanceof SessionWriteQueueError) return fail(error.message, error.status);
    if (error instanceof LoginFlowError) return fail(error.message, error.status);
    if (error instanceof AuthError) return fail(error.message, error.status);
    if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
    return fail(toErrorMessage(error), 500);
  }
}

export const OPTIONS = options;
