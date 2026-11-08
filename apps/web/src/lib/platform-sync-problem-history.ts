import type { Prisma } from '@prisma/client';
import { digest } from './exam-federation-protocol';

export const retiredBankKey = (domain: string, id: string) => `retired-bank:${digest({ domain, id })}`;

/** Free a reused numeric Hydro ID without redirecting historical submissions to the new problem. */
export async function retireProblemIdentity(tx: Prisma.TransactionClient, domain: string, id: string, bankId: string) {
  const retiredId = `deleted-${digest(bankId)}`;
  const rows = await tx.examProblem.findMany({ where: { hydroDomain: domain, hydroProblemId: id }, select: { id: true, examId: true } });
  for (const row of rows) {
    await tx.examProblem.update({ where: { id: row.id }, data: { sourceDeleted: true, hydroProblemId: retiredId } });
    await tx.examQuestion.updateMany({ where: { examId: row.examId, problemPid: id }, data: { problemPid: retiredId } });
  }
  const key = retiredBankKey(domain, retiredId);
  await tx.systemSetting.upsert({ where: { key }, create: { key, value: { bankId } }, update: { value: { bankId } } });
}
