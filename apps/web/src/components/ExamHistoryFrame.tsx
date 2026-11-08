import type { ReactNode } from 'react';
import Link from 'next/link';

export function ExamHistoryFrame({ examId, current, canViewProctorRecords, children }: {
  examId: string;
  current: 'proctor-records' | 'recordings';
  canViewProctorRecords: boolean;
  children: ReactNode;
}) {
  const base = `/dashboard/exams/${encodeURIComponent(examId)}`;
  return <div className="grid">
    <nav className="subnav card" aria-label="考试记录导航">
      {canViewProctorRecords ? <Link className={`button${current === 'proctor-records' ? '' : ' secondary'}`} aria-current={current === 'proctor-records' ? 'page' : undefined} href={`${base}/proctor-records`}>监考记录</Link> : null}
      <Link className={`button${current === 'recordings' ? '' : ' secondary'}`} aria-current={current === 'recordings' ? 'page' : undefined} href={`${base}/recordings`}>历史录像</Link>
    </nav>
    {children}
  </div>;
}
