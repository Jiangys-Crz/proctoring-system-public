import { StorageSettingsSchema, getStorageSettings, saveStorageSettings } from '@/lib/settings';
import { AuthError, requireSuperAdmin } from '@/lib/auth';
import { options, fail, ok, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';

export async function GET() {
  try {
    await requireSuperAdmin();
    const settings = await getStorageSettings();
    return ok(settings);
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    return fail(toErrorMessage(error), 500);
  }
}

export async function PUT(request: Request) {
  try {
    await requireSuperAdmin(request);
    const input = await parseBody(request, StorageSettingsSchema);
    const settings = await saveStorageSettings(input);
    return ok(settings);
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
    return fail(toErrorMessage(error), 500);
  }
}

export const OPTIONS = options;
