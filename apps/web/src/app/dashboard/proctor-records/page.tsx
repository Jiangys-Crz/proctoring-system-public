import { redirect } from 'next/navigation';
import { ProctorRecordsPageClient, type ProctorRecordExam, type ProctorRecordRow } from '@/components/ProctorRecordsPageClient';
import { getCurrentUser } from '@/lib/auth';
import { prisma } from '@/lib/db';

function operatorName(user: { realName: string | null; nickname: string | null; username: string | null; numberId: string | null } | null) {
  return user?.realName || user?.nickname || user?.username || user?.numberId || '-';
}

function candidateName(candidate: { name: string | null; teamName: string | null; examNumber: string }) {
  return candidate.teamName || candidate.name || candidate.examNumber;
}

function memberText(record: {
  session: { memberName: string | null; memberStudentId: string | null } | null;
  candidate: { name: string | null; studentId: string | null; teamMembers: string | null; teamMemberStudentIds: string | null };
}) {
  return {
    memberName: record.session?.memberName || record.candidate.name || record.candidate.teamMembers || '-',
    memberStudentId: record.session?.memberStudentId || record.candidate.studentId || record.candidate.teamMemberStudentIds || '-'
  };
}

export default async function ProctorRecordsPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (user.role !== 'SUPER_ADMIN') redirect('/dashboard/exams');

  const [examsRaw, records] = await Promise.all([
    prisma.exam.findMany({
      select: {
        id: true,
        name: true,
        startAt: true,
        endAt: true,
        contestType: true
      },
      orderBy: { startAt: 'desc' }
    }),
    prisma.cheatingRecord.findMany({
      include: {
        exam: true,
        candidate: true,
        session: true,
        markedBy: true,
        canceledBy: true
      },
      orderBy: { createdAt: 'desc' }
    })
  ]);

  const exams: ProctorRecordExam[] = examsRaw.map((exam) => ({
    id: exam.id,
    name: exam.name,
    startAt: exam.startAt.toISOString(),
    endAt: exam.endAt.toISOString(),
    contestType: exam.contestType
  }));

  const rows: ProctorRecordRow[] = records
    .flatMap((record) => {
      const member = memberText(record);
      const markRow: ProctorRecordRow = {
        id: `${record.id}-mark`,
        examId: record.examId,
        examName: record.exam.name,
        createdAt: record.createdAt.toISOString(),
        isTeam: Boolean(record.candidate.teamName),
        school: record.candidate.school || '-',
        college: record.candidate.college || '-',
        name: candidateName(record.candidate),
        studentId: record.candidate.studentId || '-',
        teamName: record.candidate.teamName || '-',
        memberName: member.memberName,
        memberStudentId: member.memberStudentId,
        examNumber: record.candidate.examNumber,
        action: '标记作弊',
        reason: record.reason,
        operator: operatorName(record.markedBy)
      };
      const cancelRow: ProctorRecordRow | null = record.canceledAt
        ? {
            id: `${record.id}-cancel`,
            examId: record.examId,
            examName: record.exam.name,
            createdAt: record.canceledAt.toISOString(),
            isTeam: Boolean(record.candidate.teamName),
            school: record.candidate.school || '-',
            college: record.candidate.college || '-',
            name: candidateName(record.candidate),
            studentId: record.candidate.studentId || '-',
            teamName: record.candidate.teamName || '-',
            memberName: member.memberName,
            memberStudentId: member.memberStudentId,
            examNumber: record.candidate.examNumber,
            action: '取消作弊',
            reason: record.canceledReason || '-',
            operator: operatorName(record.canceledBy)
          }
        : null;
      return cancelRow ? [markRow, cancelRow] : [markRow];
    })
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());

  return <ProctorRecordsPageClient exams={exams} rows={rows} />;
}
