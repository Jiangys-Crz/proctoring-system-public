import { createHash } from 'node:crypto';

export const reactionChannels = ['DESKTOP_CAMERA', 'DESKTOP_SCREEN'] as const;
export const activeReactionStates = ['PENDING', 'TAIL', 'CAPTURING'];
export type CcsEvent = { id?: string; type: string; op?: string; data?: Record<string, unknown> | null };
export const eventHash = (data: unknown) => createHash('sha256').update(JSON.stringify(data)).digest('hex');

/** A streaming decoder must retain both split UTF-8 characters and partial lines. */
export async function* readNdjson(body: ReadableStream<Uint8Array>): AsyncGenerator<CcsEvent> {
  const reader = body.getReader(); const decoder = new TextDecoder(); let pending = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      if (pending.length > 8 * 1024 * 1024) throw new Error('CCS line exceeds limit');
      let end;
      while ((end = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, end).trim(); pending = pending.slice(end + 1);
        if (line) yield JSON.parse(line) as CcsEvent;
      }
      if (done) break;
    }
    if (pending.trim()) yield JSON.parse(pending) as CcsEvent;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function finalVerdict(data: Record<string, unknown>) {
  const value = typeof data.judgement_type_id === 'string' ? data.judgement_type_id : '';
  return ['AC', 'WA', 'TLE', 'RTE', 'RE', 'CE', 'MLE', 'OLE', 'PE', 'SE', 'JE', 'NO', 'FAILED'].includes(value) ? value : null;
}

/** CCS contest_time is a duration, independent of the proctoring exam schedule. */
export function ccsContestTimeMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d+):([0-5]\d):([0-5]\d)(?:\.(\d{1,9}))?$/.exec(value);
  if (!match) return null;
  const milliseconds = Number(match[1]) * 3_600_000 + Number(match[2]) * 60_000 + Number(match[3]) * 1000 + Number((match[4] || '').padEnd(3, '0').slice(0, 3));
  return Number.isSafeInteger(milliseconds) ? milliseconds : null;
}

export type TimedSegment = { id: string; startedAt: Date; endedAt: Date | null; durationSeconds: number | null; clockOffsetMs: number | null; clockUncertaintyMs: number | null };
export function coverage(segments: TimedSegment[], start: Date, end: Date, toleranceMs = 250) {
  if (!Number.isFinite(+start) || !Number.isFinite(+end) || +end <= +start || !Number.isFinite(toleranceMs) || toleranceMs < 0) throw new Error('REACTION_WINDOW_INVALID');
  let cursor = +start; const gaps: { start: string; end: string }[] = []; const issues: string[] = [];
  const slices: { id: string; from: number; duration: number; timelineStart: number }[] = [];
  for (const s of [...segments].sort((a,b) => +a.startedAt - +b.startedAt || a.id.localeCompare(b.id))) {
    if (!s.endedAt || !Number.isFinite(+s.startedAt) || !Number.isFinite(+s.endedAt) || +s.endedAt <= +s.startedAt || s.durationSeconds == null || !Number.isFinite(s.durationSeconds) || s.durationSeconds <= 0) { issues.push(`UNVERIFIED_TIMING:${s.id}`); continue; }
    // The actual independent file duration bounds usable evidence. A declared
    // interval that extends beyond EOF must leave a visible gap, never freeze
    // or stretch its final frame to manufacture the missing evidence.
    const begin = Math.max(+start, +s.startedAt, cursor), finish = Math.min(+end, +s.endedAt, +s.startedAt + s.durationSeconds * 1000);
    if (finish <= begin) continue;
    if (begin - cursor > toleranceMs) gaps.push({ start: new Date(cursor).toISOString(), end: new Date(begin).toISOString() });
    if (s.clockOffsetMs == null || !Number.isFinite(s.clockOffsetMs) || s.clockUncertaintyMs == null || !Number.isFinite(s.clockUncertaintyMs) || s.clockUncertaintyMs < 0 || s.clockUncertaintyMs > 250) issues.push(`CLOCK_UNCERTAIN:${s.id}`);
    // Never stretch a corrupt/short file to make its declared capture interval fit.
    if (Math.abs(s.durationSeconds * 1000 - (+s.endedAt - +s.startedAt)) > 750) issues.push(`DURATION_MISMATCH:${s.id}`);
    slices.push({ id: s.id, from: (begin - +s.startedAt) / 1000, duration: (finish - begin) / 1000, timelineStart: (begin - +start) / 1000 });
    cursor = Math.max(cursor, finish);
  }
  if (+end - cursor > toleranceMs) gaps.push({ start: new Date(cursor).toISOString(), end: end.toISOString() });
  return { complete: slices.length > 0 && !gaps.length && !issues.length, gaps, issues, slices };
}

/** Quantize the shared wall-clock timeline once, so gaps do not shorten either channel. */
export function reactionTimelineFrames(slices: ReturnType<typeof coverage>['slices'], durationSeconds: number, fps = 25) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || !Number.isSafeInteger(fps) || fps <= 0) throw new Error('REACTION_TIMELINE_INVALID');
  const total = Math.max(1, Math.round(durationSeconds * fps));
  const pieces: { id: string | null; from: number; startFrame: number; frames: number }[] = [];
  let cursor = 0;
  for (const slice of slices) {
    const begin = Math.max(cursor, Math.min(total, Math.round(slice.timelineStart * fps)));
    const finish = Math.max(begin, Math.min(total, Math.round((slice.timelineStart + slice.duration) * fps)));
    if (begin > cursor) pieces.push({ id: null, from: 0, startFrame: cursor, frames: begin - cursor });
    if (finish > begin) pieces.push({ id: slice.id, from: Math.max(0, slice.from + begin / fps - slice.timelineStart), startFrame: begin, frames: finish - begin });
    cursor = finish;
  }
  if (cursor < total) pieces.push({ id: null, from: 0, startFrame: cursor, frames: total - cursor });
  return pieces;
}

export function ccsCredential(exam: { id: string; platformBaseUrl: string }) {
  let configured: Record<string, { origin: string; username: string; password: string }> = {};
  try { configured = JSON.parse(process.env.REACTION_CCS_CREDENTIALS || '{}'); } catch { throw new Error('CCS credential configuration is invalid'); }
  const entry = configured[exam.id] || { origin: process.env.REACTION_CCS_ORIGIN || '', username: process.env.REACTION_CCS_USERNAME || '', password: process.env.REACTION_CCS_PASSWORD || '' };
  const origin = new URL(exam.platformBaseUrl).origin;
  if (entry.origin !== origin || !entry.username || !entry.password) throw new Error('CCS credentials are missing for this exact origin');
  const url = new URL(origin);
  if (url.protocol !== 'https:' && !['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw new Error('CCS requires HTTPS outside loopback');
  return { origin, authorization: `Basic ${Buffer.from(`${entry.username}:${entry.password}`).toString('base64')}` };
}
