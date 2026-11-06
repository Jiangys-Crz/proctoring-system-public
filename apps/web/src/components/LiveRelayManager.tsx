'use client';
import { useEffect, useState } from 'react';
import { Copy, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { api } from './api';
type State = { configured: boolean; onlineCount: number; registrationLimit: number; mediaError: string; streams: { id: string; name: string; enabled: boolean; online: boolean }[] };
type Key = { id: string; name: string; enabled: boolean; copyable: boolean };
export function LiveRelayManager() {
  const [state, setState] = useState<State | null>(null), [keys, setKeys] = useState<Key[]>([]), [keyId, setKeyId] = useState('');
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false), [reload, setReload] = useState(0);
  const [newId, setNewId] = useState('');
  useEffect(() => {
    const c = new AbortController(); let pending = false;
    const load = async () => {
      if (pending || document.hidden) return; pending = true;
      try { const next = await api<State>('/api/live-relay/streams', { signal: c.signal, cache: 'no-store' }); if (!c.signal.aborted) { setState(next); setError(''); } }
      catch(e) { if (!c.signal.aborted) setError(e instanceof Error ? e.message : '读取直播失败'); }
      finally { pending = false; }
    };
    void load(); const timer = setInterval(() => void load(), 5000);
    return () => { c.abort(); clearInterval(timer); };
  }, [reload]);
  useEffect(() => {
    const c = new AbortController();
    void api<Key[]>('/api/settings/live-api-keys', { signal: c.signal, cache: 'no-store' }).then(list => {
      if (c.signal.aborted) return; const enabled = list.filter(k => k.enabled && k.copyable); setKeys(enabled); setKeyId(enabled[0]?.id || '');
    }).catch(e => { if (!c.signal.aborted) setError(e.message); });
    return () => c.abort();
  }, [reload]);
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  async function createStream() {
    if (busy || !newId.trim()) return; setBusy(true); setError('');
    try {
      await api('/api/live-relay/streams', { method: 'POST', body: JSON.stringify({ id: newId.trim() }) });
      setNewId(''); setMessage('流 ID 已创建，可复制推流地址。一个 ID 同时只允许一台设备推流。'); setReload(n => n + 1);
    } catch(e) { setError(e instanceof Error ? e.message : '创建失败'); }
    finally { setBusy(false); }
  }
  async function archiveStream(id: string) {
    if (busy || !window.confirm('归档后将停止该直播，且此 ID 不能重新创建。确定归档？')) return;
    setBusy(true); setError('');
    try { await api('/api/live-relay/streams', { method: 'PATCH', body: JSON.stringify({ kind: 'stream', id, archived: true }) }); setMessage('已归档流 ID。'); }
    catch(e) { setError(e instanceof Error ? e.message : '归档失败'); }
    finally { setBusy(false); setReload(n => n + 1); }
  }
  async function copyUrl(id: string, publish = false) {
    if (busy || !keyId) return; setBusy(true); setMessage('');
    try {
      const { apiKey } = await api<{ apiKey: string }>('/api/settings/live-api-keys/reveal', { method: 'POST', body: JSON.stringify({ id: keyId }) });
      const path = publish ? '/api/live-relay/publish/' : '/api/live/';
      await navigator.clipboard.writeText(origin + path + encodeURIComponent(id) + '?apikey=' + encodeURIComponent(apiKey)); setMessage(publish ? '已复制 WHIP 推流地址。' : '已复制 WebRTC 播放 API 链接。');
    } catch(e) { setError(e instanceof Error ? e.message : '复制失败'); }
    finally { setBusy(false); }
  }
  return <div className="grid">
    <div className="topbar"><h1 style={{ margin: 0 }}>直播管理</h1><button className="button secondary" onClick={() => setReload(n => n + 1)}><RefreshCw size={16} />刷新</button></div>
    <section className="card form"><h2 style={{ margin: 0 }}>正在推流：{state && !state.mediaError ? state.onlineCount : '—'} 路</h2>
      <p className="muted">WebRTC 推流和播放统一使用<Link href="/dashboard/system">系统设置</Link>中的全局直播 API-KEY。监考画面由各端独立管理。</p>
      {error ? <p role="alert">{error}</p> : null}{message ? <p role="status">{message}</p> : null}
      {state && !state.configured ? <p>独立 WebRTC 转发服务尚未启用。</p> : null}
      {state?.mediaError ? <p role="alert">{state.mediaError}，暂时无法统计。</p> : null}
      {keys.length ? <label>复制链接使用的系统密钥<select value={keyId} onChange={e => setKeyId(e.target.value)}>{keys.map(k => <option key={k.id} value={k.id}>{k.name}</option>)}</select></label> : <p className="muted">若需复制包含密钥的完整链接，请先在系统设置生成支持重复复制的直播密钥。</p>}
      <form onSubmit={e => { e.preventDefault(); void createStream(); }} className="form">
        <label>新建流 ID<input required maxLength={64} pattern={'[A-Za-z0-9_\\-]+'} value={newId} onChange={e => setNewId(e.target.value)} placeholder="例如：camera-1" /></label>
        <small className="muted">仅支持字母、数字、下划线和连字符，区分大小写。</small>
        <button className="button" disabled={busy || !state?.configured || !newId.trim()}>新建流 ID</button>
      </form>
      <p className="muted">先创建 ID 才能推流。同一 ID 同时仅允许一个设备连接，其他设备会被拒绝，不能替换原设备。已登记 {state?.streams.length ?? 0}/{state?.registrationLimit ?? '—'} 路。</p>
    </section>
    {state?.streams.map(s => <section className="card form" key={s.id}>
      <strong>流 ID：{s.id} · {state.mediaError ? '状态未知' : s.online ? '正在推流' : '等待推流'}</strong>
      <label>WHIP 推流地址<input readOnly value={origin + '/api/live-relay/publish/' + encodeURIComponent(s.id) + '?apikey=系统API-KEY'} /></label>
      <label>播放 API 链接<input readOnly value={origin + '/api/live/' + encodeURIComponent(s.id) + '?apikey=系统API-KEY'} /></label>
      <div className="exam-list-actions"><button className="button secondary" disabled={busy || !keyId} onClick={() => void copyUrl(s.id)}><Copy size={16} />复制播放链接</button><button className="button secondary" disabled={busy || !keyId} onClick={() => void copyUrl(s.id, true)}>复制推流地址</button></div>
      <button className="button secondary" disabled={busy} onClick={() => void archiveStream(s.id)}>归档流 ID</button>
    </section>)}
  </div>;
}
