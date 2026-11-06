'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, Ban, BarChart3, CalendarClock, Clock3, CopyCheck, Download, FileCheck, FileText, Film, Flag, List, LoaderCircle,
  Eye, Pencil, RotateCcw, Settings, Trophy, Users
} from 'lucide-react';
import { MarkdownContent } from './MarkdownComposer';
import { api } from './api';
import { problemTypeLabel } from '@cwnupaa/proctor-shared';
import { LeaderboardTable } from '@cwnupaa/proctor-shared/leaderboard-table';
import type { LeaderboardData } from '@cwnupaa/proctor-shared/leaderboard';

type Rule = 'GPLT' | 'XCPC' | 'LANQIAO' | 'ACM' | 'OI' | 'IOI' | 'KS';
type View = 'details' | 'problems' | 'leaderboard' | 'submissions';
type Problem = { id: string; order: number; hydroProblemId: string; title: string; problemType: string; score: number };
type Overview = {
  exam: {
    platform: 'HYDRO' | 'NOVAJUDGE'; platformBaseUrl: string; platformContestId: string; id: string; examCode: string; name: string; rules: string; contestRule: Rule; contestType: 'INDIVIDUAL' | 'TEAM';
    startAt: string; latestStartAt: string; endAt: string; durationMinutes: number; flexible: boolean;
    problems: Problem[]; participantCount: number; submissionCount: number;
  };
  leaderboard: LeaderboardData;
  canManage: boolean;
};
type Submission = {
  id: string; lang: string; code: string; status: number; statusText: string | null; score: number;
  passedTestCases: number; totalTestCases: number; time: number; memory: number; createdAt: string;
  candidate: { examNumber: string; name: string | null; teamName: string | null };
  problem: Problem;
};

const ruleLabels: Record<Rule, string> = { GPLT: 'GPLT', XCPC: 'XCPC', LANQIAO: 'LANQIAO', ACM: 'XCPC', OI: 'OI', IOI: 'IOI', KS: 'KS' };

function problemLabel(order: number) {
  let value = order + 1, result = '';
  while (value > 0) { value -= 1; result = String.fromCharCode(65 + value % 26) + result; value = Math.floor(value / 26); }
  return result;
}

function durationLabel(minutes: number) {
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  return [days ? `${days} 天` : '', hours ? `${hours} 小时` : '', rest ? `${rest} 分钟` : ''].filter(Boolean).join(' ') || '0 分钟';
}

