import { z } from 'zod';
import { AuthError, getCurrentUser, requireUser } from './auth';
import { contestLiveCredentialMatches } from './contest-live-access';
import { isContestLiveSupported, validContestFreezeTime } from './contest-live-contract';
import { contestDisplayScenes, contestDisplayTransitions, defaultContestDisplaySettings, type ContestDisplayScene, type ContestDisplaySettings, type ContestDisplayTransition } from './contest-display-contract';
import { prisma } from './db';
import { canManageExam } from './permissions';

const scene = z.enum(Object.keys(contestDisplayScenes) as [ContestDisplayScene, ...ContestDisplayScene[]]);
const id = z.string().min(1).max(191);
const medalCount = z.number().int().min(0).max(1000);
const transition = z.enum(Object.keys(contestDisplayTransitions) as [ContestDisplayTransition, ...ContestDisplayTransition[]]);
const durationSeconds = z.number().int().min(3).max(600);
const assetUrl = z.string().max(2048).refine(value => {
  if (!value) return true;
  if (/[\x00-\x20\x7f\\]/.test(value)) return false;
  if (value.startsWith('/')) return !value.startsWith('//');
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password;
  } catch { return false; }
}, '素材地址必须是 HTTP(S) 或站内地址');
const assetList = z.array(assetUrl.min(1)).max(12);
const presentationAssets = z.object({
  logo: assetUrl, banner: assetUrl, background: assetUrl, ccsPrimary: assetUrl, ccsShadow: assetUrl,
  logoA: assetList, logoB: assetList, imageProgression: assetList, promotions: assetList,
}).partial().strict();
const sceneProperties = z.object({
  theme: z.enum(['dark', 'light']),
  title: z.string().trim().max(180),
  message: z.string().max(1000),
  teamId: id.nullable(),
  problemId: id.nullable(),
  group: z.string().max(180),
  scroll: z.boolean(),
  tileRows: z.number().int().min(1).max(24).optional(),
  tileColumns: z.number().int().min(1).max(4).optional(),
  showClock: z.boolean().optional(),
  showLocalTime: z.boolean().optional(),
  presentationAssets: presentationAssets.optional(),
});
const stepOptions = z.array(z.object({ transition, durationSeconds, properties: sceneProperties.partial().strict() }).partial().strict().nullable()).max(100);
export const displayPatchSchema = z.object({
  expectedRevision: z.number().int().min(0),
  restartClock: z.boolean(),
  freeze: z.object({ at: z.iso.datetime().nullable(), revealed: z.boolean() }).partial().strict(),
  enabled: z.boolean(),
  hidden: z.boolean(),
  scene,
  ...sceneProperties.shape,
  historyExamIds: z.array(id).max(4).refine(ids => new Set(ids).size === ids.length, '历史赛事编号重复'),
  speed: z.number().min(0.25).max(4),
  transition,
  playlist: z.array(scene).max(100),
  playlistOptions: stepOptions,
  savedPlans: z.array(z.object({
    name: z.string().trim().min(1).max(80), playlist: z.array(scene).min(1).max(100),
    transition, durationSeconds, playlistOptions: stepOptions.optional(),
  }).strict()).max(20).refine(plans => new Set(plans.map(plan => plan.name)).size === plans.length, '演示计划名称不能重复'),
  autoplay: z.boolean(),
  durationSeconds,
  medals: z.object({ gold: medalCount, silver: medalCount, bronze: medalCount }).partial().strict(),
}).partial().strict();
type DisplayPatch = z.infer<typeof displayPatchSchema>;
type Timing = { startAt: Date; endAt: Date };

export function readContestDisplaySettings(raw: unknown): ContestDisplaySettings {
  const parsed = displayPatchSchema.strip().safeParse(raw);
  if (!parsed.success) return defaultContestDisplaySettings;
  const { expectedRevision: _revision, restartClock: _restart, ...settings } = parsed.data;
  return { ...defaultContestDisplaySettings, ...settings,
    freeze: { ...defaultContestDisplaySettings.freeze, ...settings.freeze },
    medals: { ...defaultContestDisplaySettings.medals, ...settings.medals } };
}

