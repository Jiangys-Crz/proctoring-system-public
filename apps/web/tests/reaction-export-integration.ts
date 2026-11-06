/** Real local HTTP/DB export acceptance. Only uniquely owned fixtures are mutated. */
import assert from 'node:assert/strict';
import { randomBytes, randomInt, randomUUID, createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import JSZip from 'jszip';
import { prisma } from '../src/lib/db';
import { digestPasswordForStorage } from '../src/lib/password-crypto';
import { storeBuffer, deleteStoredObject, storedObjectExists } from '../src/lib/storage';
import { getStorageSettings, type StorageSettings } from '../src/lib/settings';
import { probeReactionVideo } from '../src/lib/reaction-media';

const base = (process.env.REACTION_TEST_BASE || 'http://localhost:4031').replace(/\/$/, '');
const output = path.resolve(process.argv[2] || '.local/reaction-export-integration');
const sourceFile = path.resolve(process.argv[3] || path.join(output, 'desktop-only/missing-camera-reaction.mp4'));
const database = new URL(process.env.DATABASE_URL || 'mysql://invalid/invalid');
assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname) && /reaction/i.test(database.pathname), 'Use the existing local Reaction test database');
assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname), 'Local HTTP application required');
const marker = 'export-api-' + randomBytes(8).toString('hex');
const submissionIds = Array.from({ length: 205 }, () => randomUUID());
const report: { startedAt: string; marker: string; checks: { name: string; result: 'PASS' | 'FAIL'; evidence?: unknown }[]; cleanupErrors: string[]; realContestZip?: unknown; passed?: boolean; finishedAt?: string } = {
  startedAt: new Date().toISOString(), marker, checks: [], cleanupErrors: []
};
let examId = '', adminId = '', outsiderId = '', outsiderUsername = '', sharedKey = '';
let sharedBytes = 0;
let adminCookie = '', outsiderCookie = '';
let storage: StorageSettings | undefined;
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function check(name: string, run: () => Promise<unknown>) {
  try { const evidence = await run(); report.checks.push({ name, result: 'PASS', evidence }); console.log('PASS ' + name); }
  catch (error) { report.checks.push({ name, result: 'FAIL', evidence: error instanceof assert.AssertionError ? error.message : 'Operation failed; private credentials and remote diagnostics omitted' }); throw error; }
}
async function login(account: string, password: string) {
  const response = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ account, passwordDigest: digestPasswordForStorage(password) }), signal: AbortSignal.timeout(30000)
  });
  assert.equal(response.status, 200, 'Legal administrator login must succeed');
  const body = await response.json();
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  assert(cookie, 'Server-issued session cookie required');
  assert(cookie.startsWith('cwnupaa_proctor_session='), 'Expected administrator session cookie');
  assert.equal(body.ok, true);
  return { cookie, id: String(body.data.id) };
}
const endpoint = () => `${base}/api/exams/${examId}/reactions`;
function request(suffix = '', cookie = adminCookie) {
  return fetch(endpoint() + suffix, { headers: cookie ? { cookie } : {}, signal: AbortSignal.timeout(180000) });
}
async function expectConflict(suffix: string, expected: RegExp) {
  const response = await request(suffix);
  assert.equal(response.status, 409, 'Incomplete export must fail before a ZIP response');
  assert.match(response.headers.get('content-type') || '', /application\/json/);
  const payload = await response.json(); assert.equal(payload.ok, false); assert.match(payload.message, expected);
  return response.status;
}

