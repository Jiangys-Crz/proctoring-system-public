import { z } from 'zod';
import { requireContestSession } from '@/lib/client-contest';
import { requestHydroContestFile, requestHydroProblemFile } from '@/lib/hydro-contest';
import { isLocalContest } from '@/lib/local-contest';
import { prisma } from '@/lib/db';
import { options, fail, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';
import { canReadContestAttachments } from '@/lib/contest-attachment-policy';
import { fetchStatementDownload } from '@/lib/statement-download';
import { attachmentResponse } from '@/lib/attachment-response';
import { getHydroSettings } from '@/lib/settings';
import { admittedAttachment } from '@/lib/attachment-admission';

const FileSchema = z.object({
  sessionId: z.string().min(1),
  type: z.enum(['public', 'private']),
  name: z.string().min(1).max(255),
  problemId: z.string().min(1).max(100).optional(),
  url: z.string().url().max(4096).optional(),
});

async function postFile(request: Request) {
  try {
    const input = await parseBody(request, FileSchema, 65536);
    const authorized = await requireContestSession(request, input.sessionId, true);
    if (!authorized.ok) return fail(authorized.message, authorized.status);
    if (!canReadContestAttachments(authorized.session)) return fail('请在考试开始后查看题目附件', 403);
    if (isLocalContest(authorized.session.exam)) {
      if (input.type !== 'public') return fail('本地题库文件不支持 private 类型', 400);
      if (!input.problemId) return fail('缺少题目编号', 400);
      const problem = await prisma.examProblem.findFirst({ where: { examId: authorized.session.exam.id, hydroProblemId: input.problemId },
        select: { hydroProblemId: true, content: true, files: true } });
      if (!problem || problem.hydroProblemId !== input.problemId) return fail('题目文件不存在', 404);
      let upstream: Response;
      if (input.url) {
        const settings = await getHydroSettings();
        upstream = await fetchStatementDownload(problem.content, input.url, settings.baseUrl, request.signal);
      } else {
        const file = Array.isArray(problem.files) && problem.files.find((item) => Boolean(item && typeof item === 'object' && (item as { name?: unknown }).name === input.name));
        if (!file) return fail('题目文件不存在', 404);
        upstream = await requestHydroProblemFile(authorized.session.exam, problem.hydroProblemId, input.name, request.signal);
      }
      return attachmentResponse(upstream, input.name, Boolean(input.url));
    }
    if (input.url) return fail('该考试的下载链接不受支持，请使用考试附件', 400);
    const upstream = await requestHydroContestFile({ ...authorized.session.exam, candidate: authorized.session.candidate }, {
      type: input.type,
      name: input.name
    }, request.signal);
    return attachmentResponse(upstream, input.name);
  } catch (error) {
    if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
    return fail(toErrorMessage(error), 502);
  }
}

export const OPTIONS = options;
export async function POST(request: Request) { return admittedAttachment(request, () => postFile(request)); }
