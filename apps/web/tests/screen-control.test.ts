import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { normalizeScreenControlImage } from '../src/lib/screen-control-images';
import { serializeScreenControlDisplay } from '../src/lib/screen-control';
import { orderedScreenParticipantNames } from '../src/lib/screen-control-participant-card';
import {
  CreateScreenControlDisplaySchema, effectiveScreenDisplay, SCREEN_CONTROL_MAX_GROUP_BYTES,
  SCREEN_CONTROL_MAX_IMAGE_BYTES, ScreenControlActionSchema, validateScreenDisplayImageCount, validateScreenDisplayTimes,
  validateScreenImageOrder, validateScreenUploadSizes,
} from '../src/lib/screen-control-policy';

const instant = new Date('2026-10-07T02:00:00Z');
function display(id: string, offset: number, options: Record<string, unknown> = {}) {
  return { id, startsAt: new Date(+instant + offset), endsAt: null, stoppedAt: null, canceledAt: null,
    createdAt: instant, sequence: offset, ...options } as Parameters<typeof effectiveScreenDisplay>[0][number];
}

test('screen display schedules start at the server instant and end exactly at their deadline', () => {
  const scheduled = display('scheduled', 5_000, { endsAt: new Date(+instant + 10_000) });
  assert.equal(effectiveScreenDisplay([scheduled], instant), null);
  assert.equal(effectiveScreenDisplay([scheduled], scheduled.startsAt)?.id, 'scheduled');
  assert.equal(effectiveScreenDisplay([scheduled], new Date(+instant + 9_999))?.id, 'scheduled');
  assert.equal(effectiveScreenDisplay([scheduled], new Date(+instant + 10_000)), null);
});

test('later pushes permanently supersede older displays without resuming them after stop or expiry', () => {
  const old = display('old', -30_000);
  for (const latest of [display('new', -5_000, { endsAt: instant }), display('new', -5_000, { stoppedAt: instant })]) {
    assert.equal(effectiveScreenDisplay([old, latest], instant), null);
  }
  assert.equal(effectiveScreenDisplay([old, display('scheduled', 5_000)], instant)?.id, 'old');
  assert.equal(effectiveScreenDisplay([old, display('canceled', -5_000, { canceledAt: instant })], instant)?.id, 'old');
});

test('same-start schedules select the last persisted push deterministically', () => {
  assert.equal(effectiveScreenDisplay([display('z-old', 0, { sequence: 1 }), display('a-new', 0, { sequence: 2 })], instant)?.id, 'a-new');
});

test('schedule validation rejects naive timezone, invalid past times and deadlines before start', () => {
  assert.equal(CreateScreenControlDisplaySchema.safeParse({ groupId: 'g', startsAt: '2026-10-07T10:00:00' }).success, false);
  assert.equal(CreateScreenControlDisplaySchema.safeParse({ groupId: 'g', startsAt: '2026-10-07T10:00:00+08:00' }).success, true);
  assert.throws(() => validateScreenDisplayTimes({ startsAt: '2026-10-07T01:59:59Z' }, instant), /晚于当前/);
  assert.throws(() => validateScreenDisplayTimes({ endsAt: instant.toISOString() }, instant), /截止时间/);
  assert.throws(() => validateScreenDisplayTimes({ startsAt: 'invalid' }, instant), /不正确/);
  assert.deepEqual(validateScreenDisplayTimes({}, instant), { startsAt: instant, endsAt: null });
  assert.equal(ScreenControlActionSchema.safeParse({ action: 'CANCEL' }).success, false);
});

test('image reorder cannot omit, duplicate or introduce another group image', () => {
  assert.doesNotThrow(() => validateScreenImageOrder(['a', 'b'], ['b', 'a']));
  for (const ids of [['a'], ['a', 'a'], ['a', 'other'], ['a', 'b', 'other']]) {
    assert.throws(() => validateScreenImageOrder(['a', 'b'], ids), /全部图片/);
  }
});

