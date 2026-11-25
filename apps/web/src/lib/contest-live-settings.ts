import { z } from 'zod';
import { validContestFreezeTime, type ContestLiveData, type ContestLiveFreeze, type ContestLiveTeam } from './contest-live-contract';
import { contestTeamNameTemplateSchema, defaultContestTeamNameTemplate } from './contest-team-name';
import { contestLiveVisualConfigSchema, type ContestLiveVisualConfig } from './contest-live-visual-config';

const displayText = (length: number) => z.string().max(length);
const identifier = z.string().min(1).max(255);
const teamSelection = z.array(identifier).max(50);
const displayUrl = (message: string) => z.string().max(2048).refine(value => {
  if (!value) return true;
  try {
    if (/[\x00-\x20\x7f]/.test(value)) return false;
    if (value.startsWith('/') && !value.startsWith('//') && !value.includes('\\')) return true;
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}, message);
const displayImageUrl = displayUrl('图片地址必须是 HTTP(S) 或站内地址');
const displayMediaUrl = displayUrl('素材地址必须是 HTTP(S) 或站内地址');
const timeZone = z.string().max(100).refine(value => {
  try { new Intl.DateTimeFormat('zh-CN', { timeZone: value }); return true; }
  catch { return false; }
}, '时区无效');

const widgets = z.object({
  scoreboard: z.boolean(), queue: z.boolean(), statistics: z.boolean(), ticker: z.boolean(), clock: z.boolean(),
});
const scoreboard = z.object({
  offset: z.number().int().min(0).max(10000), limit: z.number().int().min(1).max(300),
  scroll: z.enum(['up', 'down', 'off']), group: displayText(180), showProblems: z.boolean(),
  version: z.enum(['normal', 'optimistic', 'pessimistic']),
});
const clock = z.object({
  mode: z.enum(['standard', 'countdown', 'global']), showSeconds: z.boolean(), timezone: timeZone,
});
const titles = z.object({
  title: displayText(180), subtitle: displayText(250), advertisement: displayText(1000), pictureUrl: displayImageUrl, visible: z.boolean(),
  titleVisible: z.boolean().optional(), advertisementVisible: z.boolean().optional(), pictureVisible: z.boolean().optional(),
  svgUrl: displayMediaUrl.optional(), svgVisible: z.boolean().optional(),
  videoUrl: displayMediaUrl.optional(), videoVisible: z.boolean().optional(),
});
const tickerMode = z.enum(['text', 'clock', 'scoreboard', 'image']);
const tickerMessage = z.object({
  id: identifier, part: z.enum(['short', 'long']), mode: tickerMode, periodMs: z.number().int().min(1000).max(600_000),
  shown: z.boolean(), text: displayText(4000), imageUrl: displayImageUrl,
  from: z.number().int().min(1).max(10_000), to: z.number().int().min(1).max(10_000), clock,
}).strict().refine(row => row.from <= row.to && (row.part === 'long' || row.mode !== 'scoreboard'), '滚动条位置或榜单范围无效');
export type ContestLiveTickerMessage = z.infer<typeof tickerMessage>;
const ticker = z.object({
  mode: tickerMode, text: displayText(4000), imageUrl: displayImageUrl,
  speed: z.number().min(1).max(300),
  messages: z.array(tickerMessage).max(32).refine(messages => new Set(messages.map(message => message.id)).size === messages.length, '滚动消息编号重复').optional(),
});
const analytics = z.object({
  submissionId: identifier.nullable(), annotation: displayText(1500), visible: z.boolean(),
});
const spotlight = z.object({ teamIds: teamSelection, visible: z.boolean() });
const teamSlot = z.object({
  teamId: identifier,
  primary: z.enum(['auto', 'screen', 'camera', 'photo', 'empty']),
  secondary: z.enum(['screen', 'camera', 'photo', 'empty']),
  showTaskStatus: z.boolean().optional(),
  showTimeLine: z.boolean().optional(),
}).strict();
export type ContestLiveTeamSlot = z.infer<typeof teamSlot>;
export const contestLiveTeamSlotCount = { single: 1, pvp: 2, split: 4 } as const;

export const contestLiveSettingsPatchSchema = z.object({
  teamNameTemplate: contestTeamNameTemplateSchema.optional(),
  visualConfig: contestLiveVisualConfigSchema.optional(),
  freeze: z.object({ at: z.iso.datetime().nullable(), revealed: z.boolean() }).partial().strict().optional(),
  publicEnabled: z.boolean().optional(),
  publicMediaEnabled: z.boolean().optional(),
  horizontalQueue: z.boolean().optional(),
  widgets: widgets.partial().strict().optional(),
  teamMode: z.enum(['single', 'pvp', 'split']).optional(),
  selectedTeamIds: teamSelection.optional(),
  teamSlots: z.array(teamSlot.nullable()).max(4).nullable().optional(),
  mediaMode: z.enum(['auto', 'screen', 'camera', 'photo', 'both']).optional(),
  scoreboard: scoreboard.partial().strict().optional(),
  clock: clock.partial().strict().optional(),
  titles: titles.partial().strict().optional(),
  ticker: ticker.partial().strict().optional(),
  analytics: analytics.partial().strict().optional(),
  spotlight: spotlight.partial().strict().optional(),
}).strict();

export type ContestLiveSettingsPatch = z.infer<typeof contestLiveSettingsPatchSchema>;

export type ContestLiveSettings = {
  teamNameTemplate: string;
  visualConfig: ContestLiveVisualConfig;
  freeze: ContestLiveFreeze;
  publicEnabled: boolean;
  publicMediaEnabled: boolean;
  horizontalQueue: boolean;
  widgets: z.infer<typeof widgets>;
  teamMode: 'single' | 'pvp' | 'split';
  selectedTeamIds: string[];
  teamSlots?: Array<ContestLiveTeamSlot | null>;
  mediaMode: 'auto' | 'screen' | 'camera' | 'photo' | 'both';
  scoreboard: z.infer<typeof scoreboard>;
  clock: z.infer<typeof clock>;
  titles: z.infer<typeof titles>;
  ticker: z.infer<typeof ticker>;
  analytics: z.infer<typeof analytics>;
  spotlight: z.infer<typeof spotlight>;
};

export type ContestLivePublishedSettings = ContestLiveSettings & { obsKeyActive: boolean };
export type ContestLiveBroadcastTeam = ContestLiveTeam & {
  photoUrl: string | null;
  organizationLogoUrl: string | null;
  media: { screenUrl: string | null; cameraUrl: string | null };
};
export type ContestLiveResponse = {
  settings: ContestLivePublishedSettings;
  contest: Omit<ContestLiveData, 'teams'> & { teams: ContestLiveBroadcastTeam[] };
};

export const defaultContestLiveSettings: ContestLiveSettings = {
  teamNameTemplate: defaultContestTeamNameTemplate,
  visualConfig: {},
  freeze: { at: null, revealed: false },
  publicEnabled: false,
  publicMediaEnabled: false,
  horizontalQueue: false,
  widgets: { scoreboard: false, queue: true, statistics: true, ticker: false, clock: true },
  teamMode: 'single',
  selectedTeamIds: [],
  mediaMode: 'auto',
  scoreboard: { offset: 0, limit: 300, scroll: 'off', group: '', showProblems: true, version: 'normal' },
  clock: { mode: 'standard', showSeconds: true, timezone: 'Asia/Shanghai' },
  titles: { title: '', subtitle: '', advertisement: '', pictureUrl: '', visible: false, svgUrl: '', svgVisible: false, videoUrl: '', videoVisible: false },
  ticker: { mode: 'text', text: '', imageUrl: '', speed: 60 },
  analytics: { submissionId: null, annotation: '', visible: false },
  spotlight: { teamIds: [], visible: false },
};

export function mergeContestLiveSettings(base: ContestLiveSettings, input: ContestLiveSettingsPatch): ContestLiveSettings {
  const { teamSlots: requestedSlots, ...patch } = input;
  const { teamSlots: storedSlots, ...stored } = base;
  const freeze = { ...base.freeze, ...input.freeze };
  if (!freeze.at || (input.freeze?.at !== undefined && input.freeze.at !== base.freeze.at)) freeze.revealed = false;
  const teamMode = patch.teamMode ?? base.teamMode;
  const teamSlots = (requestedSlots === null || (requestedSlots === undefined && input.selectedTeamIds !== undefined) ? undefined
    : requestedSlots ?? storedSlots)?.slice(0, contestLiveTeamSlotCount[teamMode]);
  return {
    ...stored,
    ...patch,
    visualConfig: input.visualConfig ?? base.visualConfig,
    freeze,
    ...(teamSlots && { teamSlots }),
    selectedTeamIds: Array.from(new Set(teamSlots ? teamSlots.flatMap(slot => slot ? [slot.teamId] : []) : input.selectedTeamIds ?? base.selectedTeamIds)),
    widgets: { ...base.widgets, ...input.widgets },
    scoreboard: { ...base.scoreboard, ...input.scoreboard },
    clock: { ...base.clock, ...input.clock },
    titles: {
      ...base.titles,
      ...(input.titles?.visible === undefined ? {} : {
        titleVisible: input.titles.visible, advertisementVisible: input.titles.visible, pictureVisible: input.titles.visible,
      }),
      ...input.titles,
    },
    ticker: { ...base.ticker, ...input.ticker },
    analytics: { ...base.analytics, ...input.analytics },
    spotlight: {
      ...base.spotlight, ...input.spotlight,
      teamIds: Array.from(new Set(input.spotlight?.teamIds ?? base.spotlight.teamIds)),
    },
  };
}

const storedContestLiveSettingsSchema = contestLiveSettingsPatchSchema.strip().extend({
  visualConfig: contestLiveVisualConfigSchema.catch({}).optional(),
});

export function readContestLiveSettings(value: unknown) {
  const parsed = storedContestLiveSettingsSchema.safeParse(value);
  if (!parsed.success) return defaultContestLiveSettings;
  const settings = mergeContestLiveSettings(defaultContestLiveSettings, parsed.data);
  if (settings.freeze.at && parsed.data.freeze?.revealed === true) settings.freeze.revealed = true;
  return settings;
}

export function readContestLiveConfig(stored: { settings: unknown; obsKeyHash: string | null } | null | undefined,
  timing: Parameters<typeof validContestFreezeTime>[1]) {
  const settings = readContestLiveSettings(stored?.settings);
  if (validContestFreezeTime(settings.freeze.at, timing)) return { settings, obsKeyHash: stored?.obsKeyHash ?? null };
  return {
    settings: { ...settings, freeze: defaultContestLiveSettings.freeze, publicEnabled: false, publicMediaEnabled: false },
    obsKeyHash: null,
  };
}
