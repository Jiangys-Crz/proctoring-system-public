import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requiredTestMediaReady } from '../src/lib/test-media-state';

test('public tests start with screen and second-camera streams even without a front camera', () => {
  const required = [
    { channel: 'DESKTOP_SCREEN', ready: true },
    { channel: 'MOBILE_CAMERA', ready: true },
  ];
  assert.equal(requiredTestMediaReady(required), true);
  assert.equal(requiredTestMediaReady([...required, { channel: 'DESKTOP_CAMERA', ready: false }]), true);
  assert.equal(requiredTestMediaReady([...required, { channel: 'DESKTOP_CAMERA', ready: true }]), true);
});

test('an optional front camera cannot substitute for either required test stream', () => {
  for (const missing of ['DESKTOP_SCREEN', 'MOBILE_CAMERA']) {
    const channels = ['DESKTOP_SCREEN', 'DESKTOP_CAMERA', 'MOBILE_CAMERA'].map(channel => ({ channel, ready: channel !== missing }));
    assert.equal(requiredTestMediaReady(channels), false, missing);
    assert.equal(requiredTestMediaReady(channels.filter(item => item.channel !== missing)), false, missing);
  }
  assert.equal(requiredTestMediaReady([]), false);
});
