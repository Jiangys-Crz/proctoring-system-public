import { admittedQaRead, admittedQaWrite } from '@/lib/qa-admission';
import { appendQuestionMessage, ensureQuestionMessages, nextPublicationId, qaAnnouncementVisibility, qaAuthorLabel, qaContentDto, qaMessagesForRead, qaQuestionTransaction, refreshQuestionSummary, requireQuestionExam } from '@/lib/qa-thread';
import { publicQuestionAnnouncement } from '@/lib/public-question-announcement';
import { CommunicationSnapshotSchema, QuestionSnapshotSchema } from '@/lib/exam-communication-protocol';
import { contentIdentity } from '@/lib/exam-communication-entry';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { AuthError, requireUser } from '@/lib/auth';
import { canAccessCandidate, canAccessExam, canManageExam } from '@/lib/permissions';
import { fail, ok, options, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';
import { settleReads } from '@/lib/request-admission';

const ActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('reply'), questionId: z.string().min(1), content: z.string().trim().min(1).max(10000) }),
  z.object({ action: z.literal('publish'), questionId: z.string().min(1), published: z.boolean() }),
  z.object({ action: z.literal('announce'), content: z.string().trim().min(1).max(10000), candidateId: z.string().min(1).nullable().optional() })
]);

async function getQa(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await context.params;
    if (!(await canAccessExam(user, id))) return fail('无权查看该考试答疑', 403);
    const manageable = await canManageExam(user, id);
    const candidateScope = manageable ? {} : {
      rooms: { some: { room: { proctors: { some: { userId: user.id } } } } }
    };
    const questionScope = manageable ? {} : { candidate: candidateScope };
    const [questions, announcements, candidates] = await settleReads([
      prisma.examQuestion.findMany({
        where: { examId: id, ...questionScope },
        include: {
          candidate: { select: { id: true, examNumber: true, name: true, teamName: true, seatNo: true } },
          answeredBy: { select: { id: true, realName: true, nickname: true, username: true } },
          messages: { include: { createdBy: { select: { id: true, realName: true, nickname: true, username: true } } }, orderBy: [{ threadOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] }
        },
        orderBy: [{ answeredAt: 'asc' }, { createdAt: 'desc' }]
      }),
      prisma.examAnnouncement.findMany({
        where: { AND: [qaAnnouncementVisibility()], examId: id, ...(manageable ? {} : { OR: [{ candidateId: null }, { candidate: candidateScope }] }) },
        include: {
          createdBy: { select: { id: true, realName: true, nickname: true, username: true } },
          candidate: { select: { id: true, examNumber: true, name: true, teamName: true } }
        },
        orderBy: { createdAt: 'desc' },
        take: 50
      }),
      prisma.candidate.findMany({
        where: { examId: id, ...candidateScope },
        select: { id: true, examNumber: true, name: true, teamName: true, seatNo: true },
        orderBy: { examNumber: 'asc' }
      })
    ]);
    return ok(qaContentDto({ questions: questions.map(question => ({ ...question, messages: qaMessagesForRead(question) })), announcements, candidates }));
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    return fail(toErrorMessage(error), 500);
  }
}

async function postQa(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    if (!(await canAccessExam(user, id))) return fail('无权处理该考试答疑', 403);
    const input = await parseBody(request, ActionSchema, 65536);
    if (input.action === 'announce') {
      if (!input.candidateId && !(await canManageExam(user, id))) return fail('只有考试管理员可以向全体考生发布公告，请选择负责考室的考生', 403);
      if (input.candidateId) {
        const candidate = await prisma.candidate.findFirst({ where: { id: input.candidateId, examId: id } });
        if (!candidate) return fail('目标考生不存在', 404);
        if (!(await canManageExam(user, id)) && !(await canAccessCandidate(user, candidate.id))) return fail('无权向该考生发布公告', 403);
      }
      const announcement = await prisma.examAnnouncement.create({
        data: { examId: id, candidateId: input.candidateId || null, deliveredAt: new Date(), content: input.content, createdById: user.id, creatorLabel: qaAuthorLabel(user) },
        include: {
          createdBy: { select: { id: true, realName: true, nickname: true, username: true } },
          candidate: { select: { id: true, examNumber: true, name: true, teamName: true } }
        }
      });
      return ok(qaContentDto(announcement), { status: 201 });
    }
    const question = await prisma.examQuestion.findFirst({ where: { id: input.questionId, examId: id }, select: { id: true, candidateId: true } });
    if (!question) return fail('提问不存在', 404);
    if (!(await canManageExam(user, id)) && !(await canAccessCandidate(user, question.candidateId))) return fail('无权回复该考生', 403);
    const updated = await qaQuestionTransaction(question.id, async tx => {
      const current = await tx.examQuestion.findUnique({ where: { id: question.id } });
      requireQuestionExam(current, id);
      await ensureQuestionMessages(tx, question.id);
      if (input.action === 'publish') {
        if (current!.isPublished !== input.published || (input.published && !current!.publicationId)) {
          const publicationId = nextPublicationId(input.published);
          const fresh = await tx.examQuestion.update({ where: { id: question.id }, data: { isPublished: input.published, publicationId,
            federationDirty: true, federationRevision: { increment: 1 } } });
          await tx.examAnnouncement.updateMany({ where: { sourceQuestionId: question.id, ...(publicationId ? { sourcePublicationId: { not: publicationId } } : {}) }, data: { withdrawn: true } });
          if (input.published) {
            const stored = await tx.examFederationContent.findUnique({ where: contentIdentity(id, 'question', question.id), select: { snapshot: true } });
            let content = fresh.content, answer = fresh.answer;
            if (stored) {
              content = QuestionSnapshotSchema.parse(stored.snapshot).content;
              const lastReply = await tx.examQuestionMessage.findFirst({ where: { questionId: question.id, sender: 'ADMIN' },
                select: { id: true }, orderBy: [{ threadOrder: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }] });
              const reply = lastReply && await tx.examFederationContent.findUnique({ where: contentIdentity(id, 'message', lastReply.id), select: { snapshot: true } });
              if (reply) {
                const snapshot = CommunicationSnapshotSchema.parse(reply.snapshot);
                if (snapshot.kind === 'message') answer = snapshot.content;
              }
            }
            await tx.examAnnouncement.create({ data: { examId: id, candidateId: null,
              deliveredAt: new Date(), content: publicQuestionAnnouncement({ ...fresh, content, answer }), createdById: user.id, creatorLabel: qaAuthorLabel(user),
              sourceQuestionId: question.id, sourcePublicationId: publicationId } });
          }
        }
      } else {
        await appendQuestionMessage(tx, question.id, { sender: 'ADMIN', content: input.content, createdById: user.id, creatorLabel: qaAuthorLabel(user) });
        await refreshQuestionSummary(tx, question.id);
      }
      return tx.examQuestion.findUniqueOrThrow({ where: { id: question.id }, include: {
        candidate: { select: { id: true, examNumber: true, name: true, teamName: true, seatNo: true } },
        answeredBy: { select: { id: true, realName: true, nickname: true, username: true } },
        messages: { include: { createdBy: { select: { id: true, realName: true, nickname: true, username: true } } }, orderBy: [{ threadOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] },
      } });
    });
    return ok(qaContentDto(updated));
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
    return fail(toErrorMessage(error), 500);
  }
}

export const OPTIONS = options;

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) { return admittedQaRead(request, () => getQa(request, context)); }
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) { return admittedQaWrite(request, () => postQa(request, context)); }
