import type { Exam } from '@prisma/client';

/** Small, current exam metadata for the desktop shell's existing heartbeat. */
export function clientExamTiming(exam: Pick<Exam, 'id' | 'updatedAt' | 'startAt' | 'latestStartAt' | 'endAt' | 'durationMinutes' | 'contestRule' | 'flexible'>) {
  return {
    examId: exam.id, updatedAt: exam.updatedAt.toISOString(), startAt: exam.startAt.toISOString(),
    latestStartAt: exam.latestStartAt.toISOString(), endAt: exam.endAt.toISOString(),
    durationMinutes: exam.durationMinutes, contestRule: exam.contestRule, flexible: exam.flexible,
  };
}
