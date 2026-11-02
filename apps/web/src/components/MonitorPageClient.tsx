'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, CalendarDays, Clock3, Eye, LoaderCircle, RefreshCw, Trophy, Users } from 'lucide-react';
import { api } from './api';

type ExamSummary = {
  id: string;
  examCode: string;
  name: string;
  startAt: string;
  latestStartAt: string;
  endAt: string;
  durationMinutes: number;
  contestType: 'INDIVIDUAL' | 'TEAM';
  contestRule: 'GPLT' | 'XCPC' | 'LANQIAO' | 'ACM' | 'OI' | 'IOI' | 'KS';
  published: boolean;
  problems?: Array<{ id: string }>;
  _count?: { candidates: number; loginRequests: number; alerts: number };
};

const ruleLabels = { GPLT: 'GPLT', XCPC: 'XCPC', LANQIAO: 'LANQIAO', ACM: 'XCPC', OI: 'OI', IOI: 'IOI', KS: 'KS' };
function durationLabel(minutes: number) {
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return [hours ? `${hours} 小时` : '', rest ? `${rest} 分钟` : ''].filter(Boolean).join(' ') || '0 分钟';
}
function phase(exam: ExamSummary, now: number) {
  const start = new Date(exam.startAt).getTime();
  const end = new Date(exam.endAt).getTime();
  return now >= start && now <= end ? 'running' : 'upcoming';
}

export function MonitorPageClient() {
  const [exams, setExams] = useState<ExamSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());

  async function load() {
    setLoading(true);
    setError('');
    try { setExams(await api<ExamSummary[]>('/api/exams')); }
    catch (err) { setError(err instanceof Error ? err.message : '监考考试加载失败'); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); const timer = window.setInterval(() => setNow(Date.now()), 30_000); return () => window.clearInterval(timer); }, []);

  const activeExams = useMemo(() => exams
    .filter((exam) => new Date(exam.endAt).getTime() > now)
    .sort((a, b) => {
      const phaseDiff = (phase(a, now) === 'running' ? 0 : 1) - (phase(b, now) === 'running' ? 0 : 1);
      if (phaseDiff) return phaseDiff;
      return phase(a, now) === 'running'
        ? new Date(a.endAt).getTime() - new Date(b.endAt).getTime()
        : new Date(a.startAt).getTime() - new Date(b.startAt).getTime();
    }), [exams, now]);

  return <div className="grid monitor-list-page">
    <div className="topbar">
      <div><h1 style={{ margin: 0 }}>考试监考</h1></div>
      <button className="button secondary" onClick={() => void load()} disabled={loading}><RefreshCw size={18} /> {loading ? '刷新中' : '刷新'}</button>
    </div>
    {error ? <div className="card problem-error">{error}</div> : null}
    <div className="exam-publish-list">{activeExams.map(exam => <article className="exam-publish-item" key={exam.id}><Link className="exam-publish-main-link" href={`/dashboard/exams/${exam.id}/status`}><div className="exam-publish-content"><h2>{exam.name}</h2><div className="exam-publish-meta"><span title="考试编号">#{exam.examCode}</span><span className="exam-rule-badge"><Trophy size={17} />{ruleLabels[exam.contestRule]}</span><span title="开始时间"><CalendarDays size={17} /><time dateTime={exam.startAt}>{new Date(exam.startAt).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}</time></span><span title="考试时长"><Clock3 size={17} />{durationLabel(exam.durationMinutes)}</span><span title="参与人数"><Users size={17} />{exam._count?.candidates || 0} 人</span></div></div><span className="exam-publish-open">查看监考详情 <ArrowRight size={17} /></span></Link></article>)}{!activeExams.length ? <div className="exam-list-empty">{loading ? <><LoaderCircle className="spin" size={20} /> 正在加载考试…</> : <><Eye size={20} /> 暂无未结束的考试</>}</div> : null}</div>
  </div>;
}
