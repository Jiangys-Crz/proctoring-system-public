function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Only capture provenance can identify an old all-black filler. A dark but
 * genuine camera recording must never be mistaken for an absent camera. */
export function cameraPlaceholderReason(cameraPath: string | null, metadata: unknown): 'MISSING_CAMERA_RECORDING' | 'NO_CAPTURED_CAMERA_FRAMES' | null {
  if (!cameraPath) return 'MISSING_CAMERA_RECORDING';
  const camera = object(object(object(metadata)?.channels)?.DESKTOP_CAMERA);
  if (!camera || camera.complete !== false || !Array.isArray(camera.slices)) return null;
  if (!camera.slices.length) return 'NO_CAPTURED_CAMERA_FRAMES';
  const timings = object(camera.frameTiming);
  if (!timings) return null;
  const noRetainedFrames = camera.slices.every(slice => {
    const id = object(slice)?.id;
    const timing = typeof id === 'string' ? object(timings[id]) : null;
    if (!timing) return false;
    if (timing.timestampsVerified === true && timing.selectedFrames === 0) return true;
    // selectedFrames is also zero for invalid timestamps, which is not proof
    // that the file contains no camera image. Keep such footage and diagnostics.
    if (timing.timestampsVerified === false) return false;
    // Legacy audits computed cadence only after verifying all timestamps.
    // A positive interval plus an after-last-frame slice proves an empty
    // selection; first/last alone cannot exclude an invalid timestamp order.
    const first = timing.firstPtsSeconds, last = timing.lastPtsSeconds, from = timing.requestedFromSeconds;
    return typeof first === 'number' && typeof last === 'number' && typeof from === 'number'
      && typeof timing.maxFrameIntervalSeconds === 'number' && timing.maxFrameIntervalSeconds > 0
      && typeof timing.decodedFrames === 'number' && timing.decodedFrames >= 2
      && [first, last, from, timing.maxFrameIntervalSeconds].every(Number.isFinite)
      && last > first && from >= 0 && last - first < from - 1e-6;
  });
  return noRetainedFrames ? 'NO_CAPTURED_CAMERA_FRAMES' : null;
}
