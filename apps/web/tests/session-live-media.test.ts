import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSessionLiveMediaStopper, stopSessionLiveMedia } from '../src/lib/session-live-media';

const streams = {
  screen: 'live/current_DESKTOP_SCREEN',
  camera: 'live/current_DESKTOP_CAMERA',
  phone: 'live/current_MOBILE_CAMERA',
};
const id = (index: number) => `01234567-1234-1234-1234-${String(index).padStart(12, '0')}`;
const page = (items: object[], pageCount = 1) => Response.json({ items, itemCount: items.length, pageCount });

test('disconnects only exact selected session channels, including attached and negotiating peers', async () => {
  const kicks: string[] = [];
  const requests = new Set<string>();
  const stop = createSessionLiveMediaStopper({
    base: () => 'http://media.test:9997',
    token: () => 'private-test-token',
    fetch: async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, 'http://media.test:9997');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer private-test-token');
      assert.equal(init?.redirect, 'error');
      requests.add(url.pathname + url.search);
      if (init?.method === 'POST') {
        kicks.push(url.pathname);
        return new Response(null, { status: url.pathname.endsWith(id(3)) ? 404 : 200 });
      }
      if (url.pathname === '/v3/paths/list') {
        return url.searchParams.get('page') === '0' ? page([
          { name: 'live/other-current_DESKTOP_SCREEN', source: { type: 'webRTCSession', id: id(25) } },
          { name: 'voice/current_DESKTOP_SCREEN', readers: [{ type: 'hlsSession', id: id(26) }] },
          { name: streams.phone, source: { type: 'webRTCSession', id: id(27) } },
        ], 2) : page([{
          name: streams.screen, source: { type: 'rtmpsConn', id: id(1) },
          readers: [{ type: 'webRTCSession', id: id(2) }, { type: 'hlsSession', id: id(3) }],
        }], 2);
      }
      if (url.pathname === '/v3/webrtc/sessions/list') return page([
        { path: streams.screen, id: id(2) },
        { path: streams.camera, id: id(4) },
        { path: streams.phone, id: id(28) },
      ]);
      if (url.pathname === '/v3/hls/sessions/list') return page([{ path: streams.screen, id: id(3) }]);
      if (url.pathname === '/v3/rtmps/conns/list') return page([{ path: streams.screen, id: id(1) }]);
      assert.equal(url.pathname, '/v3/rtmp/conns/list');
      return new Response(null, { status: 404 }); // plain RTMP disabled
    },
  });

  await stop(new Set([streams.screen, streams.camera]));
  assert.ok(requests.has('/v3/paths/list?itemsPerPage=250&page=1'));
  assert.deepEqual(kicks.sort(), [
    `/v3/hls/sessions/kick/${id(3)}`, `/v3/rtmps/conns/kick/${id(1)}`,
    `/v3/webrtc/sessions/kick/${id(2)}`, `/v3/webrtc/sessions/kick/${id(4)}`,
  ]);
});

test('best-effort disconnects known peers but rejects an inventory or teardown failure for retry', async () => {
  const kicks: string[] = [];
  const stop = createSessionLiveMediaStopper({
    base: () => 'http://media.test:9997',
    token: () => 'private-test-token',
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (init?.method === 'POST') {
        kicks.push(url.pathname);
        return new Response(null, { status: url.pathname.endsWith(id(1)) ? 503 : 200 });
      }
      if (url.pathname === '/v3/paths/list') return new Response(null, { status: 500 });
      if (url.pathname === '/v3/webrtc/sessions/list') return page([{ path: streams.screen, id: id(1) }, { path: streams.screen, id: id(2) }]);
      return page([], 0);
    },
  });
  await assert.rejects(stop(new Set([streams.screen])), /无法列出/);
  assert.equal(kicks.length, 2);
});

test('tracking rows are cleared only for stopped channels after successful media cleanup', async () => {
  const original = globalThis.fetch;
  const secret = process.env.MEDIA_PUBLISH_SECRET;
  process.env.MEDIA_PUBLISH_SECRET = 'synthetic-session-media-secret';
  let available = false;
  globalThis.fetch = (async () => available ? page([], 0) : new Response(null, { status: 503 })) as typeof fetch;
  const deletes: unknown[] = [];
  const deleting = { deleteMany: async (query: unknown) => { deletes.push(query); return { count: 1 }; } };
  const db = { liveWebRtcConnection: deleting, contestLiveConnection: deleting } as unknown as NonNullable<Parameters<typeof stopSessionLiveMedia>[2]>;
  try {
    await assert.rejects(stopSessionLiveMedia(['current', 'current'], ['DESKTOP_CAMERA'], db));
    assert.deepEqual(deletes, []);
    available = true;
    await stopSessionLiveMedia(['current', 'current'], ['DESKTOP_CAMERA'], db);
    assert.deepEqual(deletes, Array.from({ length: 2 }, () => ({
      where: { sessionId: { in: ['current'] }, channel: { in: ['DESKTOP_CAMERA'] } },
    })));
  } finally {
    globalThis.fetch = original;
    if (secret === undefined) delete process.env.MEDIA_PUBLISH_SECRET;
    else process.env.MEDIA_PUBLISH_SECRET = secret;
  }
});
