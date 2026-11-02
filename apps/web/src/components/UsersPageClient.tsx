'use client';

import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, Pencil, RefreshCw, Search, ShieldCheck, Trash2, Upload, UserCheck, UserPlus, UsersRound, X } from 'lucide-react';
import { api } from './api';
import { parseAssociationImport } from '@/lib/association-import';

type Role = 'ADMIN' | 'SUPER_ADMIN';
type UserStatus = 'ACTIVE' | 'DISABLED';
interface UserRow {
  id: string; numberId: string | null; username: string | null; nickname: string | null; realName: string | null;
  associationImported: boolean; associationVerifiedAt: string | null; school: string | null; email: string | null; role: Role; status: UserStatus;
}
interface LocalUserImport {
  username: string; realName: string; school: string; numberId: string; email?: string; password: string; status: UserStatus; role: Role;
}
const importHeaders = ['用户名', '姓名', '学校', '学号', '邮箱', '密码', '状态', '角色'];
const importExample = ['local001', '张三', '西华师范大学', '20260001', 'local001@example.com', 'Passw0rd!', '启用', '普通管理员'];

function parseCsvLine(line: string) {
  const result: string[] = [];
  let value = '', quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && quoted && line[index + 1] === '"') { value += '"'; index += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) { result.push(value.trim()); value = ''; }
    else value += char;
  }
  result.push(value.trim());
  return result;
}
function csvCell(value: string) { return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value; }
function parseImportText(value: string): LocalUserImport[] {
  const lines = value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]);
  const index = (name: string) => headers.indexOf(name);
  if (!['用户名', '姓名', '学校', '学号', '密码'].every(name => index(name) >= 0)) return [];
  return lines.slice(1).map(line => {
    const cells = parseCsvLine(line);
    const statusText = cells[index('状态')] || '启用';
    const roleText = cells[index('角色')] || '普通管理员';
    return {
      username: cells[index('用户名')] || '', realName: cells[index('姓名')] || '', school: cells[index('学校')] || '',
      numberId: cells[index('学号')] || '', email: cells[index('邮箱')] || undefined, password: cells[index('密码')] || '',
      status: (['停用', 'DISABLED'].includes(statusText.toUpperCase()) ? 'DISABLED' : 'ACTIVE') as UserStatus,
      role: (['超级管理员', 'SUPER_ADMIN'].includes(roleText.toUpperCase()) ? 'SUPER_ADMIN' : 'ADMIN') as Role
    };
  }).filter(row => row.username || row.numberId || row.realName);
}
function emptyDraft(user?: UserRow) {
  return { username: user?.username || '', realName: user?.realName || '', school: user?.school || '', numberId: user?.numberId || '', email: user?.email || '', password: '', status: user?.status || 'ACTIVE' as UserStatus, role: user?.role || 'ADMIN' as Role };
}

