'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, FileSearch, LoaderCircle, Play, Square } from 'lucide-react';
import { api } from './api';
import { codeCheckLanguageLabel, codeCheckPercent, codeCheckSeverity, codeCheckStatusLabels, type CodeCheckData, type CodeCheckLevel } from '@/lib/code-check/types';
import styles from './ExamCodeCheck.module.css';

const time = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false });
const levelNames = { all: '全部', high: '红色 · 高', medium: '黄色 · 中', low: '绿色 · 低' } as const;

export function ExamCodeCheckClient({ examId }: { examId: string }) {
  const [data, setData] = useState<CodeCheckData | null>(null);
  const [jobId, setJobId] = useState(''); const [level, setLevel] = useState<CodeCheckLevel>('all');
  const [resultProblem, setResultProblem] = useState(''); const [page, setPage] = useState(1);
  const [problemId, setProblemId] = useState(''); const [minTokens, setMinTokens] = useState(9);
  const [submissionScope, setSubmissionScope] = useState('all');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [ready, setReady] = useState(false); const [refresh, setRefresh] = useState(0);
  const initialized = useRef(false);

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    setJobId(query.get('jobId') || ''); setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    let mounted = true; let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      try {
        const query = new URLSearchParams({ level, page: String(page) });
        if (jobId) query.set('jobId', jobId);
        if (resultProblem) query.set('problemId', resultProblem);
        const result = await api<CodeCheckData>(`/api/exams/${examId}/code-check?${query}`);
        if (!mounted) return;
        setData(result);
        if (!initialized.current) {
          initialized.current = true;
          if (result.job) { setProblemId(result.job.problemId || ''); setMinTokens(result.job.minTokens); setSubmissionScope(result.job.submissionScope); }
        }
        if (result.activeJob) timer = setTimeout(() => void load(), 2_500);
      } catch (cause) {
        if (mounted) { setError(cause instanceof Error ? cause.message : '查重数据加载失败'); timer = setTimeout(() => void load(), 8_000); }
      }
    }
    void load();
    return () => { mounted = false; if (timer) clearTimeout(timer); };
  }, [examId, jobId, level, resultProblem, page, ready, refresh]);

  function chooseReport(id: string) {
    setJobId(id); setPage(1); setError('');
    const url = new URL(window.location.href); if (id) url.searchParams.set('jobId', id); else url.searchParams.delete('jobId');
    window.history.replaceState(null, '', url);
  }

  async function start() {
    setBusy(true); setError('');
    try {
      const job = await api<{ id: string }>(`/api/exams/${examId}/code-check`, { method: 'POST', body: JSON.stringify({ problemId, minTokens, submissionScope }) });
      chooseReport(job.id); setResultProblem(''); setLevel('all'); setRefresh(value => value + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '查重启动失败'); }
    finally { setBusy(false); }
  }

  async function stop() {
    if (!data?.activeJob) return; setBusy(true); setError('');
    try { await api(`/api/exams/${examId}/code-check/${data.activeJob.id}/cancel`, { method: 'POST' }); setRefresh(value => value + 1); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '停止查重失败'); }
    finally { setBusy(false); }
  }

  const job = data?.job;
  const progress = job?.groups ? Math.round(job.completedGroups / job.groups * 100) : 0;

  return <div className={`exam-workspace-page ${styles.page}`}>
    <header className="exam-workspace-header">
      <div className="return-only-row"><Link className="exam-back" href={`/dashboard/exams/${examId}`}><ArrowLeft size={18} /> 返回比赛详情</Link></div>
      <div className="exam-workspace-title-row"><h1>比赛代码查重</h1><span>{data?.exam.name}</span></div>
    </header>
    <main className={styles.layout}>
      <div className={styles.content}>
        {error ? <div className={styles.error} role="alert">{error}</div> : null}
        <section className={styles.card}>
          <h2><FileSearch size={20} /> 比赛代码查重</h2>
          <p>比较所有选手在同一道编程题、同一语言族下的本地递交代码。C 与 C++ 合并查重，各编译器版本归入对应语言族。仅归一化变量名，忽略格式和注释；关键字、运算符、类型、函数名和常量仍按原值区分。</p>
          <div className={styles.legend}><span className={`${styles.badge} ${styles.high}`}>高 · ≥80%</span><span className={`${styles.badge} ${styles.medium}`}>中 · 50%–79%</span><span className={`${styles.badge} ${styles.low}`}>低 · &lt;50%</span></div>
          <p className={styles.muted}>保留每对选手历史版本中最相似的一组，包含公共模板。常见算法和较短代码也可能高度相似，请结合匹配片段复核。</p>
          <form className={styles.controls} onSubmit={event => { event.preventDefault(); void start(); }}>
            <label>查重题目<select value={problemId} onChange={event => setProblemId(event.target.value)}><option value="">全部编程题</option>{data?.problems.map(problem => <option key={problem.id} value={problem.id}>{problem.title}</option>)}</select></label>
            <label>查重方式<select value={minTokens} onChange={event => setMinTokens(Number(event.target.value))}><option value={9}>标准（语法单元匹配）</option><option value={5}>高灵敏度（包含更短片段）</option><option value={15}>低灵敏度（侧重更长片段）</option></select></label>
            <label>提交范围<select value={submissionScope} onChange={event => setSubmissionScope(event.target.value)}><option value="all">所有提交</option><option value="accepted">仅已通过（AC）提交</option></select></label>
            <button className={styles.primary} type="submit" disabled={busy || !data || Boolean(data.activeJob)}>{busy ? <LoaderCircle size={16} className="spin" /> : <Play size={16} />}{data?.activeJob ? '查重进行中' : job ? '重新查重' : '开始查重'}</button>
            {data?.activeJob ? <button className={styles.stop} type="button" onClick={() => void stop()} disabled={busy || data.activeJob.status === 'cancelling'}><Square size={15} />{data.activeJob.status === 'cancelling' ? '正在停止…' : '停止查重'}</button> : null}
          </form>
          <p className={styles.muted}>每次点击只执行一次任务。重新选择题目、方式和提交范围后，点击「重新查重」即可应用；进行中的任务可先停止。只读取本平台保存的编程题递交记录。</p>
          {job ? <div className={styles.job} aria-live="polite">
            <div className={styles.jobHeading}><strong>{codeCheckStatusLabels[job.status]}</strong><span>{job.phase}</span></div>
            {job.groups > 0 ? <div className={styles.progress} aria-label={`已完成 ${progress}%`}><span style={{ width: `${progress}%` }} /></div> : null}
            {['partial', 'failed', 'cancelled', 'cancelling'].includes(job.status) ? <p className={styles.warning}>本次未完成全部代码检查，已有结果仅覆盖成功分析的部分。</p> : null}
            <div className={styles.stats}><span>读取 <b>{job.total}</b> 份提交</span><span>成功分析 <b>{job.compared}</b> 份</span><span>未分析 <b>{job.skipped}</b> 份</span><span>选手配对 <b>{job.resultCount}</b> 组</span></div>
            <p className={styles.muted}>本次范围：{job.problemId ? data?.problems.find(problem => problem.id === job.problemId)?.title || '所选题目' : '全部编程题'} · {job.submissionScope === 'accepted' ? '仅 AC 提交' : '所有提交'} · {job.minTokens === 5 ? '高灵敏度' : job.minTokens === 15 ? '低灵敏度' : '标准'}。创建于 {time(job.createdAt)}，之后的新提交可通过重新查重纳入。</p>
            {job.warnings.length ? <details className={styles.warning}><summary>查看未分析的代码与原因（{job.warnings.length} 项）</summary><ul>{job.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details> : null}
          </div> : null}
        </section>
        <section className={styles.card}>
          <h2>查重结果 <small>{data?.count || 0} 组</small></h2>
          <div className={styles.filters}><label>结果题目<select value={resultProblem} onChange={event => { setResultProblem(event.target.value); setPage(1); }}><option value="">全部题目</option>{data?.problems.map(problem => <option key={problem.id} value={problem.id}>{problem.title}</option>)}</select></label><nav aria-label="重复度筛选">{(Object.keys(levelNames) as CodeCheckLevel[]).map(value => <button key={value} className={level === value ? styles.activeFilter : ''} type="button" onClick={() => { setLevel(value); setPage(1); }}>{levelNames[value]}</button>)}</nav></div>
          {data?.rows.length ? <div className={styles.tableScroll}><table className={styles.table}><thead><tr><th>题目</th><th>选手 A</th><th>选手 B</th><th>语言</th><th>重复度</th><th>详情</th></tr></thead><tbody>{data.rows.map(row => <tr key={row.id}><td>{row.problemTitle}</td><td><strong>{row.firstName}</strong><small>{row.firstExamNumber}</small></td><td><strong>{row.secondName}</strong><small>{row.secondExamNumber}</small></td><td>{codeCheckLanguageLabel(row.language)}</td><td><span className={`${styles.badge} ${styles[codeCheckSeverity(row.similarity)]}`}>{codeCheckPercent(row.similarity)}%</span><div className={styles.meter}><span className={styles[codeCheckSeverity(row.similarity)]} style={{ width: `${codeCheckPercent(row.similarity)}%` }} /></div></td><td><Link href={`/dashboard/exams/${examId}/code-check/${row.id}`}>查看对比 →</Link></td></tr>)}</tbody></table></div> : <div className={styles.empty}>{!data ? <><LoaderCircle size={18} className="spin" /> 正在加载查重数据…</> : !job ? '尚未开始查重，点击上方按钮生成结果。' : ['queued', 'running'].includes(job.status) ? '正在分析，结果会自动更新。' : '当前筛选下没有可比较的选手配对。请查看提交数量及未分析原因。'}</div>}
          {data && data.pageCount > 1 ? <div className={styles.pagination}><button type="button" onClick={() => setPage(data.page - 1)} disabled={data.page <= 1}>← 上一页</button><span>{data.page} / {data.pageCount}</span><button type="button" onClick={() => setPage(data.page + 1)} disabled={data.page >= data.pageCount}>下一页 →</button></div> : null}
        </section>
        {data && data.history.length > 0 ? <section className={styles.card}><h2>最近查重</h2><div className={styles.history}>{data.history.map(item => <button type="button" key={item.id} className={job?.id === item.id ? styles.activeHistory : ''} onClick={() => chooseReport(item.id)}>{time(item.createdAt)} · {codeCheckStatusLabels[item.status]}{item.submissionScope === 'accepted' ? ' · AC' : ''}</button>)}</div></section> : null}
      </div>
      <aside className={styles.sidebar}><h3>比赛管理</h3><Link href={`/dashboard/exams/${examId}`}>比赛详情</Link><Link href={`/dashboard/exams/${examId}/submissions`}>递交记录</Link><Link href={`/dashboard/exams/${examId}/leaderboard`}>排行榜</Link><Link className={styles.currentNav} href={`/dashboard/exams/${examId}/code-check`} aria-current="page">代码查重</Link><Link href={`/dashboard/exams/${examId}/settings`}>比赛设置</Link></aside>
    </main>
  </div>;
}
