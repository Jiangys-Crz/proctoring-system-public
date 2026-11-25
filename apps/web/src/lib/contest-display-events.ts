import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { AuthError } from './auth';
import { authorizeContestDisplay, getContestDisplayViewer, readContestDisplayConfig } from './contest-display-config';
import { contestDisplayControlState, contestDisplayResponse, contestDisplaySourcesUnchanged, readContestDisplayContent } from './contest-display-data';
import { createRequestAdmission } from './request-admission';

type Content = Awaited<ReturnType<typeof readContestDisplayContent>>;
type Config = Awaited<ReturnType<typeof readContestDisplayConfig>>;
type CachedRead = { revision: number; expires: number; promise: Promise<Content> };
const runtime = globalThis as typeof globalThis & {
  contestDisplayRuntime?: {
    events: EventEmitter;
    connections: Map<string, number>;
    reads: Map<string, CachedRead>;
    acquire: ReturnType<typeof createRequestAdmission>;
  };
};
const hub = runtime.contestDisplayRuntime ??= {
  events: new EventEmitter().setMaxListeners(0),
  connections: new Map(),
  reads: new Map(),
  acquire: createRequestAdmission(4, 24, 2500),
};

export function notifyContestDisplay(examId: string) {
  hub.reads.delete(examId);
  hub.events.emit(examId);
}

function sharedContent(examId: string, config: Config) {
  const current = hub.reads.get(examId);
  if (current?.revision === config.revision && current.expires > Date.now()) return current.promise;
  for (const [id, read] of hub.reads) if (read.expires <= Date.now()) hub.reads.delete(id);
  const entry: CachedRead = {
    revision: config.revision, expires: Infinity,
    promise: hub.acquire().then(async release => {
      try { return await readContestDisplayContent(examId, config); }
      finally { release(); }
    }).then(content => {
      entry.expires = Date.now() + 1_000;
      return content;
    }).catch(error => {
      if (hub.reads.get(examId) === entry) hub.reads.delete(examId);
      throw error;
    }),
  };
  if (hub.reads.size < 64 || current) hub.reads.set(examId, entry);
  return entry.promise;
}

export function openContestDisplayStream(request: Request, examId: string) {
  const count = hub.connections.get(examId) ?? 0;
  if (count >= 24 || [...hub.connections.values()].reduce((total, value) => total + value, 0) >= 96) {
    throw new AuthError('大屏连接数量已满，请稍后重试', 503);
  }
  hub.connections.set(examId, count + 1);
  const encoder = new TextEncoder();
  let dispose = () => {};
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true, reading = false, dirty = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let lifetime: ReturnType<typeof setTimeout> | undefined;
      let previous = '';
      let announced = -1;
      let pendingRevision: number | null = null;
      const close = () => {
        if (!open) return;
        open = false;
        request.signal.removeEventListener('abort', close);
        hub.events.off(examId, refresh);
        const remaining = (hub.connections.get(examId) ?? 1) - 1;
        if (remaining > 0) hub.connections.set(examId, remaining);
        else hub.connections.delete(examId);
        clearTimeout(timer);
        clearInterval(heartbeat);
        clearTimeout(lifetime);
        try { controller.close(); } catch { /* The HTTP consumer already closed. */ }
      };
      const enqueue = (message: string) => {
        if (!open) return;
        if ((controller.desiredSize ?? 0) < 1) { close(); return; }
        try { controller.enqueue(encoder.encode(message)); } catch { close(); }
      };
      function unavailable(error: unknown) {
        const message = error instanceof AuthError ? error.message : '大屏连接暂时中断，正在重新同步';
        if (previous !== message) {
          previous = message;
          enqueue(`event: unavailable\ndata: ${JSON.stringify({ message })}\n\n`);
        }
      }
      async function pushSnapshot(config: Config) {
        try {
          const content = await sharedContent(examId, config);
          if (!open) return;
          const [latest, viewer, sourcesUnchanged] = await Promise.all([
            readContestDisplayConfig(examId), getContestDisplayViewer(request, examId), contestDisplaySourcesUnchanged(examId, content),
          ]);
          authorizeContestDisplay(latest, viewer);
          if (latest.revision !== config.revision || !open) return;
          if (!sourcesUnchanged) throw new AuthError('大屏名单已更新，请重新同步', 409);
          const snapshot = contestDisplayResponse(config, content, viewer);
          const fingerprint = createHash('sha256').update(JSON.stringify({
            ...snapshot, serverTime: 0, contest: { ...snapshot.contest, updatedAt: null },
          })).digest('base64url');
          if (fingerprint !== previous) {
            previous = fingerprint;
            enqueue(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
          }
        } catch (error) {
          if (announced === config.revision) unavailable(error);
        } finally {
          if (pendingRevision === config.revision) pendingRevision = null;
        }
      }
      async function refresh() {
        if (!open) return;
        clearTimeout(timer);
        if (reading) { dirty = true; return; }
        reading = true;
        try {
          const [config, viewer] = await Promise.all([readContestDisplayConfig(examId), getContestDisplayViewer(request, examId)]);
          authorizeContestDisplay(config, viewer);
          if (!open) return;
          if (announced !== config.revision) {
            announced = config.revision;
            enqueue(`event: settings\ndata: ${JSON.stringify(contestDisplayControlState(config, viewer.manage))}\n\n`);
          }
          if (pendingRevision !== config.revision) {
            pendingRevision = config.revision;
            void pushSnapshot(config);
          }
        } catch (error) {
          unavailable(error);
        } finally {
          reading = false;
          if (open) {
            timer = setTimeout(refresh, dirty ? 0 : 1_250);
            dirty = false;
          }
        }
      }
      dispose = close;
      if (request.signal.aborted) { close(); return; }
      request.signal.addEventListener('abort', close, { once: true });
      hub.events.on(examId, refresh);
      enqueue('retry: 1500\n\n');
      heartbeat = setInterval(() => enqueue(': keepalive\n\n'), 10_000);
      lifetime = setTimeout(close, 55_000);
      void refresh();
    },
    cancel() { dispose(); },
  }, { highWaterMark: 3 });
}
