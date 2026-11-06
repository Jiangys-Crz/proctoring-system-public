import { ok, options } from '@/lib/http';
import { acquireUploadSlot, boundedUploadForm, consumeRateLimit, UploadSecurityError } from '@/lib/upload-security';
import { REACTION_ASSET_MAX_BYTES, reactionAssetKey, readReactionAsset, storeReactionAsset } from '@/lib/reaction-presentation';
import { reactionRouteError, requireReactionAdmin } from '../_shared';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  let release: (() => void) | undefined;
  try {
    const { id } = await context.params;
    const user = await requireReactionAdmin(id, request);
    await consumeRateLimit(`reaction-assets:${id}:${user.id}`, 15);
    release = acquireUploadSlot();
    const form = await boundedUploadForm(request, REACTION_ASSET_MAX_BYTES + 16384);
    const file = form.get('file'), kind = form.get('kind');
    if (!(file instanceof File) || form.getAll('file').length !== 1) throw new UploadSecurityError('请选择一张图片');
    if (kind === 'logo') throw new UploadSecurityError('组织徽章已统一移至系统设置，请由超级管理员维护', 410);
    if (kind !== 'background') throw new UploadSecurityError('此入口仅允许上传背景图片');
    return ok(await storeReactionAsset(id, file, kind), { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) { return reactionRouteError(error); }
  finally { release?.(); }
}
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    await requireReactionAdmin(id);
    const key = reactionAssetKey(id, new URL(request.url).searchParams.get('asset') || '');
    const data = await readReactionAsset(id, key);
    return new Response(new Uint8Array(data), { headers: {
      'content-type': 'image/png', 'content-length': String(data.length),
      'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff',
      'content-disposition': 'inline; filename="reaction-asset.png"'
    } });
  } catch (error) { return reactionRouteError(error); }
}
export const OPTIONS = options;
