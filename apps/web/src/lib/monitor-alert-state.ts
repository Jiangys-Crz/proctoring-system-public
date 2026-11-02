import type { Alert, AlertType, Prisma } from '@prisma/client';

// A fixed set of server-observable conditions. Instantaneous events (page
// switches, blocked navigation, scanner diagnostics) keep their own cooldown.
const conditionTypes = [
  'SCREEN_CAPTURE_LOST', 'CAMERA_CAPTURE_LOST', 'MOBILE_CAMERA_LOST',
  'PROCESS_POLICY', 'NETWORK_POLICY', 'VIRTUAL_MACHINE', 'CLIENT_OFFLINE', 'SECOND_CAMERA_OFFLINE', 'USB_SCAN_FAILED'
] as const;
type Condition = typeof conditionTypes[number];
type Episode = { active: boolean; alertId: string; severity: number; healthySince?: number; lastHealthyAt?: number; recoveredAt?: number; recoveredSeverity?: number; eventIds?: string[] };
export const MONITOR_RECOVERY_MS = 10_000;
const MAX_HEALTHY_GAP_MS = 15_000;
const MAX_EVENT_IDS = 32;
export const USB_SCAN_FAILURE_MESSAGE = 'USB 外设检测不可用或结果已过期，请恢复检测后联系监考员解锁';

export function monitoredCondition(type: AlertType, message = ''): Condition | undefined {
  if (type === 'PERIPHERAL_CHANGED' && message === USB_SCAN_FAILURE_MESSAGE) return 'USB_SCAN_FAILED';
  if (type === 'NETWORK_POLICY' && /^(?:整机域名检测状态：|内置浏览器尝试访问非考试范围页面：)/.test(message)) return undefined;
  if (['SCREEN_CAPTURE_LOST', 'CAMERA_CAPTURE_LOST', 'MOBILE_CAMERA_LOST'].includes(type)
    && /录像|录屏保存|录屏编码|手动上报/.test(message)) return undefined;
  return (conditionTypes as readonly string[]).includes(type) ? type as Condition : undefined;
}

/** Created and persisted only while holding withSessionWrite's session lock. */
export class MonitorAlertState {
  private readonly entries: Partial<Record<Condition, Episode>> = {};
  changed = false;

