import { createHash } from 'node:crypto';
import { z } from 'zod';
import { requireSuperAdmin, AuthError } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { digest } from '@/lib/exam-federation-protocol';
import { requestHydroBridge } from '@/lib/hydro-contest';
import { getHydroSettings } from '@/lib/settings';
import { validateProblemDraft } from '@/lib/problem-authoring';
import { createRequestAdmission, isRequestAdmissionError } from '@/lib/request-admission';
import { fail, ok, options, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';

const Schema = z.object({ requestId: z.string().uuid(), draft: z.unknown().optional() });
const shared = globalThis as typeof globalThis & { problemCreateAdmission?: ReturnType<typeof createRequestAdmission> };
const acquire = shared.problemCreateAdmission ??= createRequestAdmission(2, 4, 3000);
type CreationResult = { complete: boolean; id: string; sourceId: string; domain?: string; ready?: number; files?: number; total?: number };

export async function GET() {
  try {
    await requireSuperAdmin();
    const hydro = await getHydroSettings();
    return ok({ domain: hydro.problemDomainId }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { if (error instanceof AuthError) return fail(error.message, error.status); return fail(toErrorMessage(error), 502); }
}

export async function POST(request: Request) {
  let release: (() => void) | undefined;
  try {
    const user = await requireSuperAdmin(request);
    release = await acquire(request.signal);
    const input = await parseBody(request, Schema, 8 * 1024 * 1024);
    if (input.draft !== undefined) {
      const issues = validateProblemDraft(input.draft);
      if (issues.length) return fail(issues[0].message, 400, { issues });
      if (Buffer.byteLength(JSON.stringify(input.draft)) > 6 * 1024 * 1024) return fail('题目及测试数据总量不能超过 6 MiB');
    }
    const hydro = await getHydroSettings();
    const requestId = createHash('sha256').update(JSON.stringify([user.id, input.requestId])).digest('hex');
    const key = `problem-create:${requestId}`;
    // Keep an intent across response loss, process restarts and setting changes.
    // The native ledger and initial document insert carry the same identity.
    const intent = input.draft !== undefined ? await prisma.systemSetting.upsert({ where: { key }, create: { key,
      value: { hash: digest(input.draft), baseUrl: hydro.baseUrl, domain: hydro.problemDomainId, state: 'pending' } }, update: {} })
      : await prisma.systemSetting.findUnique({ where: { key } });
    if (!intent) return fail('未找到本次创建记录，请使用原内容重新保存', 409);
    const saved = intent.value as { hash: string; baseUrl: string; domain: string; state: string; id?: string; sourceId?: string };
    if (input.draft !== undefined && saved.hash !== digest(input.draft)) return fail('本次创建内容已固定，请使用原内容继续保存', 409);
    if (saved.baseUrl !== hydro.baseUrl || saved.domain !== hydro.problemDomainId) return fail('保存期间题库连接或域已更改，请恢复原配置后继续保存', 409);
    const result = await requestHydroBridge<CreationResult>({ platformBaseUrl: hydro.baseUrl }, '/api/proctor/problem-bank', {
      action: 'create-step', domain: hydro.problemDomainId, requestId, draft: input.draft,
      ...(saved.sourceId ? { expectedId: saved.id, expectedSourceId: saved.sourceId } : {}),
    }, undefined, hydro);
    if (!/^[1-9]\d*$/.test(result.id) || !Number.isSafeInteger(Number(result.id)) || typeof result.complete !== 'boolean'
      || typeof result.sourceId !== 'string' || !/^[a-f0-9]{24}$/i.test(result.sourceId)
      || (result.complete && result.domain !== hydro.problemDomainId)) throw new Error('评测插件创建响应不兼容，请更新插件后使用原内容重试');
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT \`key\` FROM SystemSetting WHERE \`key\` = ${key} FOR UPDATE`;
      const latest = await tx.systemSetting.findUniqueOrThrow({ where: { key } });
      const current = latest.value as typeof saved;
      if (current.sourceId && (current.sourceId !== result.sourceId || current.id !== result.id)) throw new Error('创建记录的原题身份已改变，请检查评测服务是否已替换');
      await tx.systemSetting.update({ where: { key }, data: { value: { ...current,
        state: result.complete || current.state === 'complete' ? 'complete' : 'pending', id: result.id, sourceId: result.sourceId } } });
    }, { isolationLevel: 'ReadCommitted', maxWait: 3000, timeout: 10000 });
    return ok(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
    if (isRequestAdmissionError(error)) { const response = fail('题目保存服务繁忙，请保留内容稍后重试', 503); response.headers.set('Retry-After', '2'); return response; }
    const message = toErrorMessage(error);
    return fail(message === '服务暂不可用，请稍后再试' ? '题目保存未完成，输入和进度已保留；请检查题库连接及插件版本后继续保存' : message, 502);
  } finally { release?.(); }
}
export const OPTIONS = options;
