import type { Metadata } from 'next';
import ContestApp from '@/components/ContestApp';

export const metadata: Metadata = {
  title: '比赛答题 | 程序设计算法协会',
  description: '在线考试答题页面，支持查看题目、提交答案和查看测评结果'
};

export default function ContestPage() {
  return (
    <ContestApp
      configuredApiBase={process.env.NEXT_PUBLIC_PROCTOR_API_BASE || ''}
      allowMock={process.env.NEXT_PUBLIC_PROCTOR_CONTEST_MOCK === '1'}
    />
  );
}
