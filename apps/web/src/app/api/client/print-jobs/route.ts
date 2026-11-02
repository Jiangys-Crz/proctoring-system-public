import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireContestSession } from '@/lib/client-contest';
import { fail, ok, options, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';

const CreateSchema = z.object({ sessionId: z.string().min(1), content: z.string().trim().min(1).max(100000) });

export async function GET(request: Request) {
  try {
    const sessionId = new URL(request.url).searchParams.get('sessionId') || '';
    const authorized = await requireContestSession(request, sessionId);
    if (!authorized.ok) return fail(authorized.message, authorized.status);
    const { exam, candidate } = authorized.session;
    if (exam.printMode === 'DISABLED') return ok([]);
    const owner = exam.contestType === 'TEAM' && candidate.teamName
      ? { examId: exam.id, OR: [
          { mode: 'VIRTUAL' as const, teamName: candidate.teamName },
          { mode: 'PHYSICAL' as const, candidateId: candidate.id },
        ] }
      : { examId: exam.id, candidateId: candidate.id };
    const jobs = await prisma.printJob.findMany({ where: owner, orderBy: { createdAt: 'desc' } });
    return ok(jobs);
  } catch (error) { return fail(toErrorMessage(error), 500); }
}

export async function POST(request: Request) {
  try {
    const input = await parseBody(request, CreateSchema);
    const authorized = await requireContestSession(request, input.sessionId);
    if (!authorized.ok) return fail(authorized.message, authorized.status);
    const { exam, candidate } = authorized.session;
    if (exam.printMode === 'DISABLED') return fail('本场考试未开启打印', 403);
    const room = await prisma.examRoom.findFirst({ where: { examId: exam.id, candidates: { some: { candidateId: candidate.id } } }, select: { name: true } });
    const now = new Date();
    const who = candidate.name || candidate.teamName || candidate.examNumber;
    const title = `${new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'Asia/Shanghai' }).format(now)} ${who}`;
    const job = await prisma.printJob.create({ data: {
      examId: exam.id, candidateId: candidate.id, sessionId: authorized.session.id,
      mode: exam.printMode, status: exam.printMode === 'VIRTUAL' ? 'SAVED' : 'PENDING',
      title, content: input.content, teamName: candidate.teamName, candidateName: candidate.name,
      examNumber: candidate.examNumber, teamMembers: candidate.teamMembers, roomName: room?.name, seatNo: candidate.seatNo,
    } });
    return ok(job);
  } catch (error) {
    if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
    return fail(toErrorMessage(error), 500);
  }
}

export const OPTIONS = options;
