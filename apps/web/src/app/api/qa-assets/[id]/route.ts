import { prisma } from '@/lib/db';
import { keyHash } from '@/lib/exam-federation-protocol';
import { createRequestAdmission } from '@/lib/request-admission';
import { holdAttachment } from '@/lib/attachment-admission';

export const runtime = 'nodejs';
const shared = globalThis as typeof globalThis & { qaAssetAdmission?: ReturnType<typeof createRequestAdmission> };
const acquire = shared.qaAssetAdmission ??= createRequestAdmission(2, 16, 3000);
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  let release: (() => void) | undefined;
  try {
    const { id } = await context.params, key = new URL(request.url).searchParams.get('key') || '';
    if (!/^[a-f0-9-]{36}$/i.test(id) || !/^[A-Za-z0-9_-]{43}$/.test(key)) return new Response(null, { status: 404 });
    release = await acquire(request.signal);
    const asset = await prisma.examFederationAsset.findFirst({ where: { id, accessKeyHash: keyHash(key), expiresAt: { gt: new Date() } }, select: { bytes: true, byteSize: true } });
    if (!asset) return new Response(null, { status: 404 });
    let offset = 0, data: Uint8Array | null = asset.bytes;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!data) return;
        const end = Math.min(data.length, offset + 65536);
        if (offset < end) { controller.enqueue(data.subarray(offset, end)); offset = end; }
        if (offset === data.length) { controller.close(); data = null; }
      }, cancel() { data = null; },
    });
    const response = new Response(body, { headers: { 'Content-Type': 'image/webp', 'Content-Length': String(asset.byteSize),
      'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Access-Control-Allow-Origin': '*' } });
    const streamed = holdAttachment(response, request.signal, release);
    release = undefined;
    return streamed;
  } catch { return new Response(null, { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '3' } }); }
  finally { release?.(); }
}
