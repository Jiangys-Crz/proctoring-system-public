import { prisma } from '../src/lib/db';
// Old installations had only a captain flag. Repair only untouched all-1
// groups, retaining any member ordering an administrator has already entered.
try {
  const rows = await prisma.candidate.findMany({ where: { teamName: { not: null }, exam: { contestType: 'TEAM', teamAccountMode: 'MEMBER_ACCOUNTS' } },
    select: { id: true, examId: true, teamName: true, memberOrder: true, isTeamLeader: true, createdAt: true }, orderBy: [{ isTeamLeader: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }] });
  const teams = new Map<string, typeof rows>();
  for (const row of rows) { const key = `${row.examId}\0${row.teamName}`; teams.set(key, [...(teams.get(key) || []), row]); }
  let updated = 0;
  for (const members of teams.values()) if (members.length > 1 && members.every(m => m.memberOrder === 1)) {
    await prisma.$transaction(members.map((m, index) => prisma.candidate.update({ where: { id: m.id }, data: { memberOrder: index + 1, isTeamLeader: index === 0 } }))); updated += members.length;
  }
  console.log(`Team member order migration complete: ${updated} rows`);
} finally { await prisma.$disconnect(); }
