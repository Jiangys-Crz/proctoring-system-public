import { randomUUID } from 'node:crypto';

type LogInput = {
  examId: string; status: 'SUCCESS' | 'ERROR' | 'INFO'; message: string;
  problemCount?: number; submissionCount?: number; durationMs?: number; baseUrl?: string | null; eventId?: string | null;
};

export type ExternalBoardLog = LogInput & {
  id: string; createdAt: string; problemCount: number; submissionCount: number; durationMs: number;
};
const memory = globalThis as typeof globalThis & { externalBoardLogs?: Map<string, ExternalBoardLog[]> };

/** Temporary, bounded logs shared by the worker and API; a service restart clears them. */
export function appendExternalBoardLog(data: LogInput) {
  const logs = memory.externalBoardLogs ??= new Map();
  const entries = logs.get(data.examId) || [];
  entries.unshift({ problemCount: 0, submissionCount: 0, durationMs: 0, ...data, id: randomUUID(), createdAt: new Date().toISOString() });
  entries.length = Math.min(entries.length, 100);
  logs.delete(data.examId);
  logs.set(data.examId, entries);
  if (logs.size > 100) logs.delete(logs.keys().next().value!);
}

export function readExternalBoardLogs(examId: string) {
  return (memory.externalBoardLogs?.get(examId) || []).map(log => ({ ...log }));
}
