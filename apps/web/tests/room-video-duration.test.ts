import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { isValidRoomVideoDuration } from '@cwnupaa/proctor-shared';
import { validateMedia } from '../src/lib/media-validation';

const run = promisify(execFile);
const ffmpeg = process.env.FFMPEG_PATH || createRequire(new URL('../../desktop/package.json', import.meta.url))('ffmpeg-static');

test('login environment videos accept only finite durations from 3 through 15 seconds, inclusive', () => {
  for (const duration of [3, 3.001, 8, 14.999, 15]) assert.equal(isValidRoomVideoDuration(duration), true);
  for (const duration of [null, undefined, NaN, Infinity, -1, 0, 2.999, 15.001, 120]) assert.equal(isValidRoomVideoDuration(duration), false);
});

for (const duration of [2.9, 3, 15, 15.1]) {
  test(`actual decoded ${duration}-second video is ${duration >= 3 && duration <= 15 ? 'accepted' : 'rejected'} for login materials`, async () => {
    const { stdout } = await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=size=32x32:rate=10',
      '-t', String(duration), '-c:v', 'libvpx', '-f', 'webm', 'pipe:1'], { encoding: 'buffer', maxBuffer: 1024 * 1024 });
    for (const memoryOnly of [false, true]) {
      if (duration >= 3 && duration <= 15) {
        const result = await validateMedia(stdout, 'ROOM_VIDEO', 'video/webm', { memoryOnly });
        assert.equal(result.duration, duration);
      } else {
        await assert.rejects(validateMedia(stdout, 'ROOM_VIDEO', 'video/webm', { memoryOnly }), /3–15 秒/);
      }
    }
    // Ongoing monitoring recordings use a different policy.
    if (duration > 15) assert.equal((await validateMedia(stdout, 'MOBILE_CAMERA', 'video/webm', { memoryOnly: true })).duration, duration);
  });
}
