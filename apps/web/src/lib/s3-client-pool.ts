import { createHash } from 'node:crypto';
import { S3Client } from '@aws-sdk/client-s3';
import type { StorageSettings } from './settings';

type ClientEntry = { client: S3Client; active: number };
const clients = new Map<string, ClientEntry>();

/** Reuse TLS connections across recording PUTs and login HEADs. Keep old
 * destinations available to deletion jobs without retaining unbounded pools. */
export async function withS3Client<T>(settings: StorageSettings, operation: (client: S3Client) => Promise<T>): Promise<T> {
  const s3 = settings.s3;
  const key = createHash('sha256').update(JSON.stringify([
    s3.endpoint, s3.region || 'auto', s3.forcePathStyle, s3.accessKeyId, s3.secretAccessKey
  ])).digest('hex');
  let entry = clients.get(key);
  if (!entry) {
    entry = { active: 0, client: new S3Client({
      endpoint: s3.endpoint,
      region: s3.region || 'auto',
      forcePathStyle: s3.forcePathStyle,
      credentials: { accessKeyId: s3.accessKeyId!, secretAccessKey: s3.secretAccessKey! },
      requestHandler: { connectionTimeout: 5_000, requestTimeout: 120_000 }
    }) };
  }
  // Map insertion order tracks recent use. Never close an in-flight request
  // when settings change or a cleanup job accesses an older destination.
  clients.delete(key); clients.set(key, entry);
  entry.active++;
  try { return await operation(entry.client); }
  finally {
    entry.active--;
    for (const [oldKey, old] of clients) {
      if (clients.size <= 4) break;
      if (old.active) continue;
      clients.delete(oldKey); old.client.destroy();
    }
  }
}
