import { AuthError, requireSuperAdmin } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { getPlatformSyncSettings, publicPlatformSyncSettings, publicPlatformSyncKey, savePlatformSyncSettings, PlatformSyncSettingsSchema } from '@/lib/platform-sync-settings';
import { FederationError } from '@/lib/exam-federation-protocol';
import { fail, ok, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';
import { z } from 'zod';
import { countPlatformPending, platformPendingReasons } from '@/lib/platform-sync-status';
import { readBankFileProgress } from '@/lib/platform-sync-bank-progress';
function assertSettingsOrigin(request: Request) {
  const origin = request.headers.get('origin');
  const allowed = [new URL(request.url).origin];
  if (process.env.APP_BASE_URL) allowed.push(new URL(process.env.APP_BASE_URL).origin);
  if (origin && !allowed.includes(origin)) throw new AuthError('请求来源无效', 403);
}
export async function GET() {
  try {
    await requireSuperAdmin(); const settings = await getPlatformSyncSettings();
    const state = await prisma.platformSyncState.findUnique({ where: { id: 'peer' }, select: { lastError: true, lastSuccessAt: true } });
    const [pending, pendingReasons, bankFileProgress, uploadFailures] = await Promise.all([countPlatformPending(), platformPendingReasons(), readBankFileProgress(), prisma.systemSetting.findMany({ where: { key: { startsWith: 'bank-upload-error:' }, updatedAt: { gt: new Date(Date.now() - 30 * 60_000) } }, orderBy: { updatedAt: 'desc' }, take: 3, select: { value: true } })]);
    const waiting = pending ? await prisma.platformSyncInbox.findFirst({ where: { lastError: { not: null } }, orderBy: { lastAttemptAt: 'desc' }, select: { lastError: true } }) : null;
    return ok({ ...publicPlatformSyncSettings(settings), ...state, pendingCount: pending, pendingReasons, bankFileProgress, recentUploadErrors: uploadFailures.map(row => (row.value as { error: string }).error), lastError: state?.lastError || waiting?.lastError || '' }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { if (error instanceof AuthError || error instanceof FederationError) return fail(error.message, error.status); return fail(toErrorMessage(error), 500); }
}
export async function PUT(request: Request) {
  try { await requireSuperAdmin(request); assertSettingsOrigin(request); return ok(await savePlatformSyncSettings(await parseBody(request, PlatformSyncSettingsSchema)), { headers: { 'Cache-Control': 'no-store' } }); }
  catch (error) { if (error instanceof AuthError || error instanceof FederationError) return fail(error.message, error.status); if (error instanceof RequestParseError) return fail(error.message, 400); return fail(toErrorMessage(error), 500); }
}
export async function POST(request: Request) {
  try {
    await requireSuperAdmin(request); assertSettingsOrigin(request);
    const input = await parseBody(request, z.object({ action: z.enum(['generate', 'reveal']) }));
    return ok(await publicPlatformSyncKey(input.action === 'generate'), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof AuthError || error instanceof FederationError) return fail(error.message, error.status);
    if (error instanceof RequestParseError) return fail(error.message, 400);
    return fail(toErrorMessage(error), 500);
  }
}
