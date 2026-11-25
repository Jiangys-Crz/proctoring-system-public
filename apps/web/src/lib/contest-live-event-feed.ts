import { ccsContestTimeMs, ccsCredential, readNdjson } from './reaction-domain';
import { hydroCcsConnection } from './reaction-hydro-credentials';
import { hydroBrowserTarget } from './hydro-browser';
import { readContestFeedCredential } from './contest-event-feed-settings';
import type { LiveRun, LiveSnapshot } from './contest-live-scoring';

type FeedExam = Parameters<typeof hydroCcsConnection>[0] & { hydroBrowserEventFeedApiKey?: string | null };
type Platform = 'hydro' | 'nova';
type FeedConnection = { platform: Platform; contestId: string; url: string; headers: Record<string, string> };

export class ContestEventFeedError extends Error {}

export function contestEventFeedConnection(exam: FeedExam, platform: Platform): FeedConnection {
  try {
    if (platform === 'hydro') {
      const { base, contestId, apiKey } = hydroCcsConnection(exam);
      return { platform, contestId, url: `${base}/api/ccs/contests/${contestId}/event-feed`, headers: { 'x-ccs-api-key': apiKey } };
    }
    const { origin, authorization } = ccsCredential(exam);
    const contestId = exam.platformContestId;
    if (!/^[1-9]\d*$/.test(contestId)) throw new ContestEventFeedError('请填写有效的 NovaJudge 比赛 ID');
    return { platform, contestId, url: `${origin}/api/ccs/contests/${contestId}/event-feed`, headers: { authorization } };
  } catch (error) {
    if (error instanceof ContestEventFeedError) throw error;
    throw new ContestEventFeedError(platform === 'hydro'
      ? '请配置 HydroOJ CCS Event Feed 站点和未封榜读取密钥'
      : '请配置 NovaJudge CCS Event Feed 站点和授权账号');
  }
}

export async function configuredContestEventFeed(exam: FeedExam, platform: Platform): Promise<FeedConnection | null> {
  // HydroOJ browser exams keep the EventFeed key with the exam. The site and
  // contest ID always come from the exam; there is no separate origin field.
  if (platform === 'hydro' && exam.platform === 'HYDRO_BROWSER') {
    const apiKey = exam.hydroBrowserEventFeedApiKey?.trim();
    if (apiKey) {
      if (!/^[\x21-\x7e]{32,1024}$/.test(apiKey)) throw new ContestEventFeedError('HydroOJ EventFeed 密钥格式不正确');
      const { base, contestId } = hydroBrowserTarget(exam.platformBaseUrl, exam.platformContestId);
      return { platform, contestId, url: `${base}/api/ccs/contests/${contestId}/event-feed`,
        headers: { 'x-ccs-api-key': apiKey } };
    }
  }
  const credential = await readContestFeedCredential(platform);
  const examOrigin = new URL(exam.platformBaseUrl).origin;
  if (credential?.origin === examOrigin) {
    if (credential.platform === 'hydro') {
      const { base, contestId } = hydroBrowserTarget(exam.platformBaseUrl, exam.platformContestId);
      return { platform, contestId, url: `${base}/api/ccs/contests/${contestId}/event-feed`,
        headers: { 'x-ccs-api-key': credential.apiKey } };
    }
    if (!/^[1-9]\d*$/.test(exam.platformContestId)) throw new ContestEventFeedError('请填写有效的 NovaJudge 比赛 ID');
    return { platform, contestId: exam.platformContestId, url: `${examOrigin}/api/ccs/contests/${exam.platformContestId}/event-feed`,
      headers: { authorization: `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString('base64')}` } };
  }
  try {
    return contestEventFeedConnection(exam, platform);
  } catch (error) {
    if (!(error instanceof ContestEventFeedError)) throw error;
    return null;
  }
}

const fields = {
  contests: ['end_time', 'scoreboard_freeze_duration'],
  state: ['frozen', 'thawed'],
  teams: [],
  problems: ['label', 'ordinal', 'name', 'rgb', 'color', 'test_data_count'],
  submissions: ['team_id', 'x_hydro_username', 'problem_id', 'time', 'language_id'],
  judgements: ['submission_id', 'judgement_type_id', 'end_time', 'x_hydro_status'],
  runs: ['judgement_id'],
} as const;
type EntityType = keyof typeof fields;
type FeedEntity = { id: string } & Record<string, unknown>;
type FeedState = { entities: Record<EntityType, Map<string, FeedEntity>>; token: string | null };
const maxEntitiesPerType = 250_000;

