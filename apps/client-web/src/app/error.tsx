'use client';
export default function Error({ retry }: { retry: () => void }) {
  return <main style={{ padding: '60px 24px', textAlign: 'center' }}><h1>页面暂时无法加载</h1><p>请检查连接后重试。</p><button onClick={retry}>重试</button></main>;
}
