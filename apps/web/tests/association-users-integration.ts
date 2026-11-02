// Run only against an isolated fixture database; does not contact the real association site.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { NextRequest } from 'next/server';
import { prisma } from '../src/lib/db';
import { importAssociationUsers } from '../src/lib/association-users';
import { parseAssociationImport } from '../src/lib/association-import';
import { digestPasswordForStorage } from '../src/lib/password-crypto';
import { POST as login } from '../src/app/api/auth/login/route';
import { POST as externalLogin } from '../src/app/api/auth/external-login/route';
import { POST as enroll } from '../src/app/api/public-test/route';
import { cleanupPublicTestState, getPublicTestExam, publicTestEnrollmentKey } from '../src/lib/public-test';
import type { ExternalUserInfo } from '../src/lib/cwnupaa';

const marker = randomUUID();
const originalFetch = globalThis.fetch;
const originalSetting = await prisma.systemSetting.findUnique({ where: { key: 'externalLogin' } });
const userIds: string[] = [], candidateIds: string[] = [];
const testPassword = 'fixture-password-2026';
const idBase = BigInt('0x' + randomBytes(6).toString('hex'));
const profiles = new Map<string, ExternalUserInfo>();
let calls = 0, offline = false;
const key = (suffix: string) => `qa-${marker}-${suffix}`;
function profile(index: number, realName: string, numberId: string) {
  const account = key(String(index));
  const result = { userId: String(idBase + BigInt(index)), userAccount: account, realName, numberId, userName: `昵称${index}`, email: `${account}@example.test` };
  profiles.set(account, result); return result;
}
globalThis.fetch = async (_input, init) => {
  calls++;
  if (offline) throw new Error('fixture offline');
  const body = JSON.parse(String(init?.body));
  assert.equal(body.appKey, 'fixture-key');
  const user = profiles.get(body.account);
  return Response.json({ code: user && body.credential === testPassword ? 200 : 500, msg: '验证失败', data: user && body.credential === testPassword ? user : null });
};
async function call(handler: (request: any) => Promise<Response>, body: object, cookie = '') {
  const path = handler === enroll ? '/api/public-test' : '/api/auth/login';
  const response = await handler(new NextRequest(`http://localhost:4141${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:4141', cookie }, body: JSON.stringify(body) }));
  return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie') };
}
try {
  await prisma.systemSetting.upsert({ where: { key: 'externalLogin' }, create: { key: 'externalLogin', value: { apiBase: 'https://fixture.test/api', appKey: 'fixture-key' } }, update: { value: { apiBase: 'https://fixture.test/api', appKey: 'fixture-key' } } });
  assert.deepEqual(parseAssociationImport('张三+001\n李四 002\n王五\t003\n赵六，004'), [{ realName: '张三', numberId: '001' }, { realName: '李四', numberId: '002' }, { realName: '王五', numberId: '003' }, { realName: '赵六', numberId: '004' }]);
  assert.throws(() => parseAssociationImport('缺少学号'), /第 1 行/);
  const a = profile(1, key('张三'), key('001')), b = profile(2, key('李四'), a.numberId);
  await importAssociationUsers([{ realName: a.realName, numberId: a.numberId }, { realName: b.realName, numberId: b.numberId }]);
  const users = await prisma.user.findMany({ where: { numberId: a.numberId } }); userIds.push(...users.map(user => user.id));
  assert.equal(users.length, 2); assert.ok(users.every(user => !user.passwordHash && !user.associationVerifiedAt));
  const outsider = profile(3, key('名单外'), key('003'));
  assert.equal((await call(login, { account: outsider.userAccount, password: testPassword })).status, 403);
  assert.equal(await prisma.user.count({ where: { username: outsider.userAccount } }), 0);
  const impostor = profile(4, key('冒用姓名'), a.numberId);
  assert.equal((await call(login, { account: impostor.userAccount, password: testPassword })).status, 403);
  assert.equal((await call(login, { account: a.userAccount, password: 'incorrect' })).status, 401);
  const first = await call(login, { account: a.userAccount, password: testPassword });
  assert.equal(first.status, 200, JSON.stringify(first.body)); assert.ok(first.cookie);
  const cached = await prisma.user.findUniqueOrThrow({ where: { username: a.userAccount } });
  assert.equal(cached.associationUserId, a.userId); assert.equal(cached.email, a.email);
  assert.ok(await bcrypt.compare(digestPasswordForStorage(testPassword), cached.passwordHash!));
  assert.equal(JSON.stringify(first.body).includes('passwordHash'), false);
  await importAssociationUsers([{ realName: a.realName, numberId: a.numberId }]);
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: cached.id } })).passwordHash, cached.passwordHash);
  offline = true; const before = calls;
  assert.equal((await call(login, { account: a.userAccount, password: testPassword })).status, 200);
  assert.equal(calls, before, 'cached account authenticates while association is offline'); offline = false;
  assert.equal((await call(login, { account: b.userAccount, password: testPassword })).status, 200);
  assert.equal((await call(login, { account: a.numberId, password: testPassword })).status, 401);
  assert.equal((await call(login, { account: a.numberId, realName: a.realName, password: testPassword })).status, 401);
  // A numeric official account may also match multiple local student IDs. Only
  // the official response, never a supplied name or cached password, selects it.
  profiles.set(a.numberId, a);
  const resolvedA = await call(login, { account: a.numberId, password: testPassword, realName: b.realName });
  assert.equal(resolvedA.status, 200, JSON.stringify(resolvedA.body));
  assert.equal(resolvedA.body.data.id, cached.id);
  assert.equal(resolvedA.body.data.realName, a.realName);
  profiles.set(a.numberId, b);
  const resolvedB = await call(login, { account: a.numberId, password: testPassword });
  assert.equal(resolvedB.status, 200, JSON.stringify(resolvedB.body));
  assert.equal(resolvedB.body.data.realName, b.realName);
  profiles.delete(a.numberId);
  await prisma.user.update({ where: { id: cached.id }, data: { status: 'DISABLED' } });
  assert.equal((await call(login, { account: a.userAccount, password: testPassword })).status, 403);
  assert.equal((await call(externalLogin, { account: a.userAccount, password: testPassword })).status, 403);
  await importAssociationUsers([{ realName: a.realName, numberId: a.numberId }]);
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: cached.id } })).status, 'DISABLED');
  const localProfile = profile(5, key('本地'), key('005'));
  const local = await prisma.user.create({ data: { username: key('local'), realName: localProfile.realName, numberId: localProfile.numberId, passwordHash: await bcrypt.hash(digestPasswordForStorage(testPassword), 4) } }); userIds.push(local.id);
  await assert.rejects(importAssociationUsers([{ realName: localProfile.realName, numberId: localProfile.numberId }]), /本地用户/);
  assert.equal((await call(externalLogin, { account: localProfile.userAccount, password: testPassword })).status, 403);
  const legacyProfile = profile(6, key('旧管理员'), key('006'));
  const legacy = await prisma.user.create({ data: { numberId: legacyProfile.numberId } }); userIds.push(legacy.id);
  assert.equal((await call(login, { account: legacyProfile.userAccount, password: testPassword })).status, 200);
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: legacy.id } })).realName, legacyProfile.realName);
  // Every public enrollment must authenticate; it never adds an administrator.
  assert.equal((await call(enroll, { mode: 'secondCamera' })).status, 400);
  assert.equal((await call(enroll, { mode: 'secondCamera', account: outsider.userAccount, password: 'incorrect' })).status, 401);
  const payload = { mode: 'secondCamera', account: outsider.userAccount, password: testPassword };
  const concurrent = await Promise.all([call(enroll, payload), call(enroll, payload)]);
  assert.ok(concurrent.every(result => result.status === 200), JSON.stringify(concurrent));
  assert.deepEqual(concurrent[0].body.data, concurrent[1].body.data);
  const credentials = concurrent[0].body.data;
  const candidate = await prisma.candidate.findFirstOrThrow({ where: { examNumber: credentials.examNumber } }); candidateIds.push(candidate.id);
  assert.equal(await prisma.publicTestAccount.count({ where: { externalUserId: outsider.userId } }), 1);
  assert.equal(await prisma.user.count({ where: { username: outsider.userAccount } }), 0);
  assert.equal((await call(login, { account: outsider.userAccount, password: testPassword })).status, 403);
  await prisma.candidate.update({ where: { id: candidate.id }, data: { status: 'FINISHED', startedAt: new Date(Date.now() - 86_400_000), updatedAt: new Date(Date.now() - 120_000) } });
  await cleanupPublicTestState();
  assert.equal((await prisma.candidate.findUniqueOrThrow({ where: { id: candidate.id } })).startedAt, null);
  assert.deepEqual((await call(enroll, payload)).body.data, credentials);
  assert.equal((await prisma.publicTestAccount.findUniqueOrThrow({ where: { externalUserId: outsider.userId } })).candidateId, candidate.id);
  // Old browser cookies cannot claim anonymous accounts or change a permanent account.
  const exam = await getPublicTestExam(); const room = exam.rooms.find(room => room.requireSecondCamera)!;
  const old = await prisma.candidate.create({ data: { examId: exam.id, name: key('旧测试'), examNumber: key('TEST'), password: key('old-secret'), seatNo: '旧测试', ranked: false, rooms: { create: { roomId: room.id } } } }); candidateIds.push(old.id);
  const token = randomBytes(32).toString('base64url');
  await prisma.systemSetting.create({ data: { key: publicTestEnrollmentKey(token), value: { secondCamera: old.id } } });
  const fresh = await call(enroll, { mode: 'secondCamera', account: impostor.userAccount, password: testPassword }, `proctor_test_enrollment=${token}`);
  assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
  assert.notEqual(fresh.body.data.examNumber, old.examNumber);
  const freshBinding = await prisma.publicTestAccount.findUniqueOrThrow({ where: { externalUserId: impostor.userId } });
  candidateIds.push(freshBinding.candidateId);
  assert.notEqual(freshBinding.candidateId, old.id);
  assert.equal(await prisma.publicTestAccount.findUnique({ where: { candidateId: old.id } }), null);
  assert.deepEqual((await call(enroll, payload, `proctor_test_enrollment=${token}`)).body.data, credentials);
  const callsBeforeLegacy = calls;
  const manual = await call(enroll, { mode: 'secondCamera', account: localProfile.userAccount, password: testPassword, legacyCredentials: { name: old.name, examNumber: old.examNumber, password: old.password } });
  assert.equal(manual.status, 400);
  assert.equal(calls, callsBeforeLegacy, 'old-account binding requests are rejected before official authentication');
  assert.equal(await prisma.publicTestAccount.findUnique({ where: { externalUserId: localProfile.userId } }), null);
  for (let attempt = 0; attempt < 10; attempt++) assert.equal((await call(enroll, { mode: 'secondCamera', account: key('brute'), password: 'incorrect' })).status, 401);
  assert.equal((await call(enroll, { mode: 'secondCamera', account: key('brute'), password: 'incorrect' })).status, 429);
  await prisma.systemSetting.deleteMany({ where: { key: publicTestEnrollmentKey(token) } });
  console.log('PASS: import parser, same student number with different names, whitelist, wrong credentials/name, profile and password cache, offline local login, ambiguity, disabled accounts, local account isolation, legacy admins, verified enrollment, concurrent permanent binding, repeat testing, old cookies ignored, old-account binding rejected, no admin privilege escalation and rate limit.');
} finally {
  globalThis.fetch = originalFetch;
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.candidate.deleteMany({ where: { id: { in: candidateIds } } });
  await prisma.systemSetting.deleteMany({ where: { key: { in: [...profiles.values()].map(user => `public-test.account.${user.userId}`) } } });
  if (originalSetting) await prisma.systemSetting.update({ where: { key: 'externalLogin' }, data: { value: originalSetting.value! } });
  else await prisma.systemSetting.deleteMany({ where: { key: 'externalLogin' } });
  await prisma.$disconnect();
}
