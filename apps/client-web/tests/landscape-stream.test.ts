import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

function harness(options: { capture?: boolean; context?: boolean } = {}) {
  const source = readFileSync(new URL('../src/components/CandidateApp.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('async function createLandscapeStream(');
  const code = source.slice(start, source.indexOf('\nfunction readPairPayload(', start));
  const angles: number[] = [], drawings: number[][] = [], frames: Array<(time: number) => void> = [];
  let stopped = 0, fps = 0;
  const processed = { getTracks: () => [{ stop: () => { stopped++; } }] };
  const canvas = { width: 0, height: 0,
    ...(options.capture === false ? {} : { captureStream: (rate: number) => { fps = rate; return processed; } }),
    getContext: () => options.context === false ? null : ({
    save() {}, restore() {}, fillRect() {}, translate() {}, rotate: (angle: number) => angles.push(angle),
    drawImage: (_video: unknown, ...values: number[]) => drawings.push(values),
  }) };
  const video = { videoWidth: 720, videoHeight: 1280, srcObject: null, play: async () => {}, pause() {} };
  const context = vm.createContext({ document: { createElement: (name: string) => name === 'canvas' ? canvas : video },
    performance: { now: () => 0 },
    window: { requestAnimationFrame: (frame: (time: number) => void) => { frames.push(frame); return frames.length; }, cancelAnimationFrame() {} },
    stopStream: (stream: typeof processed) => stream.getTracks().forEach(track => track.stop()),
  });
  vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return { create: context.createLandscapeStream, angles, drawings, frames, canvas, video, processed, fps: () => fps, stopped: () => stopped };
}

test('portrait camera frames become a 720p landscape stream and manual rotation still applies after reconnect', async () => {
  const h = harness();
  const rotation = { current: 270 }, rawCamera = { id: 'portrait-camera' };
  const result = await h.create(rawCamera, rotation);
  assert.equal(result.stream, h.processed); assert.notEqual(result.stream, rawCamera);
  assert.equal(h.canvas.width, 1280); assert.equal(h.canvas.height, 720); assert.equal(h.fps(), 20);
  assert.ok(Math.abs(Math.sin(h.angles[0]) + 1) < 1e-9, '270 degrees is a counterclockwise quarter-turn');
  assert.equal(h.drawings[0][2], 720); assert.equal(h.drawings[0][3], 1280, 'the rotated portrait fills the landscape frame');
  rotation.current = 0; h.frames.shift()!(50); assert.equal(h.angles[1], 0);
  assert.equal(rotation.current, 0, 'a selected manual direction is not reset by frame rendering');
  result.stop(); assert.equal(h.stopped(), 1); assert.equal(h.video.srcObject, null);
  const drawingsAtStop = h.drawings.length;
  h.frames.shift()!(100);
  assert.equal(h.drawings.length, drawingsAtStop, 'a late frame after stop cannot keep drawing');
  assert.equal(h.frames.length, 0);
});

test('60 and 120 Hz displays draw no more than 20 camera frames per second', async () => {
  for (const refreshRate of [60, 120]) {
    const h = harness();
    const result = await h.create({ id: 'camera' }, { current: 270 });
    for (let frame = 1; frame < refreshRate; frame++) h.frames.shift()!(frame * 1000 / refreshRate);
    assert.ok(h.drawings.length >= 19 && h.drawings.length <= 20, `${refreshRate} callbacks drew ${h.drawings.length} frames`);
    h.frames.shift()!(5000);
    assert.ok(h.drawings.length <= 21, 'resuming a suspended tab never redraws the missed frames in a burst');
    result.stop();
  }
});

test('all manual rotations survive reconnect and canvas-unavailable browsers retain their source stream', async () => {
  for (const rotation of [0, 90, 180, 270]) {
    const h = harness();
    const result = await h.create({ id: 'camera' }, { current: rotation });
    assert.equal(h.angles[0], rotation * Math.PI / 180);
    result.stop();
  }
  for (const options of [{ capture: false }, { context: false }]) {
    const h = harness(options);
    const source = { id: 'fallback-camera' };
    const result = await h.create(source, { current: 90 });
    assert.equal(result.stream, source);
    assert.equal(h.frames.length, 0);
    result.stop();
    assert.equal(h.stopped(), 0, 'the source camera remains owned by the caller');
    assert.equal(h.video.srcObject, null);
  }
});
