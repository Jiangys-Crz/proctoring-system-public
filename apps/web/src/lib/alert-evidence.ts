import { prisma } from './db';
import { publicObjectUrl } from './storage';
import { createEvidenceLookup, evidenceChannel, evidenceWindow, EVIDENCE_WINDOW_MS, LEGACY_SEGMENT_MS, type EvidenceAlert, type EvidenceSegment } from './evidence-window';

export async function evidenceForAlerts(alerts: (EvidenceAlert & { evidenceDeletedAt?: Date | null })[]) {
  const records = new Map<string, EvidenceSegment>();
  const bound = alerts.filter((alert) => alert.sessionId && !alert.evidenceDeletedAt);
  // Query each event's time range; a global "latest N" limit can silently omit
  // old incidents in busy exams and associate evidence from a different login.
  for (let offset = 0; offset < bound.length; offset += 100) {
    const segments = await prisma.mediaSegment.findMany({
      where: { deletedAt: null, OR: bound.slice(offset, offset + 100).map((alert) => ({
        sessionId: alert.sessionId!, channel: evidenceChannel(alert.type, alert),
        startedAt: { lt: new Date(alert.createdAt.getTime() + EVIDENCE_WINDOW_MS) },
        OR: [
          { endedAt: { gt: new Date(alert.createdAt.getTime() - EVIDENCE_WINDOW_MS) } },
          { endedAt: null, startedAt: { gt: new Date(alert.createdAt.getTime() - EVIDENCE_WINDOW_MS - LEGACY_SEGMENT_MS) } }
        ]
      })) },
      select: { id: true, sessionId: true, channel: true, objectPath: true, startedAt: true, endedAt: true }
    });
    for (const segment of segments) records.set(segment.id, segment);
  }
  const urls = new Map<string, Promise<string | null | undefined>>();
  const signed = (path: string) => {
    if (!urls.has(path)) urls.set(path, publicObjectUrl(path));
    return urls.get(path)!;
  };
  const findSegments = createEvidenceLookup([...records.values()]);
  return new Map(await Promise.all(alerts.map(async (alert) => {
    const evidence = evidenceWindow(alert, alert.evidenceDeletedAt ? [] : findSegments(alert));
    if (alert.evidenceDeletedAt) evidence.pending = false;
    return [alert.id, { ...evidence, segments: await Promise.all(evidence.segments.map(async (segment) => ({ ...segment, objectPath: await signed(segment.objectPath) || segment.objectPath }))) }] as const;
  })));
}
