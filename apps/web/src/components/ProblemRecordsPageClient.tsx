'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ArrowLeft, CheckCircle2, Clock3, LoaderCircle, Send, XCircle } from 'lucide-react';
import { api } from './api';
import { hydroStatusIsAwaiting, hydroStatusText, hydroStatusTone } from '@/lib/hydro-status';
import { problemFullScore } from '@/lib/problem-score';

type Problem = { id: string; pid: string; title: string; score?: number; config?: Record<string, any> };
type RecordData = { id: string; lang: string; status?: number; statusText: string; score: number; totalTestCases?: number; passedTestCases?: number; createdAt: string; judgeAt?: string | null };
const names: Record<string, string> = { cc: 'C++', cpp: 'C++', 'cpp.gcc': 'C++ (GCC)', 'cpp.g++17': 'C++17', c: 'C', py: 'Python 3', python: 'Python', java: 'Java', _: '提交答案' };
const label = (value: string) => names[value] || value.replace(/\./g, ' · ');
const pending = (r: RecordData) => hydroStatusIsAwaiting(r.statusText, r.status, r.judgeAt);
function submissionDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const datePart = [date.getFullYear(), date.getMonth() + 1, date.getDate()].map(part => String(part).padStart(2, '0')).join('-');
  const timePart = [date.getHours(), date.getMinutes(), date.getSeconds()].map(part => String(part).padStart(2, '0')).join(':');
  return `${datePart} ${timePart}`;
}

export function ProblemRecordsPageClient({ problemId, examId }: { problemId: string; examId?: string }) {
  const router = useRouter();
  const [problem, setProblem] = useState<Problem | null>(null); const [records, setRecords] = useState<RecordData[]>([]); const [error, setError] = useState(''); const [loading, setLoading] = useState(true);
  const contextQuery = examId ? `?examId=${encodeURIComponent(examId)}` : '';
  const problemPath = `/dashboard/problems/${problemId}${contextQuery}`;
  useEffect(() => { Promise.all([api<Problem>(`/api/problems/${problemId}`), api<RecordData[]>(`/api/problems/${problemId}/records`)]).then(([p, r]) => { setProblem(p); setRecords(r); }).catch(e => setError(e instanceof Error ? e.message : '提交记录加载失败')).finally(() => setLoading(false)); }, [problemId]);
  useEffect(() => { let disposed = false; let refreshing = false; const refresh = async () => { if (refreshing) return; refreshing = true; try { const next = await api<RecordData[]>(`/api/problems/${problemId}/records`); if (!disposed) setRecords(next); } catch { /* keep the current live state and retry */ } finally { refreshing = false; } }; const timer = window.setInterval(() => void refresh(), 1000); return () => { disposed = true; window.clearInterval(timer); }; }, [problemId]);
  if (loading) return <div className="problem-loading"><LoaderCircle className="spin" size={19} /> 正在加载本地提交记录…</div>;
  if (!problem) return <div className="card problem-error">{error || '题目不存在或无权访问'}</div>;
  const fullScore = problemFullScore(problem);
  return <div className="problem-records-page"><div className="problem-breadcrumb"><Link href={problemPath}><ArrowLeft size={15} /> 返回题面</Link></div><div className="problem-record-title"><h1>{problem.title}</h1></div>{error ? <div className="card problem-error">{error}</div> : null}<section className="card submissions-browser"><div className="submissions-browser-head"><span>本地提交记录</span><span>{records.length} 条记录</span></div>{records.length ? <div className="problems-table-wrap"><table className="table hydro-problem-table submissions-table"><thead><tr><th>状态</th><th>提交时间</th><th>语言</th><th>得分</th><th>测试点</th></tr></thead><tbody>{records.map(record => { const isPending = pending(record); const state = hydroStatusTone(record.statusText, record.status, record.judgeAt); const displayStatus = hydroStatusText(record.statusText, record.status); const detailUrl = `/dashboard/problems/${problemId}/records/${record.id}${contextQuery}`; return <tr className="submission-row-link" key={record.id} role="link" tabIndex={0} aria-label={`查看 ${displayStatus} 提交详情`} onClick={() => router.push(detailUrl)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); router.push(detailUrl); } }}><td><span className={`submission-status ${state}`}>{isPending ? <Clock3 size={13} /> : state === 'accepted' ? <CheckCircle2 size={13} /> : <XCircle size={13} />}{displayStatus}</span></td><td>{submissionDateTime(record.createdAt)}</td><td>{label(record.lang)}</td><td><strong>{record.score} / {fullScore ?? '—'}</strong></td><td>{record.passedTestCases ?? 0} / {record.totalTestCases ?? 0}</td></tr>; })}</tbody></table></div> : <div className="problems-empty"><Send size={24} /><strong>暂无提交记录</strong><span>提交代码后，测评记录会保存在本地监考系统。</span></div>}</section></div>;
}
