import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publicDto, stripCredentialHashes } from '../src/lib/public-dto';
import { ok } from '../src/lib/http';

test('public DTO strips nested credentials and preserves dates without changing the original', () => {
  const date = new Date();
  const input = { monitoringAlertState: { private: 'state' }, createdAt: date, password: 'private', passwordHash: 'hash', apiKey: 'key', externalBoardApiKey: 'push-key', nested: [{
    miniProgramTokenHash: 'mobile-hash', desktopTokenHash: 'desktop-hash', signingSecret: 'private', credentialTicket: 'ticket',
    user: { id: 'public-id', username: 'public-name', passwordHash: 'hash' },
  }] };
  const result = publicDto(input);
  assert.equal(result.createdAt, date);
  assert.deepEqual(Object.keys(result).sort(), ['createdAt', 'nested']);
  assert.deepEqual(result.nested, [{ user: { id: 'public-id', username: 'public-name' } }]);
  assert.equal(input.password, 'private'); assert.equal(input.nested[0].credentialTicket, 'ticket');
});

test('response safety net removes hashes while preserving explicitly authorized credential issuance/configuration', async () => {
  const issued = { desktopSessionToken: 'issued-desktop', miniProgramSessionToken: 'issued-mobile', pollToken: 'issued-poll', recoverySecret: 'issued-recovery',
    credentialTicket: 'issued-ticket', sharedSecret: 'authorized-settings', password: 'authorized-managed-candidate', externalBoardApiKey: 'must-never-leak', nested: { passwordHash: 'hash', desktopTokenHash: 'hash', monitoringAlertState: { private: 'state' } } };
  const safe = stripCredentialHashes(issued);
  assert.deepEqual(safe.nested, {});
  const response = await ok(issued).json();
  assert.equal(response.data.desktopSessionToken, issued.desktopSessionToken);
  assert.equal(response.data.miniProgramSessionToken, issued.miniProgramSessionToken);
  assert.equal(response.data.recoverySecret, issued.recoverySecret);
  assert.equal(response.data.credentialTicket, issued.credentialTicket);
  assert.equal(response.data.sharedSecret, issued.sharedSecret);
  assert.equal(response.data.password, issued.password);
  assert.deepEqual(response.data.nested, {});
  assert.equal(response.data.externalBoardApiKey, undefined);
});
