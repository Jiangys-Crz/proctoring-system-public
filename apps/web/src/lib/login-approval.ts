import type { Candidate, Exam } from '@prisma/client';
import { prisma } from './db';
import { requestOjLogin } from './oj';
import { toErrorMessage } from './http';
import { createAlertOnce } from './alert-dedup';
import { withSessionWrite } from './session-write';
import { isPublicTestExam } from './public-test';
import { createRequestAdmission } from './request-admission';

const state = globalThis as typeof globalThis & { ojLoginAdmission?: ReturnType<typeof createRequestAdmission> };
export const acquireOjLoginSlot = state.ojLoginAdmission ??= createRequestAdmission(4, 128, 30_000);

export async function issueApprovedSessionOjTicket({ exam, candidate, sessionId }: {
  exam: Exam; candidate: Candidate; sessionId: string;
}) {
  if (exam.platform === 'NOVAJUDGE' || await isPublicTestExam(exam.id)) return;
  let release: (() => void) | undefined;
  try {
    release = await acquireOjLoginSlot();
    const live = await prisma.clientSession.findUnique({ where: { id: sessionId }, select: { status: true, revokedAt: true, approvedAt: true } });
    if (!live || live.revokedAt || !live.approvedAt || live.status === 'FINISHED') return;
    const loginUrl = await requestOjLogin(exam, candidate);
    await withSessionWrite(sessionId, async tx => {
      const current = await tx.clientSession.findUnique({ where: { id: sessionId } });
      if (!current || current.revokedAt || !current.approvedAt || current.status === 'FINISHED') return;
      await tx.oJLoginTicket.create({ data: {
        examId: exam.id, candidateId: candidate.id, sessionId, status: 'ISSUED', loginUrl,
        expiresAt: new Date(Date.now() + 2 * 60 * 1000)
      } });
    });
  } catch (error) {
    const message = toErrorMessage(error);
    await withSessionWrite(sessionId, async tx => {
      const current = await tx.clientSession.findUnique({ where: { id: sessionId } });
      // Late results from an old login cannot create incidents on the new login.
      if (!current || current.revokedAt || !current.approvedAt || current.status === 'FINISHED') return;
      await tx.oJLoginTicket.create({ data: { examId: exam.id, candidateId: candidate.id, sessionId, status: 'FAILED', error: message } });
      await createAlertOnce(tx, { examId: exam.id, candidateId: candidate.id, sessionId, type: 'OJ_LOGIN_FAILED', severity: 4, message });
    });
  } finally { release?.(); }
}
