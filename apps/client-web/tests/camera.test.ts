import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { cameraErrorMessage, isCameraPermissionError, requestCameraStream } from '../src/lib/camera';

const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
afterEach(() => {
  if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
  else Reflect.deleteProperty(globalThis, 'navigator');
});

function camera(getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>) {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia } } });
}

test('a denied camera can be requested again after the user allows permission, without automatic repeated prompts', async () => {
  let calls = 0;
  const restored = {} as MediaStream;
  camera(async () => {
    if (++calls === 1) throw { name: 'NotAllowedError' };
    return restored;
  });
  await assert.rejects(requestCameraStream({ video: true, audio: false }), error => isCameraPermissionError(error));
  assert.equal(calls, 1);
  assert.equal(await requestCameraStream({ video: true, audio: false }), restored);
  assert.equal(calls, 2);
});

test('mobile constraint fallback opens the available camera and preserves the requested microphone', async () => {
  const calls: MediaStreamConstraints[] = [];
  const restored = {} as MediaStream;
  camera(async constraints => {
    calls.push(constraints);
    if (calls.length === 1) throw { name: 'OverconstrainedError' };
    return restored;
  });
  assert.equal(await requestCameraStream({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 } }, audio: true }), restored);
  assert.deepEqual(calls[1], { video: true, audio: true });
});

test('busy cameras wait for release and an explicit retry', async () => {
  let calls = 0;
  camera(async () => { calls++; throw { name: 'NotReadableError' }; });
  await assert.rejects(requestCameraStream({ video: true }), error => (error as { name: string }).name === 'NotReadableError');
  assert.equal(calls, 1);
  assert.match(cameraErrorMessage({ name: 'NotReadableError' }), /占用/);
  assert.match(cameraErrorMessage({ name: 'NotAllowedError' }, true), /摄像头和麦克风/);
});
