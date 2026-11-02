import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import ts from 'typescript';
import { prisma } from '../src/lib/db';
import { isTrustedMutationOrigin } from '../src/lib/request-origin';
import { parseBody, RequestParseError } from '../src/lib/http';
import { POST as login } from '../src/app/api/auth/login/route';
import { POST as legacyLogin } from '../src/app/api/auth/admin-login/route';
import { POST as externalLogin } from '../src/app/api/auth/external-login/route';
import { POST as logout } from '../src/app/api/auth/logout/route';
import { POST as candidateVerify } from '../src/app/api/client/candidate-verify/route';
import { POST as credentialLogin } from '../src/app/api/client/credential-login/route';
import { consumeCandidatePasswordAttempt } from '../src/lib/login-attempts';
import { cleanupExpiredRateBuckets } from '../src/lib/rate-limit-cleanup';

const origin = 'https://admin.example.test';
function request(body: object = {}, headers: Record<string, string> = {}, url = `${origin}/api/test`) {
  return new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

test('cookie writes require an exact origin, including sibling sites and opaque origins', () => {
  assert.equal(isTrustedMutationOrigin(request({}, { origin }), ''), true);
  assert.equal(isTrustedMutationOrigin(request({}, { origin }, 'http://web:4031/api/test'), origin), true);
  assert.equal(isTrustedMutationOrigin(request({}, { origin: 'http://192.168.50.40:4031' }, 'http://192.168.50.40:4031/api/test'), ''), true);
  assert.equal(isTrustedMutationOrigin(request(), ''), true, 'native tools without browser headers remain supported');
  assert.equal(isTrustedMutationOrigin(request({}, { 'sec-fetch-site': 'same-origin' }), ''), true);
  for (const value of ['null', 'https://evil.example.test', 'https://outside.test', `${origin}.outside.test`, `${origin}/`, `${origin}/path`, 'https://admin.example.test@outside.test', 'file:///']) {
    assert.equal(isTrustedMutationOrigin(request({}, { origin: value }), origin), false, value);
  }
  for (const site of ['cross-site', 'same-site']) assert.equal(isTrustedMutationOrigin(request({}, { 'sec-fetch-site': site }), ''), false);
  assert.equal(isTrustedMutationOrigin(request({}, { origin: 'https://outside.test', 'x-forwarded-host': 'outside.test' }), ''), false);
  assert.equal(isTrustedMutationOrigin(new Request(`${origin}/api/test`, { headers: { origin: 'https://outside.test' } }), ''), true, 'read requests are unchanged');
});

test('all administrator login aliases and logout reject forged forms before authentication', async () => {
  for (const handler of [login, legacyLogin, externalLogin, logout]) {
    const response = await handler(request({ account: 'target', username: 'target', password: 'guess' }, { origin: 'https://evil.example.test', 'content-type': 'text/plain' }));
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('set-cookie'), null);
  }
});

test('login JSON limits apply to both Content-Length and chunked streams', async () => {
  const schema = z.object({ password: z.string() });
  const body = { password: 'a'.repeat(500) };
  await assert.rejects(parseBody(request(body, { 'content-length': '9999' }), schema, 128), RequestParseError);
  await assert.rejects(parseBody(request(body), schema, 128), /请求内容过大/);
  assert.deepEqual(await parseBody(request({ password: 'correct' }), schema, 128), { password: 'correct' });
  const response = await legacyLogin(request({ username: 'admin', password: 'a'.repeat(20_000) }));
  assert.equal(response.status, 400);
});

test('legacy/new administrator login and account aliases share the password attempt budget', async () => {
  const originals = { lookup: prisma.user.findUnique, upsert: prisma.requestRateBucket.upsert, compare: bcrypt.compare };
  const counts = new Map<string, number>();
  let passwordChecks = 0;
  prisma.user.findUnique = (async () => ({ id: 'same-admin', passwordHash: 'fixture', status: 'ACTIVE', associationImported: false })) as never;
  prisma.requestRateBucket.upsert = (async (input: { where: { id: string } }) => {
    const count = (counts.get(input.where.id) || 0) + 1;
    counts.set(input.where.id, count);
    return { count };
  }) as never;
  bcrypt.compare = (async () => { passwordChecks++; return false; }) as typeof bcrypt.compare;
  try {
    for (let index = 0; index < 20; index++) {
      const handler = index % 2 ? legacyLogin : login;
      const response = await handler(request({ account: `alias-${index}`, username: `alias-${index}`, password: 'guess' }));
      assert.equal(response.status, 401);
    }
    assert.equal((await legacyLogin(request({ username: 'new-alias', password: 'guess' }))).status, 429);
    assert.equal((await login(request({ account: 'another-alias', password: 'guess' }))).status, 429);
    assert.equal(passwordChecks, 20, 'rate limits are checked before bcrypt');
  } finally {
    prisma.user.findUnique = originals.lookup; prisma.requestRateBucket.upsert = originals.upsert; bcrypt.compare = originals.compare;
  }
});

