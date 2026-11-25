import { hydroBrowserTarget } from './hydro-browser';
import { reactionSource } from './reaction-source';

type CcsExam = { id: string; platform: string; platformBaseUrl: string; platformContestId: string };

/** The standalone CCS read key is independent of judging and broadcast credentials. */
export function hydroCcsConnection(exam: CcsExam, env: Record<string, string | undefined> = process.env) {
  try {
    if (reactionSource(exam) !== 'HYDRO_CONTEST') throw new Error();
    const overrides: unknown = JSON.parse(env.REACTION_HYDRO_CCS_CREDENTIALS || '{}');
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new Error();
    const entry = Object.hasOwn(overrides, exam.id)
      ? (overrides as Record<string, unknown>)[exam.id]
      : { origin: env.REACTION_HYDRO_CCS_ORIGIN, apiKey: env.REACTION_HYDRO_CCS_API_KEY };
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error();
    const { origin, apiKey } = entry as Record<string, unknown>;
    const target = hydroBrowserTarget(exam.platformBaseUrl, exam.platformContestId);
    if (origin !== target.origin || typeof apiKey !== 'string' || !/^[\x21-\x7e]{32,1024}$/.test(apiKey)) throw new Error();
    return { base: target.base, contestId: target.contestId, apiKey };
  } catch {
    // Never expose credentials, URLs or remote diagnostic bodies in admin errors.
    throw new Error('REACTION_HYDRO_CCS_CONFIGURATION');
  }
}
