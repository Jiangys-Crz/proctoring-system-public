import type { ExamFederation } from '@prisma/client';
import { prisma } from './db';
import type { CommunicationWire } from './exam-communication-protocol';
import { prepareCommunicationAssets } from './exam-communication-assets';
import { settleReads } from './request-admission';
export async function prepareIncomingCommunications(config: ExamFederation, entries: CommunicationWire[]) {
  const ids = [...new Set(entries.flatMap(({ snapshot }) => snapshot.kind === 'question' ? [snapshot.id]
    : (snapshot.kind === 'message' || snapshot.kind === 'announcement') && snapshot.question ? [snapshot.question.id] : []))];
  const [rows, stored] = await settleReads([
    ids.length ? prisma.examQuestion.findMany({ where: { id: { in: ids }, examId: config.examId, federationDirty: true }, select: { id: true, content: true } }) : [],
    ids.length ? prisma.examFederationContent.findMany({ where: { examId: config.examId, kind: 'question', entityId: { in: ids } }, select: { entityId: true } }) : [],
  ]);
  const known = new Set(stored.map(row => row.entityId));
  return prepareCommunicationAssets(config, rows.filter(row => !known.has(row.id)).map(row => row.content));
}
