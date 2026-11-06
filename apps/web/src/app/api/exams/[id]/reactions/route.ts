import { getReactionAdminData, ReactionConfigSchema, updateReactionConfig } from '@/lib/reaction-admin';
import { ok, options, parseBody } from '@/lib/http';
import { reactionRouteError, requireReactionAdmin } from './_shared';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    await requireReactionAdmin(id);
    return ok(await getReactionAdminData(id), { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) { return reactionRouteError(error); }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    await requireReactionAdmin(id, request);
    const input = await parseBody(request, ReactionConfigSchema, 131072);
    return ok(await updateReactionConfig(id, input), { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) { return reactionRouteError(error); }
}

export const OPTIONS = options;
