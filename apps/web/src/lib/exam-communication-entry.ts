import { Prisma, type ExamFederation } from '@prisma/client';
import { digest } from './exam-federation-protocol';
import { CommunicationSnapshotSchema, type CommunicationSnapshot } from './exam-communication-protocol';
export function contentIdentity(examId: string, kind: string, entityId: string) { return { examId_kind_entityId: { examId, kind, entityId } }; }
export async function putCommunication(tx: Prisma.TransactionClient, config: ExamFederation, value: CommunicationSnapshot) {
  value = CommunicationSnapshotSchema.parse(value);
  const { contentSequence } = await tx.examFederation.update({ where: { examId: config.examId }, data: { contentSequence: { increment: 1 } }, select: { contentSequence: true } });
  const data = { originNodeId: value.originNodeId, writerNodeId: value.writerNodeId, revision: value.revision,
    sequence: contentSequence, payloadHash: digest(value), snapshot: value as Prisma.InputJsonValue };
  await tx.examFederationContent.upsert({ where: contentIdentity(config.examId, value.kind, value.id),
    create: { examId: config.examId, kind: value.kind, entityId: value.id, ...data }, update: data });
}
