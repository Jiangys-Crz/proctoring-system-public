'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, CheckCircle2, LoaderCircle, XCircle } from 'lucide-react';
import { api } from './api';
import { CodePreview } from './CodeHighlight';
import { hydroStatusIsAwaiting, hydroStatusText, hydroStatusTone } from '@/lib/hydro-status';
import { problemFullScore } from '@/lib/problem-score';

type Problem = { id: string; pid: string; title: string; score?: number; config?: Record<string, any> };
type RecordData = { id: string; ownerKey?: string; submitter?: string; hydroRecordId?: string | null; lang: string; code: string; status?: number; statusText: string; score: number; totalTestCases?: number; passedTestCases?: number; time: number; memory: number; testCases: unknown[]; judgeAt?: string | null; createdAt: string };
type TestCase = { status?: unknown; statusText?: unknown; result?: unknown; score?: unknown; points?: unknown; time?: unknown; timeMs?: unknown; memory?: unknown; memoryKb?: unknown; passed?: unknown; accepted?: unknown };

const names: Record<string, string> = { cc: 'C++', cpp: 'C++', 'cpp.gcc': 'C++ (GCC)', 'cpp.g++17': 'C++17', c: 'C', py: 'Python 3', python: 'Python', java: 'Java', js: 'JavaScript', ts: 'TypeScript', go: 'Go', rs: 'Rust', _: '提交答案' };
const label = (value: string) => names[value] || value.replace(/\./g, ' · ');
function isAwaiting(record: RecordData) { return hydroStatusIsAwaiting(record.statusText, record.status, record.judgeAt); }
function statusTone(record: RecordData) { return hydroStatusTone(record.statusText, record.status, record.judgeAt); }
function integer(value: unknown) { const number = Number(value); return Number.isFinite(number) ? Math.round(number) : 0; }
function testCaseValue(value: unknown): TestCase { return value && typeof value === 'object' ? value as TestCase : {}; }
function testCaseStatus(test: TestCase) {
  const raw = test.statusText ?? test.result;
  const rawText = String(raw ?? '').trim();
  const numericStatus = test.status ?? (/^\d+$/.test(rawText) ? rawText : undefined);
  return hydroStatusText(/^\d+$/.test(rawText) ? '' : raw, numericStatus ?? (test.accepted || test.passed ? 1 : undefined));
}
function testCaseTone(status: string) { return hydroStatusTone(status); }
function submissionDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const datePart = [date.getFullYear(), date.getMonth() + 1, date.getDate()].map(part => String(part).padStart(2, '0')).join('-');
  const timePart = [date.getHours(), date.getMinutes(), date.getSeconds()].map(part => String(part).padStart(2, '0')).join(':');
  return `${datePart} ${timePart}`;
}

