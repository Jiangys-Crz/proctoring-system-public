type ExamTime = { id: string; startAt: Date | string; endAt: Date | string };
/** Active/upcoming exams nearest to their start first; recently ended exams last. */
export function compareExamStart(a: ExamTime, b: ExamTime, now = Date.now()) {
  const aEnded = +new Date(a.endAt) <= now, bEnded = +new Date(b.endAt) <= now;
  if (aEnded !== bEnded) return aEnded ? 1 : -1;
  const time = aEnded ? +new Date(b.endAt) - +new Date(a.endAt)
    : Math.abs(+new Date(a.startAt) - now) - Math.abs(+new Date(b.startAt) - now);
  return time || +new Date(a.startAt) - +new Date(b.startAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
