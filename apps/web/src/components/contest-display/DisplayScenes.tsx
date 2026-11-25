import { memo, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import type { ContestDisplayResponse, ContestDisplayScene } from '@/lib/contest-display-contract';
import type { ContestLiveCell, ContestLiveProblem, ContestLiveStanding, ContestLiveSubmission } from '@/lib/contest-live-contract';
import type { ContestLiveBroadcastTeam } from '@/lib/contest-live-settings';
import { AdditionalDisplayScene } from './AdditionalDisplayScenes';
import { DisplayChartScene, isChartDisplayScene } from './DisplayChartScenes';
import { DisplayDiagnosticScene } from './DisplayDiagnostics';
import { FirstSolutionHistoryScene } from './FirstSolutionHistoryScene';
import { CaptionPhotoSlide, ContestBanner, GraphicSlide, TeamDetailSlide } from './GraphicSlides';
import styles from './ContestDisplay.module.css';

type SceneProps = {
  scene: ContestDisplayScene;
  data: ContestDisplayResponse;
  now: number;
  elapsed: number;
};

const clockFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const nameCollator = new Intl.Collator('zh-CN', { numeric: true });
const presentationNames: Record<ContestDisplayScene, string> = {
  blank: 'Blank',
  scoreboard: 'Current Standings',
  scoreboardTimeline: 'Current Standings',
  leaderboard: 'Current Medal Contenders',
  scoreboardJudge: 'Judge Queue',
  scoreboardFirstToSolve: 'First to Solve',
  scoreboardMedal: 'Current Medal Contenders',
  scoreboardTiles: 'Current Standings',
  scoreboardAlphabetical: 'Alphabetic list of teams',
  scoreboardRank: 'Team Rank',
  scoreboardTeam: 'Team Scoreboard',
  queue: 'Submissions',
  judgeQueue: 'Team Judgements',
  firstToSolve: 'First Solution in Contest',
  statistics: 'Problem Summary',
  team: 'Single Team',
  teamDetail: 'Team Detail',
  teamList: 'Teams',
  teamPhoto: 'Photo and Caption',
  organizationList: 'Organizations',
  organizationLogo: 'Fading Logos',
  problem: 'Problem Detail',
  countdown: 'Countdown',
  contestClock: 'Contest Clock',
  clock: 'Clock',
  logo: 'Logo',
  logoA: 'Logo A',
  logoB: 'Logo B',
  imageProgression: 'Image progression',
  promotions: 'Promotions',
  ccs: 'CCS',
  title: 'Title',
  message: 'Message',
  awards: 'Awards',
  groupLeaderboard: 'Leaders',
  allGroupsLeaderboard: 'All Group Leaders',
  problemColors: 'Problem Colours',
  logoWall: 'Organization Logos',
  fadingLogos: 'Fading Logos',
  slidingLogos: 'Sliding Logos',
  photoSlideshow: 'Photos',
  polarCountdown: 'Polar Countdown',
  problemDetailChart: 'Problem Submissions',
  problemComparisonChart: 'Submissions by Problem',
  problemSummaryChart: 'Attempts & Solutions by Problem',
  totalProblemsChart: 'Total Problem Submissions',
  languageSummaryChart: 'Attempts & Solutions by Language',
  judgementChart: 'Average Judgement Time by Problem',
  judgeQueueDepthChart: 'Judgement Queue Depth',
  scoreboardChart: 'Scoreboard Standing',
  historicalComparisonChart: 'Historical Comparison',
  testChart: 'Test Chart',
  testAlignment: 'Display Alignment',
  testSynchronization: 'Synchronization',
  testClock: 'Test Clock',
  testFps: 'FPS',
  testBlueScreen: 'Blue Screen',
};
const medals = { Gold: 'Gold Medal', Silver: 'Silver Medal', Bronze: 'Bronze Medal' };
const problemPalette = ['#dc4057', '#fbde40', '#35acda', '#f18b32', '#af70ce', '#5cc186', '#dc5d9f', '#adb8cd'];
const verdictLabels = new Map([
  ['accepted', 'Accepted'], ['ac', 'Accepted'], ['ok', 'Accepted'], ['wrong answer', 'Wrong Answer'], ['wa', 'Wrong Answer'],
  ['time limit exceeded', 'Time Limit Exceeded'], ['tle', 'Time Limit Exceeded'], ['memory limit exceeded', 'Memory Limit Exceeded'], ['mle', 'Memory Limit Exceeded'],
  ['output limit exceeded', 'Output Limit Exceeded'], ['ole', 'Output Limit Exceeded'], ['runtime error', 'Run-time Error'], ['re', 'Run-time Error'],
  ['compile error', 'Compile Error'], ['ce', 'Compile Error'], ['system error', 'System Error'], ['se', 'System Error'],
  ['presentation error', 'Presentation Error'], ['pe', 'Presentation Error'], ['partially accepted', 'Partially Accepted'],
  ['通过', 'Accepted'], ['正确', 'Accepted'], ['答案正确', 'Accepted'],
]);

function resultLabel(run: ContestLiveSubmission) {
  if (!run.verdict) return run.frozen ? 'Frozen Submission' : 'Pending Submission';
  if (run.firstBlood) return 'First to Solve';
  return verdictLabels.get(run.verdict.trim().toLowerCase()) ?? (run.score !== null ? 'Judged' : 'Rejected');
}

function submissionStatus(run: ContestLiveSubmission) {
  return run.frozen ? 'frozen' : !run.verdict ? 'pending'
    : run.firstBlood ? 'first' : resultLabel(run) === 'Accepted' ? 'solved' : 'wrong';
}

function timecode(seconds: number) {
  seconds = Math.max(0, Math.floor(seconds));
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(value => String(value).padStart(2, '0')).join(':');
}

function signedTime(seconds: number, positiveSign = '') {
  const value = timecode(Math.abs(seconds)).replace(/^0(?=\d:)/, '');
  return (seconds < 0 ? '-' : positiveSign) + value;
}

function scoreboardTimes({ startAt, endAt }: SceneProps['data']['contest']['exam'], now: number) {
  const ended = now >= Date.parse(endAt);
  return {
    left: ended ? 'Contest is over' : signedTime(Math.ceil((now - Date.parse(startAt)) / 1000)),
    right: ended ? 'Contest is over' : signedTime(Math.floor((Date.parse(endAt) - now) / 1000)),
  };
}

function Frame({ caption, data, now, children, compact = false }: { caption: string; data: SceneProps['data']; now: number; children: ReactNode; compact?: boolean }) {
  const { frozen } = data.contest.exam;
  const { left, right } = scoreboardTimes(data.contest.exam, now);
  return <section className={styles.frame} data-compact={compact || undefined} aria-label={caption}>
    <header className={styles.header}>
      {data.settings.showClock !== false && <div className={styles.headerClock} data-side="left" data-frozen={frozen || undefined}>{left}</div>}
      <div className={styles.headerTitle}>{data.settings.title || caption}</div>
      {data.settings.showClock !== false && <div className={styles.headerClock} data-side="right" data-frozen={frozen || undefined}>{right}</div>}
    </header>
    <div className={styles.frameContent}>{children}</div>
  </section>;
}

function Empty({ children = 'No Data' }: { children?: ReactNode }) {
  return <div className={styles.empty}>{children}</div>;
}

function School({ team }: { team: ContestLiveBroadcastTeam }) {
  return team.organizationLogoUrl ? <img className={styles.school} src={team.organizationLogoUrl} alt="" /> : null;
}

function scrollPage<T>(rows: T[], pageSize: number, elapsed: number, speed: number, scroll: boolean) {
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const page = scroll ? Math.floor(elapsed * speed / 7500) % pages : 0;
  return { rows: rows.slice(page * pageSize, (page + 1) * pageSize), page };
}

function colorFor(problem: ContestLiveProblem, index: number) {
  return problem.color || problemPalette[index % problemPalette.length];
}

function problemHeader(problem: ContestLiveProblem, index: number) {
  return <span key={problem.id} className={styles.problemLetter}
    style={{ '--problem-color': colorFor(problem, index) } as CSSProperties} title={problem.name}>{problem.label}</span>;
}

function ResultCell({ cell, icpc, label }: { cell?: ContestLiveCell; icpc: boolean; label: string }) {
  if (!cell) return <span className={styles.scoreCell}>{label}</span>;
  const status = cell.firstBlood ? 'first' : cell.accepted ? 'solved' : cell.frozen ? 'frozen'
    : cell.pending ? 'pending' : cell.wrong || cell.score !== null ? 'wrong' : 'empty';
  if (status === 'empty') return <span className={styles.scoreCell}>{label}</span>;
  const minutes = Math.floor(cell.seconds / 60);
  const attempts = cell.wrong + cell.pending + Number(cell.accepted);
  return <span className={styles.scoreCell} data-status={status}
    aria-label={status === 'frozen' ? 'Frozen Submission' : status === 'pending' ? 'Pending Submission' : undefined}>
    {status === 'frozen' ? cell.pending > 0 ? `?${cell.pending}` : '?' : icpc
      ? minutes > 0 ? `${attempts || 1} - ${minutes}` : attempts || 1
      : cell.pending && cell.score === null ? '?' : cell.score ?? '−'}
  </span>;
}

const noProblems: ContestLiveProblem[] = [];

function BoardTeamCell({ team, standing, problems, icpc }: {
  team: ContestLiveBroadcastTeam; standing: ContestLiveStanding; problems: ContestLiveProblem[]; icpc: boolean;
}) {
  const cells = new Map(standing.cells.map(cell => [cell.problemId, cell]));
  return <div className={styles.boardTeam}><School team={team} /><div>
    <div className={styles.boardTeamName}>{team.name}</div>
    {!!problems.length && <div className={styles.scoreStrip} style={{ '--problems': problems.length } as CSSProperties}>
      {problems.map(problem => <span key={problem.id} title={`${problem.label} ${problem.name}`}>
        <ResultCell label={problem.label} cell={cells.get(problem.id)} icpc={icpc} />
      </span>)}
    </div>}
  </div></div>;
}

function boardOffset(total: number, pageSize: number, elapsed: number, speed: number) {
  const lastOffset = Math.max(0, total - pageSize);
  const pages = Math.ceil(total / pageSize);
  if (!lastOffset) return 0;
  const time = (elapsed * speed) % (3000 + pages * 12_000 + 1000);
  const progress = Math.max(0, (time - 3000 + 750) / 12_000);
  const page = Math.floor(progress);
  if (page === 0) return 0;
  const phase = Math.min(1, (progress - page) * 8);
  const motion = phase * phase * (3 - 2 * phase);
  return Math.min(lastOffset, (page - 1 + motion) * pageSize);
}

function BoardLegend({ elapsed, frozen }: { elapsed: number; frozen: boolean }) {
  if (elapsed >= 6000) return null;
  const entries = [['first', 'First to Solve'], ['solved', 'Solved Problem'], ['wrong', 'Rejected Run(s)'], ['pending', 'Pending Submission']];
  if (frozen) entries.push(['frozen', 'Frozen Submission']);
  return <aside className={styles.boardLegend} aria-label="Legend" style={{ opacity: Math.min(1, elapsed / 1500, (6000 - elapsed) / 1500) }}>
    {entries.map(([status, label]) => <div key={status}><span className={styles.scoreCell} data-status={status} />{label}</div>)}
  </aside>;
}

function timelinePosition(seconds: number, duration: number) {
  return `${(Math.min(duration, Math.max(0, seconds)) / duration) * 100}%`;
}

const TimelineRuns = memo(function TimelineRuns({ runs, labels, duration }: {
  runs: ContestLiveSubmission[]; labels: Map<string, string>; duration: number;
}) {
  const collision = duration * 0.018;
  let lift = -1;
  return <div className={styles.timelineRuns} aria-label="Submission Timeline">
      {runs.map((run, index) => {
        const overlaps = (index > 0 && run.seconds - runs[index - 1].seconds < collision)
          || (index < runs.length - 1 && runs[index + 1].seconds - run.seconds < collision);
        const offset = overlaps ? lift : 0;
        lift = overlaps ? -lift : -1;
        const label = resultLabel(run);
        const status = run.frozen ? 'frozen' : !run.verdict ? 'pending'
          : run.firstBlood ? 'first' : label === 'Accepted' ? 'solved' : 'wrong';
        const problem = labels.get(run.problemId);
        return <span key={run.id} className={styles.scoreCell} data-status={status}
          aria-label={`${problem} · ${timecode(run.seconds)} · ${label}`}
          style={{ left: timelinePosition(run.seconds, duration), '--run-lift': offset } as CSSProperties}>{problem}</span>;
      })}
  </div>;
});

function BoardTimeline({ runs, labels, duration, current, freeze }: {
  runs: ContestLiveSubmission[]; labels: Map<string, string>; duration: number; current: number; freeze: number | null;
}) {
  const hours = Array.from({ length: Math.max(1, Math.floor(duration / 3600)) }, (_, hour) => hour * 3600);
  return <div className={styles.boardTimeline}>
    <div className={styles.timelineGuide} data-type="current" style={{ left: timelinePosition(current, duration) }} aria-hidden />
    {freeze !== null && <div className={styles.timelineGuide} data-type="freeze" style={{ left: timelinePosition(freeze, duration) }} aria-hidden />}
    <div className={styles.timelineAxis} aria-hidden>
      {hours.map(hour => <i key={hour} style={{ left: timelinePosition(hour, duration) }} />)}
    </div>
    <TimelineRuns runs={runs} labels={labels} duration={duration} />
  </div>;
}

const noRuns: ContestLiveSubmission[] = [];

function Board({ scene, data, now, elapsed, teams }: SceneProps & { teams: ContestLiveBroadcastTeam[] }) {
  const { problems, standings, exam, statistics, submissions, timeline } = data.contest;
  const { group, teamId, speed, scroll } = data.settings;
  const icpc = exam.scoring === 'icpc';
  const hasTimeline = scene === 'scoreboardTimeline';
  const timelineRuns = useMemo(() => {
    const byTeam = new Map<string, ContestLiveSubmission[]>();
    if (hasTimeline) {
      const distinct = new Map([...timeline, ...submissions].map(run => [run.id, run]));
      for (const run of distinct.values()) {
        const runs = byTeam.get(run.teamId);
        if (runs) runs.push(run);
        else byTeam.set(run.teamId, [run]);
      }
      for (const runs of byTeam.values()) runs.sort((a, b) => a.seconds - b.seconds);
    }
    return byTeam;
  }, [hasTimeline, submissions, timeline]);
  const timelineLabels = useMemo(() => new Map(problems.map(problem => [problem.id, problem.label])), [problems]);
  const startTime = Date.parse(exam.startAt);
  const contestDuration = Math.max(1, (Date.parse(exam.endAt) - startTime) / 1000);
  const currentTime = (now - startTime) / 1000;
  const freezeAt = data.settings.freeze.at ?? exam.freezeAt;
  const frozenTime = freezeAt ? (Date.parse(freezeAt) - startTime) / 1000 : null;
  const byId = new Map(teams.map(team => [team.id, team]));
  let ranked = standings.filter(row => byId.has(row.teamId));
  const groups = [...new Set(teams.map(team => team.group).filter(Boolean))];
  const groupName = group || groups[Math.floor(elapsed / (data.settings.durationSeconds * 1000)) % groups.length];
  if (scene === 'groupLeaderboard') ranked = ranked.filter(row => groupName && byId.get(row.teamId)?.group === groupName);
  if (scene === 'allGroupsLeaderboard') {
    const seen = new Set<string>();
    ranked = ranked.filter(row => {
      const name = byId.get(row.teamId)?.group;
      if (row.rank === null || !name || seen.has(name)) return false;
      seen.add(name);
      return true;
    });
  }
  const selected = teamId ? ranked.findIndex(row => row.teamId === teamId) : -1;
  const pageSize = scene === 'groupLeaderboard' || scene === 'allGroupsLeaderboard' ? 10 : 12;
  const pageable = !['leaderboard', 'scoreboardMedal', 'groupLeaderboard', 'allGroupsLeaderboard'].includes(scene);
  const summary = scene === 'scoreboard' && problems.length > 0 && ranked.length > 0;
  const offset = pageable && selected >= 0 ? Math.max(0, Math.min(selected, ranked.length - pageSize))
    : pageable && scroll ? boardOffset(ranked.length + Number(summary), pageSize, elapsed, speed) : 0;
  const first = Math.floor(offset);
  const pageRows = ranked.slice(Math.max(0, first - 1), first + pageSize + (pageable ? 2 : 0));
  const start = Math.max(0, first - 1);
  const title = scene === 'groupLeaderboard' && groupName ? `${groupName} Leaders`
    : group ? `${presentationNames[scene]} · ${group}` : presentationNames[scene];
  const stats = new Map(statistics.map(row => [row.problemId, row]));
  return <Frame caption={title} data={data} now={now} compact>
    {ranked.length === 0 ? <Empty>No Standings</Empty> : <div className={styles.board} role="table" aria-label={title} style={{ '--page-rows': pageSize } as CSSProperties}>
        <div className={styles.boardHeader} role="row">
          <span role="columnheader">Rank</span><span role="columnheader">Name</span>
          <span role="columnheader">{icpc ? 'Solved' : 'Score'}</span><span role="columnheader">Time</span>
        </div>
        <div className={styles.boardViewport}>
          <div className={styles.boardRows} style={{ '--row-offset': offset } as CSSProperties}>
          {pageRows.map((row, index) => {
            const team = byId.get(row.teamId)!;
            return <div key={row.teamId} className={styles.boardRow} role="row" data-featured={teamId === row.teamId || undefined}
              data-timeline={hasTimeline || undefined}
              data-medal={scene === 'scoreboardMedal' ? row.medal ?? undefined : undefined} data-stripe={(start + index) % 2 === 0 || undefined}
              style={{ '--row-index': start + index } as CSSProperties}>
              <span className={styles.rank}>{row.rank ?? '★'}</span>
              <BoardTeamCell team={team} standing={row} problems={hasTimeline ? noProblems : problems} icpc={icpc} />
              <span className={styles.total}>{(icpc ? row.solved : row.score) || ''}</span>
              <span className={styles.penalty}>
                {scene === 'scoreboardMedal' && row.medal ? medals[row.medal] : Math.floor(row.penaltySeconds / 60) || ''}
              </span>
              {hasTimeline && <BoardTimeline runs={timelineRuns.get(row.teamId) ?? noRuns} labels={timelineLabels}
                duration={contestDuration} current={currentTime} freeze={frozenTime} />}
            </div>;
          })}
          {summary && <div className={styles.boardRow} data-summary="" style={{ '--row-index': ranked.length } as CSSProperties}>
            <div className={styles.boardTeam}>
              <div className={styles.scoreStrip} style={{ '--problems': problems.length } as CSSProperties}>
                {problems.map(problem => {
                  const count = stats.get(problem.id);
                  return <div className={styles.summaryCount} key={problem.id}>
                    <span className={styles.scoreCell} data-status={count?.teamsPending ? 'pending' : undefined}>{count?.teamsPending || ''}</span>
                    <span className={styles.scoreCell} data-status={count?.teamsAccepted ? 'solved' : undefined}>{count?.teamsAccepted || ''}</span>
                  </div>;
                })}
              </div>
            </div>
          </div>}
          </div>
        </div>
        {(scene === 'scoreboard' || hasTimeline) && <BoardLegend elapsed={elapsed} frozen={exam.frozen} />}
      </div>}
  </Frame>;
}

type TileEntry = { team: ContestLiveBroadcastTeam; standing: ContestLiveStanding };
type PositionedTile = TileEntry & { x: number; y: number; stripe: boolean; divider: boolean };

const TileFace = memo(function TileFace({ team, standing, problems, icpc }: TileEntry & { problems: ContestLiveProblem[]; icpc: boolean }) {
  const cells = new Map(standing.cells.map(cell => [cell.problemId, cell]));
  return <>
    <span className={styles.nativeTileRank}>{standing.rank ?? '★'}</span>
    <School team={team} />
    <span className={styles.nativeTileName} title={team.name}>{team.name}</span>
    <span className={styles.nativeTileSolved}>{(icpc ? standing.solved : standing.score) || ''}</span>
    {icpc && <span className={styles.nativeTileTime}>{Math.floor(standing.penaltySeconds / 60) || ''}</span>}
    {!!problems.length && <div className={styles.nativeTileResults} style={{ '--problems': problems.length } as CSSProperties}>
      {problems.map(problem => <ResultCell key={problem.id} label={problem.label} cell={cells.get(problem.id)} icpc={icpc} />)}
    </div>}
  </>;
});

function scoreTilePosition(x: number, y: number) {
  return { '--tile-x': x, '--tile-y': y } as CSSProperties;
}

function tileMotion(progress: number) {
  const t = Math.max(0, Math.min(1, progress));
  return t * t * (3 - 2 * t);
}

const tileInterval = 8_000;
const tileInitialDelay = 5_000;

function scrollTileColumns(time: number) {
  const progress = Math.max(0, (time - tileInitialDelay + 800) / tileInterval);
  const column = Math.floor(progress);
  return column ? column - 1 + tileMotion((progress - column) * 5) : 0;
}

function groupScoreTiles(entries: TileEntry[], columns: number) {
  const groups: { solved: number; y: number; rows: number }[] = [];
  const tiles: PositionedTile[] = [];
  let y = 0;
  for (let i = 0; i < entries.length;) {
    const solved = entries[i].standing.solved;
    let end = i + 1;
    while (end < entries.length && entries[end].standing.solved === solved) end++;
    const rows = Math.ceil((end - i) / columns);
    groups.push({ solved, y, rows });
    for (let index = i; index < end; index++) {
      const row = (index - i) % rows;
      tiles.push({ ...entries[index], x: Math.floor((index - i) / rows), y: y + row, stripe: row % 2 === 0, divider: false });
    }
    y += rows + .25;
    i = end;
  }
  return { groups, tiles, length: Math.max(0, y - .25) };
}

function ScoreTiles({ scene, data, now, elapsed, teams }: SceneProps & { teams: ContestLiveBroadcastTeam[] }) {
  const { standings, exam, problems, submissions, statistics } = data.contest;
  const { teamId, scroll, speed, showClock, title, tileRows, tileColumns } = data.settings;
  const entries = useMemo(() => {
    const roster = new Map(teams.map(team => [team.id, team]));
    const result = standings.flatMap(standing => {
      const team = roster.get(standing.teamId);
      return team ? [{ team, standing }] : [];
    });
    return scene === 'scoreboardAlphabetical' ? result.sort((a, b) => a.team.name < b.team.name ? -1 : Number(a.team.name > b.team.name)) : result;
  }, [scene, standings, teams]);
  const lastRunByTeam = useMemo(() => {
    const recent = new Map<string, ContestLiveSubmission>();
    for (const run of submissions) if (!recent.has(run.teamId)) recent.set(run.teamId, run);
    return recent;
  }, [submissions]);
  const ranked = scene === 'scoreboardRank';
  const standard = scene === 'scoreboardTiles';
  const icpc = exam.scoring === 'icpc';
  const rows = tileRows ?? 14;
  const columns = tileColumns ?? 2;
  const rankedLayout = useMemo(() => ranked ? groupScoreTiles(entries, columns) : null, [ranked, entries, columns]);
  const caption = presentationNames[scene];
  if (scene === 'scoreboardTeam') {
    const selected = entries.find(({ team }) => team.id === teamId);
    if (!selected) return <section aria-label={caption} />;
    return <section className={styles.teamScoreTile} aria-label={caption}>
      {selected.team.photoUrl && <img className={styles.teamScoreTilePhoto} src={selected.team.photoUrl} alt={selected.team.name} />}
      <div className={styles.nativeTile}><TileFace {...selected} problems={problems} icpc={icpc} /></div>
    </section>;
  }
  if (!entries.length) return <Empty>No Standings</Empty>;

  const length = entries.length + Number(standard && problems.length > 0);
  const initialRemainder = length % rows;
  const adjustedRemainder = length % (rows + 1);
  const rowCount = tileRows === undefined && initialRemainder > 0 && initialRemainder <= 3
    && (adjustedRemainder === 0 || adjustedRemainder > initialRemainder) ? rows + 1 : rows;
  const nColumns = Math.ceil(length / rowCount);
  const end = rankedLayout ? tileInitialDelay + 10_000 * ((rankedLayout.length + 3) / rowCount) : tileInitialDelay + tileInterval * nColumns;
  const phaseTime = (elapsed * speed) % (end + 1_000);
  const widthColumns = standard && scroll ? 1 + (columns - 1) * tileMotion((phaseTime - tileInitialDelay) / 2_600) : columns;
  const horizontal = scroll && !ranked ? Math.min(nColumns - 1, scrollTileColumns(phaseTime)) : 0;
  const vertical = ranked && scroll ? Math.max(0, (phaseTime - tileInitialDelay) * rowCount / 10_000) : 0;
  const opacity = scroll ? Math.min(1, phaseTime / 1_000, (end + 1_000 - phaseTime) / 1_000) : 1;
  const hasVisiblePosition = (x: number, y: number) => x >= horizontal - 1 && x <= horizontal + widthColumns + 1
    && y >= vertical - 1 && y <= vertical + rowCount + 1;
  const tiles = rankedLayout?.tiles ?? entries.map((entry, index) => ({
    ...entry, x: Math.floor(index / rowCount), y: index % rowCount, stripe: index % rowCount % 2 === 0,
    divider: standard && index > 0 && entry.standing.solved !== entries[index - 1].standing.solved,
  }));
  const totalsPosition = { x: Math.floor(entries.length / rowCount), y: entries.length % rowCount };
  const stats = new Map(statistics.map(row => [row.problemId, row]));
  const clocks = scoreboardTimes(exam, now);
  const tileStyles = {
    '--tile-rows': rowCount, '--tile-columns': widthColumns, '--tile-pan-x': horizontal, '--tile-pan-y': vertical, '--tile-opacity': opacity,
  } as CSSProperties;

  return <section className={styles.tileBoard} data-ranked={ranked || undefined} aria-label={caption} style={tileStyles}>
    {!ranked && <header className={styles.tileBoardHeader}>
      {showClock !== false && <span className={styles.tileBoardClock} data-clock="elapsed" data-frozen={exam.frozen || undefined}>{clocks.left}</span>}
      <strong>{title || caption}</strong>
      {showClock !== false && <span className={styles.tileBoardClock} data-clock="remaining" data-frozen={exam.frozen || undefined}>{clocks.right}</span>}
    </header>}
    <div className={styles.tileBoardWindow}>
      <div className={styles.tileBoardCanvas}>
        {rankedLayout?.groups.filter(group => group.y + group.rows > vertical && group.y < vertical + rowCount + 1).map(group =>
          <div className={styles.tileGroupLabel} key={group.solved} style={{ ...scoreTilePosition(0, group.y), '--tile-group-rows': group.rows } as CSSProperties}>
            <strong>{group.solved}</strong>{group.rows > 1 && <span>solved</span>}
          </div>)}
        {tiles.filter(tile => hasVisiblePosition(tile.x, tile.y)).map(tile => {
          const run = lastRunByTeam.get(tile.team.id);
          const age = run ? now - Date.parse(run.submittedAt) : Infinity;
          const recent = run && age >= 0 && age < 30_000;
          const status = recent ? submissionStatus(run) : undefined;
          return <article key={tile.team.id} className={styles.nativeTile} aria-label={tile.team.name}
            data-stripe={tile.stripe || undefined} data-divider={tile.divider || undefined}
            data-recent={status} style={{ ...scoreTilePosition(tile.x, tile.y), '--tile-age': recent ? 1 - age / 30_000 : 0 } as CSSProperties}>
            <TileFace {...tile} problems={problems} icpc={icpc} />
          </article>;
        })}
        {standard && !!problems.length && hasVisiblePosition(totalsPosition.x, totalsPosition.y) &&
          <div className={styles.nativeTile} aria-label="Problem Totals" style={scoreTilePosition(totalsPosition.x, totalsPosition.y)}>
            <div className={styles.nativeTileResults} style={{ '--problems': problems.length } as CSSProperties}>
              {problems.map(problem => {
                const count = stats.get(problem.id);
                return <div className={styles.summaryCount} key={problem.id}>
                  <span className={styles.scoreCell} data-status={count?.teamsPending ? 'pending' : undefined}>{count?.teamsPending || ''}</span>
                  <span className={styles.scoreCell} data-status={count?.teamsAccepted ? 'solved' : undefined}>{count?.teamsAccepted || ''}</span>
                </div>;
              })}
            </div>
          </div>}
      </div>
    </div>
  </section>;
}

function NativeSubmissionBoard({ scene, data, now, teams }: SceneProps & { teams: ContestLiveBroadcastTeam[] }) {
  const { standings, submissions, problems, exam } = data.contest;
  const { teamId, problemId } = data.settings;
  const byTeam = new Map(teams.map(team => [team.id, team]));
  const byStanding = new Map(standings.map(standing => [standing.teamId, standing]));
  const byProblem = new Map(problems.map(problem => [problem.id, problem]));
  const firstToSolve = scene === 'scoreboardFirstToSolve';
  const caption = presentationNames[scene];
  const icpc = exam.scoring === 'icpc';
  const [observations, setObservations] = useState(new Map<string, { status: string; at: number }>());
  useEffect(() => {
    setObservations(previous => new Map(submissions.map(run => {
      const status = submissionStatus(run);
      const before = previous.get(run.id);
      const at = !before ? Date.parse(run.submittedAt) : before.status !== status ? data.serverTime : before.at;
      return [run.id, { status, at }];
    })));
  }, [submissions, data.serverTime]);

  const firstByProblem = new Map<string, ContestLiveSubmission>();
  if (firstToSolve) {
    for (const standing of standings) {
      if (!byTeam.has(standing.teamId)) continue;
      for (const cell of standing.cells) {
        if (!cell.firstBlood || (problemId && cell.problemId !== problemId)) continue;
        const before = firstByProblem.get(cell.problemId);
        if (!before || cell.seconds < before.seconds) {
          firstByProblem.set(cell.problemId, { id: `first:${cell.problemId}`, problemId: cell.problemId, teamId: standing.teamId,
            seconds: cell.seconds, firstBlood: true, score: cell.score, submittedAt: exam.startAt, verdict: 'Accepted' });
        }
      }
    }
  }
  const first = [...firstByProblem.values()].sort((a, b) => a.seconds - b.seconds);
  const pageRows = 12;
  let nextRow = first.length;
  const remaining = [...submissions].sort((a, b) => a.seconds - b.seconds).flatMap(run => {
    const winning = firstByProblem.get(run.problemId);
    if (!byTeam.has(run.teamId) || !byProblem.has(run.problemId) || (problemId && run.problemId !== problemId)
      || (winning && (run.firstBlood || run.seconds >= winning.seconds))) return [];
    const status = submissionStatus(run);
    const at = observations.get(run.id)?.at ?? Date.parse(run.submittedAt);
    const age = now - at;
    const lifetime = status === 'pending' ? Infinity : status === 'frozen' ? 14_000
      : !firstToSolve && (status === 'first' || status === 'solved') ? 11_000 : 8_000;
    if (age >= lifetime + 1_500) return [];
    if (age < lifetime) return [{ run, row: nextRow++, opacity: 1 }];
    const direction = !firstToSolve && (status === 'first' || status === 'solved') ? -1 : 1;
    return [{ run, row: direction < 0 ? -2 : pageRows + 1, opacity: Math.max(0, 1 - (age - lifetime) / 1_500) }];
  });
  const rows = [...first.map((run, row) => ({ run, row, opacity: 1 })), ...remaining].filter(item => item.row <= pageRows + 1);

  return <Frame caption={caption} data={data} now={now} compact>
    <div className={styles.board} role="table" aria-label={caption} style={{ '--page-rows': pageRows } as CSSProperties}>
      <div className={styles.boardHeader} role="row">
        <span role="columnheader">{firstToSolve ? 'Time' : 'Rank'}</span>
        <span role="columnheader">Name</span>
        {firstToSolve ? <span aria-hidden /> : <span role="columnheader">{icpc ? 'Solved' : 'Score'}</span>}
        <span role="columnheader">{firstToSolve ? 'Problem' : 'Time'}</span>
      </div>
      <div className={`${styles.boardViewport} ${styles.nativeSubmissionLanes}`}>
        {first.length > 0 && <div className={styles.nativeSubmissionDivider} style={{ '--row-index': first.length } as CSSProperties} />}
        {rows.map(({ run, row, opacity }) => {
          const team = byTeam.get(run.teamId)!;
          const standing = byStanding.get(run.teamId);
          const cells = new Map(standing?.cells.map(cell => [cell.problemId, cell]));
          const minutes = Math.floor(run.seconds / 60);
          return <div className={`${styles.boardRow} ${styles.nativeSubmissionRow}`} role="row" key={run.id}
            data-featured={teamId === team.id || undefined} style={{ '--row-index': row, opacity } as CSSProperties}>
            <span className={styles.rank}>{firstToSolve ? minutes : standing?.rank ?? '★'}</span>
            <div className={styles.boardTeam}><School team={team} /><div>
              <div className={styles.boardTeamName}>{team.name}</div>
              {!!problems.length && <div className={styles.scoreStrip} style={{ '--problems': problems.length } as CSSProperties}>
                {problems.map(problem => run.problemId === problem.id
                  ? <span key={problem.id} className={styles.scoreCell} data-status={submissionStatus(run)}
                    aria-label={`${problem.label} · ${resultLabel(run)}`}>{minutes}</span>
                  : <span key={problem.id} className={styles.scoreCell} data-status={!firstToSolve && cells.get(problem.id)?.accepted ? 'previous-solve' : undefined}>{!firstToSolve && cells.get(problem.id)?.accepted ? '' : problem.label}</span>)}
              </div>}
            </div></div>
            <span className={styles.total}>{firstToSolve ? '' : (icpc ? standing?.solved : standing?.score) || ''}</span>
            <span className={styles.penalty}>{firstToSolve ? byProblem.get(run.problemId)?.label : Math.floor((standing?.penaltySeconds ?? 0) / 60) || ''}</span>
          </div>;
        })}
      </div>
    </div>
  </Frame>;
}

function Queue({ data, now, teams }: SceneProps & { teams: ContestLiveBroadcastTeam[] }) {
  const byId = new Map(teams.map(team => [team.id, team]));
  const { submissions, problems, exam } = data.contest;
  const { problemId } = data.settings;
  const byProblem = new Map(problems.map((problem, index) => [problem.id, { problem, index }]));
  const rows = submissions.filter(run => byId.has(run.teamId) && (!problemId || run.problemId === problemId)).slice(0, 10);
  return <Frame caption={presentationNames.queue} data={data} now={now}>
    {!rows.length ? <Empty>Waiting for Submissions</Empty> : <div className={styles.queue} role="table" aria-label={presentationNames.queue}>
      <div className={styles.queueHeader} role="row"><span>Time</span><span>Name</span><span>Problem</span><span>Judgement</span></div>
      {rows.map(run => {
        const team = byId.get(run.teamId)!;
        const problem = byProblem.get(run.problemId);
        const verdict = resultLabel(run);
        return <div className={styles.queueRow} role="row" key={run.id}>
          <span className={styles.queueTime}>{timecode(run.seconds)}</span>
          <div className={styles.teamName}><School team={team} /><span><strong>{team.name}</strong><small>{team.organization}</small></span></div>
          <div className={styles.queueProblem}>{problem ? problemHeader(problem.problem, problem.index) : null}</div>
          <span className={styles.verdict} data-status={submissionStatus(run)} title={team.name === team.organization ? undefined : team.organization}>{verdict}
            {exam.scoring === 'score' && run.score !== null ? ` ${run.score}` : ''}
          </span>
        </div>;
      })}
    </div>}
  </Frame>;
}

function TeamJudgements({ data, teams }: SceneProps & { teams: ContestLiveBroadcastTeam[] }) {
  const { submissions, timeline, problems } = data.contest;
  const { teamId, problemId } = data.settings;
  const byId = new Map(teams.map(team => [team.id, team]));
  const byProblem = new Map(problems.map((problem, index) => [problem.id, { problem, index }]));
  const runs = (teamId
    ? [...new Map([...timeline, ...submissions].map(run => [run.id, run])).values()].sort((a, b) => b.seconds - a.seconds)
    : submissions).filter(run => byId.has(run.teamId) && (!teamId || run.teamId === teamId) && (!problemId || run.problemId === problemId)).slice(0, 21);
  if (!runs.length) return <Empty>Waiting for Submissions</Empty>;
  return <section className={styles.judgementTiles} aria-label={presentationNames.judgeQueue}>
    {runs.map(run => {
      const team = byId.get(run.teamId)!;
      const item = byProblem.get(run.problemId);
      const verdict = resultLabel(run);
      const status = run.frozen ? 'frozen' : !run.verdict ? 'pending' : run.firstBlood ? 'first' : verdict === 'Accepted' ? 'solved' : 'wrong';
      const shade = item ? colorFor(item.problem, item.index) : '#777';
      return <article className={styles.judgementTile} style={{ '--problem-color': shade } as CSSProperties} key={run.id}>
        <strong>{team.name}</strong>
        <School team={team} />
        <span className={styles.scoreCell} aria-label={verdict} data-status={status}>
          {item?.problem.label || ''} – {Math.floor(run.seconds / 60)}
        </span>
      </article>;
    })}
  </section>;
}

function Statistics({ data }: SceneProps) {
  const { problems, statistics, standings } = data.contest;
  const stats = new Map(statistics.map(row => [row.problemId, row]));
  const firstSolve = new Map<string, number>();
  for (const row of standings) for (const cell of row.cells) {
    if (cell.firstBlood) firstSolve.set(cell.problemId, Math.min(firstSolve.get(cell.problemId) ?? Infinity, cell.seconds));
  }
  if (!problems.length) return <Empty>No Problems</Empty>;
  const rows = problems.length >= 12 ? 4 : problems.length >= 9 ? 3 : problems.length >= 4 ? 2 : 1;
  const columns = Math.ceil((problems.length + 1) / rows);
  return <section className={styles.problemSummary} aria-label={presentationNames.statistics}
    style={{ '--summary-rows': rows, '--summary-columns': columns } as CSSProperties}>
      {problems.map((problem, index) => {
        const counts = stats.get(problem.id);
        const attempts = counts ? counts.accepted + counts.rejected + counts.pending : 0;
        const earliest = firstSolve.get(problem.id);
        return <article key={problem.id} className={styles.summaryCard}
          style={{ '--problem-color': colorFor(problem, index), '--card-index': index } as CSSProperties} title={problem.name}>
          <strong>{problem.label}</strong><div><span>{attempts}</span><span>{counts?.teamsAccepted ?? 0}</span><span>{earliest !== undefined ? Math.floor(earliest / 60) : '—'}</span></div>
        </article>;
      })}
      <div className={styles.summaryLegend} style={{ '--card-index': problems.length } as CSSProperties}>
        <span>Attempts</span><span>Solutions</span><span>Fastest Solve</span>
      </div>
  </section>;
}

const illuminatedSegments = ['012345', '12', '01643', '01236', '1256', '05236', '054326', '012', '0123456', '012356'];

function DigitalClock({ value }: { value: string }) {
  return <div className={styles.digital} aria-label={value} style={{ gridTemplateColumns: Array.from(value, digit => digit === ':' ? '.24fr' : '1fr').join(' ') }}>
    {Array.from(value).map((digit, index) => digit === ':'
      ? <span className={styles.digitalColon} key={index} aria-hidden><i /><i /></span>
      : digit === '-' || digit === '+' ? <span className={styles.digitalSign} key={index} data-positive={digit === '+' || undefined} aria-hidden />
      : <span className={styles.digitalDigit} key={index} aria-hidden>{Array.from({ length: 7 }, (_, segment) =>
        <i key={segment} data-segment={segment} data-on={illuminatedSegments[Number(digit)]?.includes(String(segment)) || undefined} />)}</span>)}
  </div>;
}

function Clock({ scene, data, now }: SceneProps) {
  const { startAt, endAt } = data.contest.exam;
  const start = Date.parse(startAt), end = Date.parse(endAt);
  const countdown = scene === 'countdown';
  const local = scene === 'clock';
  const seconds = Math.floor((Math.min(now, end) - start) / 1000);
  const value = local ? clockFormat.format(now) : signedTime(seconds, '+');
  return <section className={styles.clockScene} aria-label={local ? 'Clock' : countdown ? 'Countdown' : 'Contest Clock'}>
    <DigitalClock value={value} />
    {!local && <ContestBanner data={data} className={styles.clockBanner} />}
  </section>;
}

function SingleTeam({ data, team }: { data: ContestDisplayResponse; team?: ContestLiveBroadcastTeam }) {
  const { standings, problems, exam } = data.contest;
  const standing = team && standings.find(row => row.teamId === team.id);
  const icpc = exam.scoring === 'icpc';
  return <section className={`${styles.board} ${styles.singleTeam}`} aria-label={presentationNames.team}>
    {team && standing && <div className={styles.boardRow} data-stripe>
      <span className={styles.rank}>{standing.rank ?? '★'}</span>
      <BoardTeamCell team={team} standing={standing} problems={problems} icpc={icpc} />
      <span className={styles.total}>{(icpc ? standing.solved : standing.score) || ''}</span>
      <span className={styles.penalty}>{icpc ? Math.floor(standing.penaltySeconds / 60) || '' : ''}</span>
    </div>}
  </section>;
}

function Team({ scene, data, elapsed, teams }: SceneProps & { teams: ContestLiveBroadcastTeam[] }) {
  const { teamId, speed, durationSeconds, message } = data.settings;
  const selected = teams.find(team => team.id === teamId);
  if (scene === 'team') return <SingleTeam data={data} team={selected} />;
  if (scene === 'teamDetail') return <TeamDetailSlide data={data} team={selected} />;
  const available = teams.filter(team => team.photoUrl);
  const auto = available[Math.floor(elapsed * speed / (durationSeconds * 1000)) % available.length];
  return <CaptionPhotoSlide photo={teamId ? selected : auto} caption={message} />;
}

function Roster({ scene, data, now, elapsed, teams }: SceneProps & { teams: ContestLiveBroadcastTeam[] }) {
  const schools = [...new Map(teams.filter(team => team.organization).map(team => [team.organization, team])).values()]
    .sort((a, b) => nameCollator.compare(a.organization, b.organization));
  if (scene === 'organizationLogo') {
    const { teamId, speed, durationSeconds } = data.settings;
    const byLogo = schools.filter(team => team.organizationLogoUrl);
    const selectedSchool = teamId ? teams.find(team => team.id === teamId)?.organization : null;
    const school = selectedSchool ? byLogo.find(team => team.organization === selectedSchool) : byLogo[Math.floor(elapsed * speed / (durationSeconds * 1000)) % byLogo.length];
    return <Frame caption={presentationNames.organizationLogo} data={data} now={now}>
      {school ? <div className={styles.logoFocus} key={school.organization}><School team={school} /><strong>{school.organization}</strong></div> : <Empty>No Organization Logos</Empty>}
    </Frame>;
  }
  const schoolMode = scene === 'organizationList';
  const aToZ = schoolMode ? schools : [...teams].sort((a, b) => nameCollator.compare(a.name, b.name));
  const page = scrollPage(aToZ, 20, elapsed, data.settings.speed, data.settings.scroll);
  return <Frame caption={presentationNames[scene]} data={data} now={now}>
    {page.rows.length ? <div className={styles.roster} key={page.page}>
      {page.rows.map(team => <div className={styles.rosterCard} key={schoolMode ? team.organization : team.id}>
        <School team={team} /><div><strong>{schoolMode ? team.organization : team.name}</strong>
          {!schoolMode && team.organization && <small>{team.organization}</small>}</div>
      </div>)}
    </div> : <Empty>{schoolMode ? 'No Organizations' : 'No Teams'}</Empty>}
  </Frame>;
}

function Problem({ data, now, elapsed }: SceneProps) {
  const { problems, statistics } = data.contest;
  const { problemId, durationSeconds, speed } = data.settings;
  const index = problemId ? problems.findIndex(problem => problem.id === problemId) : Math.floor(elapsed * speed / (durationSeconds * 1000)) % problems.length;
  const problem = problems[index];
  const stat = problem && statistics.find(row => row.problemId === problem.id);
  return <Frame caption={presentationNames.problem} data={data} now={now}>
    {!problem ? <Empty>No Problems</Empty> : <div className={styles.problemScene} key={problem.id}>
      <span className={styles.bigProblemLetter} style={{ '--problem-color': colorFor(problem, index) } as CSSProperties}>{problem.label}</span>
      <h1>{problem.name}</h1>
      {stat && <div className={styles.problemTotals}><span>Attempts {stat.accepted + stat.rejected + stat.pending}</span><span>Solutions {stat.accepted}</span><span>Pending {stat.pending}</span></div>}
    </div>}
  </Frame>;
}

function Award({ data, now, elapsed, teams }: SceneProps & { teams: ContestLiveBroadcastTeam[] }) {
  const byId = new Map(teams.map(team => [team.id, team]));
  const available = data.contest.standings.filter(row => row.medal && byId.has(row.teamId));
  const selected = data.settings.teamId ? available.find(row => row.teamId === data.settings.teamId)
    : available[Math.floor(elapsed * data.settings.speed / (data.settings.durationSeconds * 1000)) % available.length];
  const team = selected && byId.get(selected.teamId);
  return <Frame caption={presentationNames.awards} data={data} now={now}>
    {selected?.medal && team ? <div className={styles.award} data-medal={selected.medal} key={team.id}>
      <div className={styles.medal}>{medals[selected.medal]}</div>
      <School team={team} /><strong>{team.name}</strong><span>{team.organization}</span>
    </div> : <Empty>No Awards Yet</Empty>}
  </Frame>;
}

export function DisplayScene(props: SceneProps) {
  const { data, scene } = props;
  const teams = data.settings.group ? data.contest.teams.filter(team => team.group === data.settings.group) : data.contest.teams;
  if (data.contest.exam.beforeStart && (scene.startsWith('scoreboard') || scene.startsWith('problem')
    || scene === 'leaderboard' || scene === 'groupLeaderboard' || scene === 'allGroupsLeaderboard' || scene === 'statistics')) {
    return <Roster {...props} scene="teamList" teams={teams} />;
  }
  if (isChartDisplayScene(scene)) return <DisplayChartScene scene={scene} data={data} elapsed={props.elapsed} />;
  switch (scene) {
    case 'blank': return null;
    case 'scoreboard':
    case 'scoreboardTimeline':
    case 'leaderboard':
    case 'scoreboardMedal':
    case 'groupLeaderboard':
    case 'allGroupsLeaderboard':
      return <Board {...props} teams={teams} />;
    case 'scoreboardJudge':
    case 'scoreboardFirstToSolve':
      return <NativeSubmissionBoard {...props} teams={teams} />;
    case 'scoreboardTiles':
    case 'scoreboardAlphabetical':
    case 'scoreboardRank':
    case 'scoreboardTeam':
      return <ScoreTiles {...props} teams={teams} />;
    case 'queue': return <Queue {...props} teams={teams} />;
    case 'firstToSolve':
      return <FirstSolutionHistoryScene data={data} now={props.now} clocks={scoreboardTimes(data.contest.exam, props.now)} />;
    case 'judgeQueue': return <TeamJudgements {...props} teams={teams} />;
    case 'statistics': return <Statistics {...props} />;
    case 'team':
    case 'teamDetail':
    case 'teamPhoto':
      return <Team {...props} teams={teams} />;
    case 'teamList':
    case 'organizationList':
    case 'organizationLogo':
      return <Roster {...props} teams={teams} />;
    case 'problem': return <Problem {...props} />;
    case 'countdown':
    case 'contestClock':
    case 'clock':
      return <Clock {...props} />;
    case 'awards': return <Award {...props} teams={teams} />;
    case 'problemColors':
    case 'logoWall':
    case 'fadingLogos':
    case 'slidingLogos':
    case 'photoSlideshow':
    case 'polarCountdown':
      return <AdditionalDisplayScene scene={scene} data={data} elapsed={props.elapsed} now={props.now}
        renderClock={value => <DigitalClock value={value} />} />;
    case 'testAlignment':
    case 'testSynchronization':
    case 'testClock':
    case 'testFps':
    case 'testBlueScreen':
      return <DisplayDiagnosticScene scene={scene} data={data} elapsed={props.elapsed} now={props.now}
        renderClock={value => <DigitalClock value={value} />} />;
    case 'logo':
    case 'logoA':
    case 'logoB':
    case 'imageProgression':
    case 'promotions':
    case 'ccs':
    case 'title':
    case 'message':
      return <GraphicSlide scene={scene} data={data} elapsed={props.elapsed} />;
  }
}
