export type CodeCheckStatus = 'queued' | 'running' | 'cancelling' | 'cancelled' | 'complete' | 'partial' | 'failed';
export type CodeCheckLevel = 'all' | 'high' | 'medium' | 'low';
export type CodeCheckMatch = {
  startInFirst: { line: number; column: number }; endInFirst: { line: number; column: number };
  startInSecond: { line: number; column: number }; endInSecond: { line: number; column: number };
  lengthOfFirst: number; lengthOfSecond: number;
};
export type CodeCheckJobView = {
  id: string; status: CodeCheckStatus; phase: string; problemId: string | null;
  submissionScope: string; minTokens: number; total: number; read: number; compared: number;
  skipped: number; groups: number; completedGroups: number; resultCount: number; warnings: string[];
  createdAt: string; startedAt: string | null; finishedAt: string | null;
};
export type CodeCheckPairView = {
  id: string; jobId: string; problemId: string; problemTitle: string; problemOrder: number;
  language: string; firstName: string; secondName: string; firstExamNumber: string; secondExamNumber: string;
  similarity: number; firstSimilarity: number; secondSimilarity: number; versions: number;
};
export type CodeCheckData = {
  exam: { id: string; name: string }; problems: Array<{ id: string; order: number; title: string }>;
  job: CodeCheckJobView | null; activeJob: CodeCheckJobView | null; history: CodeCheckJobView[];
  rows: CodeCheckPairView[]; count: number; page: number; pageCount: number;
};
export type CodeCheckSourceView = {
  id: string; submissionId: string; candidateName: string; examNumber: string;
  lang: string; code: string; submittedAt: string;
};
export type CodeCheckDetailData = {
  pair: CodeCheckPairView & { matches: CodeCheckMatch[] };
  first: CodeCheckSourceView; second: CodeCheckSourceView;
  timing: { firstDate: string | null; secondDate: string | null; earlier: string | null; differenceText: string | null };
};
export const codeCheckStatusLabels: Record<CodeCheckStatus, string> = {
  queued: '排队中', running: '正在分析', cancelling: '正在停止', cancelled: '已停止',
  complete: '查重完成', partial: '部分完成', failed: '查重失败',
};
export const codeCheckActive = (status: string) => ['queued', 'running', 'cancelling'].includes(status);
export const codeCheckSeverity = (similarity: number): Exclude<CodeCheckLevel, 'all'> => similarity >= .8 ? 'high' : similarity >= .5 ? 'medium' : 'low';
export const codeCheckPercent = (similarity: number) => (similarity >= 1 ? 100 : Math.min(99.9, Math.max(0, similarity) * 100)).toFixed(1);
export const codeCheckLanguageLabel = (family: string) => ({ 'c-cpp': 'C/C++', python3: 'Python', java: 'Java', javascript: 'JavaScript', typescript: 'TypeScript', golang: 'Go', rust: 'Rust', csharp: 'C#', kotlin: 'Kotlin' })[family] || family;
