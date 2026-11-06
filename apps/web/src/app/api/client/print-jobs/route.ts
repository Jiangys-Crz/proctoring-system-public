import { z } from 'zod';
import { prisma } from '@/lib/db';
import { proctorSessionEndAt, requireContestSession } from '@/lib/client-contest';
import { AuthError } from '@/lib/auth';
import { verifyClientTokenForSession } from '@/lib/client-auth';
import { withSessionWrite, SessionWriteQueueError } from '@/lib/session-write';
import { admittedContestLoad } from '@/lib/request-admission';
import { fail, ok, options, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';

const CreateSchema = z.object({ sessionId: z.string().min(1), content: z.string().trim().min(1).max(100000) });

async function getJobs(request: Request) {
  try {
    const sessionId = new URL(request.url).searchParams.get('sessionId') || '';
    const authorized = await requireContestSession(request, sessionId, true);
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
    // The database's default collation can equate different team names. Grant
    // shared virtual-print access only to an exact current team name.
    return ok(jobs.filter(job => job.candidateId === candidate.id
      || (exam.contestType === 'TEAM' && candidate.teamName && job.mode === 'VIRTUAL' && job.teamName === candidate.teamName)));
  } catch (error) { return fail(toErrorMessage(error), 500); }
}

async function createJob(request: Request) {
  try {
    const input = await parseBody(request, CreateSchema, 1024 * 1024);
    const authorized = await requireContestSession(request, input.sessionId, true);
    if (!authorized.ok) return fail(authorized.message, authorized.status);
    const session = authorized.session;
    const job = await withSessionWrite(session.id, async tx => {
      await tx.$queryRaw`SELECT id FROM Exam WHERE id = ${session.examId} FOR SHARE`;
      await tx.$queryRaw`SELECT id FROM Candidate WHERE id = ${session.candidateId} FOR UPDATE`;
      const current = await tx.clientSession.findUnique({ where: { id: session.id }, include: { exam: true, candidate: true } });
      if (!current || !verifyClientTokenForSession(request, current, 'DESKTOP')) throw new AuthError('考试会话已失效，请重新登录', 401);
      if (current.examId !== session.examId || current.candidateId !== session.candidateId || current.exam.platform !== 'HYDRO') throw new AuthError('考试配置已改变，请刷新后重试', 409);
      const { exam, candidate } = current;
      if (current.status !== 'IN_EXAM' || current.lockdown || candidate.status === 'FINISHED') throw new AuthError('当前考试状态不能提交打印任务', 409);
      if (exam.platformContestId === 'local' && !exam.published) throw new AuthError('考试尚未发布', 409);
      if (exam.printMode === 'DISABLED') throw new AuthError('本场考试未开启打印', 403);
      const room = await tx.examRoom.findFirst({ where: { examId: exam.id, candidates: { some: { candidateId: candidate.id } } }, select: { name: true } });
      const now = new Date();
      if (!(candidate.startedAt || current.startedAt) || now < exam.startAt || now >= proctorSessionEndAt(current)) throw new AuthError('当前不在允许打印的考试时间内', 409);
      const who = candidate.name || candidate.teamName || candidate.examNumber;
      const title = `${new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'Asia/Shanghai' }).format(now)} ${who}`;
      return tx.printJob.create({ data: {
        examId: exam.id, candidateId: candidate.id, sessionId: current.id,
        mode: exam.printMode, status: exam.printMode === 'VIRTUAL' ? 'SAVED' : 'PENDING',
        title, content: input.content, teamName: candidate.teamName, candidateName: candidate.name,
        examNumber: candidate.examNumber, teamMembers: candidate.teamMembers, roomName: room?.name, seatNo: candidate.seatNo, createdAt: now,
      } });
    }, { signal: request.signal });
    return ok(job);
  } catch (error) {
    if (error instanceof AuthError || error instanceof SessionWriteQueueError) return fail(error.message, error.status);
    if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
    return fail(toErrorMessage(error), 500);
  }
}

export const OPTIONS = options;
export async function GET(request: Request) { return admittedContestLoad(request, () => getJobs(request)); }
export async function POST(request: Request) { return admittedContestLoad(request, () => createJob(request)); }
