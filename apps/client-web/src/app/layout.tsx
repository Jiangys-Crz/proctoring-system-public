import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import 'katex/dist/katex.min.css';
import './globals.css';
import './hydro-theme.css';
import './novajudge-theme.css';

export const metadata: Metadata = {
  title: '考生第二机位 | 程序设计算法协会',
  description: '程序设计算法协会线上监考平台考生网页端'
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
  themeColor: '#edf0f2'
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
