import type { CcsEvent } from './reaction-domain';
import { hydroReactionConnection } from './reaction-source';

export type HydroReactionRecord = {
  id: string;
  username: string;
  problemId: string;
  problemLabel: string;
  status: number;
  createdAt: string;
  judgeAt: string | null;
};
export type HydroReactionPage = { contestId: string; records: HydroReactionRecord[]; nextAfter: string | null };

// Hydro's running states (20+) must never end the capture window. A cancelled
// submission (9) is terminal; ignored records (30) are handled as deletions.
export function hydroReactionVerdict(status: number) {
  return ({ 1: 'AC', 2: 'WA', 3: 'TLE', 4: 'MLE', 5: 'OLE', 6: 'RTE', 7: 'CE', 8: 'SE', 9: 'NO', 10: 'FAILED', 11: 'HK', 31: 'FE' } as Record<number, string>)[status] || null;
}

export function hydroReactionEvents(record: HydroReactionRecord): CcsEvent[] {
  if (!record.id || !record.username || !record.problemId || !Number.isFinite(Date.parse(record.createdAt))) throw new Error('REACTION_HYDRO_INVALID_RECORD');
  if (record.status === 30) return [{ type: 'submissions', op: 'delete', data: { id: record.id } }];
  return [
    { type: 'problems', data: { id: record.problemId, label: record.problemLabel } },
    { type: 'submissions', data: { id: record.id, team_id: record.username, problem_id: record.problemId, time: record.createdAt } },
    { type: 'judgements', data: { id: `hydro-${record.id}`, submission_id: record.id, judgement_type_id: hydroReactionVerdict(record.status), end_time: record.judgeAt } },
  ];
}

export async function fetchHydroReactionPage(
  exam: { platform: string; platformBaseUrl: string; platformContestId: string; hydroBrowserApiKey?: string | null },
  connection: { baseUrl: string; apiKey: string },
  since: Date, after: string | null, signal: AbortSignal,
): Promise<HydroReactionPage> {
  const { base, apiKey } = hydroReactionConnection(exam, connection);
  const response = await fetch(`${base}/api/proctor/reaction-contest/${encodeURIComponent(exam.platformContestId)}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-proctor-api-key': apiKey },
    body: JSON.stringify({ since: since.toISOString(), after }), cache: 'no-store', redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`HYDRO_HTTP_${response.status}`); }
  const result = await response.json();
  const data = result?.data;
  if (!result?.ok || data?.contestId !== exam.platformContestId.toLowerCase() || !Array.isArray(data.records) || data.records.length > 200
    || !(data.nextAfter === null || (typeof data.nextAfter === 'string' && /^[a-f\d]{24}$/.test(data.nextAfter) && (!after || data.nextAfter > after)))) {
    throw new Error('REACTION_HYDRO_INVALID_RECORD');
  }
  let previousId = after || '';
  for (const row of data.records) {
    if (!row || !/^[a-f\d]{24}$/.test(row.id) || typeof row.username !== 'string' || !row.username || typeof row.problemId !== 'string'
      || typeof row.problemLabel !== 'string' || !Number.isInteger(row.status) || typeof row.createdAt !== 'string' || !Number.isFinite(Date.parse(row.createdAt))
      || row.id <= previousId || !(row.judgeAt === null || (typeof row.judgeAt === 'string' && Number.isFinite(Date.parse(row.judgeAt))))) throw new Error('REACTION_HYDRO_INVALID_RECORD');
    previousId = row.id;
  }
  if (data.nextAfter !== null && (!data.records.length || data.nextAfter !== previousId)) throw new Error('REACTION_HYDRO_INVALID_RECORD');
  return data;
}
