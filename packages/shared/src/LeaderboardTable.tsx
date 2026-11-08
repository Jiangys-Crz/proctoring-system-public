'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { filterLeaderboardRows, isXcpcLeaderboard, leaderboardGroups, type LeaderboardData, type ParticipationFilter } from './leaderboard';
import ExternalBoardStandings from './ExternalBoardStandings';
import { BOARD_SCORE_LEVELS } from './boardScoreColors';
import { BOARD_RESULT_COLORS } from './boardResultColors';
import type { StandingProblemStatus } from './standing-types';
import './LeaderboardTable.css';
import { useBoardDesktopLayout } from './useBoardDesktopLayout';
import { leaderboardExportTable } from './leaderboard-export';

type Problem = { id: string; label: string; title: string; score: number };
type Props = {
  leaderboard: LeaderboardData; rule: string; title: string; problems: Problem[];
  startAt?: string; endAt?: string; onRefresh?: () => void; refreshing?: boolean;
  onTimeChange?: (timePoint: number | null) => void;
  isTeam?: boolean; exportScope?: 'all' | 'visible'; onDownload?: (blob: Blob, name: string) => void;
};
const identity = (row: {groupName?:string;username:string}) => JSON.stringify([row.groupName, row.username]);
const duration = (seconds: number) => [Math.floor(seconds / 3600), Math.floor(seconds % 3600 / 60), Math.floor(seconds % 60)].map(value => String(value).padStart(2, '0')).join(':');

