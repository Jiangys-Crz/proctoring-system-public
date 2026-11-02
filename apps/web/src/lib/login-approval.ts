import type { Candidate, Exam } from '@prisma/client';
import { prisma } from './db';
import { requestOjLogin } from './oj';
import { toErrorMessage } from './http';
import { createAlertOnce } from './alert-dedup';
import { withSessionWrite } from './session-write';
import { isPublicTestExam } from './public-test';

export async function issueApprovedSessionOjTicket({ exam, candidate, sessionId }: {
  exam: Exam;
  candidate: Candidate;
  sessionId: string;
}) {
  if (exam.platform === 'NOVAJUDGE' || await isPublicTestExam(exam.id)) return;
  try {
    const loginUrl = await requestOjLogin(exam, candidate);
    await prisma.oJLoginTicket.create({
      data: {
        examId: exam.id,
        candidateId: candidate.id,
        sessionId,
        status: 'ISSUED',
        loginUrl,
        expiresAt: new Date(Date.now() + 2 * 60 * 1000)
      }
    });
  } catch (error) {
    const message = toErrorMessage(error);
    await withSessionWrite(sessionId, async (tx) => {
      await tx.oJLoginTicket.create({
        data: {
          examId: exam.id,
          candidateId: candidate.id,
          sessionId,
          status: 'FAILED',
          error: message
        }
      });
      await createAlertOnce(tx, {
          examId: exam.id,
          candidateId: candidate.id,
          sessionId,
          type: 'OJ_LOGIN_FAILED',
          severity: 4,
          message
      });
    });
  }
}
