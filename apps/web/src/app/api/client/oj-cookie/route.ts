import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requestOjLogin } from '@/lib/oj';
import { verifyClientTokenForSession } from '@/lib/client-auth';
import { options, fail, ok, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';
import { createAlertOnce } from '@/lib/alert-dedup';
import { withSessionWrite, SessionWriteQueueError } from '@/lib/session-write';
import { isPublicTestExam } from '@/lib/public-test';
import { loginNovaJudge } from '@/lib/novajudge';
import { effectiveEnd } from '@/lib/contest-rules';

const TicketRequestSchema = z.object({
  sessionId: z.string().min(1)
});

export async function POST(request: Request) {
  try {
    const input = await parseBody(request, TicketRequestSchema);
    const session = await prisma.clientSession.findUnique({
      where: { id: input.sessionId },
      include: { exam: true, candidate: true }
    });
    if (!session) return fail('客户端会话不存在', 404);
    if (!verifyClientTokenForSession(request, session, 'DESKTOP')) return fail('客户端会话令牌无效或已过期', 401);
    if (await isPublicTestExam(session.examId)) return fail('系统测试使用内置体验页面', 403);
    if (!['APPROVED', 'IN_EXAM'].includes(session.status)) return fail('当前会话尚未通过审核或已被锁定', 403);
    if (session.lockdown || new Date() >= effectiveEnd(session.exam, session.candidate.startedAt || session.startedAt)) return fail('考试已结束或当前会话已锁定', 403);

    if (session.exam.platform === 'NOVAJUDGE') {
      if (session.status !== 'IN_EXAM' || !session.startedAt) return fail('请先确认开始考试，再登录 NovaJudge', 403);
      try {
        const login = await loginNovaJudge(session.exam, session.candidate);
        // Remote login is slow: recheck authority before releasing a cookie.
        const current = await prisma.clientSession.findUnique({ where: { id: session.id }, include: { candidate: true, exam: true } });
        if (!current || current.status !== 'IN_EXAM' || current.lockdown || !verifyClientTokenForSession(request, current, 'DESKTOP')
          || new Date() >= effectiveEnd(current.exam, current.candidate.startedAt || current.startedAt)
          || current.exam.platformBaseUrl !== session.exam.platformBaseUrl || current.exam.platformContestId !== session.exam.platformContestId) {
          return fail('会话状态已变化，无法登录 NovaJudge', 403);
        }
        return ok(login, { headers: { 'Cache-Control': 'no-store' } });
      } catch (error) {
        if (error instanceof SessionWriteQueueError) return fail(error.message, error.status);
        await withSessionWrite(session.id, tx => createAlertOnce(tx, { examId: session.examId, candidateId: session.candidateId,
          sessionId: session.id, type: 'OJ_LOGIN_FAILED', severity: 4, message: toErrorMessage(error) }));
        return fail(toErrorMessage(error), 502);
      }
    }

    const existing = await prisma.oJLoginTicket.findFirst({
      where: {
        sessionId: session.id,
        status: 'ISSUED',
        expiresAt: { gt: new Date() }
      },
      orderBy: { createdAt: 'desc' }
    });
    if (existing?.loginUrl) return ok({ loginUrl: existing.loginUrl, expiresAt: existing.expiresAt });

    try {
      const loginUrl = await requestOjLogin(session.exam, session.candidate);
      const ticket = await prisma.oJLoginTicket.create({
        data: {
          examId: session.examId,
          candidateId: session.candidateId,
          sessionId: session.id,
          status: 'ISSUED',
          loginUrl,
          expiresAt: new Date(Date.now() + 2 * 60 * 1000)
        }
      });
      return ok({ loginUrl: ticket.loginUrl, expiresAt: ticket.expiresAt });
    } catch (error) {
      if (error instanceof SessionWriteQueueError) return fail(error.message, error.status);
      await withSessionWrite(session.id, async (tx) => {
        await tx.oJLoginTicket.create({
          data: {
            examId: session.examId,
            candidateId: session.candidateId,
            sessionId: session.id,
            status: 'FAILED',
            error: toErrorMessage(error)
          }
        });
        await createAlertOnce(tx, {
            examId: session.examId,
            candidateId: session.candidateId,
            sessionId: session.id,
            type: 'OJ_LOGIN_FAILED',
            severity: 4,
            message: toErrorMessage(error)
        });
      });
      return fail(toErrorMessage(error), 502);
    }
  } catch (error) {
    if (error instanceof SessionWriteQueueError) return fail(error.message, error.status);
    if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
    return fail(toErrorMessage(error), 500);
  }
}

export const OPTIONS = options;
