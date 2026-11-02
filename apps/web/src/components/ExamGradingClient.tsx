'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Check, FileCheck, LoaderCircle, RotateCcw, X } from 'lucide-react';
import { api } from './api';
import { CodePreview } from './CodeHighlight';
import { HydroProblemStatement } from './HydroProblemStatement';

type Problem = {
  id: string; order: number; label: string; hydroProblemId: string; title: string; content: string;
  html: boolean; problemType: string; hydroScore: number; score: number;
};
type GradeCell = {
  submissionId: string; status: number; statusText: string | null; systemScore: number;
  manualScore: number | null; effectiveScore: number; manualScoreUpdatedAt: string | null;
  lang: string; code: string; createdAt: string;
};
type GradeRow = {
  candidate: { id: string; examNumber: string; name: string | null; teamName: string | null; groupName: string | null; institution: string };
  rank: number | null; totalScore: number; cells: Array<GradeCell | null>;
};
type GradingData = {
  exam: { id: string; name: string; examCode: string; contestRule: 'KS' };
  problems: Problem[];
  rows: GradeRow[];
};

function score(value: number) {
  return Number(value.toFixed(2));
}

function languageName(value: string) {
  const family = value.toLowerCase().split('.')[0];
  if (family === 'cc' || family === 'cpp') return 'C++';
  if (family === 'c') return 'C';
  if (family === 'py' || family === 'python') return 'Python';
  if (family === 'java') return 'Java';
  if (value === '_') return '提交答案';
  return value;
}

