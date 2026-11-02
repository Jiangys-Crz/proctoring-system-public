import { requireSuperAdmin, AuthError } from '@/lib/auth';
import { generateHydroApiKey } from '@/lib/hydro-api-key';
import { fail, ok, options, toErrorMessage } from '@/lib/http';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    await requireSuperAdmin(request);
    return ok({ apiKey: generateHydroApiKey() }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    return fail(toErrorMessage(error), 500);
  }
}

export const OPTIONS = options;
