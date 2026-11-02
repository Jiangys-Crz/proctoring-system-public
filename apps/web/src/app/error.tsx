'use client';

import { AppErrorView } from '@/components/AppErrorView';

export default function Error({ retry }: { retry: () => void }) {
  return <AppErrorView retry={retry} />;
}
