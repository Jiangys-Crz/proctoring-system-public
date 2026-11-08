'use client';

import { formatScore } from './score-format';

import { memo, useLayoutEffect, useRef, useState, type CSSProperties, type Ref } from 'react';
import { createPortal } from 'react-dom';
import type { StandingProblemStatus as ProblemStatus, StandingRowMetadata as BoardDisplayRowMeta } from './standing-types';
import { BoardParticipantOrganization, BoardParticipantTeam, BoardParticipantWatermark, BoardParticipantMetadata, type BoardParticipant } from './BoardParticipantIdentity';
import './ExternalBoardStandings.css';
import { BOARD_RESULT_STYLE } from './boardResultColors';
import { getBoardScoreLevel } from './boardScoreColors';

type StandingRow = BoardParticipant & BoardDisplayRowMeta & {
  solved?: number; penalty?: number; totalScore?: number; medal?: 'Gold' | 'Silver' | 'Bronze';
  problemStatus: Record<string, ProblemStatus>;
};
type StandingProblem = {
  id: string; label: string; name: string; submitted: number; attempted: number; accepted: number;
  firstSolved: number; lastSolved: number; score?: number;
  avgScore?: number; maxScore?: number; minScore?: number;
};

type FloatingHeader = { left: number; top: number; width: number; height: number; naturalWidth: number; scale: number };

