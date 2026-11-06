import { z } from 'zod';
import { AuthError, requireSuperAdmin } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { assertLiveKeyRequestOrigin } from '@/lib/live-api-key';
import { revealLiveApiKey } from '@/lib/live-api-secret';
import { parseBody, RequestParseError } from '@/lib/http';
const headers = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' };
export async function POST(request: Request) {
  try {
    await requireSuperAdmin(request); assertLiveKeyRequestOrigin(request);
    const { id } = await parseBody(request, z.object({ id: z.string().min(1).max(128) }), 1024);
    const key = await prisma.liveApiKey.findUnique({ where: { id }, select: { keyCiphertext: true, keyHash: true } });
    if (!key) throw new AuthError('直播密钥不存在', 404);
    return Response.json({ ok: true, data: { apiKey: revealLiveApiKey(key.keyCiphertext, key.keyHash) } }, { headers });
  } catch (error) {
    return Response.json({ ok: false, message: error instanceof AuthError || error instanceof RequestParseError ? error.message : '暂时无法读取直播密钥' },
      { status: error instanceof AuthError ? error.status : error instanceof RequestParseError ? 400 : 503, headers });
  }
}
