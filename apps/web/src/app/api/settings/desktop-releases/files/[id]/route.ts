import { z } from 'zod';
import { AuthError, requireSuperAdmin } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { ReleaseArtifactSchema, artifactPath } from '@/lib/desktop-releases';
import { desktopDownload } from '@/lib/desktop-download';
import { fail } from '@/lib/http';
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireSuperAdmin();
    const id = z.string().uuid().parse((await params).id);
    const row = await prisma.systemSetting.findUnique({ where: { key: 'desktop.asset.' + id } });
    if (!row) return fail('安装包不存在或已删除', 404);
    const asset = ReleaseArtifactSchema.parse(row.value);
    return desktopDownload(request, { ...asset, path: artifactPath(asset) }, true);
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    return fail('安装包读取失败', 400);
  }
}

export const HEAD = GET;
