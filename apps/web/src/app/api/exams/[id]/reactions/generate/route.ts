import { z } from 'zod';
import { queueReactionGeneration } from '@/lib/reaction-admin';
import { ok, options, parseBody } from '@/lib/http';
import { reactionRouteError, requireReactionAdmin } from '../_shared';

const GenerateSchema = z.object({ reactionIds: z.array(z.string().min(1).max(191)).min(1).max(200).optional() }).strict();

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    await requireReactionAdmin(id, request);
    const { reactionIds } = await parseBody(request, GenerateSchema, 40_000);
    return ok(await queueReactionGeneration(id, reactionIds), { status: 202 });
  } catch (error) { return reactionRouteError(error); }
}

export const OPTIONS = options;
