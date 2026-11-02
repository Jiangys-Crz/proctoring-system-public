'use client';
import { useEffect, useState } from 'react';
import { api } from './api';
export function FileCleanupStatus({ kind, revision }: { kind: 'MEDIA' | 'INSTALLER'; revision: number }) {
  const [status, setStatus] = useState({ pending: 0, failed: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false, running = false;
    const load = async () => {
      if (running) return;
      running = true;
      try { const data = await api<typeof status>(`/api/file-cleanup?kind=${kind}`); if (!cancelled) { setStatus(data); setError(''); } }
      catch (error) { if (!cancelled) setError(error instanceof Error ? error.message : '文件清理状态读取失败'); }
      finally { running = false; }
    };
    void load();
    const timer = window.setInterval(() => void load(), 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [kind, revision]);
  async function retry() {
    setBusy(true);
    try { await api('/api/file-cleanup', { method: 'POST', body: JSON.stringify({ kind }) }); setError(''); }
    catch (error) { setError(error instanceof Error ? error.message : '重试失败'); }
    finally { setBusy(false); }
  }
  if (!status.pending && !error) return null;
  return <div className="card" role="status">
    {status.pending > 0 && <span>正在清理 {status.pending} 个文件。{status.failed > 0 ? `其中 ${status.failed} 个文件清理失败，系统会自动重试。` : '清理完成后释放存储空间。'}</span>}
    {status.failed > 0 && <button className="button secondary compact-button" disabled={busy} onClick={() => void retry()}>{busy ? '安排重试中…' : '重试文件清理'}</button>}
    {error && <span style={{ color: 'var(--danger)' }}>{error}</span>}
  </div>;
}
