'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ArrowRight, CalendarDays, RefreshCw, Search, Users } from 'lucide-react';

type Exam = {
  id: string;
  name: string;
  examCode: string;
  platform: 'HYDRO' | 'HYDRO_BROWSER' | 'NOVAJUDGE';
  startAt: string;
  _count: { candidates: number };
};

const platformLabel = { HYDRO: '本机 XCPC', HYDRO_BROWSER: 'HydroOJ 浏览器', NOVAJUDGE: 'NovaJudge' };

export function ContestLiveExamList({ exams, mode }: { exams: Exam[]; mode: 'contests' | 'displays' }) {
  const [query, setQuery] = useState('');
  const [refreshing, startTransition] = useTransition();
  const router = useRouter();

  const keyword = query.trim().toLowerCase();
  const visibleExams = exams.filter(exam => [exam.name, exam.examCode, platformLabel[exam.platform]].some(value => value.toLowerCase().includes(keyword)));

  return <section className="grid management-page exam-publish-page" aria-label={mode === 'displays' ? '可管理大屏的考试' : '可直播的考试'}>
    <div className="card management-toolbar">
      <div className="management-search">
        <Search size={17} aria-hidden="true" />
        <input type="search" aria-label="搜索考试" placeholder="搜索名称、编号或平台" value={query} onChange={event => setQuery(event.target.value)} />
      </div>
      <div className="management-actions">
        <button className="button secondary" type="button" disabled={refreshing} onClick={() => startTransition(() => router.refresh())}><RefreshCw size={16} className={refreshing ? 'spin' : undefined} aria-hidden="true" />刷新</button>
      </div>
    </div>
    {visibleExams.length === 0 && <div className="card">{keyword ? '没有匹配的考试。' : '暂无可管理的考试。'}</div>}
    <div className="exam-publish-list">
      {visibleExams.map(exam => <article className="exam-publish-item" key={exam.id}>
        <Link className="exam-publish-main-link" href={`/dashboard/live/${mode}/${encodeURIComponent(exam.id)}`}>
          <div className="exam-publish-content">
            <div className="exam-list-title"><h2>{exam.name}</h2></div>
            <div className="exam-publish-meta">
              <span>#{exam.examCode}</span>
              <span>{platformLabel[exam.platform]}</span>
              <span><CalendarDays size={16} aria-hidden="true" /><time dateTime={exam.startAt}>{new Date(exam.startAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}</time></span>
              <span><Users size={16} aria-hidden="true" />{exam._count.candidates} 位考生</span>
            </div>
          </div>
          <span className="exam-publish-open">{mode === 'displays' ? '管理大屏' : '进入导播'} <ArrowRight size={17} aria-hidden="true" /></span>
        </Link>
      </article>)}
    </div>
  </section>;
}
