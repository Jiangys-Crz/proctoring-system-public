import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { auditReactionFrameTiming, reactionIncompleteReason } from '../src/lib/reaction-frame-timing';
const frames = (values: number[]) => values.map(value => ({ best_effort_timestamp_time: value.toFixed(3) }));
test('continuous 20 fps capture is complete on the requested interval', () => {
  const audit = auditReactionFrameTiming(frames(Array.from({length:201},(_,i)=>i/20)), 3, 5);
  assert.equal(audit.complete, true); assert.equal(audit.decodedFrames, 201);
});
test('a decodable 10 second clip throttled to 1 fps is incomplete inside the requested tail', () => {
  const audit = auditReactionFrameTiming(frames([0,.05,.1,.15,.2,.25,.3,.35,.4,.927,1.936,2.927,3.935,4.927,5.932,6.942,7.928,8.938,9.932]), 0, 5.026);
  assert.equal(audit.complete, false); assert.equal(audit.issue, 'FRAME_CADENCE_INCOMPLETE');
  assert.equal(audit.gaps.length, 5); assert.ok(audit.gaps.every(gap=>gap.to<=5.026));
});
test('slow sampling outside the selected interval does not condemn valid selected footage', () => {
  const pts = [0,1,2,3,...Array.from({length:141},(_,i)=>3.5+i/20)];
  assert.equal(auditReactionFrameTiming(frames(pts), 8.607, 1.338).complete, true);
  assert.equal(auditReactionFrameTiming(frames([0,.05,.1,.15,.2,1.2]), 0, .2).complete, true);
  assert.equal(auditReactionFrameTiming(frames([0,.05,.1,.15,.2,1.2]), .5, .5).complete, false);
});
test('nonzero PTS is normalized; duplicate, missing, decreasing and nonfinite PTS fail closed', () => {
  assert.equal(auditReactionFrameTiming(frames([4,4.05,4.1,4.15]), 0, .1).complete, true);
  for (const input of [[],frames([0]),frames([0,0]),frames([.1,0]),frames([0,NaN]),[{},{}]]) assert.equal(auditReactionFrameTiming(input, 0, 1).complete, false);
});
test('specific incomplete causes retain clock/gap/duration checks and distinguish undersampling', () => {
  const report = (issues: string[], gaps: unknown[] = []) => [{complete:false,issues,gaps}];
  assert.equal(reactionIncompleteReason(report(['DURATION_MISMATCH:s','FRAME_CADENCE_INCOMPLETE:s'])), 'VIDEO_FRAME_CADENCE_INCOMPLETE');
  assert.equal(reactionIncompleteReason(report(['CLOCK_UNCERTAIN:s'])), 'VIDEO_CLOCK_UNCERTAIN');
  assert.equal(reactionIncompleteReason(report([], [{}])), 'VIDEO_INTERVAL_MISSING');
  assert.equal(reactionIncompleteReason(report(['DURATION_MISMATCH:s'])), 'VIDEO_DURATION_MISMATCH');
  assert.equal(reactionIncompleteReason([{complete:true,issues:[],gaps:[]}] ), null);
});
test('a long final packet hold cannot masquerade as further captured samples', () => {
  const source = [{best_effort_timestamp_time:'0',pkt_duration_time:'.05'}, {best_effort_timestamp_time:'.05',pkt_duration_time:'9.95'}];
  const audit = auditReactionFrameTiming(source, 0, 10);
  assert.equal(audit.complete, false); assert.equal(audit.issue, 'FRAME_CADENCE_INCOMPLETE');
  assert.deepEqual(audit.gaps, [{from:.05,to:10,sourceIntervalSeconds:9.95}]);
  assert.equal(auditReactionFrameTiming(source, 0, .1).complete, true);
});
test('a sub-tolerance interval with no retained frame is not complete black footage', () => {
  const audit = auditReactionFrameTiming(frames([0,1,2]), .4, .2);
  assert.equal(audit.complete, false); assert.equal(audit.selectedFrames, 0);
  assert.equal(audit.issue, 'FRAME_TIMING_UNVERIFIED');
});
test('legitimate irregular VFR sampling and a normal final-frame tail remain valid', () => {
  const source = frames([7,7.04,7.16,7.21,7.4,7.59,7.71,7.89]);
  assert.equal(auditReactionFrameTiming(source, .16, .7).complete, true);
  assert.equal(auditReactionFrameTiming(source, .71, .25).complete, true);
  assert.equal(auditReactionFrameTiming(frames([0,.24,.48,.72,.96]), .25, .5).complete, true);
  assert.equal(auditReactionFrameTiming(frames([4,4.05,4.1]), .05, .01).complete, true, 'Decimal nonzero PTS normalization does not lose an exact starting frame');
});
test('actual FFmpeg VFR trim keeps its leading black interval on the shared timeline', async t => {
  const { probeReactionFrameTiming, renderReactionTimeline } = await import('../src/lib/reaction-media');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'reaction-vfr-test-'));
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
  const invoke = (args: string[]) => {
    const result = spawnSync(ffmpeg, ['-nostdin','-hide_banner','-v','error',...args], {windowsHide:true, maxBuffer:1024*1024});
    assert.equal(result.status, 0, 'Controlled FFmpeg invocation must succeed');
    return result.stdout;
  };
  try {
    const source = path.join(directory, 'vfr.mkv');
    // Real retained PTS: 0,.24,.48,.72,.96. Selecting [.25,.75) must
    // preserve .23 seconds before the first retained frame, not pull it to 0.
    invoke(['-f','lavfi','-i','color=c=red:s=32x32:r=25:d=1','-vf',"select='not(mod(n,6))'",'-fps_mode','vfr','-c:v','ffv1',source]);
    const timing = await probeReactionFrameTiming(source, .25, .5);
    assert.equal(timing.complete, true);
    const report = {complete:true,issues:[] as string[],gaps:[],slices:[{id:'vfr',from:.25,duration:.5,timelineStart:0}]};
    const rendered = await renderReactionTimeline(report, .5, async()=>source, directory, 'render');
    assert.ok(rendered); assert.equal(report.complete, true);
    const pixels = invoke(['-i',rendered.output,'-vf','scale=1:1:flags=area,format=rgb24','-f','rawvideo','-']);
    const colours = Array.from({length:pixels.length/3},(_,i)=>[pixels[i*3],pixels[i*3+1],pixels[i*3+2]]);
    const firstPicture = colours.findIndex(([red,green,blue]) => red>50 && red>green*2 && red>blue*2);
    assert.ok(firstPicture >= 5 && firstPicture <= 7, `First source frame must remain at 0.23s +/- one 25fps frame; got frame ${firstPicture}`);
    assert.ok(colours.slice(0,firstPicture).every(rgb=>rgb.every(value=>value<8)), 'Leading interval must actually decode black');
    assert.equal(colours.length, 13, 'Quantized common timeline remains 13 frames / 0.52s');
    assert.ok(Math.abs(rendered.probe.duration-.52)<.001);
    t.diagnostic(`Actual decoded leading black: ${firstPicture} frames / ${(firstPicture/25).toFixed(3)}s; first nonblack frame index=${firstPicture}; total=${colours.length} frames / ${rendered.probe.duration}s`);
  } finally {
    const actual = await realpath(directory), parent = await realpath(os.tmpdir());
    assert.equal(path.dirname(actual), parent); assert.ok(path.basename(actual).startsWith('reaction-vfr-test-'));
    await rm(actual,{recursive:true,force:true});
  }
});
