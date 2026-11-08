import '@cwnupaa/proctor-shared/nova-theme.css';
import './globals.css';
import './hydro-theme.css';
import './dashboard-theme.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'CWNU PAA 线上监考平台',
  description: '算法竞赛线上监考系统'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
