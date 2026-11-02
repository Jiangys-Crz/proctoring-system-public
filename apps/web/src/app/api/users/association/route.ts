import { AuthError, requireSuperAdmin } from '@/lib/auth';
import { AssociationImportSchema, importAssociationUsers } from '@/lib/association-users';
import { fail, ok, options, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';

export async function POST(request: Request) {
  try {
    await requireSuperAdmin(request);
    const { users } = await parseBody(request, AssociationImportSchema);
    return ok(await importAssociationUsers(users));
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
    return fail(toErrorMessage(error), 500);
  }
}
export const OPTIONS = options;