function countdown(value: number) {
  const seconds = Math.max(0, Math.floor(value / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function dateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const datePart = [date.getFullYear(), date.getMonth() + 1, date.getDate()].map(part => String(part).padStart(2, '0')).join('-');
  const timePart = [date.getHours(), date.getMinutes(), date.getSeconds()].map(part => String(part).padStart(2, '0')).join(':');
  return `${datePart} ${timePart}`;
}

function statusFor(startAt: string, endAt: string, now: number) {
  if (now < +new Date(startAt)) return { text: '马上开始', tone: 'upcoming' };
  if (now <= +new Date(endAt)) return { text: '进行中', tone: 'running' };
  return { text: '已结束', tone: 'ended' };
}

function resultText(submission: Submission) {
  if ([0, 20, 21, 22].includes(submission.status)) return submission.statusText || '等待评测';
  return submission.statusText || (submission.status === 1 ? '答案正确' : `状态 ${submission.status}`);
}

function resultTone(status: number) {
  if ([0, 20, 21, 22].includes(status)) return 'pending';
  if ([1, 32].includes(status)) return 'accepted';
  if ([9, 30, 31].includes(status)) return 'ignored';
  return 'failed';
}

export function ExamOverviewClient({ examId, initialCanManage, initialView = 'details', fullScreen = false }: { examId: string; initialCanManage: boolean; initialView?: View; fullScreen?: boolean }) {
  const [data, setData] = useState<Overview | null>(null);
  const view = initialView;
  const [submissions, setSubmissions] = useState<Submission[] | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [submissionsLoading, setSubmissionsLoading] = useState(false);
  const [submissionAction, setSubmissionAction] = useState<{ id: string; action: 'rejudge' | 'ignore' } | null>(null);
  const [bulkRejudging, setBulkRejudging] = useState(false);
  const [bulkRejudgeMessage, setBulkRejudgeMessage] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportingPapers, setExportingPapers] = useState(false);
  const [now, setNow] = useState(Date.now());
  const leaderboardTimePoint = useRef<number | null>(null);
  async function refreshBoard(timePoint?: number | null) {
    if (timePoint !== undefined) leaderboardTimePoint.current = timePoint;
    const selected = leaderboardTimePoint.current;
    try {
      const next = await api<Overview>(`/api/exams/${examId}/overview${selected === null ? '' : `?timePoint=${selected}`}`);
      if (selected === leaderboardTimePoint.current) setData(next);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '排行榜加载失败'); }
  }

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    api<Overview>(`/api/exams/${examId}/overview`).then(result => {
      if (active) setData(result);
    }).catch(err => {
      if (active) setError(err instanceof Error ? err.message : '考试详情加载失败');
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [examId]);

  const canManage = data?.canManage ?? initialCanManage;
  useEffect(() => {
    if (view !== 'submissions' || submissions || submissionsLoading || !canManage) return;
    setSubmissionsLoading(true);
    api<Submission[]>(`/api/exams/${examId}/submissions`).then(setSubmissions).catch(err => {
      setError(err instanceof Error ? err.message : '递交记录加载失败');
    }).finally(() => setSubmissionsLoading(false));
  }, [canManage, examId, submissions, submissionsLoading, view]);

  useEffect(() => {
    if (view !== 'submissions' || !canManage) return;
    let disposed = false;
    let refreshing = false;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const next = await api<Submission[]>(`/api/exams/${examId}/submissions`);
        if (!disposed) setSubmissions(next);
      } catch { /* retain the latest records and retry */ }
      finally { refreshing = false; }
    };
    const timer = window.setInterval(() => void refresh(), 1_000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [canManage, examId, view]);

  useEffect(() => {
    if (view !== 'leaderboard') return;
    let disposed = false;
    let refreshing = false;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const selected = leaderboardTimePoint.current;
        const next = await api<Overview>(`/api/exams/${examId}/overview${selected === null ? '' : `?timePoint=${selected}`}`);
        if (!disposed && selected === leaderboardTimePoint.current) setData(next);
      } catch { /* retain the latest board and retry */ }
      finally { refreshing = false; }
    };
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [examId, view]);

  const status = useMemo(() => data ? statusFor(data.exam.startAt, data.exam.endAt, now) : null, [data, now]);
  const latestStartVisible = Boolean(data?.exam.flexible && !['XCPC', 'ACM'].includes(data.exam.contestRule) && +new Date(data.exam.latestStartAt) > +new Date(data.exam.startAt));

  async function exportCodes() {
    setExporting(true); setError('');
    try {
      const response = await fetch(`/api/exams/${examId}/export-code`);
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { message?: string } | null;
        throw new Error(body?.message || '代码导出失败');
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `exam-${data?.exam.examCode || examId}-codes.zip`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : '代码导出失败');
    } finally {
      setExporting(false);
    }
  }

  async function exportPapers() {
    setExportingPapers(true); setError('');
    try {
      const response = await fetch(`/api/exams/${examId}/export-papers`);
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { message?: string } | null;
        throw new Error(body?.message || '试卷导出失败');
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${exam.name}-试卷.zip`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : '试卷导出失败');
    } finally {
      setExportingPapers(false);
    }
  }

  async function actOnSubmission(submission: Submission, action: 'rejudge' | 'ignore') {
    if (submissionAction || bulkRejudging) return;
    if (action === 'ignore' && !window.confirm('确认取消这条递交的成绩？该记录会保留，但不再计入排行榜。')) return;
    setSubmissionAction({ id: submission.id, action });
    setError('');
    try {
      await api(`/api/exams/${examId}/submissions/${encodeURIComponent(submission.id)}`, {
        method: 'POST',
        body: JSON.stringify({ action }),
      });
      const next = await api<Submission[]>(`/api/exams/${examId}/submissions`);
      setSubmissions(next);
    } catch {
      setError(action === 'rejudge' ? '重测失败，请检查评测服务后重试' : '取消成绩失败，请稍后重试');
    } finally {
      setSubmissionAction(null);
    }
  }

  async function rejudgeAllSubmissions() {
    if (bulkRejudging || submissionAction) return;
    if (!window.confirm('确认重测本场考试的所有有效递交？已取消成绩的记录会被跳过，人工评分不会被修改。')) return;
    setBulkRejudging(true);
    setBulkRejudgeMessage('');
    setError('');
    try {
      const result = await api<{ total: number; completed: number; failed: number; queued?: number }>(`/api/exams/${examId}/submissions`, { method: 'POST' });
      setBulkRejudgeMessage(result.queued !== undefined ? `已将 ${result.queued} 条递交加入后台重测队列，人工评分未改变` : result.failed ? `已重测 ${result.completed}/${result.total} 条，${result.failed} 条失败` : `已完成 ${result.completed} 条递交的重测，人工评分未改变`);
      setSubmissions(await api<Submission[]>(`/api/exams/${examId}/submissions`));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '重测所有提交失败');
    } finally {
      setBulkRejudging(false);
    }
  }

  if (loading) return <div className={fullScreen ? 'exam-workspace-page' : ''}><div className="exam-overview-loading"><LoaderCircle className="spin" size={22} /> 正在加载考试详情…</div></div>;
  if (!data || !status) return <div className={fullScreen ? 'exam-workspace-page' : ''}><div className="exam-editor-error" role="alert">{error || '考试不存在或无权访问'}</div></div>;
  const exam = data.exam;
  const beginsIn = +new Date(exam.startAt) - now;
  const remaining = +new Date(exam.endAt) - now;
  const countdownTitle = beginsIn > 0 ? '距离考试开始' : remaining > 0 ? '考试剩余时间' : '考试剩余时间';
  const countdownValue = countdown(beginsIn > 0 ? beginsIn : remaining);
  const viewTitles: Record<View, string> = { details: '考试说明', problems: '题目列表', leaderboard: '排行榜', submissions: '所有递交' };
  const viewContent = <>
    {exam.platform === 'NOVAJUDGE' && view !== 'details' ? <section className="exam-overview-card"><p>本场考试的题目、提交和排行榜由 NovaJudge 管理。</p><a className="button" href={`${exam.platformBaseUrl}/contest/${exam.platformContestId}`} target="_blank" rel="noreferrer">打开 NovaJudge 比赛</a></section> : null}
    {view === 'details' ? <section className="exam-overview-card exam-description-card">
      <div className="exam-card-heading"><FileText size={19} /><h2>考试说明</h2></div>
      <div className="hydro-markdown exam-description-markdown"><MarkdownContent content={exam.rules || '暂无考试详情'} /></div>
    </section> : null}

    {view === 'problems' && exam.platform !== 'NOVAJUDGE' ? <section className="exam-overview-card">
      <div className="exam-card-heading"><List size={19} /><h2>题目列表</h2><span>{exam.problems.length} 道题</span></div>
      <div className="exam-overview-problems">{exam.problems.map(problem => <Link href={`/dashboard/problems/${encodeURIComponent(problem.hydroProblemId)}?examId=${encodeURIComponent(examId)}`} key={problem.id} className="exam-overview-problem"><span>{problemLabel(problem.order)}</span><div><strong>{problem.title}</strong><small>{problemTypeLabel(problem.problemType)} · {problem.score} 分</small></div><span className="exam-problem-open">查看题目</span></Link>)}{!exam.problems.length ? <div className="exam-overview-empty">暂无题目</div> : null}</div>
    </section> : null}

    {view === 'leaderboard' && exam.platform !== 'NOVAJUDGE' ? <section className="exam-overview-card">
      <LeaderboardTable key={examId} leaderboard={data.leaderboard} rule={exam.contestRule} title={exam.name} startAt={exam.startAt} endAt={exam.endAt} problems={exam.problems.map(problem => ({ id: problem.id, label: problemLabel(problem.order), title: problem.title, score: problem.score }))} onRefresh={() => void refreshBoard()} onTimeChange={timePoint => void refreshBoard(timePoint)} />
    </section> : null}

    {view === 'submissions' && exam.platform !== 'NOVAJUDGE' ? <section className="exam-overview-card">
      <div className="exam-card-heading"><Flag size={19} /><h2>所有递交</h2><div className="exam-card-heading-actions">{bulkRejudgeMessage ? <span>{bulkRejudgeMessage}</span> : null}<button type="button" onClick={() => void rejudgeAllSubmissions()} disabled={bulkRejudging || Boolean(submissionAction) || !submissions?.length}>{bulkRejudging ? <LoaderCircle className="spin" size={15} /> : <RotateCcw size={15} />}{bulkRejudging ? '重测中…' : '重测所有提交'}</button><span>{exam.submissionCount} 条记录</span></div></div>
      {submissionsLoading ? <div className="exam-overview-empty"><LoaderCircle className="spin" size={18} /> 正在加载递交记录…</div> : <div className="exam-overview-table-wrap"><table className="exam-overview-table exam-submissions-table"><thead><tr><th>操作</th><th>提交时间</th><th>考生 / 队伍</th><th>题目</th><th>语言</th><th>结果</th><th>得分</th><th>测试点</th><th>提交内容</th></tr></thead><tbody>{(submissions || []).map(submission => {
        const rejudging = submissionAction?.id === submission.id && submissionAction.action === 'rejudge';
        const ignoring = submissionAction?.id === submission.id && submissionAction.action === 'ignore';
        return <tr key={submission.id}><td><div className="submission-admin-actions"><button type="button" onClick={() => void actOnSubmission(submission, 'rejudge')} disabled={bulkRejudging || Boolean(submissionAction)}>{rejudging ? <LoaderCircle className="spin" size={14} /> : <RotateCcw size={14} />}{rejudging ? '重测中…' : '重测'}</button><button className="danger" type="button" onClick={() => void actOnSubmission(submission, 'ignore')} disabled={bulkRejudging || Boolean(submissionAction) || submission.status === 30}>{ignoring ? <LoaderCircle className="spin" size={14} /> : <Ban size={14} />}{ignoring ? '取消中…' : '取消成绩'}</button></div></td><td><time dateTime={submission.createdAt}>{dateTime(submission.createdAt)}</time></td><td><strong>{submission.candidate.teamName || submission.candidate.name || submission.candidate.examNumber}</strong><small>{submission.candidate.examNumber}</small></td><td>{problemLabel(submission.problem.order)} · {submission.problem.title}</td><td>{submission.lang}</td><td><span className={`submission-result-tag ${resultTone(submission.status)}`}>{resultText(submission)}</span></td><td><strong>{Number(submission.score.toFixed(2))}</strong></td><td>{submission.passedTestCases} / {submission.totalTestCases}</td><td><details><summary>查看提交内容</summary><pre><code>{submission.code}</code></pre></details></td></tr>;
      })}</tbody></table>{submissions && !submissions.length ? <div className="exam-overview-empty">暂无递交记录</div> : null}</div>}
    </section> : null}
  </>;

  if (fullScreen) return <div className="exam-workspace-page">
    <header className="exam-workspace-header">
      <div className="return-only-row"><Link href={`/dashboard/exams/${examId}`} className="exam-back"><ArrowLeft size={18} /> 返回考试详情</Link></div>
      {view === 'leaderboard' ? null : <div className="exam-workspace-title-row"><h1>{viewTitles[view]}</h1><span>{exam.name}</span></div>}
    </header>
    <main className="exam-workspace-content">{error ? <div className="exam-editor-error" role="alert">{error}</div> : null}{viewContent}</main>
  </div>;

  return <div className="exam-overview-page">
    {error ? <div className="exam-editor-error" role="alert">{error}</div> : null}
    <div className="exam-overview-layout">
      <main className="exam-overview-main">
        <section className="exam-overview-hero">
          <div className="exam-overview-title"><span>考试编号 #{exam.examCode}</span><h1>{exam.name}</h1></div>
          <div className="exam-overview-meta">
            <span className={`exam-status-badge ${status.tone}`}>{status.text}</span>
            <span className="exam-rule-badge"><Trophy size={17} />{exam.platform === 'NOVAJUDGE' ? 'NovaJudge' : ruleLabels[exam.contestRule]}</span>
            <span><CalendarClock size={17} />开始于 {dateTime(exam.startAt)}</span>
            {latestStartVisible ? <span><CalendarClock size={17} />最晚开始 {dateTime(exam.latestStartAt)}</span> : null}
            <span><Clock3 size={17} />{durationLabel(exam.durationMinutes)}</span>
            <span><Clock3 size={17} />{countdownTitle} {countdownValue}</span>
            <span><Users size={17} />{exam.participantCount} 人</span>
          </div>
        </section>

        {viewContent}
      </main>

      <aside className="exam-overview-sidebar">
        <nav className="exam-overview-actions" aria-label="考试详情操作">
          {exam.platform === 'NOVAJUDGE' ? <>
            <a href={`${exam.platformBaseUrl}/contest/${exam.platformContestId}`} target="_blank" rel="noreferrer"><Trophy size={19} />NovaJudge 比赛</a>
            {canManage ? <Link href={`/dashboard/exams/${examId}/reactions`}><Film size={19} />Reaction 录像</Link> : null}
            {canManage ? <><Link href={`/dashboard/exams/${examId}/settings`}><Pencil size={19} />编辑考试</Link><Link href={`/dashboard/exams/${examId}/settings/rooms`}><Settings size={19} />考试管理</Link></> : null}
            <Link href={`/dashboard/exams/${examId}/status`}><Eye size={19} />考试监考</Link>
          </> : <>
          <Link href={`/dashboard/exams/${examId}/problems`}><List size={19} />题目列表</Link>
          <Link href={`/dashboard/exams/${examId}/leaderboard`}><BarChart3 size={19} />排行榜</Link>
          {canManage ? <Link href={`/dashboard/exams/${examId}/code-check`}><CopyCheck size={19} />代码查重</Link> : null}
          {canManage ? <>{exam.contestRule === 'KS' ? <Link href={`/dashboard/exams/${examId}/grading`}><FileCheck size={19} />评卷</Link> : null}<Link href={`/dashboard/exams/${examId}/settings`}><Pencil size={19} />编辑考试</Link><Link href={`/dashboard/exams/${examId}/settings/problems`}><Settings size={19} />考试管理</Link></> : null}
          <Link href={`/dashboard/exams/${examId}/status`}><Eye size={19} />考试监考</Link>
          {canManage ? <><button disabled={exportingPapers} onClick={() => void exportPapers()}>{exportingPapers ? <LoaderCircle className="spin" size={19} /> : <FileText size={19} />}{exportingPapers ? '正在生成试卷…' : '导出试卷（PDF）'}</button><button disabled={exporting} onClick={() => void exportCodes()}>{exporting ? <LoaderCircle className="spin" size={19} /> : <Download size={19} />}导出所有代码</button><Link href={`/dashboard/exams/${examId}/submissions`}><Flag size={19} />所有递交</Link></> : null}
          </>}
        </nav>
        <dl className="exam-overview-facts">
          <div><dt>状态</dt><dd>{status.text}</dd></div><div><dt>{countdownTitle}</dt><dd>{countdownValue}</dd></div><div><dt>规则</dt><dd>{exam.platform === 'NOVAJUDGE' ? 'NovaJudge' : ruleLabels[exam.contestRule]}</dd></div>{exam.platform !== 'NOVAJUDGE' ? <div><dt>题目</dt><dd>{exam.problems.length}</dd></div> : null}<div><dt>开始于</dt><dd>{dateTime(exam.startAt)}</dd></div>{latestStartVisible ? <div><dt>最晚开始</dt><dd>{dateTime(exam.latestStartAt)}</dd></div> : null}<div><dt>结束于</dt><dd>{dateTime(exam.endAt)}</dd></div><div><dt>持续时间</dt><dd>{durationLabel(exam.durationMinutes)}</dd></div><div><dt>参与人数</dt><dd>{exam.participantCount}</dd></div>
        </dl>
      </aside>
    </div>
  </div>;
}
