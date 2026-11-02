const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../src/renderer/capture-policy.js');

test('Windows 7 recording prefers VP8; other platforms retain their original codec order', () => {
  assert.equal(proctorRecordingMimeTypes('win32 6.1.7601')[0], 'video/webm;codecs=vp8,opus');
  assert.equal(proctorRecordingMimeTypes('win32 10.0.19045')[0], 'video/webm;codecs=vp9,opus');
  assert.equal(proctorRecordingMimeTypes('darwin 25.6.0').at(-1), 'video/webm');
});

test('no capture or preview is active before a login session exists', () => {
  assert.deepEqual(proctorCapturePolicy(null, { requireFrontCamera: true }, { screen: true, camera: true }), {
    captureScreen: false, captureCamera: false, previewScreen: false, previewCamera: false, channels: []
  });
});

test('screen-only rooms never publish or preview the desktop camera', () => {
  assert.deepEqual(proctorCapturePolicy({ id: 'session', status: 'WAITING_REVIEW' }, { requireFrontCamera: false }, { screen: true, camera: true }), {
    captureScreen: true, captureCamera: false, previewScreen: true, previewCamera: false, channels: ['DESKTOP_SCREEN']
  });
});

test('front-camera rooms publish and preview both desktop sources after login', () => {
  const policy = proctorCapturePolicy({ id: 'session', status: 'IN_EXAM' }, { requireFrontCamera: true }, { screen: true, camera: true });
  assert.equal(policy.previewScreen, true);
  assert.equal(policy.previewCamera, true);
  assert.deepEqual(policy.channels, ['DESKTOP_SCREEN', 'DESKTOP_CAMERA']);
});

test('cheating and USB fullscreen lockdown keep both live channels active', () => {
  for (const reason of ['被监考老师标记为作弊', '检测到外设接入或移除']) {
    const policy = proctorCapturePolicy({ id: 'session', status: 'LOCKED', lockdown: true, lockdownReason: reason }, { requireFrontCamera: true }, { screen: true, camera: true });
    assert.equal(policy.captureScreen, true);
    assert.equal(policy.captureCamera, true);
    assert.deepEqual(policy.channels, ['DESKTOP_SCREEN', 'DESKTOP_CAMERA']);
  }
});

test('desktop channels remain independent when either local source is unavailable', () => {
  const session = { id: 'session', status: 'IN_EXAM' };
  const requirements = { requireFrontCamera: true };
  const screenOnlyLive = proctorCapturePolicy(session, requirements, { screen: true, camera: false });
  const cameraOnlyLive = proctorCapturePolicy(session, requirements, { screen: false, camera: true });

  assert.equal(screenOnlyLive.previewScreen, true);
  assert.equal(screenOnlyLive.previewCamera, false);
  assert.equal(cameraOnlyLive.previewScreen, false);
  assert.equal(cameraOnlyLive.previewCamera, true);
  assert.deepEqual(screenOnlyLive.channels, ['DESKTOP_SCREEN', 'DESKTOP_CAMERA']);
  assert.deepEqual(cameraOnlyLive.channels, ['DESKTOP_SCREEN', 'DESKTOP_CAMERA']);
});

test('finished sessions stop all capture channels', () => {
  assert.deepEqual(proctorCapturePolicy({ id: 'session', status: 'FINISHED' }, { requireFrontCamera: true }, { screen: true, camera: true }).channels, []);
});
