'use client';

import '@cwnupaa/proctor-shared/nova-theme.css';
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
