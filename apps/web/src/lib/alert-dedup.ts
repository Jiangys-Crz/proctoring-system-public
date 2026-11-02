import type { Prisma } from '@prisma/client';
import { monitoredCondition } from './monitor-alert-state';

export const ALERT_COOLDOWN_MS = 5 * 60_000;

export function alertCooldownStart(now = new Date()) {
  return new Date(now.getTime() - ALERT_COOLDOWN_MS);
}

/** Call while holding the session lock from withSessionWrite. */
export async function createAlertOnce(tx: Prisma.TransactionClient, data: Prisma.AlertUncheckedCreateInput, now = new Date(), options: {
  evidence?: () => Promise<string | undefined>;
  bypassCooldown?: boolean;
} = {}) {
  if (!data.sessionId) throw new Error('自动告警必须绑定会话');
  if (data.sessionId.startsWith('test_')) return { alert: null, created: false }; // Server-assigned test sessions never retain monitoring events.
  const screenSwitchScope = data.type !== 'SCREEN_SWITCH' ? {} : data.id?.startsWith('mobile_alert_')
    ? { OR: [{ id: { startsWith: 'mobile_alert_' } }, { message: { contains: '第二机位' } }] }
    : { NOT: [{ id: { startsWith: 'mobile_alert_' } }, { message: { contains: '第二机位' } }] };
  const diagnosticPrefix = '整机域名检测状态：';
  const navigationPrefix = '内置浏览器尝试访问非考试范围页面：';
  const networkScope = data.type !== 'NETWORK_POLICY' ? {} : data.message.startsWith(diagnosticPrefix)
    ? { message: { startsWith: diagnosticPrefix } }
    : data.message.startsWith(navigationPrefix) ? { message: { startsWith: navigationPrefix } }
      : { NOT: [{ message: { startsWith: diagnosticPrefix } }, { message: { startsWith: navigationPrefix } }] };
  const captureScope = ['SCREEN_CAPTURE_LOST', 'CAMERA_CAPTURE_LOST', 'MOBILE_CAMERA_LOST'].includes(data.type)
    && !monitoredCondition(data.type, data.message)
    ? { OR: ['录像', '录屏保存', '录屏编码', '手动上报'].map(text => ({ message: { contains: text } })) } : {};
  const recent = { type: data.type, severity: { gte: data.severity ?? 3 }, createdAt: { gte: alertCooldownStart(now), lte: new Date(now.getTime() + ALERT_COOLDOWN_MS) }, ...screenSwitchScope, ...networkScope, ...captureScope };
  const duplicate = options.bypassCooldown ? null : await tx.alert.findFirst({
    where: {
      sessionId: data.sessionId,
      ...(data.id ? { OR: [{ id: data.id }, recent] } : recent)
    },
    orderBy: { createdAt: 'desc' }
  });
  if (duplicate) return { alert: duplicate, created: false };
  const evidencePath = data.evidencePath || await options.evidence?.();
  return { alert: await tx.alert.create({ data: { ...data, ...(evidencePath ? { evidencePath } : {}) } }), created: true };
}
