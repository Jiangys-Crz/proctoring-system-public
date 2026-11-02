import { AuthError, requireUser } from '@/lib/auth';
import { requestHydroLanguages } from '@/lib/hydro-contest';
import { fail, ok, toErrorMessage } from '@/lib/http';
export async function GET() {
  try {
    await requireUser();
    return ok(await requestHydroLanguages());
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    return fail(toErrorMessage(error), 502);
  }
}
