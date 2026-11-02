import { prisma } from './db';
import type { Prisma } from '@prisma/client';
import { evidenceChannel, EVIDENCE_WINDOW_MS } from './evidence-window';

export async function recordingEventsForSession(sessionId: string) {
  const events = await prisma.alert.findMany({ where: { sessionId, evidenceDeletedAt: null, createdAt: { gte: new Date(Date.now() - 90_000) } },
    select: { id: true, type: true, message: true, createdAt: true }, orderBy: { createdAt: 'asc' } });
  return events.map(event => ({ id: event.id, occurredAt: event.createdAt.toISOString(), channel: evidenceChannel(event.type, event) }));
}

export async function isIncidentRecording(sessionId: string, channel: string, startedAt: Date, endedAt: Date, db: Pick<Prisma.TransactionClient, 'alert'> = prisma) {
  const events = await db.alert.findMany({ where: { sessionId, evidenceDeletedAt: null,
    createdAt: { gt: new Date(startedAt.getTime() - EVIDENCE_WINDOW_MS), lt: new Date(endedAt.getTime() + EVIDENCE_WINDOW_MS) }
  }, select: { id: true, type: true, message: true } });
  return events.some(event => evidenceChannel(event.type, event) === channel);
}
