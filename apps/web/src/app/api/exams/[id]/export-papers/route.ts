import { AuthError, requireUser } from '@/lib/auth';
import { buildExamPaperArchive } from '@/lib/exam-paper-export';
import { fail, toErrorMessage } from '@/lib/http';
import { canManageExam } from '@/lib/permissions';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await context.params;
    if (!(await canManageExam(user, id))) return fail('无权导出该考试试卷', 403);
    const archive = await buildExamPaperArchive(id);
    const responseBody = new ArrayBuffer(archive.body.byteLength);
    new Uint8Array(responseBody).set(archive.body);
    return new Response(responseBody, {
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(archive.fileName)}`,
        'cache-control': 'no-store',
      },
    });
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    return fail(toErrorMessage(error), 500);
  }
}
