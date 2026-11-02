import { after } from 'next/server';
import { z } from 'zod';
import { AuthError, requireUser } from '@/lib/auth';
import { canManageExam } from '@/lib/permissions';
import { fail, ok, options, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';
import { createCodeCheckJob, getCodeCheckData, runCodeCheckJob } from '@/lib/code-check/service';

export const runtime = 'nodejs';
export const maxDuration = 3600;
const querySchema = z.object({
  jobId: z.string().max(160).optional(), problemId: z.string().max(160).optional(),
  level: z.enum(['all', 'high', 'medium', 'low']).default('all'),
  page: z.coerce.number().int().min(1).max(100000).default(1),
});
const startSchema = z.object({
  problemId: z.string().max(160).optional(), minTokens: z.union([z.literal(5), z.literal(9), z.literal(15)]).default(9),
  submissionScope: z.enum(['all', 'accepted']).default('all'),
});

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(); const { id } = await context.params;
    if (!await canManageExam(user, id)) return fail('无权查看本场比赛代码查重', 403);
    const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success) return fail('查重筛选参数不正确', 400);
    const result = await getCodeCheckData(id, parsed.data);
    if (result.activeJob?.status === 'queued') after(() => runCodeCheckJob(result.activeJob!.id));
    return ok(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    return fail(toErrorMessage(error), 500);
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request); const { id } = await context.params;
    if (!await canManageExam(user, id)) return fail('无权执行本场比赛代码查重', 403);
    const input = await parseBody(request, startSchema);
    const job = await createCodeCheckJob(id, user.id, input);
    after(() => runCodeCheckJob(job.id));
    return ok({ id: job.id }, { status: 202 });
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
    const message = toErrorMessage(error);
    return fail(message, message.includes('已有查重任务') ? 409 : 400);
  }
}

export const OPTIONS = options;
