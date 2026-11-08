'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from './api';
export function ImportPublicExam({ onPublish }: { onPublish: () => void }) {
  const router = useRouter(); const [link,setLink] = useState(''), [busy,setBusy] = useState(false), [error,setError] = useState('');
  async function submit() {
    setBusy(true); setError('');
    try { const exam = await api<{ id: string }>('/api/exams/import-public', { method: 'POST', timeoutMs: 600000, body: JSON.stringify({ link }) }); router.push(`/dashboard/exams/${exam.id}`); }
    catch (e) { setError(e instanceof Error ? e.message : '导入失败'); } finally { setBusy(false); }
  }
  return <section className="card form"><div className="exam-editor-heading"><h2>导入公网考试</h2><button type="button" className="button secondary" disabled={busy} onClick={onPublish}>发布新考试</button></div><p>复制已开启同步的公网考试详情链接，导入后两端的修改自动同步。连接信息使用系统设置。</p><label>公网考试链接<input type="url" value={link} onChange={e => setLink(e.target.value)} placeholder="https://exam.example.com/dashboard/exams/…" /></label>{error ? <p role="alert" className="exam-editor-error">{error}</p> : null}<button className="button" disabled={busy || !link.trim()} onClick={() => void submit()}>{busy ? '导入中…' : '导入考试'}</button></section>;
}
