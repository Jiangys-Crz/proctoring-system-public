import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireSuperAdmin, AuthError } from '@/lib/auth';
import { assertLiveKeyRequestOrigin, generateLiveApiKey, liveApiKeyHash, liveKeyPublicSelect, LiveKeyCreateSchema, LiveKeyUpdateSchema } from '@/lib/live-api-key';
import { ok, fail, options, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';
import { stopLiveWebRtcConnections } from '@/lib/live-webrtc';

const responseOptions = { headers: { 'Cache-Control': 'private, no-store' } };
function failure(error: unknown) {
  if (error instanceof AuthError) return fail(error.message, error.status);
  if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
  return fail(toErrorMessage(error), 500);
}
export async function GET() {
  try {
    await requireSuperAdmin();
    return ok(await prisma.liveApiKey.findMany({ select: liveKeyPublicSelect, orderBy: { createdAt: 'desc' } }), responseOptions);
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try {
    await requireSuperAdmin(request); assertLiveKeyRequestOrigin(request);
    const input = await parseBody(request, LiveKeyCreateSchema), apiKey = generateLiveApiKey();
    const record = await prisma.liveApiKey.create({ data: { ...input, keyHash: liveApiKeyHash(apiKey), keyPrefix: apiKey.slice(0, 13) }, select: liveKeyPublicSelect });
    return ok({ ...record, apiKey }, { ...responseOptions, status: 201 });
  } catch (error) { return failure(error); }
}
export async function PATCH(request: Request) {
  try {
    await requireSuperAdmin(request); assertLiveKeyRequestOrigin(request);
    const { id, ...data } = await parseBody(request, LiveKeyUpdateSchema);
    if (!await prisma.liveApiKey.findUnique({ where: { id }, select: { id: true } })) return fail('直播 API Key 不存在', 404);
    const record = await prisma.liveApiKey.update({ where: { id }, data, select: liveKeyPublicSelect });
    if (data.enabled === false) await stopLiveWebRtcConnections(id);
    return ok(record, responseOptions);
  } catch (error) { return failure(error); }
}
export async function DELETE(request: Request) {
  try {
    await requireSuperAdmin(request); assertLiveKeyRequestOrigin(request);
    const { id } = await parseBody(request, z.object({ id: z.string().min(1).max(128) }));
    await prisma.liveApiKey.updateMany({ where: { id }, data: { enabled: false } });
    await stopLiveWebRtcConnections(id);
    return ok(await prisma.liveApiKey.deleteMany({ where: { id } }), responseOptions);
  } catch (error) { return failure(error); }
}
export const OPTIONS = options;
