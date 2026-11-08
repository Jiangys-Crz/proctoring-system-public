'use client';
import { useEffect, useRef, useState } from 'react';
import { api } from './api';
type Settings = { enabled: boolean; role: 'PUBLIC' | 'LOCAL'; publicBaseUrl: string; publicApiKey: string; hasPublicApiKey?: boolean; lastSuccessAt?: string; lastError?: string; pendingCount?: number; pendingReasons?: { reason: string; count: number }[]; recentUploadErrors?: string[]; bankFileProgress?: { pendingProblems: number; checkedProblems: number; totalFiles: number; readyFiles: number } };
export function PlatformSyncSettings() {
  const [form, setForm] = useState<Settings>({ enabled: false, role: 'PUBLIC', publicBaseUrl: '', publicApiKey: '' });
  const [savedRole, setSavedRole] = useState<Settings['role']>('PUBLIC'), [revealedKey, setRevealedKey] = useState('');
  const [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const inFlight = useRef(false);
  useEffect(() => { api<Settings>('/api/settings/platform-sync').then(s => { setForm(s); setSavedRole(s.role); setLoaded(true); }).catch(e => setError(e.message)); }, []);
  useEffect(() => {
    if (!loaded) return;
    const controller = new AbortController(); let pending = false;
    const refresh = async () => {
      if (pending || document.hidden || inFlight.current) return;
      pending = true;
      try {
        const s = await api<Settings>('/api/settings/platform-sync', { signal: controller.signal, cache: 'no-store' });
        // Status polling must not replace an unsaved URL, role, key or switch.
        if (!controller.signal.aborted) setForm(previous => ({ ...previous, lastSuccessAt: s.lastSuccessAt, lastError: s.lastError, pendingCount: s.pendingCount, pendingReasons: s.pendingReasons, recentUploadErrors: s.recentUploadErrors, bankFileProgress: s.bankFileProgress }));
      } catch { /* Keep the last known status; the next poll retries. */ }
      finally { pending = false; }
    };
    const timer = setInterval(() => void refresh(), 15_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [loaded]);
  async function act(work: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(''); setMessage('');
    try { await work(); }
    catch (e) { setError(e instanceof Error ? e.message : '操作失败'); }
    finally { inFlight.current = false; setBusy(false); }
  }
  async function save() {
    await act(async () => {
      const settings = await api<Settings>('/api/settings/platform-sync', { method: 'PUT', body: JSON.stringify({ ...form, publicApiKey: form.role === 'LOCAL' ? form.publicApiKey : '' }) });
      setForm(previous => ({ ...previous, ...settings })); setSavedRole(settings.role); setRevealedKey('');
      setMessage(settings.enabled ? '已保存。内网将主动上传本机改动并拉取公网更新，断网后自动补传。' : '已保存，同步当前已暂停。');
    });
  }
  async function publicKey(action: 'generate' | 'reveal') {
    await act(async () => {
      const result = await api<{ apiKey: string; settings: Settings }>('/api/settings/platform-sync', { method: 'POST', body: JSON.stringify({ action }) });
      setRevealedKey(result.apiKey);
      if (action === 'generate') { setForm(previous => ({ ...previous, ...result.settings })); setSavedRole(result.settings.role); }
      setMessage(action === 'generate' ? '同步密钥已生成并保存，公网同步已启用。请将公网地址和此密钥填写到内网。' : '请复制此密钥到内网服务器的同步设置。');
    });
  }
  async function copy() {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(revealedKey);
      else { const input = document.createElement('textarea'); input.value = revealedKey; input.style.position = 'fixed'; input.style.left = '-10000px'; document.body.append(input); input.select(); const copied = document.execCommand('copy'); input.remove(); if (!copied) throw new Error(); }
      setMessage('密钥已复制，请填写到内网服务器。');
    } catch { setError('无法自动复制，请选中密钥后手动复制。'); }
  }
  return <section className="card form" style={{ gap: 16 }}><h2>公网与内网同步设置</h2>
    {error ? <p role="alert" className="exam-editor-error">{error}</p> : null}{message ? <p role="status">{message}</p> : null}
    <label>当前服务器版本<select disabled={!loaded || busy} value={form.role} onChange={e => { setForm({ ...form, role: e.target.value as Settings['role'], enabled: false, publicBaseUrl: '', publicApiKey: '', hasPublicApiKey: false }); setRevealedKey(''); setMessage('请先保存服务器版本，再配置同步。'); }}><option value="PUBLIC">公网版本</option><option value="LOCAL">内网版本</option></select></label>
    {form.role === 'PUBLIC' ? <div className="form" style={{ gap: 12 }}>
      {form.publicBaseUrl ? <p>公网地址：{form.publicBaseUrl}</p> : null}
      <div><button type="button" className="button secondary" disabled={!loaded || busy || savedRole !== 'PUBLIC'} onClick={() => void publicKey(form.hasPublicApiKey && form.enabled ? 'reveal' : 'generate')}>{form.hasPublicApiKey ? form.enabled ? '查看同步 API Key' : '启用并查看 API Key' : '生成并启用 API Key'}</button></div>
      {revealedKey ? <label>同步 API Key<input readOnly value={revealedKey} autoComplete="off" onFocus={e => e.currentTarget.select()} /><button type="button" className="button secondary" disabled={busy} onClick={() => void copy()}>复制密钥</button></label> : null}
    </div> : <div className="grid">
      <label>公网服务器地址<input disabled={!loaded || busy} type="url" value={form.publicBaseUrl} onChange={e => setForm({ ...form, publicBaseUrl: e.target.value })} placeholder="https://exam.example.com" /></label>
      <label>公网 API Key<input disabled={!loaded || busy} type="password" autoComplete="new-password" value={form.publicApiKey} placeholder={form.hasPublicApiKey ? '已保存，留空保留' : '填写公网生成的同步 API Key'} onChange={e => setForm({ ...form, publicApiKey: e.target.value })} /></label>
    </div>}
    <label className="exam-checkbox"><input disabled={!loaded || busy} type="checkbox" role="switch" className="settings-switch" checked={form.enabled} onChange={e => setForm({ ...form, enabled: e.target.checked })} /> 启用题库及考试同步</label>
    {form.lastError ? <p role="alert">{form.lastError}</p> : null}<p>待处理资料：{form.pendingCount || 0} 条。最近资料交换：{form.lastSuccessAt ? new Date(form.lastSuccessAt).toLocaleString('zh-CN') : '暂无'}</p>
    {form.pendingReasons?.length ? <ul>{form.pendingReasons.map((item, index) => <li key={`${index}:${item.reason}`}>{item.count} 条：{item.reason}</li>)}</ul> : null}
    {form.bankFileProgress?.pendingProblems ? <div role="status">
      {form.bankFileProgress.checkedProblems ? <p>已核对 {form.bankFileProgress.checkedProblems}/{form.bankFileProgress.pendingProblems} 道待处理题目；已到齐文件：{form.bankFileProgress.readyFiles}/{form.bankFileProgress.totalFiles} 个。</p>
        : <p>正在核对 {form.bankFileProgress.pendingProblems} 道待处理题目的文件清单…</p>}
      {form.bankFileProgress.totalFiles > 0 ? <progress aria-label="已核对题目的文件到齐进度" value={form.bankFileProgress.readyFiles} max={form.bankFileProgress.totalFiles} style={{ width: '100%' }} /> : null}
    </div> : null}
    {form.recentUploadErrors?.length ? <p role="alert">最近文件接收失败：{[...new Set(form.recentUploadErrors)].join('；')}</p> : null}
    <button type="button" className="button" disabled={!loaded || busy} onClick={() => void save()}>{busy ? '处理中…' : '保存同步设置'}</button>
  </section>;
}
