import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attachmentResponse } from '../src/lib/attachment-response';

test('active attachments download without inheriting upstream cookies or policy', async () => {
  for (const mime of ['text/html', 'application/xhtml+xml', 'application/pdf', 'application/javascript', 'application/octet-stream']) {
    const upstream = new Response('<script>fetch("/api/users")</script>', { headers: {
      'content-type': mime, 'content-disposition': 'inline', 'set-cookie': 'attacker=1',
      'content-security-policy': "script-src 'unsafe-inline'", 'refresh': '0;url=https://attacker.test',
    } });
    const response = attachmentResponse(upstream, "attachment';\r\n.html");
    assert.match(response.headers.get('content-disposition')!, /^attachment; filename\*=UTF-8''/);
    assert.ok(!response.headers.get('content-disposition')!.includes('\r'));
    assert.equal(response.headers.get('set-cookie'), null); assert.equal(response.headers.get('refresh'), null);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.match(response.headers.get('cache-control')!, /no-store/);
    assert.match(response.headers.get('content-security-policy')!, /^sandbox;/);
    assert.doesNotMatch(response.headers.get('content-security-policy')!, /allow-scripts|allow-same-origin/);
    assert.match(await response.text(), /script/);
  }
});

test('images remain inline but SVG documents are sandboxed; explicit download still works', () => {
  for (const mime of ['image/png', 'image/jpeg', 'image/svg+xml; charset=utf-8']) {
    const response = attachmentResponse(new Response('image', { headers: { 'content-type': mime } }), 'image.svg');
    assert.equal(response.headers.get('content-disposition'), null);
    assert.match(response.headers.get('content-security-policy')!, /default-src 'none'/);
  }
  const downloaded = attachmentResponse(new Response('image', { headers: { 'content-type': 'image/svg+xml' } }), 'figure.svg', true);
  assert.match(downloaded.headers.get('content-disposition')!, /^attachment;/);
});

test('attachment streaming exposes the first chunk without buffering and propagates cancellation', async () => {
  let cancelled = false;
  const upstream = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('first chunk')); },
    cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'application/octet-stream', 'content-length': '17179869184' } });
  const response = attachmentResponse(upstream, 'large.bin');
  assert.equal(upstream.bodyUsed, false);
  const reader = response.body!.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'first chunk');
  await reader.cancel('download stopped');
  assert.equal(cancelled, true);
});

test('compressed upstream lengths are dropped after fetch decoding, and partial statuses are preserved', () => {
  const compressed = attachmentResponse(new Response('decoded content', { headers: { 'content-encoding': 'gzip', 'content-length': '3' } }), 'file.txt');
  assert.equal(compressed.headers.get('content-length'), null);
  assert.equal(compressed.headers.get('content-encoding'), null);
  const partial = attachmentResponse(new Response('part', { status: 206, headers: { 'content-length': '4', 'content-range': 'bytes 0-3/100' } }), 'file.txt');
  assert.equal(partial.status, 206); assert.equal(partial.headers.get('content-range'), 'bytes 0-3/100');
  assert.equal(partial.headers.get('content-length'), '4');
});
