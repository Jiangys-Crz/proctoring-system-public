import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSessionToken, verifySessionToken } from '../src/lib/auth';
import { createMediaReadToken, verifyMediaReadToken } from '../src/lib/media-read-token';

test('two monitor logins for the same account remain valid independently', () => {
  const user = { id: 'proctor-1', role: 'ADMIN' as const, username: 'proctor', numberId: '1001' };
  const originalNow = Date.now;
  const issuedAt = originalNow();
  let first: string;
  let second: string;
  try {
    Date.now = () => issuedAt;
    first = createSessionToken(user);
    Date.now = () => issuedAt + 5_000;
    second = createSessionToken(user);
  } finally {
    Date.now = originalNow;
  }
  assert.notEqual(first!, second!);
  assert.equal(verifySessionToken(first!)?.sub, user.id);
  assert.equal(verifySessionToken(second!)?.sub, user.id);

  const firstViewer = createMediaReadToken(user.id, 'session-1', 'DESKTOP_SCREEN');
  const secondViewer = createMediaReadToken(user.id, 'session-1', 'DESKTOP_SCREEN');
  assert.equal(verifyMediaReadToken(firstViewer, 'session-1', 'DESKTOP_SCREEN')?.userId, user.id);
  assert.equal(verifyMediaReadToken(secondViewer, 'session-1', 'DESKTOP_SCREEN')?.userId, user.id);
});
