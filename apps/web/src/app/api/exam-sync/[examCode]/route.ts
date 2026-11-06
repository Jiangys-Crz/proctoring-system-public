import { z } from 'zod';
import { prisma } from '@/lib/db';
import { syncManifest } from '@/lib/exam-federation-contract';
import { equalHash, ExchangeSchema, FederationError, keyHash, openKey, SYNC_BYTES } from '@/lib/exam-federation-protocol';
import { federationTransaction, mergeSnapshots, readSyncPage } from '@/lib/exam-federation-store';
import { CommunicationExchangeSchema } from '@/lib/exam-communication-protocol';
import { decodeCommunicationAssets, installPreparedAssets } from '@/lib/exam-communication-assets';
import { prepareIncomingCommunications } from '@/lib/exam-communication-incoming';
import { buildCommunicationPage, communicationPage, mergeCommunications } from '@/lib/exam-communications';
import { parseBody, RequestParseError } from '@/lib/http';
import { createRequestAdmission, isRequestAdmissionError } from '@/lib/request-admission';

export const runtime = 'nodejs';
const shared = globalThis as typeof globalThis & { federationAdmission?: ReturnType<typeof createRequestAdmission>; communicationAdmission?: ReturnType<typeof createRequestAdmission> };
const acquire = shared.federationAdmission ??= createRequestAdmission(2, 16, 5000);
// Do not hold the second exchange slot while waiting for the content slot.
// The sender retains its durable cursor and retries a busy response; keeping
// this queue empty leaves capacity for submission/result exchanges.
const acquireCommunication = shared.communicationAdmission ??= createRequestAdmission(1, 0, 5000);
const schema = z.union([ExchangeSchema, CommunicationExchangeSchema]);
function reply(data: unknown, status = 200) { return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } }); }
export async function POST(request: Request, context: { params: Promise<{ examCode: string }> }) {
  let release: (() => void) | undefined, releaseCommunication: (() => void) | undefined;
  try {
    release = await acquire(request.signal);
    const { examCode } = await context.params;
    const key = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get('authorization') || '')?.[1];
    if (!key || !/^\d{10}$/.test(examCode)) throw new FederationError('同步认证失败', 401);
    const exam = await prisma.exam.findUnique({ where: { examCode }, select: { id: true, federation: true } });
    const config = exam?.federation;
    if (!exam || !config?.enabled || config.role !== 'HUB' || !equalHash(config.apiKeyHash || '', keyHash(key))) throw new FederationError('同步认证失败或公网接收已暂停', 401);
    const input = await parseBody(request, schema, SYNC_BYTES);
    if (input.action === 'communications') releaseCommunication = await acquireCommunication(request.signal);
    const incoming = input.action === 'communications' ? await prepareIncomingCommunications(config, input.entries) : null;
    const buffers = input.action === 'communications' ? await decodeCommunicationAssets(input.entries, exam.id) : null;
    const result = await federationTransaction(exam.id, async tx => {
      const fresh = await tx.examFederation.findUniqueOrThrow({ where: { examId: exam.id } });
      if (!fresh.enabled || fresh.role !== 'HUB' || !equalHash(fresh.apiKeyHash || '', keyHash(key))) throw new FederationError('同步设置已改变，请重新连接', 401);
      if (input.action === 'manifest') return { type: 'data' as const, data: await syncManifest(exam.id, fresh.nodeId, openKey(fresh.apiKeyCiphertext), tx) };
      if (input.hubId !== fresh.nodeId || input.nodeId === fresh.nodeId || input.contractHash !== fresh.contractHash) throw new FederationError('两端考试定义或节点不一致，请重新检查同步设置');
      if (input.action === 'communications') {
        await installPreparedAssets(tx, fresh, incoming!);
        await mergeCommunications(tx, fresh, input.entries, buffers!, incoming!, input.nodeId);
        const updated = await tx.examFederation.update({ where: { examId: exam.id }, data: { communicationSuccessAt: new Date() } });
        return { type: 'communications' as const, nodeId: fresh.nodeId, page: await communicationPage(tx, updated, BigInt(input.after), false, input.nodeId) };
      }
      await mergeSnapshots(tx, fresh, input.entries, input.nodeId);
      const updated = await tx.examFederation.update({ where: { examId: exam.id }, data: { lastSuccessAt: new Date() } });
      return { type: 'data' as const, data: { nodeId: fresh.nodeId, now: new Date().toISOString(), ...await readSyncPage(tx, updated, BigInt(input.after), 'pull', input.nodeId) } };
    });
    const data = result.type === 'communications' ? { nodeId: result.nodeId, now: new Date().toISOString(), ...await buildCommunicationPage(result.page) } : result.data;
    if (Buffer.byteLength(JSON.stringify(data)) > SYNC_BYTES - 1024) throw new FederationError('同步配置或提交响应过大', 413);
    return reply({ ok: true, data });
  } catch (error) {
    if (error instanceof FederationError) return reply({ ok: false, message: error.message }, error.status);
    if (error instanceof RequestParseError) return reply({ ok: false, message: error.message }, 400);
    if (isRequestAdmissionError(error)) return reply({ ok: false, message: '同步服务繁忙，请稍后重试' }, 503);
    console.error('Exam federation exchange failed');
    return reply({ ok: false, message: '同步服务暂不可用，请稍后重试' }, 503);
  } finally { releaseCommunication?.(); release?.(); }
}
