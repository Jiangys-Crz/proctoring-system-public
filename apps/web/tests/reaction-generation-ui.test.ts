import assert from 'node:assert/strict';
import test from 'node:test';
import { canGenerateReaction, reactionExportBlockReason, reactionSubmissionLabel } from '../src/components/reaction-generation-ui';

const partial = Object.freeze({ status: 'PARTIAL', generationStatus: 'IDLE', cameraPath: 'camera.mp4', desktopPath: 'desktop.mp4' });

test('partial recordings with both sources are eligible without changing their status', () => {
  assert.equal(canGenerateReaction(partial), true);
  assert.equal(partial.status, 'PARTIAL');
  assert.equal([{ ...partial, status: 'MISSING' }, partial].some(canGenerateReaction), true);
});

test('desktop-only partial recordings can generate without becoming complete', () => {
  const desktopOnly = Object.freeze({ ...partial, cameraPath: null });
  assert.equal(canGenerateReaction(desktopOnly), true);
  assert.equal([desktopOnly].some(canGenerateReaction), true);
  assert.equal(desktopOnly.status, 'PARTIAL');
});

test('desktop is required for every recording and complete recordings still need camera', () => {
  for (const status of ['PARTIAL', 'COMPLETE', 'COMPLETED']) {
    assert.equal(canGenerateReaction({ ...partial, status, desktopPath: null }), false);
    assert.equal(canGenerateReaction({ ...partial, status, desktopPath: null, cameraPath: null }), false);
  }
  for (const status of ['COMPLETE', 'COMPLETED']) {
    assert.equal(canGenerateReaction({ ...partial, status, cameraPath: null }), false);
  }
});

test('complete recordings and failed generation attempts remain eligible', () => {
  for (const status of ['COMPLETE', 'COMPLETED', 'PARTIAL']) {
    assert.equal(canGenerateReaction({ ...partial, status, generationStatus: 'FAILED' }), true);
    assert.equal(canGenerateReaction({ ...partial, status, generationStatus: 'COMPLETE' }), true);
  }
});

test('queued or running jobs cannot be queued again through either action', () => {
  for (const generationStatus of ['QUEUED', 'RUNNING', 'GENERATING']) {
    const item = { ...partial, generationStatus };
    assert.equal(canGenerateReaction(item), false);
    assert.equal([item].some(canGenerateReaction), false);
  }
});

test('unfinished, deleted, and unavailable recordings cannot generate despite stale paths', () => {
  for (const status of ['PENDING', 'TAIL', 'CAPTURING', 'MISSING', 'FAILED', 'DELETED', 'CANCELLED', 'EXPIRED']) {
    assert.equal(canGenerateReaction({ ...partial, status }), false);
  }
});

test('submission display preserves the source UUID without replacing it with a numeric label', () => {
  const submissionId = 'a53bb0f8-20b3-4a28-8252-1251a4aeaa50';
  assert.equal(reactionSubmissionLabel({ submissionId }), submissionId);
  const other = '9e2c3e58-23d3-4744-a0c9-a2819944af5c';
  assert.equal(reactionSubmissionLabel({ submissionId: other }), other);
});

test('export rejects invalid submission UUIDs instead of requesting numeric label synchronization', () => {
  assert.match(reactionExportBlockReason({ generatedCount: 501, invalidSubmissionIds: 2 })!, /2.*Submission UUID 无效/);
  assert.equal(reactionExportBlockReason({ generatedCount: 501, invalidSubmissionIds: 0 }), null);
  assert.match(reactionExportBlockReason({ generatedCount: 0, invalidSubmissionIds: 0 })!, /暂无/);
  assert.notEqual(reactionExportBlockReason(), null);
});
