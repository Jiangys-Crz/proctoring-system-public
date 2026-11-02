export type HydroStatusTone = 'pending' | 'accepted' | 'failed';

const numericLabels: Record<number, string> = {
  0: 'Waiting',
  1: 'Accepted',
  2: 'Wrong Answer',
  3: 'Time Limit Exceeded',
  4: 'Memory Limit Exceeded',
  5: 'Output Limit Exceeded',
  6: 'Runtime Error',
  7: 'Compile Error',
  8: 'System Error',
};

export function hydroStatusText(raw: unknown, numericStatus?: unknown) {
  const numeric = Number(numericStatus);
  const source = String(raw ?? '').trim();
  if (!source && Number.isFinite(numeric) && numericLabels[numeric]) return numericLabels[numeric];
  const text = source.toLowerCase();
  if (!text && Number.isFinite(numeric) && numericLabels[numeric]) return numericLabels[numeric];
  if (/^(accepted|ac|通过|答案正确)$/.test(text)) return 'Accepted';
  if (/wrong\s*answer|答案错误|wrong$/.test(text)) return 'Wrong Answer';
  if (/compile\s*error|compilation\s*error|编译错误/.test(text)) return 'Compile Error';
  if (/time\s*limit|超时/.test(text)) return 'Time Limit Exceeded';
  if (/memory\s*limit|memory\s*error|内存超限/.test(text)) return 'Memory Limit Exceeded';
  if (/output\s*limit|输出超限/.test(text)) return 'Output Limit Exceeded';
  if (/runtime\s*error|运行错误/.test(text)) return 'Runtime Error';
  if (/presentation\s*error|格式错误/.test(text)) return 'Presentation Error';
  if (/system\s*error|系统错误/.test(text)) return 'System Error';
  if (/queue|排队/.test(text)) return 'Queueing';
  if (/judg|评测/.test(text)) return 'Judging';
  if (/compil|编译/.test(text)) return 'Compiling';
  if (/run|test|运行/.test(text)) return 'Judging';
  if (/wait|pending|等待/.test(text)) return 'Waiting';
  return source || (Number.isFinite(numeric) && numericLabels[numeric]) || 'Waiting';
}

export function hydroStatusTone(raw: unknown, numericStatus?: unknown, judgeAt?: string | null): HydroStatusTone {
  const text = hydroStatusText(raw, numericStatus);
  if (text === 'Accepted') return 'accepted';
  if (['Waiting', 'Queueing', 'Judging', 'Compiling'].includes(text) || (!judgeAt && !/Error|Exceeded|Wrong Answer|Rejected/.test(text))) return 'pending';
  return 'failed';
}

export function hydroStatusIsAwaiting(raw: unknown, numericStatus?: unknown, judgeAt?: string | null) {
  return hydroStatusTone(raw, numericStatus, judgeAt) === 'pending';
}
