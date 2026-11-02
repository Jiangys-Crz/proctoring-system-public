import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createVoiceMediaToken, verifyVoiceMediaToken, voiceStreamPath } from '../src/lib/voice-call-token';
import { voiceCallEndReason, voiceResource } from '../src/lib/voice-call';

test('voice capabilities bind the exact call, source direction and operation without accepting live-video tokens', () => {
  const now = Date.now();
  for (const side of ['ADMIN', 'DESKTOP'] as const) for (const mode of ['publish', 'read'] as const) {
    const token = createVoiceMediaToken('call', side, mode, 'credential', now), path = voiceStreamPath('call', side, mode);
    assert.equal(verifyVoiceMediaToken(token, path, mode, now)?.side, side);
    assert.equal(verifyVoiceMediaToken(token, path.replace('call', 'other-call'), mode, now), null);
    assert.equal(verifyVoiceMediaToken(token, path, mode === 'read' ? 'publish' : 'read', now), null);
    assert.equal(verifyVoiceMediaToken(token, path, mode, now + 61000), null);
    assert.equal(verifyVoiceMediaToken(token + '.extra', path, mode, now), null);
    assert.equal(verifyVoiceMediaToken(token, '/live/session_DESKTOP_SCREEN', mode, now), null);
  }
  assert.equal(voiceStreamPath('call', 'ADMIN', 'read'), '/voice/call_DESKTOP');
  assert.equal(voiceStreamPath('call', 'DESKTOP', 'read'), '/voice/call_ADMIN');
});
test('ringing, setup and active calls have bounded leases; ended calls never revive', () => {
  const now = Date.now(), date = new Date(now), base = { status: 'RINGING' as const, createdAt: date, adminSeenAt: date, desktopSeenAt: null, acceptedAt: null };
  assert.equal(voiceCallEndReason(base, now), null);
  assert.equal(voiceCallEndReason({ ...base, createdAt: new Date(now - 46000) }, now), 'UNANSWERED');
  assert.equal(voiceCallEndReason(base, now + 21000), 'NETWORK');
  assert.equal(voiceCallEndReason({ ...base, status: 'CONNECTING', desktopSeenAt: date, acceptedAt: new Date(now - 31000) }, now), 'NETWORK');
  assert.equal(voiceCallEndReason({ ...base, status: 'ACTIVE', desktopSeenAt: date, acceptedAt: date }, now), null);
  assert.equal(voiceCallEndReason({ ...base, status: 'ACTIVE', desktopSeenAt: new Date(now - 21000), acceptedAt: date }, now), 'NETWORK');
  assert.equal(voiceCallEndReason({ ...base, status: 'ENDED' }, now + 60000), null);
});
test('media resource locations cannot escape their own call, direction, mode or trusted server', () => {
  const id = '01234567-89ab-4cde-8fab-0123456789ab', base = 'http://127.0.0.1:8889', path = '/voice/call_ADMIN';
  assert.equal(voiceResource(`${path}/whip/${id}`, base, path, 'publish'), id);
  for (const location of [`https://other.example${path}/whip/${id}`, `/voice/other_ADMIN/whip/${id}`, `${path}/whep/${id}`, `${path}/whip/${id}?token=x`, `${path}/whip/not-a-uuid`]) {
    assert.throws(() => voiceResource(location, base, path, 'publish'));
  }
});
