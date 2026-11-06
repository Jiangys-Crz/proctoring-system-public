import type { Prisma } from '@prisma/client';
import { prisma } from './db';
import { qaAnnouncementVisibility } from './qa-thread';
import { settleReads } from './request-admission';

const questionSelect = {
  id: true, initialMessageId: true, candidateId: true, isPublished: true, problemPid: true, problemIndex: true, problemTitle: true,
  content: true, answer: true, answeredAt: true, createdAt: true, updatedAt: true,
  messages: { select: { id: true, sender: true, content: true, acknowledgedAt: true, createdAt: true, threadOrder: true },
    orderBy: [{ threadOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] },
} satisfies Prisma.ExamQuestionSelect;

/** Keep the existing response bound while allowing acknowledgments to drain
 * every unread batch, including old discussions received after a long outage. */
export async function readCandidateQa(examId: string, candidateId: string) {
  const questionWhere = { examId, OR: [{ candidateId }, { isPublished: true }] } satisfies Prisma.ExamQuestionWhereInput;
  const announcementWhere = { AND: [qaAnnouncementVisibility()], examId, OR: [{ candidateId: null }, { candidateId }] } satisfies Prisma.ExamAnnouncementWhereInput;
  const announcementSelect = { id: true, candidateId: true, content: true, createdAt: true, updatedAt: true,
    receipts: { where: { candidateId }, select: { id: true } } } satisfies Prisma.ExamAnnouncementSelect;
  const questionOrder = [{ updatedAt: 'desc' }, { id: 'desc' }] satisfies Prisma.ExamQuestionOrderByWithRelationInput[];
  const announcementOrder = [{ deliveredAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }] satisfies Prisma.ExamAnnouncementOrderByWithRelationInput[];
  const [unreadQuestions, unreadAnnouncements] = await settleReads([
    prisma.examQuestion.findMany({ where: { ...questionWhere, candidateId, messages: { some: { sender: 'ADMIN', acknowledgedAt: null } } },
      select: questionSelect, orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }], take: 50 }),
    prisma.examAnnouncement.findMany({ where: { ...announcementWhere, receipts: { none: { candidateId } } },
      select: announcementSelect, orderBy: [{ deliveredAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }], take: 50 }),
  ]);
  const [recentQuestions, recentAnnouncements] = await settleReads([
    unreadQuestions.length < 50 ? prisma.examQuestion.findMany({ where: { ...questionWhere, id: { notIn: unreadQuestions.map(row => row.id) } },
      select: questionSelect, orderBy: questionOrder, take: 50 - unreadQuestions.length }) : [],
    unreadAnnouncements.length < 50 ? prisma.examAnnouncement.findMany({ where: { ...announcementWhere, id: { notIn: unreadAnnouncements.map(row => row.id) } },
      select: announcementSelect, orderBy: announcementOrder, take: 50 - unreadAnnouncements.length }) : [],
  ]);
  return { questions: [...unreadQuestions, ...recentQuestions], announcements: [...unreadAnnouncements, ...recentAnnouncements] };
}