  constructor(value: unknown) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const key of conditionTypes) {
      const row = (value as Record<string, unknown>)[key];
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
      const data = row as Record<string, unknown>;
      if (typeof data.active !== 'boolean' || typeof data.alertId !== 'string' || !data.alertId || data.alertId.length > 191
        || typeof data.severity !== 'number' || data.severity < 1 || data.severity > 5) continue;
      this.entries[key] = { active: data.active, alertId: data.alertId, severity: data.severity,
        ...(typeof data.healthySince === 'number' && Number.isFinite(data.healthySince) ? { healthySince: data.healthySince } : {}),
        ...(typeof data.lastHealthyAt === 'number' && Number.isFinite(data.lastHealthyAt) ? { lastHealthyAt: data.lastHealthyAt } : {}),
        ...(typeof data.recoveredAt === 'number' && Number.isFinite(data.recoveredAt) ? { recoveredAt: data.recoveredAt } : {}),
        ...(typeof data.recoveredSeverity === 'number' && data.recoveredSeverity >= 1 && data.recoveredSeverity <= 5 ? { recoveredSeverity: data.recoveredSeverity } : {}),
        ...(Array.isArray(data.eventIds) ? { eventIds: data.eventIds.filter((id): id is string => typeof id === 'string' && id.length <= 191).slice(-MAX_EVENT_IDS) } : {}) };
    }
  }

  /** Missing observations are unknown, never proof of recovery. */
  observe(type: Condition, healthy: boolean | undefined, now: Date) {
    const entry = this.entries[type];
    if (!entry?.active) return;
    if (healthy !== true) {
      // An unknown/failed sample also breaks a run of confirmed healthy data.
      if (entry.healthySince !== undefined) { delete entry.healthySince; this.changed = true; }
      if (entry.lastHealthyAt !== undefined) { delete entry.lastHealthyAt; this.changed = true; }
      return;
    }
    const time = now.getTime();
    // A reconnect after a long silence is one healthy sample, not continuous
    // recovery. Older persisted states without this timestamp restart safely.
    if (entry.healthySince === undefined || entry.lastHealthyAt === undefined
      || time < entry.lastHealthyAt || time - entry.lastHealthyAt > MAX_HEALTHY_GAP_MS) {
      entry.healthySince = time; this.changed = true;
    }
    else if (now.getTime() - entry.healthySince >= MONITOR_RECOVERY_MS) {
      entry.active = false;
      entry.recoveredAt = now.getTime();
      entry.recoveredSeverity = entry.severity;
      delete entry.healthySince;
      delete entry.lastHealthyAt;
      this.changed = true;
    }
    if (entry.active && entry.lastHealthyAt !== time) { entry.lastHealthyAt = time; this.changed = true; }
  }

  toJson(): Prisma.InputJsonObject { return this.entries as unknown as Prisma.InputJsonObject; }

  async report(tx: Prisma.TransactionClient, data: Prisma.AlertUncheckedCreateInput, options: {
    now: Date; eventId?: string; occurredAt?: Date; evidence?: () => Promise<string | undefined>; returnDuplicate?: boolean;
  }): Promise<{ alert: Alert | null; created: boolean }> {
    const type = monitoredCondition(data.type, data.message);
    if (!type || !data.sessionId) throw new Error('持续告警必须绑定可观测的会话条件');
    if (data.sessionId.startsWith('test_')) return { alert: null, created: false };
    const entry = this.entries[type];
    // Persisted alert IDs remain idempotent even after the condition recovered.
    if (options.eventId) {
      const replay = await tx.alert.findFirst({ where: { sessionId: data.sessionId, id: options.eventId } });
      if (replay) return { alert: replay, created: false };
    }
    const severity = data.severity ?? 3;
    const historical = Boolean(entry && options.occurredAt && entry.recoveredAt !== undefined && options.occurredAt.getTime() <= entry.recoveredAt);
    const duplicate = entry && (entry.eventIds?.includes(options.eventId || '')
      || (historical ? severity <= (entry.recoveredSeverity ?? entry.severity) : entry.active && severity <= entry.severity));
    if (duplicate) {
      if (!historical && entry.active && entry.healthySince !== undefined
        && (!options.occurredAt || options.occurredAt.getTime() >= entry.healthySince)) {
        delete entry.healthySince; delete entry.lastHealthyAt; this.changed = true;
      }
      this.remember(entry, options.eventId);
      return { alert: options.returnDuplicate ? await tx.alert.findFirst({ where: { id: entry.alertId, sessionId: data.sessionId } }) : null, created: false };
    }
    const evidencePath = data.evidencePath || await options.evidence?.();
    const alert = await tx.alert.create({ data: { ...data, ...(evidencePath ? { evidencePath } : {}) } });
    if (historical && entry) {
      // Preserve a late, more serious first report as historical evidence, but
      // never revive a condition that the server has already seen recover.
      entry.recoveredSeverity = severity;
      this.remember(entry, options.eventId);
      this.changed = true;
      return { alert, created: true };
    }
    const next: Episode = { active: true, alertId: alert.id, severity,
      ...(entry?.recoveredAt !== undefined ? { recoveredAt: entry.recoveredAt } : {}),
      ...(entry?.recoveredSeverity !== undefined ? { recoveredSeverity: entry.recoveredSeverity } : {}),
      ...(entry?.eventIds ? { eventIds: [...entry.eventIds] } : {}) };
    this.remember(next, options.eventId);
    this.entries[type] = next;
    this.changed = true;
    return { alert, created: true };
  }

  private remember(entry: Episode, id?: string) {
    if (!id || entry.eventIds?.includes(id)) return;
    entry.eventIds = [...(entry.eventIds || []), id].slice(-MAX_EVENT_IDS);
    this.changed = true;
  }
}
