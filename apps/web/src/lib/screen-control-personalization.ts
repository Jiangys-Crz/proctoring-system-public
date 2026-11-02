import { participationGroupLabel } from '@cwnupaa/proctor-shared/leaderboard';
import { prisma } from './db';
import { ScreenControlError } from './screen-control-policy';
import { SCREEN_SAMPLE_VALUES, type ScreenTextValues } from './screen-control-template';

const candidateSelect = { name: true, teamName: true, teamMembers: true, school: true, college: true, groupName: true } as const;
const join = (values: (string | null)[]) => [...new Set(values.map(value => value?.trim()).filter(Boolean))].join('、');

export async function screenControlTextValues(examId: string, candidateId?: string): Promise<ScreenTextValues> {
  if (!candidateId) return { ...SCREEN_SAMPLE_VALUES };
  const [exam, candidate] = await Promise.all([
    prisma.exam.findUnique({ where: { id: examId }, select: { contestType: true, teamAccountMode: true, contestRule: true } }),
    prisma.candidate.findFirst({ where: { id: candidateId, examId }, select: candidateSelect }),
  ]);
  if (!exam || !candidate) throw new ScreenControlError('考生不属于本场考试', 404);
  let members = [candidate];
  if (exam.contestType === 'TEAM' && exam.teamAccountMode === 'MEMBER_ACCOUNTS' && candidate.teamName) {
    members = await prisma.candidate.findMany({ where: { examId, teamName: candidate.teamName }, select: candidateSelect,
      orderBy: [{ seatNo: 'asc' }, { examNumber: 'asc' }, { id: 'asc' }] });
  }
  const isTeam = exam.contestType === 'TEAM';
  return {
    name: candidate.name || '', teamname: candidate.teamName || '',
    members: exam.teamAccountMode === 'TEAM_ACCOUNT' ? candidate.teamMembers || '' : join(members.map(member => member.name)) || candidate.teamMembers || '',
    school: isTeam ? join(members.map(member => member.school)) : candidate.school || '',
    college: isTeam ? join(members.map(member => member.college)) : candidate.college || '',
    group: candidate.groupName ? participationGroupLabel(exam.contestRule, candidate.groupName) : '',
  };
}