try {
  await fs.mkdir(output, { recursive: true });
  const fixture = JSON.parse(await fs.readFile(process.env.REACTION_ADMIN_FIXTURE || '.local/reaction-e2e/fixture.private.json', 'utf8'));
  assert(typeof fixture.adminUsername === 'string' && typeof fixture.adminPassword === 'string', 'Private local administrator fixture required');
  await check('Existing test administrator authenticates through the real login API', async () => {
    const session = await login(fixture.adminUsername, fixture.adminPassword);
    adminCookie = session.cookie; adminId = session.id;
    return { loginHttp: 200, sessionIssuedByServer: true, forgedSession: false };
  });

  const now = new Date();
  const exam = await prisma.exam.create({ data: {
    examCode: String(randomInt(1_000_000_000, 10_000_000_000)), name: marker,
    startAt: now, latestStartAt: now, endAt: new Date(+now + 3_600_000), durationMinutes: 60,
    platform: 'NOVAJUDGE', platformBaseUrl: 'http://localhost:3001', platformContestId: marker,
    contestType: 'TEAM', rules: 'Isolated export fixture; no CCS subscription or recording', reactionEnabled: false, createdById: adminId
  } });
  examId = exam.id;
  const source = await fs.readFile(sourceFile);
  sharedBytes = source.length;
  const probe = await probeReactionVideo(sourceFile);
  storage = await getStorageSettings();
  const prefix = `reactions/${examId}/${marker}`;
  sharedKey = (await storeBuffer(source, { prefix, filename: 'shared-test.mp4', stableName: true, immutable: true, contentType: 'video/mp4' }, storage)).objectPath;
  assert.equal(sharedKey, prefix + '/shared-test.mp4');
  const common = {
    examId, contestId: marker, teamId: 'fixture-team', teamName: 'Isolated export fixture', problemId: 'fixture-problem', problemLabel: 'A',
    sourceSubmittedAt: now, submissionObservedAt: now, judgementObservedAt: now, windowStart: now, windowEnd: new Date(+now + probe.duration * 1000),
    status: 'COMPLETE', generationStatus: 'COMPLETE', verdict: 'AC', originalVerdict: 'AC',
    cameraPath: sharedKey, desktopPath: sharedKey, reactionPath: sharedKey, outputBytes: BigInt(source.length), durationSeconds: probe.duration,
    finalizedAt: now, expiresAt: new Date(+now + 86_400_000)
  };
  await prisma.reaction.createMany({ data: Array.from({ length: 205 }, (_, index) => ({
    ...common, submissionId: submissionIds[index],
    ...(index === 204 ? { status: 'PARTIAL', cameraPath: null, error: 'VIDEO_INTERVAL_MISSING' } : {})
  })) });
  await prisma.reaction.createMany({ data: [
    { ...common, submissionId: randomUUID(), generationStatus: 'IDLE', reactionPath: null },
    { ...common, submissionId: randomUUID(), status: 'EXPIRED' },
    { ...common, submissionId: randomUUID(), status: 'DELETED' },
    { ...common, submissionId: randomUUID(), status: 'CANCELLED' },
    { ...common, submissionId: randomUUID(), generationStatus: 'FAILED' },
    { ...common, submissionId: randomUUID(), expiresAt: new Date(+now - 1000) }
  ] });
  await check('Independent video fixture is valid and Recorder is disabled for the fixture exam', async () => {
    assert.equal((await prisma.exam.findUniqueOrThrow({ where: { id: examId } })).reactionEnabled, false);
    assert.equal(await prisma.reactionConfig.count({ where: { examId } }), 0);
    assert(await storedObjectExists(sharedKey, source.length, storage));
    assert.equal(await prisma.reaction.count({ where: { examId } }), 211);
    return { activeGeneratedRows: 205, excludedControlRows: 6, sharedPhysicalCopy: 1, sourceSha256: digest(source), sourceProbe: probe, reactionEnabled: false };
  });

  await check('Anonymous export and preflight are denied with 401', async () => {
    for (const suffix of ['/export', '/export?check=1']) {
      const response = await request(suffix, ''); assert.equal(response.status, 401); await response.arrayBuffer();
    }
    return { export: 401, preflight: 401 };
  });

  outsiderUsername = marker + '-outsider';
  const outsiderPassword = randomBytes(30).toString('base64url');
  outsiderId = (await prisma.user.create({ data: {
    username: outsiderUsername, role: 'ADMIN', status: 'ACTIVE', passwordHash: await bcrypt.hash(digestPasswordForStorage(outsiderPassword), 10)
  } })).id;
  await check('An unassigned administrator logs in legally and receives 403 for export', async () => {
    const session = await login(outsiderUsername, outsiderPassword); outsiderCookie = session.cookie; assert.equal(session.id, outsiderId);
    for (const suffix of ['/export', '/export?check=1']) {
      const response = await request(suffix, outsiderCookie); assert.equal(response.status, 403); await response.arrayBuffer();
    }
    return { login: 200, export: 403, preflight: 403, passwordStorage: 'bcrypt of digestPasswordForStorage; random per run' };
  });

  await check('Summary counts all 205 generated videos while the visible list remains capped at 200', async () => {
    const response = await request(); assert.equal(response.status, 200);
    const data = (await response.json()).data;
    assert.equal(data.items.length, 200);
    assert.deepEqual(data.exportSummary, { generatedCount: 205, invalidSubmissionIds: 0 });
    const preflight = await request('/export?check=1'); assert.equal(preflight.status, 200);
    assert.deepEqual((await preflight.json()).data, { generatedCount: 205, invalidSubmissionIds: 0 });
    return { displayedRows: 200, generatedCount: 205, invalidSubmissionIds: 0, excluded: ['not generated', 'EXPIRED', 'DELETED', 'CANCELLED', 'generation failed', 'expiresAt elapsed without status change'] };
  });

  await check('Actual streaming ZIP contains all 205 named MP4s with correct bytes and CRC', async () => {
    const response = await request('/export'); assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /application\/zip/);
    assert.match(response.headers.get('content-disposition') || '', /attachment;.*\.zip/);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    const bytes = Buffer.from(await response.arrayBuffer());
    const archive = await JSZip.loadAsync(bytes, { checkCRC32: true });
    const files = Object.values(archive.files).filter(entry => !entry.dir);
    assert.equal(files.length, 205);
    assert.deepEqual(files.map(entry => entry.name).sort(), submissionIds.map(id => `${id}.mp4`).sort());
    const expected = digest(source);
    for (const entry of files) assert.equal(digest(await entry.async('nodebuffer')), expected, `MP4 bytes changed for ${entry.name}`);
    assert(bytes.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06])), 'ZIP64 end record expected');
    return { entryCount: files.length, boundaryFile: `${submissionIds[204]}.mp4`, allHashesMatchSource: true, crcCheck: 'PASS', zip64: true, zipBytes: bytes.length };
  });

  const first = await prisma.reaction.findUniqueOrThrow({ where: { examId_submissionId: { examId, submissionId: submissionIds[0] } } });
  await check('Single generated MP4 downloads use the original Submission UUID', async () => {
    const response = await request(`/${first.id}/files/reaction?download=1`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-disposition'), `attachment; filename="${submissionIds[0]}.mp4"`);
    assert.equal(digest(Buffer.from(await response.arrayBuffer())), digest(source));
    return { filename: `${submissionIds[0]}.mp4`, originalSubmissionIdPreserved: true, bytesUnchanged: true };
  });

  await check('Invalid UUID and traversal-like Submission IDs block the entire export', async () => {
    for (const invalid of ['not-a-uuid', '../outside', `${submissionIds[0]}/../outside`]) {
      await prisma.reaction.update({ where: { id: first.id }, data: { submissionId: invalid } });
      try {
        const response = await request(); assert.equal(response.status, 200);
        assert.deepEqual((await response.json()).data.exportSummary, { generatedCount: 205, invalidSubmissionIds: 1 });
        await expectConflict('/export?check=1', /UUID|Submission|提交标识/i);
        await expectConflict('/export', /UUID|Submission|提交标识/i);
      } finally { await prisma.reaction.update({ where: { id: first.id }, data: { submissionId: submissionIds[0] } }); }
    }
    return { invalidCases: 3, summary: { generatedCount: 205, invalidSubmissionIds: 1 }, preflight: 409, export: 409, silentlyOmitted: false, traversalNamesRejected: true };
  });

  await check('One missing video blocks preflight and export before any ZIP is sent', async () => {
    await prisma.reaction.update({ where: { id: first.id }, data: { reactionPath: prefix + '/does-not-exist.mp4' } });
    try {
      await expectConflict('/export?check=1', /缺失|存储/); await expectConflict('/export', /缺失|存储/);
      return { preflight: 409, export: 409 };
    } finally { await prisma.reaction.update({ where: { id: first.id }, data: { reactionPath: sharedKey } }); }
  });

  await check('An invalid storage path is rejected with 409 without accessing another object', async () => {
    await prisma.reaction.update({ where: { id: first.id }, data: { reactionPath: `reactions/${examId}/../rejected.mp4` } });
    try {
      await expectConflict('/export?check=1', /路径无效/); await expectConflict('/export', /路径无效/);
      return { preflight: 409, export: 409, invalidTraversalRejected: true };
    } finally { await prisma.reaction.update({ where: { id: first.id }, data: { reactionPath: sharedKey } }); }
  });
} catch (error) {
  process.exitCode = 1;
  if (!report.checks.some(item => item.result === 'FAIL')) report.checks.push({ name: 'Test setup', result: 'FAIL', evidence: error instanceof assert.AssertionError ? error.message : 'Local fixture setup failed; credentials and remote diagnostics omitted' });
  console.error('Export integration failed; consult the sanitized report.');
} finally {
  if (examId) {
    try {
      const owned = await prisma.exam.findUnique({ where: { id: examId }, select: { name: true, createdById: true, reactionEnabled: true } });
      assert(owned && owned.name === marker && owned.createdById === adminId && !owned.reactionEnabled, 'Fixture ownership must match before cleanup');
      await prisma.reaction.deleteMany({ where: { examId } });
      await prisma.exam.delete({ where: { id: examId } });
      assert.equal(await prisma.reaction.count({ where: { examId } }), 0);
    } catch { report.cleanupErrors.push('Own fixture exam cleanup failed'); }
  }
  if (sharedKey && storage) {
    try {
      assert(sharedKey === `reactions/${examId}/${marker}/shared-test.mp4`, 'Only the independent copied test object may be deleted');
      assert.equal(await prisma.reaction.count({ where: { OR: [{ reactionPath: sharedKey }, { cameraPath: sharedKey }, { desktopPath: sharedKey }, { metadataPath: sharedKey }] } }), 0);
      await deleteStoredObject(sharedKey, storage);
      assert.equal(await storedObjectExists(sharedKey, sharedBytes, storage), false);
    } catch { report.cleanupErrors.push('Own copied MP4 cleanup failed'); }
  }
  if (outsiderId) {
    try {
      assert.equal((await prisma.user.deleteMany({ where: { id: outsiderId, username: outsiderUsername, role: 'ADMIN' } })).count, 1);
    } catch { report.cleanupErrors.push('Own temporary administrator cleanup failed'); }
  }
  report.checks.push({ name: 'Only owned temporary exam, recordings, video copy and outsider account are removed', result: report.cleanupErrors.length ? 'FAIL' : 'PASS', evidence: { cleanupErrors: report.cleanupErrors, userRecordingsRegenerated: false } });
  try { report.realContestZip = JSON.parse(await fs.readFile(path.join(output, 'real-zip-hash-report.json'), 'utf8')); } catch { /* Independent read-only hash review can be merged later. */ }
  report.passed = !report.cleanupErrors.length && report.checks.every(item => item.result === 'PASS');
  if (!report.passed) process.exitCode = 1;
  report.finishedAt = new Date().toISOString();
  await fs.mkdir(output, { recursive: true }); await fs.writeFile(path.join(output, 'export-api-report.json'), JSON.stringify(report, null, 2));
  await prisma.$disconnect();
}
