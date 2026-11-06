import { fail, ok, options } from '@/lib/http';
import { listReactionLogos } from '@/lib/reaction-logo-library';
import { reactionRouteError, requireReactionAdmin } from '../_shared';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params; const user = await requireReactionAdmin(id);
    return ok(await listReactionLogos(user, id), { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) { return reactionRouteError(error); }
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params; await requireReactionAdmin(id, request);
    return fail('组织徽章已统一移至系统设置，请由超级管理员维护', 410);
  } catch (error) { return reactionRouteError(error); }
}
export const PATCH = POST;
export const DELETE = POST;
export const OPTIONS = options;
