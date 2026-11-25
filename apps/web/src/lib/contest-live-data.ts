import { createHash } from 'node:crypto';
import type { Exam, Prisma } from '@prisma/client';
import type { ContestDisplayChartScene } from './contest-display-contract';
import { prisma } from './db';
import { AuthError } from './auth';
import { getHydroSettings } from './settings';
import { HydroBoardError, readHydroBoardPage, type HydroBoardRunMetadata } from './hydro-board';
import { readNovaJudgeBoard } from './novajudge-board';
import { ContestEventFeedError, configuredContestEventFeed, readContestEventFeed } from './contest-live-event-feed';
import { hydroStatusText } from './hydro-status';
import { IGNORED_SUBMISSION_STATUS, problemLabel } from './contest-rules';
import { isContestLiveSupported, type ContestLiveFreeze, type ContestLiveScoreboardVersion } from './contest-live-contract';
import { contestLivePresentation, liveRoster, type LiveRun, type LiveSnapshot, type LiveSource } from './contest-live-scoring';
import { readContestLiveSettings } from './contest-live-settings';

const sourceOf = (platform: Exam['platform']): LiveSource =>
  platform === 'HYDRO_BROWSER' ? 'hydro' : platform === 'NOVAJUDGE' ? 'nova' : 'local';

const statuses = new Map([
  ['Accepted', 1], ['Wrong Answer', 2], ['Time Limit Exceeded', 3], ['Memory Limit Exceeded', 4],
  ['Output Limit Exceeded', 5], ['Runtime Error', 6], ['Compile Error', 7], ['System Error', 8],
  ['Presentation Error', 31], ['Queueing', 20], ['Judging', 21], ['Compiling', 22], ['Waiting', 0],
  ['Cancelled', 30], ['Canceled', 30], ['AC', 1], ['WA', 2], ['TLE', 3], ['MLE', 4], ['OLE', 5], ['RE', 6], ['CE', 7],
  ['PE', 31],
]);

function statusAndVerdict(raw: string, status?: number) {
  const verdict = statuses.has(raw) ? raw : hydroStatusText(raw, status);
  return { verdict, status: status ?? statuses.get(verdict) ?? 2 };
}

async function localSnapshot(exam: Exam, capturedAt: Date): Promise<LiveSnapshot> {
  const [problems, runs] = await prisma.$transaction([
    prisma.examProblem.findMany({ where: { examId: exam.id, sourceDeleted: false }, orderBy: { order: 'asc' },
      select: { id: true, order: true, label: true, title: true, score: true, hydroScore: true, problemType: true } }),
    prisma.contestSubmission.findMany({ where: { examId: exam.id, status: { not: IGNORED_SUBMISSION_STATUS },
      createdAt: { gte: exam.startAt, lt: exam.endAt, lte: capturedAt } },
      select: { id: true, candidateId: true, problemId: true, status: true, statusText: true, score: true, manualScore: true, createdAt: true,
        lang: true, judgeAt: true } }),
  ], { isolationLevel: 'RepeatableRead' });
  return { capturedAt, problems: problems.map(problem => ({
    id: problem.id, label: problem.label || problemLabel(problem.order), name: problem.title,
    color: null, maxScore: problem.score, hydroScore: problem.hydroScore, objective: problem.problemType === 'objective',
  })), runs: runs.map(({ statusText, lang, judgeAt, ...run }) => ({ ...run, language: lang, judgedAt: judgeAt, ...statusAndVerdict(statusText || '', run.status) })) };
}

async function novaSnapshot(exam: Exam, accounts: Map<string, string>, capturedAt: Date, signal: AbortSignal): Promise<LiveSnapshot> {
  const board = await readNovaJudgeBoard(exam, signal, new Set(accounts.keys()), capturedAt, true);
  return { capturedAt, rule: 'XCPC', problems: board.problems.map(problem => ({
    id: problem.display_id, label: problem.display_id, name: problem.title, maxScore: problem.score, hydroScore: 100, color: null,
  })), runs: board.records.map(({ payload: run, broadcastSubmittedAt }) => ({
    id: run.rid, candidateId: accounts.get(run.username)!, problemId: run.problem, score: run.score, language: run.language,
    createdAt: broadcastSubmittedAt!, ...statusAndVerdict(run.status),
  })) };
}

