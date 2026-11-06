'use client';
import { useEffect, useState } from 'react';
import { Copy, KeyRound, Save, Trash2 } from 'lucide-react';
import { api } from './api';

type LiveKey = { id: string; name: string; keyPrefix: string; enabled: boolean; createdAt: string; copyable?: boolean };
export function LiveApiKeysPanel() {
  const [keys, setKeys] = useState<LiveKey[]>([]), [name, setName] = useState(''), [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false), [message, setMessage] = useState(''), [isError, setIsError] = useState(false);
  const [issued, setIssued] = useState('');
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
      setKeys(previous => previous.map(key => key.id === id ? { ...key, ...saved } : key)); setMessage('已保存直播 API Key 设置。');
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
  async function copyKey(id: string) {
    await mutate(async () => { const { apiKey } = await api<{ apiKey: string }>('/api/settings/live-api-keys/reveal', { method: 'POST', body: JSON.stringify({ id }) }); setIssued(apiKey); await copy(apiKey); });
  }
  return <div className="form">
    <p className="muted">全考试通用，无须绑定考试。此密钥用于读取本服务器所有考试的监考画面，以及独立转发直播的 WebRTC 推流和播放。新密钥加密保存，可随时再次复制；停用或删除会撤销相应连接。</p>
    {message && <div role={isError ? 'alert' : 'status'} style={{ color: isError ? '#b42318' : 'var(--accent-2)' }}>{message}</div>}
    <fieldset className="form" disabled={busy || !loaded} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <label>API Key 名称<input value={name} maxLength={100} onChange={event => setName(event.target.value)} placeholder="例如：比赛直播平台" /></label>
      <label className="checkbox-label"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />生成后启用</label>
      <button type="button" className="button" disabled={!name.trim()} onClick={() => void create()}><KeyRound size={17} />生成直播 API Key</button>
      {issued && <div className="card form">
        <label>新生成的 API Key<input readOnly value={issued} autoComplete="off" /></label>
        <button type="button" className="button secondary" onClick={() => void copy(issued)}><Copy size={16} />复制 API Key</button>
        <small className="muted">之后可在下方密钥列表再次复制。监考观看地址为 /api/考试编号/考号/机位?apikey=此密钥；转发直播的播放链接在“直播管理”中显示。</small>
      </div>}
      {!keys.length ? <p className="muted">{loaded ? '尚未生成直播 API Key。' : '正在加载…'}</p> : keys.map(key => <LiveKeyRow key={key.id} value={key} update={update} remove={remove} copyKey={copyKey} />)}
    </fieldset>
  </div>;
}
function LiveKeyRow({ value, update, remove, copyKey }: { value: LiveKey; update: (id: string, data: { name?: string; enabled?: boolean }) => Promise<void>; remove: (key: LiveKey) => Promise<void>; copyKey: (id: string) => Promise<void> }) {
  const [name, setName] = useState(value.name);
  useEffect(() => setName(value.name), [value.name]);
  return <div className="card form">
    <label>名称<input value={name} maxLength={100} onChange={event => setName(event.target.value)} /></label>
    <small className="muted">{value.keyPrefix}… · 全考试通用 · {new Date(value.createdAt).toLocaleString('zh-CN')}</small>
    {value.copyable ? <button type="button" className="button secondary" onClick={() => void copyKey(value.id)}><Copy size={16} />再次复制 API Key</button> : <small className="muted">旧密钥仅保存摘要，无法再次复制；如需重复复制请生成新密钥。</small>}
    <label className="checkbox-label"><input type="checkbox" checked={value.enabled} onChange={event => void update(value.id, { enabled: event.target.checked })} />已启用</label>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}><button type="button" className="button secondary" disabled={!name.trim() || name.trim() === value.name} onClick={() => void update(value.id, { name: name.trim() })}><Save size={16} />保存名称</button><button type="button" className="button secondary" onClick={() => void remove(value)}><Trash2 size={16} />删除</button></div>
  </div>;
}
