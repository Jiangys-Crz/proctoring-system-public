import JSZip from 'jszip';
import { prisma } from '@/lib/db';
import { AuthError, requireUser } from '@/lib/auth';
import { canManageExam } from '@/lib/permissions';
import { fail, toErrorMessage } from '@/lib/http';
import { problemLabel } from '@/lib/contest-rules';

function safeName(value: string) {
  return value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 80) || '未命名';
}

function codeExtension(lang: string) {
  const value = lang.toLowerCase();
  if (value === 'c' || value.startsWith('c.')) return 'c';
  if (value.includes('cpp') || value.startsWith('cc.') || value === 'cc') return 'cpp';
  if (value.includes('python') || value.startsWith('py.')) return 'py';
  if (value.startsWith('java')) return 'java';
  return 'txt';
}

function csvCell(value: unknown) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await context.params;
    if (!(await canManageExam(user, id))) return fail('无权导出该考试代码', 403);
    const exam = await prisma.exam.findUnique({ where: { id }, select: { examCode: true, name: true } });
    if (!exam) return fail('考试不存在', 404);

    const submissions = await prisma.contestSubmission.findMany({
      where: { examId: id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: {
        candidate: { select: { examNumber: true, name: true, teamName: true } },
        problem: { select: { order: true, title: true, problemType: true } }
      }
    });
    const codeSubmissions = submissions.filter(item => !['objective', 'submit_answer'].includes(item.problem.problemType.toLowerCase()));
    const zip = new JSZip();
    const manifest: Array<Array<string | number>> = [['提交编号', '考号', '考生或队伍', '题目', '语言', '状态', '分数', '提交时间', '文件']];

    for (const submission of codeSubmissions) {
      const owner = submission.candidate.teamName || submission.candidate.name || submission.candidate.examNumber;
      const problem = `${problemLabel(submission.problem.order)}-${submission.problem.title}`;
      const stamp = submission.createdAt.toISOString().replace(/[:.]/g, '-');
      const path = `${safeName(submission.candidate.examNumber)}-${safeName(owner)}/${safeName(problem)}/${stamp}-${submission.id.slice(-8)}.${codeExtension(submission.lang)}`;
      zip.file(path, submission.code);
      manifest.push([
        submission.id,
        submission.candidate.examNumber,
        owner,
        problem,
        submission.lang,
        submission.statusText || submission.status,
        submission.score,
        submission.createdAt.toISOString(),
        path
      ]);
    }
    zip.file('提交清单.csv', `\uFEFF${manifest.map(row => row.map(csvCell).join(',')).join('\n')}`);
    zip.file('说明.txt', `${exam.name}\n考试编号：${exam.examCode}\n代码递交：${codeSubmissions.length} 份\n客观题答卷不会包含在代码导出中。`);
    const body = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    const responseBody = new ArrayBuffer(body.byteLength);
    new Uint8Array(responseBody).set(body);
    return new Response(responseBody, {
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="exam-${exam.examCode}-codes.zip"`,
        'cache-control': 'no-store'
      }
    });
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    return fail(toErrorMessage(error), 500);
  }
}
