import { z } from 'zod';
import { CursorSchema } from './exam-federation-protocol';

const identifier = z.string().min(1).max(191).regex(/^[A-Za-z0-9_-]+$/);
const date = z.string().datetime({ offset: true });
// Peer clocks are checked separately; a forged logical clock must not overflow
// BIGINT or permanently prevent this node from appending to a discussion.
const clock = CursorSchema.refine(value => BigInt(value) > 0n && BigInt(value) <= BigInt(Date.now() + 300_000), '答疑消息时钟超出允许范围');
const base = { id: identifier, originNodeId: z.string().uuid(), writerNodeId: z.string().uuid(), revision: z.number().int().min(1).max(2147483647) };
export const QuestionSnapshotSchema = z.object({ ...base, kind: z.literal('question'),
  initialMessageId: identifier, initialMessageCreatedAt: date, initialThreadOrder: clock, messageClock: clock, examNumber: z.string().min(1).max(191), problemPid: z.string().max(191).nullable(), problemIndex: z.string().max(20).nullable(),
  problemTitle: z.string().max(200).nullable(), content: z.string().max(20000), createdAt: date,
  isPublished: z.boolean(), publicationId: z.string().uuid().nullable(),
}).strict().refine(value => value.isPublished === Boolean(value.publicationId) && BigInt(value.messageClock) >= BigInt(value.initialThreadOrder), '公开提问版本或消息时钟无效');
const MessageSchema = z.object({ ...base, kind: z.literal('message'), question: QuestionSnapshotSchema,
  threadOrder: clock, sender: z.enum(['ADMIN', 'CANDIDATE']), content: z.string().min(1).max(20000), creatorLabel: z.string().max(200).nullable(), createdAt: date,
}).strict().refine(value => value.id !== value.question.initialMessageId || (value.sender === 'CANDIDATE' && value.originNodeId === value.question.originNodeId
    && value.content === value.question.content && value.createdAt === value.question.initialMessageCreatedAt && value.threadOrder === value.question.initialThreadOrder), '初始提问消息或顺序不一致');
const AnnouncementSchema = z.object({ ...base, kind: z.literal('announcement'), examNumber: z.string().min(1).max(191).nullable(),
  content: z.string().min(1).max(20000), creatorLabel: z.string().max(200).nullable(), createdAt: date,
  question: QuestionSnapshotSchema.nullable(), sourcePublicationId: z.string().uuid().nullable(),
}).strict().refine(value => Boolean(value.question) === Boolean(value.sourcePublicationId), '公开公告版本无效');
const AssetSchema = z.object({ ...base, kind: z.literal('asset'), id: z.string().uuid(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), accessKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  byteSize: z.number().int().positive().max(10 * 1024 * 1024), expiresAt: date,
}).strict();
export const CommunicationSnapshotSchema = z.union([QuestionSnapshotSchema, MessageSchema, AnnouncementSchema, AssetSchema]);
export type CommunicationSnapshot = z.infer<typeof CommunicationSnapshotSchema>;
export type QuestionSnapshot = z.infer<typeof QuestionSnapshotSchema>;
export type AssetSnapshot = z.infer<typeof AssetSchema>;
export const CommunicationWireSchema = z.object({ snapshot: CommunicationSnapshotSchema, data: z.string().max(14 * 1024 * 1024).optional() }).strict()
  .refine(value => (value.snapshot.kind === 'asset') === (value.data !== undefined), '同步附件数据无效');
export type CommunicationWire = z.infer<typeof CommunicationWireSchema>;
export const CommunicationExchangeSchema = z.object({ action: z.literal('communications'), version: z.literal(1),
  nodeId: z.string().uuid(), hubId: z.string().uuid(), contractHash: z.string().regex(/^[a-f0-9]{64}$/),
  after: CursorSchema, entries: z.array(CommunicationWireSchema).max(8),
}).strict();
export const CommunicationReplySchema = z.object({ nodeId: z.string().uuid(), now: date, after: CursorSchema, entries: z.array(CommunicationWireSchema).max(8) });
