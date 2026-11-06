import path from 'node:path';
import sharp from 'sharp';
import { prisma } from '@/lib/db';
import { readReactionAsset } from '@/lib/reaction-presentation';
import { readBuiltinReactionBadge, resolveReactionBrandingLogo } from '@/lib/reaction-branding';
import { UploadSecurityError } from '@/lib/upload-security';
import { reactionRouteError, requireReactionAdmin } from '../_shared';

let background: Promise<Buffer> | undefined;
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    await requireReactionAdmin(id);
    const params = new URL(request.url).searchParams;
    const kind = params.get('kind');
    let buffer: Buffer;
    if (kind === 'background') {
      // Render the same repository template used by the official CLI adapter.
      background ??= sharp(path.resolve(process.cwd(), 'assets/reaction-background.svg')).png().toBuffer().catch(error => { background = undefined; throw error; });
      buffer = await background;
    } else if (kind === 'logo') {
      const teamId = params.get('teamId');
      if (teamId && teamId.length > 100) throw new UploadSecurityError('队伍账号无效');
      const candidate = teamId ? await prisma.candidate.findFirst({ where: { examId: id, examNumber: teamId }, select: { school: true } }) : null;
      if (teamId && !candidate) throw new UploadSecurityError('队伍不存在', 404);
      const badge = await resolveReactionBrandingLogo(candidate?.school || null);
      buffer = badge.path ? await readReactionAsset('logo-library', badge.path) : await readBuiltinReactionBadge();
    } else throw new UploadSecurityError('预览类型无效');
    return new Response(new Uint8Array(buffer), { headers: { 'content-type': 'image/png', 'content-length': String(buffer.length), 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } });
  } catch (error) { return reactionRouteError(error); }
}
