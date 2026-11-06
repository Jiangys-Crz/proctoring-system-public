import { requireUser, AuthError } from '@/lib/auth';
import { requestHydroProblemFile } from '@/lib/hydro-contest';
import { fail, toErrorMessage } from '@/lib/http';
import { canAccessHydroProblem } from '@/lib/permissions';
import { attachmentResponse } from '@/lib/attachment-response';
import { admittedAttachment } from '@/lib/attachment-admission';

async function getFile(_request: Request, context: { params: Promise<{ id: string; name: string[] }> }) {
  try {
    const user = await requireUser();
    const { id, name } = await context.params;
    if (!await canAccessHydroProblem(user, id)) return fail('无权查看该题目文件', 403);
    const fileName = decodeURIComponent(name.at(-1) || '');
    if (!fileName || fileName.includes('/') || fileName.includes('\\') || fileName.includes('\0')) return fail('文件名无效', 400);
    const response = await requestHydroProblemFile({ platformBaseUrl: process.env.HYDRO_PROCTOR_BASE_URL || 'http://localhost' }, id, fileName, _request.signal);
    return attachmentResponse(response, fileName, new URL(_request.url).searchParams.get('download') === '1');
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    return fail(toErrorMessage(error), 502);
  }
}

export async function GET(request: Request, context: { params: Promise<{ id: string; name: string[] }> }) {
  return admittedAttachment(request, () => getFile(request, context));
}
