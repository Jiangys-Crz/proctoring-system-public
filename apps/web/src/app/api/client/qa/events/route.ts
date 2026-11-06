import { prisma } from '@/lib/db';
import { clientSessionTokenFromRequest, verifyClientTokenForAnySide } from '@/lib/client-auth';
import { qaEventHub, qaEventSessionSelect } from '@/lib/qa-event-hub';
import { createRequestAdmission, isRequestAdmissionError, RequestAdmissionError } from '@/lib/request-admission';
import { fail } from '@/lib/http';

const shared = globalThis as typeof globalThis & { qaEventConnectAdmission?: ReturnType<typeof createRequestAdmission> };
const acquireConnect = shared.qaEventConnectAdmission ??= createRequestAdmission(8, 128, 3000);

export const dynamic = 'force-dynamic';

async function openEvents(request: Request) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get('sessionId') || '';
  const session = sessionId ? await prisma.clientSession.findUnique({ where: { id: sessionId }, select: qaEventSessionSelect }) : null;
  if (!session || !verifyClientTokenForAnySide(request, session)) return new Response('Unauthorized', { status: 401 });

  const encoder = new TextEncoder();
  let unsubscribe = () => {};
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = () => {
        if (closed) return;
        closed = true;
        request.signal.removeEventListener('abort', abort);
        try { controller.close(); } catch { /* Reader cancellation may close first. */ }
      };
      const abort = () => unsubscribe();
      if (request.signal.aborted) { close(); return; }
      controller.enqueue(encoder.encode('retry: 1000\nevent: connected\ndata: {}\n\n'));
      unsubscribe = qaEventHub.subscribe({
        session, token: clientSessionTokenFromRequest(request), since: new Date(url.searchParams.get('since') || ''), close,
        send(chunk) {
          if (closed) throw new Error('Stream closed');
          const bytes = encoder.encode(chunk);
          if ((controller.desiredSize ?? 0) < bytes.byteLength) throw new Error('Slow stream reader');
          controller.enqueue(bytes);
        },
      });
      request.signal.addEventListener('abort', abort, { once: true });
      if (request.signal.aborted) unsubscribe();
    },
    cancel() { unsubscribe(); },
  }, { highWaterMark: 64 * 1024, size: chunk => chunk.byteLength });
  return new Response(stream, { headers: {
    'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive', 'x-accel-buffering': 'no',
  } });
}

export async function GET(request: Request) {
  let release: (() => void) | undefined;
  try {
    // This slot covers authentication/registration only. The hub separately
    // accounts for the complete connection lifetime and releases on close.
    release = await acquireConnect(request.signal);
    if (request.signal.aborted) throw new RequestAdmissionError();
    return await openEvents(request);
  } catch (error) {
    if (!isRequestAdmissionError(error) && !(error && typeof error === 'object' && 'code' in error && error.code === 'PROCTOR_QA_EVENT_CAPACITY')) throw error;
    const response = fail('答疑推送连接繁忙，请稍后重试', 503);
    response.headers.set('Retry-After', '3');
    return response;
  } finally { release?.(); }
}
