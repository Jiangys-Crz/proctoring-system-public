'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { ContestDisplayResponse } from '@/lib/contest-display-contract';
import type { ContestLiveSubmission } from '@/lib/contest-live-contract';
import styles from './FirstSolutionHistoryScene.module.css';

const title = 'First Solution in Contest';
const rowsPerScreen = 10;
const judgementLifetime = 8_000;
const yearFormat = new Intl.DateTimeFormat('en', { year: 'numeric', timeZone: 'Asia/Shanghai' });

type FirstSolutionStatus = 'first' | 'solved' | 'failed' | 'pending' | 'frozen';
type HistoryRow = {
  contestLabel: string;
  teamName: string;
  logoUrl: string | null;
  seconds?: number;
  status?: FirstSolutionStatus;
};

function useRecentJudgements(submissions: ContestLiveSubmission[], serverTime: number) {
  const previous = useRef<ContestLiveSubmission[] | null>(null);
  const [judgedAt, setJudgedAt] = useState<ReadonlyMap<string, number>>(() => new Map());
  useEffect(() => {
    const last = previous.current;
    if (last === submissions) return;
    previous.current = submissions;
    if (!last) return;
    const pendingIds = new Set(last.filter(run => !run.verdict && !run.frozen).map(run => run.id));
    setJudgedAt(previousTimes => {
      const next = new Map<string, number>();
      for (const run of submissions) {
        if (!run.verdict) continue;
        const time = pendingIds.has(run.id) ? serverTime : previousTimes.get(run.id);
        if (time !== undefined && time + judgementLifetime > serverTime) next.set(run.id, time);
      }
      return next.size || previousTimes.size ? next : previousTimes;
    });
  }, [serverTime, submissions]);
  return judgedAt;
}

function resultStatus(run: ContestLiveSubmission): FirstSolutionStatus {
  if (run.frozen) return 'frozen';
  if (!run.verdict) return 'pending';
  return run.firstBlood || /^(?:accepted|ac|ok|通过|正确|答案正确)$/i.test(run.verdict.trim()) ? 'solved' : 'failed';
}

function SolutionRow({ row, index, live }: { row: HistoryRow; index: number; live?: boolean }) {
  const minutes = row.seconds === undefined ? undefined : Math.floor(row.seconds / 60);
  return <div className={styles.row} role="row" data-live={live || undefined}
    style={{ '--solution-row': index } as CSSProperties}>
    <span className={styles.contestLabel} role="cell" title={row.contestLabel}>{row.contestLabel}</span>
    <div className={styles.school} aria-hidden>
      {row.logoUrl && <img src={row.logoUrl} alt="" />}
    </div>
    <div className={styles.team} role="cell">
      <span title={row.teamName}>{row.teamName}</span>
      {minutes !== undefined && <span className={styles.chip} data-status={row.status} aria-hidden>{minutes}</span>}
    </div>
    <span className={styles.duration} role="cell">{minutes}</span>
  </div>;
}

export function FirstSolutionHistoryScene({ data, now, clocks }: {
  data: ContestDisplayResponse;
  now: number;
  clocks?: { left: string; right: string };
}) {
  const { firstSolutionHistory: history, contest, settings, serverTime } = data;
  const { exam, submissions, teams } = contest;
  const judgedAt = useRecentJudgements(submissions, serverTime);
  const teamsById = new Map(teams.map(team => [team.id, team]));
  const past = (history?.past ?? []).slice(0, rowsPerScreen - 1);
  const current = history?.current;
  const winner = current ? teamsById.get(current.teamId) : undefined;
  const startedAt = Date.parse(exam.startAt);
  const currentLabel = Number.isFinite(startedAt) ? yearFormat.format(startedAt) : 'Current';
  const active = current && winner ? [] : submissions
    .filter(run => teamsById.has(run.teamId)
      && (!run.verdict || now - (judgedAt.get(run.id) ?? Date.parse(run.submittedAt)) < judgementLifetime))
    .sort((a, b) => a.seconds - b.seconds)
    .slice(0, rowsPerScreen - past.length - 1);
  const currentRow: HistoryRow = {
    contestLabel: currentLabel, teamName: winner?.name ?? '?', logoUrl: winner?.organizationLogoUrl ?? null,
    seconds: winner ? current?.seconds : undefined,
    status: winner ? 'first' : undefined,
  };

  return <section className={styles.scene} data-theme={settings.theme} aria-label={title}>
    <div className={styles.titleRow}>
      {settings.showClock !== false && clocks && <span className={styles.leftClock} data-frozen={exam.frozen || undefined}>{clocks.left}</span>}
      <span className={styles.title}>{title}</span>
      {settings.showClock !== false && clocks && <span className={styles.rightClock} data-frozen={exam.frozen || undefined}>{clocks.right}</span>}
    </div>
    <div className={styles.table} role="table" aria-label={title}>
      <div className={styles.columns} role="row">
        <span role="columnheader">Contest</span>
        <span role="columnheader">Name</span>
        <span role="columnheader">Time</span>
      </div>
      <div className={styles.lanes} role="rowgroup">
        {past.map((row, index) => <SolutionRow key={index} index={index} row={{ ...row, status: 'first' }} />)}
        <SolutionRow key={winner ? `current:${winner.id}` : 'current'} row={currentRow} index={past.length} live={!!winner} />
        <div className={styles.divider} aria-hidden style={{ '--solution-row': past.length + 1 } as CSSProperties} />
        {active.map((run, index) => {
          const team = teamsById.get(run.teamId)!;
          return <SolutionRow key={run.id} index={past.length + index + 1} live row={{
            contestLabel: '', teamName: team.name, logoUrl: team.organizationLogoUrl, seconds: run.seconds,
            status: resultStatus(run),
          }} />;
        })}
      </div>
    </div>
  </section>;
}
