import { admittedPlatformSync } from '@/lib/platform-sync-admission';
import { authenticatePlatformSync, withPlatformLease, capturePlatform, mergePlatformItems, publicExamBundle, bindPlatformPeer } from '@/lib/platform-sync';
import { PlatformExchangeSchema, PLATFORM_SYNC_PROTOCOL } from '@/lib/platform-sync-protocol';
import { readPlatformPage, hasPlatformBacklog } from '@/lib/platform-sync-store';
import { FederationError } from '@/lib/exam-federation-protocol';
import { parseBody, RequestParseError, fail } from '@/lib/http';
import { platformTransaction } from '@/lib/platform-sync-lock';
import { countPlatformPending } from '@/lib/platform-sync-status';
export const runtime = 'nodejs';
async function exchange(request: Request) {
  try {
    const settings = await authenticatePlatformSync(request);
    const input = await parseBody(request, PlatformExchangeSchema, 20 * 1024 * 1024);
    const data = await withPlatformLease(async () => {
      if (input.action === 'exam') return publicExamBundle(input.examCode, settings, input.after, input.snapshot);
      if (input.peerId && input.peerId !== settings.nodeId) throw new FederationError('目标服务器节点已改变，不能写入已有同步资料', 409);
      await bindPlatformPeer(input.nodeId, settings);
      if (input.action === 'hello') return { protocol: PLATFORM_SYNC_PROTOCOL, nodeId: settings.nodeId, after: '0', entries: [] };
      // Capture once at the start of a bounded exchange. Re-capturing live
      // heartbeats on every page moves unread journal rows beyond the cursor.
      // Old peers omit the hint and keep the existing capture behavior.
      if (input.captureChanges !== false && !await hasPlatformBacklog(BigInt(input.after), input.nodeId)) await capturePlatform(settings);
      await mergePlatformItems(input.entries, settings);
      const page = await readPlatformPage(BigInt(input.after), input.nodeId);
      await platformTransaction(async tx => {
        const pending = await countPlatformPending(tx);
        // This acknowledges only the page the peer had already committed when
        // issuing the request, never the response currently being produced.
        await tx.platformSyncState.updateMany({ where: { id: 'peer', pushCursor: { lt: BigInt(input.after) } }, data: { pushCursor: BigInt(input.after) } });
        await tx.platformSyncState.update({ where: { id: 'peer' }, data: { lastSuccessAt: new Date(), lastError: pending ? `有 ${pending} 条资料正在补传或等待依赖，数据已保留；具体原因见下方` : null } });
      });
      return { protocol: PLATFORM_SYNC_PROTOCOL, nodeId: settings.nodeId, ...page };
    }, settings.revision, input.action === 'exam' ? 15_000 : 0);
    return Response.json({ ok: true, data }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof FederationError) return fail(error.message, error.status);
    if (error instanceof RequestParseError) return fail(error.message, 400);
    console.error('Platform sync exchange unavailable'); return fail('同步服务暂不可用，将自动重试', 503);
  }
}

export async function POST(request: Request) { return admittedPlatformSync(request, () => exchange(request)); }
