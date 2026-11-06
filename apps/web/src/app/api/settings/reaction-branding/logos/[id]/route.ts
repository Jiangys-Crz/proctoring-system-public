import { z } from 'zod';
import { AuthError, requireSuperAdmin } from '@/lib/auth';
import { fail, options } from '@/lib/http';
import { prisma } from '@/lib/db';
import { readReactionAsset } from '@/lib/reaction-presentation';
import { readBuiltinReactionBadge } from '@/lib/reaction-branding';
import { UploadSecurityError } from '@/lib/upload-security';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireSuperAdmin();
    const { id } = await context.params;
    let data: Buffer;
    if (id === 'builtin') data = await readBuiltinReactionBadge();
    else {
      if (!z.string().cuid().safeParse(id).success) return fail('徽章不存在', 404);
      const entry = await prisma.reactionLogo.findUnique({ where: { id }, select: { objectPath: true } });
      if (!entry) return fail('徽章不存在', 404);
      data = await readReactionAsset('logo-library', entry.objectPath);
    }
    return new Response(new Uint8Array(data), { headers: { 'content-type': 'image/png', 'content-length': String(data.length), 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'content-disposition': 'inline; filename="organization-badge.png"' } });
  } catch (error) {
    if (error instanceof AuthError || error instanceof UploadSecurityError) return fail(error.message, error.status);
    return fail('徽章读取失败', 500);
  }
}
export const OPTIONS = options;
