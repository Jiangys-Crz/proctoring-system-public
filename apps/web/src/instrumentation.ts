export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { prisma } = await import('./lib/db');
    const { ensureBootstrapAdministrator } = await import('./lib/bootstrap-admin');
    await ensureBootstrapAdministrator(prisma);
    const { ensurePublicTestExam, startPublicTestCleanup } = await import('./lib/public-test');
    await ensurePublicTestExam(prisma);
    startPublicTestCleanup();
    const { startMaterialCleanup } = await import('./lib/material-cleanup');
    startMaterialCleanup();
    const { startRateLimitCleanup } = await import('./lib/rate-limit-cleanup');
    startRateLimitCleanup();
    const { startPairingCleanup } = await import('./lib/pairing-cleanup');
    startPairingCleanup();
    const { startFileDeletionWorker } = await import('./lib/file-deletion');
    startFileDeletionWorker();
    const { startDeferredJudgeWorker } = await import('./lib/deferred-judge');
    const { startSessionHealthWorker } = await import('./lib/session-health');
    startDeferredJudgeWorker();
    startSessionHealthWorker();
    const { startExternalBoardWorker } = await import('./lib/external-board');
    startExternalBoardWorker();
    const { startVoiceCallCleanup } = await import('./lib/voice-call');
    startVoiceCallCleanup();
  }
}
