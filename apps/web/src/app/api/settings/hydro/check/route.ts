import { requireSuperAdmin, AuthError } from '@/lib/auth';
import { HydroConnectionSettingsSchema } from '@/lib/settings';
import { checkHydroConnection } from '@/lib/hydro-connection-check';
import { fail, ok, options, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    await requireSuperAdmin(request);
    const settings = await parseBody(request, HydroConnectionSettingsSchema);
    return ok(await checkHydroConnection(settings));
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
    return fail(toErrorMessage(error), 502);
  }
}

export const OPTIONS = options;
