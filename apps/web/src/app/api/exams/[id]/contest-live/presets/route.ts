import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AuthError } from '@/lib/auth';
import { contestLiveHeaders, requireContestLiveManager } from '@/lib/contest-live-access';
import { updateContestLiveConfig } from '@/lib/contest-live-config';
import { contestLiveSceneIdSchema, contestLiveSceneNameSchema, contestLiveSceneSchema, readContestLivePresets, type ContestLivePreset } from '@/lib/contest-live-presets';
import { mergeContestLiveSettings, readContestLiveSettings } from '@/lib/contest-live-settings';
import { prisma } from '@/lib/db';
import { fail, ok, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';

export const runtime = 'nodejs';

const inputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('save'), name: contestLiveSceneNameSchema, id: contestLiveSceneIdSchema.optional() }).strict(),
  z.object({ action: z.literal('rename'), name: contestLiveSceneNameSchema, id: contestLiveSceneIdSchema }).strict(),
  z.object({ action: z.literal('remove'), id: contestLiveSceneIdSchema }).strict(),
  z.object({ action: z.literal('apply'), id: contestLiveSceneIdSchema }).strict(),
]);

type Context = { params: Promise<{ id: string }> };

function handleError(error: unknown) {
  if (error instanceof AuthError) return fail(error.message, error.status);
  if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
  return fail(toErrorMessage(error), 500);
}

export async function GET(request: Request, { params }: Context) {
  try {
    const { id } = await params;
    await requireContestLiveManager(id, request);
    const config = await prisma.contestLiveSettings.findUnique({ where: { examId: id }, select: { presets: true } });
    return ok(readContestLivePresets(config?.presets), { headers: contestLiveHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function POST(request: Request, { params }: Context) {
  try {
    const { id: examId } = await params;
    await requireContestLiveManager(examId, request);
    const input = await parseBody(request, inputSchema, 4096);
    if (input.action === 'apply') {
      const config = await prisma.contestLiveSettings.findUnique({ where: { examId }, select: { presets: true } });
      const preset = readContestLivePresets(config?.presets).find(item => item.id === input.id);
      if (!preset) throw new AuthError('导播预设不存在', 404);
      const updated = await updateContestLiveConfig(examId, previous => ({ ...previous, settings: mergeContestLiveSettings(previous.settings, preset.scene) }));
      return ok({ settings: { ...updated.settings, obsKeyActive: Boolean(updated.obsKeyHash) } }, { headers: contestLiveHeaders });
    }

    const presets = await prisma.$transaction(async tx => {
      const exam = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM Exam WHERE id = ${examId} FOR UPDATE`;
      if (!exam.length) throw new AuthError('考试不存在', 404);
      const config = await tx.contestLiveSettings.findUnique({ where: { examId }, select: { presets: true, settings: true } });
      let current = readContestLivePresets(config?.presets);
      const existing = current.find(item => item.id === input.id);
      if (input.id && !existing) throw new AuthError('导播预设不存在', 404);
      const settings = readContestLiveSettings(config?.settings);

      if (input.action === 'remove') current = current.filter(item => item.id !== input.id);
      else {
        if (current.some(item => item.id !== input.id && item.name === input.name)) throw new AuthError('已有同名导播预设', 409);
        if (!existing && current.length >= 30) throw new AuthError('一场比赛最多可保存 30 个导播预设', 409);
        const scene = input.action === 'rename' && existing ? existing.scene : contestLiveSceneSchema.strip().parse(settings);
        const next: ContestLivePreset = { id: existing?.id ?? randomUUID(), name: input.name, scene };
        current = existing ? current.map(item => item.id === next.id ? next : item) : [...current, next];
      }

      await tx.contestLiveSettings.upsert({ where: { examId }, create: { examId, settings, presets: current }, update: { presets: current } });
      return current;
    });
    return ok({ presets }, { headers: contestLiveHeaders });
  } catch (error) {
    return handleError(error);
  }
}
