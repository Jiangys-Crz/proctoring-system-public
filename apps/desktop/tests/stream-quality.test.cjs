const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../src/renderer/renderer.js'), 'utf8');
function harness(extra = {}) {
  const context = vm.createContext({ ...extra });
  vm.runInContext(source.slice(source.indexOf('const captureProfile ='), source.indexOf('function apiUrl('))
    + source.slice(source.indexOf('function whipEncoding('), source.indexOf('function whipEndpoint(')), context);
  return context;
}

test('screen publishing preserves text resolution while cameras yield bandwidth', async () => {
  const context = harness();
  const rows = [];
  const sender = { getParameters: () => ({ encodings: [{ active: true, rid: 'main' }] }),
    setParameters: async parameters => rows.push(parameters) };
  await context.configureWhipSender(sender, 'DESKTOP_SCREEN');
  await context.configureWhipSender(sender, 'DESKTOP_CAMERA');
  assert.equal(rows[0].degradationPreference, 'maintain-resolution');
  assert.equal(rows[0].encodings[0].maxFramerate, 30);
  assert.equal(rows[0].encodings[0].maxBitrate, 3_000_000);
  assert.equal(rows[0].encodings[0].rid, 'main', 'negotiated encoding identity must be retained');
  assert.equal(rows[1].degradationPreference, 'maintain-framerate');
  assert.equal(rows[1].encodings[0].maxFramerate, 20);
  assert.equal(rows[1].encodings[0].maxBitrate, 450_000);
});

test('Windows 7 reduces software encoding work without reducing screen resolution', async () => {
  const context = harness();
  context.configureCaptureProfile('win32 6.1.7601');
  const parameters = [];
  await context.configureWhipSender({ getParameters: () => ({}), setParameters: async value => parameters.push(value) }, 'DESKTOP_SCREEN');
  assert.equal(parameters[0].encodings[0].maxFramerate, 15);
  assert.equal(parameters[0].degradationPreference, 'maintain-resolution');
  assert.equal(vm.runInContext('captureProfile.width', context), 1920);
  assert.equal(vm.runInContext('captureProfile.height', context), 1080);
  assert.equal(vm.runInContext('captureProfile.recordingFrameRate', context), 10);
});

test('older sender rejecting degradation preference still receives bitrate and frame limits', async () => {
  const context = harness();
  const calls = [];
  await context.configureWhipSender({
    getParameters: () => ({}),
    setParameters: async parameters => {
      calls.push(structuredClone(parameters));
      if ('degradationPreference' in parameters) throw new Error('unsupported preference');
    },
  }, 'DESKTOP_SCREEN');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].degradationPreference, undefined);
  assert.equal(calls[1].encodings[0].maxBitrate, 3_000_000);
  assert.equal(calls[1].encodings[0].maxFramerate, 30);
});

test('initial and replacement screen tracks both keep the text hint', () => {
  const track = { contentHint: '', addEventListener() {} };
  const context = harness({ state: { screenStream: { getVideoTracks: () => [track] } } });
  vm.runInContext(source.slice(source.indexOf('function attachScreenTrackWatchers('), source.indexOf('function scheduleWindowModeCaptureRecovery(')), context);
  context.attachScreenTrackWatchers();
  assert.equal(track.contentHint, 'text');
  track.contentHint = '';
  context.attachScreenTrackWatchers();
  assert.equal(track.contentHint, 'text');
});

test('screen capture respects source dimensions instead of forcing smaller screens to upscale', async () => {
  const requests = [];
  const context = harness({ navigator: { mediaDevices: { getUserMedia: async value => { requests.push(value); return {}; } } } });
  vm.runInContext(source.slice(source.indexOf('async function captureElectronScreenWithSource('), source.indexOf('async function captureElectronScreen()')), context);
  await context.captureElectronScreenWithSource({ id: 'screen:1' });
  await context.captureElectronScreenWithoutSource();
  for (const { video: { mandatory } } of requests) {
    assert.equal(mandatory.maxWidth, 1920);
    assert.equal(mandatory.maxHeight, 1080);
    assert.equal(mandatory.minWidth, undefined);
    assert.equal(mandatory.minHeight, undefined);
  }
});
