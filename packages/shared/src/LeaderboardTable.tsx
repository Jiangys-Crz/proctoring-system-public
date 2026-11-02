'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { filterLeaderboardRows, isXcpcLeaderboard, leaderboardGroups, leaderboardScoreClass, type LeaderboardData, type ParticipationFilter } from './leaderboard';
import { leaderboardExportTable } from './leaderboard-export';

type Problem = { id: string; label: string; title: string; score: number };
type Props = {
  leaderboard: LeaderboardData; rule: string; title: string; problems: Problem[];
  startAt?: string; endAt?: string; onRefresh?: () => void; refreshing?: boolean;
  onTimeChange?: (timePoint: number | null) => void;
  exportScope?: 'all' | 'visible'; onDownload?: (blob: Blob, name: string) => void;
};
const duration = (seconds: number) => [Math.floor(seconds / 3600), Math.floor(seconds % 3600 / 60), Math.floor(seconds % 60)].map(value => String(value).padStart(2, '0')).join(':');

/** The admin and candidate boards use the same controls and cells. */
export function LeaderboardTable({ leaderboard, rule, title, problems, startAt, endAt, onRefresh, refreshing, onTimeChange, exportScope = 'all', onDownload }: Props) {
  const boards = leaderboard.boards?.length ? leaderboard.boards : [{ key: 'main', label: '排行榜', rows: leaderboard.rows }];
  const [boardKey, setBoardKey] = useState('team');
  const [group, setGroup] = useState('');
  const [filter, setFilter] = useState<ParticipationFilter>('all');
  const [search, setSearch] = useState('');
  const [replaySeconds, setReplaySeconds] = useState<number | null>(null);
  const [now, setNow] = useState<number | null>(null);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');
  const viewportRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<{ scale: number; height?: number }>({ scale: 1 });
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const board = boards.find(item => item.key === boardKey) || boards[0];
  const groups = leaderboardGroups(rule);
  const xcpc = isXcpcLeaderboard(rule);
  const scoreBoard = groups.length > 0;
  const hideProblems = rule === 'GPLT' && board.key === 'team';
  const rows = filterLeaderboardRows(board.rows, rule, group, filter, search);
  const tableWidth = Math.max(900, xcpc ? 598 + problems.length * 54 : hideProblems ? 575 : 545 + problems.length * 42);
  useLayoutEffect(() => {
    const viewport = viewportRef.current, inner = tableRef.current;
    if (!viewport || !inner) return;
    const update = () => {
      const scale = Math.min(1, Math.max(1, viewport.clientWidth) / tableWidth);
      const height = Math.ceil(inner.offsetHeight * scale);
      setFit(previous => previous.scale === scale && previous.height === height ? previous : { scale, height });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(viewport); observer.observe(inner);
    return () => observer.disconnect();
  }, [board.key, group, filter, search, rows.length, tableWidth]);
  // Counts remain for the entire selected board, like the reference backend.
  const acceptedCounts = problems.map((_, index) => board.rows.filter(row => row.cells?.[index]?.accepted).length);
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

  return <section className="cwnu-rank-shell leaderboard-board">
    <style>{`
      .cwnu-rank-toolbar { flex-wrap: wrap; gap: 12px; }
      .cwnu-rank-toolbar input, .cwnu-rank-toolbar select { width: auto; height: 34px; border: 1px solid #d9dfe3; border-radius: 4px; padding: 0 10px; background: #fff; color: #30383d; }
      .cwnu-rank-toolbar label { display: inline-flex; align-items: center; gap: 8px; }
      .cwnu-rank-action { height: 34px; border: 1px solid #d9dfe3; border-radius: 4px; background: white; color: #30383d; padding: 0 12px; cursor: pointer; }
      .cwnu-rank-action:disabled { opacity: .5; cursor: wait; }
      .cwnu-rank-empty { padding: 40px 20px; text-align: center; color: #777; }
      .cwnu-rank-timeline { padding: 12px 20px; display: grid; gap: 8px; }
      .cwnu-rank-timeline > div { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
      .cwnu-rank-timeline input { width: 100%; padding: 0; height: 20px; accent-color: #198754; }
      .cwnu-rank-table-wrap { overflow: hidden; }
      .cwnu-rank-table .medal-col { width: 70px; }
      .cwnu-rank-table .rank-gold td:not(.problem-col) { background: #fff9e6; }
      .cwnu-rank-table .rank-silver td:not(.problem-col) { background: #f3f4f6; }
      .cwnu-rank-table .rank-bronze td:not(.problem-col) { background: #fff2e8; }
      .cwnu-rank-table .rank-star td:not(.problem-col) { background: #fffbe6; }
      .cwnu-rank-table .rank-members { display: block; margin-top: 3px; color: #777; font-size: 11px; font-weight: 400; }
      .cwnu-rank-badges { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; margin-top: 5px; }
      .cwnu-rank-badge { display: inline-flex; align-items: center; gap: 4px; padding: 2px 7px; border: 1px solid; border-radius: 999px; font: 600 11px/1.5 'Microsoft YaHei', sans-serif; white-space: nowrap; }
      .cwnu-rank-badge > span { display: inline-grid; place-items: center; width: 17px; height: 17px; border-radius: 50%; color: #fff; font-size: 12px; line-height: 1; }
      .cwnu-rank-badge.star { background: linear-gradient(135deg, #fffbeb, #fde68a); border-color: #f59e0b; color: #92400e; box-shadow: 0 1px 3px #f59e0b22; }
      .cwnu-rank-badge.star > span { background: #d97706; }
      .cwnu-rank-badge.girl { background: linear-gradient(135deg, #faf5ff, #e9d5ff); border-color: #a855f7; color: #6b21a8; box-shadow: 0 1px 3px #a855f722; }
      .cwnu-rank-badge.girl > span { background: #9333ea; }
      .cwnu-rank-medal { padding: 2px 5px; border-radius: 3px; color: #000; }
      .cwnu-rank-medal.Gold { background: #fadb14; } .cwnu-rank-medal.Silver { background: #d9d9d9; } .cwnu-rank-medal.Bronze { background: #d48806; }
    `}</style>
    <div className="cwnu-rank-heading"><div><span>LEADERBOARD</span><h3>{title} 排行榜</h3></div><span>{leaderboard.frozen ? 'FROZEN' : replaySeconds !== null ? 'REPLAY MODE' : 'LIVE'}</span></div>
    {start && end && onTimeChange ? <div className="cwnu-rank-timeline">
      <div><time>{new Date(start).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })}</time><time>{new Date(end).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })}</time></div>
      <input aria-label="榜单时间" type="range" min={0} max={total} value={replaySeconds ?? current} onChange={event => setReplaySeconds(Number(event.target.value))} onPointerUp={commitReplay} onKeyUp={commitReplay} />
      <div><strong>{duration(replaySeconds ?? current)} / {duration(total)}</strong>{replaySeconds !== null ? <button className="cwnu-rank-action" onClick={() => { setReplaySeconds(null); onTimeChange(null); }}>Return to Live</button> : null}</div>
    </div> : null}
    <div className="cwnu-rank-legend">{xcpc ? <><span><i className="cell-problem-first-ac" />First AC</span><span><i className="cell-problem-ac" />AC</span><span><i className="cell-problem-frozen" />Frozen</span></> : !hideProblems ? ['0-25%', '26-50%', '51-75%', '76-100%'].map((label, index) => <span key={label}><i className={`cell-score-level-${index + 1}`} />{label}</span>) : null}</div>
    <div className="cwnu-rank-toolbar">
      {scoreBoard ? <label><span>参赛组别</span><select aria-label="选择组别" value={group} onChange={event => setGroup(event.target.value)}><option value="" disabled>选择组别</option>{groups.map(value => <option key={value} value={value}>{value}</option>)}</select></label> : null}
      {rule === 'GPLT' ? <div className="cwnu-rank-segments" aria-label="排行榜类型">{['team', 'personal'].map(key => <button className={board.key === key ? 'active' : ''} key={key} onClick={() => setBoardKey(key)}>{key === 'team' ? '团队排名' : '个人排名'}</button>)}</div> : null}
      <select aria-label="参赛类型" value={filter} onChange={event => setFilter(event.target.value as ParticipationFilter)}><option value="all">所有参赛</option><option value="official">正式参赛</option><option value="star">打星参赛</option>{!scoreBoard ? <option value="girl">女生队伍</option> : null}</select>
      <input type="search" aria-label="搜索姓名或机构" placeholder="搜索姓名或机构..." value={search} onChange={event => setSearch(event.target.value)} />
      <button className="cwnu-rank-action" disabled={exporting} onClick={() => void exportBoard()}>{exporting ? '正在导出…' : '导出榜单'}</button>
      {onRefresh ? <button className="cwnu-rank-action" disabled={refreshing} onClick={onRefresh}>刷新</button> : null}
    </div>
    {error ? <div role="alert" className="cwnu-rank-empty">{error}</div> : null}
    {scoreBoard && !group ? <div className="cwnu-rank-empty">请先选择组别以查看榜单</div> : <div className="cwnu-rank-table-wrap exam-overview-table-wrap leaderboard-table-wrap">
      <div ref={viewportRef} style={{ position: 'relative', width: '100%', height: fit.height }}><div style={{ width: tableWidth * fit.scale, margin: '0 auto' }}><div ref={tableRef} style={{ width: tableWidth, transform: `scale(${fit.scale})`, transformOrigin: 'top left' }}>
      <table className="cwnu-rank-table" style={{ width: tableWidth, minWidth: tableWidth }}>
        <thead><tr><th className="sequence-col">#</th><th className="rank-col">Rk</th><th className="institution-col">{xcpc ? 'Institution' : 'Inst'}</th><th className="user-col">{xcpc ? 'User / Team' : hideProblems ? 'Team' : 'User'}</th>{xcpc ? <><th className="stat-col">S</th><th className="stat-col">P</th></> : <th className="score-col">Score</th>}{!hideProblems ? problems.map((problem, index) => <th className="problem-col" key={problem.id} title={`${problem.title} (${problem.score} pts)`}><span>{problem.label}</span><small>{xcpc ? acceptedCounts[index] : problem.score}</small></th>) : null}<th className="medal-col">{xcpc ? 'Medal' : 'Award'}</th></tr></thead>
        <tbody>{rows.map((row, rowIndex) => <tr className={row.isStar ? 'rank-star' : row.medal ? `rank-${row.medal.toLowerCase()}` : ''} key={`${row.groupName}-${row.username}`}>
          <td className="sequence-col">{rowIndex + 1}</td><td className="rank-col">{row.rank === -1 || row.isStar ? '*' : row.rank}{row.rank === 1 && !row.isStar ? <span aria-label="第一名"> 🏆</span> : null}</td><td className="institution-col">{row.institution || 'Unknown'}</td>
          <td className="user-col"><strong>{row.displayName || row.username}</strong>{row.isStar || row.isGirl ? <span className="cwnu-rank-badges">{row.isGirl ? <span className="cwnu-rank-badge girl" aria-label="女生队伍" title="女生队伍"><span aria-hidden="true">♀</span>女生队伍</span> : null}{row.isStar ? <span className="cwnu-rank-badge star" aria-label="打星参赛" title="打星参赛，不占正式名次"><span aria-hidden="true">★</span>打星参赛</span> : null}</span> : null}{row.members && (hideProblems || xcpc) ? <small className="rank-members">{row.members}</small> : null}</td>
          {xcpc ? <><td className="stat-col">{row.solved}</td><td className="stat-col">{Math.floor(row.penalty / 60)}</td></> : <td className="score-col">{Number(row.score.toFixed(2))}</td>}
          {!hideProblems ? problems.map((problem, index) => {
            const cell = row.cells?.[index]; const score = cell?.score ?? row.problemScores[index] ?? null;
            if (!xcpc) return <td className={`problem-col ${leaderboardScoreClass(score, problem.score)}`} key={problem.id}>{score === null ? '' : Number(score.toFixed(2))}</td>;
            const accepted = cell?.accepted ?? row.problemScores[index] === 1;
            const pending = cell?.pending || 0; const wrong = cell?.wrong || 0;
            const className = accepted ? cell?.firstBlood ? 'cell-problem-first-ac' : 'cell-problem-ac' : pending ? 'cell-problem-frozen' : wrong ? 'cell-problem-wa' : 'cell-problem-empty';
            const minutes = Math.floor((cell?.seconds || 0) / 60);
            return <td className={`problem-col ${className}`} key={problem.id}><div className="problem-cell-content">{accepted ? <><span className="main-symbol">+</span><span className="sub-info">{wrong + 1}/{minutes}</span></> : pending ? <><span className="frozen-symbol">? {pending}</span><span className="sub-info">{wrong}/{minutes}</span></> : wrong ? <><span className="main-symbol">-</span><span className="sub-info">{wrong}/{minutes}</span></> : null}</div></td>;
          }) : null}
          <td className="medal-col">{row.medal && !row.isStar ? <span className={`cwnu-rank-medal ${row.medal}`}>{row.medal}</span> : null}</td>
        </tr>)}</tbody>
      </table></div></div></div>{!rows.length ? <div className="cwnu-rank-empty">暂无排行榜数据</div> : null}
    </div>}
  </section>;
}
