import type { ContestLiveData, ContestLiveSubmission } from '@/lib/contest-live-contract';

// ICPC Live's QueueSettings defaults. The data feed sends a history snapshot,
// so reconstruct queue admission and expiry from the observed run changes.
const TTL_MS = { judged: 60_000, firstToSolve: 120_000, pending: 300_000 };
const QUEUE_SIZE = 20;
const UNTESTED_LIMIT = 15;

export function createOverlayQueue() {
  const runs = new Map<string, { signature: string; updatedAt: number }>();
  let firstObservedAt: number | undefined;

  return {
    reset() {
      runs.clear();
      firstObservedAt = undefined;
    },
    select(contest: ContestLiveData, featuredId: string | null, now: number) {
      const exam = contest.exam;
      const currentTime = Math.min(now, Date.parse(exam.endAt));
      const freezeTime = exam.freezeAt ? Date.parse(exam.freezeAt) : null;
      const submissions = contest.submissions;
      if (submissions.length) firstObservedAt ??= currentTime;
      const currentIds = new Set(submissions.map(run => run.id));
      for (const id of runs.keys()) if (!currentIds.has(id)) runs.delete(id);

      const untestedBeforeFreeze = (run: ContestLiveSubmission) => !run.verdict && !run.frozen
        && freezeTime !== null && Date.parse(run.submittedAt) < freezeTime;
      const selected: ContestLiveSubmission[] = [];
      let untested = 0;
      // Reserve queue slots using contest event order, then emit newest first.
      for (const run of [...submissions].reverse()) {
        const submittedAt = Date.parse(run.submittedAt);
        const signature = JSON.stringify([run.verdict, run.score, run.firstBlood, run.frozen, run.testedPart]);
        const previous = runs.get(run.id);
        if (signature !== previous?.signature) {
          const settled = firstObservedAt !== undefined && currentTime > firstObservedAt + 60_000;
          runs.set(run.id, { signature, updatedAt: previous || settled ? currentTime : submittedAt });
        }
        if (featuredId === run.id) {
          selected.push(run);
          continue;
        }
        const expiry = run.firstBlood ? TTL_MS.firstToSolve : run.verdict ? TTL_MS.judged : TTL_MS.pending;
        if (currentTime >= (runs.get(run.id)?.updatedAt ?? submittedAt) + expiry) continue;
        if (untestedBeforeFreeze(run)) {
          if (untested >= UNTESTED_LIMIT) continue;
          untested++;
        }
        selected.push(run);
      }

      while (selected.length >= QUEUE_SIZE) {
        const removable = selected.findIndex(run => run.id !== featuredId && !run.firstBlood && !untestedBeforeFreeze(run));
        if (removable < 0) break;
        selected.splice(removable, 1);
      }
      return selected.reverse();
    },
  };
}
