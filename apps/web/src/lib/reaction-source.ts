import { hydroBrowserConnection, trustedHydroBrowserTarget } from './hydro-browser';

type SourceExam = { platform: string; platformBaseUrl: string; platformContestId: string; hydroBrowserApiKey?: string | null };
export const supportsReaction = (platform: string) => ['NOVAJUDGE', 'HYDRO', 'HYDRO_BROWSER'].includes(platform);

export function reactionSource(exam: Pick<SourceExam, 'platform' | 'platformContestId'>) {
  if (exam.platform === 'NOVAJUDGE') return 'NOVAJUDGE_CCS';
  if (exam.platform === 'HYDRO_BROWSER' || (exam.platform === 'HYDRO' && /^[a-f\d]{24}$/i.test(exam.platformContestId))) return 'HYDRO_CONTEST';
  if (exam.platform === 'HYDRO') return 'LOCAL_HYDRO';
  throw new Error('REACTION_PLATFORM_UNSUPPORTED');
}

/** Domain paths are part of a Hydro contest's identity. Never mix their records. */
export function sameReactionSource(left: SourceExam, right: SourceExam) {
  const base = (exam: SourceExam) => {
    if (reactionSource(exam) === 'LOCAL_HYDRO') return exam.platformBaseUrl.replace(/\/+$/, '');
    const url = new URL(exam.platformBaseUrl);
    return url.origin + (exam.platform === 'NOVAJUDGE' ? '' : url.pathname.replace(/\/+$/, ''));
  };
  return left.platform === right.platform && left.platformContestId === right.platformContestId && base(left) === base(right);
}

export function hydroReactionConnection(exam: SourceExam, connection: { baseUrl: string; apiKey: string }) {
  try {
    if (reactionSource(exam) === 'HYDRO_CONTEST') {
      connection = hydroBrowserConnection(exam, connection);
      if (!connection.apiKey) throw new Error();
      return { ...trustedHydroBrowserTarget(exam, connection.baseUrl), apiKey: connection.apiKey };
    }
    if (!connection.apiKey) throw new Error();
    const url = new URL(connection.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
    return { base: url.origin, apiKey: connection.apiKey };
  } catch { throw new Error('REACTION_HYDRO_CONFIGURATION'); }
}
