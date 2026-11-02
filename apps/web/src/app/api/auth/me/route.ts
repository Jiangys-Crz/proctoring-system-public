import { getCurrentUser } from '@/lib/auth';
import { options, ok } from '@/lib/http';

export async function GET() {
  const user = await getCurrentUser();
  return ok(
    user
      ? {
          id: user.id,
          username: user.username,
          numberId: user.numberId,
          nickname: user.nickname,
          realName: user.realName,
          email: user.email,
          role: user.role
        }
      : null
  );
}

export const OPTIONS = options;
