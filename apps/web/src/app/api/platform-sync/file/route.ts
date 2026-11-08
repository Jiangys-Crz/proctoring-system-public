import { admittedPlatformSync } from '@/lib/platform-sync-admission';
import { prepareBankUpload, receiveBankUpload, recordBankUploadFailure } from '@/lib/platform-sync-upload';
import { PlatformItemSchema } from '@/lib/platform-sync-protocol';
import { ok } from '@/lib/http';
import { z } from 'zod';
import { authenticatePlatformSync, withPlatformLease } from '@/lib/platform-sync';
import { bankFileResponse } from '@/lib/platform-sync-bank';
import { FederationError } from '@/lib/exam-federation-protocol';
import { parseBody, RequestParseError, fail } from '@/lib/http';
export const runtime = 'nodejs';
const downloadSchema = z.object({ itemId: z.string().min(1).max(191), area: z.enum(['data','files']), name: z.string().min(1).max(1024), hash: z.string().regex(/^[a-f0-9]{64}$/) });
async function postFile(request: Request) {
  try {
    const settings = await authenticatePlatformSync(request); const input = await parseBody(request, z.union([downloadSchema,z.object({ action:z.literal('prepare'), item:PlatformItemSchema, peerId:z.string().uuid() })]), 20 * 1024 * 1024);
    if ('action' in input && input.peerId !== settings.nodeId) throw new FederationError('目标服务器节点已改变，已停止文件推送',409);
    if ('action' in input) return ok(await withPlatformLease(() => prepareBankUpload(input.item, settings), settings.revision));
    const response = await bankFileResponse(input.itemId, input.area, input.name, input.hash);
    return new Response(response.body, { status: response.status, headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' } });
  } catch (error) {
    if (error instanceof FederationError) return fail(error.message, error.status);
    if (error instanceof RequestParseError) return fail(error.message, 400);
    return fail('题目文件暂不可用', 503);
  }
}

async function putFile(request: Request) {
  let authenticated = false;
  try { const settings = await authenticatePlatformSync(request); authenticated = true; return ok(await receiveBankUpload(request, settings)); }
  catch (error) {
    if (authenticated) await recordBankUploadFailure(request, error).catch(() => {});
    if (error instanceof FederationError) return fail(error.message,error.status); return fail('题目文件上传失败',503);
  }
}

export async function POST(request: Request) { return admittedPlatformSync(request, () => postFile(request), true); }
export async function PUT(request: Request) { return admittedPlatformSync(request, () => putFile(request), true); }
