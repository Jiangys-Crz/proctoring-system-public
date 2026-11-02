import type { Prisma } from '@prisma/client';
import { ExamSettingsError } from './exam-settings';

export function examCodeDate(startAt: Date) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(startAt);
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value).join('');
}
export async function nextExamCode(tx: Prisma.TransactionClient, startAt: Date) {
  const date = examCodeDate(startAt);
  // MySQL locks this daily counter until the surrounding exam transaction commits.
  // The counter is never decremented on deletion, so an old code cannot be reused.
  for (;;) {
    await tx.$executeRaw`INSERT INTO ExamCodeSequence (date, value) VALUES (${date}, 1) ON DUPLICATE KEY UPDATE value = value + 1`;
    const sequence = await tx.examCodeSequence.findUniqueOrThrow({ where: { date } });
    if (sequence.value > 99) throw new ExamSettingsError('该日期的两位考试序号已用完（01–99），请选择其他考试日期');
    const code = `${date}${String(sequence.value).padStart(2, '0')}`;
    if (!await tx.exam.findUnique({ where: { examCode: code }, select: { id: true } })) return code;
  }
}
