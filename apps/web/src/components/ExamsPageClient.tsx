'use client';

import type { ExamPlatform } from '@cwnupaa/proctor-shared';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowRight, CalendarDays, Clock3, LoaderCircle, Plus, RefreshCw, Search, Users } from 'lucide-react';
import { api } from './api';
import { compareExamStart } from '@/lib/exam-list-order';

interface ExamSummary {
  platform: ExamPlatform; id: string; examCode: string; name: string; startAt: string; endAt: string; durationMinutes: number;
  contestRule: 'GPLT' | 'XCPC' | 'LANQIAO' | 'ACM' | 'OI' | 'IOI' | 'KS'; canManage: boolean;
  _count?: { candidates: number };
}
const ruleLabels = { GPLT: 'GPLT', XCPC: 'XCPC', LANQIAO: 'LANQIAO', ACM: 'XCPC', OI: 'OI', IOI: 'IOI', KS: 'KS' };
const rules = [...new Set(Object.values(ruleLabels))];
const platformLabels = { HYDRO: 'Hydro', NOVAJUDGE: 'NovaJudge', HYDRO_BROWSER: 'HydroOJ 浏览器' };
const statusLabels = { upcoming: '未开始', ongoing: '进行中', ended: '已结束' };
type ExamStatus = keyof typeof statusLabels;

function examStatus(exam: ExamSummary, now: number): ExamStatus {
  if (+new Date(exam.endAt) <= now) return 'ended';
  return +new Date(exam.startAt) <= now ? 'ongoing' : 'upcoming';
}

function durationLabel(minutes: number) {
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return [hours ? `${hours} 小时` : '', rest ? `${rest} 分钟` : ''].filter(Boolean).join(' ') || '0 分钟';
}
export function ExamsPageClient({ role }: { role: 'ADMIN' | 'SUPER_ADMIN' }) {
  const [exams, setExams] = useState<ExamSummary[]>([]);
  const [query, setQuery] = useState('');
  const [rule, setRule] = useState('');
  const [platform, setPlatform] = useState('');
  const [status, setStatus] = useState<ExamStatus | ''>('');
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  async function load() {
    setLoading(true); setError('');
    try { setExams(await api<ExamSummary[]>('/api/exams')); setNow(Date.now()); }
    catch (err) { setError(err instanceof Error ? err.message : '加载失败'); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(timer); }, []);
  const keyword = query.trim().toLocaleLowerCase();
  const visibleExams = exams.filter(exam => (!rule || ruleLabels[exam.contestRule] === rule)
    && (!platform || exam.platform === platform)
    && (!status || examStatus(exam, now) === status)
    && exam.name.toLocaleLowerCase().includes(keyword)
  ).sort((a, b) => compareExamStart(a, b, now));

  return <div className="grid management-page exam-publish-page">
    <div className="card management-toolbar">
      <div className="exam-list-filters">
        <select aria-label="考试类型" value={rule} onChange={event => setRule(event.target.value)}>
          <option value="">全部类型</option>
          {rules.map(value => <option key={value}>{value}</option>)}
        </select>
        <select aria-label="考试平台" value={platform} onChange={event => setPlatform(event.target.value)}>
          <option value="">全部平台</option>
          {Object.entries(platformLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </div>
      <div className="exam-status-filters" role="group" aria-label="考试状态">
        <button type="button" aria-pressed={status === ''} onClick={() => setStatus('')}>全部</button>
        {(Object.keys(statusLabels) as ExamStatus[]).map(value => (
          <button type="button" key={value} aria-pressed={status === value} onClick={() => setStatus(value)}>{statusLabels[value]}</button>
        ))}
      </div>
      <div className="management-search">
        <Search size={17} aria-hidden="true" />
        <input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索考试名称" aria-label="搜索考试名称" />
      </div>
      <div className="management-actions">
        <button className="button secondary" disabled={loading} onClick={() => void load()}><RefreshCw size={16} className={loading ? 'spin' : ''} />{loading ? '刷新中' : '刷新'}</button>
        {role === 'SUPER_ADMIN' ? <Link className="button" href="/dashboard/exams/new"><Plus size={17} />添加考试</Link> : null}
      </div>
    </div>
    {error ? <div className="exam-editor-error" role="alert">{error}</div> : null}
    <div className="exam-publish-list">
      {visibleExams.map(exam => {
        const currentStatus = examStatus(exam, now);
        return <article className="exam-publish-item" key={exam.id}>
          <Link className="exam-publish-main-link" href={`/dashboard/exams/${exam.id}`}>
            <div className="exam-publish-content">
              <div className="exam-list-title"><h2>{exam.name}</h2><span className="management-badge" data-status={currentStatus}>{statusLabels[currentStatus]}</span></div>
              <div className="exam-publish-meta">
                <span title="考试编号">#{exam.examCode}</span>
                <span className="management-badge" data-status="info">{ruleLabels[exam.contestRule]}</span>
                <span>{platformLabels[exam.platform]}</span>
                <span title="开始时间"><CalendarDays size={16} /><time dateTime={exam.startAt}>{new Date(exam.startAt).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}</time></span>
                <span title="考试时长"><Clock3 size={16} />{durationLabel(exam.durationMinutes)}</span>
                <span title="参与人数"><Users size={16} />{exam._count?.candidates || 0} 人</span>
              </div>
            </div>
            <span className="exam-publish-open">查看详情 <ArrowRight size={17} /></span>
          </Link>
        </article>;
      })}
      {!visibleExams.length ? <div className="exam-list-empty" role="status">{loading ? <><LoaderCircle className="spin" size={20} /> 正在加载考试…</> : error ? '暂时无法加载考试' : keyword || rule || platform || status ? '没有匹配的考试' : '暂无考试'}</div> : null}
    </div>
  </div>;
}