export function mergeContestDisplaySettings(settings: ContestDisplaySettings, patch: Omit<DisplayPatch, 'expectedRevision' | 'restartClock'>,
  timing: Timing, now = new Date()): ContestDisplaySettings {
  const freeze = { ...settings.freeze, ...patch.freeze };
  if (patch.freeze?.at && !validContestFreezeTime(patch.freeze.at, timing)) {
    throw new AuthError('封榜时间必须在比赛开始和结束之间', 400);
  }
  if (!freeze.at || (patch.freeze?.at !== undefined && patch.freeze.at !== settings.freeze.at)) freeze.revealed = false;
  if (patch.freeze?.revealed === true && (!freeze.at || +new Date(freeze.at) > +now)) {
    throw new AuthError('达到封榜时间后才可手动揭晓', 400);
  }
  if (patch.enabled && !freeze.at) throw new AuthError('请先设置大屏封榜时间', 403);
  const merged = { ...settings, ...patch, freeze, medals: { ...settings.medals, ...patch.medals } };
  const playlistOptions = patch.playlistOptions ?? (patch.playlist ? [] : settings.playlistOptions ?? []);
  return { ...merged, ...(patch.presentationAssets && { presentationAssets: { ...settings.presentationAssets, ...patch.presentationAssets } }),
    playlistOptions: playlistOptions.slice(0, merged.playlist.length),
    enabled: !!freeze.at && merged.enabled, autoplay: merged.autoplay && merged.playlist.length > 0 };
}

type Config = {
  settings: ContestDisplaySettings;
  keyHash: string | null;
  revision: number;
  startedAt: Date | null;
};

function unpack(value: { settings: unknown; keyHash: string | null; revision: number; startedAt: Date } | null, timing: Timing): Config {
  const stored = readContestDisplaySettings(value?.settings);
  const valid = validContestFreezeTime(stored.freeze.at, timing);
  const settings = valid ? stored : { ...stored, freeze: defaultContestDisplaySettings.freeze, enabled: false };
  return { settings, keyHash: valid ? value?.keyHash ?? null : null,
    revision: value?.revision ?? 0, startedAt: value?.startedAt ?? null };
}

function assertSupported(exam: { platform: string; contestRule: string } | null) {
  if (!exam || !isContestLiveSupported(exam.platform, exam.contestRule)) throw new AuthError('该考试暂无大屏管理', 404);
}

export async function readContestDisplayConfig(examId: string) {
  const exam = await prisma.exam.findUnique({ where: { id: examId },
    select: { platform: true, contestRule: true, startAt: true, endAt: true,
      contestDisplay: { select: { settings: true, keyHash: true, revision: true, startedAt: true } } } });
  assertSupported(exam);
  return unpack(exam!.contestDisplay, exam!);
}

export async function requireContestDisplayManager(examId: string, request?: Request) {
  const user = await requireUser(request);
  if (!await canManageExam(user, examId)) throw new AuthError('无权管理该考试的大屏', 403);
  return user;
}

export type ContestDisplayViewer = { manage: boolean; key: string | null };
export async function getContestDisplayViewer(request: Request, examId: string): Promise<ContestDisplayViewer> {
  const key = new URL(request.url).searchParams.get('key');
  if (key !== null) return { key, manage: false };
  const user = await getCurrentUser();
  return { key: null, manage: !!user && await canManageExam(user, examId) };
}

export function authorizeContestDisplay(config: Config, viewer: ContestDisplayViewer) {
  if (!viewer.manage && (!viewer.key || !contestLiveCredentialMatches(viewer.key, config.keyHash))) {
    throw new AuthError(viewer.key ? '大屏链接已失效' : '请使用大屏访问链接或管理员预览', viewer.key ? 403 : 401);
  }
  if (!config.settings.freeze.at) throw new AuthError('请先在大屏管理中设置封榜时间', 403);
  if (!config.settings.enabled && !viewer.manage) throw new AuthError('大屏播放已暂停', 403);
}

export async function updateContestDisplayConfig(examId: string, update: (config: Config, timing: Timing) => Pick<Config, 'settings' | 'keyHash'>, restartClock = false) {
  return prisma.$transaction(async tx => {
    const [exam] = await tx.$queryRaw<(Timing & { platform: string; contestRule: string })[]>`
      SELECT platform, contestRule, startAt, endAt FROM Exam WHERE id = ${examId} FOR UPDATE`;
    assertSupported(exam ?? null);
    const before = unpack(await tx.contestDisplay.findUnique({ where: { examId } }), exam);
    const { settings, keyHash } = update(before, exam);
    const beforePlan = [before.settings.scene, before.settings.playlist, before.settings.playlistOptions ?? [], before.settings.autoplay, before.settings.durationSeconds, before.settings.speed];
    const afterPlan = [settings.scene, settings.playlist, settings.playlistOptions ?? [], settings.autoplay, settings.durationSeconds, settings.speed];
    const restart = restartClock || JSON.stringify(beforePlan) !== JSON.stringify(afterPlan);
    const data = { settings, keyHash: settings.freeze.at ? keyHash : null, revision: before.revision + 1,
      startedAt: restart || !before.startedAt || (!before.settings.enabled && settings.enabled) ? new Date() : before.startedAt };
    return unpack(await tx.contestDisplay.upsert({ where: { examId }, create: { examId, ...data }, update: data }), exam);
  });
}
