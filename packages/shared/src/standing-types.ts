export type StandingParticipant = {
  itemId: string; rank: number; name: string; organization?: string; organizationLogo?: string;
  members?: string; memberInfos?: Array<{name:string;numberId:string}>;
  advisor?: string | null; coach?: string; englishName?: string; isStar?: boolean; isGirl?: boolean; group?: string;
};
export type StandingRowMetadata = { boardRowKey: string; boardPosition: number; isPinned: boolean };
export type StandingProblemStatus = {
  status: 'AC' | 'WA' | 'PENDING' | 'NONE' | 'Scored';
  score?: number; maxScore?: number; time?: number; tryCount?: number; isFirstAc?: boolean;
};
