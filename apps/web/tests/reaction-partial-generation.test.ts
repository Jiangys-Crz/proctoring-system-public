import assert from 'node:assert/strict';
import test from 'node:test';
import { planReactionGeneration } from '../src/lib/reaction-generator';

test('PARTIAL uses the minimum of both videos and original common window', () => {
  for (const [camera,desktop,window,expected] of [[2,3,4,2],[3,2,4,2],[3,4,1.5,1.48]]) {
    const plan=planReactionGeneration(camera,desktop,{allowPartial:true,windowDurationSeconds:window,judgementOffsetSeconds:1});
    assert.equal(plan.selectedDurationSeconds,expected); assert.equal(plan.degraded,true);
    assert.ok(plan.selectedDurationSeconds<=Math.min(camera,desktop,window));
    assert.equal(plan.judgementIncluded,true);
  }
});
test('a judgement outside or exactly at the trimmed endpoint stays in waiting mode', () => {
  for(const offset of [2,3]) {
    const plan=planReactionGeneration(3,2,{allowPartial:true,windowDurationSeconds:4,judgementOffsetSeconds:offset});
    assert.equal(plan.judgementIncluded,false);assert.equal(plan.judgementPresentation,'OUTSIDE_TRIMMED_WINDOW_WAITING');
    assert.equal(plan.judgementOffsetSeconds,offset);
  }
});
test('COMPLETE retains synchronized-input and judgement-bound checks', () => {
  assert.throws(()=>planReactionGeneration(2,3,{judgementOffsetSeconds:1}),/INPUTS_NOT_SYNCHRONIZED/);
  assert.throws(()=>planReactionGeneration(2,2,{judgementOffsetSeconds:3}),/JUDGEMENT_OUTSIDE_VIDEO/);
  const plan=planReactionGeneration(2,2,{judgementOffsetSeconds:1});assert.equal(plan.degraded,false);assert.equal(plan.selectedDurationSeconds,2);
});
test('invalid, missing or sub-frame partial windows fail closed', () => {
  assert.throws(()=>planReactionGeneration(2,2,{allowPartial:true,judgementOffsetSeconds:1}),/TIMING_INVALID/);
  for(const duration of [NaN,Infinity,0,-1])assert.throws(()=>planReactionGeneration(duration,2,{allowPartial:true,windowDurationSeconds:2,judgementOffsetSeconds:1}),/TIMING_INVALID/);
  assert.throws(()=>planReactionGeneration(.02,2,{allowPartial:true,windowDurationSeconds:2,judgementOffsetSeconds:1}),/NO_COMMON_VIDEO/);
});
