import { z } from 'zod';
import { fail, options } from '@/lib/http';
import { readReactionAsset, resolveReactionLogoAsset } from '@/lib/reaction-presentation';
import { reactionRouteError, requireReactionAdmin } from '../../_shared';

export async function GET(_request: Request, context: { params: Promise<{ id: string; logoId: string }> }) {
  try {
    const { id, logoId } = await context.params; await requireReactionAdmin(id);
    if (!z.string().cuid().safeParse(logoId).success) return new Response('Not found', { status: 404 });
    const entry = await resolveReactionLogoAsset(id, { logoId });
    if (!entry) return new Response('Not found', { status: 404 });
    const data = await readReactionAsset('logo-library', entry.path);
    return new Response(new Uint8Array(data), { headers: { 'content-type': 'image/png', 'content-length': String(data.length), 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'content-disposition': 'inline; filename="reaction-logo.png"' } });
  } catch (error) { return reactionRouteError(error); }
}
export async function PATCH(request: Request, context: { params: Promise<{ id: string; logoId: string }> }) {
  try {
    const { id } = await context.params; await requireReactionAdmin(id, request);
    return fail('组织徽章已统一移至系统设置，请由超级管理员维护', 410);
  } catch (error) { return reactionRouteError(error); }
}
export const POST = PATCH;
export const DELETE = PATCH;
export const OPTIONS = options;
