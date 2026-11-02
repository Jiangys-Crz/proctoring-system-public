export const GPLT_GROUPS = ['星芒初绽', '长风破浪', '凌霄问鼎'] as const;
export const LANQIAO_GROUPS = ['C/C++程序设计', 'Python程序设计', 'Java软件开发'] as const;
export const XCPC_PARTICIPATION = [
  { value: 'official', label: '正式参赛' },
  { value: 'girl', label: '女生队伍' },
  { value: 'star', label: '打星参赛' },
] as const;
export function isXcpcLeaderboard(rule: string) { return ['XCPC', 'ACM'].includes(rule.toUpperCase()); }
export function leaderboardGroups(rule: string): readonly string[] {
  return rule === 'GPLT' ? GPLT_GROUPS : rule === 'LANQIAO' ? LANQIAO_GROUPS : [];
}
export function participationOptions(rule: string) {
  const groups = leaderboardGroups(rule);
  return groups.length ? groups.map(value => ({ value, label: value })) : isXcpcLeaderboard(rule) ? [...XCPC_PARTICIPATION] : [];
}
export function normalizeParticipationGroup(rule: string, group?: string | null) {
  const value = group?.trim() || '';
  if (!isXcpcLeaderboard(rule)) return value;
  const aliases: Record<string, string> = {
    '': 'official', official: 'official', '正式': 'official', '正式参赛': 'official', '正式队伍': 'official',
    girl: 'girl', '女生': 'girl', '女生组': 'girl', '女生队伍': 'girl',
    star: 'star', '打星': 'star', '打星参赛': 'star', '打星队伍': 'star',
  };
  return aliases[value.toLowerCase()] || value;
}
export function participationGroupLabel(rule: string, group?: string | null) {
  const value = normalizeParticipationGroup(rule, group);
  return participationOptions(rule).find(option => option.value === value)?.label || value || '未分组';
}
export function isFemale(gender?: string | null) { return ['女', 'female', '2'].includes(gender?.trim().toLowerCase() || ''); }
export type LeaderboardCell = { score: number | null; accepted: boolean; wrong: number; pending: number; seconds: number; penalty: number; firstBlood: boolean };
export type LeaderboardRow = {
  rank: number; username: string; displayName: string; institution?: string; groupName?: string; teamName?: string | null;
  members?: string; isStar?: boolean; isGirl?: boolean; medal?: 'Gold' | 'Silver' | 'Bronze';
  score: number; solved: number; penalty: number; penaltyMillis?: number;
  problemScores: Array<number | null>; cells?: LeaderboardCell[];
};
export type LeaderboardData = {
  available: boolean; frozen?: boolean; rows: LeaderboardRow[]; groups?: string[];
  boards?: Array<{ key: string; label: string; rows: LeaderboardRow[] }>;
};
export type ParticipationFilter = 'all' | 'official' | 'star' | 'girl';
export function filterLeaderboardRows(rows: LeaderboardRow[], rule: string, group: string, filter: ParticipationFilter, search: string) {
  if (leaderboardGroups(rule).length && !group) return [];
  const keyword = search.toLowerCase();
  return rows.filter(row => (!leaderboardGroups(rule).length || row.groupName === group)
    && (filter !== 'official' || !row.isStar)
    && (filter !== 'star' || row.isStar)
    && (filter !== 'girl' || row.isGirl)
    && (!keyword || [row.displayName, row.institution, row.members].some(value => value?.toLowerCase().includes(keyword))));
}
export function leaderboardScoreClass(score: number | null, maximum: number) {
  if (score === null) return 'cell-problem-empty';
  const percent = maximum > 0 ? score / maximum * 100 : 0;
  return `cell-score-level-${percent <= 25 ? 1 : percent <= 50 ? 2 : percent <= 75 ? 3 : 4}`;
}