test('candidate verification and credential login share identity limits without blocking other candidates', async () => {
  const originals = { exam: prisma.exam.findUnique, candidate: prisma.candidate.findMany, setting: prisma.systemSetting.findUnique, upsert: prisma.requestRateBucket.upsert };
  const counts = new Map<string, number>();
  prisma.exam.findUnique = (async () => ({ id: 'exam-security', examCode: '2026101501', contestType: 'INDIVIDUAL' })) as never;
  prisma.systemSetting.findUnique = (async () => null) as never;
  prisma.candidate.findMany = (async () => [{ id: 'candidate-security', password: 'actual-secret', name: 'Candidate', teamMembers: null, teamMemberStudentIds: null }]) as never;
  prisma.requestRateBucket.upsert = (async (input: { where: { id: string } }) => {
    const count = (counts.get(input.where.id) || 0) + 1;
    counts.set(input.where.id, count);
    return { count };
  }) as never;
  try {
    for (let index = 0; index < 30; index++) {
      const handler = index % 2 ? credentialLogin : candidateVerify;
      const response = await handler(request({ examCode: '2026101501', examNumber: 'C001', name: `name-${index}`, password: 'guess', pairCode: String(100000 + index) }));
      assert.equal(response.status, index % 2 ? 401 : 400, await response.text());
    }
    for (const handler of [credentialLogin, candidateVerify]) {
      const response = await handler(request({ examCode: '2026101501', examNumber: 'C001', name: 'Candidate', password: 'actual-secret', pairCode: '999999' }));
      assert.equal(response.status, 429);
    }
    const beforeUnknown = counts.size;
    await consumeCandidatePasswordAttempt([]);
    assert.equal(counts.size, beforeUnknown, 'unknown IDs do not allocate buckets');
    await consumeCandidatePasswordAttempt(['another-candidate']);
    assert.equal(counts.size, beforeUnknown + 1, 'another participant has an independent budget');
  } finally {
    prisma.exam.findUnique = originals.exam; prisma.candidate.findMany = originals.candidate; prisma.systemSetting.findUnique = originals.setting; prisma.requestRateBucket.upsert = originals.upsert;
  }
});

test('expired rate counters are cleaned in bounded batches and recheck expiry before deletion', async () => {
  const originals = { find: prisma.requestRateBucket.findMany, remove: prisma.requestRateBucket.deleteMany };
  const now = new Date('2026-10-15T10:00:00Z');
  prisma.requestRateBucket.findMany = (async (input: any) => {
    assert.equal(input.take, 1000); assert.deepEqual(input.where, { expiresAt: { lt: now } });
    return [{ id: 'expired-a' }, { id: 'renewed-b' }];
  }) as never;
  prisma.requestRateBucket.deleteMany = (async (input: any) => {
    assert.deepEqual(input.where, { id: { in: ['expired-a', 'renewed-b'] }, expiresAt: { lt: now } });
    return { count: 1 };
  }) as never;
  try { assert.equal(await cleanupExpiredRateBuckets(now), 1); }
  finally { prisma.requestRateBucket.findMany = originals.find; prisma.requestRateBucket.deleteMany = originals.remove; }
});

test('every cookie-authenticated route passes request context into the mutation origin guard', async () => {
  const apiRoot = fileURLToPath(new URL('../src/app/api/', import.meta.url));
  async function walk(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    return (await Promise.all(entries.map(entry => entry.isDirectory() ? walk(path.join(directory, entry.name)) : [path.join(directory, entry.name)]))).flat();
  }
  let checked = 0;
  for (const filename of await walk(apiRoot)) {
    if (!filename.endsWith('/route.ts')) continue;
    const source = ts.createSourceFile(filename, await readFile(filename, 'utf8'), ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node, isMutation: boolean) {
      if (ts.isFunctionDeclaration(node) && node.name && ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(node.name.text)) {
        isMutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(node.name.text);
      }
      if (isMutation && ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const name = node.expression.text;
        if (['requireUser', 'requireSuperAdmin', 'requireScreenControlAdmin'].includes(name)) {
          checked++;
          assert.ok(node.arguments.length >= (name === 'requireScreenControlAdmin' ? 2 : 1), `${filename}: ${name} must receive the Request`);
        }
      }
      ts.forEachChild(node, child => visit(child, isMutation));
    }
    visit(source, false);
  }
  assert.ok(checked >= 50, `only ${checked} mutation guards checked`);
});
