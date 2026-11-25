'use client';
import { useCallback, useEffect, useState } from 'react';
import { LockKeyhole, LockOpen, RefreshCw } from 'lucide-react';
import { api } from './api';

type Candidate = { id: string; examNumber: string; name: string | null; teamName: string | null; seatNo: string;
  loginIp: string | null; loginIpBoundAt: string | null; loginIpReleasedAt: string | null };
type Data = { enabled: boolean; canManage: boolean; rooms: { id: string; name: string; enabled: boolean }[]; candidates: Candidate[]; total: number; page: number; pageSize: number };
export function ExamLoginRestrictionsPanel({ examId }: { examId: string }) {
  const [data, setData] = useState<Data | null>(null), [query, setQuery] = useState(''), [search, setSearch] = useState('');
  const [page, setPage] = useState(1), [selected, setSelected] = useState<string[]>([]), [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(''), [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      const value = await api<Data>(`/api/exams/${examId}/login-restrictions?${new URLSearchParams({ page: String(page), q: search })}`, { cache: 'no-store' });
      if (page > 1 && (page - 1) * value.pageSize >= value.total) { setPage(Math.max(1, Math.ceil(value.total / value.pageSize))); setSelected([]); return; }
      setData(value); setError('');
      setSelected(previous => previous.filter(id => value.candidates.some(candidate => candidate.id === id && candidate.loginIp)));
    } catch (cause) { setError(cause instanceof Error ? cause.message : '登录限制加载失败'); }
  }, [examId, page, search]);
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 5000); return () => window.clearInterval(timer); }, [load]);
  async function action(input: { action: 'toggle'; enabled: boolean } | { action: 'set-room'; roomId: string; enabled: boolean } | { action: 'release'; candidateIds: string[] }) {
    setBusy(true); setError(''); setMessage('');
    try {
      await api(`/api/exams/${examId}/login-restrictions`, { method: 'POST', body: JSON.stringify(input) });
      setSelected([]); await load();
      setMessage(input.action === 'release' ? '已解除一次 IP 绑定，下次成功登录后将绑定新的 IP。' : input.enabled ? '考室 IP 登录限制已启用，跨网同步开启时会同步到另一端。' : '考室 IP 登录限制已关闭，跨网同步开启时会同步到另一端。');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '操作失败'); }
    finally { setBusy(false); }
  }
  function release(ids: string[]) {
    if (window.confirm(`为 ${ids.length} 位考生解除一次 IP 绑定？下次成功登录后会绑定新的 IP。`)) void action({ action: 'release', candidateIds: ids });
  }
  const selectable = data?.candidates.filter(candidate => candidate.loginIp).map(candidate => candidate.id) || [];
  return <section className="card grid" aria-label="登录限制">
    <div className="topbar topbar-actions"><button className="button secondary" onClick={() => void load()} disabled={busy}><RefreshCw size={16} />刷新</button></div>
    {data ? <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <strong>{data.rooms.some(room => room.enabled) ? <LockKeyhole size={17} /> : <LockOpen size={17} />} 已启用 {data.rooms.filter(room => room.enabled).length} / {data.rooms.length} 个考室的 IP 限制</strong>
      {data.canManage ? <><button className="button secondary" disabled={busy} onClick={() => void action({ action: 'toggle', enabled: true })}>全部启用</button><button className="button secondary" disabled={busy} onClick={() => void action({ action: 'toggle', enabled: false })}>全部关闭</button></> : null}
    </div> : <p>正在加载…</p>}
    <p className="muted" style={{ margin: 0 }}>按考室设置是否限制登录 IP。开启跨网同步后，考室开关在公网、内网保持一致；考生绑定的具体 IP 留在各自服务器。下方仅列出实际启用限制的考生。</p>
    {data?.rooms.length ? <div className="grid" aria-label="考室 IP 限制设置">{data.rooms.map(room => <label key={room.id} className="exam-checkbox"><input type="checkbox" role="switch" className="settings-switch" aria-label={`${room.name} IP 登录限制`} disabled={busy || !data.canManage} checked={room.enabled} onChange={event => void action({ action: 'set-room', roomId: room.id, enabled: event.target.checked })} />{room.name}</label>)}</div> : null}
    {error ? <p role="alert" style={{ color: 'var(--danger)' }}>{error}</p> : null}
    {message ? <p role="status">{message}</p> : null}
    <form style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }} onSubmit={event => { event.preventDefault(); setPage(1); setSearch(query); setSelected([]); }}>
      <input aria-label="搜索考生或 IP" placeholder="搜索考号、姓名、学号或 IP" value={query} onChange={event => setQuery(event.target.value)} style={{ flex: 1, minWidth: 220 }} />
      <button className="button secondary" type="submit">搜索</button>
      <button className="button" type="button" disabled={busy || !selected.length} onClick={() => release(selected)}>解除所选考生限制 ({selected.length})</button>
    </form>
    <div style={{ overflowX: 'auto' }}><table className="exam-overview-table"><thead><tr>
      <th><input aria-label="选择本页已绑定考生" type="checkbox" style={{ width: 'auto' }} checked={Boolean(selectable.length) && selectable.every(id => selected.includes(id))} onChange={event => setSelected(event.target.checked ? selectable : [])} /></th>
      <th>考号</th><th>姓名 / 队伍</th><th>座位</th><th>绑定 IP</th><th>绑定时间</th><th>操作</th>
    </tr></thead><tbody>{data?.candidates.map(candidate => <tr key={candidate.id}>
      <td><input aria-label={`选择 ${candidate.examNumber}`} type="checkbox" style={{ width: 'auto' }} disabled={!candidate.loginIp || busy} checked={selected.includes(candidate.id)} onChange={event => setSelected(previous => event.target.checked ? [...previous, candidate.id] : previous.filter(id => id !== candidate.id))} /></td>
      <td>{candidate.examNumber}</td><td>{candidate.teamName || candidate.name || '—'}</td><td>{candidate.seatNo}</td>
      <td>{candidate.loginIp || (candidate.loginIpReleasedAt ? '待下次登录绑定' : '未绑定')}</td>
      <td>{candidate.loginIpBoundAt ? new Date(candidate.loginIpBoundAt).toLocaleString('zh-CN', { hour12: false }) : '—'}</td>
      <td><button className="button secondary" disabled={busy || !candidate.loginIp} onClick={() => release([candidate.id])}>解除一次限制</button></td>
    </tr>)}{data && !data.candidates.length ? <tr><td colSpan={7} className="muted">暂无符合条件且已启用 IP 限制的考生</td></tr> : null}</tbody></table></div>
    {data ? <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}><span>共 {data.total} 位考生 · 第 {page} 页</span>
      <button className="button secondary" disabled={page <= 1 || busy} onClick={() => { setPage(page - 1); setSelected([]); }}>上一页</button>
      <button className="button secondary" disabled={page * data.pageSize >= data.total || busy} onClick={() => { setPage(page + 1); setSelected([]); }}>下一页</button>
    </div> : null}
  </section>;
}
