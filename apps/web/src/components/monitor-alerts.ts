export interface GroupableMonitorAlert {
  id: string;
  candidate: { id: string } | null;
  sessionId?: string | null;
  type: string;
  message: string;
  severity: number;
  createdAt: string;
  acknowledgedAt: string | null;
}

export const MONITOR_ALERT_GROUP_MS = 15 * 60_000;

/** Presentation only: every original event and its evidence remain available. */
export function groupMonitorAlerts<T extends GroupableMonitorAlert>(alerts: readonly T[]) {
  const groups: Array<{ id: string; alerts: T[] }> = [];
  const recent = new Map<string, { id: string; alerts: T[] }>();
  const sorted = [...alerts].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id));
  for (const alert of sorted) {
    // Keep severity upgrades, teacher notes, and handled events independent.
    const scope = alert.type === 'MANUAL_NOTE' ? alert.id : alert.candidate?.id || alert.id;
    const key = JSON.stringify([scope, alert.sessionId ?? null,
      alert.type, alert.severity, Boolean(alert.acknowledgedAt)]);
    const group = recent.get(key);
    const age = group ? Date.parse(group.alerts[0].createdAt) - Date.parse(alert.createdAt) : Infinity;
    if (group && age >= 0 && age <= MONITOR_ALERT_GROUP_MS) group.alerts.push(alert);
    else {
      const next = { id: alert.id, alerts: [alert] };
      groups.push(next);
      recent.set(key, next);
    }
  }
  return groups;
}