function hydroResult(row: Pick<HydroBoardRunMetadata, 'status' | 'score' | 'language' | 'judgedAt'>, acm: boolean) {
  if ([9, 30].includes(row.status) || (acm && row.status === 31)) return null;
  const status = row.status === 10 ? 8 : row.status === 11 ? 2 : row.status;
  return { score: row.score, language: row.language, judgedAt: row.judgedAt ? new Date(row.judgedAt) : null,
    ...statusAndVerdict(status === 31 ? 'Presentation Error' : '', status) };
}

async function revealHydroExport(exam: Exam, connection: Awaited<ReturnType<typeof getHydroSettings>>, accounts: Map<string, string>,
  capturedAt: Date, signal: AbortSignal, frozenAt: string, runs: LiveRun[], acm: boolean) {
  const lock = new Date(frozenAt);
  const matchingRuns = new Map(runs.filter(run => run.createdAt > lock).map(run => [run.id, run]));
  if (!matchingRuns.size) return runs;
  const source = { ...exam, startAt: +lock > +exam.startAt ? lock : exam.startAt };
  const usernames = new Set(accounts.keys());
  const results = new Map<string, ReturnType<typeof hydroResult>>();
  let after: string | null = null;
  do {
    const page = await readHydroBoardPage(source, connection, { after, until: capturedAt }, usernames, signal, 'export-metadata');
    for (const row of page.submissionMetadata ?? []) {
      const original = matchingRuns.get(`hydro:${row.id}`);
      if (original && original.candidateId === accounts.get(row.username) && original.problemId === row.problemId
        && +original.createdAt === Date.parse(row.createdAt)) results.set(original.id, hydroResult(row, acm));
    }
    after = page.nextAfter;
  } while (after !== null && results.size < matchingRuns.size);
  if (results.size !== matchingRuns.size) return null;
  return runs.flatMap(run => {
    const result = results.get(run.id);
    return result === null ? [] : [result ? { ...run, ...result } : run];
  });
}

async function hydroSnapshot(exam: Exam, connection: Awaited<ReturnType<typeof getHydroSettings>>, accounts: Map<string, string>,
  capturedAt: Date, signal: AbortSignal, revealed: boolean): Promise<LiveSnapshot> {
  const usernames = new Set(accounts.keys());
  const runs: LiveRun[] = [];
  let cursor = { after: null as string | null, until: capturedAt };
  let firstPage: NonNullable<Awaited<ReturnType<typeof readHydroBoardPage>>['broadcastPage']> | undefined;
  let boardDefinition: string | undefined;
  do {
    const { broadcastPage: page, nextAfter } = await readHydroBoardPage(exam, connection, cursor, usernames, signal,
      revealed ? 'revealed-broadcast' : 'broadcast');
    if (!page?.broadcast) throw new HydroBoardError('HydroOJ 监考插件需要更新才能读取直播封榜状态');
    const definition = JSON.stringify([page.rule, page.broadcast, page.problems]);
    if (boardDefinition !== undefined && definition !== boardDefinition) throw new HydroBoardError('HydroOJ 比赛设置刚刚变更，正在重新读取');
    if (!firstPage) { firstPage = page; boardDefinition = definition; }
    for (const run of page.records) {
      const candidateId = accounts.get(run.username);
      if (!candidateId) continue;
      const result = hydroResult(run, page.rule === 'acm');
      if (result) runs.push({ id: `hydro:${run.id}`, candidateId, problemId: run.problemId, createdAt: new Date(run.createdAt), ...result });
    }
    cursor = { ...cursor, after: nextAfter };
  } while (cursor.after !== null);
  const page = firstPage!;
  const nativeFrozenAt = page.broadcast!.frozenAt;
  // Older plugins still support the API-key-protected export. Join its verdicts
  // only onto records already admitted by the broadcast's roster filter.
  const revealedRuns = revealed && nativeFrozenAt
    ? await revealHydroExport(exam, connection, accounts, capturedAt, signal, nativeFrozenAt, runs, page.rule === 'acm').catch(() => null)
    : null;
  const rule = page.rule === 'acm' ? 'XCPC' : page.rule === 'oi' ? 'OI' : 'IOI';
  return { capturedAt, rule, remoteFrozenAt: revealedRuns ? null : nativeFrozenAt, runs: revealedRuns ?? runs, problems: page.problems.map(problem => ({
    id: problem.id, label: problem.label, name: problem.title, color: problem.color ?? null,
    maxScore: problem.score, hydroScore: problem.hydroScore,
  })) };
}

