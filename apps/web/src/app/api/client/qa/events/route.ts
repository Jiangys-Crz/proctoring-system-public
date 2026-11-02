import { prisma } from '@/lib/db';
import { clientSessionTokenFromRequest, verifyClientTokenForAnySide } from '@/lib/client-auth';
import { qaEventHub, qaEventSessionSelect } from '@/lib/qa-event-hub';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
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
  }, { highWaterMark: 256 * 1024, size: chunk => chunk.byteLength });
  return new Response(stream, { headers: {
    'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive', 'x-accel-buffering': 'no',
  } });
}