test('a push appends one participant slide without modifying the stored group or desktop interval', () => {
  const group = {
    id: 'group', examId: 'exam', name: '原图', createdAt: instant, updatedAt: instant,
    images: [{ id: 'image', name: '比赛规则.webp', order: 0, width: 100, height: 100, byteSize: 500 }],
  };
  const push = {
    id: 'push', examId: 'exam', groupId: group.id, groupName: group.name, createdAt: instant, createdById: null,
    startsAt: instant, endsAt: null, stoppedAt: null, canceledAt: null, sequence: 1, showParticipantCard: true, group,
  };
  const enabled = serializeScreenControlDisplay(push, 'session');
  const disabled = serializeScreenControlDisplay({ ...push, showParticipantCard: false }, 'session');
  assert.deepEqual(enabled.images.slice(0, 1), disabled.images);
  assert.equal(enabled.intervalMs, 5000);
  assert.deepEqual(enabled.images[1], {
    id: 'participant-push', name: '参赛信息图.webp', order: 1, width: 1920, height: 1080, byteSize: 0,
    url: '/api/client/screen-control/images/participant-push?sessionId=session',
  });
  assert.equal(group.images.length, 1);
  assert.equal(serializeScreenControlDisplay(push).showParticipantCard, true);
  assert.equal(CreateScreenControlDisplaySchema.parse({ groupId: group.id }).showParticipantCard, false);
  assert.throws(() => validateScreenDisplayImageCount(30, true), /29/);
  assert.doesNotThrow(() => validateScreenDisplayImageCount(29, true));
  assert.doesNotThrow(() => validateScreenDisplayImageCount(30, false));
  const only = { ...push, groupId: 'participant-card-exam' };
  assert.deepEqual(serializeScreenControlDisplay(only, 'session').images.map(image => image.id), ['participant-push']);
  assert.equal(serializeScreenControlDisplay(only).participantCardOnly, true);
  assert.equal(CreateScreenControlDisplaySchema.safeParse({ participantCardOnly: true }).success, true);
  assert.equal(CreateScreenControlDisplaySchema.safeParse({ groupId: group.id, participantCardOnly: true }).success, false);
  assert.equal(CreateScreenControlDisplaySchema.safeParse({}).success, false);
});

test('participant slides put the captain first and preserve member order and identical names', () => {
  assert.deepEqual(orderedScreenParticipantNames([
    { name: ' 李四 ', isTeamLeader: false, memberOrder: 2 },
    { name: '王五', isTeamLeader: false, memberOrder: 1 },
    { name: '张三', isTeamLeader: true, memberOrder: 3 },
    { name: null, isTeamLeader: false, memberOrder: 4 },
    { name: '李四', isTeamLeader: false, memberOrder: 5 },
  ]), ['张三', '王五', '李四', '李四']);
});

test('upload limits reject empty groups, image count, file size and total size', () => {
  assert.throws(() => validateScreenUploadSizes([]), /1 至 30/);
  assert.throws(() => validateScreenUploadSizes(Array(31).fill(1)), /1 至 30/);
  for (const size of [0, -1, NaN, SCREEN_CONTROL_MAX_IMAGE_BYTES + 1]) {
    assert.throws(() => validateScreenUploadSizes([size]), /10MB/);
  }
  assert.throws(() => validateScreenUploadSizes(Array(9).fill(SCREEN_CONTROL_MAX_IMAGE_BYTES)), /80MB/);
  assert.doesNotThrow(() => validateScreenUploadSizes(Array(8).fill(SCREEN_CONTROL_MAX_GROUP_BYTES / 8)));
});

test('image validation decodes bytes, blocks disguised text/SVG/corruption and excessive dimensions', async () => {
  for (const bytes of [Buffer.from('not an image.jpg'), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"></svg>'), Buffer.from([0x89, 0x50, 0x4e, 0x47])]) {
    await assert.rejects(normalizeScreenControlImage(bytes), /图片/);
  }
  const oversized = await sharp({ create: { width: 10_001, height: 1, channels: 3, background: '#fff' } }).png().toBuffer();
  await assert.rejects(normalizeScreenControlImage(oversized), /10000/);
  const input = await sharp({ create: { width: 4, height: 7, channels: 4, background: '#ffffff80' } }).png().toBuffer();
  const normalized = await normalizeScreenControlImage(input);
  assert.equal(normalized.contentType, 'image/webp');
  assert.equal(normalized.width, 4);
  assert.equal(normalized.height, 7);
  assert.equal((await sharp(normalized.buffer).metadata()).hasAlpha, true);
});

test('image normalization honors orientation and strips metadata before broadcasting', async () => {
  const input = await sharp({ create: { width: 4, height: 7, channels: 3, background: '#fff' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const normalized = await normalizeScreenControlImage(input);
  assert.equal(normalized.width, 7);
  assert.equal(normalized.height, 4);
  const metadata = await sharp(normalized.buffer).metadata();
  assert.equal(metadata.exif, undefined);
  assert.equal(metadata.orientation, undefined);
});
