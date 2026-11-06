import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { openReactionExportS3Object } from '../src/lib/reaction-export';
import { withS3Client } from '../src/lib/s3-client-pool';
import type { StorageSettings } from '../src/lib/settings';

/** Local HTTP S3-protocol fixture only; no configured bucket or credentials. */
test('S3 body keeps its pool lease through destination churn and releases on cancellation', { timeout: 10000 }, async () => {
  let finishBody: (() => void) | undefined;
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-length': '6', 'content-type': 'video/mp4' });
    if (request.method === 'HEAD') { response.end(); return; }
    response.write('abc');
    finishBody = () => response.end('def');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const settings = (index: number): StorageSettings => ({ provider: 'S3', localUploadDir: './unused', s3: {
    endpoint, region: 'us-east-1', bucket: 'isolated-fixture', accessKeyId: `fixture-${index}`, secretAccessKey: 'synthetic-test-only', forcePathStyle: true,
  } });
  try {
    const body = await openReactionExportS3Object(settings(0), 'reactions/fixture.mp4', new AbortController().signal);
    // This exceeds the pool's four-client budget while the first GET is open.
    for (let i = 1; i <= 5; i++) await withS3Client(settings(i), client => client.send(new HeadObjectCommand({ Bucket: 'isolated-fixture', Key: 'other.mp4' })));
    assert.equal(body.destroyed, false, 'a live response must not be evicted as an idle client');
    assert.ok(finishBody); finishBody();
    const chunks: Buffer[] = [];for await (const chunk of body) chunks.push(Buffer.from(chunk));
    assert.equal(Buffer.concat(chunks).toString(), 'abcdef');
    const controller = new AbortController();
    const cancelled = await openReactionExportS3Object(settings(6), 'reactions/cancelled.mp4', controller.signal);
    const closed = new Promise<void>(resolve => cancelled.once('close', () => resolve()));
    controller.abort();await closed;assert.equal(cancelled.destroyed, true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
