'use client';

import Link from 'next/link';

export function AppErrorView({ retry }: { retry?: () => void; code?: string }) {
  return (
    <main className="error-page">
      <section className="error-panel">
        <h1>页面暂时无法加载</h1>
        <div className="error-actions">
          {retry ? <button className="button" onClick={retry}>重试</button> : null}
          <Link className="button secondary" href="/">首页</Link>
        </div>
      </section>
    </main>
  );
}
