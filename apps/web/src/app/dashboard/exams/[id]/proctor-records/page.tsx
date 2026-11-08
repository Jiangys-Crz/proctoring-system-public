import { notFound, redirect } from 'next/navigation';
import { ProctorRecordsPageClient, type ProctorRecordRow } from '@/components/ProctorRecordsPageClient';
import { ExamHistoryFrame } from '@/components/ExamHistoryFrame';
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

export default async function ProctorRecordsPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (user.role !== 'SUPER_ADMIN') redirect('/dashboard/exams');
  const { id } = await params;
  const exam = await prisma.exam.findUnique({ where: { id },
      select: {
        id: true,
        name: true,
        startAt: true,
        endAt: true,
        contestType: true
      }
    });
  if (!exam) notFound();
  const records = await prisma.cheatingRecord.findMany({
      where: { examId: id },
      include: {
        exam: { select: { name: true } },
        candidate: { select: { name: true, studentId: true, teamName: true, teamMembers: true, teamMemberStudentIds: true, examNumber: true, school: true, college: true } },
        session: { select: { memberName: true, memberStudentId: true } },
        markedBy: { select: { realName: true, nickname: true, username: true, numberId: true } },
        canceledBy: { select: { realName: true, nickname: true, username: true, numberId: true } }
      },
      orderBy: { createdAt: 'desc' }
    });

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

  return <ExamHistoryFrame examId={id} current="proctor-records" canViewProctorRecords>
    <ProctorRecordsPageClient exam={{ ...exam, startAt: exam.startAt.toISOString(), endAt: exam.endAt.toISOString() }} rows={rows} />
  </ExamHistoryFrame>;
}
