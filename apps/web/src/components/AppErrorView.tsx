'use client';

import { usePathname, useRouter } from 'next/navigation';
import { parentRoutePath } from '@cwnupaa/proctor-shared';

export function AppErrorView({ retry }: { retry?: () => void; code?: string }) {
  const router = useRouter();
  const pathname = usePathname();

  return (
    <main className="error-page">
      <section className="error-panel">
        <h1>页面暂时无法加载</h1><p>请稍后重试，或返回主页。</p>
        <div className="error-actions">
          {retry ? <button className="button" onClick={retry}>重试</button> : null}
          <button className="button" onClick={() => router.push('/')}>返回主页</button>
          <button className="button secondary" onClick={() => router.push(parentRoutePath(pathname || '/'))}>返回上级</button>
        </div>
      </section>
    </main>
  );
}
