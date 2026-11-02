import { createHash } from 'node:crypto';

export function mediaUploadIdentity(input: { examId: string; sessionId?: string; channel: string; uploadId?: string; startedAt?: string; buffer: Buffer }) {
  const digest = createHash('sha256').update(input.buffer).digest('hex');
  const identity = [input.examId, input.sessionId || 'unbound', input.channel,
    input.uploadId || `${input.startedAt ? new Date(input.startedAt).toISOString() : ''}:${digest}`];
  const id = `media_${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;
  return { id, digest };
}

export function mediaFileExtension(filename: string, contentType: string) {
  const extension = filename.match(/\.(webm|mp4|mov|m4v|jpg|jpeg|png|webp|heic)$/i)?.[0].toLowerCase();
  if (extension) return extension;
  if (contentType.includes('webm')) return '.webm';
  if (contentType.includes('mp4')) return '.mp4';
  if (contentType.includes('png')) return '.png';
  if (contentType.includes('jpeg')) return '.jpg';
  return '.bin';
}
