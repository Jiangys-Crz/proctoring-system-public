import { AlertCreateSchema } from '@cwnupaa/proctor-shared';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { isPublicTestExam } from '@/lib/public-test';
import { verifyClientTokenForAnySide, verifyClientTokenForSession } from '@/lib/client-auth';
import { options, fail, ok, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';
import { createAlertOnce } from '@/lib/alert-dedup';
import { MonitorAlertState, monitoredCondition } from '@/lib/monitor-alert-state';
import { withSessionWrite, SessionWriteQueueError } from '@/lib/session-write';

const InputSchema = AlertCreateSchema.extend({
  eventId: z.string().min(1).max(160).regex(/^[a-zA-Z0-9_-]+$/).optional(),
  occurredAt: z.iso.datetime({ offset: true }).optional()
});

export async function POST(request: Request) {
  try {
    const input = await parseBody(request, InputSchema);
    if (!input.sessionId) return fail('缺少有效 sessionId', 400);
    const session = await prisma.clientSession.findUnique({ where: { id: input.sessionId }, include: { exam: { select: { endAt: true } } } });
    if (!session) return fail('客户端会话不存在', 404);
    if (!verifyClientTokenForAnySide(request, session)) return fail('客户端会话令牌无效或已过期', 401);
    const mobileSide = verifyClientTokenForSession(request, session, 'MINIPROGRAM');
    if (mobileSide && !['SCREEN_SWITCH', 'MOBILE_CAMERA_LOST'].includes(input.type)) return fail('第二机位不能上报电脑端异常', 403);
    // Older desktops also report a local string comparison. It has no current
    // fingerprint or accepted baseline, so it cannot distinguish a real change
    // from a format upgrade, a delayed retry, or an already approved USB state.
    // Heartbeats authenticate and decide under the session lock, including the
    // alert/evidence event; acknowledging this obsolete report stops retries.
    if (input.type === 'PERIPHERAL_CHANGED') return ok({ discarded: true, detectedBy: 'heartbeat' });
    if (await isPublicTestExam(session.examId)) return ok({ discarded: true });
    const now = new Date();
    const occurredAt = input.occurredAt ? new Date(input.occurredAt) : now;
    if (occurredAt.getTime() > now.getTime() + 5_000 || occurredAt < session.createdAt) return fail('异常发生时间不在有效会话时间内', 400);
    const endedAt = session.endedAt && session.endedAt < session.exam.endAt ? session.endedAt : session.exam.endAt;
    if (now >= endedAt && (!input.occurredAt || occurredAt > endedAt || now.getTime() - endedAt.getTime() > 30 * 60_000)) return fail('考试会话已结束，不能继续上报告警', 409);
    if (input.evidencePath && !await prisma.mediaSegment.findFirst({ where: { sessionId: session.id, deletedAt: null, objectPath: input.evidencePath }, select: { id: true } })) return fail('录像证据不属于当前会话', 403);

    const preferredChannel =
      mobileSide || input.type === 'MOBILE_CAMERA_LOST'
        ? 'MOBILE_CAMERA'
        : input.type === 'CAMERA_CAPTURE_LOST'
          ? 'DESKTOP_CAMERA'
          : 'DESKTOP_SCREEN';

    const result = await withSessionWrite(session.id, async (tx) => {
      const current = await tx.clientSession.findUniqueOrThrow({ where: { id: session.id } });
      if (!verifyClientTokenForAnySide(request, current)) throw new Error('客户端会话令牌已改变，请重新连接');
      const monitorState = new MonitorAlertState(current.monitoringAlertState);
      const condition = monitoredCondition(input.type, input.message);
      const id = `${mobileSide ? 'mobile' : 'desktop'}_alert_${createHash('sha256').update(`${session.id}:${input.type}:${input.eventId || randomUUID()}`).digest('hex')}`;
      const data = {
        id, examId: session.examId, candidateId: session.candidateId, sessionId: session.id,
        type: input.type,
        // Old desktop direct reports defaulted to 3 while the same heartbeat
        // condition used 4. Normalize that baseline, retaining real escalation.
        severity: condition ? Math.max(input.severity, input.type === 'VIRTUAL_MACHINE' ? 3 : 4) : input.severity,
        message: input.message, evidencePath: input.evidencePath, createdAt: occurredAt
      };
      const evidence = async () => (await tx.mediaSegment.findFirst({
        where: { sessionId: session.id, deletedAt: null, channel: preferredChannel,
          startedAt: { gte: new Date(occurredAt.getTime() - 30_000), lte: occurredAt } },
        orderBy: { startedAt: 'desc' }, select: { objectPath: true }
      }))?.objectPath;
      const result = condition
        ? await monitorState.report(tx, data, { now, ...(input.eventId ? { eventId: id } : {}),
            ...(input.occurredAt ? { occurredAt } : {}), evidence, returnDuplicate: true })
        : await createAlertOnce(tx, data, occurredAt, { evidence });
      if (monitorState.changed) await tx.clientSession.update({ where: { id: session.id }, data: { monitoringAlertState: monitorState.toJson() } });
      if (!result.created || current.status === 'FINISHED') return result;
      await tx.candidate.update({
        where: { id: session.candidateId },
        data: { status: 'ONLINE_ABNORMAL', abnormal: true }
      });
      return result;
    });
    return ok(result.alert, { status: result.created ? 201 : 200 });
  } catch (error) {
    if (error instanceof SessionWriteQueueError) return fail(error.message, error.status);
    if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
    return fail(toErrorMessage(error), 500);
  }
}

export const OPTIONS = options;
