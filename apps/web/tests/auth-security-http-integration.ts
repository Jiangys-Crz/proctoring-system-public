// Start a locally built server against this same disposable database first.
// DATABASE_URL=mysql://.../proctor_csrf_qa SECURITY_QA_BASE=http://127.0.0.1:... tsx tests/auth-security-http-integration.ts
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '../src/lib/db';
import { digestPasswordForStorage } from '../src/lib/password-crypto';

const database = new URL(process.env.DATABASE_URL || '');
assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.pathname, '/proctor_csrf_qa', 'never run against application data');
const base = new URL(process.env.SECURITY_QA_BASE || '');
assert.ok(['localhost', '127.0.0.1'].includes(base.hostname));
const prefix = `csrf-${randomUUID()}`, password = randomUUID();
let userId = '';
const key = 'externalLogin';
const previous = await prisma.systemSetting.findUnique({ where: { key } });
const initial = { apiBase: 'http://127.0.0.1:9/original', appKey: prefix };
const changed = { apiBase: 'http://127.0.0.1:9/updated', appKey: `${prefix}-changed` };

try {
  const user = await prisma.user.create({ data: { username: prefix, role: 'SUPER_ADMIN',
    passwordHash: await bcrypt.hash(digestPasswordForStorage(password), 4) } });
  userId = user.id;
  await prisma.systemSetting.upsert({ where: { key }, create: { key, value: initial }, update: { value: initial } });
  const loginBody = JSON.stringify({ username: prefix, password });
  const rejectedLogin = await fetch(`${base.origin}/api/auth/admin-login`, { method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example.test' }, body: loginBody });
  assert.equal(rejectedLogin.status, 403);
  assert.equal(rejectedLogin.headers.get('set-cookie'), null);
  const login = await fetch(`${base.origin}/api/auth/admin-login`, { method: 'POST',
    headers: { 'content-type': 'application/json', origin: base.origin }, body: loginBody });
  assert.equal(login.status, 200, await login.clone().text());
  const setCookie = login.headers.get('set-cookie');
  assert.ok(setCookie);
  assert.ok(setCookie.includes('HttpOnly'));
  const cookie = setCookie.split(';')[0];
  const endpoint = `${base.origin}/api/settings/external-login`;
  const read = await fetch(endpoint, { headers: { cookie, origin: 'https://evil.example.test' } });
  assert.equal(read.status, 200, 'GET authorization remains unchanged');
  assert.deepEqual((await read.json()).data, initial);

  const forgedHeaders: Record<string, string>[] = [
    { origin: 'https://evil.example.test' },
    { origin: 'null' },
    { origin: 'https://evil.example.test', 'sec-fetch-site': 'same-origin', 'x-forwarded-host': 'evil.example.test' },
    { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'same-site' },
  ];
  for (const headers of forgedHeaders) {
    const response = await fetch(endpoint, { method: 'PUT', headers: { cookie, 'content-type': 'application/json', ...headers }, body: JSON.stringify(changed) });
    assert.equal(response.status, 403, JSON.stringify(headers));
    assert.deepEqual((await prisma.systemSetting.findUniqueOrThrow({ where: { key } })).value, initial);
  }
  const allowed = await fetch(endpoint, { method: 'PUT', headers: { cookie, origin: base.origin, 'content-type': 'application/json' }, body: JSON.stringify(changed) });
  assert.equal(allowed.status, 200, await allowed.clone().text());
  assert.deepEqual((await prisma.systemSetting.findUniqueOrThrow({ where: { key } })).value, changed);
  const native = await fetch(endpoint, { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(initial) });
  assert.equal(native.status, 200, 'non-browser tools without Origin remain compatible');
  const forgedLogout = await fetch(`${base.origin}/api/auth/logout`, { method: 'POST', headers: { cookie, origin: 'https://evil.example.test' } });
  assert.equal(forgedLogout.status, 403);
  assert.equal(forgedLogout.headers.get('set-cookie'), null);
  const logout = await fetch(`${base.origin}/api/auth/logout`, { method: 'POST', headers: { cookie, origin: base.origin } });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie') || '', /Max-Age=0/);
  console.log('PASS: real administrator login/cookie; cross-origin, opaque and spoofed-origin writes blocked; same-origin/native writes and GET retained; logout guarded.');
} finally {
  if (previous) await prisma.systemSetting.update({ where: { key }, data: { value: previous.value as object } });
  else await prisma.systemSetting.deleteMany({ where: { key } });
  if (userId) await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
}
