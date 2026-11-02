'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowRight, CalendarDays, Clock3, LoaderCircle, Plus, RefreshCw, Trophy, Users } from 'lucide-react';
import { api } from './api';

interface ExamSummary {
  platform: 'HYDRO' | 'NOVAJUDGE'; id: string; examCode: string; name: string; startAt: string; durationMinutes: number;
  contestRule: 'GPLT' | 'XCPC' | 'LANQIAO' | 'ACM' | 'OI' | 'IOI' | 'KS'; canManage: boolean;
  _count?: { candidates: number };
}
const ruleLabels = { GPLT: 'GPLT', XCPC: 'XCPC', LANQIAO: 'LANQIAO', ACM: 'XCPC', OI: 'OI', IOI: 'IOI', KS: 'KS' };
function durationLabel(minutes: number) {
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return [hours ? `${hours} 小时` : '', rest ? `${rest} 分钟` : ''].filter(Boolean).join(' ') || '0 分钟';
}
export function ExamsPageClient({ role }: { role: 'ADMIN' | 'SUPER_ADMIN' }) {
  const [exams, setExams] = useState<ExamSummary[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  async function load() {
    setLoading(true); setError('');
    try { setExams(await api<ExamSummary[]>('/api/exams')); }
    catch (err) { setError(err instanceof Error ? err.message : '加载失败'); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  const visibleExams = [...exams].sort((a, b) => +new Date(a.startAt) - +new Date(b.startAt));
  return <div className="grid exam-publish-page">
    <div className="topbar"><h1 style={{ margin: 0 }}>考试管理</h1><div className="exam-list-actions"><button className="button secondary" disabled={loading} onClick={() => void load()}><RefreshCw size={16} className={loading ? 'spin' : ''} />{loading ? '刷新中' : '刷新'}</button>{role === 'SUPER_ADMIN' ? <Link className="button" href="/dashboard/exams/new"><Plus size={17} /> 发布考试</Link> : null}</div></div>
    {error ? <div className="exam-editor-error" role="alert">{error}</div> : null}
    <div className="exam-publish-list">{visibleExams.map(exam => <article className="exam-publish-item" key={exam.id}><Link className="exam-publish-main-link" href={`/dashboard/exams/${exam.id}`}><div className="exam-publish-content"><h2>{exam.name}</h2><div className="exam-publish-meta"><span title="考试编号">#{exam.examCode}</span><span className="exam-rule-badge"><Trophy size={17} />{exam.platform === 'NOVAJUDGE' ? 'NovaJudge' : ruleLabels[exam.contestRule]}</span><span title="开始时间"><CalendarDays size={17} /><time dateTime={exam.startAt}>{new Date(exam.startAt).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}</time></span><span title="考试时长"><Clock3 size={17} />{durationLabel(exam.durationMinutes)}</span><span title="参与人数"><Users size={17} />{exam._count?.candidates || 0} 人</span></div></div><span className="exam-publish-open">查看详情 <ArrowRight size={17} /></span></Link></article>)}{!visibleExams.length ? <div className="exam-list-empty">{loading ? <><LoaderCircle className="spin" size={20} /> 正在加载考试…</> : '暂无考试'}</div> : null}</div>
  </div>;
}