export function ProblemRecordPageClient({ problemId, recordId, examId }: { problemId: string; recordId: string; examId?: string }) {
  const [problem, setProblem] = useState<Problem | null>(null);
  const [record, setRecord] = useState<RecordData | null>(null);
  const [error, setError] = useState('');
  const [showTests, setShowTests] = useState(false);
  useEffect(() => { if (!showTests) return; const previous = document.body.style.overflow; document.body.style.overflow = 'hidden'; return () => { document.body.style.overflow = previous; }; }, [showTests]);
  useEffect(() => { Promise.all([api<Problem>(`/api/problems/${problemId}`), api<RecordData>(`/api/problems/records/${recordId}`)]).then(([nextProblem, nextRecord]) => { setProblem(nextProblem); setRecord(nextRecord); }).catch(err => setError(err instanceof Error ? err.message : '提交记录加载失败')); }, [problemId, recordId]);
  useEffect(() => { if (!record || !isAwaiting(record)) return; let disposed = false; let refreshing = false; const refresh = async () => { if (refreshing) return; refreshing = true; try { const next = await api<RecordData>(`/api/problems/records/${recordId}`); if (!disposed) setRecord(next); } catch { /* keep waiting and retry */ } finally { refreshing = false; } }; const timer = window.setInterval(() => void refresh(), 1000); return () => { disposed = true; window.clearInterval(timer); }; }, [record?.id, record?.status, record?.statusText, record?.judgeAt, recordId]);
  if (!problem || !record) return <div className="problem-loading">{error || <><LoaderCircle className="spin" size={19} /> 正在加载提交记录…</>}</div>;
  const waiting = isAwaiting(record); const tone = statusTone(record); const currentStatus = hydroStatusText(record.statusText, record.status); const submitter = record.submitter || record.ownerKey || '当前管理员'; const total = record.totalTestCases ?? record.testCases?.length ?? 0; const passed = record.passedTestCases ?? 0; const fullScore = problemFullScore(problem); const scoreDisplay = `${record.score} / ${fullScore ?? '—'}`;
  return <div className="problem-record-page"><div className="problem-breadcrumb"><Link href={`/dashboard/problems/${problemId}${examId ? `?examId=${encodeURIComponent(examId)}` : ''}`}><ArrowLeft size={15} /> 返回题面</Link></div><div className="problem-record-title"><h1>{problem.title}</h1></div><main className="hydro-record-page card">
    <header className={`hydro-record-result ${tone}`}><div>{waiting ? <LoaderCircle className="spin" size={18} /> : tone === 'accepted' ? <CheckCircle2 size={18} /> : <XCircle size={18} />}<strong>{currentStatus}</strong><span>{scoreDisplay}</span></div></header>
    <div className="hydro-record-metrics hydro-record-metrics-detailed">
      <div><span>状态</span><strong>{currentStatus}</strong></div><div><span>得分</span><strong>{scoreDisplay}</strong></div><div><span>测试点</span><strong>{passed} / {total}</strong></div>
      <div><span>语言</span><strong>{label(record.lang)}</strong></div><div><span>峰值时间</span><strong>{integer(record.time)} ms</strong></div><div><span>峰值内存</span><strong>{integer(record.memory)} KB</strong></div>
      <div><span>提交 ID</span><strong>{record.id}</strong></div><div><span>提交者</span><strong>{submitter}</strong></div><div><span>提交时间</span><strong>{submissionDateTime(record.createdAt)}</strong></div>
    </div>
    <section className="hydro-record-code-section"><button type="button" className="hydro-test-details-toggle" onClick={() => setShowTests(true)}>查看测试点详情</button><CodePreview code={record.code} language={record.lang} languageLabel={label(record.lang)} toolbarLabel="代码" copyable showLineNumbers />{showTests && typeof document !== 'undefined' ? createPortal(<div className="hydro-test-modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setShowTests(false); }}><div className="hydro-test-modal" role="dialog" aria-modal="true" aria-labelledby="hydro-test-modal-title"><div className="hydro-test-modal-head"><h2 id="hydro-test-modal-title">测试点详情</h2><button type="button" className="icon-button" onClick={() => setShowTests(false)} aria-label="关闭测试点详情"><XCircle size={18} /></button></div><div className="hydro-testcase-table-wrap"><table className="hydro-testcase-table"><thead><tr><th>#</th><th>状态</th><th>耗时</th><th>内存占用</th></tr></thead><tbody>{(Array.isArray(record.testCases) ? record.testCases : []).map((raw, index) => { const test = testCaseValue(raw); const status = testCaseStatus(test); return <tr className={`testcase-${testCaseTone(status)}`} key={index}><td>#{index + 1}</td><td><span className="hydro-testcase-status">{testCaseTone(status) === 'accepted' ? '✓ ' : ''}{status}</span></td><td>{integer(test.timeMs ?? test.time)} ms</td><td>{integer(test.memoryKb ?? test.memory)} KB</td></tr>; })}</tbody></table></div></div></div>, document.body) : null}</section>
  </main></div>;
}
