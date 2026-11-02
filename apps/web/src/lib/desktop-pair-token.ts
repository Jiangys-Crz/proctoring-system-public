import crypto from 'node:crypto';
import { hashClientSessionToken } from './client-auth';

// The private poll proof already authorizes delivery of the desktop token.
// Derive a stable token so a lost poll response can be retried without rotating
// the session's credential or storing its plaintext in the database.
export function desktopPairToken(pairingId: string, sessionId: string, pollProof: string) {
  const token = crypto.createHmac('sha256', pollProof)
    .update(JSON.stringify(['desktop-pair-session-v1', pairingId, sessionId])).digest('base64url');
  return { token, tokenHash: hashClientSessionToken(token) };
}
