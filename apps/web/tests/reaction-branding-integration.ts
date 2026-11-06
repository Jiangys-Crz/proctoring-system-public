/** System organization branding acceptance. Run only during an agreed exclusive local test window.
 * Saves/restores the exact pre-existing SystemSetting row under a database lock; user exams stay read-only.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Prisma, SystemSetting } from '@prisma/client';
import sharp from 'sharp';
import { prisma } from '../src/lib/db';
import { createSessionToken } from '../src/lib/auth';
import { deleteStoredObject, storeBuffer } from '../src/lib/storage';
import { generateStoredReaction, materializeReactionObject, runMedia } from '../src/lib/reaction-media';
import { reactionObjectBytes } from '../src/lib/reaction-storage-budget';
import { REACTION_BRANDING_SETTING_KEY, getReactionBranding, readBuiltinReactionBadge, resolveReactionBrandingLogo } from '../src/lib/reaction-branding';
import { normalizeReactionOrganizationName, type ReactionBrandingView } from '../src/lib/reaction-branding-contract';

const base = (process.env.REACTION_TEST_BASE || process.env.APP_BASE_URL || 'http://localhost:4031').replace(/\/$/, '');
const endpoint = base + '/api/settings/reaction-branding';
const sourceReactionId = process.env.REACTION_BRANDING_SOURCE_REACTION_ID;
const output = path.resolve(process.env.REACTION_BRANDING_TEST_OUTPUT || '.local/reaction-branding-test');
assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname), 'Local HTTP only');
const database = new URL(process.env.DATABASE_URL || 'mysql://invalid/invalid');
assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname) && /reaction/i.test(database.pathname), 'Isolated local Reaction database required');
assert.equal(process.env.REACTION_BRANDING_TEST_MUTATE_GLOBAL, '1', 'Coordinate an exclusive test window, then set REACTION_BRANDING_TEST_MUTATE_GLOBAL=1');
assert(sourceReactionId, 'Set REACTION_BRANDING_SOURCE_REACTION_ID to the explicitly approved synthetic D AC capture');

type Actor = { id: string; cookie: string };
type Check = { test: string; result: 'PASS' | 'FAIL'; evidence?: unknown };
const checks: Check[] = [], createdUsers: string[] = [], createdExams: string[] = [], createdObjects = new Set<string>();
const cleanupErrors: string[] = [], suffix = randomBytes(5).toString('hex');
const scratch = path.resolve('.local/reaction-branding-test', suffix);
const lockPath = path.resolve('.local/reaction-branding-test/global-settings.lock');
let before: SystemSetting | null = null, expected: SystemSetting | null = null;
let captured = false, ownsLock = false, restored = false, mutated = false;
const initialAt = new Date().toISOString();
const snapshot = () => prisma.systemSetting.findUnique({ where: { key: REACTION_BRANDING_SETTING_KEY } });
const sameSetting = (a: SystemSetting | null, b: SystemSetting | null) => (!a && !b) || Boolean(a && b && a.key === b.key && +a.updatedAt === +b.updatedAt && +a.createdAt === +b.createdAt && isDeepStrictEqual(a.value, b.value));

async function check(test: string, fn: () => Promise<unknown>) {
  try { const evidence = await fn(); checks.push({ test, result: 'PASS', ...(evidence === undefined ? {} : { evidence }) }); console.log('PASS ' + test); }
  catch (error) { checks.push({ test, result: 'FAIL', evidence: error instanceof Error ? error.message : 'Operation failed' }); throw error; }
}
async function makeActor(label: string, role: 'ADMIN' | 'SUPER_ADMIN'): Promise<Actor> {
  const user = await prisma.user.create({ data: { username: `reaction-branding-${label}-${suffix}`, role } }); createdUsers.push(user.id);
  return { id: user.id, cookie: 'cwnupaa_proctor_session=' + createSessionToken(user) };
}
async function mutate(owner: Actor, method: string, body: FormData | object, origin = base) {
  assert(sameSetting(await snapshot(), expected), 'Concurrent system branding change detected before request; abort without overwriting it');
  const response = await fetch(endpoint, { method, headers: { cookie: owner.cookie, origin, ...(body instanceof FormData ? {} : { 'content-type': 'application/json' }) }, body: body instanceof FormData ? body : JSON.stringify(body) });
  if (response.ok) {
    mutated = true; expected = await snapshot();
    await fs.writeFile(path.join(scratch, 'expected.private.json'), JSON.stringify(expected, null, 2));
  } else assert(sameSetting(await snapshot(), expected), 'Failed request unexpectedly changed system branding');
  return response;
}
async function upload(owner: Actor, bytes: Buffer, kind: 'organization' | 'default', name?: string, options: { type?: string; replace?: boolean; existingName?: string; origin?: string } = {}) {
  const form = new FormData(); form.set('kind', kind); if (name !== undefined) form.set('name', name);
  form.set('file', new Blob([new Uint8Array(bytes)], { type: options.type || 'image/png' }), 'TEST-image');
  if (options.replace) form.set('replace', 'true'); if (options.existingName) form.set('existingName', options.existingName);
  return mutate(owner, 'POST', form, options.origin);
}
async function view(owner: Actor) {
  const response = await fetch(endpoint, { headers: { cookie: owner.cookie } }); assert.equal(response.status, 200);
  return (await response.json()).data as ReactionBrandingView;
}
async function preview(owner: Actor, url: string) {
  const response = await fetch(new URL(url, base), { headers: { cookie: owner.cookie } }); assert.equal(response.status, 200);
  const bytes = Buffer.from(await response.arrayBuffer()); assert.equal((await sharp(bytes).metadata()).format, 'png');
  assert.match(response.headers.get('cache-control') || '', /private/); return bytes;
}
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function fixture(owner: Actor, label: string, school: string) {
  const exam = await prisma.exam.create({ data: {
    examCode: String(randomInt(1_000_000_000, 10_000_000_000)), name: `System branding TEST ${label}`, startAt: new Date(),
    latestStartAt: new Date(Date.now() + 3600000), endAt: new Date(Date.now() + 3600000), durationMinutes: 60, platform: 'NOVAJUDGE',
    platformBaseUrl: 'http://127.0.0.1:3001', platformContestId: 'branding-test-no-feed', contestType: 'TEAM', rules: 'Synthetic TEST badge render only', createdById: owner.id
  } }); createdExams.push(exam.id);
  const teamId = 'branding_' + label;
  const candidate = await prisma.candidate.create({ data: { examId: exam.id, examNumber: teamId, name: '组织徽章 TEST 队伍', teamName: '组织徽章 TEST 队伍', school, password: randomBytes(32).toString('hex'), seatNo: '1' } });
  return { exam, candidate, teamId };
}

try {
  await fs.mkdir(scratch, { recursive: true }); await fs.mkdir(output, { recursive: true });
  const lock = await fs.open(lockPath, 'wx'); ownsLock = true; await lock.writeFile(JSON.stringify({ pid: process.pid, at: initialAt, suffix })); await lock.close();
  before = await snapshot(); expected = before; captured = true;
  await fs.writeFile(path.join(scratch, 'before.private.json'), JSON.stringify(before, null, 2));
  const globalAdmin = await makeActor('system', 'SUPER_ADMIN'), examAdmin = await makeActor('exam', 'ADMIN');
  const orgRaw = `　ＴＥＳＴ\u00a0 Org\t${suffix}　`, orgName = normalizeReactionOrganizationName(orgRaw);
  const secondaryName = 'Secondary TEST ' + suffix, thirdName = 'Third TEST ' + suffix;
  const organizationFixture = await fixture(examAdmin, 'organization', orgRaw), defaultFixture = await fixture(examAdmin, 'default', 'Unknown TEST ' + suffix);
  const organizationIcon = await sharp({ create: { width: 180, height: 180, channels: 4, background: '#137c57' } })
    .composite([{ input: Buffer.from('<svg width="180" height="180"><text x="90" y="106" text-anchor="middle" font-family="Arial" font-weight="bold" font-size="38" fill="white">ORG</text><text x="90" y="146" text-anchor="middle" font-family="Arial" font-size="24" fill="white">TEST</text></svg>') }]).png().toBuffer();
  const defaultIcon = await sharp({ create: { width: 180, height: 180, channels: 4, background: '#284bc5' } })
    .composite([{ input: Buffer.from('<svg width="180" height="180"><text x="90" y="106" text-anchor="middle" font-family="Arial" font-weight="bold" font-size="31" fill="white">DEFAULT</text><text x="90" y="146" text-anchor="middle" font-family="Arial" font-size="24" fill="white">TEST</text></svg>') }]).png().toBuffer();

  await check('Global branding requires super administrator even for an authorized exam manager', async () => {
    assert.equal((await fetch(endpoint)).status, 401);
    assert.equal((await fetch(endpoint, { headers: { cookie: examAdmin.cookie } })).status, 403);
    assert.equal((await upload(examAdmin, organizationIcon, 'organization', orgRaw)).status, 403);
    assert.equal((await mutate(examAdmin, 'PATCH', { name: orgRaw, newName: secondaryName })).status, 403);
    assert.equal((await mutate(examAdmin, 'DELETE', {})).status, 403);
    assert.equal((await fetch(`${base}/api/exams/${organizationFixture.exam.id}/reactions`, { headers: { cookie: examAdmin.cookie } })).status, 200);
  });
  await check('Built-in badge preview is valid PNG and remains restricted', async () => {
    const url = '/api/settings/reaction-branding/logos/builtin';
    assert.equal((await fetch(base + url)).status, 401);
    assert.equal((await fetch(base + url, { headers: { cookie: examAdmin.cookie } })).status, 403);
    const bytes = await preview(globalAdmin, url); assert.equal(digest(bytes), digest(await readBuiltinReactionBadge()));
    const current = await view(globalAdmin); assert.equal(current.version, 1); assert.equal(current.limit, 500);
    return { builtinSha256: digest(bytes), byteLength: bytes.length };
  });
  let organizationLogoId = '';
  await check('Organization uploads accept PNG JPEG WebP and normalize organization names', async () => {
    const examples = [{ format: 'png', name: orgRaw }, { format: 'jpeg', name: secondaryName }, { format: 'webp', name: thirdName }] as const;
    for (const example of examples) {
      const bytes = await sharp(organizationIcon).toFormat(example.format).toBuffer();
      const response = await upload(globalAdmin, bytes, 'organization', example.name, { type: 'image/' + example.format }); assert.equal(response.status, 200, await response.text());
      const entry = (await view(globalAdmin)).organizations.find(item => item.name === normalizeReactionOrganizationName(example.name)); assert(entry);
      const rendered = await preview(globalAdmin, entry.previewUrl); assert.equal((await sharp(rendered).metadata()).exif, undefined);
      assert.equal((await prisma.reactionLogo.findUniqueOrThrow({ where: { id: entry.logoId } })).createdById, globalAdmin.id);
      if (example.format === 'png') organizationLogoId = entry.logoId;
    }
    return { normalizedOrganization: orgName, logoId: organizationLogoId };
  });
  await check('Malformed SVG oversized and excessive-pixel badge uploads are rejected', async () => {
    const name = 'Invalid TEST ' + suffix;
    assert.equal((await upload(globalAdmin, Buffer.from('bad image'), 'organization', name)).status, 400);
    assert.equal((await upload(globalAdmin, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'organization', name, { type: 'image/svg+xml' })).status, 400);
    assert.equal((await upload(globalAdmin, Buffer.alloc(4 * 1024 * 1024 + 1), 'organization', name)).status, 413);
    const oversized = await sharp({ create: { width: 5000, height: 5000, channels: 3, background: 'white' } }).png().toBuffer();
    assert.equal((await upload(globalAdmin, oversized, 'organization', name)).status, 400);
  });
  await check('Normalized duplicate organization is rejected and replacement is explicit', async () => {
    assert.equal((await upload(globalAdmin, organizationIcon, 'organization', ` ${orgName.replaceAll(' ', '\t')} `)).status, 409);
    assert.equal((await upload(globalAdmin, organizationIcon, 'organization', orgName, { replace: true, existingName: secondaryName })).status, 400);
    const original = await prisma.reactionLogo.findUniqueOrThrow({ where: { id: organizationLogoId } });
    const response = await upload(globalAdmin, organizationIcon, 'organization', orgName, { replace: true, existingName: orgRaw }); assert.equal(response.status, 200, await response.text());
    const entry = (await view(globalAdmin)).organizations.find(item => item.name === orgName)!; assert.notEqual(entry.logoId, organizationLogoId);
    organizationLogoId = entry.logoId;
    assert.deepEqual(await prisma.reactionLogo.findUnique({ where: { id: original.id } }), original);
  });
  await check('Organization rename and removal affect only the explicit binding', async () => {
    const original = (await view(globalAdmin)).organizations.find(item => item.name === secondaryName)!;
    const renamed = 'Renamed TEST ' + suffix;
    assert.equal((await mutate(globalAdmin, 'PATCH', { name: secondaryName, newName: ` ${renamed} ` })).status, 200);
    assert.equal((await view(globalAdmin)).organizations.find(item => item.name === renamed)?.logoId, original.logoId);
    assert.equal((await mutate(globalAdmin, 'PATCH', { name: renamed, newName: orgRaw })).status, 409);
    assert.equal((await mutate(globalAdmin, 'DELETE', { name: renamed })).status, 200);
    assert(!(await view(globalAdmin)).organizations.some(item => item.name === renamed));
    assert.equal((await prisma.reactionLogo.findUniqueOrThrow({ where: { id: original.logoId } })).archivedAt, null);
  });
  await check('Cross-origin global mutations and legacy exam badge mutation endpoints are rejected', async () => {
    assert.equal((await upload(globalAdmin, organizationIcon, 'organization', 'Foreign TEST ' + suffix, { origin: 'https://invalid.example' })).status, 403);
    assert.equal((await mutate(globalAdmin, 'PATCH', { name: orgName, newName: secondaryName }, 'https://invalid.example')).status, 403);
    assert.equal((await mutate(globalAdmin, 'DELETE', { name: orgName }, 'https://invalid.example')).status, 403);
    const form = new FormData(); form.set('file', new Blob([new Uint8Array(organizationIcon)], { type: 'image/png' }), 'TEST.png'); form.set('kind', 'logo');
    assert.equal((await fetch(`${base}/api/exams/${organizationFixture.exam.id}/reactions/assets`, { method: 'POST', headers: { cookie: examAdmin.cookie, origin: base }, body: form })).status, 410);
  });
  let defaultLogoId = '', organizationSha = '', defaultSha = '';
  await check('Custom global default covers unmatched and missing organizations', async () => {
    const response = await upload(globalAdmin, defaultIcon, 'default', undefined, { replace: true, existingName: 'default' }); assert.equal(response.status, 200, await response.text());
    const branding = await view(globalAdmin); defaultLogoId = branding.defaultBadge.logoId!; assert(defaultLogoId);
    defaultSha = digest(await preview(globalAdmin, branding.defaultBadge.previewUrl));
    organizationSha = digest(await preview(globalAdmin, branding.organizations.find(item => item.name === orgName)!.previewUrl));
    assert.notEqual(defaultSha, organizationSha);
    for (const school of [null, '', 'Unknown TEST ' + suffix, orgName.toLowerCase(), orgName + ' Extension']) {
      const selected = await resolveReactionBrandingLogo(school); assert.equal(selected.basis, 'system-default'); assert.equal(selected.logoId, defaultLogoId);
    }
    const selected = await resolveReactionBrandingLogo(orgRaw); assert.equal(selected.basis, 'system-organization'); assert.equal(selected.logoId, organizationLogoId); assert.equal(selected.normalizedSchoolName, orgName);
    return { organizationLogoId, defaultLogoId, organizationSha256: organizationSha, defaultSha256: defaultSha };
  });

  const source = await prisma.reaction.findUniqueOrThrow({ where: { id: sourceReactionId } });
  assert.equal(source.status, 'COMPLETE'); assert.equal(source.problemLabel, 'D'); assert.equal(source.originalVerdict, 'AC');
  assert(source.cameraPath && source.desktopPath && source.judgementObservedAt && source.windowEnd);
  async function render(label: 'organization' | 'default', target: typeof organizationFixture, expectedLogoId: string, expectedSha: string, wrongLogoId: string) {
    const prefix = `reactions/${target.exam.id}/branding-test-${suffix}`, directory = path.join(output, label); await fs.mkdir(directory, { recursive: true });
    // These obsolete exam mappings deliberately point at the opposite image; they must never win.
    await prisma.reactionConfig.create({ data: { examId: target.exam.id, presentation: { version: 1, fontPreset: 'broadcast', teamLogos: [{ teamId: target.teamId, logoId: wrongLogoId }], schoolLogos: [{ schoolName: target.candidate.school, logoId: wrongLogoId }], defaultLogoId: wrongLogoId } } });
    const paths: Record<string, string> = {};
    for (const kind of ['camera', 'desktop'] as const) {
      const filename = path.join(scratch, label + '-' + kind + '.mp4'); await materializeReactionObject(source[kind + 'Path' as 'cameraPath' | 'desktopPath']!, filename);
      paths[kind] = (await storeBuffer(await fs.readFile(filename), { prefix, filename: kind + '.mp4', stableName: true, contentType: 'video/mp4' })).objectPath; createdObjects.add(paths[kind]);
    }
    // The snapshot is intentionally different; verified current candidate.school controls branding.
    const snapshotSchool = label === 'organization' ? 'Old Unknown TEST' : orgName;
    const metadata = { schemaVersion: 1, testFixture: true, sourceCaptureReactionId: source.id, examId: target.exam.id, submissionId: 'branding-' + label + '-' + suffix, teamId: target.teamId, schoolName: snapshotSchool, rankContext: null };
    paths.metadata = (await storeBuffer(Buffer.from(JSON.stringify(metadata)), { prefix, filename: 'metadata.json', stableName: true, contentType: 'application/json' })).objectPath; createdObjects.add(paths.metadata);
    const bytes = await reactionObjectBytes(paths.camera) + await reactionObjectBytes(paths.desktop) + await reactionObjectBytes(paths.metadata);
    const reaction = await prisma.reaction.create({ data: {
      examId: target.exam.id, contestId: 'branding-test-no-feed', submissionId: 'branding-' + label + '-' + suffix, teamId: target.teamId, candidateId: target.candidate.id,
      teamName: label === 'organization' ? '组织命中 TEST 队伍' : '默认徽章 TEST 队伍', schoolName: snapshotSchool, problemId: source.problemId, problemLabel: 'D',
      sourceSubmittedAt: source.sourceSubmittedAt, submissionObservedAt: source.submissionObservedAt, judgementObservedAt: source.judgementObservedAt,
      windowStart: source.windowStart, windowEnd: source.windowEnd, status: 'COMPLETE', verdict: 'AC', originalVerdict: 'AC',
      cameraPath: paths.camera, desktopPath: paths.desktop, metadataPath: paths.metadata, outputBytes: bytes, durationSeconds: source.durationSeconds, finalizedAt: new Date()
    } });
    console.log('Generating system branding TEST sample: ' + label);
    await generateStoredReaction(reaction.id);
    const generated = await prisma.reaction.findUniqueOrThrow({ where: { id: reaction.id } }); assert.equal(generated.generationStatus, 'COMPLETE');
    let actualBytes = 0n;
    for (const kind of ['camera', 'desktop', 'reaction', 'metadata'] as const) {
      const key = generated[kind + 'Path' as 'cameraPath' | 'desktopPath' | 'reactionPath' | 'metadataPath']; assert(key && key.startsWith(`reactions/${target.exam.id}/`));
      createdObjects.add(key); actualBytes += await reactionObjectBytes(key);
      await materializeReactionObject(key, path.join(directory, kind + (kind === 'metadata' ? '.json' : '.mp4')));
    }
    const finalMetadata = JSON.parse(await fs.readFile(path.join(directory, 'metadata.json'), 'utf8'));
    assert.equal(finalMetadata.generation.logo.basis, label === 'organization' ? 'system-organization' : 'system-default');
    assert.equal(finalMetadata.generation.logo.source, 'system-reaction-branding'); assert.equal(finalMetadata.generation.logo.logoId, expectedLogoId);
    assert.equal(finalMetadata.generation.logo.sha256, expectedSha); assert.equal(finalMetadata.generation.logo.schoolSource, 'current-candidate');
    assert.equal(finalMetadata.generation.logo.schoolName, target.candidate.school);
    assert(!JSON.stringify(finalMetadata.generation).includes(scratch)); assert.equal(generated.outputBytes, actualBytes); assert.equal(generated.reservedBytes, 0n);
    const filename = path.join(directory, 'reaction.mp4');
    const probe = JSON.parse(await runMedia(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filename], 30000));
    const video = probe.streams.find((item: { codec_type: string }) => item.codec_type === 'video'); assert.equal(video.width, 1080); assert.equal(video.height, 1920); assert.equal(video.codec_name, 'h264');
    await runMedia(process.env.FFMPEG_PATH || 'ffmpeg', ['-nostdin', '-v', 'error', '-xerror', '-i', filename, '-map', '0:v:0', '-f', 'null', '-'], 180000);
    await runMedia(process.env.FFMPEG_PATH || 'ffmpeg', ['-nostdin', '-v', 'error', '-y', '-ss', '2', '-i', filename, '-frames:v', '1', path.join(directory, 'preview.png')], 30000);
    await fs.writeFile(path.join(directory, 'ffprobe.json'), JSON.stringify(probe, null, 2));
    return { directory, sourceCaptureReactionId: source.id, isolatedReactionId: reaction.id, logoId: expectedLogoId, logoSha256: expectedSha, basis: finalMetadata.generation.logo.basis, schoolSource: finalMetadata.generation.logo.schoolSource, legacyExamMappingIgnored: true, outputBytes: actualBytes.toString(), reservedBytes: '0', dimensions: '1080x1920', fullDecode: 'PASS' };
  }
  await check('Official organization video uses current candidate organization and ignores legacy exam overrides', () => render('organization', organizationFixture, organizationLogoId, organizationSha, defaultLogoId));
  await check('Official default video uses global fallback and ignores legacy snapshot and exam overrides', () => render('default', defaultFixture, defaultLogoId, defaultSha, organizationLogoId));
  await check('Removing the custom default selects the same built-in PNG shown in System Settings', async () => {
    assert.equal((await mutate(globalAdmin, 'DELETE', {})).status, 200);
    const selected = await resolveReactionBrandingLogo('Unknown TEST ' + suffix); assert.equal(selected.basis, 'built-in-default'); assert.equal(selected.logoId, null);
    const current = await view(globalAdmin); assert.equal(current.defaultBadge.logoId, null);
    assert.equal(digest(await preview(globalAdmin, current.defaultBadge.previewUrl)), digest(await readBuiltinReactionBadge()));
    assert.equal((await getReactionBranding()).organizations.find(item => item.name === orgName)?.logoId, organizationLogoId);
  });
} catch (error) { process.exitCode = 1; console.error(error instanceof Error ? error.message : 'System branding test failed'); }
finally {
  if (captured && ownsLock) {
    try {
      await prisma.$transaction(async tx => {
        if (expected) await tx.$queryRaw`SELECT \`key\` FROM SystemSetting WHERE \`key\` = ${REACTION_BRANDING_SETTING_KEY} FOR UPDATE`;
        const current = await tx.systemSetting.findUnique({ where: { key: REACTION_BRANDING_SETTING_KEY } });
        assert(sameSetting(current, expected), 'Concurrent branding change detected; original snapshot was NOT restored over another writer');
        if (before) await tx.systemSetting.update({ where: { key: REACTION_BRANDING_SETTING_KEY }, data: { value: before.value as Prisma.InputJsonValue, updatedAt: before.updatedAt } });
        else if (current) await tx.systemSetting.delete({ where: { key: REACTION_BRANDING_SETTING_KEY } });
      }, { isolationLevel: 'Serializable', timeout: 15000 });
      assert(sameSetting(await snapshot(), before), 'Restored setting does not match the original row'); restored = true;
      checks.push({ test: 'Original global organization/default setting restored exactly', result: 'PASS', evidence: { originallyExisted: Boolean(before), mutated, originalUpdatedAtRestored: true } });
      console.log('PASS Original global organization/default setting restored exactly');
    } catch (error) { cleanupErrors.push(error instanceof Error ? error.message : 'Global restore failed'); checks.push({ test: 'Original global organization/default setting restored exactly', result: 'FAIL' }); }
  }
  if (restored) {
    const ownReactions = createdExams.length ? await prisma.reaction.findMany({ where: { examId: { in: createdExams } }, select: { examId: true, cameraPath: true, desktopPath: true, metadataPath: true, reactionPath: true } }) : [];
    for (const reaction of ownReactions) for (const key of [reaction.cameraPath, reaction.desktopPath, reaction.metadataPath, reaction.reactionPath]) if (key?.startsWith(`reactions/${reaction.examId}/`)) createdObjects.add(key);
    for (const id of createdExams) await prisma.exam.delete({ where: { id } }).catch(() => cleanupErrors.push('Could not remove fixture exam ' + id));
    const logos = createdUsers.length ? await prisma.reactionLogo.findMany({ where: { createdById: { in: createdUsers } }, select: { id: true, objectPath: true } }) : [];
    for (const logo of logos) createdObjects.add(logo.objectPath);
    if (logos.length) await prisma.reactionLogo.deleteMany({ where: { id: { in: logos.map(logo => logo.id) }, createdById: { in: createdUsers } } }).catch(() => cleanupErrors.push('Could not remove fixture badge records'));
    for (const key of createdObjects) await deleteStoredObject(key).catch(() => cleanupErrors.push('Could not remove fixture object'));
    for (const id of createdUsers) await prisma.user.delete({ where: { id } }).catch(() => cleanupErrors.push('Could not remove fixture user ' + id));
  }
  if (ownsLock && restored) await fs.rm(lockPath, { force: true });
  if (cleanupErrors.length) process.exitCode = 1;
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ startedAt: initialAt, finishedAt: new Date().toISOString(), fixtureKind: 'ISOLATED_EXAMS_AND_SYNTHETIC_D_AC_MEDIA', sourceCaptureReactionId: sourceReactionId, userExamModified: false, checks, globalSettingRestored: restored, cleanupErrors, isolatedFixturesRemoved: restored && !cleanupErrors.length, passed: checks.length === 12 && checks.every(item => item.result === 'PASS') && restored && !cleanupErrors.length }, null, 2));
  await prisma.$disconnect();
}
