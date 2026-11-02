import crypto from 'node:crypto';
import { requireUser, AuthError } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { judgeStatistics, requestHydroProblem, submitHydroJudge } from '@/lib/hydro-contest';
import { fail, ok, options, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';
import { canAccessHydroProblem } from '@/lib/permissions';
import { z } from 'zod';
const Submit = z.object({ lang: z.string().min(1), code: z.string().min(1) });
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) { try { const user = await requireUser(); const { id } = await context.params; if (!await canAccessHydroProblem(user, id)) return fail('无权查看该题目', 403); return ok(await requestHydroProblem({ platformBaseUrl: process.env.HYDRO_PROCTOR_BASE_URL || 'http://localhost' }, id)); } catch (error) { if (error instanceof AuthError) return fail(error.message, error.status); return fail(toErrorMessage(error), 502); } }
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    if (!await canAccessHydroProblem(user, id)) return fail('无权提交该题目', 403);
    const input = await parseBody(request, Submit);
    const remote = await submitHydroJudge({ platformBaseUrl: process.env.HYDRO_PROCTOR_BASE_URL || 'http://localhost' }, { pid: Number(id), ...input });
    const ownerKey = user.id;
    const local = await prisma.problemSubmission.create({
      data: {
        id: `sub_${crypto.randomUUID()}`,
        problemId: id,
        userId: user.id,
        ownerKey,
        // Standalone trial runs do not belong to an exam or a Hydro account.
        recordExamId: null,
        hydroRecordId: remote.id,
        lang: remote.lang || input.lang,
        code: input.code,
        status: remote.status || 0,
        statusText: remote.statusText || 'Waiting',
        score: remote.score || 0,
        ...judgeStatistics(remote.testCases),
        time: remote.time || 0,
        memory: remote.memory || 0,
        testCases: remote.testCases as any,
        subtasks: remote.subtasks as any,
        judgeAt: remote.judgeAt ? new Date(remote.judgeAt) : null,
      }
    });
    return ok({ ...remote, id: local.id, recordExamId: local.recordExamId, ownerKey: local.ownerKey, hydroRecordId: remote.id, createdAt: local.createdAt.toISOString(), code: input.code, totalTestCases: local.totalTestCases, passedTestCases: local.passedTestCases });
  } catch (error) { if (error instanceof AuthError) return fail(error.message, error.status); if (error instanceof RequestParseError) return fail(error.message, 400, error.details); return fail(toErrorMessage(error), 502); }
}
export const OPTIONS = options;
