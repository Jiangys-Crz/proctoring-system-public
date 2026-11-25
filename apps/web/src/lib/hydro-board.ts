import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Exam } from '@prisma/client';
import { hydroBrowserConnection, trustedHydroBrowserTarget } from './hydro-browser';
import { hydroStatusText } from './hydro-status';

export class HydroBoardError extends Error {}
const id = z.string().regex(/^[a-f\d]{24}$/);
const number = z.number().finite().nonnegative();
const pageSchema = z.object({
  contestId: id, rule: z.enum(['acm', 'oi', 'ioi', 'strictioi']),
  broadcast: z.object({ frozenAt: z.string().datetime().nullable() }).optional(),
  problems: z.array(z.object({ id: z.string().min(1), label: z.string().min(1).max(6), title: z.string().min(1),
    score: number, hydroScore: number.positive(), timeLimitMs: number, memoryLimitMb: number,
    color: z.string().regex(/^#(?:[a-f\d]{3}|[a-f\d]{6})$/i).nullable().optional() })),
  records: z.array(z.object({ id, username: z.string().min(1), problemId: z.string().min(1), status: z.number().int(),
    score: number, language: z.string(), code: z.string(), runtime: number, memory: number, createdAt: z.string().datetime(),
    judgedAt: z.iso.datetime().nullable().optional() })).max(250),
  nextAfter: id.nullable(),
});
type HydroBoardRun = z.infer<typeof pageSchema>['records'][number];
export type HydroBoardRunMetadata = Pick<HydroBoardRun, 'id' | 'username' | 'problemId' | 'status' | 'score' | 'createdAt' | 'language' | 'judgedAt'>;
type SourceExam = Pick<Exam, 'id' | 'platformBaseUrl' | 'platformContestId' | 'startAt' | 'endAt'> & Partial<Pick<Exam, 'hydroBrowserApiKey'>>;

async function readPage(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new HydroBoardError('HydroOJ 外榜返回了空响应');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 5_000_000) throw new HydroBoardError('HydroOJ 外榜单页数据过大，请检查插件和代码大小');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof HydroBoardError) throw error;
    throw new HydroBoardError('读取 HydroOJ 外榜数据失败或格式无效');
  } finally { reader.releaseLock(); }
}

export async function readHydroBoardPage(exam: SourceExam, connection: { baseUrl: string; apiKey: string },
  cursor: { after: string | null; until: Date }, usernames: Set<string>, signal: AbortSignal,
  mode: 'export' | 'export-metadata' | 'broadcast' | 'revealed-broadcast' = 'export') {
  const broadcast = mode === 'broadcast' || mode === 'revealed-broadcast';
  let target: ReturnType<typeof trustedHydroBrowserTarget>;
  try { connection = hydroBrowserConnection(exam, connection); target = trustedHydroBrowserTarget(exam, connection.baseUrl); }
  catch { throw new HydroBoardError('HydroOJ 外榜来源无效；使用其他站点时须填写本场插件 API-Key，未填写时须与评测服务使用同一站点'); }
  if (!connection.apiKey) throw new HydroBoardError('请先在系统设置中配置 HydroOJ 评测 API-Key');
  let response: Response;
  try {
    response = await fetch(`${target.base}/api/proctor/board-contest/${target.contestId}`, {
      method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-proctor-api-key': connection.apiKey },
      body: JSON.stringify({ since: exam.startAt.toISOString(), until: cursor.until.toISOString(), after: cursor.after, usernames: [...usernames],
        ...(broadcast ? { broadcast: true, statistics: true } : {}),
        ...(mode === 'revealed-broadcast' ? { reveal: true } : {}) }),
    });
  } catch { throw new HydroBoardError('读取 HydroOJ 外榜记录失败或超时'); }
  if (!response.ok) {
    await response.body?.cancel();
    throw new HydroBoardError(response.status === 404 ? 'HydroOJ 比赛不存在或插件未更新，请部署 0.3.1 及以上版本'
      : response.status === 400 ? 'HydroOJ 外榜来源不支持该配置，请检查固定时间赛制和同步时间范围'
        : [401, 403].includes(response.status) ? 'HydroOJ 拒绝读取外榜记录，请检查评测 API-Key' : '读取 HydroOJ 外榜记录失败，请检查服务状态');
  }
  const result = await readPage(response);
  const parsed = pageSchema.safeParse(result?.ok ? result.data : null);
  if (!parsed.success || parsed.data.contestId !== target.contestId) throw new HydroBoardError('HydroOJ 外榜数据格式或比赛标识不匹配');
  const page = parsed.data;
  if (!broadcast && page.records.length > 50) throw new HydroBoardError('HydroOJ 外榜单页记录过多');
  const unique = (values: string[]) => new Set(values).size === values.length;
  if (!unique(page.problems.map(row => row.id)) || !unique(page.problems.map(row => row.label))) throw new HydroBoardError('HydroOJ 外榜题目 ID 或题号重复');
  let previous = cursor.after || '';
  for (const row of page.records) {
    if (row.id <= previous || (page.nextAfter && row.id > page.nextAfter)) throw new HydroBoardError('HydroOJ 外榜分页顺序无效');
    previous = row.id;
  }
  if (page.nextAfter && page.nextAfter <= (cursor.after || '')) throw new HydroBoardError('HydroOJ 外榜分页未前进');
  const problems = page.problems.map(row => ({ display_id: row.label, title: row.title, score: row.score,
    time_limit: Math.round(row.timeLimitMs), memory_limit: Math.round(row.memoryLimitMb) }));
  const inScope = (row: HydroBoardRun) => usernames.has(row.username) && +new Date(row.createdAt) >= +exam.startAt
    && +new Date(row.createdAt) < Math.min(+exam.endAt, +cursor.until);
  if (mode === 'export-metadata') {
    const submissionMetadata: HydroBoardRunMetadata[] = page.records.filter(inScope).map(({ id, username, problemId, status, score, createdAt, language, judgedAt }) =>
      ({ id, username, problemId, status, score, createdAt, language, ...(judgedAt !== undefined && { judgedAt }) }));
    return { problems, records: [], nextAfter: page.nextAfter, broadcastPage: undefined, submissionMetadata };
  }
  const byId = new Map(page.problems.map(row => [row.id, row]));
  const namespace = createHash('sha256').update(`${target.base}/contest/${target.contestId}`).digest('hex').slice(0, 16);
  const records = page.records.filter(row => inScope(row) && !(row.status === 0 || (row.status >= 20 && row.status < 30))).map(row => {
    const problem = byId.get(row.problemId);
    if (!problem) throw new HydroBoardError('HydroOJ 提交记录的题目不属于本场比赛');
    if (!((row.status >= 1 && row.status <= 11) || [30, 31].includes(row.status))) throw new HydroBoardError('HydroOJ 提交记录包含未知判题状态');
    // Hydro ACM excludes cancellation/format errors from wrong-attempt penalty.
    // The receiver has no delete/FE-neutral API, so use its existing CE/0 reset.
    const neutral = [9, 30].includes(row.status) || (page.rule === 'acm' && row.status === 31);
    const status = neutral ? 'Compile Error' : row.status === 10 ? 'System Error' : row.status === 11 ? 'Wrong Answer'
      : row.status === 31 ? 'Presentation Error' : hydroStatusText(null, row.status);
    const score = neutral ? 0 : page.rule === 'acm' ? row.status === 1 ? 100 : 0
      : Math.round(Math.max(0, Math.min(100, row.score * 100 / problem.hydroScore)));
    return { remoteId: `hydro:${row.id}`, payload: {
      rid: `hydro:${exam.id}:${namespace}:${row.id}`, username: row.username, problem: problem.label, status, score,
      ...(page.rule !== 'acm' ? { raw_score: neutral ? 0 : row.score, raw_max_score: problem.hydroScore } : {}),
      language: row.language, code: row.code, runtime: String(Math.round(row.runtime)), memory: String(Math.round(row.memory)),
      submit_time: new Date(+new Date(row.createdAt) + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' '),
    } };
  });
  return { problems, records, nextAfter: page.nextAfter, broadcastPage: broadcast && page.broadcast ? page : undefined, submissionMetadata: undefined };
}