export function UsersPageClient() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [query, setQuery] = useState('');
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [importKind, setImportKind] = useState<'local' | 'association'>('local');
  const [associationText, setAssociationText] = useState('');
  const [importText, setImportText] = useState(`${importHeaders.join(',')}\n${importExample.join(',')}`);
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [draft, setDraft] = useState(emptyDraft());
  const [error, setError] = useState('');
  const [busyAction, setBusyAction] = useState('');
  const [loadingUsers, setLoadingUsers] = useState(false);
  async function load() { setError(''); setLoadingUsers(true); try { setUsers(await api<UserRow[]>('/api/users')); } catch (err) { setError(err instanceof Error ? err.message : '加载失败'); } finally { setLoadingUsers(false); } }
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (!showImportDialog && !editing) return;
    const previous = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [editing, showImportDialog]);
  const associationPreview = useMemo(() => {
    try { return { rows: parseAssociationImport(associationText), error: '' }; }
    catch (error) { return { rows: [], error: error instanceof Error ? error.message : '导入格式不正确' }; }
  }, [associationText]);
  const importRows = useMemo(() => parseImportText(importText), [importText]);
  const filteredUsers = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase();
    if (!keyword) return users;
    return users.filter(user => [user.username, user.realName, user.nickname, user.school, user.numberId, user.email].some(value => value?.toLocaleLowerCase().includes(keyword)));
  }, [query, users]);
  const activeCount = users.filter(user => user.status === 'ACTIVE').length;
  const superAdminCount = users.filter(user => user.role === 'SUPER_ADMIN').length;

  async function importUsers() {
    setError(''); setBusyAction('importUsers');
    try { await api(importKind === 'association' ? '/api/users/association' : '/api/users', { method: 'POST', body: JSON.stringify({ users: importKind === 'association' ? associationPreview.rows : importRows }) }); setShowImportDialog(false); await load(); }
    catch (err) { setError(err instanceof Error ? err.message : '导入失败'); }
    finally { setBusyAction(''); }
  }
  async function readImportFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; if (!file) return;
    try {
      const XLSX = await import('xlsx');
      const book = XLSX.read(await file.arrayBuffer());
      const sheet = book.Sheets[book.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json<Array<string | number>>(sheet, { header: 1, defval: '' });
      setImportText(rows.map(row => row.map(value => csvCell(String(value))).join(',')).join('\n'));
    } catch { setError('导入文件读取失败，请使用系统模板'); }
    finally { event.target.value = ''; }
  }
  async function downloadTemplate() {
    const XLSX = await import('xlsx');
    const sheet = XLSX.utils.aoa_to_sheet([importHeaders, importExample]);
    const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, '本地用户'); XLSX.writeFile(book, '本地用户导入模板.xlsx');
  }
  function editUser(user: UserRow) { setEditing(user); setDraft(emptyDraft(user)); }
  async function saveUser() {
    if (!editing) return;
    setError(''); setBusyAction(`edit-${editing.id}`);
    try { await api(`/api/users/${editing.id}`, { method: 'PATCH', body: JSON.stringify({ ...draft, password: draft.password || undefined }) }); setEditing(null); await load(); }
    catch (err) { setError(err instanceof Error ? err.message : '保存失败'); }
    finally { setBusyAction(''); }
  }
  async function deleteUser(user: UserRow) {
    const name = user.realName || user.username || user.numberId || user.id;
    if (!window.confirm(`确认删除用户“${name}”吗？`)) return;
    setBusyAction(`delete-${user.id}`);
    try { await api(`/api/users/${user.id}`, { method: 'DELETE' }); await load(); }
    catch (err) { setError(err instanceof Error ? err.message : '删除失败'); }
    finally { setBusyAction(''); }
  }
  const portal = typeof document !== 'undefined' ? document.body : null;
  return <div className="grid users-page">
    <div className="topbar users-page-header"><h1 style={{ margin: 0 }}>用户管理</h1><div className="users-header-actions"><button className="button secondary" onClick={() => void load()} disabled={loadingUsers}><RefreshCw size={16} className={loadingUsers ? 'spin' : ''} />{loadingUsers ? '刷新中…' : '刷新'}</button><button className="button" onClick={() => { setImportKind('local'); setShowImportDialog(true); }}><UserPlus size={16} />导入本地用户</button><button className="button secondary" onClick={() => { setImportKind('association'); setShowImportDialog(true); }}><UserPlus size={16} />导入协会用户</button></div></div>
    <section className="users-summary" aria-label="用户统计"><div className="card users-summary-item"><span className="users-summary-icon total"><UsersRound size={19} /></span><span><small>全部用户</small><strong>{users.length}</strong></span></div><div className="card users-summary-item"><span className="users-summary-icon completed"><UserCheck size={19} /></span><span><small>启用用户</small><strong>{activeCount}</strong></span></div><div className="card users-summary-item"><span className="users-summary-icon super"><ShieldCheck size={19} /></span><span><small>超级管理员</small><strong>{superAdminCount}</strong></span></div></section>
    {error ? <div className="users-error" role="alert">{error}</div> : null}
    <section className="card users-browser"><div className="users-toolbar"><div className="users-search"><Search size={17} /><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索用户名、姓名、学校、学号或邮箱" aria-label="搜索用户" />{query ? <button type="button" onClick={() => setQuery('')} aria-label="清空搜索"><X size={14} /></button> : null}</div><span className="users-result-count">{query ? `${filteredUsers.length} 条结果` : `共 ${users.length} 位用户`}</span></div>
      <div className="users-table-wrap"><table className="table users-table"><thead><tr><th>用户名</th><th>姓名</th><th>学校</th><th>学号</th><th>邮箱</th><th>状态</th><th>角色</th><th>操作</th></tr></thead><tbody>
        {filteredUsers.map(user => <tr key={user.id}><td><strong>{user.username || '—'}</strong></td><td>{user.realName || user.nickname || '—'}{user.associationImported ? <small className="muted" style={{ display: 'block' }}>{user.associationVerifiedAt ? '协会用户 · 已验证' : '协会用户 · 待首次登录验证'}</small> : null}</td><td>{user.school || '—'}</td><td><span className="users-number-id">{user.numberId || '—'}</span></td><td><span className={user.email ? 'users-email' : 'users-empty-value'}>{user.email || '—'}</span></td><td><span className={`users-status ${user.status === 'ACTIVE' ? 'completed' : 'disabled'}`}><i />{user.status === 'ACTIVE' ? '启用' : '停用'}</span></td><td>{user.role === 'SUPER_ADMIN' ? '超级管理员' : '普通管理员'}</td><td><div className="users-row-actions"><button onClick={() => editUser(user)} aria-label={`编辑用户 ${user.realName || user.username}`}><Pencil size={15} /></button><button className="danger" onClick={() => void deleteUser(user)} disabled={busyAction === `delete-${user.id}`} aria-label={`删除用户 ${user.realName || user.username}`}><Trash2 size={15} /></button></div></td></tr>)}
        {!filteredUsers.length ? <tr><td colSpan={8} className="users-empty-state"><UsersRound size={24} /><strong>{query ? '没有匹配的用户' : '暂无用户'}</strong><span>{query ? '请尝试其他搜索关键词' : '点击右上角导入本地用户或协会用户'}</span></td></tr> : null}
      </tbody></table></div>
    </section>
    {showImportDialog && portal ? createPortal(<div className="modal-backdrop user-import-backdrop" onMouseDown={() => busyAction !== 'importUsers' && setShowImportDialog(false)}><section className="modal-panel user-import-dialog" role="dialog" aria-modal="true" onMouseDown={event => event.stopPropagation()}><div className="user-import-header"><div className="user-import-heading"><span><UserPlus size={20} /></span><div><h2>{importKind === 'association' ? '导入协会官网用户' : '导入本地用户'}</h2><p>{importKind === 'association' ? '一行一个姓名＋学号，无需填写密码' : '用户名、姓名、学校、学号、邮箱、密码、状态、角色'}</p></div></div><button className="user-import-close" onClick={() => setShowImportDialog(false)} aria-label="关闭"><X size={17} /></button></div><div className="user-import-body">{importKind === 'association' ? <><label htmlFor="association-user-import">姓名＋学号</label><textarea id="association-user-import" rows={10} value={associationText} onChange={event => setAssociationText(event.target.value)} placeholder={"张三+20260001\n李四+20260002"} spellCheck={false} /><p className="muted">请填写官网真实姓名和学号，也支持空格、制表符或逗号分隔。已识别 {associationPreview.rows.length} 位用户。</p>{associationPreview.error ? <p role="alert">{associationPreview.error}</p> : null}<div className="user-import-help"><ShieldCheck size={17} /><span><strong>首次登录验证</strong><small>用户首次使用官网用户名或邮箱及密码登录，验证姓名和学号后同步真实资料并保存本地密码凭据。重复导入保留密码、状态和角色。</small></span></div></> : <><div className="user-import-file-actions"><button className="button secondary" onClick={() => void downloadTemplate()}><Download size={16} />下载模板</button><label className="button secondary"><Upload size={16} />选择文件<input type="file" accept=".xlsx,.xls,.csv" onChange={event => void readImportFile(event)} hidden /></label></div><div className="user-import-field-head"><label htmlFor="local-user-import">导入内容</label><span>{importRows.length ? `已识别 ${importRows.length} 位用户` : '请保留表头并填写数据'}</span></div><textarea id="local-user-import" rows={10} value={importText} onChange={event => setImportText(event.target.value)} spellCheck={false} /><div className="user-import-help"><ShieldCheck size={17} /><span><strong>密码安全</strong><small>密码导入后会立即加密保存，列表和接口均不会返回明文密码；再次导入同一用户会更新资料和密码。</small></span></div></>}</div><div className="user-import-actions"><button className="button secondary" onClick={() => setShowImportDialog(false)}>取消</button><button className="button user-import-submit" onClick={() => void importUsers()} disabled={!(importKind === 'association' ? associationPreview.rows.length : importRows.length) || busyAction === 'importUsers'}><Upload size={16} />{busyAction === 'importUsers' ? '正在导入…' : `导入 ${(importKind === 'association' ? associationPreview.rows.length : importRows.length) || ''} 位用户`}</button></div></section></div>, portal) : null}
    {editing && portal ? createPortal(<div className="modal-backdrop user-import-backdrop" onMouseDown={() => !busyAction && setEditing(null)}><section className="modal-panel user-edit-dialog" role="dialog" aria-modal="true" onMouseDown={event => event.stopPropagation()}><div className="user-import-header"><div className="user-import-heading"><span><Pencil size={19} /></span><div><h2>{editing.associationImported ? '编辑协会用户' : '编辑本地用户'}</h2><p>{editing.associationImported && !editing.associationVerifiedAt ? '首次官网登录验证后保存本地密码' : '留空密码表示保持当前密码'}</p></div></div><button className="user-import-close" onClick={() => setEditing(null)} aria-label="关闭"><X size={17} /></button></div><div className="user-edit-grid"><label>用户名<input value={draft.username} onChange={event => setDraft({ ...draft, username: event.target.value })} /></label><label>姓名<input disabled={Boolean(editing.associationVerifiedAt)} value={draft.realName} onChange={event => setDraft({ ...draft, realName: event.target.value })} /></label><label>学校<input value={draft.school} onChange={event => setDraft({ ...draft, school: event.target.value })} /></label><label>学号<input disabled={Boolean(editing.associationVerifiedAt)} value={draft.numberId} onChange={event => setDraft({ ...draft, numberId: event.target.value })} /></label><label>邮箱<input type="email" value={draft.email} onChange={event => setDraft({ ...draft, email: event.target.value })} /></label><label>新密码<input type="password" disabled={editing.associationImported && !editing.associationVerifiedAt} minLength={6} value={draft.password} onChange={event => setDraft({ ...draft, password: event.target.value })} placeholder="留空则不修改" /></label><label>状态<select value={draft.status} onChange={event => setDraft({ ...draft, status: event.target.value as UserStatus })}><option value="ACTIVE">启用</option><option value="DISABLED">停用</option></select></label><label>角色<select value={draft.role} onChange={event => setDraft({ ...draft, role: event.target.value as Role })}><option value="ADMIN">普通管理员</option><option value="SUPER_ADMIN">超级管理员</option></select></label></div><div className="user-import-actions"><button className="button secondary" onClick={() => setEditing(null)}>取消</button><button className="button" onClick={() => void saveUser()} disabled={(!editing.associationImported && (!draft.username.trim() || !draft.realName.trim())) || !draft.numberId.trim() || busyAction === `edit-${editing.id}`}>{busyAction === `edit-${editing.id}` ? '保存中…' : '保存用户'}</button></div></section></div>, portal) : null}
  </div>;
}