function copyFeed(previous?: FeedState): FeedState {
  const existing = previous?.entities;
  return { token: previous?.token ?? null, entities: {
    contests: new Map(existing?.contests), state: new Map(existing?.state), teams: new Map(existing?.teams),
    problems: new Map(existing?.problems), submissions: new Map(existing?.submissions), judgements: new Map(existing?.judgements),
    runs: new Map(existing?.runs),
  } };
}

const string = (value: unknown) => typeof value === 'string' ? value : '';
function date(value: unknown) {
  const time = Date.parse(string(value));
  return Number.isFinite(time) ? new Date(time) : null;
}
function color(value: unknown) {
  const text = string(value);
  return /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(text) || /^[a-z]{1,24}$/i.test(text) ? text : null;
}

const verdicts = new Map<string, [number, string]>([
  ['AC', [1, 'Accepted']], ['WA', [2, 'Wrong Answer']], ['TLE', [3, 'Time Limit Exceeded']],
  ['MLE', [4, 'Memory Limit Exceeded']], ['OLE', [5, 'Output Limit Exceeded']],
  ['RTE', [6, 'Runtime Error']], ['RE', [6, 'Runtime Error']], ['CE', [7, 'Compile Error']],
  ['SE', [8, 'System Error']], ['JE', [8, 'System Error']], ['FAILED', [8, 'System Error']],
  ['HK', [2, 'Wrong Answer']], ['PE', [31, 'Presentation Error']],
]);

function makeRun(submission: FeedEntity, judgement: FeedEntity | undefined, candidateId: string, platform: Platform): LiveRun | null {
  const createdAt = date(submission.time);
  const problemId = string(submission.problem_id);
  if (!createdAt || !problemId) throw new Error('Invalid CCS submission');
  const code = string(judgement?.judgement_type_id);
  const nativeStatus = judgement?.x_hydro_status;
  if (platform === 'hydro' && (nativeStatus === 9 || nativeStatus === 30 || nativeStatus === 31)) return null;
  const [status, verdict] = verdicts.get(code) ?? (code
    ? [2, code]
    : [typeof nativeStatus === 'number' && [20, 21, 22].includes(nativeStatus) ? nativeStatus : 0, 'Waiting']);
  return { id: platform === 'hydro' ? `hydro:${submission.id}` : submission.id,
    candidateId, problemId, status, verdict, score: status === 1 ? 100 : 0,
    createdAt, judgedAt: date(judgement?.end_time), language: string(submission.language_id) };
}

// A CCS run is one completed test case. Keep its ID while judging so updates and
// deletions are idempotent. Finished submissions only need their final verdict.
function pendingTestCounts(entities: FeedState['entities']) {
  const counts = new Map<string, number>();
  for (const [id, test] of entities.runs) {
    const judgementId = string(test.judgement_id);
    if (string(entities.judgements.get(judgementId)?.judgement_type_id)) entities.runs.delete(id);
    else counts.set(judgementId, (counts.get(judgementId) ?? 0) + 1);
  }
  return counts;
}

function snapshotOf(connection: FeedConnection, state: FeedState, accounts: ReadonlyMap<string, string>, capturedAt: Date): LiveSnapshot {
  const { entities } = state;
  const contest = entities.contests.get(connection.contestId);
  if (!contest) throw new Error('CCS feed did not contain the configured contest');
  const hydro = connection.platform === 'hydro';
  const problems = [...entities.problems.values()].sort((a, b) =>
    (typeof a.ordinal === 'number' ? a.ordinal : Number.MAX_SAFE_INTEGER) - (typeof b.ordinal === 'number' ? b.ordinal : Number.MAX_SAFE_INTEGER)
    || string(a.label).localeCompare(string(b.label), 'en', { numeric: true })).map(problem => ({
    id: problem.id, label: string(problem.label) || problem.id, name: string(problem.name) || string(problem.label) || problem.id,
    color: color(problem.rgb) ?? color(problem.color), maxScore: 100, hydroScore: 100,
  }));
  const bySubmission = new Map<string, FeedEntity>();
  for (const judgement of entities.judgements.values()) bySubmission.set(string(judgement.submission_id), judgement);
  const completedTests = pendingTestCounts(entities);
  const runs: LiveRun[] = [];
  for (const submission of entities.submissions.values()) {
    const account = hydro ? string(submission.x_hydro_username) : string(submission.team_id);
    if (!account || (!hydro && !entities.teams.has(account))) continue;
    const candidateId = accounts.get(account);
    if (!candidateId) continue;
    const judgement = bySubmission.get(submission.id);
    const run = makeRun(submission, judgement, candidateId, connection.platform);
    if (!run || run.createdAt > capturedAt) continue;
    const total = entities.problems.get(run.problemId)?.test_data_count;
    if (judgement && !string(judgement.judgement_type_id) && typeof total === 'number' && Number.isSafeInteger(total) && total > 0) {
      run.testedPart = Math.min(completedTests.get(judgement.id) ?? 0, total) / total;
    }
    runs.push(run);
  }

  const contestState = entities.state.get(connection.contestId);
  const duration = ccsContestTimeMs(contest.scoreboard_freeze_duration);
  const end = date(contest.end_time);
  const remoteFreeze = hydro && !date(contestState?.thawed)
    ? date(contestState?.frozen) ?? (duration && end ? new Date(+end - duration) : null)
    : null;
  return { capturedAt, rule: 'XCPC', problems, runs, remoteFrozenAt: remoteFreeze?.toISOString() ?? null };
}

