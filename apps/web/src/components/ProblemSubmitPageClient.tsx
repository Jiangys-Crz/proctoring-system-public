'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowLeft, Code2, LoaderCircle, Send } from 'lucide-react';
import { api } from './api';
import { groupJudgeLanguages } from '@/lib/exam-languages';
import { useProblemLanguages } from './useProblemLanguages';
import { CodeEditor } from './CodeHighlight';

type Problem = { id: string; pid: string; title: string; config: Record<string, any>; tags: string[]; score?: number };
type RecordData = { id: string };
const languageNames: Record<string, string> = { cc: 'C++', cpp: 'C++', 'cpp.gcc': 'C++ (GCC)', 'cpp.g++17': 'C++17', c: 'C', py: 'Python 3', python: 'Python', java: 'Java', js: 'JavaScript', ts: 'TypeScript', go: 'Go', rs: 'Rust', php: 'PHP', kt: 'Kotlin', swift: 'Swift', hs: 'Haskell', rb: 'Ruby', pas: 'Pascal', _: '提交答案' };
const label = (value: string) => languageNames[value] || value.replace(/\./g, ' · ');

export function ProblemSubmitPageClient({ problemId, examId }: { problemId: string; examId?: string }) {
  const [problem, setProblem] = useState<Problem | null>(null); const [lang, setLang] = useState('cc'); const [code, setCode] = useState(''); const [error, setError] = useState(''); const [loading, setLoading] = useState(true); const [submitting, setSubmitting] = useState(false);
  const contextQuery = examId ? `?examId=${encodeURIComponent(examId)}` : '';
  const problemPath = `/dashboard/problems/${problemId}${contextQuery}`;
  useEffect(() => { api<Problem>(`/api/problems/${problemId}`).then(p => { setProblem(p);  }).catch(e => setError(e instanceof Error ? e.message : '题目加载失败')).finally(() => setLoading(false)); }, [problemId]);
  const { languages, languageNames: enabledNames, loading: loadingLanguages, error: languageError } = useProblemLanguages(problem, lang, setLang);
  async function submit() { if (!code.trim() || !languages.includes(lang)) return; setSubmitting(true); setError(''); try { const record = await api<RecordData>(`/api/problems/${problemId}`, { method: 'POST', body: JSON.stringify({ lang, code }) }); window.location.assign(`/dashboard/problems/${problemId}/records/${record.id}${contextQuery}`); } catch (e) { setError(e instanceof Error ? e.message : '提交失败'); } finally { setSubmitting(false); } }
  if (loading) return <div className="problem-loading"><LoaderCircle className="spin" size={19} /> 正在加载题目…</div>;
  if (!problem) return <div className="card problem-error">{error || '题目不存在'}</div>;
  if (problem.config?.type === 'objective') return <div className="problem-submit-page"><div className="problem-breadcrumb"><Link href={problemPath}><ArrowLeft size={15} /> 返回题面</Link></div><div className="card objective-submit-redirect"><h2>这是客观题</h2><p>请返回题面直接选择选项或填写答案。</p></div></div>;
  return <div className="problem-submit-page"><div className="problem-breadcrumb"><Link href={problemPath}><ArrowLeft size={15} /> 返回题面</Link></div><div className="problem-submit-page-header"><h1>{problem.title}</h1></div><div className="problem-submit-page-grid"><section className="card hydro-submit-form"><div className="hydro-submit-form-title"><div><span className="hydro-judge-eyebrow">CODE EDITOR</span><h2>递交代码</h2></div><Code2 size={22} /></div><label className="hydro-language-field">语言<select value={lang} onChange={e => setLang(e.target.value)} disabled={languages.length === 1 && languages[0] === '_'}>{groupJudgeLanguages(languages.map(id => ({ id, name: enabledNames[id] || label(id) }))).map(group => <optgroup key={group.id} label={group.name}>{group.versions.map(item => <option key={item.id} value={item.id}>{item.name} ({item.id})</option>)}</optgroup>)}</select></label><label className="hydro-code-field">代码或答案<CodeEditor value={code} onChange={setCode} language={lang} rows={25} placeholder={lang === '_' ? '输入题目要求的答案' : '粘贴或编写你的代码'} /></label>{error || languageError ? <div className="problem-error">{error || languageError}</div> : null}<div className="hydro-submit-page-actions"><button className="button" onClick={() => void submit()} disabled={submitting || loadingLanguages || !languages.includes(lang) || !code.trim()}><Send size={16} /> {submitting ? '提交中…' : '提交测评'}</button></div></section></div></div>;
}
