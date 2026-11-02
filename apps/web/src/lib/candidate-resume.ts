import type { User } from '@prisma/client';
import { prisma } from './db';
import { effectiveEnd } from './contest-rules';
import { isPublicTestExam } from './public-test';
import { LoginFlowError } from './room-login-policy';

export async function resumeCandidateExam(candidateId: string, actor: User, sessionId?: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(async tx => {
        // Match heartbeat/health writes: lock sessions before their candidate.
        await tx.$queryRaw`SELECT id FROM ClientSession WHERE candidateId = ${candidateId} ORDER BY id FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM Candidate WHERE id = ${candidateId} FOR UPDATE`;
        const candidate = await tx.candidate.findUnique({ where: { id: candidateId }, include: { exam: true } });
        if (!candidate) throw new LoginFlowError('考生不存在', 404);
        const now = new Date();
        if (now < candidate.exam.startAt || now >= candidate.exam.endAt) throw new LoginFlowError('当前不在考试时间内，不能继续考试', 400);
        const firstSession = candidate.startedAt ? null : await tx.clientSession.findFirst({
          where: { candidateId, startedAt: { not: null } }, orderBy: { startedAt: 'asc' }
        });
        const startedAt = candidate.startedAt || firstSession?.startedAt;
        if (startedAt && now >= effectiveEnd(candidate.exam, startedAt)) throw new LoginFlowError('该考生的考试时间已经结束', 400);
        const requiresRelogin = candidate.status === 'FINISHED' || !await tx.clientSession.count({
          where: { candidateId, status: { not: 'FINISHED' }, revokedAt: null }
        });
        if (candidate.status === 'FINISHED') {
          // Ended tokens remain ended. Resuming requires a fresh, reviewed login.
          await tx.clientSession.updateMany({
            where: { candidateId, status: { not: 'FINISHED' } },
            data: { status: 'FINISHED', endedAt: now, lockdown: false, lockdownReason: null }
          });
        }
        const updated = await tx.candidate.update({ where: { id: candidateId }, data: {
          ...(candidate.status === 'FINISHED' ? { status: 'OFFLINE' } : {}),
          ...(startedAt ? { startedAt } : { lateStartAllowedAt: candidate.lateStartAllowedAt || now })
        } });
        if (!await isPublicTestExam(candidate.examId, tx)) await tx.alert.create({ data: {
          examId: candidate.examId, candidateId, sessionId,
          type: 'MANUAL_NOTE', severity: 3,
          message: `监考老师 ${actor.realName || actor.username || actor.numberId || actor.id} 已允许该考生继续考试${startedAt ? '，保留原考试计时' : '，允许超过最晚开考时间后登录并确认开始'}${requiresRelogin ? '，请重新登录' : ''}`
        } });
        return { candidateId, lateStartAllowedAt: updated.lateStartAllowedAt, requiresRelogin };
      }, { isolationLevel: 'ReadCommitted', maxWait: 10_000, timeout: 15_000 });
    } catch (error) {
      if (attempt >= 2 || !error || typeof error !== 'object' || !('code' in error) || error.code !== 'P2034') throw error;
      await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}