/** The admin and candidate boards use the same controls and cells. */
export function LeaderboardTable({ leaderboard, rule, title, problems, startAt, endAt, onRefresh, refreshing, onTimeChange, isTeam = false, exportScope = 'all', onDownload }: Props) {
  const boards = leaderboard.boards?.length ? leaderboard.boards : [{ key: 'main', label: '排行榜', rows: leaderboard.rows }];
  const [boardKey, setBoardKey] = useState('team');
  const [group, setGroup] = useState('');
  const [filter, setFilter] = useState<ParticipationFilter>('all');
  const [search, setSearch] = useState('');
  const [pinned, setPinned] = useState<string[]>([]);
  const [replaySeconds, setReplaySeconds] = useState<number | null>(null);
  const [now, setNow] = useState<number | null>(null);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const board = boards.find(item => item.key === boardKey) || boards[0];
  const groups = leaderboardGroups(rule);
  const xcpc = isXcpcLeaderboard(rule);
  const scoreBoard = groups.length > 0;
  const team = rule === 'GPLT' ? board.key === 'team' : isTeam;
  const rows = useMemo(() => filterLeaderboardRows(board.rows, rule, group, filter, ''), [board.rows, rule, group, filter]);
  const pinnedKeys = useMemo(() => new Set(pinned), [pinned]);
  const terms = search.normalize('NFKC').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const suggestions = terms.length ? rows.filter(row => terms.every(term => [row.displayName, row.institution].some(value => value?.normalize('NFKC').toLowerCase().includes(term)))).slice(0, 12) : [];
  const displayRows = useMemo(() => rows.map((row, index) => {
    const problemStatus: Record<string, StandingProblemStatus> = {};
    problems.forEach((problem, position) => {
      const cell = row.cells?.[position], score = cell?.score ?? row.problemScores[position] ?? null;
      const accepted = cell?.accepted ?? row.problemScores[position] === 1;
      problemStatus[problem.id] = xcpc
        ? { status: accepted ? 'AC' : cell?.pending ? 'PENDING' : cell?.wrong ? 'WA' : 'NONE', time: Math.floor((cell?.seconds || 0) / 60), tryCount: accepted ? (cell?.wrong || 0) + 1 : cell?.pending || cell?.wrong || 0, isFirstAc: cell?.firstBlood }
        : { status: score !== null ? 'Scored' : cell?.pending ? 'PENDING' : 'NONE', score: score ?? undefined, maxScore: cell?.maxScore ?? problem.score };
    });
    return { itemId: row.username, rank: row.rank, name: row.displayName || row.username, organization: row.institution,
      members: row.members, advisor: row.advisor, group: row.groupName, isStar: row.isStar, isGirl: row.isGirl, medal: row.medal,
      solved: row.solved, penalty: Math.floor(row.penalty / 60), totalScore: row.score, problemStatus,
      boardRowKey: `rank-${identity(row)}`, boardPosition: index + 1, isPinned: false, identity: identity(row) };
  }), [rows, problems, xcpc]);
  const standings = useMemo(() => [...displayRows.filter(row => pinnedKeys.has(row.identity)).map(row => ({ ...row, boardRowKey: `pinned-${row.identity}`, isPinned: true })), ...displayRows], [displayRows, pinnedKeys]);
  const standingProblems = useMemo(() => problems.map((problem, index) => ({ ...problem, name: problem.title, ...(leaderboard.problemStats?.[index] || { submitted: 0, attempted: 0, accepted: 0, firstSolved: -1, lastSolved: -1 }) })), [problems, leaderboard.problemStats]);
  const getProblemHoverProps = useCallback((row: {name:string}, problem: {label:string;title:string}) => ({ title: `${row.name} · ${problem.label} · ${problem.title}` }), []);
  const { viewportRef, contentRef: tableRef, fit } = useBoardDesktopLayout(`${rule}:${board.key}:${group}:${filter}`);
  const start = startAt ? +new Date(startAt) : 0;
  const end = endAt ? +new Date(endAt) : 0;
  const total = Math.max(0, Math.floor((end - start) / 1000));
  const current = now === null ? 0 : Math.max(0, Math.min(total, Math.floor((now - start) / 1000)));
  const commitReplay = () => { if (replaySeconds !== null) onTimeChange?.(start + replaySeconds * 1000); };

  async function exportBoard() {
    setError(''); setExporting(true);
    try {
      const XLSX = await import('xlsx');
      const book = XLSX.utils.book_new();
      const exportGroups = exportScope === 'visible' ? [group] : groups.length ? groups : [''];
      for (const exportGroup of exportGroups) for (const selectedBoard of exportScope === 'visible' ? [board] : boards) {
        const selectedRows = exportScope === 'visible' ? rows : selectedBoard.rows.filter(row => !exportGroup || row.groupName === exportGroup);
        const data = leaderboardExportTable(selectedRows, rule, selectedBoard.key, problems);
        const name = [exportGroup, boards.length > 1 ? selectedBoard.key === 'team' ? '团队' : '个人' : '排名'].filter(Boolean).join('-').replace(/[\\/\[\]*?:]/g, '_').slice(0, 31);
        XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(data), name);
      }
      const filename = `Contest_Rank_${title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120)}.xlsx`;
      if (onDownload) onDownload(new Blob([XLSX.write(book, { bookType: 'xlsx', type: 'array' })], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), filename);
      else XLSX.writeFile(book, filename);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '导出失败，请重试'); }
    finally { setExporting(false); }
  }

  const displayedAt = replaySeconds !== null && start ? start + replaySeconds * 1000 : now;
  const status = displayedAt !== null && start && displayedAt < start ? 'PENDING' : displayedAt !== null && end && displayedAt >= end ? 'ENDED' : leaderboard.frozen ? 'FROZEN' : 'RUNNING';
  const progress = total ? Math.max(0, Math.min(100, (replaySeconds ?? current) / total * 100)) : 0;
  const addPin = (key: string) => { setPinned(previous => previous.includes(key) ? previous : [...previous, key]); setSearch(''); };
  return <section className="reference-leaderboard leaderboard-board">
    <div ref={viewportRef} className="board-page-fit-viewport" style={{ height: fit.height }}>
    <div ref={tableRef} className="rank-container" style={{ width: fit.width, transform: `scale(${fit.scale})`, transformOrigin: 'top left' }}>
      <header className="rank-page-header">
        <div className="rank-page-title"><h3>{title}</h3><div className="rank-page-meta"><span>Type: <span className="rank-page-meta-type">{rule === 'ACM' ? 'XCPC' : rule}</span></span><span>Status: <span className="rank-page-meta-status">{status}</span></span></div></div>
        {start && end && onTimeChange ? <div className="rank-page-timeline">
          <div className="rank-page-times"><time>{new Date(start).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })}</time><time>{new Date(end).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })}</time></div>
          <div className="rank-page-progress" data-status={status}><input aria-label="榜单时间" type="range" min={0} max={total} disabled={status === 'PENDING'} value={replaySeconds ?? current} style={{ background: `linear-gradient(to right, ${leaderboard.frozen ? BOARD_RESULT_COLORS.frozen : BOARD_RESULT_COLORS.ac} ${progress}%, #f3f4f6 ${progress}%)` }} onChange={event => setReplaySeconds(Number(event.target.value))} onPointerUp={commitReplay} onKeyUp={commitReplay} /></div>
        </div> : null}
        <div className="rank-page-timeline-bottom"><div className="rank-page-time-progress" data-replay={replaySeconds !== null}><span>{duration(replaySeconds ?? current)}<span className="rank-page-time-progress-total"> / {duration(total)}</span></span>{replaySeconds !== null ? <button type="button" onClick={() => { setReplaySeconds(null); onTimeChange?.(null); }}>Return to Live</button> : null}</div>
          <div className="rank-page-legend">{xcpc ? Object.entries(BOARD_RESULT_COLORS).map(([key, color]) => <span key={key}><i style={{ background: color }} />{({firstAc:'First AC',ac:'AC',frozen:'Frozen',wa:'WA'})[key as keyof typeof BOARD_RESULT_COLORS]}</span>) : !team ? BOARD_SCORE_LEVELS.map(level => <span className="rank-score-legend" style={{ background: level.color, color: level.textColor }} key={level.label}>{level.label}</span>) : null}</div>
        </div>
      </header>
      <div className="rank-page-content">
        <div className="rank-page-filters">
          {scoreBoard ? <select aria-label="选择组别" value={group} onChange={event => setGroup(event.target.value)}><option value="" disabled>Select a group</option>{groups.map(value => <option key={value} value={value}>{value}</option>)}</select> : null}
          {rule === 'GPLT' ? <div className="rank-scope-control" aria-label="排行榜类型">{['team', 'personal'].map(key => <button type="button" className={board.key === key ? 'active' : ''} key={key} onClick={() => setBoardKey(key)}>{key === 'team' ? 'Team Ranking' : 'Person Ranking'}</button>)}</div> : null}
          <select aria-label="参赛类型" value={filter} onChange={event => setFilter(event.target.value as ParticipationFilter)}><option value="all">All Participants</option><option value="official">Official</option><option value="star">Unofficial</option>{!scoreBoard ? <option value="girl">Female Team</option> : null}</select>
          <div className="rank-participant-search"><input type="search" aria-label="搜索并置顶姓名或机构" placeholder={team ? 'Search team or institution to pin...' : 'Search name or institution to pin...'} value={search} onChange={event => setSearch(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && suggestions[0]) { event.preventDefault(); addPin(identity(suggestions[0])); } }} />
            {suggestions.length ? <div className="rank-participant-options">{suggestions.map(row => <button type="button" key={identity(row)} onClick={() => addPin(identity(row))}><strong>{row.displayName}</strong><small>{row.institution || 'Unknown institution'} · Rk {row.rank === -1 ? '*' : row.rank}</small></button>)}</div> : null}
          </div><span className="rank-toolbar-spacer" />
          <button type="button" disabled={exporting} onClick={() => void exportBoard()}>{exporting ? 'Exporting…' : 'Export Leaderboard'}</button>
          {onRefresh ? <button type="button" disabled={refreshing} onClick={onRefresh}>Refresh</button> : null}
        </div>
        {pinned.length ? <div className="rank-pinned-tags">{rows.filter(row => pinnedKeys.has(identity(row))).map(row => <button type="button" key={identity(row)} onClick={() => setPinned(previous => previous.filter(key => key !== identity(row)))}>{row.displayName} ×</button>)}</div> : null}
        {error ? <div role="alert" className="cwnu-rank-empty">{error}</div> : null}
        {scoreBoard && !group ? <div className="cwnu-rank-empty">Select a group to view the leaderboard</div> : <ExternalBoardStandings rows={standings} problems={standingProblems} isTeam={team} scored={!xcpc} showSummary={rule !== 'GPLT' || !team} getProblemHoverProps={getProblemHoverProps} />}
      </div>
    </div></div>
  </section>;
}
