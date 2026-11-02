import { ok, options, parseBody } from '@/lib/http';
import { deleteScreenControlGroup, updateScreenControlGroup } from '@/lib/screen-control';
import { UpdateScreenControlGroupSchema } from '@/lib/screen-control-policy';
import { requireScreenControlAdmin, screenControlRouteError } from '@/lib/screen-control-route';

export async function PATCH(request: Request, context: { params: Promise<{ id: string; groupId: string }> }) {
  try {
    const { id, groupId } = await context.params;
    await requireScreenControlAdmin(id, request);
    const input = await parseBody(request, UpdateScreenControlGroupSchema, 2 * 1024 * 1024);
    return ok(await updateScreenControlGroup(id, groupId, input));
  } catch (error) { return screenControlRouteError(error); }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string; groupId: string }> }) {
  try {
    const { id, groupId } = await context.params;
    await requireScreenControlAdmin(id, _request);
    return ok(await deleteScreenControlGroup(id, groupId));
  } catch (error) { return screenControlRouteError(error); }
}

export const OPTIONS = options;