export function ExamGradingClient({ examId }: { examId: string }) {
  const [data, setData] = useState<GradingData | null>(null);
  const [selected, setSelected] = useState<{ candidateId: string; problemId: string } | null>(null);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  async function load() {
    const result = await api<GradingData>(`/api/exams/${examId}/grading`);
    setData(result);
    return result;
  }

  useEffect(() => {
    let active = true;
    setLoading(true);
    api<GradingData>(`/api/exams/${examId}/grading`).then(result => {
      if (active) setData(result);
    }).catch(cause => {
      if (active) setError(cause instanceof Error ? cause.message : '评卷数据加载失败');
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [examId]);

  const selection = useMemo(() => {
    if (!data || !selected) return null;
    const row = data.rows.find(item => item.candidate.id === selected.candidateId);
    const problemIndex = data.problems.findIndex(problem => problem.id === selected.problemId);
    const problem = data.problems[problemIndex];
    const cell = row?.cells[problemIndex] || null;
    return row && problem && cell ? { row, problem, cell } : null;
  }, [data, selected]);

  function openGrade(row: GradeRow, problem: Problem, cell: GradeCell | null) {
    if (!cell) return;
    setSelected({ candidateId: row.candidate.id, problemId: problem.id });
    setDraft(cell.manualScore === null ? '' : String(score(cell.manualScore)));
    setMessage('');
    setError('');
  }

  function closeGrade() {
    if (saving) return;
    setSelected(null);
    setMessage('');
  }

  async function saveGrade(value: number | null) {
    if (!selection || saving) return;
    if (value !== null && (!Number.isFinite(value) || value < 0 || value > selection.problem.score)) {
      setError(`请输入 0 至 ${selection.problem.score} 之间的分数`);
      return;
    }
    setSaving(true);
    setError('');
    setMessage('');
    try {
      await api(`/api/exams/${examId}/grading`, {
        method: 'PATCH',
        body: JSON.stringify({ submissionId: selection.cell.submissionId, score: value }),
      });
      const next = await load();
      const nextRow = next.rows.find(item => item.candidate.id === selection.row.candidate.id);
      const problemIndex = next.problems.findIndex(problem => problem.id === selection.problem.id);
      const nextCell = nextRow?.cells[problemIndex] || null;
      setDraft(nextCell?.manualScore === null || nextCell?.manualScore === undefined ? '' : String(score(nextCell.manualScore)));
      if (value === null) setMessage('已恢复使用系统评测分');
      else setSelected(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '评分保存失败');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="exam-workspace-page"><div className="exam-overview-loading"><LoaderCircle className="spin" size={22} /> 正在加载评卷数据…</div></div>;
  if (!data) return <div className="exam-workspace-page"><div className="exam-editor-error" role="alert">{error || '无法打开评卷页面'}</div></div>;

  return <div className="exam-workspace-page ks-grading-page">
    <header className="exam-workspace-header">
      <div className="return-only-row"><Link href={`/dashboard/exams/${examId}`} className="exam-back"><ArrowLeft size={18} /> 返回考试详情</Link></div>
      <div className="exam-workspace-title-row"><h1>KS 评卷</h1><span>{data.exam.name}</span></div>
    </header>
    <main className="exam-workspace-content">
      {error ? <div className="exam-editor-error" role="alert">{error}</div> : null}
      <section className="exam-overview-card ks-grade-sheet">
        <div className="exam-card-heading"><FileCheck size={19} /><h2>考试成绩表</h2><span>点击非客观题分数进入评卷</span></div>
        <div className="ks-grade-table-wrap"><table className="ks-grade-table"><thead><tr><th className="ks-grade-rank">Rk</th><th className="ks-grade-candidate">考生</th><th className="ks-grade-total">总分</th>{data.problems.map(problem => <th key={problem.id}><span>{problem.label}</span><small>{problem.score} 分</small></th>)}</tr></thead><tbody>{data.rows.map(row => <tr key={row.candidate.id}><td className="ks-grade-rank">{row.rank ?? '—'}</td><td className="ks-grade-candidate"><strong>{row.candidate.teamName || row.candidate.name || row.candidate.examNumber}</strong><small>{row.candidate.examNumber}{row.candidate.institution ? ` · ${row.candidate.institution}` : ''}</small></td><td className="ks-grade-total">{score(row.totalScore)}</td>{data.problems.map((problem, index) => {
          const cell = row.cells[index];
          const objective = problem.problemType === 'objective';
          return <td key={`${row.candidate.id}-${problem.id}`}><button type="button" className={`ks-grade-cell${cell?.manualScore !== null && cell?.manualScore !== undefined ? ' manual' : ''}${objective ? ' objective' : ''}`} disabled={!cell || objective} onClick={() => openGrade(row, problem, cell)} title={objective ? '客观题不允许人工改分' : cell ? `系统评测分 ${score(cell.systemScore)}` : '未提交'}><strong>{cell ? score(cell.effectiveScore) : '—'}</strong>{cell?.manualScore !== null && cell?.manualScore !== undefined ? <small>人工</small> : <small>{objective ? '客观题' : cell ? '系统' : '未提交'}</small>}</button></td>;
        })}</tr>)}</tbody></table></div>
      </section>
    </main>

    {selection ? <div className="ks-grading-backdrop" role="presentation"><section className="ks-grading-dialog" role="dialog" aria-modal="true" aria-label={`${selection.row.candidate.name || selection.row.candidate.examNumber} ${selection.problem.title} 评卷`}>
      <header><div><span>{selection.problem.label} · {selection.problem.score} 分</span><h2>{selection.problem.title}</h2><p>{selection.row.candidate.name || selection.row.candidate.examNumber} · {selection.row.candidate.examNumber}</p></div><button type="button" onClick={closeGrade} disabled={saving} aria-label="关闭评卷"><X size={20} /></button></header>
      <div className="ks-grading-split">
        <article className="ks-grading-problem"><div className="ks-grading-pane-title"><span>PROBLEM</span><h3>题目内容</h3></div><div className="ks-grading-statement"><HydroProblemStatement content={selection.problem.content} html={selection.problem.html} problemId={selection.problem.hydroProblemId} /></div></article>
        <aside className="ks-grading-submission"><div className="ks-grading-score-panel"><div><span>系统评测分</span><strong>{score(selection.cell.systemScore)} / {selection.problem.score}</strong></div><label><span>人工评分</span><div><input type="number" min="0" max={selection.problem.score} step="0.01" value={draft} onChange={event => setDraft(event.target.value)} placeholder={`0 - ${selection.problem.score}`} disabled={saving} /><em>/ {selection.problem.score}</em></div></label><button type="button" className="ks-grade-save" onClick={() => void saveGrade(Number(draft))} disabled={saving || !draft.trim()}>{saving ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}{saving ? '保存中…' : '保存评分'}</button><button type="button" className="ks-grade-reset" onClick={() => void saveGrade(null)} disabled={saving || selection.cell.manualScore === null}><RotateCcw size={15} />恢复系统分</button></div>
          {message ? <div className="ks-grade-message">{message}</div> : null}
          <div className="ks-grading-pane-title code"><span>SUBMISSION</span><h3>提交代码</h3><small>{languageName(selection.cell.lang)} · {selection.cell.lang}</small></div>
          <CodePreview code={selection.cell.code || '暂无提交内容'} language={selection.cell.lang} showLineNumbers copyable className="ks-grading-code" />
        </aside>
      </div>
    </section></div> : null}
  </div>;
}
