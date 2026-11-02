'use client';
import { useEffect, useState } from 'react';
import { Copy, KeyRound, Save, Trash2 } from 'lucide-react';
import { api } from './api';

type LiveKey = { id: string; name: string; keyPrefix: string; enabled: boolean; createdAt: string };
export function LiveApiKeysPanel() {
  const [keys, setKeys] = useState<LiveKey[]>([]), [name, setName] = useState(''), [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false), [message, setMessage] = useState(''), [isError, setIsError] = useState(false);
  const [issued, setIssued] = useState(''), [examCode, setExamCode] = useState(''), [examNumber, setExamNumber] = useState(''), [camera, setCamera] = useState('1');
  useEffect(() => { void api<LiveKey[]>('/api/settings/live-api-keys', { cache: 'no-store' }).then(value => { setKeys(value); setLoaded(true); }).catch(error => { setIsError(true); setMessage(error.message); }); }, []);
  async function mutate(work: () => Promise<void>) {
    setBusy(true); setMessage(''); setIsError(false);
    try { await work(); }
    catch (error) { setIsError(true); setMessage(error instanceof Error ? error.message : '操作失败'); }
    finally { setBusy(false); }
  }
  async function create() {
    await mutate(async () => {
      const { apiKey, ...record } = await api<LiveKey & { apiKey: string }>('/api/settings/live-api-keys', { method: 'POST', body: JSON.stringify({ name, enabled }) });
      setKeys(previous => [record, ...previous]); setIssued(apiKey); setName(''); setMessage('直播 API Key 已生成，请复制并保存。');
    });
  }
  async function update(id: string, data: { name?: string; enabled?: boolean }) {
    await mutate(async () => {
      const saved = await api<LiveKey>('/api/settings/live-api-keys', { method: 'PATCH', body: JSON.stringify({ id, ...data }) });
      setKeys(previous => previous.map(key => key.id === id ? saved : key)); setMessage('已保存直播 API Key 设置。');
    });
  }
  async function remove(key: LiveKey) {
    if (!window.confirm(`删除直播 API Key「${key.name}」后，该密钥将无法访问直播。确定删除？`)) return;
    await mutate(async () => { await api('/api/settings/live-api-keys', { method: 'DELETE', body: JSON.stringify({ id: key.id }) }); setKeys(previous => previous.filter(value => value.id !== key.id)); setMessage('直播 API Key 已删除。'); });
  }
  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); setIsError(false); setMessage('已复制。'); }
    catch { setIsError(true); setMessage('复制失败，请选中文本手动复制。'); }
  }
  const url = issued && /^\d{10}$/.test(examCode) && examNumber.trim()
    ? `${typeof window === 'undefined' ? '' : window.location.origin}/api/${examCode}/${encodeURIComponent(examNumber.trim())}/${camera}/apikey=${issued}` : '';
  return <div className="form">
    <p className="muted">直播密钥单独管理，只用于读取三个机位已有的直播画面。生成后即可使用，停用或删除后立即停止后续访问。</p>
    {message && <div role={isError ? 'alert' : 'status'} style={{ color: isError ? '#b42318' : 'var(--accent-2)' }}>{message}</div>}
    <fieldset className="form" disabled={busy || !loaded} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <label>API Key 名称<input value={name} maxLength={100} onChange={event => setName(event.target.value)} placeholder="例如：比赛直播平台" /></label>
      <label className="checkbox-label"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />生成后启用</label>
      <button type="button" className="button" disabled={!name.trim()} onClick={() => void create()}><KeyRound size={17} />生成直播 API Key</button>
      {issued && <div className="card form">
        <label>新生成的 API Key<input readOnly value={issued} autoComplete="off" /></label>
        <button type="button" className="button secondary" onClick={() => void copy(issued)}><Copy size={16} />复制 API Key</button>
        <small className="muted">完整密钥仅在生成时显示，请在离开此面板前复制并保存。</small>
        <div className="grid two"><label>考试编号<input value={examCode} maxLength={10} onChange={event => setExamCode(event.target.value)} placeholder="10 位考试编号" /></label><label>考号<input value={examNumber} onChange={event => setExamNumber(event.target.value)} /></label></div>
        <label>机位<select value={camera} onChange={event => setCamera(event.target.value)}><option value="1">1 · 电脑屏幕</option><option value="2">2 · 电脑前置摄像头</option><option value="3">3 · 第二机位</option></select></label>
        {url && <><label>直播流地址<input readOnly value={url} /></label><button type="button" className="button secondary" onClick={() => void copy(url)}><Copy size={16} />复制直播地址</button></>}
      </div>}
      {!keys.length ? <p className="muted">{loaded ? '尚未生成直播 API Key。' : '正在加载…'}</p> : keys.map(key => <LiveKeyRow key={key.id} value={key} update={update} remove={remove} />)}
    </fieldset>
  </div>;
}
function LiveKeyRow({ value, update, remove }: { value: LiveKey; update: (id: string, data: { name?: string; enabled?: boolean }) => Promise<void>; remove: (key: LiveKey) => Promise<void> }) {
  const [name, setName] = useState(value.name);
  useEffect(() => setName(value.name), [value.name]);
  return <div className="card form">
    <label>名称<input value={name} maxLength={100} onChange={event => setName(event.target.value)} /></label>
    <small className="muted">{value.keyPrefix}… · {new Date(value.createdAt).toLocaleString('zh-CN')}</small>
    <label className="checkbox-label"><input type="checkbox" checked={value.enabled} onChange={event => void update(value.id, { enabled: event.target.checked })} />已启用</label>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}><button type="button" className="button secondary" disabled={!name.trim() || name.trim() === value.name} onClick={() => void update(value.id, { name: name.trim() })}><Save size={16} />保存名称</button><button type="button" className="button secondary" onClick={() => void remove(value)}><Trash2 size={16} />删除</button></div>
  </div>;
}
