import { ZodError } from 'zod';
import { AuthError, requireSuperAdmin } from '@/lib/auth';
import { assertReleaseRequestOrigin, uploadDesktopArtifact } from '@/lib/desktop-releases';
import { ok, fail } from '@/lib/http';
import { UploadSecurityError } from '@/lib/upload-security';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    const user = await requireSuperAdmin(request); assertReleaseRequestOrigin(request);
    return ok(await uploadDesktopArtifact(request, user.id), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof AuthError || error instanceof UploadSecurityError) return fail(error.message, error.status);
    if (error instanceof ZodError) return fail('请填写有效版本、系统和安装包类型', 400);
    return fail('安装包上传失败，请检查剩余磁盘空间', 500);
  }
}
