import assert from 'node:assert/strict';
import test from 'node:test';
import { cameraPlaceholderReason } from '../src/lib/reaction-camera-source';
import { planReactionGeneration } from '../src/lib/reaction-generator';

const metadata = (camera: unknown) => ({ channels: { DESKTOP_CAMERA: camera } });
test('missing camera uses explicit placeholder; unknown/dark playable footage remains a recording', () => {
  assert.equal(cameraPlaceholderReason(null, {}), 'MISSING_CAMERA_RECORDING');
  for (const data of [{}, metadata({ complete: true, slices: [] }), metadata({ complete: false })]) {
    assert.equal(cameraPlaceholderReason('camera.mp4', data), null);
  }
});
test('only explicit capture evidence of zero retained camera frames identifies old filler', () => {
  assert.equal(cameraPlaceholderReason('camera.mp4', metadata({complete:false,slices:[]})), 'NO_CAPTURED_CAMERA_FRAMES');
  const zero = {complete:false,slices:[{id:'one'},{id:'two'}],frameTiming:{one:{selectedFrames:0,timestampsVerified:true},two:{selectedFrames:0,timestampsVerified:true}}};
  assert.equal(cameraPlaceholderReason('camera.mp4', metadata(zero)), 'NO_CAPTURED_CAMERA_FRAMES');
  zero.frameTiming.two.selectedFrames=1;
  assert.equal(cameraPlaceholderReason('camera.mp4', metadata(zero)), null);
  assert.equal(cameraPlaceholderReason('camera.mp4', metadata({complete:false,slices:[{id:'unknown'}],frameTiming:{}})), null);
});
test('zero selected frames caused by unknown or invalid timestamps cannot hide real camera footage', () => {
  for(const timing of [{selectedFrames:0,decodedFrames:1},{selectedFrames:0,decodedFrames:2,timestampsVerified:false,firstPtsSeconds:0,lastPtsSeconds:1,requestedFromSeconds:2}]) {
    assert.equal(cameraPlaceholderReason('camera.mp4',metadata({complete:false,slices:[{id:'source'}],frameTiming:{source:timing}})),null);
  }
});
test('legacy capture metadata needs positive evidence that the requested slice starts after the last frame', () => {
  const legacy={complete:false,slices:[{id:'old'}],frameTiming:{old:{firstPtsSeconds:0,lastPtsSeconds:1,requestedFromSeconds:2,maxFrameIntervalSeconds:1,decodedFrames:20}}};
  assert.equal(cameraPlaceholderReason('camera.mp4', metadata(legacy)), 'NO_CAPTURED_CAMERA_FRAMES');
  legacy.frameTiming.old.requestedFromSeconds=.5;
  assert.equal(cameraPlaceholderReason('camera.mp4', metadata(legacy)), null);
});
test('camera placeholder does not shorten the desktop window and cannot authorize COMPLETE', () => {
  const plan=planReactionGeneration(null,2.2,{allowPartial:true,windowDurationSeconds:4,judgementOffsetSeconds:1});
  assert.equal(plan.selectedDurationSeconds,2.2);assert.equal(plan.cameraDurationSeconds,null);
  assert.equal(plan.policy,'DESKTOP_START_MIN_DURATION');assert.equal(plan.degraded,true);
  assert.equal(planReactionGeneration(null,4,{allowPartial:true,windowDurationSeconds:1.51,judgementOffsetSeconds:1}).selectedDurationSeconds,1.48);
  assert.throws(()=>planReactionGeneration(null,2,{windowDurationSeconds:4,judgementOffsetSeconds:1}),/TIMING_INVALID/);
  assert.throws(()=>planReactionGeneration(null,0,{allowPartial:true,windowDurationSeconds:4,judgementOffsetSeconds:1}),/TIMING_INVALID/);
});