type ReadResult = { eventFeed?: boolean; snapshot: LiveSnapshot | null; sourceError: string | null };
type CacheEntry = ReadResult & { hydroState?: Awaited<ReturnType<typeof readContestEventFeed>>['hydroState']; key: string; expiresAt: number; lastReadAt: number; pending?: Promise<ReadResult> };
const runtime = globalThis as typeof globalThis & { contestLiveFeedCache?: Map<string, CacheEntry> };
const cache = runtime.contestLiveFeedCache ??= new Map();
const broadcastCandidates = { orderBy: { id: 'asc' }, select: {
  id: true, examNumber: true, hydroAccount: true, name: true, teamName: true, groupName: true, school: true,
  college: true, ranked: true, gender: true, teamMembers: true, memberOrder: true, isTeamLeader: true,
} } as const;
const broadcastRosterFields = { candidates: broadcastCandidates, contestLiveSettings: { select: { settings: true } } } as const;
const revisionFields = { updatedAt: true, reactionLogoMatchBy: true, ...broadcastRosterFields } as const;
type BroadcastRoster = Prisma.ExamGetPayload<{ select: typeof revisionFields }>;

function sourceRevision(exam: BroadcastRoster, teamNameTemplate: string) {
  return createHash('sha256').update(JSON.stringify([exam.updatedAt, exam.candidates, exam.reactionLogoMatchBy, teamNameTemplate])).digest('hex');
}

export async function contestLiveSourceUnchanged(examId: string, revision: string) {
  const current = await prisma.exam.findUnique({ where: { id: examId }, select: revisionFields });
  return !!current && sourceRevision(current, readContestLiveSettings(current.contestLiveSettings?.settings).teamNameTemplate) === revision;
}

