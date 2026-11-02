import { z, ZodError } from 'zod';
import { AuthError, requireSuperAdmin } from '@/lib/auth';
import { deleteDesktopArtifacts, assertReleaseRequestOrigin, getDesktopArtifacts, getDesktopReleases, PublishDesktopSchema, publishDesktopRelease } from '@/lib/desktop-releases';
import { fail, ok, parseBody, RequestParseError } from '@/lib/http';
import { UploadSecurityError } from '@/lib/upload-security';
export async function GET() {
  try { await requireSuperAdmin(); return ok({ releases: await getDesktopReleases(), artifacts: await getDesktopArtifacts() }, { headers: { 'Cache-Control': 'no-store' } }); }
  catch (error) { return fail(error instanceof AuthError ? error.message : '发布设置读取失败', error instanceof AuthError ? error.status : 500); }
}
export async function POST(request: Request) {
  try {
    await requireSuperAdmin(request); assertReleaseRequestOrigin(request);
    await publishDesktopRelease(await parseBody(request, PublishDesktopSchema));
    return ok(await getDesktopReleases());
  } catch (error) {
    if (error instanceof AuthError || error instanceof UploadSecurityError) return fail(error.message, error.status);
    if (error instanceof RequestParseError || error instanceof ZodError) return fail('版本或安装包参数无效', 400);
    return fail('客户端发布失败，请检查安装包和存储', 500);
  }
}

export async function DELETE(request: Request) {
  try {
    const user = await requireSuperAdmin(request); assertReleaseRequestOrigin(request);
    const input = await parseBody(request, z.object({ ids: z.array(z.string().uuid()).min(1).max(100) }).strict());
    return ok(await deleteDesktopArtifacts(input.ids, user.id));
  } catch (error) {
    if (error instanceof AuthError || error instanceof UploadSecurityError) return fail(error.message, error.status);
    if (error instanceof RequestParseError) return fail('请选择需要删除的安装包', 400);
    return fail('安装包删除失败，请重试', 500);
  }
}