export async function readContestEventFeed(connection: FeedConnection, accounts: ReadonlyMap<string, string>, capturedAt: Date,
  signal: AbortSignal, previous?: FeedState) {
  const hydro = connection.platform === 'hydro';
  const label = hydro ? 'HydroOJ' : 'NovaJudge';
  const query = new URLSearchParams({ stream: 'false' });
  // A cursor cached by the verdict-only reader has no test-case baseline.
  if (hydro && previous?.entities.runs && previous.token) query.set('since_token', previous.token);
  const request = () => fetch(`${connection.url}?${query}`, {
    headers: { accept: 'application/x-ndjson', ...connection.headers },
    cache: 'no-store', credentials: 'omit', redirect: 'error', signal,
  });
  let response = await request();
  if (response.status === 400 && query.has('since_token')) {
    await response.body?.cancel();
    query.delete('since_token');
    previous = undefined;
    response = await request();
  }
  if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('application/x-ndjson')) {
    await response.body?.cancel();
    throw new ContestEventFeedError(`${label} CCS Event Feed 读取失败（HTTP ${response.status}），请检查比赛、授权及接口配置`);
  }
  // Commit the cursor and object maps only after the complete response has been read.
  const next = copyFeed(query.has('since_token') ? previous : undefined);
  for await (const event of readNdjson(response.body)) {
    signal.throwIfAborted();
    if (!event || typeof event.type !== 'string') throw new Error('Invalid CCS event');
    if (hydro) {
      if (typeof event.token !== 'string' || !/^[a-f\d]{24}\.[1-9]\d*\.\d+$/.test(event.token)) throw new Error('Invalid Hydro CCS token');
      next.token = event.token;
    }
    const type = event.type === 'contest' ? 'contests' : event.type;
    if (!Object.hasOwn(fields, type) || (hydro && type === 'teams')) continue;
    const data = event.data;
    // Hydro state is a singleton. Its outer event ID may be null.
    const singleton = type === 'contests' || type === 'state';
    const id = string(event.id) || string(data?.id) || (singleton ? connection.contestId : '');
    if (!id || (singleton && id !== connection.contestId)) throw new Error('Unexpected CCS entity ID');
    const collection = next.entities[type as EntityType];
    // A feed batch can contain both the final verdict and a fresh attempt with
    // the same judgement ID. Discard its old cases before reopening it.
    if (type === 'judgements' && string(collection.get(id)?.judgement_type_id) && !string(data?.judgement_type_id)) {
      pendingTestCounts(next.entities);
    }
    if (data === null || event.op === 'delete') {
      collection.delete(id);
      continue;
    }
    if (!data || Array.isArray(data) || typeof data !== 'object' || (data.id != null && data.id !== id)) throw new Error('Invalid CCS entity');
    if (type === 'runs' && (!string(data.judgement_id) || !string(data.judgement_type_id)
      || string(next.entities.judgements.get(string(data.judgement_id))?.judgement_type_id))) {
      collection.delete(id);
      continue;
    }
    const entity: FeedEntity = { id };
    for (const field of fields[type as EntityType]) {
      const value = data[field];
      if (value === null || typeof value === 'number' || (typeof value === 'string' && value.length <= 4096)) entity[field] = value;
    }
    collection.set(id, entity);
    if (collection.size > maxEntitiesPerType) {
      if (type === 'runs') pendingTestCounts(next.entities);
      if (collection.size > maxEntitiesPerType) throw new Error('CCS feed exceeded the entity limit');
    }
  }
  return { snapshot: snapshotOf(connection, next, accounts, capturedAt), hydroState: hydro ? next : undefined };
}
