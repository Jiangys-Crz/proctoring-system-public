import '@cwnupaa/proctor-shared/recording-buffer';

export const EVIDENCE_WINDOW_MS = 20_000;
export const LEGACY_SEGMENT_MS = 10_000;

export type EvidenceAlert = { id: string; sessionId: string | null; type: string; message?: string; createdAt: Date };
export type EvidenceSegment = { id: string; sessionId: string | null; channel: string; objectPath: string; startedAt: Date; endedAt: Date | null };

export function evidenceChannel(type: string, alert?: { id?: string; message?: string }) {
  return globalThis.proctorEvidenceChannel(type, alert) as 'MOBILE_CAMERA' | 'DESKTOP_CAMERA' | 'DESKTOP_SCREEN';
}

/** Build once per response, so every alert only examines its own time window.
 * Prefix maxima also retain long or overlapping clips that start before it.
 */
export function createEvidenceLookup(records: EvidenceSegment[]) {
  const sessions = new Map<string, Map<string, { records: EvidenceSegment[]; maxEnds: number[] }>>();
  for (const record of records) {
    if (!record.sessionId) continue;
    let channels = sessions.get(record.sessionId);
    if (!channels) sessions.set(record.sessionId, channels = new Map());
    let bucket = channels.get(record.channel);
    if (!bucket) channels.set(record.channel, bucket = { records: [], maxEnds: [] });
    bucket.records.push(record);
  }
  for (const channels of sessions.values()) for (const bucket of channels.values()) {
    bucket.records.sort((left, right) => left.startedAt.getTime() - right.startedAt.getTime() || left.id.localeCompare(right.id));
    let maxEnd = -Infinity;
    for (const record of bucket.records) {
      maxEnd = Math.max(maxEnd, record.endedAt?.getTime() ?? record.startedAt.getTime() + LEGACY_SEGMENT_MS);
      bucket.maxEnds.push(maxEnd);
    }
  }
  return (alert: EvidenceAlert): EvidenceSegment[] => {
    if (!alert.sessionId) return [];
    const bucket = sessions.get(alert.sessionId)?.get(evidenceChannel(alert.type, alert));
    if (!bucket) return [];
    const start = alert.createdAt.getTime() - EVIDENCE_WINDOW_MS;
    const end = alert.createdAt.getTime() + EVIDENCE_WINDOW_MS;
    let left = 0, right = bucket.records.length;
    // The first prefix that can contain an interval ending after the window start.
    while (left < right) {
      const middle = (left + right) >>> 1;
      if (bucket.maxEnds[middle] <= start) left = middle + 1;
      else right = middle;
    }
    const matches: EvidenceSegment[] = [];
    for (let index = left; index < bucket.records.length; index++) {
      const record = bucket.records[index];
      if (record.startedAt.getTime() >= end) break;
      if ((record.endedAt?.getTime() ?? record.startedAt.getTime() + LEGACY_SEGMENT_MS) > start) matches.push(record);
    }
    return matches;
  };
}

export function evidenceWindow(alert: EvidenceAlert, records: EvidenceSegment[], now = new Date()) {
  const start = alert.createdAt.getTime() - EVIDENCE_WINDOW_MS;
  const end = alert.createdAt.getTime() + EVIDENCE_WINDOW_MS;
  const channel = evidenceChannel(alert.type, alert);
  const paths = new Set<string>();
  const segments = records
    .filter((item) => Boolean(alert.sessionId) && item.sessionId === alert.sessionId && item.channel === channel)
    .map((item) => ({ ...item, endedAt: item.endedAt || new Date(item.startedAt.getTime() + LEGACY_SEGMENT_MS), estimated: !item.endedAt }))
    .filter((item) => item.startedAt.getTime() < end && item.endedAt.getTime() > start)
    .sort((left, right) => left.startedAt.getTime() - right.startedAt.getTime() || left.id.localeCompare(right.id))
    .filter((item) => { if (paths.has(item.objectPath)) return false; paths.add(item.objectPath); return true; });
  let coveredUntil = start;
  let availableMs = 0;
  let complete = segments.length > 0;
  for (const segment of segments) {
    const segmentStart = Math.max(start, segment.startedAt.getTime());
    const segmentEnd = Math.min(end, segment.endedAt.getTime());
    if (segment.estimated || segmentStart - coveredUntil > 250) complete = false;
    availableMs += Math.max(0, segmentEnd - Math.max(coveredUntil, segmentStart));
    coveredUntil = Math.max(coveredUntil, segmentEnd);
  }
  complete = complete && coveredUntil >= end - 250;
  return {
    windowStart: new Date(start), windowEnd: new Date(end),
    complete, pending: !complete && now.getTime() < end + 30 * 60_000,
    availableSeconds: Math.round(availableMs / 100) / 10,
    segments: segments.map(({ sessionId: _sessionId, ...segment }) => segment)
  };
}
