export function canReadContestAttachments(session: {
  startedAt: Date | null;
  candidate: { startedAt: Date | null };
  exam: { startAt: Date };
}, now = new Date()) {
  const startedAt = session.candidate.startedAt || session.startedAt;
  return Boolean(startedAt && startedAt <= now && session.exam.startAt <= now);
}
