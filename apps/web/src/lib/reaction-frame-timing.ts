/** MediaRecorder files can decode successfully while background throttling has
 * reduced a 20 fps capture to one frame per second. Duration alone cannot
 * certify that the requested reaction interval was continuously sampled. */
export type DecodedFrameTime = { best_effort_timestamp_time?: string; pkt_duration_time?: string };

export function auditReactionFrameTiming(frames: DecodedFrameTime[], from: number, duration: number, toleranceSeconds = 0.25) {
  if (!Number.isFinite(from) || from < 0 || !Number.isFinite(duration) || duration <= 0 || !Number.isFinite(toleranceSeconds) || toleranceSeconds < 0) throw new Error('REACTION_FRAME_WINDOW_INVALID');
  const timestamps = frames.map(frame => frame.best_effort_timestamp_time == null ? NaN : Number(frame.best_effort_timestamp_time));
  const valid = timestamps.length >= 2 && timestamps.every((value, i) => Number.isFinite(value) && (i === 0 || value > timestamps[i - 1]));
  const end = from + duration;
  const selectedFrames = valid ? timestamps.filter(value => value - timestamps[0] + 1e-6 >= from && value - timestamps[0] < end - 1e-6).length : 0;
  const gaps: { from: number; to: number; sourceIntervalSeconds: number }[] = [];
  let maxFrameIntervalSeconds = 0;
  if (valid) for (let i = 1; i < timestamps.length; i++) {
    const previous = timestamps[i - 1] - timestamps[0], current = timestamps[i] - timestamps[0];
    const begin = Math.max(from, previous), finish = Math.min(end, current);
    if (finish <= begin) continue;
    maxFrameIntervalSeconds = Math.max(maxFrameIntervalSeconds, current - previous);
    if (finish - begin > toleranceSeconds + 1e-6) gaps.push({ from: begin, to: finish, sourceIntervalSeconds: current - previous });
  }
  if (valid) {
    // A long final packet duration holds the same picture; it is not proof of
    // further samples. Apply the same cadence tolerance after the last PTS.
    const lastSample = timestamps.at(-1)! - timestamps[0];
    const tailBegin = Math.max(from, lastSample);
    if (end - tailBegin > toleranceSeconds + 1e-6) gaps.push({ from: tailBegin, to: end, sourceIntervalSeconds: end - lastSample });
    if (end > tailBegin) maxFrameIntervalSeconds = Math.max(maxFrameIntervalSeconds, end - lastSample);
  }
  return {
    complete: valid && selectedFrames > 0 && gaps.length === 0,
    issue: !valid || selectedFrames === 0 ? 'FRAME_TIMING_UNVERIFIED' : gaps.length ? 'FRAME_CADENCE_INCOMPLETE' : null,
    decodedFrames: frames.length, selectedFrames, timestampsVerified: valid,
    firstPtsSeconds: Number.isFinite(timestamps[0]) ? timestamps[0] : null,
    lastPtsSeconds: Number.isFinite(timestamps.at(-1)) ? timestamps.at(-1)! : null,
    requestedFromSeconds: from, requestedDurationSeconds: duration,
    toleranceSeconds, maxFrameIntervalSeconds, gaps,
  };
}

export function reactionIncompleteReason(reports: { complete: boolean; issues: string[]; gaps: unknown[] }[]) {
  if (reports.length > 0 && reports.every(report => report.complete)) return null;
  const issues = reports.flatMap(report => report.issues);
  const has = (prefix: string) => issues.some(issue => issue.startsWith(prefix));
  if (has('CLOCK_UNCERTAIN:')) return 'VIDEO_CLOCK_UNCERTAIN';
  if (has('SOURCE_UNAVAILABLE_OR_UNDECODABLE:')) return 'VIDEO_SOURCE_UNAVAILABLE';
  if (has('FRAME_CADENCE_INCOMPLETE:')) return 'VIDEO_FRAME_CADENCE_INCOMPLETE';
  if (has('FRAME_TIMING_UNVERIFIED:')) return 'VIDEO_FRAME_TIMING_UNVERIFIED';
  if (reports.some(report => report.gaps.length > 0)) return 'VIDEO_INTERVAL_MISSING';
  if (has('DURATION_MISMATCH:')) return 'VIDEO_DURATION_MISMATCH';
  return 'VIDEO_COVERAGE_OR_CLOCK_INCOMPLETE';
}
