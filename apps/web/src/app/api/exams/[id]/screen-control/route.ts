import { ok, options, parseBody } from '@/lib/http';
import { CreateScreenControlDisplaySchema, ScreenControlActionSchema } from '@/lib/screen-control-policy';
import { cancelScreenControlDisplay, createScreenControlDisplay, getAdminScreenControl, stopScreenControlDisplay } from '@/lib/screen-control';
import { requireScreenControlAdmin, screenControlRouteError } from '@/lib/screen-control-route';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    await requireScreenControlAdmin(id);
    return ok(await getAdminScreenControl(id), { headers: { 'cache-control': 'no-store' } });
  } catch (error) { return screenControlRouteError(error); }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const user = await requireScreenControlAdmin(id, request);
    const input = await parseBody(request, CreateScreenControlDisplaySchema);
    return ok(await createScreenControlDisplay(id, input, user.id), { status: 201 });
  } catch (error) { return screenControlRouteError(error); }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    await requireScreenControlAdmin(id, request);
    const input = await parseBody(request, ScreenControlActionSchema);
    return ok(input.action === 'STOP'
      ? await stopScreenControlDisplay(id, input.displayId)
      : await cancelScreenControlDisplay(id, input.displayId));
  } catch (error) { return screenControlRouteError(error); }
}

export const OPTIONS = options;
