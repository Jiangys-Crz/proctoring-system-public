import { prisma } from '@/lib/db';
import { clientSessionTokenFromRequest, hashClientSessionToken } from '@/lib/client-auth';
import { ok, fail, options } from '@/lib/http';

export async function GET(request: Request) {
  const token=clientSessionTokenFromRequest(request);
  if(!token) return fail('客户端会话令牌必填',401);
  const session=await prisma.clientSession.findFirst({where:{desktopTokenHash:hashClientSessionToken(token),revokedAt:null},select:{id:true}});
  if(!session) return fail('客户端会话无效',401);
  return ok({serverTime:Date.now()},{headers:{'cache-control':'no-store'}});
}
export const OPTIONS=options;
