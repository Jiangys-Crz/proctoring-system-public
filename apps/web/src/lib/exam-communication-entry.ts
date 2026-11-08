import { Prisma, type ExamFederation } from '@prisma/client';
import { compareSnapshotVersion, digest, FederationError } from './exam-federation-protocol';
import { CommunicationSnapshotSchema, type CommunicationSnapshot } from './exam-communication-protocol';
export function contentIdentity(examId: string, kind: string, entityId: string) { return { examId_kind_entityId: { examId, kind, entityId } }; }
export async function putCommunication(tx: Prisma.TransactionClient, config: ExamFederation, value: CommunicationSnapshot) {
  value = CommunicationSnapshotSchema.parse(value);
  const hash = digest(value);
  const previous = await tx.examFederationContent.findUnique({ where: contentIdentity(config.examId, value.kind, value.id), select: { originNodeId: true, revision: true, writerNodeId: true, payloadHash: true } });
  if (previous) {
    if (previous.originNodeId !== value.originNodeId) throw new FederationError('答疑记录来源冲突');
    const version = compareSnapshotVersion(previous, value);
    if (version > 0) throw new FederationError('不能写回答疑旧版本');
    if (!version) {
      if (previous.payloadHash !== hash) throw new FederationError('同一答疑版本包含不同内容');
      return; // A replay must not create a fresh sequence and another round trip.
    }
    if (value.kind !== 'question') throw new FederationError('答疑消息、公告和图片不能改写');
  }
  const { contentSequence } = await tx.examFederation.update({ where: { examId: config.examId }, data: { contentSequence: { increment: 1 } }, select: { contentSequence: true } });
  const data = { originNodeId: value.originNodeId, writerNodeId: value.writerNodeId, revision: value.revision,
    sequence: contentSequence, payloadHash: hash, snapshot: value as Prisma.InputJsonValue };
  await tx.examFederationContent.upsert({ where: contentIdentity(config.examId, value.kind, value.id),
    create: { examId: config.examId, kind: value.kind, entityId: value.id, ...data }, update: data });
}
