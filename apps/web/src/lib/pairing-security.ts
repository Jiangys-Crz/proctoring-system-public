import crypto from 'node:crypto';

export type PairSecretPurpose = 'POLL' | 'RECOVERY';
export const PAIR_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export function hashPairSecret(purpose: PairSecretPurpose, value: string) {
  return crypto.createHash('sha256').update(`proctor-pair-v1:${purpose}:${value}`).digest('hex');
}
export function createPairSecret(purpose: PairSecretPurpose) {
  const secret = crypto.randomBytes(32).toString('base64url');
  return { secret, hash: hashPairSecret(purpose, secret) };
}
export function verifyPairSecret(purpose: PairSecretPurpose, value: string | null | undefined, expected: string | null | undefined) {
  if (!value || !expected || !PAIR_SECRET_PATTERN.test(value)) return false;
  const left = Buffer.from(hashPairSecret(purpose, value));
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
