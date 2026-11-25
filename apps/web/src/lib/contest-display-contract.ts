import type { ContestLiveFreeze } from './contest-live-contract';
import type { ContestLiveResponse } from './contest-live-settings';

export const contestDisplayScenes = {
  blank: '黑屏',
  scoreboard: '实时榜单',
  scoreboardTimeline: '答题时间线',
  scoreboardJudge: '判题榜单',
  scoreboardFirstToSolve: '一血榜单',
  scoreboardMedal: '奖牌榜单',
  scoreboardTiles: '瓷砖榜单',
  scoreboardAlphabetical: '按队名排列',
  scoreboardRank: '名次牌',
  scoreboardTeam: '单队伍榜单',
  leaderboard: '领先队伍',
  groupLeaderboard: '分组排行榜',
  allGroupsLeaderboard: '全部分组排行榜',
  queue: '提交队列',
  judgeQueue: '判题队列',
  firstToSolve: '一血',
  statistics: '题目统计',
  team: '队伍介绍',
  teamDetail: '队伍详情',
  teamList: '参赛队伍',
  teamPhoto: '队伍照片',
  photoSlideshow: '照片轮播',
  organizationList: '参赛学校',
  organizationLogo: '学校校徽',
  logoWall: '校徽墙',
  fadingLogos: '校徽淡入淡出',
  slidingLogos: '校徽滑动',
  problem: '题目介绍',
  problemColors: '题目颜色',
  problemDetailChart: '单题提交曲线',
  problemComparisonChart: '题目比较',
  problemSummaryChart: '题目汇总图表',
  totalProblemsChart: '总提交曲线',
  languageSummaryChart: '编程语言统计',
  judgementChart: '判题耗时',
  judgeQueueDepthChart: '判题队列深度',
  scoreboardChart: '领先队伍排名走势',
  historicalComparisonChart: '历年赛事比较',
  countdown: '开赛倒计时',
  polarCountdown: '圆盘倒计时',
  contestClock: '比赛计时',
  clock: '当前时间',
  logo: '赛事标识',
  logoA: '标识轮播 A',
  logoB: '标识轮播 B',
  imageProgression: '图片序列',
  promotions: '宣传图片',
  ccs: 'CCS 标识',
  title: '赛事标题',
  message: '公告',
  awards: '颁奖',
  testAlignment: '投影校准',
  testSynchronization: '时钟同步诊断',
  testClock: '测试时钟',
  testFps: '帧率测试',
  testBlueScreen: '蓝屏测试图',
  testChart: '测试图表',
} as const;

export type ContestDisplayScene = keyof typeof contestDisplayScenes;
export const contestDisplayChartScenes = [
  'problemDetailChart', 'problemComparisonChart', 'problemSummaryChart', 'totalProblemsChart',
  'languageSummaryChart', 'judgementChart', 'judgeQueueDepthChart', 'scoreboardChart', 'historicalComparisonChart',
] as const satisfies readonly ContestDisplayScene[];
export type ContestDisplayChartScene = (typeof contestDisplayChartScenes)[number];
export function isContestDisplayChartScene(scene: ContestDisplayScene): scene is ContestDisplayChartScene {
  return (contestDisplayChartScenes as readonly ContestDisplayScene[]).includes(scene);
}

export type ContestDisplayCharts = {
  intervalSeconds: number;
  problems: Array<{ problemId: string; failed: number[]; pending: number[]; solved: number[]; frozen?: number[];
    judgement?: { solvedMs: number; failedMs: number } }>;
  languages?: Array<{ name: string; attempts: number; solved: number }>;
  queueDepth?: { stepSeconds: number; values: number[] };
  ranks?: Array<{ teamId: string; values: number[] }>;
  history?: { past: Array<{ label: string; values: number[] }>; current: Array<number | null> };
};

export type ContestDisplayPresentationAssets = {
  logo?: string; banner?: string; background?: string; ccsPrimary?: string; ccsShadow?: string;
  logoA?: string[]; logoB?: string[]; imageProgression?: string[]; promotions?: string[];
};
export const contestDisplayTransitions = {
  wipe: '擦除', cover: '覆盖', uncover: '揭开', push: '推入', none: '无转场', zoom: '放大', zoomOut: '缩小',
  split: '分割', clock: '时钟擦除', dissolve: '溶解', dissolveBlack: '黑场溶解', crossFade: '交叉淡化',
  fadeBlack: '淡入黑场', fadeWhite: '淡入白场', blinds: '百叶窗', flash: '闪光', radial: '放射',
  rectangle: '矩形', slides: '滑片', fade: '淡入', slide: '滑入',
} as const;
export type ContestDisplayTransition = keyof typeof contestDisplayTransitions;

export type ContestDisplaySceneProperties = Pick<ContestDisplaySettings,
  'theme' | 'title' | 'message' | 'teamId' | 'problemId' | 'group' | 'scroll' | 'tileRows' | 'tileColumns' | 'showClock' | 'showLocalTime' | 'presentationAssets'>;
export type ContestDisplayStepOptions = {
  transition?: ContestDisplayTransition;
  durationSeconds?: number;
  properties?: Partial<ContestDisplaySceneProperties>;
};
export type ContestDisplaySavedPlan = {
  name: string;
  playlist: ContestDisplayScene[];
  playlistOptions?: Array<ContestDisplayStepOptions | null>;
  transition: ContestDisplayTransition;
  durationSeconds: number;
};

export type ContestDisplaySettings = {
  freeze: ContestLiveFreeze;
  enabled: boolean;
  hidden?: boolean;
  scene: ContestDisplayScene;
  theme: 'dark' | 'light';
  speed: number;
  title: string;
  message: string;
  teamId: string | null;
  problemId: string | null;
  group: string;
  scroll: boolean;
  tileRows?: number;
  tileColumns?: number;
  showClock?: boolean;
  showLocalTime?: boolean;
  presentationAssets?: ContestDisplayPresentationAssets;
  historyExamIds?: string[];
  transition: ContestDisplayTransition;
  playlist: ContestDisplayScene[];
  playlistOptions?: Array<ContestDisplayStepOptions | null>;
  savedPlans?: ContestDisplaySavedPlan[];
  autoplay: boolean;
  durationSeconds: number;
  medals: { gold: number; silver: number; bronze: number };
};

export type ContestDisplayControlState = {
  settings: ContestDisplaySettings;
  revision: number;
  startedAt: string | null;
  serverTime: number;
  keyActive: boolean;
};

export type ContestDisplayResponse = ContestDisplayControlState & {
  contest: ContestLiveResponse['contest'];
  charts?: ContestDisplayCharts;
  firstSolutionHistory?: {
    past: Array<{ contestLabel: string; teamName: string; logoUrl: string | null; seconds: number }>;
    current: { teamId: string; seconds: number } | null;
  };
};

export const defaultContestDisplaySettings: ContestDisplaySettings = {
  freeze: { at: null, revealed: false },
  enabled: false,
  scene: 'scoreboard',
  theme: 'dark',
  speed: 1,
  title: '',
  message: '',
  teamId: null,
  problemId: null,
  group: '',
  scroll: true,
  transition: 'fade',
  playlist: [],
  autoplay: false,
  durationSeconds: 15,
  medals: { gold: 0, silver: 0, bronze: 0 },
};
