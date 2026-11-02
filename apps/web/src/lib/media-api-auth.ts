import { createHmac, timingSafeEqual } from 'node:crypto';
import { requiredEnv } from './env';
export function mediaApiToken() {
  return createHmac('sha256', process.env.MEDIA_PUBLISH_SECRET || requiredEnv('SESSION_SECRET')).update('proctor-private-media-api-v1').digest('base64url');
}
export function verifyMediaApiToken(value: string) {
  const left = Buffer.from(value), right = Buffer.from(mediaApiToken());
  return left.length === right.length && timingSafeEqual(left, right);
}
