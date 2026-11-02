import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';
import { cameraErrorMessage } from '../src/lib/camera';

const source = readFileSync(new URL('../src/components/CandidateApp.tsx', import.meta.url), 'utf8');
const dialogStart = source.indexOf('function CaptureDialog(');
const callbacks = source.slice(source.indexOf('  const videoRef = ', dialogStart), source.indexOf('  async function useNativeFile', dialogStart));
const stateNames = [...callbacks.matchAll(/const \[([^,]+),/g)].map(match => match[1]);

// Run the real request/retry callbacks with delayed camera responses, including a grant after closing.
function capture(mode: 'photo' | 'video' | 'qr', request: (constraints: MediaStreamConstraints) => Promise<MediaStream>) {
  const state: Record<string, unknown> = {};
  const effects: Array<() => (() => void)> = [];
  let stateIndex = 0;
  const context = vm.createContext({
    mode, cameraErrorMessage, requestCameraStream: request,
    window: { isSecureContext: true, cancelAnimationFrame() {}, clearTimeout() {} },
    navigator: { mediaDevices: { getUserMedia() {} } },
    useRef: (current: unknown) => ({ current }),
    useCallback: (callback: unknown) => callback,
    useEffect: (callback: () => (() => void)) => effects.push(callback),
    useState: (initial: unknown) => {
      const name = stateNames[stateIndex++];
      state[name] = initial;
      return [initial, (value: unknown) => { state[name] = typeof value === 'function' ? value(state[name]) : value; }];
    },
    stopStream: (stream: MediaStream | null) => stream?.getTracks().forEach(track => track.stop()),
  });
  vm.runInContext(ts.transpileModule(callbacks + '\nglobalThis.retry = retryCamera; globalThis.release = cleanup;', {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  return { state, retry: () => context.retry(), close: () => context.release(), open: () => effects[0]() };
}

for (const mode of ['photo', 'video', 'qr'] as const) {
  test(`${mode}: every failed permission request reopens the prompt, and an allowed retry recovers`, async () => {
    const constraints: MediaStreamConstraints[] = [];
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    const h = capture(mode, async value => {
      constraints.push(value);
      if (constraints.length <= 2) throw { name: 'NotAllowedError' };
      return stream;
    });
    h.open();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.state.cameraPrompt, true);
    assert.equal(h.state.ready, false);
    h.retry();
    assert.equal(constraints.length, 2, 'retry starts the camera request within the user click');
    assert.equal(h.state.cameraPrompt, false);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.state.cameraPrompt, true, 'another denial reopens the authorization prompt');
    h.retry();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.state.cameraPrompt, false);
    assert.equal(h.state.nativeCapture, false);
    assert.equal(h.state.ready, true);
    assert.equal(constraints[2].audio, mode === 'video');
    h.close();
  });
}

test('closing while authorization is pending releases a later granted camera and prevents duplicate requests', async () => {
  let grant!: (stream: MediaStream) => void;
  let requests = 0, stopped = 0;
  const h = capture('video', () => { requests++; return new Promise(resolve => { grant = resolve; }); });
  h.open();
  h.retry();
  assert.equal(requests, 1);
  h.close();
  grant({ getTracks: () => [{ stop: () => stopped++ }] } as unknown as MediaStream);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, 1);
  assert.equal(h.state.ready, false);
  assert.equal(h.state.cameraPrompt, false);
});

test('a late permission rejection after closing cannot reopen the prompt', async () => {
  let deny!: (error: unknown) => void;
  const h = capture('qr', () => new Promise((_resolve, reject) => { deny = reject; }));
  h.open();
  h.close();
  deny({ name: 'NotAllowedError' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.state.cameraPrompt, false);
  assert.equal(h.state.error, '');
});
