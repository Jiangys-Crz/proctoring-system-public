import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { AuthError, getCurrentUser, requireUser } from './auth';
import { prisma } from './db';
import { canManageExam } from './permissions';
import { readContestLiveConfig } from './contest-live-settings';
import { isContestLiveSupported } from './contest-live-contract';

export const contestLiveHeaders = {
  'cache-control': 'private, no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

export const publicContestLiveAccess = 'public';

export function digestContestLiveValue(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

export function normalizeContestLiveAccount(value: string) {
  return value.trim();
}

export function makeContestLiveObsKey() {
  return randomBytes(32).toString('base64url');
}

export function contestLiveCredentialMatches(value: string, hashed: string | null) {
  if (!hashed || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  const expected = Buffer.from(hashed, 'hex');
  const supplied = Buffer.from(digestContestLiveValue(value), 'hex');
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

export async function requireContestLiveManager(examId: string, request?: Request) {
  const user = await requireUser(request);
  if (!await canManageExam(user, examId)) throw new AuthError('无权管理该考试的赛事直播', 403);
  const exam = await prisma.exam.findUnique({ where: { id: examId }, select: { platform: true, contestRule: true } });
  assertContestLiveSupported(exam);
  return user;
}

export function assertContestLiveSupported(exam: { platform: string; contestRule: string } | null) {
  if (!exam || !isContestLiveSupported(exam.platform, exam.contestRule)) throw new AuthError('该考试暂无赛事直播', 404);
}

export async function contestLiveViewer(request: Request, examId: string) {
  const [exam, user] = await Promise.all([
    prisma.exam.findUnique({ where: { id: examId }, select: { platform: true, contestRule: true, startAt: true, endAt: true,
      contestLiveSettings: { select: { settings: true, obsKeyHash: true } } } }),
    getCurrentUser(),
  ]);
  assertContestLiveSupported(exam);
  const { settings, obsKeyHash } = readContestLiveConfig(exam!.contestLiveSettings, exam!);
  const manage = Boolean(user && await canManageExam(user, examId));
  const query = new URL(request.url).searchParams;
  if ((!manage || query.get('overlay') === '1') && !settings.freeze.at) {
    throw new AuthError('请先在直播设置中手动设置封榜时间', 403);
  }
  if (manage) return { settings, manage, mediaAllowed: true, access: null, key: null, obsKeyActive: Boolean(obsKeyHash) };
  const key = query.get('key');
  if (key !== null) {
    if (!contestLiveCredentialMatches(key, obsKeyHash)) throw new AuthError('赛事直播链接已失效', 403);
    return { settings, manage, mediaAllowed: true, access: obsKeyHash!, key, obsKeyActive: false };
  }
  if (!settings.publicEnabled) throw new AuthError('该赛事直播尚未公开', user ? 403 : 401);
  return { settings, manage, mediaAllowed: settings.publicMediaEnabled, access: publicContestLiveAccess, key: null, obsKeyActive: false };
}

type ContestLiveViewer = Awaited<ReturnType<typeof contestLiveViewer>>;

export function contestLiveViewerUnchanged(initial: ContestLiveViewer, latest: ContestLiveViewer) {
  return latest.manage === initial.manage && latest.access === initial.access && latest.mediaAllowed === initial.mediaAllowed
    && latest.obsKeyActive === initial.obsKeyActive && JSON.stringify(latest.settings) === JSON.stringify(initial.settings);
}
