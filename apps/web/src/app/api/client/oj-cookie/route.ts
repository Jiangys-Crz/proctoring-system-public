import { acquireOjLoginSlot } from '@/lib/login-approval';
import { isRequestAdmissionError } from '@/lib/request-admission';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requestOjLogin } from '@/lib/oj';
import { verifyClientTokenForSession } from '@/lib/client-auth';
import { options, fail, ok, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';
import { createAlertOnce } from '@/lib/alert-dedup';
import { withSessionWrite, SessionWriteQueueError } from '@/lib/session-write';
import { isPublicTestExam } from '@/lib/public-test';
import { loginNovaJudge, NovaJudgeConnectionError } from '@/lib/novajudge';
import { effectiveEnd } from '@/lib/contest-rules';

const TicketRequestSchema = z.object({
  sessionId: z.string().min(1)
});

export async function POST(request: Request) {
  let release: (() => void) | undefined;
  try {
    const input = await parseBody(request, TicketRequestSchema, 16 * 1024);
    const selectedSession = await prisma.clientSession.findUnique({
      where: { id: input.sessionId },
      include: { exam: true, candidate: true }
    });
    if (!selectedSession) return fail('客户端会话不存在', 404);
    if (!verifyClientTokenForSession(request, selectedSession, 'DESKTOP')) return fail('客户端会话令牌无效或已过期', 401);
    if (await isPublicTestExam(selectedSession.examId)) return fail('系统测试使用内置体验页面', 403);
    if (!selectedSession.approvedAt || !['APPROVED', 'IN_EXAM'].includes(selectedSession.status)) return fail('当前会话尚未通过审核或已被锁定', 403);
    if (selectedSession.lockdown || new Date() >= effectiveEnd(selectedSession.exam, selectedSession.candidate.startedAt || selectedSession.startedAt)) return fail('考试已结束或当前会话已锁定', 403);

    release = await acquireOjLoginSlot(request.signal);
    if (request.signal.aborted) return fail('请求已取消，请重试', 408);
    // The queue may outlive a lock, device recovery or the exam deadline.
    const live = await prisma.clientSession.findUnique({ where: { id: selectedSession.id }, include: { exam: true, candidate: true } });
    if (!live || !live.approvedAt || !['APPROVED', 'IN_EXAM'].includes(live.status) || live.lockdown
      || !verifyClientTokenForSession(request, live, 'DESKTOP') || live.candidate.status === 'FINISHED'
      || new Date() >= effectiveEnd(live.exam, live.candidate.startedAt || live.startedAt)) return fail('会话状态已变化，请重新连接', 403);
    const session = live;
    const boundSession = session;
    const recordFailure = async (error: unknown, ticket: boolean) => {
      if (request.signal.aborted) return;
      await withSessionWrite(boundSession.id, async tx => {
        const current = await tx.clientSession.findUnique({ where: { id: boundSession.id }, include: { candidate: true, exam: true } });
        if (!current || !current.approvedAt || !['APPROVED', 'IN_EXAM'].includes(current.status) || current.lockdown
          || !verifyClientTokenForSession(request, current, 'DESKTOP') || current.candidate.status === 'FINISHED'
          || new Date() >= effectiveEnd(current.exam, current.candidate.startedAt || current.startedAt)) return;
        if (ticket) await tx.oJLoginTicket.create({ data: { examId: current.examId, candidateId: current.candidateId,
          sessionId: current.id, status: 'FAILED', error: toErrorMessage(error) } });
        await createAlertOnce(tx, { examId: current.examId, candidateId: current.candidateId,
          sessionId: current.id, type: 'OJ_LOGIN_FAILED', severity: 4, message: toErrorMessage(error) });
      }, { signal: request.signal });
    };
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
        await recordFailure(error, false).catch(auditError => console.error('Failed to record NovaJudge login failure', auditError));
        return Response.json({ ok: false, code: error instanceof NovaJudgeConnectionError ? 'OJ_LOGIN_TEMPORARY' : 'OJ_LOGIN_REJECTED', message: toErrorMessage(error) }, {
          status: 502, headers: { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }
        });
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
    const stillAuthorized = async () => {
      const current = await prisma.clientSession.findUnique({ where: { id: session.id }, include: { candidate: true, exam: true } });
      return Boolean(current && current.approvedAt && ['APPROVED', 'IN_EXAM'].includes(current.status) && !current.lockdown
        && verifyClientTokenForSession(request, current, 'DESKTOP')
        && new Date() < effectiveEnd(current.exam, current.candidate.startedAt || current.startedAt)
        && current.exam.platformBaseUrl === session.exam.platformBaseUrl && current.exam.platformContestId === session.exam.platformContestId);
    };
    if (existing?.loginUrl) {
      if (!await stillAuthorized()) return fail('会话状态已变化，请重新连接', 403);
      return ok({ loginUrl: existing.loginUrl, expiresAt: existing.expiresAt });
    }

    try {
      const loginUrl = await requestOjLogin(session.exam, session.candidate);
      if (!await stillAuthorized()) return fail('会话状态已变化，请重新连接', 403);
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
      await recordFailure(error, true).catch(auditError => console.error('Failed to record OJ login failure', auditError));
      return fail(toErrorMessage(error), 502);
    }
  } catch (error) {
    if (error instanceof SessionWriteQueueError || isRequestAdmissionError(error)) return fail(error.message, error.status);
    if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
    return fail(toErrorMessage(error), 500);
  } finally { release?.(); }
}

export const OPTIONS = options;
