import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireSuperAdmin, AuthError } from '@/lib/auth';
import { assertLiveKeyRequestOrigin, generateLiveApiKey, liveApiKeyHash, liveKeyPublicSelect, LiveKeyCreateSchema, LiveKeyUpdateSchema } from '@/lib/live-api-key';
import { ok, fail, options, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';
import { stopLiveWebRtcConnections } from '@/lib/live-webrtc';
import { sealLiveApiKey } from '@/lib/live-api-secret';
import { stopRelayWebRtcConnections } from '@/lib/live-relay-connections';

async function stopKeyConnections(id: string) {
  const results = await Promise.allSettled([stopLiveWebRtcConnections(id), stopRelayWebRtcConnections(id)]);
  const failure = results.find(r => r.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
}

const responseOptions = { headers: { 'Cache-Control': 'private, no-store' } };
function failure(error: unknown) {
  if (error instanceof AuthError) return fail(error.message, error.status);
  if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
  return fail(toErrorMessage(error), 500);
}
export async function GET() {
  try {
    await requireSuperAdmin();
    const rows = await prisma.liveApiKey.findMany({ select: { ...liveKeyPublicSelect, keyCiphertext: true }, orderBy: { createdAt: 'desc' } });
    return ok(rows.map(({ keyCiphertext, ...record }) => ({ ...record, copyable: Boolean(keyCiphertext) })), responseOptions);
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try {
    await requireSuperAdmin(request); assertLiveKeyRequestOrigin(request);
    const input = await parseBody(request, LiveKeyCreateSchema), apiKey = generateLiveApiKey();
    const record = await prisma.liveApiKey.create({ data: { ...input, keyHash: liveApiKeyHash(apiKey), keyCiphertext: sealLiveApiKey(apiKey), keyPrefix: apiKey.slice(0, 13) }, select: liveKeyPublicSelect });
    return ok({ ...record, apiKey, copyable: true }, { ...responseOptions, status: 201 });
  } catch (error) { return failure(error); }
}
export async function PATCH(request: Request) {
  try {
    await requireSuperAdmin(request); assertLiveKeyRequestOrigin(request);
    const { id, ...data } = await parseBody(request, LiveKeyUpdateSchema);
    if (!await prisma.liveApiKey.findUnique({ where: { id }, select: { id: true } })) return fail('直播 API Key 不存在', 404);
    const record = await prisma.liveApiKey.update({ where: { id }, data, select: liveKeyPublicSelect });
    if (data.enabled === false) await stopKeyConnections(id);
    return ok(record, responseOptions);
  } catch (error) { return failure(error); }
}
export async function DELETE(request: Request) {
  try {
    await requireSuperAdmin(request); assertLiveKeyRequestOrigin(request);
    const { id } = await parseBody(request, z.object({ id: z.string().min(1).max(128) }));
    await prisma.liveApiKey.updateMany({ where: { id }, data: { enabled: false } });
    await stopKeyConnections(id);
    return ok(await prisma.liveApiKey.deleteMany({ where: { id } }), responseOptions);
  } catch (error) { return failure(error); }
}
export const OPTIONS = options;
