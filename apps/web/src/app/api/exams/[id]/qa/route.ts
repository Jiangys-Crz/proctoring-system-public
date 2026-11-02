import { publicQuestionAnnouncement } from '@/lib/public-question-announcement';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { AuthError, requireUser } from '@/lib/auth';
import { canAccessCandidate, canAccessExam, canManageExam } from '@/lib/permissions';
import { fail, ok, options, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';

const ActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('reply'), questionId: z.string().min(1), content: z.string().trim().min(1).max(10000) }),
  z.object({ action: z.literal('publish'), questionId: z.string().min(1), published: z.boolean() }),
  z.object({ action: z.literal('announce'), content: z.string().trim().min(1).max(10000), candidateId: z.string().min(1).nullable().optional() })
]);

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await context.params;
    if (!(await canAccessExam(user, id))) return fail('无权查看该考试答疑', 403);
    const manageable = await canManageExam(user, id);
    const candidateScope = manageable ? {} : {
      rooms: { some: { room: { proctors: { some: { userId: user.id } } } } }
    };
    const questionScope = manageable ? {} : { candidate: candidateScope };
    const [questions, announcements, candidates] = await Promise.all([
      prisma.examQuestion.findMany({
        where: { examId: id, ...questionScope },
        include: {
          candidate: { select: { id: true, examNumber: true, name: true, teamName: true, seatNo: true } },
          answeredBy: { select: { id: true, realName: true, nickname: true, username: true } }
          ,messages: { include: { createdBy: { select: { id: true, realName: true, nickname: true, username: true } } }, orderBy: { createdAt: 'asc' } }
        },
        orderBy: [{ answeredAt: 'asc' }, { createdAt: 'desc' }]
      }),
      prisma.examAnnouncement.findMany({
        where: { examId: id, ...(manageable ? {} : { OR: [{ candidateId: null }, { candidate: candidateScope }] }) },
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
    return ok({ questions, announcements, candidates });
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    return fail(toErrorMessage(error), 500);
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    if (!(await canAccessExam(user, id))) return fail('无权处理该考试答疑', 403);
    const input = await parseBody(request, ActionSchema);
    if (input.action === 'announce') {
      if (!input.candidateId && !(await canManageExam(user, id))) return fail('只有考试管理员可以向全体考生发布公告，请选择负责考室的考生', 403);
      if (input.candidateId) {
        const candidate = await prisma.candidate.findFirst({ where: { id: input.candidateId, examId: id } });
        if (!candidate) return fail('目标考生不存在', 404);
        if (!(await canManageExam(user, id)) && !(await canAccessCandidate(user, candidate.id))) return fail('无权向该考生发布公告', 403);
      }
      const announcement = await prisma.examAnnouncement.create({
        data: { examId: id, candidateId: input.candidateId || null, content: input.content, createdById: user.id },
        include: {
          createdBy: { select: { id: true, realName: true, nickname: true, username: true } },
          candidate: { select: { id: true, examNumber: true, name: true, teamName: true } }
        }
      });
      return ok(announcement, { status: 201 });
    }
    const question = await prisma.examQuestion.findFirst({ where: { id: input.questionId, examId: id }, include: { messages: true } });
    if (!question) return fail('提问不存在', 404);
    if (!(await canManageExam(user, id)) && !(await canAccessCandidate(user, question.candidateId))) return fail('无权回复该考生', 403);
    if (input.action === 'publish') {
      const updated = await prisma.$transaction(async tx => {
        const transition = await tx.examQuestion.updateMany({
          where: { id: question.id, isPublished: !input.published }, data: { isPublished: input.published }
        });
        if (input.published && transition.count) {
          await tx.examAnnouncement.create({ data: { examId: id, candidateId: null,
            content: publicQuestionAnnouncement(question), createdById: user.id } });
        }
        return tx.examQuestion.findUniqueOrThrow({ where: { id: question.id } });
      });
      return ok(updated);
    }
    const now = new Date();
    await prisma.$transaction(async tx => {
      if (!question.messages.length) {
        await tx.examQuestionMessage.create({ data: { questionId: question.id, sender: 'CANDIDATE', content: question.content, createdAt: question.createdAt } });
        if (question.answer) await tx.examQuestionMessage.create({ data: { questionId: question.id, sender: 'ADMIN', content: question.answer, createdById: question.answeredById, acknowledgedAt: question.answeredAt, createdAt: question.answeredAt || question.createdAt } });
      }
      await tx.examQuestionMessage.create({ data: { questionId: question.id, sender: 'ADMIN', content: input.content, createdById: user.id } });
    });
    const updated = await prisma.examQuestion.update({
      where: { id: question.id },
      data: { answer: input.content, answeredAt: now, answeredById: user.id },
      include: {
        candidate: { select: { id: true, examNumber: true, name: true, teamName: true, seatNo: true } },
        answeredBy: { select: { id: true, realName: true, nickname: true, username: true } },
        messages: { include: { createdBy: { select: { id: true, realName: true, nickname: true, username: true } } }, orderBy: { createdAt: 'asc' } }
      }
    });
    return ok(updated);
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
    return fail(toErrorMessage(error), 500);
  }
}

export const OPTIONS = options;
