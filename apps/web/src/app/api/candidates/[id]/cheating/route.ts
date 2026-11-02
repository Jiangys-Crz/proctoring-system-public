import crypto from 'node:crypto';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { isPublicTestExam } from '@/lib/public-test';
import { AuthError, requireUser } from '@/lib/auth';
import { canAccessCandidate } from '@/lib/permissions';
import { options, fail, ok, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';
import { MarkSchema } from '@/lib/monitor-action-schemas';
import { refreshCandidateAlertStatus, withAlertStatusWrite } from '@/lib/alert-acknowledgement';

const CancelSchema = z.object({
  reason: z.string().trim().min(1).max(500)
});

function userName(user: { realName: string | null; username: string | null; numberId: string | null; id: string }) {
  return user.realName || user.username || user.numberId || user.id;
}

function candidateName(candidate: { name: string | null; teamName: string | null; examNumber: string }) {
  return candidate.name || candidate.teamName || candidate.examNumber;
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    const input = await parseBody(request, MarkSchema);
    if (!(await canAccessCandidate(user, id))) return fail('无权标记该考生', 403);
    const candidate = await prisma.candidate.findUnique({ where: { id }, include: { exam: true } });
    if (!candidate) return fail('考生不存在', 404);
    if (await isPublicTestExam(candidate.examId)) return fail('环境测试不保存监考记录', 403);
    const targets =
      input.teamWide && candidate.teamName
        ? await prisma.candidate.findMany({ where: { examId: candidate.examId, teamName: candidate.teamName } })
        : [candidate];
    for (const target of targets) {
      if (!(await canAccessCandidate(user, target.id))) return fail('无权对其他考室的队员执行全队作弊标记', 403);
    }
    const now = new Date();
    const marker = userName(user);

    const records = await withAlertStatusWrite(async (tx) => {
      // Match acknowledgement/heartbeat lock order, including multi-candidate
      // team actions, before any FK insert or candidate update takes its lock.
      for (const target of [...targets].sort((a, b) => a.id.localeCompare(b.id))) {
        await tx.$queryRaw`SELECT id FROM ClientSession WHERE candidateId = ${target.id} ORDER BY id FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM Candidate WHERE id = ${target.id} FOR UPDATE`;
      }
      const created = [];
      for (const target of targets) {
        const preferredSession = input.sessionId && target.id === candidate.id
          ? await tx.clientSession.findFirst({ where: { id: input.sessionId, examId: target.examId, candidateId: target.id, status: { not: 'FINISHED' } } })
          : null;
        const session = preferredSession || await tx.clientSession.findFirst({
              where: { examId: target.examId, candidateId: target.id, status: { not: 'FINISHED' } },
              orderBy: { updatedAt: 'desc' }
            });
        const text = target.teamName
          ? `${target.teamName}团队${candidateName(target)}同学因${input.reason}被${marker}标记为作弊`
          : `${candidateName(target)}同学因${input.reason}被${marker}标记为作弊`;
        created.push(
          await tx.cheatingRecord.create({
            data: {
              examId: target.examId,
              candidateId: target.id,
              sessionId: session?.id,
              markedById: user.id,
              reason: input.reason,
              teamWide: Boolean(input.teamWide && candidate.teamName),
              teamName: target.teamName
            }
          })
        );
        await tx.candidate.update({
          where: { id: target.id },
          data: { status: 'ONLINE_ABNORMAL', abnormal: true }
        });
        if (session) {
          await tx.clientSession.update({
            where: { id: session.id },
            data: { status: 'LOCKED', lockdown: true, lockdownReason: text }
          });
        }
        await tx.alert.create({
          data: {
            examId: target.examId,
            candidateId: target.id,
            sessionId: session?.id,
            type: 'MANUAL_NOTE',
            severity: 5,
            message: text,
            acknowledgedAt: now
          }
        });
      }
      return created;
    });

    return ok({ marked: records.length, records });
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
    return fail(toErrorMessage(error), 500);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    const input = await parseBody(request, CancelSchema);
    if (!(await canAccessCandidate(user, id))) return fail('无权取消该考生作弊标记', 403);
    const record = await prisma.cheatingRecord.findFirst({
      where: { candidateId: id, canceledAt: null },
      include: { candidate: true },
      orderBy: { createdAt: 'desc' }
    });
    if (!record) return fail('该考生没有待取消的作弊标记', 404);
    const cancelText = `${candidateName(record.candidate)}同学作弊标记已由${userName(user)}取消，原因：${input.reason}`;
    const firstStartedAt = record.candidate.startedAt;
    const updated = await withAlertStatusWrite(async (tx) => {
      // Serialize with automatic USB/heartbeat writers before accepting the
      // current hardware state, so cancellation cannot restore a stale baseline.
      await tx.$queryRaw`SELECT id FROM ClientSession WHERE candidateId = ${id} ORDER BY id FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM Candidate WHERE id = ${id} FOR UPDATE`;
      const lockedSessions = await tx.clientSession.findMany({
        where: { candidateId: id, status: 'LOCKED', lockdown: true }
      });
      const item = await tx.cheatingRecord.update({
        where: { id: record.id },
        data: { canceledAt: new Date(), canceledReason: input.reason, canceledById: user.id }
      });
      for (const session of lockedSessions) {
        await tx.clientSession.update({
          where: { id: session.id },
          data: {
            status: firstStartedAt ? 'IN_EXAM' : 'APPROVED',
            startedAt: firstStartedAt,
            lockdown: false,
            lockdownReason: cancelText,
            endedAt: null,
            unlockNonce: crypto.randomUUID(),
            peripheralsBaselineFingerprint: session.lastPeripheralsFingerprint || session.peripheralsBaselineFingerprint
          }
        });
      }
      await tx.alert.create({
        data: {
          examId: record.examId,
          candidateId: id,
          sessionId: record.sessionId,
          type: 'MANUAL_NOTE',
          severity: 2,
          message: cancelText,
          acknowledgedAt: new Date()
        }
      });
      await refreshCandidateAlertStatus(tx, id, new Date(), true);
      return item;
    });
    return ok(updated);
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
    return fail(toErrorMessage(error), 500);
  }
}

export const OPTIONS = options;
