'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Monitor, Radio, TvMinimal } from 'lucide-react';
import styles from './ContestLiveAdmin.module.css';

export function LiveManagementNav({ canManageRelay }: { canManageRelay: boolean }) {
  const pathname = usePathname();
  const isContests = pathname.startsWith('/dashboard/live/contests');
  const isDisplays = pathname.startsWith('/dashboard/live/displays');

  return <nav aria-label="XCPC 工具" className={`card ${styles.navigation}`}>
    {canManageRelay && <Link href="/dashboard/live" aria-current={isContests || isDisplays ? undefined : 'page'}><Radio size={17} aria-hidden="true" />推流管理</Link>}
    <Link href="/dashboard/live/contests" aria-current={isContests ? 'page' : undefined}><TvMinimal size={17} aria-hidden="true" />赛事直播</Link>
    <Link href="/dashboard/live/displays" aria-current={isDisplays ? 'page' : undefined}><Monitor size={17} aria-hidden="true" />大屏管理</Link>
  </nav>;
}
