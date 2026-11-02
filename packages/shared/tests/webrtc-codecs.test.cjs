const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const source = readFileSync(require.resolve('../src/webrtc-codecs.js'), 'utf8');
const vp8 = { mimeType: 'video/VP8', clockRate: 90000 };
const h264 = { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'profile-level-id=42e01f;packetization-mode=1' };
const rtx = { mimeType: 'video/rtx', clockRate: 90000 };
function helper(sender, receiver, name = 'proctorPreferH264') {
  const context = vm.createContext({ RTCRtpSender: sender, RTCRtpReceiver: receiver });
  vm.runInContext(source, context);
  return context[name];
}
const capabilities = codecs => ({ getCapabilities: () => ({ codecs }) });

test('preferences use common exact browser dictionaries and retain VP8 and repair codecs', () => {
  const receiveH264 = { ...h264, sdpFmtpLine: 'packetization-mode=1; profile-level-id=42e01f' };
  const unsupportedH264 = { ...h264, sdpFmtpLine: 'profile-level-id=640c1f;packetization-mode=1' };
  const sender = [vp8, h264, unsupportedH264, rtx], receiver = [vp8, receiveH264, rtx];
  let ordered;
  helper(capabilities(sender), capabilities(receiver))({ setCodecPreferences: codecs => { ordered = codecs; } });
  assert.equal(ordered[0], receiveH264);
  assert.equal(ordered.length, 3);
  assert.ok(ordered.includes(vp8)); assert.ok(ordered.includes(rtx));
  assert.equal(sender[0], vp8); assert.equal(receiver[0], vp8);
});

test('a rejected H264 preference resets to defaults without interrupting publishing', () => {
  const calls = [];
  helper(capabilities([vp8, h264]), capabilities([vp8, h264]))({ setCodecPreferences: codecs => {
    calls.push(codecs);
    if (codecs.length) throw new Error('Invalid codec preferences: invalid codec with name "H264"');
  } });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].length, 0);
});

test('missing or inconsistent capabilities and unsupported preference APIs keep default negotiation', () => {
  for (const sender of [undefined, { getCapabilities: () => null }, { getCapabilities: () => { throw new Error('unsupported'); } }, capabilities([vp8])]) {
    assert.doesNotThrow(() => helper(sender, undefined)({ setCodecPreferences() { throw new Error('unsupported'); } }));
  }
  let calls = 0;
  helper(capabilities([h264]), capabilities([vp8]))({ setCodecPreferences() { calls++; } });
  assert.equal(calls, 0);
  assert.doesNotThrow(() => helper(undefined, undefined)({}));
});

test('VP8 recovery excludes every H264 profile and keeps exact common VP8 and RTX dictionaries', () => {
  const receiveVp8 = { ...vp8 };
  const sender = [h264, vp8, rtx, { mimeType: 'video/VP9', clockRate: 90000 }];
  const receiver = [h264, receiveVp8, rtx];
  let ordered;
  const applied = helper(capabilities(sender), capabilities(receiver), 'proctorPreferVp8')({
    setCodecPreferences: codecs => { ordered = codecs; }
  });
  assert.equal(applied, true);
  assert.equal(ordered.length, 2);
  assert.equal(ordered[0], receiveVp8);
  assert.equal(ordered[1], rtx);
  assert.equal(sender.length, 4);
});

test('VP8 recovery reports unavailable or rejected preferences instead of claiming a fallback was applied', () => {
  const rejected = [];
  assert.equal(helper(capabilities([vp8]), capabilities([vp8]), 'proctorPreferVp8')({
    setCodecPreferences: codecs => { rejected.push(codecs); if (codecs.length) throw new Error('unsupported'); }
  }), false);
  assert.equal(rejected[1].length, 0);
  assert.equal(helper(capabilities([h264]), capabilities([h264]), 'proctorPreferVp8')({
    setCodecPreferences() { assert.fail('unavailable VP8 must not be requested'); }
  }), false);
  assert.equal(helper(capabilities([vp8]), capabilities([vp8]), 'proctorPreferVp8')({}), false);
});