/** Measure screen coordinates because the board can live inside scaled/clipped wrappers. */
function useFloatingHeader() {
  const sectionRef = useRef<HTMLElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const [floating, setFloating] = useState<FloatingHeader | null>(null);
  useLayoutEffect(() => {
    const section = sectionRef.current, header = headerRef.current;
    if (!section || !header) return;
    let active = true, frame = 0;
    const measure = () => {
      if (!active) return;
      const bounds = header.getBoundingClientRect(), end = section.getBoundingClientRect().bottom;
      if (bounds.top >= 0 || end <= 0 || !bounds.width || !header.offsetWidth) {
        setFloating(previous => previous === null ? previous : null);
        return;
      }
      const next = { left: bounds.left, top: Math.min(0, end - bounds.height), width: bounds.width, height: bounds.height, naturalWidth: header.offsetWidth, scale: bounds.width / header.offsetWidth };
      setFloating(previous => previous && (Object.keys(next) as (keyof FloatingHeader)[]).every(key => Math.abs(previous[key] - next[key]) < .1) ? previous : next);
    };
    const schedule = () => {
      if (!active) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(section); observer.observe(header);
    const fittedContainer = section.closest('.rank-container');
    const fitObserver = new MutationObserver(schedule);
    if (fittedContainer) fitObserver.observe(fittedContainer, { attributes: true, attributeFilter: ['style'] });
    window.addEventListener('scroll', schedule, { capture: true, passive: true });
    window.addEventListener('resize', schedule);
    void document.fonts.ready.then(schedule);
    measure();
    return () => {
      active = false;
      cancelAnimationFrame(frame);
      observer.disconnect();
      fitObserver.disconnect();
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
    };
  }, []);
  return { sectionRef, headerRef, floating };
}

/** Adapted from cwnupaaweb/frontend/src/app/components/ExternalBoardStandings.tsx.
 * Presentation only: rankings, frozen cells and summary values come from the board. */
function ExternalBoardStandings<R extends StandingRow, P extends StandingProblem>({ rows, problems, isTeam, scored = false, showSummary = true, getProblemHoverProps }: {
  rows: R[]; problems: P[]; isTeam: boolean; scored?: boolean; showSummary?: boolean; getProblemHoverProps: (row: R, problem: P) => { title: string };
}) {
  const { sectionRef, headerRef, floating } = useFloatingHeader();
  const style = { ...BOARD_RESULT_STYLE, '--standing-problems': Math.max(1, problems.length), '--standing-metric-columns': scored ? '58px minmax(0,1fr)' : '58px 57px minmax(0,1fr)' } as CSSProperties;
  const stats = scored ? [
    { label: '提交', english: 'Submitted', key: 'submitted' },
    { label: '尝试', english: 'Attempted', key: 'attempted' },
    { label: '平均分', english: 'Average', key: 'avgScore' },
    { label: '最高分', english: 'Maximum', key: 'maxScore' },
    { label: '最低分', english: 'Minimum', key: 'minScore' },
  ] as const : [
    { label: '提交', english: 'Submitted', key: 'submitted' },
    { label: '尝试', english: 'Attempted', key: 'attempted' },
    { label: '通过', english: 'Accepted', key: 'accepted' },
    { label: '首答', english: 'First solve', key: 'firstSolved' },
    { label: '末答', english: 'Last solve', key: 'lastSolved' },
  ] as const;
  const pinnedRows = rows.filter(row => row.isPinned);
  const rankedRows = rows.filter(row => !row.isPinned);
  const renderRow = (row: R) => {
    const unofficial = row.isStar || row.rank === -1;
    const medal = !unofficial && row.medal ? row.medal.toLowerCase() : '';
    return <article key={row.boardRowKey} className={`external-standing-row${row.isPinned ? ' is-pinned' : ''}`} aria-label={`${row.organization || ''} ${row.name}，排名 ${unofficial ? '打星' : row.rank}`}>
      <div className="external-standing-sidebar">
        <BoardParticipantWatermark row={row} />
        <div className="external-standing-people"><BoardParticipantMetadata row={row} isTeam={isTeam} /></div>
        <div className="external-standing-metrics">
          <span className={`external-standing-rank ${unofficial ? 'unofficial' : medal}`} title={unofficial ? '打星参赛' : '正式排名'}>{unofficial ? '*' : row.rank}</span>
          {scored ? <span className="external-standing-score" title="总分">{formatScore(row.totalScore ?? 0)}</span> : <><span className="external-standing-solved" title="解题数">{row.solved ?? 0}</span><span className="external-standing-penalty" title="罚时（分钟）">{row.penalty ?? 0}</span></>}
        </div>
      </div>
      <div className="external-standing-content">
        <div className="external-standing-info">
          <BoardParticipantOrganization row={row} isTeam={isTeam} />
          <BoardParticipantTeam row={row} isTeam={isTeam} watermark={false} compact />
        </div>
        <div className="external-standing-problems">{problems.map(problem => {
          const status = row.problemStatus[problem.id];
          if (scored) {
            const hasScore = status?.status === 'Scored' && status.score != null;
            const frozen = status?.status === 'PENDING';
            const score = status?.score ?? 0;
            const maximum = status?.maxScore ?? problem.score ?? 100;
            const level = getBoardScoreLevel(score, maximum);
            return <button key={problem.id} type="button" className={`external-standing-problem score${hasScore ? '' : frozen ? ' frozen' : ' empty'}`} style={hasScore ? { background: level.color, color: level.textColor } : undefined} {...getProblemHoverProps(row, problem)} aria-label={`${row.name}，${problem.label}，${hasScore ? `${formatScore(score)} / ${formatScore(maximum)} 分` : frozen ? '封榜待揭晓' : '未提交'}，悬停查看提交记录`}>
              {hasScore ? <strong>{formatScore(score)}</strong> : frozen ? '?' : problem.label}
            </button>;
          }
          const attempted = status && status.status !== 'NONE';
          const kind = !attempted ? 'empty' : status.status === 'AC' ? status.isFirstAc ? 'first-ac' : 'ac' : status.status === 'WA' ? 'wa' : status.status === 'PENDING' ? 'frozen' : 'empty';
          const verdict = kind === 'first-ac' ? '首答' : kind === 'ac' ? '通过' : kind === 'wa' ? '未通过' : kind === 'frozen' ? '封榜待揭晓' : '未提交';
          return <button key={problem.id} type="button" className={`external-standing-problem ${kind}`} {...getProblemHoverProps(row, problem)} aria-label={`${row.name}，${problem.label}，${verdict}，悬停查看提交记录`}>
            {kind === 'empty' ? <span>{problem.label}</span> : <><span className="external-standing-attempts">{status?.tryCount ?? 0}</span><span className="external-standing-minute">{status?.time ?? 0}′</span></>}
            {kind === 'first-ac' && <span className="external-standing-first-solve" aria-hidden="true">★</span>}
          </button>;
        })}</div>
      </div>
    </article>;
  };
  const renderHeader = (ref?: Ref<HTMLDivElement>) => <div ref={ref} className="external-standing-head">
      <div className="external-standing-head-metrics"><span>排名<small>Rank</small></span>{scored ? <span>总分<small>Score</small></span> : <><span>题数<small>Solved</small></span><span>罚时<small>Penalty</small></span></>}</div>
      <div className="external-standing-problems">{problems.map(problem => <span key={problem.id} title={scored ? `${problem.label}. ${problem.name} · 满分 ${formatScore(problem.score ?? 100)}${isTeam ? ' 分/人，格子显示全队成员得分之和' : ' 分'}` : `${problem.label}. ${problem.name} · ${problem.accepted} accepted / ${problem.submitted} submitted`}>
        <span className="external-standing-problem-heading"><strong>{problem.label}</strong><small>{scored ? `${formatScore(problem.score ?? 100)}${isTeam ? '分/人' : '分'}` : `${problem.accepted}/${problem.submitted}`}</small></span>
      </span>)}</div>
    </div>;
  return <><section ref={sectionRef} className="external-standings" style={style} aria-label="比赛榜单">
    {renderHeader(headerRef)}
    <div className="external-standing-rows">
      {pinnedRows.map(renderRow)}
      {pinnedRows.length > 0 && <div className="external-standing-pin-divider" role="separator" aria-label="筛选置顶结果"><span aria-hidden="true">📌</span><strong>筛选置顶结果</strong><small>Pinned Filtered Rows</small><span /></div>}
      {rankedRows.map(renderRow)}
      {!rows.length && <div className="cwnu-rank-empty">暂无符合条件的参赛者</div>}
    </div>
    {showSummary && <div className="external-standing-summary" aria-label="题目统计">
      {stats.map(stat => <div className="external-standing-summary-row" key={stat.key}>
        <span className="external-standing-summary-label">{stat.label}<small>{stat.english}</small></span>
        <div className="external-standing-problems">{problems.map(problem => {
          const value = problem[stat.key];
          const content = value == null ? '—' : stat.key === 'firstSolved' || stat.key === 'lastSolved' ? value < 0 ? '—' : `${value}′` : stat.key === 'avgScore' || stat.key === 'maxScore' || stat.key === 'minScore' ? problem.submitted || problem.attempted ? formatScore(value) : '—' : value;
          return <span key={problem.id} title={stat.key === 'accepted' && problem.submitted ? `${(problem.accepted / problem.submitted * 100).toFixed(1)}%` : undefined}>{content}</span>;
        })}</div>
      </div>)}
    </div>}
  </section>{floating && createPortal(<div className="external-standing-sticky-holder" aria-hidden="true" style={{ ...style, left: floating.left, top: floating.top, width: floating.width, height: floating.height }}>
    <div style={{ width: floating.naturalWidth, transform: `scale(${floating.scale})`, transformOrigin: 'top left' }}>{renderHeader()}</div>
  </div>, document.body)}</>;
}

export default memo(ExternalBoardStandings) as typeof ExternalBoardStandings;
