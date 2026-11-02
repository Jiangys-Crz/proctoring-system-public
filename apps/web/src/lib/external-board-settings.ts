import { CreateExamSchema } from '@cwnupaa/proctor-shared';
import { z } from 'zod';
import { cancelExternalBoardPush, requestExternalBoardPush } from './external-board';
import { appendExternalBoardLog } from './external-board-log';
import { externalBoardTransaction } from './external-board-transaction';

const configSchema = CreateExamSchema.pick({ externalBoardEnabled: true, externalBoardBaseUrl: true, externalBoardApiKey: true, externalBoardEventId: true, externalBoardIntervalSeconds: true });
// Remove defaults on PATCH: a configuration-only save must preserve the saved switch.
export const ExternalBoardPatchSchema = z.object({
  externalBoardEnabled: CreateExamSchema.shape.externalBoardEnabled.removeDefault().optional(),
  externalBoardIntervalSeconds: CreateExamSchema.shape.externalBoardIntervalSeconds.removeDefault().optional(),
  externalBoardBaseUrl: CreateExamSchema.shape.externalBoardBaseUrl.removeDefault(),
  externalBoardApiKey: CreateExamSchema.shape.externalBoardApiKey,
  externalBoardEventId: CreateExamSchema.shape.externalBoardEventId,
}).strict().refine(raw => Object.keys(raw).length > 0, '请填写外榜推送配置');
export type ExternalBoardPatch = z.infer<typeof ExternalBoardPatchSchema>;
export class ExternalBoardSettingsError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export const externalBoardSelect = {
  externalBoardEnabled: true, externalBoardBaseUrl: true, externalBoardApiKey: true, externalBoardEventId: true,
  externalBoardIntervalSeconds: true,
} as const;

export async function saveExternalBoardSettings(examId: string, input: ExternalBoardPatch) {
  const saved = await externalBoardTransaction(examId, async tx => {
    const current = await tx.exam.findUnique({ where: { id: examId }, select: externalBoardSelect });
    if (!current) throw new ExternalBoardSettingsError('考试不存在', 404);
    const merged = configSchema.parse({ ...current, ...input });
    const config = {
      externalBoardEnabled: merged.externalBoardEnabled,
      externalBoardIntervalSeconds: merged.externalBoardIntervalSeconds,
      externalBoardBaseUrl: merged.externalBoardBaseUrl || 'https://www.example.org/api',
      externalBoardApiKey: merged.externalBoardApiKey?.trim() || null,
      externalBoardEventId: merged.externalBoardEventId?.trim() || null,
    };
    if (config.externalBoardEnabled && !config.externalBoardEventId) throw new ExternalBoardSettingsError('开启外榜推送前，请填写 CWNUPAA 官网赛事 ID');
    const changed = Object.keys(config).some(key => config[key as keyof typeof config] !== current[key as keyof typeof current]);
    const targetChanged = (['externalBoardEnabled', 'externalBoardBaseUrl', 'externalBoardEventId', 'externalBoardApiKey'] as const).some(key => config[key] !== current[key]);
    const exam = await tx.exam.update({ where: { id: examId }, data: config, select: externalBoardSelect });
    if (changed) await tx.externalBoardSync.updateMany({ where: { examId }, data: {
      ...(targetChanged ? { configHash: null, problemsHash: null, syncedThrough: null, scanUntil: null, cursorAt: null, cursorId: null, lastSuccessAt: null } : {}),
      leaseToken: null, leaseUntil: null, nextAttemptAt: null, lastError: null,
    } });
    const logMessage =
      current.externalBoardEnabled !== config.externalBoardEnabled
        ? config.externalBoardEnabled ? `已开启推送，将立即同步，之后每 ${config.externalBoardIntervalSeconds} 秒推送一次` : '已关闭推送，停止后续同步'
        : `外榜配置已更新，推送间隔 ${config.externalBoardIntervalSeconds} 秒${config.externalBoardEnabled ? '，立即开始同步' : '，推送保持关闭'}`;
    return { exam, changed, logMessage };
  });
  if (saved.changed) {
    appendExternalBoardLog({ examId, status: 'INFO', message: saved.logMessage,
      baseUrl: saved.exam.externalBoardBaseUrl, eventId: saved.exam.externalBoardEventId });
    cancelExternalBoardPush(examId);
    if (saved.exam.externalBoardEnabled) requestExternalBoardPush();
  }
  return saved.exam;
}
