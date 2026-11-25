import type { Exam, Prisma } from '@prisma/client';
import { AuthError } from './auth';
import { assertContestLiveSupported } from './contest-live-access';
import { isContestLiveSupported } from './contest-live-contract';
import { prisma } from './db';
import { removeContestLiveConnections, canUseContestLiveMedia } from './contest-live-media';
import { readContestLiveConfig, readContestLiveSettings, type ContestLiveSettings } from './contest-live-settings';

type Config = { settings: ContestLiveSettings; obsKeyHash: string | null };
type ContestLiveExamTiming = { platform: string; contestRule: string; startAt: Date; endAt: Date };
const liveConfigFields = { settings: true, obsKeyHash: true } as const;

// Called under the same exam lock as a timetable change and WHEP registration.
export async function revokeInvalidContestLiveSchedule(tx: Pick<Prisma.TransactionClient, 'contestLiveSettings' | 'contestLiveConnection'>,
  exam: Pick<Exam, 'id' | 'platform' | 'contestRule' | 'startAt' | 'endAt'>) {
  const current = await tx.contestLiveSettings.findUnique({ where: { examId: exam.id }, select: liveConfigFields });
  if (!current) return [];
  const config = readContestLiveConfig(current, exam);
  if (isContestLiveSupported(exam.platform, exam.contestRule) && config.settings.freeze.at) return [];
  const stored = readContestLiveSettings(current.settings);
  if (stored.freeze.at || stored.publicEnabled || stored.publicMediaEnabled || current.obsKeyHash) {
    await tx.contestLiveSettings.update({
      where: { examId: exam.id },
      data: { settings: { ...config.settings, freeze: { at: null, revealed: false }, publicEnabled: false, publicMediaEnabled: false }, obsKeyHash: null },
    });
  }
  return tx.contestLiveConnection.findMany({
    where: { examId: exam.id }, select: { id: true, sessionId: true, channel: true },
  });
}

export async function updateContestLiveConfig(examId: string, update: (previous: Config, exam: ContestLiveExamTiming) => Config) {
  const result = await prisma.$transaction(async tx => {
    const [exam] = await tx.$queryRaw<ContestLiveExamTiming[]>`SELECT platform, contestRule, startAt, endAt FROM Exam WHERE id = ${examId} FOR UPDATE`;
    if (!exam) throw new AuthError('考试不存在', 404);
    assertContestLiveSupported(exam);
    const current = await tx.contestLiveSettings.findUnique({ where: { examId }, select: liveConfigFields });
    const config = readContestLiveConfig(update(readContestLiveConfig(current, exam), exam), exam);
    await tx.contestLiveSettings.upsert({ where: { examId }, create: { examId, ...config }, update: config, select: { examId: true } });
    const connections = await tx.contestLiveConnection.findMany({ where: { examId } });
    const stale = connections.filter(connection => !canUseContestLiveMedia(config, connection.access, connection.teamId, connection.channel));
    return { config, stale };
  });
  await removeContestLiveConnections(result.stale);
  return result.config;
}
