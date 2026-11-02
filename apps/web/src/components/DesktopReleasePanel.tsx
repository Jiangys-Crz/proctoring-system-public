'use client';
import { useEffect, useRef, useState } from 'react';
import { ArrowUpFromLine, Check, RefreshCw, Trash2 } from 'lucide-react';
import { isReleaseVersion, type DesktopRelease, type DesktopTarget } from '@cwnupaa/proctor-shared';
import { FileCleanupStatus } from './FileCleanupStatus';
import { api } from './api';

interface Artifact { id: string; target: DesktopTarget; kind: 'installer' | 'update'; version: string; name: string; size: number; createdAt: string; status: string; downloadUrl: string }
const names = { 'mac-arm64': 'Mac · Apple 芯片', 'mac-x64': 'Mac · Intel 芯片', windows: 'Windows · 32 / 64 位' };
export function DesktopReleasePanel() {
  const [target, setTarget] = useState<DesktopTarget>('windows');
  const [version, setVersion] = useState('');
  const [notes, setNotes] = useState('');
  const [releases, setReleases] = useState<DesktopRelease[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [installerId, setInstallerId] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [fileSearch, setFileSearch] = useState('');
  const [filePage, setFilePage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState('');
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState('');
  const [error, setError] = useState(false);
  const upload = useRef<XMLHttpRequest | null>(null);
  async function load() {
    const result = await api<{ releases: DesktopRelease[]; artifacts: Artifact[] }>('/api/settings/desktop-releases');
    setReleases(result.releases); setArtifacts(result.artifacts);
    setSelectedIds(ids => ids.filter(id => result.artifacts.some(a => a.id === id && a.status !== 'active')));
  }
  useEffect(() => { void load().catch(() => { setError(true); setMessage('发布设置读取失败，请重试'); }); return () => upload.current?.abort(); }, []);
  const choices = artifacts.filter(item => item.target === target && item.version === version);
  function reset() { setInstallerId(''); setMessage(''); }
  async function uploadFile(file: File | undefined, kind: 'installer' | 'update') {
    if (!file) return;
    if (!isReleaseVersion(version)) { setError(true); setMessage('请先填写 x.y.z 格式的版本号'); return; }
    setBusy(kind); setProgress(0); setMessage(''); setError(false);
    try {
      const result = await new Promise<Artifact>((resolve, reject) => {
        const xhr = new XMLHttpRequest(); upload.current = xhr;
        xhr.open('POST', `/api/settings/desktop-releases/upload?${new URLSearchParams({ target, kind, version })}`);
        xhr.timeout = 15 * 60_000;
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.upload.onprogress = event => { if (event.lengthComputable) setProgress(Math.round(event.loaded / event.total * 100)); };
        xhr.onload = () => {
          try { const body = JSON.parse(xhr.responseText); if (xhr.status >= 200 && xhr.status < 300 && body.ok) resolve(body.data); else reject(new Error(body.message || '安装包上传失败')); }
          catch (cause) { reject(cause instanceof Error ? cause : new Error('安装包上传失败')); }
        };
        xhr.onerror = () => reject(new Error('上传连接中断，请重试'));
        xhr.ontimeout = () => reject(new Error('上传超时，请重试'));
        xhr.onabort = () => reject(new Error('上传已取消'));
        xhr.send(file);
      });
      setInstallerId(result.id);
      await load(); setMessage('安装包已上传。核对版本后点击“发布最新版”生效。');
    } catch (cause) { setError(true); setMessage(cause instanceof Error ? cause.message : '上传失败'); }
    finally { setBusy(''); upload.current = null; }
  }
  async function publish() {
    setBusy('publish'); setError(false); setMessage('');
    try {
      await api('/api/settings/desktop-releases', { method: 'POST', body: JSON.stringify({ target, version, notes, installationMode: 'manual', installerId, updateId: installerId }) });
      await load(); setMessage('最新版已发布，下载首页和客户端版本检查已同步更新。');
    } catch (cause) { setError(true); setMessage(cause instanceof Error ? cause.message : '发布失败'); }
    finally { setBusy(''); }
  }
  const filtered = artifacts.filter(a => `${a.name} ${a.version} ${names[a.target]}`.toLowerCase().includes(fileSearch.toLowerCase()));
  const pages = Math.max(1, Math.ceil(filtered.length / 20));
  const page = Math.min(filePage, pages);
  const visible = filtered.slice((page - 1) * 20, page * 20);
  async function remove(ids: string[]) {
    if (!ids.length || !window.confirm(`确认永久删除这 ${ids.length} 个安装包？对应的历史下载链接将失效，文件清理后无法恢复。`)) return;
    setBusy('delete'); setError(false); setMessage('');
    try {
      await api('/api/settings/desktop-releases', { method: 'DELETE', body: JSON.stringify({ ids }) });
      setSelectedIds([]); setRevision(r => r + 1); await load(); setMessage('安装包记录已删除，正在清理文件。');
    } catch (cause) { setError(true); setMessage(cause instanceof Error ? cause.message : '删除失败'); }
    finally { setBusy(''); }
  }
  return <div style={{ display: 'grid', gap: 18 }}>
    <p className="muted" style={{ margin: 0 }}>公网和内网共用同一软件版本与安装包，按操作系统发布一次即可。旧版本客户端需要更新后才能登录，下载首页会同步显示已发布版本。</p>
    {releases.length ? <div className="table-scroll"><table className="table"><thead><tr><th>系统</th><th>最新版</th><th>发布时间</th><th>下载</th></tr></thead><tbody>{releases.map(release => <tr key={release.target}><td>{names[release.target]}</td><td>{release.version}</td><td>{new Date(release.publishedAt).toLocaleString()}</td><td><a href={release.installer.url}>下载安装包</a></td></tr>)}</tbody></table></div> : <div className="muted">尚未发布任何客户端版本。</div>}
    <fieldset disabled={!!busy} style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 16, minWidth: 0 }}>
      <div className="grid two"><label>发布系统<select value={target} onChange={event => { reset(); setTarget(event.target.value as DesktopTarget); }}>
        {Object.entries(names).map(([value, name]) => <option key={value} value={value}>{name}</option>)}
      </select></label><label>版本号<input value={version} maxLength={20} placeholder="例如 0.1.30" onChange={event => { reset(); setVersion(event.target.value.trim()); }} /></label></div>
      <label>更新说明<textarea value={notes} onChange={event => setNotes(event.target.value)} maxLength={5000} rows={3} placeholder="向考生说明本次更新内容" /></label>
      <label><span><ArrowUpFromLine size={15} /> {target === 'windows' ? 'Windows 安装包（EXE，包含 32 / 64 位）' : 'Mac 安装包（DMG）'}</span>
        <input type="file" accept={target === 'windows' ? '.exe' : '.dmg'} key={`${target}-${version}-installer`} onChange={event => { void uploadFile(event.target.files?.[0], 'installer'); event.target.value = ''; }} />
        <select value={installerId} onChange={event => setInstallerId(event.target.value)}><option value="">选择已上传的安装包</option>{choices.filter(item => item.kind === 'installer').map(item => <option key={item.id} value={item.id}>{item.name} · {(item.size / 1024 ** 2).toFixed(1)} MB</option>)}</select>
      </label>
      <div className="muted">客户端会下载并校验安装包，随后打开安装窗口，由用户在原安装位置替换旧版本。</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><button type="button" className="button" disabled={!isReleaseVersion(version) || !installerId} onClick={() => void publish()}><Check size={16} />发布最新版</button><button type="button" className="button secondary" onClick={() => void load().catch(() => { setError(true); setMessage('读取失败，请重试'); })}><RefreshCw size={15} />刷新</button></div>
    </fieldset>
    {busy === 'installer' && <div role="status">正在上传 {progress}%<progress style={{ width: '100%', marginTop: 8 }} max={100} value={progress} /></div>}
    {busy === 'delete' && <div role="status">正在删除安装包记录…</div>}
    {busy === 'publish' && <div role="status">正在发布…</div>}
    <section className="grid">
      <h3 style={{ margin: 0 }}>安装包文件管理</h3>
      <p className="muted" style={{ margin: 0 }}>管理已上传的安装包，查看版本和大小，下载或删除旧包。正在发布的最新版不能删除。</p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}><input style={{ flex: '1 1 220px' }} aria-label="搜索安装包" placeholder="搜索版本、系统或文件名" value={fileSearch} onChange={event => { setFileSearch(event.target.value); setFilePage(1); }} />
        <button type="button" className="button secondary" disabled={!!busy || !selectedIds.length} onClick={() => void remove(selectedIds)}><Trash2 size={16} />删除已选 {selectedIds.length || ''}</button>
      </div>
      <div className="table-scroll"><table className="table candidate-table"><thead><tr><th>选择</th><th>安装包</th><th>系统 / 版本</th><th>大小</th><th>状态</th><th>上传时间</th><th>操作</th></tr></thead><tbody>
        {visible.map(asset => <tr key={asset.id}>
          <td><input type="checkbox" aria-label={`选择 ${asset.name}`} disabled={!!busy || asset.status === 'active' || !selectedIds.includes(asset.id) && selectedIds.length >= 100} checked={selectedIds.includes(asset.id)} onChange={event => setSelectedIds(ids => event.target.checked ? [...ids, asset.id] : ids.filter(id => id !== asset.id))} /></td>
          <td>{asset.name}</td><td>{names[asset.target]} / {asset.version}</td><td>{(asset.size / 1024 ** 2).toFixed(1)} MiB</td>
          <td>{asset.status === 'active' ? '当前发布' : asset.status === 'historical' ? '历史版本' : '未发布'}</td><td>{new Date(asset.createdAt).toLocaleString()}</td>
          <td><div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><a href={asset.downloadUrl}>下载</a><button type="button" className="button secondary compact-button" disabled={!!busy || asset.status === 'active'} onClick={() => void remove([asset.id])}>删除</button></div></td>
        </tr>)}
      </tbody></table></div>
      {!filtered.length && <div className="muted">暂无符合条件的安装包</div>}
      {pages > 1 && <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}><button className="button secondary" disabled={page <= 1} onClick={() => setFilePage(page - 1)}>上一页</button><span>第 {page} / {pages} 页 · 共 {filtered.length} 个文件</span><button className="button secondary" disabled={page >= pages} onClick={() => setFilePage(page + 1)}>下一页</button></div>}
      <FileCleanupStatus kind="INSTALLER" revision={revision} />
    </section>
    {message && <div role={error ? 'alert' : 'status'} style={{ color: error ? 'var(--danger)' : 'var(--accent-2)' }}>{message}</div>}
  </div>;
}
