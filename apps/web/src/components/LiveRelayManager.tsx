'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Archive, CircleCheck, Copy, LoaderCircle, Plus, Radio, RefreshCw, Search, X } from 'lucide-react';
import { api } from './api';

type Stream = { id: string; name: string; enabled: boolean; online: boolean };
type State = { configured: boolean; rtmpBase: string; rtmpsBase: string; onlineCount: number; registrationLimit: number; mediaError: string; streams: Stream[] };
type Key = { id: string; name: string; enabled: boolean; copyable: boolean };
type LinkKind = 'read' | 'whip' | 'rtmp-key';

const linkFields = [
  { kind: 'whip', label: 'WHIP 推流地址' },
  { kind: 'rtmp-key', label: 'RTMP / RTMPS 流密钥' },
  { kind: 'read', label: '播放 API 链接' },
] as const;

function streamLink(origin: string, id: string, kind: LinkKind, key: string) {
  const query = '?apikey=' + key;
  if (kind === 'rtmp-key') return id + query;
  const path = kind === 'whip' ? '/api/live-relay/publish/' : '/api/live/';
  return origin + path + encodeURIComponent(id) + query;
}

export function LiveRelayManager() {
  const [state, setState] = useState<State | null>(null);
  const [keys, setKeys] = useState<Key[]>([]);
  const [keyId, setKeyId] = useState('');
  const [query, setQuery] = useState('');
  const [loadError, setLoadError] = useState('');
  const [keysError, setKeysError] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState<{ text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [newId, setNewId] = useState('');
  const [newKeyId, setNewKeyId] = useState('');
  const [createError, setCreateError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 2800);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    const load = async () => {
      if (pending || document.hidden) return;
      pending = true;
      try {
        const next = await api<State>('/api/live-relay/streams', { signal: controller.signal, cache: 'no-store' });
        if (!controller.signal.aborted) { setState(next); setLoadError(''); }
      } catch (error) {
        if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : '读取直播失败');
      } finally {
        pending = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [reload]);

  useEffect(() => {
    const controller = new AbortController();
    void api<Key[]>('/api/settings/live-api-keys', { signal: controller.signal, cache: 'no-store' }).then(list => {
      if (controller.signal.aborted) return;
      setKeys(list.filter(key => key.enabled && key.copyable));
      setKeysError('');
    }).catch(error => {
      if (!controller.signal.aborted) setKeysError(error instanceof Error ? error.message : '读取系统密钥失败');
    });
    return () => controller.abort();
  }, [reload]);

  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const copyKey = keys.find(key => key.id === keyId) || keys[0];
  const formKey = keys.find(key => key.id === newKeyId) || copyKey;
  const keyword = query.trim().toLocaleLowerCase();
  const visibleStreams = state?.streams.filter(stream => stream.id.toLocaleLowerCase().includes(keyword)) ?? [];

  function openCreateDialog() {
    setNewId('');
    setNewKeyId(copyKey?.id || '');
    setCreateError('');
    dialog.current?.showModal();
  }

  async function createStream() {
    if (busy || !state?.configured || !newId.trim()) return;
    setBusy(true);
    setCreateError('');
    setActionError('');
    setNotice(null);
    try {
      await api('/api/live-relay/streams', { method: 'POST', body: JSON.stringify({ id: newId.trim() }) });
      setKeyId(formKey?.id || '');
      dialog.current?.close();
      setNotice({ text: '流 ID 已创建，可复制推流地址。' });
      setReload(n => n + 1);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : '创建失败');
    } finally {
      setBusy(false);
    }
  }

  async function archiveStream(id: string) {
    if (busy || !window.confirm('归档后将停止该直播，且此 ID 不能重新创建。确定归档？')) return;
    setBusy(true);
    setActionError('');
    setNotice(null);
    try {
      await api('/api/live-relay/streams', { method: 'PATCH', body: JSON.stringify({ kind: 'stream', id, archived: true }) });
      setNotice({ text: '已归档流 ID。' });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '归档失败');
    } finally {
      setBusy(false);
      setReload(n => n + 1);
    }
  }

  async function copyUrl(id: string, kind: LinkKind, label: string) {
    if (busy || !copyKey) return;
    setBusy(true);
    setActionError('');
    setNotice(null);
    try {
      const { apiKey } = await api<{ apiKey: string }>('/api/settings/live-api-keys/reveal', { method: 'POST', body: JSON.stringify({ id: copyKey.id }) });
      await navigator.clipboard.writeText(streamLink(origin, id, kind, encodeURIComponent(apiKey)));
      setNotice({ text: `已复制${label}。` });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '复制失败');
    } finally {
      setBusy(false);
    }
  }

  return <div className="grid management-page">
    <div className="card management-toolbar live-relay-toolbar">
      <div className="management-search">
        <Search size={17} aria-hidden="true" />
        <input type="search" aria-label="搜索流 ID" placeholder="搜索流 ID" value={query} onChange={event => setQuery(event.target.value)} />
      </div>
      <div className="management-actions">
        <button type="button" className="button" aria-haspopup="dialog" disabled={!state?.configured || busy} onClick={openCreateDialog}><Plus size={17} />新建流</button>
        <button type="button" className="button secondary" disabled={busy} onClick={() => setReload(n => n + 1)}><RefreshCw size={16} />刷新</button>
      </div>
    </div>

    <section className="card live-relay-summary" aria-label="直播流概况">
      <div className="live-relay-summary-metrics">
        <span><Radio size={17} />正在推流 <strong>{state?.configured && !state.mediaError ? state.onlineCount : '—'}</strong> 路</span>
        <span>已登记 <strong>{state ? `${state.streams.length}/${state.registrationLimit}` : '—'}</strong> 路</span>
        {copyKey ? <span>复制链接使用 <strong>{copyKey.name}</strong></span> : null}
      </div>
      {state && !state.configured ? <p>直播转发尚未启用。</p> : null}
      {state?.mediaError ? <p role="alert">{state.mediaError}，暂时无法统计。</p> : null}
      {state && !keysError && !copyKey ? <p>请在<Link href="/dashboard/system">系统设置</Link>中启用可复制的直播密钥，以复制完整链接。</p> : null}
    </section>

    {[loadError, keysError, actionError].filter(Boolean).map((error, index) => <div key={index} className="management-notice" role="alert">{error}</div>)}
    <div className="management-toast" role="status">
      {notice ? <div className="management-notice"><CircleCheck size={17} aria-hidden="true" />{notice.text}</div> : null}
    </div>

    {state && visibleStreams.length ? <div className="live-relay-grid">
      {visibleStreams.map(stream => {
        const status = !stream.enabled ? 'ended' : state.mediaError ? 'unknown' : stream.online ? 'ongoing' : 'idle';
        const statusLabel = { ended: '已停用', unknown: '状态未知', ongoing: '正在推流', idle: '等待推流' }[status];
        return <section className="card form live-relay-card" key={stream.id}>
          <header className="live-relay-card-header">
            <span className="live-relay-card-icon"><Radio size={20} aria-hidden="true" /></span>
            <div><small>流 ID</small><h2>{stream.id}</h2></div>
            <span className="management-badge" data-status={status}>{statusLabel}</span>
          </header>
          <div className="live-relay-servers">
            <label>RTMP 服务器<input readOnly value={state.rtmpBase} /></label>
            {state.rtmpsBase ? <label>RTMPS 服务器<input readOnly value={state.rtmpsBase} /></label> : null}
          </div>
          {linkFields.map(({ kind, label }) => <div className="live-relay-address" key={kind}>
            <label>{label}<input readOnly value={streamLink(origin, stream.id, kind, '系统API-KEY')} /></label>
            <button type="button" className="button secondary" aria-label={`复制${label}`} disabled={busy || !copyKey} onClick={() => void copyUrl(stream.id, kind, label)}><Copy size={15} />复制</button>
          </div>)}
          <footer className="live-relay-card-footer">
            <button type="button" className="button secondary" disabled={busy} onClick={() => void archiveStream(stream.id)}><Archive size={15} />归档流 ID</button>
          </footer>
        </section>;
      })}
    </div> : <div className="card management-empty" role="status">
      {!state && !loadError ? <><LoaderCircle className="spin" size={20} />正在加载直播流…</>
        : <><Radio size={22} />{!state ? '暂时无法加载直播流' : keyword ? '没有匹配的直播流' : '暂无直播流'}</>}
    </div>}

    <dialog ref={dialog} className="modal-panel live-relay-dialog" aria-labelledby="live-relay-create-title" onCancel={event => { if (busy) event.preventDefault(); }}>
      <form className="form" onSubmit={event => { event.preventDefault(); void createStream(); }}>
        <div className="modal-title">
          <h2 id="live-relay-create-title">新建流</h2>
          <button type="button" className="button secondary icon-button" aria-label="关闭新建流" disabled={busy} onClick={() => dialog.current?.close()}><X size={18} /></button>
        </div>
        <label>系统密钥
          <select value={formKey?.id || ''} disabled={busy || !keys.length} onChange={event => setNewKeyId(event.target.value)}>
            {!keys.length ? <option value="">暂无可用密钥</option> : keys.map(key => <option key={key.id} value={key.id}>{key.name}</option>)}
          </select>
        </label>
        <small>{keys.length ? '创建后，本页将使用此密钥复制推流和播放链接。' : <>可前往<Link href="/dashboard/system">系统设置</Link>启用可复制的直播密钥。</>}</small>
        <label>流 ID
          <input required maxLength={64} pattern={'[A-Za-z0-9_\\-]+'} value={newId} disabled={busy} onChange={event => setNewId(event.target.value)} placeholder="例如 camera-1" aria-describedby="live-relay-id-help" />
        </label>
        <small id="live-relay-id-help">支持字母、数字、下划线和连字符，推流时区分大小写。</small>
        {createError ? <div className="management-notice" role="alert">{createError}</div> : null}
        <div className="management-actions">
          <button type="button" className="button secondary" disabled={busy} onClick={() => dialog.current?.close()}>取消</button>
          <button type="submit" className="button" disabled={busy || !state?.configured || !newId.trim()}>{busy ? '创建中…' : '创建流'}</button>
        </div>
      </form>
    </dialog>
  </div>;
}
