import { createHmac } from 'node:crypto';
import { hashClientSessionToken } from './client-auth';

/** A retried recovery returns the same credential without storing plaintext.
 * The pairing's expiry, original device binding and current token hash must
 * still match before this value may be delivered. */
export function mobileRecoveryToken(pairingId: string, sessionId: string, deviceId: string, proof: string) {
  const token = createHmac('sha256', proof).update(JSON.stringify([
    'mobile-recovery-session-v1', pairingId, sessionId, deviceId
  ])).digest('base64url');
  return { token, tokenHash: hashClientSessionToken(token) };
}
