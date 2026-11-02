'use client';

import './globals.css';
import { AppErrorView } from '@/components/AppErrorView';

export default function GlobalError({ retry }: { retry: () => void }) {
  return (
    <html lang="zh-CN">
      <body>
        <AppErrorView retry={retry} />
      </body>
    </html>
  );
}
