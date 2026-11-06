import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth';
import { LogoutButton } from '@/components/LogoutButton';
import { HydroNav } from '@/components/HydroNav';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const nav = [
    [
      '/dashboard/exams',
      '考试管理',
      '发布考试、选择题目和编辑考试信息'
    ] as const,
    ...(user.role === 'SUPER_ADMIN' ? [[
      '/dashboard/proctor-records',
      '监考记录',
      '管理监考记录'
    ] as const] : []),
    ['/dashboard/recordings', '历史录像', '管理历史录像'] as const,
    ...(user.role === 'SUPER_ADMIN' ? [['/dashboard/live', '直播管理', '管理外部直播接收与转发'] as const] : []),
    ...(user.role === 'SUPER_ADMIN' ? [[
      '/dashboard/problems',
      '题库管理',
      '实时查看和管理题目'
    ] as const] : []),
    ['/dashboard/users', '用户管理', '管理用户和权限'] as const,
    ['/dashboard/system', '系统设置', '配置系统信息'] as const
  ] as const;
  return (
    <div className="hydro-shell hydro-top-shell">
      <header className="hydro-header">
        <div className="hydro-header-inner">
          <Link className="hydro-logo" href="/dashboard/exams">
          <img src="/brand/logo.png" alt="西华师范大学 Logo" />
          <span><strong>程序设计算法协会</strong><small>线上考试与监考平台</small></span>
          </Link>
          <HydroNav items={nav} />
          <div className="hydro-user">
            <span className="hydro-avatar">{(user.nickname || user.username || user.numberId || 'A').slice(0, 1).toUpperCase()}</span>
            <span className="hydro-user-copy"><strong>{user.nickname || user.username || user.numberId}</strong><small>{user.role === 'SUPER_ADMIN' ? '超级管理员' : '管理员'}</small></span>
            <LogoutButton />
          </div>
        </div>
      </header>
      <main className="hydro-main">{children}</main>
    </div>
  );
}