async function readSnapshot(exam: Exam, source: LiveSource, accounts: Map<string, string>, freeze?: ContestLiveFreeze): Promise<ReadResult> {
  let connection: Awaited<ReturnType<typeof configuredContestEventFeed>> = null;
  try { connection = source === 'local' ? null : await configuredContestEventFeed(exam, source); }
  catch (error) {
    if (error instanceof ContestEventFeedError || error instanceof AuthError) return { snapshot: null, sourceError: error.message };
    throw error;
  }
  const time = Date.now();
  const hydro = source === 'hydro' && !connection ? await getHydroSettings() : null;
  const legacyRevealed = !!hydro && !!freeze?.revealed && !!freeze.at && Date.parse(freeze.at) <= time;
  const cacheId = legacyRevealed ? `${exam.id}:legacy-revealed` : exam.id;
  const key = createHash('sha256').update(JSON.stringify([source, exam.startAt, exam.endAt, connection, hydro,
    exam.platformBaseUrl, exam.platformContestId, ...(connection ? [] : [exam.novaJudgeApiKey, exam.novaJudgeTimezone, exam.hydroBrowserApiKey, exam.hydroBrowserEventFeedApiKey]),
    ...(source === 'local' ? [] : [...accounts].sort())])).digest('hex');
  const previous = cache.get(cacheId);
  if (previous?.key === key) {
    previous.lastReadAt = time;
    if (previous.pending) return previous.pending;
    if (previous.expiresAt > time) return previous;
  }
  for (const [id, item] of cache) if (!item.pending && time - item.lastReadAt > 60_000) cache.delete(id);
  const entries = [...cache.values()];
  if (entries.filter(item => item.pending).length >= 6) {
    return { snapshot: previous?.key === key ? previous.snapshot : null, sourceError: '直播数据正在排队，请稍候' };
  }
  const allowedPrevious = previous?.key === key ? previous : null;
  const entry: CacheEntry = { key, eventFeed: !!connection, expiresAt: time, lastReadAt: time, snapshot: allowedPrevious?.snapshot ?? null, sourceError: null };
  const now = new Date(time);
  let refreshMs = source === 'local' ? 2_000 : 5_000;
  if (connection && now >= exam.startAt && now < exam.endAt) {
    // Hydro resumes from its cursor. NovaJudge sends a fresh contest snapshot.
    refreshMs = source === 'hydro' ? 1_000 : 2_000;
  }
  const signal = AbortSignal.timeout(45_000);
  // Existing competitions can keep broadcasting while their administrator
  // provisions CCS. A configured feed error never switches to the old source.
  const legacy = () => source === 'nova' ? novaSnapshot(exam, accounts, now, signal)
    : hydro ? hydroSnapshot(exam, hydro, accounts, now, signal, legacyRevealed) : localSnapshot(exam, now);
  const load = connection ? readContestEventFeed(connection, accounts, now, signal, allowedPrevious?.hydroState)
    : legacy().then(snapshot => ({ snapshot, hydroState: undefined }));
  entry.hydroState = allowedPrevious?.hydroState;
  entry.pending = load.then(({ snapshot, hydroState }) => {
    entry.snapshot = snapshot;
    entry.hydroState = hydroState;
  }).catch(error => {
    entry.sourceError = error instanceof ContestEventFeedError || error instanceof HydroBoardError
      || (!connection && source === 'nova' && error instanceof Error && /^(NovaJudge|读取 NovaJudge|请填写 NovaJudge)/.test(error.message))
      ? error.message : '无法更新直播数据，系统将重试';
  }).then(() => {
    delete entry.pending;
    entry.expiresAt = Date.now() + (entry.sourceError ? 10_000 : refreshMs);
    const result = { snapshot: entry.snapshot, sourceError: entry.sourceError, eventFeed: entry.eventFeed };
    if (cache.get(cacheId) === entry && (entry.snapshot?.runs.length ?? 0) > 100_000) cache.delete(cacheId);
    return result;
  });
  if (cache.size >= 32 && !previous) {
    const oldest = [...cache].filter(([, item]) => !item.pending).sort(([, a], [, b]) => a.lastReadAt - b.lastReadAt)[0];
    if (oldest) cache.delete(oldest[0]);
  }
  cache.set(cacheId, entry);
  return entry.pending;
}

export async function readContestLiveRoster(examId: string, db: Pick<Prisma.TransactionClient, 'exam'> = prisma) {
  const exam = await db.exam.findUnique({ where: { id: examId }, include: broadcastRosterFields });
  if (!exam || !isContestLiveSupported(exam.platform, exam.contestRule)) return null;
  const source = sourceOf(exam.platform);
  const { teamNameTemplate } = readContestLiveSettings(exam.contestLiveSettings?.settings);
  const roster = liveRoster(exam, exam.candidates, source, teamNameTemplate);
  return { exam, source, roster, teamNameTemplate };
}

export async function readContestLiveData(examId: string, timelineTeamIds: string[] | 'all' = [], scoreboardVersion: ContestLiveScoreboardVersion = 'normal',
  manualFreeze?: ContestLiveFreeze, chartScenes?: readonly ContestDisplayChartScene[]) {
  const result = await readContestLiveRoster(examId);
  if (!result) return null;
  const { exam, source, roster } = result;
  const accounts = new Map(exam.candidates.map(candidate => [candidate.examNumber, candidate.id]));
  const { snapshot, sourceError, eventFeed } = await readSnapshot(exam, source, accounts, manualFreeze);
  const now = new Date();
  const revealed = eventFeed && source === 'hydro' && manualFreeze?.revealed && manualFreeze.at && Date.parse(manualFreeze.at) <= +now;
  const visibleSnapshot = snapshot && revealed ? { ...snapshot, remoteFrozenAt: null } : snapshot;
  const data = contestLivePresentation(exam, source, roster, visibleSnapshot, sourceError, now, timelineTeamIds, scoreboardVersion, manualFreeze, chartScenes);
  return { data, sourceRevision: sourceRevision(exam, result.teamNameTemplate) };
}
