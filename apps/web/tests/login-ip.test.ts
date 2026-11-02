import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLoginIp, desktopRequestIp, assertLoginIp } from '../src/lib/login-ip';

test('IPv4 and IPv6 identities normalize without accepting ports, names or invalid addresses', () => {
  assert.equal(normalizeLoginIp('::ffff:192.0.2.10'), '192.0.2.10');
  assert.equal(normalizeLoginIp('2001:0DB8:0:0:0:0:0:1'), '2001:db8::1');
  for (const value of ['192.0.2.10:80', '192.000.2.10', 'localhost', 'bad', '', '192.0.2.1,192.0.2.2']) assert.equal(normalizeLoginIp(value), null);
});
test('request IP comes from the reverse proxy and restriction switches take effect immediately', () => {
  const request = new Request('https://proctor.example/api/client/pair', { headers: { 'x-forwarded-for': '192.0.2.10' } });
  assert.equal(desktopRequestIp(request), '192.0.2.10');
  assert.equal(desktopRequestIp(new Request('https://proctor.example/api/client/pair')), null);
  assert.doesNotThrow(() => assertLoginIp(true, null, '192.0.2.10'));
  assert.doesNotThrow(() => assertLoginIp(true, '192.0.2.10', '192.0.2.10'));
  assert.throws(() => assertLoginIp(true, '192.0.2.10', '192.0.2.20'), /解除一次/);
  assert.throws(() => assertLoginIp(true, null, null), /无法确认/);
  assert.doesNotThrow(() => assertLoginIp(false, '192.0.2.10', '192.0.2.20'));
});
