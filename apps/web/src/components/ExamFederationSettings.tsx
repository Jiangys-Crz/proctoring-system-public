'use client';
import { useEffect, useState } from 'react';
import { api } from './api';
type State = { managedGlobally: boolean; enabled: boolean };
export function ExamFederationSettings({ examId }: { examId: string }) {
  const [state,setState] = useState<State | null>(null), [busy,setBusy] = useState(false), [error,setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void api<State>(`/api/exams/${examId}/federation`, { signal: controller.signal, cache: 'no-store' })
      .then(value => { if (!controller.signal.aborted) setState(value); })
      .catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [examId]);
  async function toggle(enabled: boolean) {
    setBusy(true); setError('');
    try { setState(await api<State>(`/api/exams/${examId}/federation`, { method: 'POST', body: JSON.stringify({ action: 'toggle', enabled }) })); }
    catch (e) { setError(e instanceof Error ? e.message : '保存失败'); } finally { setBusy(false); }
  }
  return <>
    <label className="exam-checkbox"><input type="checkbox" role="switch" className="settings-switch" disabled={!state || busy} checked={Boolean(state?.enabled && state.managedGlobally)} onChange={e => void toggle(e.target.checked)} /> 跨网同步</label>
    {error ? <p role="alert" className="exam-editor-error">{error}</p> : null}
  </>;
}
